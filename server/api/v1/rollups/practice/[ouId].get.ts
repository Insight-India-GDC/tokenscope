/*
 * GET /api/v1/rollups/practice/:ouId — the rich single-practice view (AEUF "Practice · MPO"),
 * for a cost-owning org_unit. docs/design/aeuf-region-practice-views.md.
 *
 * DUAL LANE (the TokenScope differentiator):
 *   - USAGE signal — usage of the people who sit in the practice SUBTREE NOW
 *     (teammate.org_unit_id; the rows' stamped placement is never read, current-org-lens §2).
 *     Counts untagged spend, NOT the project-CoU key. tool 'claude-code'/'copilot-cli' → vendor; else 'other'.
 *   - RECONCILED bill — v_finance_bill_SHOWBACK summed by `cost_owning_unit_id <@ practice.path`
 *     (the view homes each teammate-day-tool on the teammate's current unit). Same
 *     population as the usage subtree → the two lanes reconcile. Intent: ADR-0010 rule 3 —
 *     showback shows ALL genuine cost incl. NFR/exempt; the chargeback-exempt exclusion lives
 *     ONLY in v_finance_bill_chargeback (the finance lane), never here.
 *
 * AUTHZ (RLS inert → in-query): the practice is visible iff the caller's region/subtree scope
 * covers it (orgSubtreeScopePredicate) OR the caller is an ACTIVE owner of it (cou_owner). Every
 * cross-practice panel (comparison) re-applies the caller's OWN scope — a pure owner never sees a
 * sibling's numbers. Estimated/emitted usage; MTD (the 14-week trend is the exception).
 *
 * THE CLOCK IS THE REQUEST'S (clock-and-day-boundary.md D1/D3). Month-to-date, the
 * current ISO week and the 14-week window are all derived from `requestClock(event)`
 * and bound into the SQL as literals. SQL `NOW()` / `CURRENT_DATE` is a second
 * definition of today and is not read here: a request straddling Monday 00:00Z must
 * bucket every panel on the same week. Every window is half-open at the request's
 * instant (`< now`, `<= today` for day-grain bill rows), so a row dated later than
 * the request is not counted "so far".
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { orgSubtreeScopePredicate } from '../../../../auth/org-subtree-scope'
import { orgSubtreeIds } from '../../../../auth/org-subtree'
import { monthStartIso } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'
import { shiftUtcDay, utcWeekStart } from '../../../../../shared/reports/clock'
import { toolToVendor, vendorCostSql, VENDOR_LANES, VENDOR_LABELS, type Vendor } from '../../../../../shared/usage/vendor'

// Flag a user when their current-week spend ≥ FLAG_MULT × their trailing weekly mean (lean
// fixed threshold; the governance-dial version lives in server/reports/velocity.ts).
const FLAG_MULT = 2

// Per-vendor MTD cost split over ar.cost_usd (shared definition — see shared/usage/vendor.ts).
// USAGE (OTel) side: only claude / copilot / other carry signal — non-Code Claude
// surfaces (#142) never emit telemetry, so their usage lanes are structurally $0
// and are not selected here. They appear on the BILL side below.
const { claude: claudeUsd, copilot: copilotUsd, other: otherUsd } = vendorCostSql('ar.cost_usd')

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'developer', 'manager', 'admin', 'platform-admin')
  // Only region-scoped roles get region-wide context (% of region / vs-region-avg). A manager or
  // developer is capped at their own SUBTREE (org-tree's orgWide set), so the region-WIDE
  // denominator spans BUs they can't see — pairing its recoverable ratio with usageUsd would leak
  // the region total. Owners likewise get null. (Gate by role, NOT by "subtree covers this practice".)
  const inRegionScope = caller.role === 'admin' || caller.role === 'platform-admin'
  const ouId = z.string().uuid().parse(getRouterParam(event, 'ouId'))

  // The ONE instant this request reads. Pre-seeding `event.context.serverClock`
  // pins it (the test seam).
  const clock = requestClock(event)
  const nowIso = clock.now
  const today = clock.today
  const monthStart = monthStartIso(new Date(clock.now))
  // ISO weeks start on Monday 00:00Z: the bucket `date_trunc('week', …)` gives.
  const weekStartDay = utcWeekStart(today)
  const weekStart = `${weekStartDay}T00:00:00.000Z`
  // The trailing 14 weeks: this week plus the 13 before it.
  const trendFromDay = shiftUtcDay(weekStartDay, -7 * 13)
  const trendFrom = `${trendFromDay}T00:00:00.000Z`
  // The velocity flag's baseline: the 3 whole weeks before this one.
  const prior3From = `${shiftUtcDay(weekStartDay, -7 * 3)}T00:00:00.000Z`

  return await withRequestRls(event, async (tx) => {
    // 1. Resolve + gate the practice (cost-owning, owner-aware).
    const ownerClause = sql`EXISTS (
      SELECT 1 FROM cou_owner co
      WHERE co.org_unit_id = org_unit.id
        AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
        AND co.revoked_at IS NULL)`
    const pRows = await tx.execute<{ id: string; path: string; region_id: string; code: string; display_name: string; parent_id: string | null }>(sql`
      SELECT id::text AS id, path::text AS path, region_id::text AS region_id, code, display_name, parent_id::text AS parent_id
      FROM org_unit
      WHERE id = ${ouId}::uuid AND retired_at IS NULL AND is_cost_owning_unit = TRUE
        AND ( ${orgSubtreeScopePredicate('org_unit')} OR ${ownerClause} )
      LIMIT 1`)
    const p = [...pRows][0]
    if (!p) throw createError({ statusCode: 403, statusMessage: 'practice not in your scope' })

    // Scope by the PEOPLE who sit in the subtree now (current-org-lens §3.1): every usage source
    // carries teammate_id, and a row's stamped placement must not decide where its usage lands.
    const practicePeople = sql`SELECT id FROM teammate WHERE org_unit_id IN (${orgSubtreeIds(p.path, p.region_id)})`
    const usageScope = sql`ar.teammate_id IN (${practicePeople})`

    // 2. Usage header + vendor split (one MTD pass).
    const hdrRows = await tx.execute<{ usage_usd: string; tokens: string; users: number; claude: string; copilot: string; other: string }>(sql`
      SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS usage_usd, COALESCE(SUM(ar.tokens), 0)::text AS tokens,
             COUNT(DISTINCT ar.teammate_id)::int AS users,
             ${claudeUsd}::text AS claude, ${copilotUsd}::text AS copilot, ${otherUsd}::text AS other
      FROM v_complete_usage ar
      WHERE ${usageScope} AND ar.ts_event >= ${monthStart}::timestamptz AND ar.ts_event < ${nowIso}::timestamptz`)
    const h = [...hdrRows][0] ?? { usage_usd: '0', tokens: '0', users: 0, claude: '0', copilot: '0', other: '0' }
    const usageUsd = Number(h.usage_usd)
    const users = h.users

    // 3. Reconciled bill (MTD) per vendor, over the cost-owning subtree.
    const billRows = await tx.execute<{ tool: string | null; bill_usd: string; bill_tokens: string }>(sql`
      SELECT b.tool, COALESCE(SUM(b.bill_usd), 0)::text AS bill_usd, COALESCE(SUM(b.bill_tokens), 0)::text AS bill_tokens
      FROM v_finance_bill_showback b
      WHERE b.cost_owning_unit_id IN (${orgSubtreeIds(p.path, p.region_id, { costOwningOnly: true })})
        AND b.period_date >= ${monthStart}::date
        AND b.period_date <= ${today}::date
      GROUP BY b.tool`)
    // Per-LANE bill split (#142): every surface gets its own lane; toolToVendor's
    // catch-all guarantees Σ lanes == bill.total (nothing vanishes).
    const billByLane: Record<Vendor, number> = Object.fromEntries(VENDOR_LANES.map((l) => [l, 0])) as Record<Vendor, number>
    const bill = { total: 0, tokens: 0 }
    for (const r of billRows) {
      const usd = Number(r.bill_usd)
      bill.total += usd
      bill.tokens += Number(r.bill_tokens)
      billByLane[toolToVendor(r.tool)] += usd
    }

    // 3b. WEEKLY per-lane §B bill series (lane-visuals V4) — the SAME showback view
    //     + cost-owning subtree as the MTD bill above, grouped week × tool over the
    //     trailing 14 weeks (mirrors the §A usage trend's window). §B ONLY — never
    //     summed with the usage signal. Σ lanes per week == that week's showback
    //     total by construction (same rows; conservation test-pinned). Lanes are
    //     registry ids via toolToVendor (its catch-all keeps every dollar in a lane).
    const billWeeklyRows = await tx.execute<{ week_start: string; tool: string | null; bill_usd: string }>(sql`
      SELECT date_trunc('week', b.period_date)::date::text AS week_start, b.tool,
             COALESCE(SUM(b.bill_usd), 0)::text AS bill_usd
      FROM v_finance_bill_showback b
      WHERE b.cost_owning_unit_id IN (${orgSubtreeIds(p.path, p.region_id, { costOwningOnly: true })})
        AND b.period_date >= ${trendFromDay}::date
        AND b.period_date <= ${today}::date
      GROUP BY 1, b.tool
      ORDER BY 1`)
    // Merge tools sharing a lane; emit (week asc, canonical lane order) deterministically.
    const weeklyByWeekLane = new Map<string, number>()
    for (const r of billWeeklyRows) {
      const k = `${r.week_start} ${toolToVendor(r.tool)}`
      weeklyByWeekLane.set(k, (weeklyByWeekLane.get(k) ?? 0) + Number(r.bill_usd))
    }
    const laneOrder = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))
    const billWeeklyLanes = [...weeklyByWeekLane.entries()]
      .map(([k, usd]) => {
        const [weekStart, lane] = k.split(' ') as [string, string]
        return { weekStart, lane, usd }
      })
      .sort(
        (a, b) =>
          (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0) ||
          (laneOrder.get(a.lane) ?? 99) - (laneOrder.get(b.lane) ?? 99),
      )

    // 4. Region denominator for % of region + vs-region-avg — ONLY for callers with region/subtree
    //    scope (a pure owner gets null, so they can't recover region totals from the ratio). Region-
    //    clamped; ratios null when the denominator ≤ 0.
    let pctOfRegion: number | null = null
    let vsRegionAvgPct: number | null = null
    if (inRegionScope) {
      const regRows = await tx.execute<{ region_usd: string; practice_count: number }>(sql`
        SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS region_usd,
               (SELECT COUNT(*)::int FROM org_unit WHERE region_id = ${p.region_id}::uuid AND is_cost_owning_unit = TRUE AND retired_at IS NULL) AS practice_count
        FROM v_complete_usage ar
        WHERE ar.teammate_id IN (SELECT id FROM teammate WHERE region_id = ${p.region_id}::uuid)
          AND ar.ts_event >= ${monthStart}::timestamptz AND ar.ts_event < ${nowIso}::timestamptz`)
      const reg = [...regRows][0] ?? { region_usd: '0', practice_count: 0 }
      const regionUsd = Number(reg.region_usd)
      pctOfRegion = regionUsd > 0 ? usageUsd / regionUsd : null
      const regionAvgPerPractice = reg.practice_count > 0 ? regionUsd / reg.practice_count : null
      vsRegionAvgPct = regionAvgPerPractice && regionAvgPerPractice > 0 ? usageUsd / regionAvgPerPractice - 1 : null
    }

    // 5. Top models.
    const modelRows = await tx.execute<{ model: string; usage_usd: string }>(sql`
      SELECT ar.model, COALESCE(SUM(ar.cost_usd), 0)::text AS usage_usd
      FROM attribution_record ar
      WHERE ${usageScope} AND ar.ts_event >= ${monthStart}::timestamptz AND ar.ts_event < ${nowIso}::timestamptz
      GROUP BY ar.model ORDER BY SUM(ar.cost_usd) DESC LIMIT 8`)

    // 6. Users (top 25, MTD spend + vendors + velocity flag over a trailing 4-week window).
    const userRows = await tx.execute<{ teammate_id: string; name: string; spend_usd: string; has_claude: boolean; has_copilot: boolean; flagged: boolean }>(sql`
      WITH win AS (
        SELECT ar.teammate_id, ar.ts_event, ar.cost_usd, ar.tool
        FROM v_complete_usage ar
        WHERE ${usageScope}
          AND ar.ts_event >= LEAST(${monthStart}::timestamptz, ${prior3From}::timestamptz)
          AND ar.ts_event < ${nowIso}::timestamptz
      ),
      per_user AS (
        SELECT teammate_id,
               COALESCE(SUM(cost_usd) FILTER (WHERE ts_event >= ${monthStart}::timestamptz), 0) AS mtd_spend,
               bool_or(tool = 'claude-code') FILTER (WHERE ts_event >= ${monthStart}::timestamptz) AS has_claude,
               bool_or(tool = 'copilot-cli') FILTER (WHERE ts_event >= ${monthStart}::timestamptz) AS has_copilot,
               COALESCE(SUM(cost_usd) FILTER (WHERE ts_event >= ${weekStart}::timestamptz), 0) AS cw,
               COALESCE(SUM(cost_usd) FILTER (WHERE ts_event >= ${prior3From}::timestamptz AND ts_event < ${weekStart}::timestamptz), 0) AS prior3
        FROM win GROUP BY teammate_id
      )
      SELECT pu.teammate_id::text AS teammate_id, COALESCE(t.display_name, t.email) AS name,
             pu.mtd_spend::text AS spend_usd, COALESCE(pu.has_claude, FALSE) AS has_claude, COALESCE(pu.has_copilot, FALSE) AS has_copilot,
             (pu.prior3 > 0 AND pu.cw >= ${FLAG_MULT} * (pu.prior3 / 3.0)) AS flagged
      FROM per_user pu JOIN teammate t ON t.id = pu.teammate_id
      WHERE pu.mtd_spend > 0
      ORDER BY pu.mtd_spend DESC LIMIT 25`)

    // 7. 14-week trend (vendor-coloured). Reads v_effective_spend (hot raw + cold rollup) so the
    //    trend survives ledger retention dropping >13-week-old raw. This is the USAGE-signal
    //    trend, so it must include Copilot the same way the header (attribution_record) does.
    //    Filter by the OTel SOURCE lanes (attribution + rollup), NOT spend_class='estimated':
    //    Copilot OTel is cost_basis='telemetry-only' → spend_class='indicative' (mig 0039), so
    //    the old 'estimated' filter hid Copilot from the trend while the header showed it
    //    (ADR-0010 — keep the two consistent). 'reconciliation'-source deltas stay excluded.
    const trendRows = await tx.execute<{ week_start: string; claude: string; copilot: string }>(sql`
      SELECT date_trunc('week', es.occurred_at AT TIME ZONE 'UTC')::date::text AS week_start,
             COALESCE(SUM(es.cost_usd) FILTER (WHERE es.tool = 'claude-code'), 0)::text  AS claude,
             COALESCE(SUM(es.cost_usd) FILTER (WHERE es.tool = 'copilot-cli'), 0)::text  AS copilot
      FROM v_effective_spend es
      WHERE es.source IN ('attribution', 'rollup')
        AND es.teammate_id IN (${practicePeople})
        AND es.occurred_at >= ${trendFrom}::timestamptz
        AND es.occurred_at < ${nowIso}::timestamptz
      GROUP BY 1 ORDER BY 1`)

    // 8. Comparison — sibling practices, RE-GATED to the caller's own scope (per-panel; a pure
    //    owner only sees practices they also own). Each sibling's subtree usage + vendor split.
    const compRows = await tx.execute<{ id: string; display_name: string; code: string; usage_usd: string; claude: string; copilot: string }>(sql`
      WITH sibs AS (
        SELECT s.id, s.display_name, s.code, s.path
        FROM org_unit s
        WHERE s.is_cost_owning_unit = TRUE AND s.retired_at IS NULL AND s.region_id = ${p.region_id}::uuid
          AND s.parent_id IS NOT DISTINCT FROM ${p.parent_id}::uuid
          AND ( ${orgSubtreeScopePredicate('s')}
                OR EXISTS (SELECT 1 FROM cou_owner co WHERE co.org_unit_id = s.id
                           AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid AND co.revoked_at IS NULL) )
      )
      SELECT sibs.id::text AS id, sibs.display_name, sibs.code,
             COALESCE(SUM(ar.cost_usd), 0)::text AS usage_usd,
             ${claudeUsd}::text AS claude, ${copilotUsd}::text AS copilot
      FROM sibs
      LEFT JOIN org_unit ou ON ou.path <@ sibs.path AND ou.region_id = ${p.region_id}::uuid
      LEFT JOIN teammate tm ON tm.org_unit_id = ou.id
      LEFT JOIN v_complete_usage ar ON ar.teammate_id = tm.id
        AND ar.ts_event >= ${monthStart}::timestamptz AND ar.ts_event < ${nowIso}::timestamptz
      GROUP BY sibs.id, sibs.display_name, sibs.code
      ORDER BY SUM(ar.cost_usd) DESC NULLS LAST LIMIT 8`)

    return {
      period: 'mtd',
      practice: { id: p.id, code: p.code, displayName: p.display_name, regionId: p.region_id },
      header: {
        usageUsd,
        tokens: Number(h.tokens),
        users,
        avgPerUser: users > 0 ? usageUsd / users : 0,
        pctOfRegion,
        vsRegionAvgPct,
      },
      lanes: {
        usageSignalUsd: usageUsd,
        billUsd: bill.total,
        billTokens: bill.tokens,
      },
      // Weekly per-lane §B bill series (lane-visuals V4): (weekStart, lane, usd)
      // cells over the trailing 14 weeks, registry lane ids, canonical order.
      // Σ lanes per week == that week's showback total (conservation, test-pinned).
      billWeeklyLanes,
      // Ordered per-lane split (#142): non-Code Claude surfaces are bill-only
      // (usageUsd structurally 0 — no OTel). Zero-zero lanes are elided so the
      // UI renders only surfaces this practice actually has — EXCEPT claude and
      // copilot, which always render (the two primary lanes anchor the page
      // even at $0; a practice with no spend still shows its baseline lanes).
      vendorSplit: VENDOR_LANES.map((lane) => ({
        lane,
        label: VENDOR_LABELS[lane],
        usageUsd: lane === 'claude' ? Number(h.claude) : lane === 'copilot' ? Number(h.copilot) : lane === 'other' ? Number(h.other) : 0,
        billUsd: billByLane[lane],
      })).filter((l) => l.usageUsd > 0 || l.billUsd > 0 || l.lane === 'claude' || l.lane === 'copilot'),
      topModels: [...modelRows].map((m) => ({ model: m.model, usageUsd: Number(m.usage_usd) })),
      users: [...userRows].map((u) => ({
        teammateId: u.teammate_id, name: u.name, spendUsd: Number(u.spend_usd),
        vendors: [u.has_claude ? 'claude' : null, u.has_copilot ? 'copilot' : null].filter(Boolean),
        flagged: u.flagged,
      })),
      trend: [...trendRows].map((t) => ({ weekStart: t.week_start, claudeUsd: Number(t.claude), copilotUsd: Number(t.copilot) })),
      comparison: [...compRows].map((c) => ({
        id: c.id, code: c.code, displayName: c.display_name,
        usageUsd: Number(c.usage_usd), claudeUsd: Number(c.claude), copilotUsd: Number(c.copilot),
        isSelf: c.id === p.id,
      })),
      planMix: null, // DEFERRED (design slice 5): spike the license_org/tier join first.
    }
  })
})
