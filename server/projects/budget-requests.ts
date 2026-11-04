/*
 * Budget requests — a project member asks the project's managers for more
 * budget (docs/design/project-requests/00-spec.md §5; amendments A6/A7, A8,
 * A9, A10). Stored as `quota_request` (mig 0165); "budget request" in all copy
 * (A15). Budgets block nothing in TokenScope: approving one raises a reported
 * figure, nothing else.
 *
 * The routes under /api/v1/projects/{id}/budget-requests authorise the caller;
 * this module does the work, inside the caller's withRequestRls transaction.
 *
 * Approving (A6/A7), all in ONE transaction with the decision:
 *   - targets the project's pool baseline in effect at decision time (409 when
 *     there is none: "set a budget first");
 *   - adds one top-up of $Y to that pool, through appendProjectTopup — the same
 *     insert, cap and audit as a manual top-up — over the baseline's period;
 *   - on a per-developer project, also raises the requester's own cap on that
 *     pool (the cap with the pool's period) by $Y. A requester with no cap row already reads the whole pool as
 *     their figure (me-queries falls back to the pool), so for them the top-up
 *     alone raises it by $Y, and no cap is created: a new $Y cap would REPLACE
 *     the pool as their figure.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { pgErrorCode } from '../db/pg-error'
import { dispatchInbox } from '../notifications/dispatch'
import { appendProjectTopup } from '../allocations/append-topup'
import { lockProjectRowAt } from './last-manager'
import type { BudgetRequestRow } from '../../shared/schemas/project-budget'

type Tx = PostgresJsDatabase<typeof schema>

interface Ctx {
  /** The request clock (requestClock(event).now). */
  at: string
  ipAddress: string | null
  userAgent: string | null
}

interface ProjectFacts {
  id: string
  code: string
  display_name: string
  allocation_mode: string
  ended: boolean
}

function problem(statusCode: number, title: string, detail: string) {
  const type =
    statusCode === 404
      ? 'https://tokenscope.example.com/errors/not-found'
      : statusCode === 403
        ? 'https://tokenscope.example.com/errors/forbidden'
        : 'https://tokenscope.example.com/errors/conflict'
  return createError({ statusCode, statusMessage: title, data: { type, title, status: statusCode, detail } })
}

async function projectFacts(tx: Tx, projectId: string, at: string): Promise<ProjectFacts> {
  const [row] = await tx.execute<ProjectFacts & Record<string, unknown>>(sql`
    SELECT id::text AS id, code, display_name, allocation_mode,
           (end_date IS NOT NULL AND end_date <= ${at}::timestamptz) AS ended
    FROM project WHERE id = ${projectId}::uuid
  `)
  if (!row) throw problem(404, 'Project not found', 'No project matches the supplied id.')
  return row
}

async function isCurrentMember(tx: Tx, projectId: string, teammateId: string, at: string): Promise<boolean> {
  const rows = await tx.execute<{ ok: boolean }>(sql`
    SELECT TRUE AS ok FROM project_assignment
    WHERE project_id = ${projectId}::uuid AND teammate_id = ${teammateId}::uuid
      AND effective @> ${at}::timestamptz
    LIMIT 1
  `)
  return [...rows].length > 0
}

async function teammateName(tx: Tx, teammateId: string): Promise<string | null> {
  const [row] = await tx.execute<{ name: string | null }>(sql`
    SELECT COALESCE(display_name, email) AS name FROM teammate WHERE id = ${teammateId}::uuid
  `)
  return row?.name ?? null
}

const ROW_SELECT = sql`
  SELECT q.id::text AS id, q.project_id::text AS project_id,
         q.requester_teammate_id::text AS requester_teammate_id,
         rt.display_name AS requester_display_name, rt.email AS requester_email,
         q.amount_usd::text AS amount_usd, q.reason, q.status,
         q.approved_amount_usd::text AS approved_amount_usd,
         dt.display_name AS decided_by_display_name,
         q.decided_at::text AS decided_at, q.decision_note,
         q.created_at::text AS created_at
  FROM quota_request q
  JOIN teammate rt ON rt.id = q.requester_teammate_id
  LEFT JOIN teammate dt ON dt.id = q.decided_by`

