/*
 * reporting/across-regions — the query layer behind the Across-Regions reporting
 * scope (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5).
 *
 * WHOLE-OF-COMPANY. This scope has no region/ou params — it is the enterprise
 * rollup, and its ONLY audience is platform-admin (RBAC enforced
 * in the endpoints via requireRole; there is no per-caller scope predicate to
 * apply because there is nothing to clamp — it is every region). RLS is inert at
 * runtime (see server/db/request-rls.ts), so a query with no scope clause sums
 * the entire company, exactly as intended.
 *
 * ONE lane per axis (build-design §4):
 *   - KPIs / region cards / drivers / concentration → the §A completeness lane
 *     (attribution ∪ the API−OTel gap), read through `usage_rollup_daily` — the
 *     day-grain rollup DEFINED as an aggregate of `v_complete_usage`
 *     (docs/design/usage-rollup-lane.md R5; seasonality alone stays on the
 *     view — it is off the page's request path); region cards and the region axis
 *     group by each person's CURRENT region (v_usage_rollup_current).
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane), region grain. The Copilot chargeable is gated on
 *     `copilot.mode` (build-design §6 interim labelling) — held back with a
 *     "pending" marker until Wave 0 validates on Dev.
 * No reporting query here touches `attribution_record` or raw `actual_spend`
 * (the lane firewall, build-design §7(7) — test-enforced over BOTH
 * `server/api/v1/reports/**` and `server/reporting/**`).
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import { wholeCompanyFinance, wholeCompanyUsage } from './engine/scope'
import { fetchKpiCore, type ReportKpiCore } from './engine/kpis'
import { fetchPerPerson, type PerPersonKpi } from './engine/per-person'
import { fetchDrivers, type DriversResult } from './engine/drivers'
import type { ServerClock } from '../../shared/reports/clock'
import { fetchUsageWeeklyLanes, fetchDailyMetrics } from './engine/usage-series'
import { fetchUsageBudgetCoverage } from './engine/usage-coverage'
import { fetchTierExposure } from './engine/tier-exposure'
import {
  fetchChargebackTrend,
  fetchChargebackLaneTrend,
  fetchChargebackLanes,
} from './engine/chargeback-series'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { csvEscape, csvMetaLine } from '../utils/csv-escape'
import { laneListSql, SECTION_A_USAGE_TOOLS } from '../../shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '../../shared/usage/surface'
import type { SpendLens } from '../../shared/usage/lens'
import {
  GITHUB_CHARGEABLE_LANES,
  GITHUB_FIREWALL_EXCLUSIONS,
  COPILOT_CLI_TOOL,
  COPILOT_AGENT_TOOL,
} from '../../shared/usage/github-surface'
import {
  buildSeasonality,
  fillDowBuckets,
  driverProvenanceCsvCells,
  driverSurfaceMixCsvCell,
  driverArmCsvLines,
  type UsageWindow,
} from './params'
import type { MonthRangeUtc } from '../utils/period'
import type {
  MeasureLane,
  BilledLaneMeta,
  ChargebackCoverage,
  DriverRow,
  DailyMetric,
  ProviderSplit,
  AcrossTrendPoint,
  ActiveTrendPoint,
  SeasonalityCell,
  ChargeDailyPoint,
  ChargeLanePoint,
  ChargebackLaneRow,
  ChargeDowBucket,
  UsageSurfaceWeeklyCell,
  UsageBudgetCoverage,
} from '../../shared/reports/types'
import type { TierExposure } from '../../shared/reports/tier-exposure'
/*
 * The concentration MATHS lives in shared/ because the Region width computes the
 * same statistic client-side and was cutting the cohorts with a different
 * rounding rule. Imported here for this module's own use, and re-exported below
 * so every existing importer of this module is unaffected.
 */
import { computeConcentration } from '../../shared/reports/concentration'
import type { ConcentrationStats } from '../../shared/reports/concentration'

type Tx = PostgresJsDatabase<Record<string, unknown>>


/**
 * A half-open `[startIso, endIso)` usage window — re-exported from `./params`
 * (the shared definition every reporting lib binds on). `MonthRangeUtc` and the
 * resolved window are both structural supersets, so month-path callers (and
 * `/reports/export`) pass their resolved month range unchanged.
 */
export type { UsageWindow }

