/*
 * GET /api/v1/admin/instances — region-scoped instance (device)
 * visibility for admins (ADR-0005 decision 3: "admin: region-wide").
 *
 * Two-layer RBAC: requireRole(admin) at the edge +
 * requireRegionScope(region) so a region admin can't pivot to another
 * region by passing ?region=. The READ carries an EXPLICIT region predicate
 * — RLS is inert under the owner connection (request-rls.ts), so the same
 * region boundary that bounds the revoke action must bound the read
 * (ADR-0005 STRIDE fix). Both use the region the device's teammate sits in
 * now, not the one stamped on the device at enrolment
 * (docs/design/current-org-lens/00-design.md).
 *
 * Per instance: the same fields as /me/instances (revoked/silent/
 * last_emission/spend_usd_mtd) PLUS the owning teammate (email,
 * display_name). Admin revoke already exists — DELETE
 * /api/v1/instances/{id} (admin + region-scoped); this is read-only.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import {
  instanceMetricColumns,
  instanceProjectionWindow,
  projectInstanceRow,
  type InstanceMetricRow,
} from '../../../utils/instance-projection'

const Query = z.object({
  region: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
})

// The admin variant carries the owning-teammate identity on top of the shared
// per-instance projection.
interface AdminInstanceRow extends InstanceMetricRow, Record<string, unknown> {
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
  last_bearer_at: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const query = await getValidated(event, Query)
  // Default to the caller's home region; an org-wide role may target any.
  const region = query.region ?? session.regionId
  await requireRegionScope(event, region)

  const { monthStartIso, silentCutoffMs } = instanceProjectionWindow(new Date())

  // Bounded + paginated (API-17 — the list was unbounded) with a real
  // COUNT(*) in the same RLS tx like the other admin lists.
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<AdminInstanceRow>(sql`
      SELECT
        ia.instance_id::text                                        AS instance_id,
        ia.tool                                                     AS tool,
        ia.raw_project_code                                         AS raw_project_code,
        ia.ts_start::text                                           AS ts_start,
        ia.ts_actual_end::text                                      AS ts_actual_end,
        -- THE OTHER HALF OF THE ATTRIBUTION-STALL EVIDENCE. Stamped by every
        -- /bearer mint, which Claude Code issues at startup and every ~29
        -- minutes for the life of the process — so a fresh value means "a
        -- client is running", NOT "a client is emitting". An operator asking
        -- why a stall paged needs to see that distinction, and until this
        -- column was exposed no page carried it at all.
        ia.last_bearer_at::text                                     AS last_bearer_at,
        ia.teammate_id::text                                        AS teammate_id,
        t.email                                                     AS teammate_email,
        t.display_name                                              AS teammate_display_name,
        ${instanceMetricColumns(monthStartIso)}
      FROM instance_attestation ia
      JOIN teammate t ON t.id = ia.teammate_id
      WHERE t.region_id = ${region}::uuid
      ORDER BY ia.ts_start DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM instance_attestation ia
      JOIN teammate t ON t.id = ia.teammate_id
      WHERE t.region_id = ${region}::uuid
    `)
    return { rows: [...dataRows], total: Number([...totalRows][0]?.total ?? 0) }
  })

  return {
    region,
    instances: rows.map((r) => ({
      ...projectInstanceRow(r, silentCutoffMs),
      teammate_id: r.teammate_id,
      teammate_email: r.teammate_email,
      teammate_display_name: r.teammate_display_name,
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
