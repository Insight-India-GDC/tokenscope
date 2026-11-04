/*
 * GET /api/v1/projects/{id}/budget-requests — budget requests on a project
 * (spec §5, A10).
 *
 * Any signed-in teammate gets their OWN requests on the project. The project's
 * current PMs and admins in scope (platform-admin, the project region's admin)
 * also get every pending request: this list, not the inbox, is the work queue.
 */
import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '../../../../../auth/rbac'
import { isProjectAdmin, loadProjectTarget } from '../../../../../auth/project-authority'
import { isProjectManager } from '../../../../../auth/org-roles'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { requestClock } from '../../../../../utils/request-clock'
import { listBudgetRequests } from '../../../../../projects/budget-requests'
import type { BudgetRequestListResponse } from '../../../../../../shared/schemas/project-budget'

export default defineEventHandler(async (event): Promise<BudgetRequestListResponse> => {
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const at = requestClock(event).now

  return await withRequestRls(event, async (tx) => {
    const proj = await loadProjectTarget(tx, id)
    if (!proj) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    const canDecide =
      isProjectAdmin(session, proj.regionId) || (await isProjectManager(tx, session.teammateId, id, at))
    const lists = await listBudgetRequests(tx, { projectId: id, viewerId: session.teammateId, canDecide })
    return { ...lists, can_decide: canDecide }
  })
})
