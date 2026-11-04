/*
 * GET /api/v1/me/project-requests — the caller's own project requests: every
 * pending one (each needs a reachable Withdraw; submission caps them at
 * MAX_PENDING_PER_REQUESTER), then the 50 most recent decisions (My projects → Your requests).
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { listProjectRequests, MAX_PENDING_PER_REQUESTER } from '../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const mine = sql`pr.requester_teammate_id = ${session.teammateId}::uuid`
  return await withRequestRls(event, async (tx) => {
    const pending = await listProjectRequests(tx, sql`${mine} AND pr.status = 'pending'`, MAX_PENDING_PER_REQUESTER)
    const decided = await listProjectRequests(tx, sql`${mine} AND pr.status <> 'pending'`, 50)
    // A decision landing between the two reads would list the request twice;
    // the decided row was read second, so it is the current one.
    const decidedIds = new Set(decided.map((r) => r.id))
    return { requests: [...pending.filter((r) => !decidedIds.has(r.id)), ...decided] }
  })
})
