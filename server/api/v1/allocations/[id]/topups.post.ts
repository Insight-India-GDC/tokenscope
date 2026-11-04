/*
 * POST /api/v1/allocations/{id}/topups — append a top-up row.
 *
 * Per design-notes §Screen 4 + mvp-final-epic.md §Epic 12:
 *   - Append-only (never overwrites the focused baseline row)
 *   - Inserts a new allocation row with allocation_kind='top-up',
 *     same scope_type+scope_id as the focused row, with the supplied
 *     budget and effective range
 *   - Writes an audit_event recording the actor + reason
 *   - CSRF guarded
 *   - The insert, cap and audit live in appendProjectTopup, shared with
 *     approving a budget request
 */
import { requestClock } from '../../../../utils/request-clock'
import {
  defineEventHandler,
  createError,
  readValidatedBody,
  getRequestIP,
  getHeader,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { allocationScopePredicate } from '../../../../auth/allocation-scope'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { EffectiveRangeSchema, TopUpBudgetUsdSchema } from '../../../../utils/allocation-validation'
import { appendProjectTopup } from '../../../../allocations/append-topup'
import { lockProjectRowAt } from '../../../../projects/last-manager'


const PostBody = z.object({
  budget_usd: TopUpBudgetUsdSchema,
  effective: EffectiveRangeSchema,
  reason: z.string().min(1).max(500).optional(),
})

interface BaseRow {
  scope_type: string
  scope_id: string
  teammate_id: string | null
}

export default defineEventHandler(async (event) => {
  // The SERVER owns `now`, once per request (CLAUDE.md §The clock); SQL's own
  // now() is a second clock that a pinned request would not move.
  const at = requestClock(event).now
  assertSameOrigin(event)
  const session = await requireAuth(event)
  // J2: budget authority is role OR relationship. Org roles keep the
  // existing scope-predicate path; everyone else must be a
  // currently-effective PM of the allocation's project (checked against
  // the base row below, AFTER it resolves — the project id lives there).
  const hasOrgRole =
    isPlatformAdmin(session.role) ||
    session.role === 'manager' ||
    session.role === 'admin'

  const id = requireUuidParam(event, 'id', 'allocation id')

  // Explicit gate (H32): the ONLY callers who may top up are the org roles
  // above or a currently-effective project manager of SOME project. Anyone
  // else is refused here, before the allocation id is looked at, so the 403
  // carries nothing about whether that id exists. Whether the PM manages THIS
  // allocation's project is still decided by the pmArm query below (404).
  if (!hasOrgRole) {
    const [pm] = await withRequestRls(event, (tx) =>
      tx.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM project_assignment pa
          WHERE pa.teammate_id = ${session.teammateId}::uuid
            AND pa.role = 'manager'
            AND pa.effective @> ${at}::timestamptz
        ) AS ok
      `),
    )
    if (!pm?.ok) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Top-ups require a manager or admin role, or being a project manager',
      })
    }
  }

  const body = await readValidatedBody(event, (data) => PostBody.parse(data))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // A project allocation: lock the project first (projects/last-manager.ts), so
    // the PM arm below reads the caller's standing under the lock, at the
    // post-lock instant, and a PM demoted or removed through the assignment routes while
    // we waited is read as such.
    const [scope] = await tx.execute<{ project_id: string }>(sql`
      SELECT scope_id::text AS project_id FROM allocation
      WHERE id = ${id}::uuid AND scope_type = 'project'
    `)
    const pmAt = scope ? await lockProjectRowAt(tx, scope.project_id, at) : at

    // Look up the focused row to inherit its scope. Two gates, a true OR
    // (R1 F4): org roles try the scope predicate first; the PM
    // relationship is then tried for EVERYONE on a miss — so a
    // manager-role PM of a project outside their org subtree isn't
    // locked out of a project a developer-role PM could top up. The PM
    // arm is one combined query (relationship proven inside it), so a
    // non-role caller costs exactly one round-trip whether the id
    // exists or not — no timing oracle on the allocation id space.
    // Per-dev-cap rows (teammate_id NOT NULL) are excluded from the PM
    // arm and 400-ed on the org arm (R1 F15): a top-up minted from a
    // per-dev focus would silently widen to the whole project pool.
    const pmArm = () =>
      tx.execute<BaseRow & Record<string, unknown>>(sql`
        SELECT a.scope_type, a.scope_id::text AS scope_id, a.teammate_id::text AS teammate_id
        FROM allocation a
        WHERE a.id = ${id}::uuid
          AND a.scope_type = 'project'
          AND a.teammate_id IS NULL
          AND EXISTS (
            SELECT 1 FROM project_assignment pa
            WHERE pa.project_id = a.scope_id
              AND pa.teammate_id = ${session.teammateId}::uuid
              AND pa.role = 'manager'
              AND pa.effective @> ${pmAt}::timestamptz
          )
        LIMIT 1
      `)

    let base: (BaseRow & Record<string, unknown>) | undefined
    let via: 'role' | 'project-manager' = 'project-manager'
    if (hasOrgRole) {
      const scoped = await tx.execute<BaseRow & Record<string, unknown>>(sql`
        SELECT scope_type, scope_id::text AS scope_id, teammate_id::text AS teammate_id
        FROM allocation
        WHERE id = ${id}::uuid
          AND ${allocationScopePredicate('allocation')}
        LIMIT 1
      `)
      base = [...scoped][0]
      if (base) via = 'role'
      else base = [...(await pmArm())][0]
    } else {
      base = [...(await pmArm())][0]
    }
    if (!base) {
      // Out-of-scope or non-existent — same 404, and we never reach the
      // INSERT below, so a manager cannot top up another org's allocation.
      throw createError({ statusCode: 404, statusMessage: 'Focused allocation not found' })
    }
    if (base.scope_type !== 'project') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Top-ups are only supported for project-scope allocations',
      })
    }
    if (base.teammate_id !== null) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Top-ups apply to the project pool — focus the baseline, not a per-developer cap',
      })
    }

    const topup = await appendProjectTopup(tx, {
      projectId: base.scope_id,
      focusedAllocationId: id,
      budgetUsd: body.budget_usd,
      effective: body.effective,
      actorTeammateId: session.teammateId,
      at,
      reason: body.reason ?? null,
      // J2: which gate admitted the actor — org role vs PM relationship.
      context: { via },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: topup.id,
      audit_event_id: topup.auditEventId,
      appended_at: new Date().toISOString(),
    }
  })
})
