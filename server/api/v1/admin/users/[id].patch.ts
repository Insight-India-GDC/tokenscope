/*
 * PATCH /api/v1/admin/users/:id — change a teammate's role.
 *
 * Wave-VI mutation. The pure decision lives in server/auth/admin-guards.ts
 * (evaluateRoleChange); this handler resolves the (caller, target) state
 * and threads it through.
 *
 * Two-layer RBAC:
 *   1. requireRole(admin) — app-level gate, 403 on miss.
 *   2. withRequestRls — RLS GUCs set so RLS-protected reads honour the
 *      caller's scope. Note teammate itself isn't RLS-protected (per
 *      0002_rls.sql — region scoping happens explicitly via region_id
 *      filter), so the region-mismatch case is enforced here with
 *      requireRegionScope + an explicit row-region check.
 *
 * Mutation order:
 *   a) load target row (region + current role)
 *   b) evaluateRoleChange(...) — pure verdict
 *   c) on allow: UPDATE + audit row in the same RLS-txn
 *   d) audit failure → throw → no role change (fail-closed)
 *
 * Wave-VII addition — auto-revoke on every role change. The role
 * UPDATE also bumps `teammate.revoked_at = NOW()` in the SAME statement,
 * so the audit row's payload carries `sessionsRevoked: true` and one
 * audit row covers both effects (R1 F4 collapse). The validate-session
 * middleware compares the row's revoked_at to the session's issuedAt;
 * the target's existing cookie 401s on its next /api/v1/** request and
 * the user is bounced to /login. The caller's own session is unaffected
 * (different teammate id).
 */
import { createError, defineEventHandler } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { evaluateRoleChange, canAssignRole, canModifyHolderOf } from '../../../../auth/admin-guards'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { ROLES, isRole, isUngrantableRole, roleLabel, type Role } from '../../../../../shared/auth/roles'
import { revokeInteractiveCredentialsOf } from '../../../../auth/emit-revocation'

const Body = z.object({
  role: z.enum(ROLES),
})

interface TargetRow extends Record<string, unknown> {
  id: string
  region_id: string
  email: string
  role: string
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  // CSRF check BEFORE any DB I/O so a cross-origin POST doesn't even
  // touch the teammate row (load + timing-side-channel hardening, same
  // pattern as dev-login.post.ts).
  assertSameOrigin(event)

  // Strict UUID validation (R1 F5 → SYS-1 shared helper — the earlier
  // /^[0-9a-f-]{36}$/i regex accepted 36-char hex-and-dash strings that
  // aren't valid UUIDs, which would 5xx on the PG ::uuid cast).
  const teammateId = requireUuidParam(event, 'id', 'teammate id')

  const body = await readValidated(event, Body)
  if (!isRole(body.role)) {
    // Belt + suspenders — z.enum already validates, but isRole keeps
    // the type-narrow for the verdict call below explicit.
    throw createError({ statusCode: 400, statusMessage: 'Invalid role' })
  }
  const newRole: Role = body.role

