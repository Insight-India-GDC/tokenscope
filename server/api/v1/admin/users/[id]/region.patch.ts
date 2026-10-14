/*
 * PATCH /api/v1/admin/users/:id/region { region_id, org_unit_id? } — move a
 * teammate to another region.
 *
 * Why this exists: new users JIT-create into the lexicographically-first region
 * (APAC today) on their first Entra sign-in, with no way to place them in their
 * real region. This is that placement action. Cross-region reassignment is an
 * ORG-WIDE operation, so a region-scoped `admin` must NOT do it — only
 * platform-admin (org-wide) or platform-admin (bypasses requireRole).
 *
 * Re-scoping a teammate changes what they can see, so we bump `revoked_at`
 * (their existing cookie 401s on its next request and they re-login into the
 * new scope) — same auto-revoke contract as the role-change PATCH.
 *
 * S3: when `org_unit_id` is omitted, the target lands on the target region's
 * `__UNPLACED__` holding node (server/auth/placement-home.ts), NOT "the
 * lexicographically-first unit" — that was the region ROOT (ltree sorts a
 * region's root before its children), whose subtree is the whole region, so an
 * admin re-homing someone without picking a unit silently handed them the
 * whole target region's scope.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { unplacedOrgUnitIdForRegion } from '../../../../../auth/placement-home'
import { revokeInteractiveCredentialsOf } from '../../../../../auth/emit-revocation'
import { followPlacement } from '../../../../../utils/device-lifecycle'

const Body = z.object({
  region_id: z.string().uuid(),
  org_unit_id: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)

  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid teammate id' })
  const teammateId = id.data
  const body = await readValidated(event, Body)

  const result = await withRequestRls(event, async (tx) => {
    // Locked before anything else: a concurrent provision or confirmation takes
    // this row the same way before writing a device's placement (#417), so the
    // two serialise and the device ends on the new placement in either order.
    // NO KEY UPDATE, not FOR UPDATE: it must not conflict with the FOR KEY SHARE
    // that a device-first path takes on this row (session-gc's audit insert),
    // or that path and this move's device step form a deadlock.
    const targetRows = await tx.execute<{ id: string; region_id: string; email: string; provisional: boolean }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, email, provisional
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
      FOR NO KEY UPDATE
    `)
    const target = [...targetRows][0]
    if (!target) throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })
    // A provisional (shadow) teammate is placed by identity confirmation, which
    // also places its devices; an admin move would leave them behind (#417).
    if (target.provisional) {
      throw createError({ statusCode: 422, statusMessage: 'A provisional teammate is placed when their device is confirmed, not by a placement move' })
    }

    const regionRows = await tx.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM region WHERE id = ${body.region_id}::uuid LIMIT 1`,
    )
    if ([...regionRows].length === 0) throw createError({ statusCode: 422, statusMessage: 'Unknown region' })

    // Resolve the home org_unit in the target region: the explicit one (must
    // belong to that region) or the region's __UNPLACED__ holding node — a real,
    // least-privilege placement rather than a guess at a real BU (S3).
    let orgUnitId = body.org_unit_id
    if (orgUnitId) {
      const ouRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM org_unit WHERE id = ${orgUnitId}::uuid AND region_id = ${body.region_id}::uuid LIMIT 1
      `)
      if ([...ouRows].length === 0) throw createError({ statusCode: 422, statusMessage: 'org_unit not in target region' })
    } else {
      orgUnitId = await unplacedOrgUnitIdForRegion(tx, body.region_id)
    }

    await tx.execute(sql`
      UPDATE teammate
      SET region_id = ${body.region_id}::uuid, org_unit_id = ${orgUnitId}::uuid, revoked_at = NOW(),
          -- An admin move is a competing authority over the manager-chain derivation: clear
          -- the placement provenance so region-reenrichment treats this as a deliberate
          -- placement and does NOT re-derive it back to the chain's unit next tick.
          metadata = (coalesce(metadata, '{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAt')
      WHERE id = ${target.id}::uuid
    `)
    // The teammate's devices survive the move (#414), so they must MOVE with it:
    // the joiner stamps new records' region/BU from the device row, and the new
    // region's admin finds devices by it. Ended devices and attributed history
    // keep the placement they were emitted under. Lock order: teammate, then
    // devices (as revoke-sessions), then oauth_token (device-lifecycle.ts).
    const rehomedInstanceIds = await followPlacement(tx as never, target.id)

    // E2 (ADR-0005) as amended by #414: same split as the role-change PATCH.
    // Interactive credentials die; the teammate's devices keep emitting, and
    // the RLS lane each emit request runs in reads the NEW region from this row.
    await revokeInteractiveCredentialsOf(tx as never, target.id)

    await recordAuditEvent(tx, {
      eventType: 'teammate-region-reassigned',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'teammate',
      subjectId: target.id,
      payload: {
        previousRegionId: target.region_id,
        newRegionId: body.region_id,
        newOrgUnitId: orgUnitId,
        targetEmail: target.email,
        sessionsRevoked: true,
        rehomedInstanceIds,
      },
    })
    return { previousRegionId: target.region_id, newRegionId: body.region_id, orgUnitId }
  })

  return { ok: true, ...result }
})