/**
 * The drivers axis (build-design §2 `/reports/across-regions/drivers`).
 *
 * 'project' is here because the unit of account is the budgeted project (D1):
 * a whole-company viewer's first question is which PROJECTS carry the spend,
 * and the axis is the same seam grouping the Regional scope and the Cost-Centre
 * drill read, with no scope clamp.
 *
 * 'region' is NOT here, and its absence is the fix rather than an omission
 * (prototype.html `note('fix 4a', …)`). The whole-company page already answers
 * "which region" in its own Regions table, off `fetchAcrossRegionCards`; the
 * pivot answered it a second time off `v_complete_usage` and the two disagreed —
 * different values AND a different rank order. One fact needs one home, so the
 * pivot's copy is the one that goes. `parseAxis` falls a saved `?axis=region`
 * URL back to `project` rather than 400-ing it.
 */
export const ACROSS_DRIVER_AXES = [
  'practice',
  'teammate',
  'model',
  'project',
  'surface',
] as const
export type AcrossDriverAxis = (typeof ACROSS_DRIVER_AXES)[number]

// ── KPIs (whole-company headline) ────────────────────────────────────────────
/**
 * The whole-company KPI row: the engine's KPI core, plus the one derived figure
 * this scope still adds. Both MoM deltas moved INTO the core when the Region
 * width started rendering the same KPI row — see engine/kpis.ts.
 */
export interface AcrossKpis extends ReportKpiCore {
  /** §A genuine ÷ activeUsers (0 when no active users). Never a §B operand. */
  avgPerUserUsd: number
}

/**
 * The whole-company KPI row: the shared core summed with NO clamp on either lane
 * (`wholeCompanyUsage` / `wholeCompanyFinance` — a written declaration that this
 * really is every region, see engine/scope.ts), plus `avgPerUserUsd`.
 *
 * Both MoM deltas ride the core and are MONTH-ANCHORED: they are computed only when
 * `opts.momMonthRange` (the viewed month's range) is supplied — the month path
 * passes it; a custom `from`/`to` range does NOT (and the export path omits it), so
 * the deltas are `null` (an MTD delta has no meaning for an arbitrary span).
 */
