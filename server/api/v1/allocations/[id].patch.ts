/*
 * PATCH /api/v1/allocations/{id} — focused allocation row write.
 *
 * Writes both the allocation row update AND an audit_event row in
 * one transaction (per AGENTS.md §Audit events: every write produces
 * an event). CSRF guarded by assertSameOrigin().
 *
 * Spec — design-notes §Screen 4 + mvp-final-epic.md §Epic 12:
 *   - Editable: budget_usd, effective (tstzrange)
 *   - Read-only: scope_type, scope_id, allocation_kind
 *   - Save writes both rows atomically; "Saved · audit logged"
 *     flash on the client
 *
 * Gate (spec A1): manager / admin / platform-admin through the allocation scope
 * predicate, OR a current PM of the allocation's project — the same two arms,
 * and the same 404 on a miss, as the editor GET and the topups POST.
 */
import { requestClock } from '../../../utils/request-clock'
import { defineEventHandler, createError, readValidatedBody, getRequestIP, getHeader } from 'h3'
import { sql, eq, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import { allocationScopePredicate } from '../../../auth/allocation-scope'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { requireUuidParam } from '../../../utils/require-uuid-param'
import {
  BudgetUsdSchema,
  EffectiveRangeSchema,
  MAX_LIVE_TOPUPS_PER_PROJECT,
  TopUpBudgetUsdSchema,
} from '../../../utils/allocation-validation'
import { advisoryXactLock } from '../../../db/advisory-lock'
import { lockProjectRowAt } from '../../../projects/last-manager'
import { translatePgConstraintError } from '../../../utils/pg-constraint-error'
import { allocation } from '../../../../drizzle/schema'
import { recordAuditEvent } from '../../../db/audit'

const PatchBody = z.object({
  budget_usd: BudgetUsdSchema,
  effective: EffectiveRangeSchema,
})

export default defineEventHandler(async (event) => {
  // The SERVER owns `now`, once per request (CLAUDE.md §The clock); SQL's own
  // now() is a second clock that a pinned request would not move.
  const at = requestClock(event).now
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const hasOrgRole =
    isPlatformAdmin(session.role) || session.role === 'manager' || session.role === 'admin'

  const id = requireUuidParam(event, 'id', 'allocation id')

  const body = await readValidatedBody(event, (data) => PatchBody.parse(data))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // A project allocation: lock the project first (the last-PM rule's lock,
    // server/projects/last-manager.ts), so the row and the caller's PM standing
    // below are read under it — a budget-request approval or a split on this
    // project waits for us. PM standing is judged at the post-lock instant, so a
    // PM removed through the remove route while we waited is read as removed.
    const [scope] = await tx.execute<{ project_id: string }>(sql`
      SELECT scope_id::text AS project_id FROM allocation
      WHERE id = ${id}::uuid AND scope_type = 'project'
    `)
    const pmAt = scope ? await lockProjectRowAt(tx, scope.project_id, at) : at

    const selectBefore = (predicate: SQL) =>
      tx.execute<{
        id: string
        scope_type: string
        scope_id: string
        budget_usd: string
        effective: string
        allocation_kind: string
        teammate_id: string | null
      }>(sql`
        SELECT id::text AS id, scope_type, scope_id::text AS scope_id,
               budget_usd::text AS budget_usd, effective::text AS effective,
               allocation_kind, teammate_id::text AS teammate_id
        FROM allocation
        WHERE id = ${id}::uuid
          AND ${predicate}
        LIMIT 1
      `)
    // PM arm: only rows of a project the caller currently manages.
    const pmPredicate = sql`
      allocation.scope_type = 'project'
      AND EXISTS (
        SELECT 1 FROM project_assignment pa
        WHERE pa.project_id = allocation.scope_id
          AND pa.teammate_id = ${session.teammateId}::uuid
          AND pa.role = 'manager'
          AND pa.effective @> ${pmAt}::timestamptz
      )`
    let via: 'role' | 'project-manager' = 'project-manager'
    let beforeRow = hasOrgRole
      ? [...(await selectBefore(allocationScopePredicate('allocation')))][0]
      : undefined
    if (beforeRow) via = 'role'
    else beforeRow = [...(await selectBefore(pmPredicate))][0]
    if (!beforeRow) {
      // Out-of-scope or non-existent — same 404, and we never reach the
      // UPDATE below, so a manager cannot mutate another org's allocation.
      throw createError({ statusCode: 404, statusMessage: 'Allocation not found' })
    }
    // Per-developer caps are written only through /split, which checks that
    // they stay within the pool and share its period; a pool edit below moves
    // them with it.
    if (beforeRow.teammate_id !== null) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Per-developer caps are edited through POST /api/v1/allocations/{pool id}/split',
      })
    }

    // A top-up keeps its own limits on edit, not only on create (H32): the
    // per-top-up ceiling, and the per-project live cap when this edit makes it
    // live, counted under the same project-keyed lock topups.post.ts takes.
    if (beforeRow.allocation_kind === 'top-up') {
      const amount = TopUpBudgetUsdSchema.safeParse(body.budget_usd)
      if (!amount.success) {
        throw createError({ statusCode: 400, statusMessage: amount.error.issues[0]?.message ?? 'Invalid top-up amount' })
      }
      await tx.execute(advisoryXactLock('allocationTopup', beforeRow.scope_id))
      const [cap] = await tx.execute<{ becomes_live: boolean; others_live: number }>(sql`
        SELECT upper(${body.effective}::tstzrange) > ${at}::timestamptz AS becomes_live,
               (SELECT COUNT(*)::int FROM allocation
                 WHERE scope_type = 'project' AND scope_id = ${beforeRow.scope_id}::uuid
                   AND allocation_kind = 'top-up' AND upper(effective) > ${at}::timestamptz
                   AND id <> ${id}::uuid) AS others_live
      `)
      if (cap?.becomes_live && (cap.others_live ?? 0) >= MAX_LIVE_TOPUPS_PER_PROJECT) {
        throw createError({
          statusCode: 409,
          statusMessage: `This project already has ${MAX_LIVE_TOPUPS_PER_PROJECT} active top-ups, the most allowed. Let one end before extending this one.`,
        })
      }
    }

    // 1) Record audit_event first so we have its id for the FK on the
    //    updated row. Insert is the side-effect that we cannot reverse
    //    if the subsequent UPDATE fails, so we run it inside the same
    //    transaction; rollback wipes both on error.
    const evt = await recordAuditEvent(tx, {
      eventType: 'allocation-updated',
      actorTeammateId: session.teammateId,
      subjectKind: 'allocation',
      subjectId: id,
      payload: {
        before: {
          budget_usd: beforeRow.budget_usd,
          effective: beforeRow.effective,
        },
        after: {
          budget_usd: body.budget_usd,
          effective: body.effective,
        },
        context: { scope_type: beforeRow.scope_type, scope_id: beforeRow.scope_id, via },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // 2) Update the focused allocation row. A new `effective` range can
    //    collide with a sibling row on the gist EXCLUDE
    //    (allocation_scope_dev_kind_eff_excl) — translate 23P01 into the
    //    same clean 409 the POST pre-check gives, instead of a raw 500.
    try {
      await tx
        .update(allocation)
        .set({
          budgetUsd: body.budget_usd,
          effective: body.effective,
          auditEventId: evt.id,
        })
        .where(eq(allocation.id, id))
      // A pool's per-developer caps share its period (split.post.ts writes them
      // that way, and the editor, the split and budget-request approval all find
      // them by that equal range). Move them with the pool, or they are stranded
      // on the old period: hidden from the editor, missed by approval, and in the
      // way of the next split.
      if (beforeRow.scope_type === 'project' && beforeRow.allocation_kind === 'baseline') {
        await tx.execute(sql`
          UPDATE allocation
          SET effective = ${body.effective}::tstzrange, audit_event_id = ${evt.id}::uuid
          WHERE scope_type = 'project' AND scope_id = ${beforeRow.scope_id}::uuid
            AND teammate_id IS NOT NULL AND allocation_kind = 'baseline'
            AND effective = ${beforeRow.effective}::tstzrange
            AND effective <> ${body.effective}::tstzrange
        `)
      }
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23P01': {
          title: 'Budget period overlaps an existing allocation',
          detail:
            'Another allocation for the same scope already covers part of this effective range. Adjust the dates so the periods do not overlap.',
        },
      })
    }

    return {
      id,
      audit_event_id: evt.id,
      saved_at: new Date().toISOString(),
    }
  })
})
