/*
 * appendProjectTopup — the one way budget is added to a project pool: a new
 * `top-up` allocation row, under the per-project top-up cap, with its audit row.
 *
 * Extracted from POST /allocations/{id}/topups so an approved budget request
 * (docs/design/project-requests/00-spec.md §5, A6/A7) adds budget through the
 * same insert, cap and audit as a manual top-up.
 *
 * The caller has already authorised the actor and resolved the pool. Must run
 * inside the caller's transaction: the cap is counted under a project-keyed
 * advisory lock that is held until that transaction ends.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { allocation } from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { advisoryXactLock } from '../db/advisory-lock'
import { translatePgConstraintError } from '../utils/pg-constraint-error'
import { MAX_LIVE_TOPUPS_PER_PROJECT, TOPUP_CAP_RECENT_DAYS } from '../utils/allocation-validation'

type Tx = PostgresJsDatabase<typeof schema>

export interface AppendTopupInput {
  projectId: string
  /** The pool row the top-up was added from (its baseline, or a top-up when the budget is top-ups only) — the audit row's subject. */
  focusedAllocationId: string
  budgetUsd: string
  /** tstzrange literal. */
  effective: string
  actorTeammateId: string
  /** The request clock (requestClock(event).now). */
  at: string
  reason: string | null
  /** Extra audit context, merged into payload.context (e.g. which gate admitted the actor). */
  context?: Record<string, unknown>
  ipAddress: string | null
  userAgent: string | null
}

export async function appendProjectTopup(
  tx: Tx,
  input: AppendTopupInput,
): Promise<{ id: string; auditEventId: string }> {
  // Per-project top-up cap (H32), counted under a project-keyed lock so
  // concurrent requests serialise and cannot all pass the same count. Every
  // insert is a new row, so the cap applies whatever the new range: a live
  // top-up counts, and so does any top-up recorded recently, which is what
  // bounds back-dated ones (they are accepted, but never live).
  await tx.execute(advisoryXactLock('allocationTopup', input.projectId))
  const [held] = await tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM allocation a
    JOIN audit_event ae ON ae.id = a.audit_event_id
    WHERE a.scope_type = 'project' AND a.scope_id = ${input.projectId}::uuid
      AND a.allocation_kind = 'top-up'
      AND (upper(a.effective) > ${input.at}::timestamptz
           OR ae.ts_recorded > now() - make_interval(days => ${TOPUP_CAP_RECENT_DAYS}))
  `)
  if ((held?.n ?? 0) >= MAX_LIVE_TOPUPS_PER_PROJECT) {
    throw createError({
      statusCode: 409,
      statusMessage: `This project already has ${MAX_LIVE_TOPUPS_PER_PROJECT} active or recent top-ups, the most allowed. Wait for one to end, or raise the baseline instead.`,
    })
  }

  // 1) audit_event first (FK target for the new allocation row).
  const evt = await recordAuditEvent(tx, {
    eventType: 'allocation-topup-added',
    actorTeammateId: input.actorTeammateId,
    subjectKind: 'allocation',
    subjectId: input.focusedAllocationId,
    payload: {
      after: {
        budget_usd: input.budgetUsd,
        effective: input.effective,
        allocation_kind: 'top-up',
      },
      context: {
        focused_allocation_id: input.focusedAllocationId,
        scope_type: 'project',
        scope_id: input.projectId,
        reason: input.reason,
        ...input.context,
      },
    },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })

  // 2) Append the top-up allocation row. Top-ups STACK (mig 0052): the
  //    allocation no-overlap EXCLUDE applies to baselines only, and
  //    fetchProjectAllocation sums every pool baseline + top-up covering now(),
  //    so multiple top-ups for the same period simply add up. The try/catch is
  //    defensive: an unexpected constraint race surfaces as a clean 409 rather
  //    than a raw 500.
  let topup: { id: string } | undefined
  try {
    ;[topup] = await tx
      .insert(allocation)
      .values({
        scopeType: 'project',
        scopeId: input.projectId,
        budgetUsd: input.budgetUsd,
        effective: input.effective,
        allocationKind: 'top-up',
        createdBy: input.actorTeammateId,
        auditEventId: evt.id,
        source: 'manual',
        isPinned: true,
      })
      .returning({ id: allocation.id })
  } catch (err: unknown) {
    translatePgConstraintError(err, {
      '23P01': {
        title: 'Could not append the top-up',
        detail:
          'A concurrent write conflicted with this top-up. Reload the allocation and try again.',
      },
    })
  }
  return { id: topup!.id, auditEventId: evt.id }
}