export async function fetchAcrossKpis(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<AcrossKpis> {
  const core = await fetchKpiCore(
    tx,
    {
      usage: wholeCompanyUsage,
      finance: wholeCompanyFinance,
      // Whole-company, so one key for every caller.
      monthFloorKey: 'across:global',
    },
    window,
    opts,
  )

  return {
    // Spread rather than re-listed field by field: a figure added to the core is
    // then published by BOTH scopes, which is the whole point of sharing it.
    // `prevGenuineUsd` / `momDeltaPct` now ride the core (engine/kpis.ts) — both
    // widths render the delta, so both compute it from one clamped query.
    ...core,
    avgPerUserUsd: core.activeUsers > 0 ? core.genuineUsd / core.activeUsers : 0,
  }
}

// ── Daily metrics (§A usage sparkline series) ────────────────────────────────
/**
 * The whole-company §A per-day usage series over the window (`usage_rollup_daily`,
 * usage-rollup-lane.md R5) —
 * one row per UTC day in the window THAT HAS HAPPENED — zero-filled, so a day
 * with no usage is present with 0s rather than absent: `SUM(cost_usd)`,
 * `SUM(tokens)`, `COUNT(DISTINCT teammate_id)`, ordered by day. Dropping empty
 * days would compress scattered activity into contiguous points and misstate the
 * month's shape; emitting days that have not occurred asserts spend collapsed to
 * zero. The exact bound lives on `fetchDailyMetrics` (engine/usage-series.ts).
 * Feeds the KPI-tile sparklines
 * (Attributed usage / Tokens / Active users / Avg usage). Pure usage lane — the
 * chargeable tile has NO daily grain (the finance lane is month-grained) and so
 * gets no sparkline (honest).
 */
export async function fetchAcrossDailyMetrics(
  tx: Tx,
  window: UsageWindow,
  clock: ServerClock,
): Promise<DailyMetric[]> {
  return fetchDailyMetrics(tx, wholeCompanyUsage, window, clock)
}

// ── §A budget coverage (the denominator beside the company's own headline) ───
/**
 * The whole-company budget-coverage decomposition of `fetchAcrossKpis`'
 * `genuineUsd` — how much of the company's attributed usage sits on a budgeted
 * project and how much sits outside the budget lens.
 *
 * Unclamped for the same reason every other Across query is: this IS the
 * whole-company claim. Its `totalUsd` is the company headline, so the parts foot
 * to the number they are rendered beside. Pure §A — no bill-lane operand (C2).
 *
 * The scope NAME is stated here, next to `wholeCompanyUsage`, rather than typed into a
 * template: the two are one decision, and the surface that renders the figure cannot
 * see which scope produced it.
 */
export async function fetchAcrossUsageBudgetCoverage(
  tx: Tx,
  window: UsageWindow,
): Promise<UsageBudgetCoverage> {
  return fetchUsageBudgetCoverage(tx, wholeCompanyUsage, window, 'the whole company')
}

// ── §B behavioural exposure (model-tier bands over provider_usage_fact) ──────
/**
 * The whole-company Behavioural-exposure card: billed spend against consumption,
 * banded by `model_catalog.tier`, for the window AND as a day-grain series over
 * it (the Region card passes the rolling 60-day window — a share metric with no
 * time axis cannot show that a policy worked).
 *
 * `wholeCompanyFinance` is a written declaration that this really is every
 * region (engine/scope.ts), not a clamp somebody forgot to pass. §B lane
 * (`provider_usage_fact`) — NEVER summed with the §A `genuineUsd` headline
 * beside it on the same page (contract C2).
 */
export async function fetchAcrossTierExposure(
  tx: Tx,
  window: UsageWindow,
): Promise<TierExposure> {
  return fetchTierExposure(tx, wholeCompanyFinance, window)
}

// ── §B chargeback daily trend (bill lane — day-grained, whole-company) ───────
/**
 * The whole-company §B ANTHROPIC chargeback per-day series over the window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane). One point per UTC
 * day, `SUM(bill_usd)`, zero-filled across every day of the window that has HAPPENED
 * (like the §A daily metrics — same bound, see engine/chargeback-series.ts) so the
 * trend/sparkline's temporal shape stays honest. Copilot is ABSENT by
 * construction (its chargeback is pooled, MONTH-grained — never in this view), so this
 * is a single Anthropic series; the card's caveat explains the pooled Copilot exclusion.
 * Feeds BOTH the chargeback-mode spend-trend card (rolling window) and the Chargeable
 * KPI-tile sparkline (KPI window). NEVER summed with the §A usage `cost_usd`.
 */
export async function fetchAcrossChargebackTrend(
  tx: Tx,
  window: UsageWindow,
  clock: ServerClock,
): Promise<ChargeDailyPoint[]> {
  return fetchChargebackTrend(tx, wholeCompanyFinance, window, clock)
}

// ── §B chargeback lane trend (bill lane, per-lane — lane-visuals V2) ──────────

/**
 * The per-LANE widening of {@link fetchAcrossChargebackTrend}: the SAME
 * `v_finance_bill_chargeback` window, GROUP BY tool, each tool mapped to its
 * registry lane id via `chargeToVendor` (claude-code → claude, each #142
 * non-Code surface → its own lane, unknown/NULL → other). NOT zero-filled —
 * the total `chargeSeries` stays the zero-filled axis/total of record; this
 * series carries only (day, lane) cells with rows, and Σ lanes per day equals
 * that day's `chargeUsd` cent-exactly (test-pinned). Copilot lanes are
 * structurally ABSENT (the mig-0085 firewall: §B Copilot is pooled, MONTH-
 * grained, never in this daily view). Never summed with §A usage.
 */
export async function fetchAcrossChargebackLaneTrend(
  tx: Tx,
  window: UsageWindow,
): Promise<ChargeLanePoint[]> {
  return fetchChargebackLaneTrend(tx, wholeCompanyFinance, window)
}

// ── §A per-surface weekly usage lanes (the usage-view composition hero) ──────
/**
 * The whole-company canonical §A USAGE weekly lane series over the window
 * (`usage_rollup_daily` GROUP BY `date_trunc('week', day)` × tool, tools
 * mapped to registry lane ids via `toolToVendor`) — the "Where the AI spend
 * goes" hero + its pinned "Spend by surface" donut (requirement 1). REPLACES
 * the former billed-showback-basis fetcher (`v_finance_bill_showback`) that fed
 * this same hero while it was still labelled "usage" — the exact mixed-lens
 * defect this restores. EVERY §A surface rides this cell natively, including
 * `copilot`/`copilot-agent` (no GitHub firewall — that firewall existed only to
 * keep usage-basis rows out of a BILLED view; this view IS the usage basis). Σ
 * cells over this window == `fetchAcrossKpis(...).genuineUsd` for the SAME
 * window, cent-exact (test-pinned) — the sum-back this requirement restores.
 * NOT zero-filled (the client's week axis zero-fills); NEVER summed with any
 * §B chargeback figure.
 */
export async function fetchAcrossUsageWeeklyLanes(
  tx: Tx,
  window: UsageWindow,
): Promise<UsageSurfaceWeeklyCell[]> {
  return fetchUsageWeeklyLanes(tx, wholeCompanyUsage, window)
}

// ── §B chargeback lane totals (bill lane — the split-donut operand, lane-visuals V2) ─
/**
 * Per-lane §B chargeback totals over the window — the ChargebackSplitCard donut
 * operand. Two arms, mirroring the KPI composition EXACTLY (so the donut sums
 * back to `fetchAcrossKpis.chargeableUsd` cent-exactly):
 *   - ANTHROPIC: day-grained `v_finance_bill_chargeback` GROUP BY tool over the
 *     exact window (Σ == `anthropicChargeableUsd` for ANY range), lanes via
 *     `chargeToVendor`;
 *   - COPILOT (§B lanes): pooled-monthly `v_finance_copilot_pool_chargeback`,
 *     included ONLY when `copilotChargeback` AND the window is month-aligned —
 *     the same gate as the KPI fold (never a partial-month slice, never a
 *     silent $0). ALL three lanes ride along, INCLUDING copilot-unclassified:
 *     it is VISIBLE (badged) but excluded from every chargeable sum by the UI
 *     (the FinanceCouTable convention) — Σ(lanes minus unclassified) == the
 *     chargeable headline.
 * Rows are emitted in canonical VENDOR_LANES order; zero-amount lanes with no
 * rows are omitted (UI elides zeros anyway).
 */
export async function fetchAcrossChargebackLanes(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<ChargebackLaneRow[]> {
  return fetchChargebackLanes(tx, wholeCompanyFinance, window, opts)
}

// ── §B chargeback day-of-week (bill lane — "when spend happens", whole-company) ─
/**
 * The whole-company §B ANTHROPIC chargeback grouped by ISO day-of-week over the window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW) - 1` → Mon=0..Sun=6, matching the §A
 * seasonality dow convention). Always seven buckets (zero-filled) so the card renders a
 * stable Mon..Sun layout. Anthropic-only (Copilot pooled/monthly). The §B analogue of
 * the seasonality heatmap; never summed with §A usage.
 */
export async function fetchAcrossChargebackDow(
  tx: Tx,
  window: UsageWindow,
): Promise<ChargeDowBucket[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ dow: number; charge: string }>(sql`
    SELECT (EXTRACT(ISODOW FROM period_date)::int - 1) AS dow,
           COALESCE(SUM(bill_usd), 0)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY 1`)
  const byDow = new Map<number, number>()
  for (const r of rows) byDow.set(Number(r.dow), Number(r.charge))
  return fillDowBuckets(byDow)
}

// ── Per-region comparison cards ──────────────────────────────────────────────
export interface AcrossRegionCard {
  /** `null` for the explicit "Unassigned" bucket (usage with no region_id). */
  regionId: string | null
  code: string | null
  displayName: string
  genuineUsd: number
  anthropicChargeableUsd: number
  copilotChargeableUsd: number
  /** Anthropic + (chargeback-mode ? Copilot pooled net : 0). */
  chargeableUsd: number
  activeUsers: number
  avgPerUserUsd: number
  /** Region genuine ÷ company genuine, a FRACTION in [0,1]. */
  sharePct: number
}

/**
 * Per-region comparison cards (build-design §3 "region cards"; PRD region
 * comparison: $, %, active users, avg/user). Usage by each person's CURRENT region from
 * `v_usage_rollup_current` (the §A rollup — usage-rollup-lane.md R5; teammate_id is
 * in its grain, so the distinct-user count is exact) merged with the
 * finance-lane chargeable pair. The NULL
 * region_id bucket is retained as an explicit "Unassigned" card so the cards SUM
 * BACK to the genuine headline (never silently dropped).
 */
export async function fetchAcrossRegionCards(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<AcrossRegionCard[]> {
  const usageRows = await tx.execute<{
    region_id: string | null
    code: string | null
    display_name: string | null
    genuine: string
    active_users: number
  }>(sql`
    SELECT u.region_id::text AS region_id, r.code, r.display_name,
           COALESCE(SUM(u.cost_usd), 0)::text AS genuine,
           COUNT(DISTINCT u.teammate_id)::int AS active_users
    FROM v_usage_rollup_current u
    LEFT JOIN region r ON r.id = u.region_id
    WHERE u.day >= ${window.startIso.slice(0, 10)}::date
      AND u.day <  ${window.endIso.slice(0, 10)}::date
    GROUP BY u.region_id, r.code, r.display_name
    ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)

  // Finance/bill lane is month-grained — sum every period_month inside the window
  // (a single month → today's one-row result; a multi-month range sums them).
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Registry-driven §B lane split (mig 0085): anthropic = NOT the unified GitHub
  // firewall set (every lane id + §A tool literal — a stray §A copilot row must
  // never count as Anthropic, r1 finding 1); copilot = the CHARGEABLE lanes only
  // (unclassified never charges).
  const chargeRows = await tx.execute<{
    region_id: string | null
    anthropic: string
    copilot: string
  }>(sql`
    SELECT region_id::text AS region_id,
           COALESCE(SUM(charge_usd) FILTER (WHERE tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)})), 0)::text AS anthropic,
           COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})), 0)::text  AS copilot
    FROM v_finance_chargeback_month
    WHERE period_month >= ${startDate}::date AND period_month < ${endDate}::date
    GROUP BY region_id`)

  const chargeByRegion = new Map<string | null, { anthropic: number; copilot: number }>()
  for (const c of chargeRows) {
    chargeByRegion.set(c.region_id ?? null, {
      anthropic: Number(c.anthropic),
      copilot: Number(c.copilot),
    })
  }

  const rows = [...usageRows]
  const totalGenuine = rows.reduce((a, r) => a + Number(r.genuine), 0)
  return rows.map((r) => {
    const genuineUsd = Number(r.genuine)
    const activeUsers = Number(r.active_users)
    const charge = chargeByRegion.get(r.region_id ?? null) ?? { anthropic: 0, copilot: 0 }
    return {
      regionId: r.region_id,
      code: r.code,
      displayName: r.display_name ?? 'Unassigned',
      genuineUsd,
      anthropicChargeableUsd: charge.anthropic,
      copilotChargeableUsd: charge.copilot,
      chargeableUsd: charge.anthropic + (opts.copilotChargeback ? charge.copilot : 0),
      activeUsers,
      avgPerUserUsd: activeUsers > 0 ? genuineUsd / activeUsers : 0,
      sharePct: totalGenuine > 0 ? genuineUsd / totalGenuine : 0,
    }
  })
}

// ── Chargeback-by-region (§B bill lane — the chargeback analogue of the region cards) ─
export interface AcrossChargebackRegionRow {
  /** `null` for the explicit "Unassigned" bucket (charge with no `region_id`). */
  regionId: string | null
  label: string
  chargeableUsd: number
}

/**
 * Rank the whole-company §B CHARGEBACK by region, off the bill lane — NEVER
 * `v_complete_usage` — GROUP BY `region_id`. The chargeback-lane swap for the usage
 * region cards: because it ranks off the bill lane rather than the usage-present regions,
 * a region with §B charge but ZERO in-window usage still appears (the usage-card path
 * silently dropped it). The NULL `region_id` bucket is retained as an explicit "Unassigned"
 * row so the ranking SUMS BACK to the whole-company chargeable headline
 * (`fetchAcrossKpis.chargeableUsd`).
 *
 * The two providers use DIFFERENT grains (the grain-mismatch fix): the Anthropic arm reads
 * the DAY-grained `v_finance_bill_chargeback` over the exact `[startDate, endDate)` window,
 * so it foots to the same windowed Anthropic total the KPI shows for ANY range (a
 * non-month-aligned custom range no longer drops it). Copilot pooled net is POOLED-MONTHLY
 * (`v_finance_copilot_pool_chargeback`, no daily grain) and is folded in only when
 * `copilotChargeback` (build-design §6). The two arms UNION by `region_id`. The §A
 * counterpart of the region cards; mirrors the regional `fetchRegionalChargebackByCostCentre`.
 */
export async function fetchAcrossChargebackByRegion(
  tx: Tx,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<AcrossChargebackRegionRow[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  // Copilot arm: pooled MONTHLY, folded on top only in chargeback mode (pending Wave-0
  // validation otherwise) so the ranking foots to the same chargeable the KPI shows.
  const copilotArm = opts.copilotChargeback
    ? sql`
      UNION ALL
      SELECT region_id, SUM(charge_usd) AS value
      FROM v_finance_copilot_pool_chargeback
      WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY region_id`
    : sql``
  const rows = await tx.execute<{
    region_id: string | null
    label: string | null
    value: string
  }>(sql`
    WITH charges AS (
      SELECT region_id, SUM(bill_usd) AS value
      FROM v_finance_bill_chargeback
      WHERE period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY region_id
      ${copilotArm}
    )
    SELECT c.region_id::text AS region_id, r.display_name AS label,
           COALESCE(SUM(c.value), 0)::text AS value
    FROM charges c LEFT JOIN region r ON r.id = c.region_id
    GROUP BY c.region_id, r.display_name
    ORDER BY SUM(c.value) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    regionId: r.region_id,
    // A true NULL region_id is the "Unassigned" bucket; a non-null region_id with no
    // matching region row (FK-orphan, LEFT JOIN miss) is a DISTINCT "Unknown region"
    // — never merge the two into one "Unassigned" bar (round-2 #6).
    label: r.label ?? (r.region_id ? 'Unknown region' : 'Unassigned'),
    chargeableUsd: Number(r.value),
  }))
}

