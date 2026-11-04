/*
 * GET /api/v1/admin/project-managers — the PMO list (mig 0164): who may create
 * projects without approval. Platform-admin only (A3: the grant reaches every
 * region). Live grants only; revoked rows stay in the table and the audit log.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

interface Row extends Record<string, unknown> {
  id: string
  teammate_id: string
  display_name: string | null
  email: string
  region_code: string | null
  is_active: boolean
  granted_by_name: string | null
  granted_at: string
  note: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'platform-admin')
  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<Row>(sql`
      SELECT g.id::text AS id,
             g.teammate_id::text AS teammate_id,
             t.display_name,
             t.email,
             r.code AS region_code,
             t.is_active,
             COALESCE(gb.display_name, gb.email) AS granted_by_name,
             g.granted_at::text AS granted_at,
             g.note
      FROM project_manager_grant g
      JOIN teammate t ON t.id = g.teammate_id
      LEFT JOIN region r ON r.id = t.region_id
      LEFT JOIN teammate gb ON gb.id = g.granted_by
      WHERE g.revoked_at IS NULL
      ORDER BY t.display_name NULLS LAST, t.email
    `)
    return { grants: [...rows] }
  })
})
