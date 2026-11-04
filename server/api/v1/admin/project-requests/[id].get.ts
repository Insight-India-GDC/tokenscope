/*
 * GET /api/v1/admin/project-requests/{id} — one request plus existing projects
 * with similar names. Out of a region admin's scope reads as not found.
 */
import { defineEventHandler, createError } from 'h3'
import { requireRole, requireRegionScopeOrNotFound } from '../../../../auth/rbac'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { withRequestRls } from '../../../../db/request-rls'
import { findSimilarProjects, loadProjectRequest } from '../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const id = requireUuidParam(event, 'id', 'request id')
  const notFound = createError({ statusCode: 404, statusMessage: 'Project request not found' })

  return await withRequestRls(event, async (tx) => {
    const request = await loadProjectRequest(tx, id)
    if (!request) throw notFound
    await requireRegionScopeOrNotFound(event, request.region_id, notFound)
    return { request, similar_projects: await findSimilarProjects(tx, request.display_name) }
  })
})