// ── Per-provider split (vendor breakdown over the window) ────────────────────
/**
 * The whole-company per-provider split over the window (`usage_rollup_daily`,
 * the §A rollup — usage-rollup-lane.md R5): one bucket per named §A lane — `claude-code` → `claudeCode`,
 * `copilot-cli` → `copilotCli`, `copilot-agent` → `copilotAgent` (the three-lane
 * §A ceiling, registry-driven via SECTION_A_USAGE_TOOLS) — plus the live `other`
 * catch-all (everything else incl. NULL tool). `spendUsd` sums back to the
 * genuine headline (every record lands in exactly one bucket); `activeUsers` is
 * `COUNT(DISTINCT teammate_id)` per bucket (NOT additive — a teammate active in
 * two vendors is counted in both). `copilot-agent` is a real, live
 * `v_complete_usage` lane (migration 0101's ingest-only completeness arm,
 * Workstream A), so its bucket carries genuine spend once the coding agent is used.
 */
export async function fetchProviderSplit(tx: Tx, window: UsageWindow): Promise<ProviderSplit> {
  const [row] = [
    ...(await tx.execute<{
      cc_spend: string
      cc_users: number
      cp_spend: string
      cp_users: number
      ca_spend: string
      ca_users: number
      ot_spend: string
      ot_users: number
    }>(sql`
      SELECT
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL}), 0)::text AS cc_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL})::int AS cc_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_CLI_TOOL}), 0)::text AS cp_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${COPILOT_CLI_TOOL})::int AS cp_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL}), 0)::text AS ca_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL})::int AS ca_users,
        COALESCE(SUM(cost_usd) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL), 0)::text AS ot_spend,
        COUNT(DISTINCT teammate_id) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL)::int AS ot_users
      FROM usage_rollup_daily
      WHERE day >= ${window.startIso.slice(0, 10)}::date
        AND day <  ${window.endIso.slice(0, 10)}::date`)),
  ]
  return {
    claudeCode: { spendUsd: Number(row?.cc_spend ?? 0), activeUsers: Number(row?.cc_users ?? 0) },
    copilotCli: { spendUsd: Number(row?.cp_spend ?? 0), activeUsers: Number(row?.cp_users ?? 0) },
    copilotAgent: { spendUsd: Number(row?.ca_spend ?? 0), activeUsers: Number(row?.ca_users ?? 0) },
    other: { spendUsd: Number(row?.ot_spend ?? 0), activeUsers: Number(row?.ot_users ?? 0) },
  }
}

