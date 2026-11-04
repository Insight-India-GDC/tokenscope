/*
 * GET /api/v1/admin/reconciliation/records — paginated reconciliation_record reader
 * + summary aggregates. The "what did the engine produce?" surface.
 *
 * RBAC: requireRole(admin). reconciliation_record has NO RLS policy, so
 * the in-query region filter is the SOLE clamp (test it as such):
 *   - admin -> AND rr.region_id = <home region>. This naturally EXCLUDES org-scope rows
 *     (region_id IS NULL), so a region admin sees teammate-scope records in their region
 *     only; org-grain (web/code-exec) records are visible to platform-admin only. The
 *     response carries regionScoped + scopeNote so the UI can label it.
 *   - platform-admin -> no clamp (full ledger incl org-grain).
 *
 * Summary is split on purpose (delta_usd is SIGNED: untagged/over positive, walk_back
 * negative): untaggedUsd = disposition='untagged' only; walkBackUsd = abs(walk_back);
 * netDeltaUsd = signed sum. Everything is scoped to the `status` filter (default
 * 'proposed' — the only state in propose-mode; labelled "awaiting application"). The
 * raw provider payload is NOT returned (it carries actor email / GitHub login).
 * 'matched' never produces a row, so it never appears in the breakdown (UI notes this).
 *
 * Pagination: limit (default 50, max 200) + offset.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { isRealUtcDay } from '#shared/schemas/activity'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const Query = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(['proposed', 'applied', 'rejected', 'superseded', 'all']).default('proposed'),
  disposition: z.enum(['untagged', 'walk_back', 'matched', 'no_install', 'ingest_only']).optional(),
  spendClass: z.enum(['billed', 'estimated', 'indicative']).optional(),
  provider: z.enum(['anthropic', 'github']).optional(),
  scope: z.enum(['teammate', 'org']).optional(),
  category: z.string().max(60).optional(),
  periodFrom: z.string().regex(DATE_RE).refine(isRealUtcDay, 'not a real calendar day').optional(),
  periodTo: z.string().regex(DATE_RE).refine(isRealUtcDay, 'not a real calendar day').optional(),
  teammateId: z.string().uuid().optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  enterprise_ref: string
  license_org: string | null
  period_date: string
  category: string
  scope: string
  teammate_id: string | null
  teammate_email: string | null
  region_code: string | null
  cou_code: string | null
  actual_usd: string
  otel_attributed_usd: string
  delta_usd: string
  actual_qty: string | null
  actual_unit_type: string | null
  spend_class: string
  indicative_reason: string | null
  disposition: string
  status: string
  lag_state: string | null
  run_id: string | null
  computed_at: string
}

interface SummaryRow extends Record<string, unknown> {
  total: string
  d_untagged: string
  d_walk_back: string
  d_no_install: string
  d_ingest_only: string
  sc_estimated: string
  sc_indicative: string
  sc_billed: string
  untagged_usd: string
  walk_back_usd: string
  no_install_usd: string
  net_delta_usd: string
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const query = await getValidated(event, Query)

  const statusClause = query.status === 'all' ? sql`` : sql`AND rr.status = ${query.status}`
  const dispositionClause = query.disposition ? sql`AND rr.disposition = ${query.disposition}` : sql``
  const spendClassClause = query.spendClass ? sql`AND rr.spend_class = ${query.spendClass}` : sql``
  const providerClause = query.provider ? sql`AND rr.provider = ${query.provider}` : sql``
  const scopeClause = query.scope ? sql`AND rr.scope = ${query.scope}` : sql``
  const categoryClause = query.category ? sql`AND rr.category = ${query.category}` : sql``
  const periodFromClause = query.periodFrom ? sql`AND rr.period_date >= ${query.periodFrom}::date` : sql``
  const periodToClause = query.periodTo ? sql`AND rr.period_date <= ${query.periodTo}::date` : sql``
  const teammateClause = query.teammateId ? sql`AND rr.teammate_id = ${query.teammateId}::uuid` : sql``
  // Region clamp (sole gate — no RLS policy on this table). admin -> own region only,
  // which excludes org-scope (region_id NULL) rows; platform-admin -> full ledger.
  const isRegionScoped = session.role === 'admin'
  const regionClause = isRegionScoped ? sql`AND rr.region_id = ${session.regionId}::uuid` : sql``

  const filters = sql`
    ${statusClause}${dispositionClause}${spendClassClause}${providerClause}${scopeClause}
    ${categoryClause}${periodFromClause}${periodToClause}${teammateClause}${regionClause}
  `

  const { rows, total, summary } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT rr.id::text AS id, rr.provider, rr.enterprise_ref, rr.license_org,
             rr.period_date, rr.category, rr.scope,
             rr.teammate_id::text AS teammate_id, t.email AS teammate_email,
             rg.code AS region_code, cou.code AS cou_code,
             rr.actual_usd::text AS actual_usd,
             rr.otel_attributed_usd::text AS otel_attributed_usd,
             rr.delta_usd::text AS delta_usd,
             rr.actual_qty::text AS actual_qty, rr.actual_unit_type,
             rr.spend_class, rr.indicative_reason, rr.disposition, rr.status, rr.lag_state,
             rr.run_id::text AS run_id, rr.computed_at
      FROM reconciliation_record rr
      LEFT JOIN teammate t ON t.id = rr.teammate_id
      LEFT JOIN region rg ON rg.id = rr.region_id
      LEFT JOIN org_unit cou ON cou.id = rr.cost_owning_unit_id
      WHERE TRUE ${filters}
      ORDER BY rr.period_date DESC, rr.computed_at DESC, rr.id DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const countRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total FROM reconciliation_record rr WHERE TRUE ${filters}
    `)
    const summaryRows = await tx.execute<SummaryRow>(sql`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE rr.disposition = 'untagged')::text AS d_untagged,
        COUNT(*) FILTER (WHERE rr.disposition = 'walk_back')::text AS d_walk_back,
        COUNT(*) FILTER (WHERE rr.disposition = 'no_install')::text AS d_no_install,
        COUNT(*) FILTER (WHERE rr.disposition = 'ingest_only')::text AS d_ingest_only,
        COUNT(*) FILTER (WHERE rr.spend_class = 'estimated')::text AS sc_estimated,
        COUNT(*) FILTER (WHERE rr.spend_class = 'indicative')::text AS sc_indicative,
        COUNT(*) FILTER (WHERE rr.spend_class = 'billed')::text AS sc_billed,
        COALESCE(SUM(rr.delta_usd) FILTER (WHERE rr.disposition = 'untagged'), 0)::text AS untagged_usd,
        COALESCE(SUM(ABS(rr.delta_usd)) FILTER (WHERE rr.disposition = 'walk_back'), 0)::text AS walk_back_usd,
        COALESCE(SUM(rr.delta_usd) FILTER (WHERE rr.disposition = 'no_install'), 0)::text AS no_install_usd,
        COALESCE(SUM(rr.delta_usd), 0)::text AS net_delta_usd
      FROM reconciliation_record rr WHERE TRUE ${filters}
    `)
    return {
      rows: [...dataRows],
      total: Number([...countRows][0]?.total ?? 0),
      summary: [...summaryRows][0],
    }
  })

  const s = summary
  return {
    summary: {
      statusScope: query.status,
      total: Number(s?.total ?? 0),
      byDisposition: {
        untagged: Number(s?.d_untagged ?? 0),
        walk_back: Number(s?.d_walk_back ?? 0),
        no_install: Number(s?.d_no_install ?? 0),
        ingest_only: Number(s?.d_ingest_only ?? 0),
      },
      bySpendClass: {
        estimated: Number(s?.sc_estimated ?? 0),
        indicative: Number(s?.sc_indicative ?? 0),
        billed: Number(s?.sc_billed ?? 0),
      },
      untaggedUsd: Number(s?.untagged_usd ?? 0).toFixed(2),
      walkBackUsd: Number(s?.walk_back_usd ?? 0).toFixed(2),
      noInstallUsd: Number(s?.no_install_usd ?? 0).toFixed(2),
      netDeltaUsd: Number(s?.net_delta_usd ?? 0).toFixed(2),
    },
    records: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      enterpriseRef: r.enterprise_ref,
      licenseOrg: r.license_org,
      periodDate: r.period_date,
      category: r.category,
      scope: r.scope,
      teammateId: r.teammate_id,
      teammateEmail: r.teammate_email,
      regionCode: r.region_code,
      costOwningUnit: r.cou_code,
      actualUsd: r.actual_usd,
      otelAttributedUsd: r.otel_attributed_usd,
      deltaUsd: r.delta_usd,
      actualQty: r.actual_qty,
      actualUnitType: r.actual_unit_type,
      spendClass: r.spend_class,
      indicativeReason: r.indicative_reason,
      disposition: r.disposition,
      status: r.status,
      lagState: r.lag_state,
      runId: r.run_id,
      computedAt: r.computed_at,
    })),
    total,
    limit: query.limit,
    offset: query.offset,
    regionScoped: isRegionScoped,
    scopeNote: isRegionScoped
      ? 'Region-scoped: teammate records in your region only. Org-grain (cross-region) records are visible to an Admin.'
      : null,
  }
})
