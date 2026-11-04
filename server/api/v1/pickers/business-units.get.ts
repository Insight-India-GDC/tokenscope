/*
 * GET /api/v1/pickers/business-units — every active cost-owning unit (Business
 * Unit), across regions, for the project request and create forms (A13). Any
 * signed-in teammate: unit names are not sensitive (docs/security-model.md).
 * `my_unit_id` is the caller's own Business Unit, the request form's default.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

interface UnitRow extends Record<string, unknown> {
  id: string
  display_name: string
  path: string
  region_id: string
  region_code: string
  region_name: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  return await withRequestRls(event, async (tx) => {
    const units = await tx.execute<UnitRow>(sql`
      SELECT ou.id::text AS id, ou.display_name, ou.path::text AS path,
             r.id::text AS region_id, r.code AS region_code, r.display_name AS region_name
      FROM org_unit ou
      JOIN region r ON r.id = ou.region_id
      WHERE ou.is_cost_owning_unit AND ou.retired_at IS NULL
      ORDER BY r.code, ou.path
    `)
    const mine = await tx.execute<{ cost_owning_unit_id: string | null }>(sql`
      SELECT c.cost_owning_unit_id::text AS cost_owning_unit_id
      FROM teammate t
      JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
      WHERE t.id = ${session.teammateId}::uuid
    `)
    return { units: [...units], my_unit_id: [...mine][0]?.cost_owning_unit_id ?? null }
  })
})
