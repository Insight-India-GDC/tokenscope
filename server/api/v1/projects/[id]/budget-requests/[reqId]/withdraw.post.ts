/*
 * POST /api/v1/projects/{id}/budget-requests/{reqId}/withdraw — the requester
 * withdraws their own pending budget request. A request that is already decided
 * returns 409 (a withdraw racing an approve loses cleanly); someone else's
 * request returns 404.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { requireAuth } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { requestClock } from '../../../../../../utils/request-clock'
import { withdrawBudgetRequest } from '../../../../../../projects/budget-requests'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const reqId = requireUuidParam(event, 'reqId', 'budget request id')
  const at = requestClock(event).now
  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, (tx) =>
    withdrawBudgetRequest(tx, {
      projectId: id,
      requestId: reqId,
      requesterId: session.teammateId,
      at,
      ipAddress,
      userAgent,
    }),
  )
})