// ── Trend (day grain, vendor-stacked, whole-company) ─────────────────────────
/**
 * The whole-company day-grain vendor-stacked usage trend over the window (mirrors
 * the Regional trend one tier up). One point per (day, vendor) with a positive
 * cost; `key` is the `tool` id — the three named §A lanes (`claude-code` /
 * `copilot-cli` / `copilot-agent`, registry-driven via SECTION_A_USAGE_TOOLS)
 * plus the live `other` catch-all. `copilot-agent` is a real, live
 * `v_complete_usage` lane (migration 0101's ingest-only completeness arm), so
 * its points appear on any day the coding agent is used.
 */
export async function fetchAcrossTrend(tx: Tx, window: UsageWindow): Promise<AcrossTrendPoint[]> {
  const rows = await tx.execute<{
    day: string
    claude: string
    copilot: string
    agent: string
    other: string
  }>(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${CLAUDE_CODE_TOOL}), 0)::text AS claude,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_CLI_TOOL}), 0)::text AS copilot,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool = ${COPILOT_AGENT_TOOL}), 0)::text AS agent,
           COALESCE(SUM(cost_usd) FILTER (WHERE tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR tool IS NULL), 0)::text AS other
    FROM usage_rollup_daily
    WHERE day >= ${window.startIso.slice(0, 10)}::date
      AND day <  ${window.endIso.slice(0, 10)}::date
    GROUP BY 1 ORDER BY 1`)
  const series: AcrossTrendPoint[] = []
  for (const r of rows) {
    if (Number(r.claude) > 0) series.push({ day: r.day, key: 'claude-code', value: Number(r.claude) })
    if (Number(r.copilot) > 0) series.push({ day: r.day, key: 'copilot-cli', value: Number(r.copilot) })
    if (Number(r.agent) > 0) series.push({ day: r.day, key: 'copilot-agent', value: Number(r.agent) })
    if (Number(r.other) > 0) series.push({ day: r.day, key: 'other', value: Number(r.other) })
  }
  return series
}

// ── Drivers (axis-switchable, whole-company) ─────────────────────────────────
/**
 * Ranked drivers for one axis over the WHOLE company, with in-scope denominators
 * that sum back to the genuine headline (build-design §7(4)).
 *
 * `wholeCompanyUsage` is a written declaration that this table really is every
 * region (engine/scope.ts), not a clamp someone forgot to pass. ACROSS_DRIVER_AXES
 * is what gates the axis a request may name, and it is the only one of the two
 * scopes that offers `region` — a region ranking needs every region in the scan.
 */
export async function fetchAcrossDrivers(
  tx: Tx,
  range: UsageWindow,
  axis: AcrossDriverAxis,
  lens: SpendLens = 'usage',
  /** `copilotChargebackEnabled()` — gates the POOLED Copilot chargeback arm. */
  opts: { copilotChargeback?: boolean } = {},
): Promise<DriversResult> {
  return fetchDrivers(tx, wholeCompanyUsage, range, axis, lens, {
    // Unclamped on the §B lane too — the whole-company chargeback really is
    // every cost centre, and `wholeCompanyFinance` is the written declaration of
    // that rather than a clamp someone forgot (engine/scope.ts).
    financeScope: wholeCompanyFinance,
    copilotChargeback: opts.copilotChargeback ?? false,
    // This scope's OWN gate, so a "break down by …" gap sentence can only name a
    // pivot this reader actually has — region is rankable and no longer offered.
    offeredAxes: ACROSS_DRIVER_AXES,
  })
}

// ── Concentration + segments (build-design §5, AEUF cut-points) ───────────────
/*
 * The MATHS moved to shared/reports/concentration.ts, because the Region width
 * computes the same statistic client-side from its own driver rows and was
 * cutting the cohorts with a different rounding rule. Re-exported here so every
 * existing importer of this module is unaffected.
 */
export {
  computeConcentration,
  type ConcentrationSegmentKey,
  type ConcentrationSegmentStat,
  type ConcentrationCohortStat,
  type ConcentrationStats,
} from '../../shared/reports/concentration'

/**
 * Company-wide spend concentration for the month — one ranked query (per-teammate
 * month cost, DESC) fed to {@link computeConcentration}. Same usage lane as the
 * drivers, so it reconciles to the genuine headline.
 */
export async function fetchConcentration(
  tx: Tx,
  range: UsageWindow,
): Promise<ConcentrationStats> {
  const rows = await tx.execute<{ cost: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS cost
    FROM usage_rollup_daily
    WHERE day >= ${range.startIso.slice(0, 10)}::date
      AND day <  ${range.endIso.slice(0, 10)}::date
    GROUP BY teammate_id
    HAVING COALESCE(SUM(cost_usd), 0) > 0
    ORDER BY SUM(cost_usd) DESC`)
  return computeConcentration([...rows].map((r) => Number(r.cost)))
}