/** The caller's own requests on the project, plus its pending queue when they may decide. */
export async function listBudgetRequests(
  tx: Tx,
  args: { projectId: string; viewerId: string; canDecide: boolean },
): Promise<{ mine: BudgetRequestRow[]; pending: BudgetRequestRow[] | null }> {
  const mine = await tx.execute<BudgetRequestRow & Record<string, unknown>>(sql`
    ${ROW_SELECT}
    WHERE q.project_id = ${args.projectId}::uuid
      AND q.requester_teammate_id = ${args.viewerId}::uuid
    ORDER BY q.created_at DESC
    LIMIT 20
  `)
  const pending = args.canDecide
    ? await tx.execute<BudgetRequestRow & Record<string, unknown>>(sql`
        ${ROW_SELECT}
        WHERE q.project_id = ${args.projectId}::uuid AND q.status = 'pending'
        ORDER BY q.created_at ASC
      `)
    : null
  return { mine: [...mine], pending: pending ? [...pending] : null }
}

async function loadRow(tx: Tx, requestId: string): Promise<BudgetRequestRow> {
  const [row] = await tx.execute<BudgetRequestRow & Record<string, unknown>>(sql`
    ${ROW_SELECT} WHERE q.id = ${requestId}::uuid
  `)
  return row!
}

/**
 * File a request. Current members only (spec §5); one pending per member and
 * project (A9). Takes the project row lock, like every other write that reads
 * membership on this project.
 */
