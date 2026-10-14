/*
 * GET /api/v1/allocations — list allocations for the manager/admin scope.
 *
 * Paginated via limit/offset (API-17 — the old fixed LIMIT 100 made rows
 * past 100 unreachable); `total` is a real COUNT(*) over the same scope so
 * callers can page.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../auth/rbac'
import { allocationScopePredicate } from '../../../auth/allocation-scope'
import { withRequestRls } from '../../../db/request-rls'

const Query = z.object({
  limit: z.coerce.number().int().positive().max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
})

interface Row extends Record<string, unknown> {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  allocation_kind: string
  project_code: string | null
  project_display_name: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))

  // Rows + COUNT in ONE RLS transaction so they can't disagree mid-flight
  // (the admin/audit list house pattern, R2 F1).
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT a.id::text AS id,
             a.scope_type, a.scope_id::text AS scope_id,
             a.budget_usd::text AS budget_usd,
             a.effective::text  AS effective,
             a.allocation_kind,
             p.code AS project_code,
             p.display_name AS project_display_name
      FROM allocation a
      LEFT JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
      WHERE ${allocationScopePredicate('a')}
      -- a.id tie-breaks equal budgets (H33): without it Postgres may return
      -- tied rows in any order, so limit/offset pages could repeat or skip rows.
      ORDER BY a.budget_usd::numeric DESC, a.id
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM allocation a
      WHERE ${allocationScopePredicate('a')}
    `)
    return { rows: [...dataRows], total: Number([...totalRows][0]?.total ?? 0) }
  })

  return { allocations: rows, total, limit: query.limit, offset: query.offset }
})