// ── Per-person KPI (the "Median per person" tile and its percentiles) ────────
/*
 * The cohort query, its shape and its MoM pacing now live in
 * engine/per-person.ts, clamped by a `UsageScope` like every other engine read —
 * because the Region width publishes the same tile and must not compute it from a
 * second query. `AcrossPerPerson` is retained as this scope's name for the shape
 * (the route and the client type both spell it that way).
 */
export type AcrossPerPerson = PerPersonKpi

/** The whole-company per-person cohort: the shared engine read with NO clamp. */
export async function fetchAcrossPerPerson(
  tx: Tx,
  window: UsageWindow,
  opts: { momMonthRange?: MonthRangeUtc | null; asOfDate?: string | null } = {},
): Promise<AcrossPerPerson> {
  return fetchPerPerson(tx, wholeCompanyUsage, window, opts)
}

// ── Seasonality (day-of-week × ISO-week heatmap, whole-company) ───────────────
/**
 * The whole-company day-of-week × ISO-week seasonality grid over the window
 * (`v_complete_usage`). Grouped by ISO week (`IYYY-"W"IW`) × ISO dow (Mon=1..Sun=7,
 * emitted zero-based Mon=0..Sun=6), summing `cost_usd`. Only buckets with a usage
 * row are returned; the endpoint wraps the window echo. Session TZ is UTC (the same
 * convention the day-grain trend binds on).
 */