export async function fileBudgetRequest(
  tx: Tx,
  args: { projectId: string; requesterId: string; amountUsd: string; reason: string } & Ctx,
): Promise<BudgetRequestRow> {
  // Lock, then check membership at the post-lock instant: a member removed while
  // this waited cannot leave a request behind (the removal holds the same lock).
  const at = await lockProjectRowAt(tx, args.projectId, args.at)
  const project = await projectFacts(tx, args.projectId, at)
  if (!(await isCurrentMember(tx, args.projectId, args.requesterId, at))) {
    throw problem(403, 'Not a member of this project', 'Only current members of a project can ask for more budget on it.')
  }
  if (project.ended) {
    throw problem(409, 'Project has ended', 'This project has ended, so its budget can no longer change.')
  }
  const alreadyPending = () =>
    problem(409, 'You already have a pending request', 'You already have a budget request waiting on this project. Withdraw it to ask for a different amount.')
  const [existing] = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM quota_request
    WHERE project_id = ${args.projectId}::uuid AND requester_teammate_id = ${args.requesterId}::uuid
      AND status = 'pending'
    LIMIT 1
  `)
  if (existing) throw alreadyPending()

  let inserted: { id: string } | undefined
  try {
    ;[inserted] = await tx.execute<{ id: string }>(sql`
      INSERT INTO quota_request (project_id, requester_teammate_id, amount_usd, reason, created_at)
      VALUES (${args.projectId}::uuid, ${args.requesterId}::uuid, ${args.amountUsd}::numeric,
              ${args.reason}, ${at}::timestamptz)
      RETURNING id::text AS id
    `)
  } catch (err) {
    // A concurrent request from the same member won the partial unique index.
    if (pgErrorCode(err) === '23505') throw alreadyPending()
    throw err
  }
  const requestId = inserted!.id

  await recordAuditEvent(tx, {
    eventType: 'budget-request-filed',
    actorTeammateId: args.requesterId,
    subjectKind: 'quota_request',
    subjectId: requestId,
    payload: {
      after: { status: 'pending', amount_usd: args.amountUsd },
      context: { project_id: args.projectId, reason: args.reason },
    },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  await dispatchInbox(tx, {
    category: 'quota-request',
    subject: `Budget request on ${project.code}`,
    body: {
      quota_request_id: requestId,
      project_code: project.code,
      project_name: project.display_name,
      requester_name: await teammateName(tx, args.requesterId),
      amount_usd: args.amountUsd,
      reason: args.reason,
    },
    relatedEntityKind: 'project',
    relatedEntityId: args.projectId,
    now: new Date(at),
  })

  return loadRow(tx, requestId)
}

/** Close the managers' inbox items for this request: the request is no longer waiting (A10). */
async function resolveRequestInboxItems(tx: Tx, requestId: string, actorId: string, at: string): Promise<void> {
  await tx.execute(sql`
    UPDATE inbox_item
    SET ack_state = 'resolved', ack_at = ${at}::timestamptz, ack_by = ${actorId}::uuid
    WHERE category = 'quota-request'
      AND body->>'quota_request_id' = ${requestId}
      AND ack_state IN ('unread', 'read', 'acknowledged')
  `)
}

/** A pending request's conditional-update miss: say which case it is. */
async function notPending(tx: Tx, projectId: string, requestId: string, requesterId?: string) {
  const [row] = await tx.execute<{ status: string; requester: string }>(sql`
    SELECT status, requester_teammate_id::text AS requester FROM quota_request
    WHERE id = ${requestId}::uuid AND project_id = ${projectId}::uuid
  `)
  if (!row || (requesterId !== undefined && row.requester !== requesterId)) {
    return problem(404, 'Budget request not found', 'No budget request with this id on this project.')
  }
  return problem(409, 'Budget request already closed', `This request is already ${row.status}.`)
}

/** The requester withdraws their own pending request. */
export async function withdrawBudgetRequest(
  tx: Tx,
  args: { projectId: string; requestId: string; requesterId: string } & Ctx,
): Promise<BudgetRequestRow> {
  const updated = await tx.execute<{ id: string }>(sql`
    UPDATE quota_request
    SET status = 'withdrawn', decided_by = ${args.requesterId}::uuid, decided_at = ${args.at}::timestamptz
    WHERE id = ${args.requestId}::uuid AND project_id = ${args.projectId}::uuid
      AND requester_teammate_id = ${args.requesterId}::uuid AND status = 'pending'
    RETURNING id::text AS id
  `)
  if (![...updated][0]) throw await notPending(tx, args.projectId, args.requestId, args.requesterId)

  await recordAuditEvent(tx, {
    eventType: 'budget-request-withdrawn',
    actorTeammateId: args.requesterId,
    subjectKind: 'quota_request',
    subjectId: args.requestId,
    payload: { before: { status: 'pending' }, after: { status: 'withdrawn' }, context: { project_id: args.projectId } },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })
  await resolveRequestInboxItems(tx, args.requestId, args.requesterId, args.at)
  return loadRow(tx, args.requestId)
}

export type BudgetDecision =
  | { kind: 'approve'; amountUsd?: string; note?: string }
  | { kind: 'reject'; note: string }

/**
 * Decide a pending request. The caller has locked the project row and checked,
 * under that lock, that the decider is the project's PM or an admin in scope.
 */
export async function decideBudgetRequest(
  tx: Tx,
  args: {
    projectId: string
    requestId: string
    deciderId: string
    via: 'admin' | 'project-manager'
    decision: BudgetDecision
  } & Ctx,
): Promise<BudgetRequestRow> {
  const { decision, at } = args
  const project = await projectFacts(tx, args.projectId, at)

  // The conditional update IS the concurrency guard (A9): a second decision, or a
  // withdraw that got there first, finds no pending row.
  const updated =
    decision.kind === 'approve'
      ? await tx.execute<{ requester: string; amount_usd: string; approved_amount_usd: string; reason: string }>(sql`
          UPDATE quota_request
          SET status = 'approved',
              approved_amount_usd = COALESCE(${decision.amountUsd ?? null}::numeric, amount_usd),
              decided_by = ${args.deciderId}::uuid, decided_at = ${at}::timestamptz,
              decision_note = ${decision.note ?? null}
          WHERE id = ${args.requestId}::uuid AND project_id = ${args.projectId}::uuid AND status = 'pending'
          RETURNING requester_teammate_id::text AS requester, amount_usd::text AS amount_usd,
                    approved_amount_usd::text AS approved_amount_usd, reason
        `)
      : await tx.execute<{ requester: string; amount_usd: string; approved_amount_usd: null; reason: string }>(sql`
          UPDATE quota_request
          SET status = 'rejected', decided_by = ${args.deciderId}::uuid, decided_at = ${at}::timestamptz,
              decision_note = ${decision.note}
          WHERE id = ${args.requestId}::uuid AND project_id = ${args.projectId}::uuid AND status = 'pending'
          RETURNING requester_teammate_id::text AS requester, amount_usd::text AS amount_usd,
                    NULL::text AS approved_amount_usd, reason
        `)
  const req = [...updated][0]
  if (!req) throw await notPending(tx, args.projectId, args.requestId)

  const auditContext: Record<string, unknown> = {
    project_id: args.projectId,
    requester_teammate_id: req.requester,
    via: args.via,
  }
  if (decision.kind === 'approve') {
    // Re-checks, after the guard and before any money moves (A8, A9). Throwing
    // rolls the conditional update back with everything else.
    if (project.ended) {
      throw problem(409, 'Project has ended', 'This project has ended, so its budget can no longer change. Decline the request instead.')
    }
    if (!(await isCurrentMember(tx, args.projectId, req.requester, at))) {
      throw problem(409, 'Requester is no longer a member', 'The person who asked is no longer on this project. Decline the request instead.')
    }
    const [pool] = await tx.execute<{ id: string; effective: string }>(sql`
      SELECT id::text AS id, effective::text AS effective FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${args.projectId}::uuid
        AND teammate_id IS NULL AND allocation_kind = 'baseline'
        AND effective @> ${at}::timestamptz
      LIMIT 1
    `)
    if (!pool) {
      throw problem(409, 'Set a budget first', 'This project has no budget for the current period, so there is nothing to add to. Set its budget first, then approve the request.')
    }
    // Set by the approve UPDATE (COALESCE over the amount asked).
    const amount = req.approved_amount_usd ?? req.amount_usd

    const decisionEvt = await recordAuditEvent(tx, {
      eventType: 'budget-request-approved',
      actorTeammateId: args.deciderId,
      subjectKind: 'quota_request',
      subjectId: args.requestId,
      payload: {
        before: { status: 'pending', amount_usd: req.amount_usd },
        after: { status: 'approved', approved_amount_usd: amount },
        context: { ...auditContext, allocation_mode: project.allocation_mode, pool_allocation_id: pool.id },
      },
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    })

    const topup = await appendProjectTopup(tx, {
      projectId: args.projectId,
      focusedAllocationId: pool.id,
      budgetUsd: amount,
      effective: pool.effective,
      actorTeammateId: args.deciderId,
      at,
      reason: req.reason,
      context: { via: args.via, quota_request_id: args.requestId },
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    })

    if (project.allocation_mode === 'per_dev_fixed') {
      // The requester's cap on this pool: caps share their pool's period (the
      // split writes them so, and a pool edit moves them), so it is the cap with
      // exactly the pool's range — never one that reaches past the pool.
      await tx.execute(sql`
        UPDATE allocation
        SET budget_usd = budget_usd + ${amount}::numeric, audit_event_id = ${decisionEvt.id}::uuid
        WHERE scope_type = 'project' AND scope_id = ${args.projectId}::uuid
          AND teammate_id = ${req.requester}::uuid
          AND allocation_kind = 'baseline'
          AND effective = ${pool.effective}::tstzrange
      `)
    }

    await tx.execute(sql`
      UPDATE quota_request SET allocation_id = ${topup.id}::uuid WHERE id = ${args.requestId}::uuid
    `)
  } else {
    await recordAuditEvent(tx, {
      eventType: 'budget-request-rejected',
      actorTeammateId: args.deciderId,
      subjectKind: 'quota_request',
      subjectId: args.requestId,
      payload: {
        before: { status: 'pending', amount_usd: req.amount_usd },
        after: { status: 'rejected', decision_note: decision.note },
        context: auditContext,
      },
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    })
  }

  await resolveRequestInboxItems(tx, args.requestId, args.deciderId, at)
  await dispatchInbox(tx, {
    category: 'quota-request-decided',
    subject:
      decision.kind === 'approve'
        ? `Budget request approved on ${project.code}`
        : `Budget request declined on ${project.code}`,
    body: {
      quota_request_id: args.requestId,
      project_code: project.code,
      project_name: project.display_name,
      decision: decision.kind === 'approve' ? 'approved' : 'rejected',
      amount_usd: req.amount_usd,
      approved_amount_usd: req.approved_amount_usd,
      note: decision.note ?? null,
    },
    relatedEntityKind: 'project',
    relatedEntityId: args.projectId,
    recipientTeammateIdHint: req.requester,
    now: new Date(at),
  })

  return loadRow(tx, args.requestId)
}