  // ── Single transactional unit (R1 F4) ─────────────────────────────
  // Load + verdict + audit + UPDATE all run inside ONE withRequestRls
  // call. withRequestRls wraps in db.transaction(...) (see
  // server/db/rls.ts:28-34), so audit insert + role UPDATE commit
  // atomically. The previous shape wrote audit via the pooled db
  // OUTSIDE the UPDATE's tx — an UPDATE failure after audit-commit
  // would leave a false audit row claiming a role change.
  const result = await withRequestRls(event, async (tx) => {
    const targetRows = await tx.execute<TargetRow>(sql`
      SELECT id::text AS id, region_id::text AS region_id, email, role
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
    `)
    const target = [...targetRows][0]
    if (!target) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Teammate not found',
          status: 404,
          detail: 'No teammate matches the supplied id (or RLS denied access).',
        },
      })
    }
    // Region-scope check — admin caller cannot mutate a row outside
    // their home region. (platform-admin is unbounded.)
    await requireRegionScope(event, target.region_id)

    if (!isRole(target.role)) {
      // Defensive — the DB shouldn't carry a non-Role string but if a
      // legacy/dirty row slips through we surface 500 (not a 4xx).
      throw createError({
        statusCode: 500,
        statusMessage: `Target teammate has unrecognised role '${target.role}'`,
      })
    }
    // Privilege-escalation guard (adversarial R1 HIGH). canAssignRole exists
    // for exactly this, but was only wired into directory-provision; this is
    // the pre-existing role-CHANGE surface that also needs it. A region-scoped
    // admin must not GRANT an org-wide role (platform-admin), nor
    // mutate a teammate who already HOLDS one (the target.role direction). Only
    // org-wide actors can. requireRole already let region admins this far.
    if (!canAssignRole(caller.role, newRole) || !canModifyHolderOf(caller.role, target.role)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Role grant not permitted',
        data: {
          type: 'https://tokenscope.example.com/errors/role-grant',
          title: 'Role grant not permitted',
          status: 403,
          // Names the ACTUAL denial, both directions. This branch fires for an
          // org-wide grant AND for a retired-role holder, and a message that
          // only mentions platform-admin tells a region admin the wrong reason
          // when the target holds `global-finops` or `finance`.
          detail: isUngrantableRole(newRole)
            ? `${roleLabel(newRole)} can no longer be granted.`
            : `${roleLabel(caller.role)} cannot change ${roleLabel(target.role)} to ${roleLabel(newRole)}: only an Admin may grant org-wide roles or modify a holder of an org-wide or retired role.`,
        },
      })
    }

    const verdict = evaluateRoleChange(
      { role: caller.role, teammateId: caller.teammateId },
      { id: target.id, role: target.role },
      newRole,
    )
    if (!verdict.allowed) {
      const titleByReason: Record<string, string> = {
        'self-role-change-blocked': 'Self role-change blocked',
        'same-role-noop': 'Same role',
      }
      const detailByReason: Record<string, string> = {
        'self-role-change-blocked':
          'You cannot change your own role. Have another Admin do it.',
        'same-role-noop':
          'Target already has the requested role; no change applied.',
      }
      throw createError({
        statusCode: verdict.status,
        statusMessage: titleByReason[verdict.reason] ?? 'Refused',
        data: {
          type: `https://tokenscope.example.com/errors/${verdict.reason}`,
          title: titleByReason[verdict.reason] ?? 'Refused',
          status: verdict.status,
          detail: detailByReason[verdict.reason] ?? 'Role change refused.',
          reason: verdict.reason,
        },
      })
    }

    // Audit + UPDATE + auto-revoke in the same tx — recordAuditEvent
    // accepts the PostgresJsDatabase shape; withRequestRls's `tx`
    // satisfies it structurally (drizzle's tx exposes the same
    // .insert/.execute API).
    //
    // R1 F4 — ONE audit row per user-intent. The Wave-VII auto-revoke
    // is a CONSEQUENCE of the role change (not a separate user action),
    // so it lives on the same `teammate-role-changed` row via
    // `payload.sessionsRevoked = true`. Forensics: filter by event
    // type once; the revocation timestamp is implicit (= ts_recorded).
    // If a future flow ever role-changes WITHOUT revoking sessions, this
    // becomes a distinguishing field.
    await recordAuditEvent(tx, {
      eventType: 'teammate-role-changed',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'teammate',
      subjectId: target.id,
      payload: {
        previousRole: target.role,
        newRole,
        targetEmail: target.email,
        regionId: target.region_id,
        sessionsRevoked: true,
      },
    })

    await tx.execute(sql`
      UPDATE teammate
      SET role = ${newRole}, revoked_at = NOW()
      WHERE id = ${target.id}::uuid
    `)
    // E2 (ADR-0005) as amended by #414: re-validate everything interactive —
    // read/tag and unbound emit credentials die with the cookie sessions. The
    // device stays: a device-bound emit credential carries no read scope and
    // its RLS context is read from this row on every request, so the new role
    // reaches it live. Ending it here silently stopped the device's telemetry
    // until a full re-enrolment. revoke-sessions is the path that ends devices.
    await revokeInteractiveCredentialsOf(tx as never, target.id)

    return { previousRole: target.role, newRole }
  })

  return { ok: true, ...result }
})