export async function fetchAcrossSeasonality(
  tx: Tx,
  window: UsageWindow,
): Promise<{ weeks: string[]; cells: SeasonalityCell[] }> {
  const rows = await tx.execute<{ iso_week: string; dow: number; value: string }>(sql`
    SELECT to_char(ts_event, 'IYYY-"W"IW') AS iso_week,
           (EXTRACT(ISODOW FROM ts_event)::int - 1) AS dow,
           COALESCE(SUM(cost_usd), 0)::text AS value
    FROM v_complete_usage
    WHERE ts_event >= ${window.startIso}::timestamptz
      AND ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1, 2
    ORDER BY 1, 2`)
  return buildSeasonality([...rows])
}

// ── Active-user trend (distinct active teammates per tool per day) ────────────
/**
 * The whole-company active-users-over-time series (`usage_rollup_daily`,
 * usage-rollup-lane.md R5 — teammate is in the grain, so the distinct counts
 * are exact): per UTC
 * day, `COUNT(DISTINCT teammate_id)` for claude-code and for copilot-cli. One point
 * per day with any usage; the two counts are NOT additive (a teammate active in
 * both tools counts in both).
 */
export async function fetchAcrossActiveTrend(
  tx: Tx,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  const rows = await tx.execute<{ day: string; claude: number; copilot: number }>(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT teammate_id) FILTER (WHERE tool = 'claude-code')::int AS claude,
           COUNT(DISTINCT teammate_id) FILTER (WHERE tool = 'copilot-cli')::int AS copilot
    FROM usage_rollup_daily
    WHERE day >= ${window.startIso.slice(0, 10)}::date
      AND day <  ${window.endIso.slice(0, 10)}::date
    GROUP BY 1 ORDER BY 1`)
  return [...rows].map((r) => ({
    day: r.day,
    claudeCode: Number(r.claude),
    copilot: Number(r.copilot),
  }))
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/** Drivers CSV — one row per driver, plus a leading provenance stamp (asOf). */
export function acrossDriversToCsv(
  rows: DriverRow[],
  /** `lane` / `billedLane` / `chargebackCoverage` — see the identical notes on
   *  regional `driversToCsv`. */
  meta: {
    month: string
    asOfDate: string | null
    axis: string
    lane: MeasureLane
    billedLane?: BilledLaneMeta
    chargebackCoverage?: ChargebackCoverage
  },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope across-regions drivers · axis=${meta.axis} · lane=${meta.lane} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company`
    ),
    'driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)},` +
        `${driverProvenanceCsvCells(r).join(',')},${csvEscape(driverSurfaceMixCsvCell(r))}`,
    ),
    ...driverArmCsvLines(meta.billedLane, meta.chargebackCoverage),
  ]
  return lines.join('\n') + '\n'
}

