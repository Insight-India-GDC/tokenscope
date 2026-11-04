/*
 * POST /api/v1/projects/{id}/budget-requests/{reqId}/reject — decline a pending
 * budget request with a note (spec §5, A9).
 *
 * Gate (A1): a current PM of the project, or an admin in scope, read under the
 * project row lock like approve. Declining is allowed on an ended project: it
 * moves no budget, and it is the only way to clear such a project's queue.
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
import { BudgetRequestRejectBody } from '../../../../../../../shared/schemas/project-budget'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const reqId = requireUuidParam(event, 'reqId', 'budget request id')
  const body = await readValidated(event, BudgetRequestRejectBody)
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
      decision: { kind: 'reject', note: body.note },
      at,
      ipAddress,
      userAgent,
    })
  })
})
