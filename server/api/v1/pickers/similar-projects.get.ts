/*
 * GET /api/v1/pickers/similar-projects?name= — existing projects whose code or
 * name shares a word with `name`: the duplicate hint on the request form (§3).
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { getValidated } from '../../../utils/validated-body'
import { withRequestRls } from '../../../db/request-rls'
import { findSimilarProjects } from '../../../projects/project-requests'

const Query = z.object({ name: z.string().trim().min(3).max(200) })

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = await getValidated(event, Query)
  return await withRequestRls(event, async (tx) => ({
    projects: await findSimilarProjects(tx, query.name),
  }))
})