/**
 * Region-comparison CSV — one row per region. This is a §A USAGE comparison
 * (genuine / active users / avg-per-user / share). The region card's `chargeableUsd`
 * is month-grained AND UI-dead (the screen ranks §A off `genuineUsd` and §B off the
 * DAILY-grained `chargebackByRegion`, never this figure), so it is deliberately NOT a
 * column here — a month-grained §B figure would read $0 in a sub-month range while the
 * screen KPI (now daily) is non-zero. The §B chargeback-by-region lives in its own
 * ranking (daily bill lane); it is not mixed into this usage comparison export.
 */
export function acrossRegionsToCsv(
  cards: AcrossRegionCard[],
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope across-regions region-comparison · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company`
    ),
    'region,genuine_usd,active_users,avg_per_user_usd,share_pct',
    ...cards.map(
      (c) =>
        `${csvEscape(c.displayName)},${usd(c.genuineUsd)},${c.activeUsers},${usd(c.avgPerUserUsd)},${(c.sharePct * 100).toFixed(1)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

/** Concentration CSV — cohort shares + one row per segment (share + avg + median). */
export function concentrationToCsv(
  stats: ConcentrationStats,
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope across-regions concentration · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=whole-company · active_users=${stats.activeUsers}`
    ),
    'cohort,share_pct',
    `Top 1%,${(stats.top1 * 100).toFixed(1)}`,
    `Top 5%,${(stats.top5 * 100).toFixed(1)}`,
    `Top 10%,${(stats.top10 * 100).toFixed(1)}`,
    '',
    'segment,users,spend_usd,share_pct,avg_usd,median_usd',
    ...stats.segments.map(
      (s) =>
        `${csvEscape(s.label)},${s.count},${usd(s.totalUsd)},${(s.sharePct * 100).toFixed(1)},${usd(s.avgUsd)},${usd(s.medianUsd)}`,
    ),
  ]
  return lines.join('\n') + '\n'
}
