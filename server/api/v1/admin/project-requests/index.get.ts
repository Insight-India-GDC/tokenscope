/*
 * GET /api/v1/admin/project-requests?status=&limit=&offset= — the
 * project-request work queue (A10), one page at a time. A region admin sees
 * their own region's requests; platform-admin all. Pending requests come oldest
 * first; `total` counts every match and `has_more` says another page follows.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { getValidated } from '../../../../utils/validated-body'
import { withRequestRls } from '../../../../db/request-rls'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { listProjectRequestsPage } from '../../../../projects/project-requests'

const Query = z.object({
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  const query = await getValidated(event, Query)
  const scope = isPlatformAdmin(caller.role) ? sql`TRUE` : sql`pr.region_id = ${caller.regionId}::uuid`
  const status =
    query.status === 'pending'
      ? sql`pr.status = 'pending'`
      : query.status === 'decided'
        ? sql`pr.status <> 'pending'`
        : sql`TRUE`

  return await withRequestRls(event, async (tx) => listProjectRequestsPage(tx, sql`${scope} AND ${status}`, query.limit, query.offset))
})
