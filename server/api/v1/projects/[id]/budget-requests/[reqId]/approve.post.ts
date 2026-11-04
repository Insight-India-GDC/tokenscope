/*
 * POST /api/v1/projects/{id}/budget-requests/{reqId}/approve — approve a pending
 * budget request, for the amount asked or a different one (spec §5, A6/A7, A9).
 *
 * Gate (A1): a current PM of the project, or an admin in scope. The project row
 * is locked first and the gate is read under that lock, so a PM demoted by a
 * concurrent assignment change cannot approve. Mechanics: decideBudgetRequest.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { requireAuth } from '../../../../../../auth/rbac'
import { assertProjectManagerOrAdmin, loadProjectTarget } from '../../../../../../auth/project-authority'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { readValidated } from '../../../../../../utils/validated-body'
import { requestClock } from '../../../../../../utils/request-clock'
import { lockProjectRowAt } from '../../../../../../projects/last-manager'
import { decideBudgetRequest } from '../../../../../../projects/budget-requests'
import { BudgetRequestApproveBody } from '../../../../../../../shared/schemas/project-budget'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const reqId = requireUuidParam(event, 'reqId', 'budget request id')
  const body = await readValidated(event, BudgetRequestApproveBody)
  const requestAt = requestClock(event).now
  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const proj = await loadProjectTarget(tx, id)
    if (!proj) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    // The decision instant is read after the lock: a PM or requester removed
    // while this request waited is judged as removed.
    const at = await lockProjectRowAt(tx, id, requestAt)
    const via = await assertProjectManagerOrAdmin(event, tx, proj, at)
    return decideBudgetRequest(tx, {
      projectId: id,
      requestId: reqId,
      deciderId: session.teammateId,
      via,
      decision: { kind: 'approve', amountUsd: body.amount_usd, note: body.note || undefined },
      at,
      ipAddress,
      userAgent,
    })
  })
})
