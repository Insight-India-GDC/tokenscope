/*
 * POST /api/v1/admin/teammates — provision a teammate from the Entra directory.
 *
 * The admin picks a person from GET /admin/directory/search, then POSTs their
 * oid + placement (region / org-unit / role). We re-resolve the oid against the
 * directory SERVER-SIDE (canonical email + display name) rather than trusting
 * the client-supplied identity, then create the teammate with the real
 * entra_oid + source='directory'. On that person's first Entra sign-in the JIT
 * resolver's fast path matches the oid — no pending-claim step.
 *
 * Gates:
 *   - requireRole admin / platform-admin (platform-admin passes)
 *   - canAssignRole: a region admin cannot mint an org-wide role
 *   - requireRegionScope: a region admin can only place into their own region
 *   - org_unit must be an ACTIVE unit in the target region
 *   - duplicate oid → 409 (already a teammate)
 *
 * Duplicate-identity handling (issue #121, same classes as
 * provisionDirectoryTeammate):
 *   - a SECONDARY (CLD) identity pick → 422 naming the primary (pre-tx guard)
 *   - a `bill:` placeholder holding the email → ADOPTED in place with the
 *     admin's explicit placement (safe: a bill placeholder has never
 *     authenticated and has no live sessions/enrolment, so re-homing it does
 *     not need the region-PATCH revoke cascade — same rationale as the
 *     region-reenrichment worker's safety contract)
 *   - the email held by another REAL identity → clean 409, never a raw 23505
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { canAssignRole } from '../../../auth/admin-guards'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { assertOrgUnitInRegion } from '../../../db/org-units'
import { teammate } from '../../../../drizzle/schema'
import { getDirectoryUserByOid } from '../../../azure/directory'
import { assertDirectoryIdentityPickable } from '../../../auth/provision-directory-teammate'
import { loadDirectoryExclusionPatterns } from '../../../utils/directory-exclusions'
import { ROLES } from '../../../../shared/auth/roles'
import { followPlacement } from '../../../utils/device-lifecycle'

// Postgres unique-violation; drizzle wraps the postgres-js error, real `.code`
// on `.cause` (jit-teammate.ts pattern).
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e != null && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') return true
  }
  return false
}

const Body = z.object({
  oid: z.string().trim().min(1).max(200),
  region_id: z.string().uuid(),
  org_unit_id: z.string().uuid(),
  role: z.enum(ROLES),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)

  // Privilege-escalation guard before any region work — a region admin must
  // not be able to mint platform-admin.
  if (!canAssignRole(caller.role, body.role)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/role-grant',
        title: 'Role grant not permitted',
        status: 403,
        detail: `Role '${caller.role}' cannot grant '${body.role}'. Org-wide roles require platform-admin.`,
      },
    })
  }

  await requireRegionScope(event, body.region_id)

  // Source of truth for identity: re-resolve the oid against the directory.
  // Never trust a client-supplied email/display name (spoofable).
  const dir = await getDirectoryUserByOid(body.oid)
  if (!dir) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Directory user not found',
      data: {
        type: 'https://tokenscope.example.com/errors/directory-user',
        title: 'Directory user not found',
        status: 404,
        detail: 'No Entra directory user matches that object id.',
      },
    })
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Excluded (privileged/service) identity picks are refused FIRST (issue
    // #121), before any write — inside the tx now, because the pattern read was
    // the one residual platform-pool read in this otherwise converted handler
    // (docs/design/rls-enforcement.md, the pattern-load class). Patterns are
    // admin-config; a fresh install excludes nobody.
    assertDirectoryIdentityPickable(dir, await loadDirectoryExclusionPatterns(tx))

    // The org unit must exist, be ACTIVE, and belong to the requested region.
    await assertOrgUnitInRegion(tx, {
      orgUnitId: body.org_unit_id,
      regionId: body.region_id,
      mustBeActive: true,
      statusMessage: 'org_unit_id is not an active org unit in this region',
    })

    // A `bill:` placeholder already holding this email is ADOPTED with the
    // admin's explicit placement — the pick confirms the identity, and the
    // explicit region/unit/role is a stronger signal than the bill-derived
    // placement. Savepoint-wrapped: setting entra_oid can race a concurrent
    // JIT sign-in / provision onto teammate_entra_oid_key, and that 23505 must
    // not abort this RLS tx (25P02).
    let adopteeId: string | undefined
    try {
      await tx.transaction(async (sp) => {
        const adopted = await sp.execute<{ id: string }>(sql`
          UPDATE teammate SET entra_oid = ${dir.oid}, source = 'directory',
            role = ${body.role}, region_id = ${body.region_id}::uuid, org_unit_id = ${body.org_unit_id}::uuid,
            display_name = COALESCE(display_name, ${dir.displayName}), last_sync_at = now()
          WHERE lower(email) = lower(${dir.email}) AND NOT provisional AND entra_oid LIKE 'bill:%'
            AND is_active = TRUE
          RETURNING id::text AS id
        `)
        adopteeId = [...adopted][0]?.id
        // A `bill:` placeholder has no device by construction (only a real
        // sign-in provisions one); followed anyway so the rule holds on every
        // path that sets a placement (#417).
        if (adopteeId) await followPlacement(sp as never, adopteeId)
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      adopteeId = undefined // oid race — the oid-conflict 409 below reports it
    }
    if (adopteeId) {
      await recordAuditEvent(tx, {
        eventType: 'teammate-directory-adopted',
        actorTeammateId: caller.teammateId,
        subjectKind: 'teammate',
        subjectId: adopteeId,
        payload: { oid: dir.oid, email: dir.email, via: 'admin-teammates-post', role: body.role, region_id: body.region_id, org_unit_id: body.org_unit_id },
        ipAddress: ip,
        userAgent: ua,
      })
      return {
        id: adopteeId,
        oid: dir.oid,
        email: dir.email,
        display_name: dir.displayName,
        role: body.role,
        region_id: body.region_id,
        org_unit_id: body.org_unit_id,
        created: false,
        adopted: true,
      }
    }

    // Insert; ON CONFLICT (entra_oid) DO NOTHING distinguishes "already a
    // teammate" (empty return) from a fresh provision. Savepoint-wrapped so an
    // email-unique 23505 (the person's email is held by ANOTHER identity —
    // their dual-identity twin or a stale binding) surfaces as a clean 409,
    // not a raw 500 that aborts the tx.
    let inserted: { id: string }[]
    try {
      inserted = await tx.transaction(async (sp) =>
        sp
          .insert(teammate)
          .values({
            entraOid: dir.oid,
            email: dir.email,
            displayName: dir.displayName,
            role: body.role,
            regionId: body.region_id,
            orgUnitId: body.org_unit_id,
            source: 'directory',
          })
          .onConflictDoNothing({ target: teammate.entraOid })
          .returning({ id: teammate.id }),
      )
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      throw createError({
        statusCode: 409,
        statusMessage: 'Identity collision',
        data: {
          type: 'https://tokenscope.example.com/errors/identity-collision',
          title: 'Identity collision',
          status: 409,
          detail: `${dir.email} is already held by another identity (their other Entra account or an unresolved record). Assign them via the Business Unit / project flows (which resolve dual identities), or resolve the duplicate from the Users table.`,
        },
      })
    }

    const row = inserted[0]
    if (!row) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Teammate already provisioned',
        data: {
          type: 'https://tokenscope.example.com/errors/teammate-exists',
          title: 'Already a teammate',
          status: 409,
          detail: `${dir.email} is already a teammate. Change their placement from the Users table.`,
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'teammate-provisioned',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: row.id,
      payload: {
        oid: dir.oid,
        email: dir.email,
        role: body.role,
        region_id: body.region_id,
        org_unit_id: body.org_unit_id,
        source: 'directory',
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: row.id,
      oid: dir.oid,
      email: dir.email,
      display_name: dir.displayName,
      role: body.role,
      region_id: body.region_id,
      org_unit_id: body.org_unit_id,
      created: true,
      adopted: false,
    }
  })
})
