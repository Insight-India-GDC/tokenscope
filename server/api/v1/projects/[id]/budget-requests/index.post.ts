/*
 * POST /api/v1/projects/{id}/budget-requests — a current member asks the
 * project's managers for more budget (spec §5). One pending request per member
 * and project (A9). Notifies the project's current PMs, or the region's admins
 * when it has none.
 */
import { defineEventHandler, getRequestIP, getHeader, setResponseStatus } from 'h3'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { readValidated } from '../../../../../utils/validated-body'
import { requestClock } from '../../../../../utils/request-clock'
import { fileBudgetRequest } from '../../../../../projects/budget-requests'
import { BudgetRequestCreateBody } from '../../../../../../shared/schemas/project-budget'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const body = await readValidated(event, BudgetRequestCreateBody)
  const at = requestClock(event).now
  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null

  const row = await withRequestRls(event, (tx) =>
    fileBudgetRequest(tx, {
      projectId: id,
      requesterId: session.teammateId,
      amountUsd: body.amount_usd,
      reason: body.reason,
      at,
      ipAddress,
      userAgent,
    }),
  )
  setResponseStatus(event, 201)
  return row
})
