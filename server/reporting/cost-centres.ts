/*
 * reporting/cost-centres — the query layer behind the Cost-Centre reporting scope
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5, Wave 3).
 *
 * ONE lane, end to end (the §A completeness lane, read through the current-org
 * lens `v_complete_usage_current`): BOTH the card grid AND the drill read the
 * `cost_owning_unit_id` USAGE axis. That column is the PROJECT's Business Unit on
 * tagged OTel rows and the person's CURRENT Business Unit on provider-reported
 * rows (mig 0162, docs/design/current-org-lens/00-design.md §3.3), so a person
 * who moves takes their untaggable usage with them while project-tagged usage
 * stays with the project's unit. The tracker card shows a CC's BURN; drilling it
 * shows WHO/WHAT is burning that budget (teammate / model drivers), reconciling
 * to the SAME burn. Copilot pooled rows carry NULL cost_owning_unit_id, so
 * `WHERE cost_owning_unit_id = ccId` excludes them by construction (the labelled
 * §A gap) — the per-CC burn is Claude-heavy.
 *
 * The one exception is the 'project' drill axis, and it is deliberate: a project
 * is clamped by its OWN cost-owning unit (`project.cost_owning_unit_id` — the
 * same column the allocation denominator uses), not by the usage row's, because
 * arm 2 of the lane carries a real project with a NULL cost-owning unit. It
 * therefore has its own denominator and says so; see fetchCostCentreBurnDrivers.
 *
 * The §B chargeback/billing DRILL for a cost centre (teammate-homed finance,
 * showback vs chargeable, pooled Copilot net) lives in the FINANCE scope's own CoU
 * drill — the burn DRILL here stays pure §A (it answers "who is consuming the
 * budget", not "who gets invoiced"). The card grid, however, carries a per-CC §B
 * `chargeUsd` alongside the §A burn (`fetchCostCentreCards`) so the list can re-lens
 * to the real charge in chargeback mode — read STRICTLY from the bill lane, on the
 * SAME grains the Across/Regional scopes use (grain-mismatch fix): Anthropic from the
 * DAILY per-teammate bill view (`v_finance_bill_chargeback`, `period_date`-windowed) +
 * the POOLED-MONTHLY Copilot net (`v_finance_copilot_pool_chargeback`) folded on top
 * only over a month-aligned window. NEVER summed with the §A `cost_usd` burn.
 *
 * The lane firewall (build-design §7(7), test-enforced over `server/reporting/**`)
 * bans `attribution_record` + raw `actual_spend` only: the §A burn reads
 * `v_complete_usage`; the §B `chargeUsd` reads the `v_finance_bill_chargeback` /
 * `v_finance_copilot_pool_chargeback` views (the bill lane's own surfaces, not raw
 * `actual_spend`). The two lanes are kept side-by-side but never mixed.
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import { reportMonthFloor } from './month-floor'
import { vendorSplitAggregates } from './vendor-split'
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { orgSubtreeScopePredicate } from '../auth/org-subtree-scope'
import { orgSubtreeIds } from '../auth/org-subtree'
import { clampedUsage, type UsageScope } from './engine/scope'
import { fetchKpiCore, type ReportKpiCore } from './engine/kpis'
import { fetchPerPerson, type PerPersonKpi } from './engine/per-person'
import { fetchDailyMetrics, fetchUsageWeeklyLanes } from './engine/usage-series'
import { fetchChargebackTrend } from './engine/chargeback-series'
import { fetchUsageBudgetCoverage } from './engine/usage-coverage'
import { fetchSpendTrend, fetchActiveTrend, type TrendPoint } from './engine/trend-series'

import {
  TEAMMATE_DRILL_FACTS_AGG,
  foldTeammateDrillFacts,
  teammateDrillDims,
  NO_TEAMMATE_DRILL_FACTS,
} from './teammate-drill-facts'
import { csvEscape, csvMetaLine } from '../utils/csv-escape'
import { laneListSql, toolToVendor, VENDOR_LANES, VENDOR_LABELS, type Vendor } from '../../shared/usage/vendor'
import { GITHUB_CHARGEABLE_LANES } from '../../shared/usage/github-surface'
import { modelDriverLabel, modelDriverKey } from '../../shared/reports/model-attribution'
import { forecastForMonth } from '../reports/forecast'
import { exhaustionDate } from '../usage/projections'
import { monthKeyUtc } from '../utils/period'
import { completeProjectAxisPopulation } from '../usage/complete-spend'
import {
  isMonthAlignedWindow,
  foldDriverBreakdown,
  driverSurfaceBreakdown,
  driverProvenanceBreakdown,
  driverProvenanceCsvCells,
  driverSurfaceMixCsvCell,
  type UsageWindow,
} from './params'
import {
  costCentreBudgetState,
  type DriverRow,
  type Forecast,
  MODEL_TIER_BANDS,
  MODEL_TIER_LABELS,
  type SpendClass,
  type CostCentreScope,
  type CostCentreSummary,
  type DriverTierAmount,
  type ModelTierBand,
  type OverSoftCap,
  type DailyMetric,
  type ChargeDailyPoint,
  type UsageBudgetCoverage,
  type ActiveTrendPoint,
  type UsageSurfaceWeeklyCell,
} from '../../shared/reports/types'
import type { ServerClock } from '../../shared/reports/clock'
import { fetchCatalog, resolveTier, type CatalogEntry } from '../usage/insights'
import { clampedFinance } from './engine/scope'
import { fetchTierExposure } from './engine/tier-exposure'
import type { TierExposure } from '../../shared/reports/tier-exposure'
import { BU_LABEL_LOWER } from '../../shared/reports/vocabulary'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The minimal caller shape the scope resolvers need (a resolved Session). */
export interface CostCentreCaller {
  role: string
  regionId: string
  teammateId: string
  orgPath: string
}

export interface CostCentreRef {
  id: string
  code: string
  displayName: string
  regionId: string
  regionCode: string
}

/**
 * A cost centre the caller may SEE, plus WHY — {@link fetchVisibleCostCentres}'
 * own row shape.
 *
 * `owned` is a SEPARATE type rather than a field on `CostCentreRef` because
 * only the LIST resolver can answer it: `resolveCostCentreDrill` grants on
 * region-or-ownership and never needs to know which arm let the caller
 * through, so a shared field would have to be faked there.
 */
export interface VisibleCostCentre extends CostCentreRef {
  /**
   * True when the caller holds an active `cou_owner` grant on this unit — the
   * OWNERSHIP half of the visibility disjunction, reported rather than
   * re-derived so the scope block can land a reader on THEIR centre rather
   * than on whichever one sorts first (F5 D23).
   */
  owned: boolean
}

/**
 * The drill axis (build-design §2 `/reports/cost-centres/[ccId]`).
 *
 * 'project' LEADS because the unit of account is the budgeted project (D1) and
 * the question a cost-centre owner holds is "which project is burning my budget".
 * It was removed once, justified as "project tagging is a §B finance concern" —
 * that is a BILLING fact used to settle a USAGE question, the cross-concern
 * conflation `docs/design/provider-billing-attribution-model.md` exists to
 * prevent, and it is wrong on its own terms: project budgets are §A allocations,
 * read by this very module as the cards' allocation denominator.
 *
 * 'teammate' / 'model' / 'surface' rank the same burn by the human, the model and
 * the vendor lane. Only the three §A-burn axes reconcile to the CC burn; the
 * project axis carries a DIFFERENT denominator by construction — see
 * {@link fetchCostCentreBurnDrivers}.
 */
export const COST_CENTRE_DRILL_AXES = ['project', 'teammate', 'model', 'surface'] as const
export type CostCentreDrillAxis = (typeof COST_CENTRE_DRILL_AXES)[number]

// ── Scope resolution (index endpoint) ────────────────────────────────────────
/**
 * The set of cost-owning units the caller may SEE on the Cost-Centre scope
 * (build-design §2 RBAC): `getOwnedCostCentreIds` ∪ the cost-owning units in the
 * caller's org SUBTREE. Expressed as ONE in-query predicate so it stays under the
 * per-request GUCs (RLS is inert at runtime — server/db/request-rls.ts):
 *   - the subtree half reuses `orgSubtreeScopePredicate` (the tested org-tree
 *     clause: global-finops unbounded · admin own-region · dev/manager subtree)
 *     AND `is_cost_owning_unit = TRUE` — i.e. `orgSubtreeIds({costOwningOnly})`
 *     but role-aware.
 *   - the ownership half is the practice-page `ownerClause` (an active cou_owner
 *     row keyed on the `app.user_teammate_id` GUC), so a pure owner sees their
 *     owned CCs even when they sit OUTSIDE the owner's own org subtree.
 * NO region denominators are computed for pure owners (build-design §2).
 */
export async function fetchVisibleCostCentres(
  tx: Tx,
  opts?: { unbounded?: boolean; ownerOnly?: boolean },
): Promise<VisibleCostCentre[]> {
  // `unbounded` = grants.costCentre === 'all' (an ACTIVE 'operational' report-access
  // grant, mig 0129): every cost centre is visible. `ownerOnly` (A3) is the OTHER
  // elevation shape: an ORG-WIDE role (global-finops/platform-admin) holding
  // costCentre ONLY via its baseline ('owned-or-subtree', no 'operational' grant) —
  // see costCentreScopeOpts (server/auth/report-scope.ts). orgSubtreeScopePredicate's
  // GUC arm is unconditionally TRUE for role 'global-finops' (org-subtree-scope.ts:49),
  // so admitting it here for this class would silently widen an ungranted org-wide
  // caller to EVERY cost centre — `ownerOnly` uses the ownership arm ALONE instead.
  // For every other caller the owner/subtree predicate is UNCHANGED (byte-identical
  // to today's behaviour).
  // The ownership half, named once and used TWICE: as (half of) the visibility
  // gate, and as the `owned` flag on every row. One expression, so a centre can
  // never be visible-because-owned while reporting `owned: false`.
  const ownerClause = sql`EXISTS (
        SELECT 1 FROM cou_owner co
        WHERE co.org_unit_id = ou.id
          AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
          AND co.revoked_at IS NULL)`
  const scopeClause = opts?.unbounded
    ? sql`TRUE`
    : opts?.ownerOnly
      ? ownerClause
      : sql`( ${orgSubtreeScopePredicate('ou')} OR ${ownerClause} )`
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string
    region_code: string
    owned: boolean
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code,
           ${ownerClause} AS owned
    FROM org_unit ou JOIN region r ON r.id = ou.region_id
    WHERE ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
      AND ${scopeClause}
    ORDER BY r.code, ou.display_name`)
  return [...rows].map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    regionId: r.region_id,
    regionCode: r.region_code,
    owned: r.owned === true,
  }))
}

/**
 * WHERE THE READER LANDS, and what they may switch to (F5 D23) — PURE, over the
 * very list `fetchVisibleCostCentres` returned, so the scope the page names and
 * the scope the cards were clamped to are the same set by construction.
 *
 * OWNED CENTRES LEAD. This page is written for the person accountable for a
 * budget, and "their" centre is the one they own — not the one that happens to
 * sort first in a 38-row admin list. A reader who owns none (a regional admin
 * browsing) lands on the first visible, which is the only other honest choice.
 */
export function costCentreScope(ccs: VisibleCostCentre[]): CostCentreScope {
  const options = ccs.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    regionCode: c.regionCode,
    owned: c.owned,
  }))
  const landing = ccs.find((c) => c.owned) ?? ccs[0] ?? null
  return {
    options,
    defaultCcId: landing?.id ?? null,
    scopeLabel: landing?.displayName ?? null,
  }
}

/**
 * Resolve + AUTHORISE a single CC for the drill endpoint (build-design §2 RBAC —
 * resource-anchored, anti-IDOR): grant iff the caller's region/subtree scope
 * covers it (`orgSubtreeScopePredicate` — global-finops/platform-admin unbounded,
 * admin own-region, dev/manager own subtree, S3-gated on a genuine, non-root
 * placement) OR the caller OWNS it (an active `cou_owner` row) — the SAME
 * disjunction `fetchVisibleCostCentres` above already grants for the LIST
 * endpoint, and the SAME shape `regional.ts`'s `ou` drill resolution uses.
 *
 * S3 part (e): the ownership/region test is folded INTO the resolving query
 * itself, not run as a SEPARATE step after an unconditional existence check. A
 * non-existent CC, a retired/non-cost-owning unit, and a foreign/unowned CC now
 * ALL fail to produce a row and so collapse to the SAME 403. The old two-step
 * (existence → 404, THEN ownership/region → 403) let a caller distinguish
 * "doesn't exist" from "not yours" — an existence oracle over which cost
 * centres exist in a region they can't see.
 */
export async function resolveCostCentreDrill(
  tx: Tx,
  caller: CostCentreCaller,
  ccId: string,
  opts?: { unbounded?: boolean; ownerOnly?: boolean },
): Promise<CostCentreRef> {
  // See fetchVisibleCostCentres' comment (A3, mig 0129) for `ownerOnly` — the
  // SAME seal, on the resource-anchored resolver: `FALSE` collapses the
  // `( scopeClause OR ownerClause )` disjunction below to the ownership arm
  // alone, rather than admitting orgSubtreeScopePredicate's unconditional
  // 'global-finops' GUC arm for an org-wide caller with no 'operational' grant.
  const scopeClause = opts?.unbounded
    ? sql`TRUE`
    : opts?.ownerOnly
      ? sql`FALSE`
      : orgSubtreeScopePredicate('ou')
  const ownerClause = sql`EXISTS (
    SELECT 1 FROM cou_owner co
    WHERE co.org_unit_id = ou.id
      AND co.teammate_id = ${caller.teammateId}::uuid
      AND co.revoked_at IS NULL)`
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string
    region_code: string
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code
    FROM org_unit ou JOIN region r ON r.id = ou.region_id
    WHERE ou.id = ${ccId}::uuid AND ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
      AND ( ${scopeClause} OR ${ownerClause} )
    LIMIT 1`)
  const cc = [...rows][0]
  if (!cc) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Business Unit not in your scope',
      },
    })
  }
  return {
    id: cc.id,
    code: cc.code,
    displayName: cc.display_name,
    regionId: cc.region_id,
    regionCode: cc.region_code,
  }
}

// ── Cards (burn-vs-allocation + the two on-track mechanics) ───────────────────
export interface CostCentreCard {
  id: string
  code: string
  displayName: string
  regionCode: string
  /** PROJECT-CoU usage-axis burn for the month (Copilot NULL-CoU rows excluded). */
  burnUsd: number
  /**
   * §B CHARGEBACK for the CC over the window — the real cross-charge, homed per
   * `cost_owning_unit_id`, on the SAME grains the Across/Regional scopes use: Anthropic
   * always (DAILY bill lane `v_finance_bill_chargeback`, `period_date`-windowed — correct
   * for ANY window); the POOLED-MONTHLY Copilot net (`v_finance_copilot_pool_chargeback`)
   * folded on top only when `copilotChargeback` AND the window is month-aligned (a monthly
   * pool has no daily grain, so it is never sliced into a partial-month range). The
   * chargeback-lane figure the list shows instead of `burnUsd` in chargeback mode — a
   * SEPARATE lane, NEVER summed with the §A burn.
   */
  chargeUsd: number
  /** Σ project baseline+top-up budgets for the CC's lead projects (current effective). */
  allocationUsd: number
  /** burn / allocation as a FRACTION in [0,1], or null when no allocation. */
  utilisation: number | null
  /**
   * Mechanic 1 — BUDGET exhaustion: the DATE spend reaches the allocation at the
   * MTD burn rate, capped at month-end (projections.ts). A date, never a dollar.
   */
  exhaustionDate: string | null
  /** Mechanic 2 — RUN-RATE dollar: the metered projection (forecast.ts). null when closed. */
  forecast: Forecast | null
  asOfDate: string | null
}

export interface CostCentreCardsResult {
  cards: CostCentreCard[]
  /** MAX(ts_event) across the visible CCs in the month (`YYYY-MM-DD`), or null. */
  asOfDate: string | null
  /** Earliest month with burn in scope (`YYYY-MM`), or null. */
  monthFloor: string | null
  /**
   * §B — copilot chargeback is ON but the window is NOT month-aligned, so the pooled
   * (monthly) Copilot net is withheld from every card's `chargeUsd` (never sliced into a
   * partial-month range, never $0-faked under a "+ Copilot pooled net" label). The UI
   * surfaces a "Copilot pooled (monthly) not shown for partial-month ranges" caveat.
   */
  copilotChargebackPartialMonth: boolean
}

/**
 * Burn (project-CoU usage axis) + allocation + BOTH on-track mechanics per CC.
 *
 * `window` filters the BURN (so a custom `from`/`to` re-windows burn); ALLOCATION is
 * current-effective (`now()`), independent of the window. `monthCtx` carries the
 * month-anchored projection context: when present (the default month path) the
 * forecast (run-rate dollar) and exhaustion (budget date) are computed for the
 * in-progress month (closed months → both null); when NULL (a custom range) BOTH are
 * null — a run-rate/exhaustion projection has no meaning over an arbitrary span
 * (matching the other scopes' forecast-null-in-range-mode rule).
 */
/**
 * §B chargeable money per cost-owning unit, for ANY window.
 *
 * EXTRACTED so the cards list and the DRILL cannot diverge. It used to live
 * inline in `fetchCostCentreCards`, which is why the drill had no `chargeUsd` at
 * all — and why the drill's lane toggle, restored on the owner's ruling that "a
 * cost-centre owner wants to see their attributed AND their cost", switched a
 * lane that had nothing behind it. A control that changes nothing teaches
 * readers to ignore controls; worse, the drill's own note claimed the tables
 * "do not add up to the billed figure above" while the figure above was the §A
 * burn. One extraction removes the dead control and the false claim together.
 *
 * The two sources keep their different grains, and the difference is load-bearing:
 *   - Anthropic (`v_finance_bill_chargeback`) is DAILY, so it is correct for a
 *     custom range as well as a month.
 *   - The Copilot pool (`v_finance_copilot_pool_chargeback`) is POOLED-MONTHLY,
 *     so it is folded in ONLY when the window is month-aligned. A monthly pool
 *     has no daily grain and must never be sliced into a partial month; callers
 *     surface `copilotChargebackPartialMonth` and caveat the omission rather
 *     than letting it read as a silent $0.
 *
 * Only the CHARGEABLE Copilot lanes are counted (mig 0085): `copilot-license` +
 * `copilot-usage`. `copilot-unclassified` is counted and alerted but NEVER
 * charged (design D2), so it cannot enter this figure.
 */
async function fetchChargeByCc(
  tx: Tx,
  ccIds: string[],
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<Map<string, number>> {
  if (ccIds.length === 0) return new Map()
  const ids = sql`ARRAY[${sql.join(
    ccIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const foldCopilot = opts.copilotChargeback && isMonthAlignedWindow(window)

  const anthropicRows = await tx.execute<{ cc_id: string; anthropic: string }>(sql`
    SELECT cost_owning_unit_id::text AS cc_id, COALESCE(SUM(bill_usd), 0)::text AS anthropic
    FROM v_finance_bill_chargeback
    WHERE cost_owning_unit_id = ANY(${ids})
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY cost_owning_unit_id`)
  const chargeByCc = new Map<string, number>()
  for (const r of anthropicRows) chargeByCc.set(r.cc_id, Number(r.anthropic))

  if (foldCopilot) {
    const copilotRows = await tx.execute<{ cc_id: string; copilot: string }>(sql`
      SELECT cost_owning_unit_id::text AS cc_id, COALESCE(SUM(charge_usd), 0)::text AS copilot
      FROM v_finance_copilot_pool_chargeback
      WHERE cost_owning_unit_id = ANY(${ids})
        AND tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY cost_owning_unit_id`)
    for (const r of copilotRows) {
      chargeByCc.set(r.cc_id, (chargeByCc.get(r.cc_id) ?? 0) + Number(r.copilot))
    }
  }
  return chargeByCc
}

/** The §B charge for ONE cost centre — the drill's counterpart to the cards' figure. */
export async function fetchCostCentreCharge(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<{ chargeUsd: number; copilotChargebackPartialMonth: boolean }> {
  const byCc = await fetchChargeByCc(tx, [ccId], window, opts)
  return {
    chargeUsd: byCc.get(ccId) ?? 0,
    copilotChargebackPartialMonth: opts.copilotChargeback && !isMonthAlignedWindow(window),
  }
}

export async function fetchCostCentreCards(
  tx: Tx,
  ccs: CostCentreRef[],
  window: UsageWindow,
  monthCtx: { month: string; now: Date } | null,
  opts: { copilotChargeback: boolean },
): Promise<CostCentreCardsResult> {
  if (ccs.length === 0)
    return {
      cards: [],
      asOfDate: null,
      monthFloor: null,
      copilotChargebackPartialMonth: opts.copilotChargeback && !isMonthAlignedWindow(window),
    }
  const ids = sql`ARRAY[${sql.join(
    ccs.map((c) => sql`${c.id}::uuid`),
    sql`, `,
  )}]`

  // Burn (project-CoU usage axis): Copilot pooled rows carry NULL cost_owning_unit_id
  // and so are EXCLUDED from `= ANY(...)` by construction (the labelled §A gap).
  const burnRows = await tx.execute<{ cc_id: string; burn: string; as_of: string | null }>(sql`
    SELECT u.cost_owning_unit_id::text AS cc_id,
           COALESCE(SUM(u.cost_usd), 0)::text AS burn,
           to_char(MAX(u.ts_event), 'YYYY-MM-DD') AS as_of
    FROM v_complete_usage_current u
    WHERE u.cost_owning_unit_id = ANY(${ids})
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY u.cost_owning_unit_id`)
  const burnByCc = new Map<string, { burn: number; asOf: string | null }>()
  for (const r of burnRows) burnByCc.set(r.cc_id, { burn: Number(r.burn), asOf: r.as_of })

  // §B CHARGEBACK per CC — the SEPARATE chargeback figure the list re-lenses to, on the
  // SAME grains the Across/Regional scopes now use (grain-mismatch fix, mirrors
  // across-regions.ts / regional.ts). NEVER mixed with the §A burn above.
  //   - Anthropic: the DAILY per-teammate bill lane (`v_finance_bill_chargeback`,
  //     `period_date`-windowed) homed to each CoU. Correct for ANY window — a
  //     non-month-aligned custom range no longer drops the charge to $0 (the grain bug).
  //     Copilot is ABSENT from this view (pooled/per-org, no per-teammate row) and
  //     chargeback_exempt rows are excluded by the view.
  //   - Copilot pooled net: POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`,
  //     `period_month`), folded on top ONLY when copilotChargeback AND the window is
  //     month-aligned — a monthly pool has no daily grain, so it is never sliced into a
  //     partial-month range. Withheld otherwise, and the result flags it so the UI caveats
  //     the omission instead of showing a silent $0.
  const isMonthAligned = isMonthAlignedWindow(window)
  const chargeByCc = await fetchChargeByCc(tx, ccs.map((c) => c.id), window, opts)
  const copilotChargebackPartialMonth = opts.copilotChargeback && !isMonthAligned

  // Allocation: Σ current-effective baseline+top-up project budgets homed to each CC
  // (the me/cost-centres CC-level allocation mechanic, aggregated once here).
  const allocRows = await tx.execute<{ cc_id: string; alloc: string }>(sql`
    SELECT p.cost_owning_unit_id::text AS cc_id, COALESCE(SUM(a.budget_usd), 0)::text AS alloc
    FROM project p
    JOIN allocation a ON a.scope_type = 'project' AND a.scope_id = p.id
      AND a.allocation_kind IN ('baseline', 'top-up') AND a.teammate_id IS NULL AND a.effective @> now()
    WHERE p.cost_owning_unit_id = ANY(${ids})
    GROUP BY p.cost_owning_unit_id`)
  const allocByCc = new Map<string, number>()
  for (const r of allocRows) allocByCc.set(r.cc_id, Number(r.alloc))

  /*
   * Scope-wide floor (earliest month with burn) over the visible CCs, cached
   * (month-floor.ts). The key is the SORTED id list: two callers seeing the
   * same set of cost centres genuinely share a floor, and sorting means the
   * order the ids happened to arrive in cannot split the cache entry.
   */
  const floorMonth = await reportMonthFloor(tx, {
    key: `cost-centres:${ccs.map((c) => c.id).sort().join(',')}`,
    where: sql`u.cost_owning_unit_id = ANY(${ids})`,
  })

  // In range mode (monthCtx null) both month-anchored mechanics are null.
  const isCurrentMonth = monthCtx != null && monthCtx.month === monthKeyUtc(monthCtx.now)
  let scopeAsOf: string | null = null
  const cards: CostCentreCard[] = ccs.map((cc) => {
    const b = burnByCc.get(cc.id)
    const burnUsd = b?.burn ?? 0
    const asOfDate = b?.asOf ?? null
    if (asOfDate && (!scopeAsOf || asOfDate > scopeAsOf)) scopeAsOf = asOfDate
    const allocationUsd = allocByCc.get(cc.id) ?? 0

    // Mechanic 2 (run-rate dollar) — forecast.ts returns null for a closed month;
    // range mode (no month anchor) is null too.
    const asOf = asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : null
    const forecast = monthCtx
      ? forecastForMonth({ requestedMonth: monthCtx.month, now: monthCtx.now, asOf, meteredMtdUsd: burnUsd })
      : null
    // Mechanic 1 (budget exhaustion DATE) — only meaningful on the in-progress month.
    const exhaustion = isCurrentMonth ? exhaustionDate(burnUsd, allocationUsd, monthCtx!.now) : null

    return {
      id: cc.id,
      code: cc.code,
      displayName: cc.displayName,
      regionCode: cc.regionCode,
      burnUsd,
      chargeUsd: chargeByCc.get(cc.id) ?? 0,
      allocationUsd,
      utilisation: allocationUsd > 0 ? burnUsd / allocationUsd : null,
      exhaustionDate: exhaustion,
      forecast,
      asOfDate,
    }
  })
  // Sort by burn desc so the hottest CCs lead the grid.
  cards.sort((a, b) => b.burnUsd - a.burnUsd)

  return {
    cards,
    asOfDate: scopeAsOf,
    monthFloor: floorMonth,
    copilotChargebackPartialMonth,
  }
}

// ── Summary (KPI strip + RAG rollup, computed from the cards) ─────────────────
/**
 * The whole-scope Cost-Centre summary — burn/allocation totals + a RAG count
 * breakdown, computed PURELY from the visible cards (so it can never drift from the
 * grid). The four counts partition the cards exactly via the shared
 * {@link costCentreBudgetState} classifier (one RAG definition, no drift with the
 * per-card colouring the view applies).
 */
export function summariseCostCentres(
  cards: CostCentreCard[],
  asOfDate: string | null,
): CostCentreSummary {
  let totalBurnUsd = 0
  let totalAllocationUsd = 0
  let countOverBudget = 0
  let countNearBudget = 0
  let countOnTrack = 0
  let countNotStarted = 0
  let countNoAllocation = 0
  for (const c of cards) {
    totalBurnUsd += c.burnUsd
    totalAllocationUsd += c.allocationUsd
    switch (costCentreBudgetState(c.utilisation)) {
      case 'over':
        countOverBudget++
        break
      case 'warn':
        countNearBudget++
        break
      case 'ok':
        countOnTrack++
        break
      // An allocation with nothing spent against it (F5 D26) — split out of
      // `ok`, where "$0.00 of $500.00 · On track" hid it.
      case 'not-started':
        countNotStarted++
        break
      case 'none':
        countNoAllocation++
        break
    }
  }
  return {
    totalBurnUsd,
    totalAllocationUsd,
    countOverBudget,
    countNearBudget,
    countOnTrack,
    countNotStarted,
    countNoAllocation,
    asOfDate,
  }
}

// ── Drill: §A USAGE BURN (project-CoU usage axis — the SAME lane as the tracker) ─
export interface CostCentreBurnDrill {
  /** Σ cost_usd over `v_complete_usage WHERE cost_owning_unit_id = ccId` in the window. */
  burnUsd: number
  /** MAX(ts_event) as `YYYY-MM-DD`, or null when the CC has no burn in the window. */
  asOf: string | null
  /** Burn split by `tool` (feeds the drill donut). Copilot pooled NULL-CoU is excluded. */
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
}

/**
 * The CC's §A usage BURN for the window — IDENTICAL lane + filter to the tracker
 * card burn (`v_complete_usage WHERE cost_owning_unit_id = ccId`), so the drill
 * headline reconciles to the tracker row. Copilot pooled rows carry NULL
 * cost_owning_unit_id and are excluded by construction (the labelled §A gap), so
 * the burn is Claude-heavy; the vendor split still reports whatever `tool`s landed.
 */
export async function fetchCostCentreBurnDrill(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<CostCentreBurnDrill> {
  const [row] = [
    ...(await tx.execute<{
      burn: string
      as_of: string | null
      claude: string
      copilot: string
      other: string
    }>(sql`
      SELECT COALESCE(SUM(u.cost_usd), 0)::text AS burn,
             to_char(MAX(u.ts_event), 'YYYY-MM-DD') AS as_of,
             ${vendorSplitAggregates}
      FROM v_complete_usage_current u
      WHERE u.cost_owning_unit_id = ${ccId}::uuid
        AND u.ts_event >= ${window.startIso}::timestamptz
        AND u.ts_event <  ${window.endIso}::timestamptz`)),
  ]
  return {
    burnUsd: Number(row?.burn ?? 0),
    asOf: row?.as_of ?? null,
    vendor: {
      claudeUsd: Number(row?.claude ?? 0),
      copilotUsd: Number(row?.copilot ?? 0),
      otherUsd: Number(row?.other ?? 0),
    },
  }
}

/**
 * PER-PROJECT current-effective baseline+top-up allocation for the CC's lead
 * projects — the operand behind each Budgets-hero row's "87% of $6,024".
 *
 * The SAME `allocation` predicate {@link fetchCostCentreAllocation} sums, one
 * grain finer: that function is the Σ of exactly these rows, so the hero's rows
 * and the drill's allocation headline can never disagree about what a budget is.
 * That is also why the headline is labelled DERIVED on the face — the budget axis
 * is the PROJECT, and a cost-centre allocation figure is the roll-up of its
 * projects' allocations, never a budget anyone set on the cost centre.
 *
 * A project with no active allocation is ABSENT from the map: "no budget set" is
 * a state the row must render as itself, and defaulting it to 0 here would make
 * it indistinguishable from a budget of zero.
 */
export async function fetchCostCentreProjectBudgets(
  tx: Tx,
  ccId: string,
): Promise<Map<string, number>> {
  const rows = await tx.execute<{ project_id: string; alloc: string }>(sql`
    SELECT p.id::text AS project_id, COALESCE(SUM(a.budget_usd), 0)::text AS alloc
    FROM project p
    JOIN allocation a ON a.scope_type = 'project' AND a.scope_id = p.id
      AND a.allocation_kind IN ('baseline', 'top-up') AND a.teammate_id IS NULL AND a.effective @> now()
    WHERE p.cost_owning_unit_id = ${ccId}::uuid
    GROUP BY p.id`)
  return new Map([...rows].map((r) => [r.project_id, Number(r.alloc)]))
}

/**
 * The CC's current-effective Σ project baseline+top-up allocation (the SAME
 * allocation term `fetchCostCentreCards` sums, for a single CC) — lets the drill
 * frame the burn against its budget. 0 when the CC has no active allocation.
 *
 * DERIVED, and labelled so wherever it renders: it is the roll-up of
 * {@link fetchCostCentreProjectBudgets}, not a budget set on the cost centre.
 */
export async function fetchCostCentreAllocation(tx: Tx, ccId: string): Promise<number> {
  const [row] = [
    ...(await tx.execute<{ alloc: string }>(sql`
      SELECT COALESCE(SUM(a.budget_usd), 0)::text AS alloc
      FROM project p
      JOIN allocation a ON a.scope_type = 'project' AND a.scope_id = p.id
        AND a.allocation_kind IN ('baseline', 'top-up') AND a.teammate_id IS NULL AND a.effective @> now()
      WHERE p.cost_owning_unit_id = ${ccId}::uuid`)),
  ]
  return Number(row?.alloc ?? 0)
}

// ── §B behavioural exposure (model-tier bands over provider_usage_fact) ──────
/**
 * The cost-centre's Behavioural-exposure card — the SAME primitive the Region
 * scope calls, clamped to this CC's cost-owning unit.
 *
 * WHY `cost_owning_unit_id` AND NOT the §A burn clamp. This is the §B lane, read
 * through `v_provider_usage_fact_current`, whose `cost_owning_unit_id` is the
 * person's current Business Unit — the column the finance clamp addresses
 * everywhere else. The card sits
 * beside the §A burn drill and its money is NEVER summed with it (contract C2):
 * the burn is usage-basis and this is provider-billed.
 *
 * The window is the drill's ACTIVE window, not a rolling 60 days — the
 * cost-centre page has no rolling band, and the card labels the window it was
 * given rather than claiming one it was not.
 */
export async function fetchCostCentreTierExposure(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<TierExposure> {
  return fetchTierExposure(
    tx,
    clampedFinance(sql`cost_owning_unit_id = ${ccId}::uuid`),
    window,
  )
}

// ── The Projects hero's two additions (F5 D25, D30) ──────────────────────────
/**
 * The row key + label for the burn this cost centre carries with NO project
 * claim on it (F5 D30).
 *
 * A NAMED CONSTANT because three surfaces must agree on it: the axis that emits
 * the row, the CSV that exports it, and any test that asserts it is present. It
 * is deliberately NOT `__null_project` — that key names "the axis could not
 * identify a project", while this row names a real, actionable state: money
 * with no budget to sit against.
 */
export const NO_PROJECT_ROW_KEY = '__no_project'
export const NO_PROJECT_ROW_LABEL = 'Not on a project'

/**
 * THIS COST CENTRE's share of each of its projects' spend — the second operand
 * on a Projects-hero row (F5 D25 / 03-snag-plan §8c).
 *
 * The axis row's own `usd` is the PROJECT's total across every centre whose
 * people worked on it, because the axis is clamped on `p.cost_owning_unit_id`
 * (that is what makes it the right operand to put against the project's
 * budget). This is the OTHER question — "how much of that did my centre spend"
 * — and it is clamped the way every burn figure on this page is clamped, on the
 * usage row's own `cost_owning_unit_id`.
 *
 * A project ABSENT from the map contributed nothing homed here (the map is not
 * defaulted to the row total): a centre can lead a project that only other
 * centres' people worked on, and reporting the project's own total as "your
 * share" would be the exact conflation this operand exists to remove.
 *
 * ── THE PROVISIONAL FILTER IS PART OF THE OPERAND, NOT A DETAIL (r6-H1) ──────
 * This figure is rendered as a PART of the axis row's `usd`, and that row comes
 * from `completeProjectAxisPopulation(..., { excludeProvisional: true })` — the
 * seam rule that every project figure in the product drops unconfirmed identity
 * bindings. Reading this operand over the wider population let the part exceed
 * its own whole: one unconfirmed teammate homed here was counted in the share
 * and not in the total, and the row then asserted "$120 of $100". Same lane,
 * same window, same population — or it is not a share of anything on screen.
 */
export async function fetchCostCentreProjectShare(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<Map<string, number>> {
  const rows = await tx.execute<{ project_id: string; share: string }>(sql`
    SELECT u.project_id::text AS project_id, COALESCE(SUM(u.cost_usd), 0)::text AS share
    FROM v_complete_usage_current u
    WHERE u.cost_owning_unit_id = ${ccId}::uuid
      AND u.project_id IS NOT NULL
      AND u.identity_state IS DISTINCT FROM 'provisional'
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY u.project_id`)
  return new Map([...rows].map((r) => [r.project_id, Number(r.share)]))
}

// ── Model tier per person (F5 — the drill's missing SERVER MEASURE) ──────────
/**
 * The People hero's model-tier column, banded by `model_catalog.tier`.
 *
 * ── THE PRIMITIVE ALWAYS EXISTED; THE MEASURE DID NOT ────────────────────────
 * `CcDrill.vue` used to claim this column needed a `model_catalog.tier` that
 * "does not exist". It exists, is CHECK-constrained and is seeded (mig
 * `0046:128`, `0046:138-146`), two shipped engines already join it, and
 * `MODEL_TIER_BANDS` is a finished contract. What was missing was one query
 * over primitives that were already there — an implementation gap, not a
 * blocked dependency (`CLAUDE.md` §Decision discipline).
 *
 * ── BANDING IS `resolveTier`'s, NEVER THIS MODULE's ──────────────────────────
 * The catalogue matches by SUBSTRING with a `sort_order` tie-break, so
 * `gpt-5-mini` matches BOTH the `gpt-5-mini` row and the `gpt-5` row. A SQL
 * equijoin fans out and returns the same dollar once per matching pattern,
 * overstating every band. `resolveTier` — the function the frontier-share
 * detector already uses — resolves each model to exactly one tier before a
 * dollar is added, so a fan-out is structurally impossible and this column can
 * never publish a different frontier share from that detector.
 *
 * ── `unclassified` IS A BAND, NOT A DEFAULT ──────────────────────────────────
 * A model the catalogue does not know lands in `unclassified` and is NEVER
 * folded into the cheapest band: folding it would understate frontier exposure
 * by exactly the spend nobody has classified yet, which is the spend most
 * likely to be new and dear.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT COVER ────────────────────────────────────
 * A row whose `model` is NULL carries no model to band. That is a DIFFERENT
 * fact from "a model we have not classified" (prototype note `data`), and
 * `ModelTierBand` has no member for it, so that spend is OMITTED from the mix
 * rather than assigned a band it does not have. The mix therefore describes the
 * banded part of a person's spend; it is a proportional indicator, and nothing
 * foots a total to it.
 */
export async function fetchCostCentreTeammateTierMix(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<Map<string, DriverTierAmount[]>> {
  const rows = await tx.execute<{ teammate_id: string | null; model: string | null; value: string }>(sql`
    SELECT u.teammate_id::text AS teammate_id, u.model AS model,
           COALESCE(SUM(u.cost_usd), 0)::text AS value
    FROM v_complete_usage_current u
    WHERE u.cost_owning_unit_id = ${ccId}::uuid
      AND u.model IS NOT NULL
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY u.teammate_id, u.model`)
  return foldTeammateTierMix([...rows], await fetchCatalog(tx))
}

/**
 * The PURE core of {@link fetchCostCentreTeammateTierMix} — (teammate, model)
 * sums + the catalogue → per-teammate bands. Separated from the fetch so the
 * banding, which is the part a fan-out or a mis-defaulted unknown would break,
 * is unit-testable on a fixture that names the models it is about.
 */
export function foldTeammateTierMix(
  rows: readonly { teammate_id: string | null; model: string | null; value: string }[],
  catalog: readonly CatalogEntry[],
): Map<string, DriverTierAmount[]> {
  const cat = [...catalog]
  // One catalogue walk per DISTINCT model, not per row.
  const bandCache = new Map<string, ModelTierBand>()
  const bandOf = (model: string): ModelTierBand => {
    const hit = bandCache.get(model)
    if (hit) return hit
    // `?? 'unclassified'` is the whole discipline: an unmatched model is its own
    // band, never the cheapest one.
    const band = (resolveTier(model, cat) ?? 'unclassified') as ModelTierBand
    bandCache.set(model, band)
    return band
  }
  const byTeammate = new Map<string, Map<ModelTierBand, number>>()
  for (const r of rows) {
    if (!r.teammate_id || !r.model) continue
    const usd = Number(r.value)
    if (!usd) continue
    let bands = byTeammate.get(r.teammate_id)
    if (!bands) {
      bands = new Map<ModelTierBand, number>()
      byTeammate.set(r.teammate_id, bands)
    }
    const band = bandOf(r.model)
    bands.set(band, (bands.get(band) ?? 0) + usd)
  }
  const out = new Map<string, DriverTierAmount[]>()
  for (const [teammateId, bands] of byTeammate) {
    // Emitted in the shared hottest-to-coolest band order, never the order the
    // scan happened to return, so a legend and a bar can never disagree.
    out.set(
      teammateId,
      MODEL_TIER_BANDS.filter((b) => bands.has(b)).map((band) => ({
        band,
        label: MODEL_TIER_LABELS[band],
        usd: bands.get(band)!,
      })),
    )
  }
  return out
}

// ── Drill drivers (axis-switchable §A burn drivers) ──────────────────────────
export interface CostCentreBurnDriversResult {
  rows: DriverRow[]
  /**
   * What the rows sum back to (build-design §7(4)) — the CC burn on the three
   * §A-burn axes, and Σ of the cost centre's projects on the 'project' axis.
   * NOT interchangeable: the two clamps admit different arms of the lane, so a
   * caller must render THIS number as the denominator, never `burnUsd`.
   */
  headlineUsd: number
  denominatorLabel: string
}

/**
 * Ranked §A burn drivers for one axis, summing back to the CC burn headline
 * (build-design §7(4)):
 *   - teammate → LEFT JOIN teammate for the label; EVERY §A row under a CoU carries a
 *     teammate_id, so the ranking reconciles to the burn, on the same current-lens
 *     column the burn is clamped by.
 *     LEFT (not INNER) + COALESCE(...,'Unattributed') is defence-in-depth: an orphaned
 *     teammate_id would silently DROP a row under an inner join and break the sum-back.
 *   - model    → group by (model, usage_provenance); a NULL model → an explicit
 *     bucket, labelled via shared/reports/model-attribution.ts (R1-M3, mig 0101).
 *     Pre-0101 this bucket was DEFENSIVE only (model was NOT NULL on the §A
 *     attribution lane, so it should never have carried spend). Migration
 *     0101's ingest-only completeness arm (arm 3) genuinely carries a NULL
 *     model AND a real `cost_owning_unit_id` when homed, so this bucket can now
 *     be live — labelled "Unattributed" would misreport it as a collection
 *     failure rather than the structural absence it is.
 * Rows are `indicative` — a usage-lane $, never a per-user charge. No Copilot
 * pooled rows are present here (NULL-CoU), so there is no pooled-usage row.
 */
export async function fetchCostCentreBurnDrivers(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  axis: CostCentreDrillAxis,
  burnUsd: number,
): Promise<CostCentreBurnDriversResult> {
  const win = sql`u.ts_event >= ${window.startIso}::timestamptz AND u.ts_event < ${window.endIso}::timestamptz`

  /*
   * 'project' — the budgeted unit of account (D1), clamped on the PROJECT's own
   * cost-owning unit, NOT on the usage row's.
   *
   * That clamp is the whole point. `cost_owning_unit_id` on the §A lane is NULL
   * BY CONSTRUCTION on arm 2 (`unaccounted_usage`, the API−OTel reconciliation
   * gap — mig 0101/0113), while `project_id` on that arm is real and taggable
   * through the same needs-tagging flow. Clamping this axis the way the burn
   * axes clamp it (`u.cost_owning_unit_id = ccId`) would therefore delete every
   * reconciled dollar from the list — at today's adoption, most of the money —
   * and the deletion would be silent: the rows would still foot to a headline,
   * just a smaller one.
   *
   * The consequence is that this axis does NOT sum back to the CC burn, and it
   * must not pretend to. Its denominator is Σ of the cost centre's own projects;
   * `completeCostCentreProjectResiduals` publishes every term between the two,
   * and the P&L card renders them. One axis, one denominator, named on its face.
   *
   * `excludeProvisional` is set because this axis IS a project figure, and every
   * project figure in the product drops unconfirmed identity bindings (the seam's
   * module header: the five project sites all set it, so the page, the budget
   * editor and the alert cannot disagree). The owner's project table on this very
   * scope reads `completeProjectSpend(..., { excludeProvisional: true })`, so
   * without this the SAME project showed two totals on two adjacent surfaces —
   * the defect the seam exists to remove, one level down. The burn axes below do
   * NOT set it: they must reconcile to `burnUsd`, which is the raw lane.
   */
  if (axis === 'project') {
    /*
     * ── UNCAPPED, AND THAT IS THE POINT ────────────────────────────────────
     * `completeProjectAxisPopulation`, not the ranked `completeProjectAxisSpend`
     * seam: at ONE cost centre the list IS the population. A ranked top-50 with
     * an "(all other — N projects)" tail hides the budget the owner opened the
     * page to find, and the tail is not something they can act on — they own
     * each of those projects individually. The ranked seam keeps its cap, and
     * its meaning, for every exploratory driver table (region / whole company).
     */
    /*
     * ── THE CLAMP HAS TWO ARMS, AND THE SECOND ONE IS "NOT ON A PROJECT" ─────
     * (F5 D30, prototype `R:903-907`: the Projects hero's last row is
     * `['Not on a project', …, 'no project']`.)
     *
     * Arm 1 (`p`) is the budget question: every project this centre LEADS,
     * whatever the usage row's own home — the clamp the allocation denominator
     * uses, and the reason arm-2 reconciled dollars are not deleted here.
     *
     * Arm 2 (`u`) is the money with no budget to be against: usage homed to
     * this centre carrying NO project claim. It cannot arrive through arm 1 —
     * a NULL `project_id` has no `p` row to clamp — so without it the hero
     * silently omits it. The two arms are DISJOINT by construction
     * (`project_id` is either NULL or it is not), so nothing is counted twice.
     *
     * ── WHAT ARM 2 ACTUALLY HOLDS, AND WHAT IT DOES NOT (r6-A1) ──────────────
     * It holds the INGEST-ONLY arm, and essentially only that. v_complete_usage
     * arm 3 selects `vtd.cost_owning_unit_id` beside `NULL::uuid AS project_id`
     * (mig 0101/0125), so provider-reported usage is homed at a cost centre with
     * no project — untaggable money, which is exactly why arm 1 can never reach
     * it. That is a real, live bucket and the row names it correctly.
     *
     * It does NOT hold the TAGGABLE untagged money — someone's emitted spend
     * that simply has not been put on a project yet. Both §A writers set the CoU
     * FROM the project and leave it NULL when there is none (`tag-session.ts`,
     * `azure-monitor-reader.ts`; arms 1-2 of the view), so that money carries a
     * NULL `cost_owning_unit_id` and this clamp cannot see it. The claim that
     * this arm equals "what the over-the-soft-cap card surfaces per person" was
     * false, and inverted: that card's population is the TEAMMATE roster, and
     * the money it ranks is precisely the half arm 2 misses.
     *
     * That half is NOT folded in here on purpose. Its only home is the SPENDER's
     * cost centre, and this axis's denominator is the PROJECT's — mixing a
     * teammate-homed figure into a project-homed one is how two axes become one
     * wrong number (`CostCentreLaneResidual`, complete-spend.ts). It is reported
     * on the same page instead, on the dimension it has, as
     * `memberUntaggedUsd` (/me/cost-centres → `CcProjectTable`).
     */
    // CONSTRAINT: both clamp arms must address columns the rollup grain
    // carries — a new arm on a view-only column silently matches nothing under
    // source: 'rollup' (usage-rollup-lane.md R5b.3).
    const projectRows = await completeProjectAxisPopulation(tx, window, {
      scope: sql`( p.cost_owning_unit_id = ${ccId}::uuid
                   OR (u.project_id IS NULL AND u.cost_owning_unit_id = ${ccId}::uuid) )`,
      excludeProvisional: true,
      source: 'rollup',
    })
    const [budgets, ccShare] = await Promise.all([
      fetchCostCentreProjectBudgets(tx, ccId),
      fetchCostCentreProjectShare(tx, ccId, window),
    ])
    const total = projectRows.reduce((a, r) => a + r.costUsd, 0)
    const rows: DriverRow[] = projectRows.map((r) => ({
      // A NULL `projectId` on THIS axis is the arm-2 bucket above, never a
      // folded tail: the population variant folds nothing (`remainderProjects`
      // is 0 on every row it returns).
      key: r.projectId ?? NO_PROJECT_ROW_KEY,
      label: r.label ?? NO_PROJECT_ROW_LABEL,
      usd: r.costUsd,
      sharePct: total > 0 ? r.costUsd / total : 0,
      spendClass: 'indicative' as SpendClass,
      indicativeReason: 'usage-not-yet-billed',
      // The three states are distinct and stay that way: an absent allocation is
      // `null` ("no budget set"), never 0. Only a real project row carries the
      // field — the "Not on a project" row has no budget to consume, and renders
      // "—" rather than a missing decision it does not have.
      ...(r.projectId ? { budgetUsd: budgets.get(r.projectId) ?? null } : {}),
      /*
       * THE SECOND OPERAND (D25). `usd` above is the PROJECT's own total —
       * right against its budget, and the wrong answer to "what did my centre
       * spend on it". Both ship; neither is inferred from the other.
       *
       * Only on a real project row: on the "Not on a project" row the two are
       * the same figure by construction (arm 2 is already clamped to this
       * centre), and restating it would invite the reader to add them.
       */
      ...(r.projectId
        ? { scopeShareUsd: ccShare.get(r.projectId) ?? 0, scopeShareLabel: `this ${BU_LABEL_LOWER}` }
        : {}),
      // The drill target (D29) — the CODE, because that is what /projects/{code}
      // is keyed on. Absent ⇒ the row renders as plain text.
      ...(r.code ? { dims: { project_code: r.code } } : {}),
    }))
    return {
      rows,
      headlineUsd: total,
      denominatorLabel: `this ${BU_LABEL_LOWER}'s projects, and burn on none`,
    }
  }

  // 'teammate' (requirements 3/4): grouped by (teammate, tool, usage_provenance)
  // so ONE query yields the row total AND both breakdowns from the SAME rows
  // (foldDriverBreakdown) — see the identical note in fetchAcrossDrivers
  // (server/reporting/across-regions.ts). No pooled-usage rows are possible
  // here (Copilot pooled usage carries NULL cost_owning_unit_id, structurally
  // excluded by the `cost_owning_unit_id = ccId` filter below).
  if (axis === 'teammate') {
    const raws = await tx.execute<{
      key: string | null
      label: string | null
      tool: string | null
      provenance: string | null
      value: string
      drill_is_active: boolean | null
      drill_is_provisional: boolean | null
    }>(sql`
      SELECT u.teammate_id::text AS key, COALESCE(t.display_name, t.email, 'Unattributed') AS label,
             u.tool AS tool, u.usage_provenance AS provenance,
             COALESCE(SUM(u.cost_usd), 0)::text AS value,
             ${TEAMMATE_DRILL_FACTS_AGG}
      FROM v_complete_usage_current u LEFT JOIN teammate t ON t.id = u.teammate_id
      WHERE u.cost_owning_unit_id = ${ccId}::uuid AND ${win}
      GROUP BY u.teammate_id, t.display_name, t.email, u.tool, u.usage_provenance`)
    // The two drill-admission conjuncts the CLIENT cannot infer (D34/D38,
    // r4-H2), from the ONE shared producer (reporting/teammate-drill-facts.ts):
    // a deactivated subject AND an unconfirmed provisional shadow both 403 at
    // /reports/teammate/{id}, so either name must render as plain text rather
    // than as a live-looking dead link. The rows themselves STAY — this axis
    // foots to `burnUsd`, the cost centre's whole §A burn, and filtering a
    // subject out of a decomposition to close a door breaks the sum-back
    // instead (the argument is written out in engine/drivers.ts's teammate axis).
    const factsByKey = foldTeammateDrillFacts(raws, (r) => r.key)
    // The model-tier column (F5). A SEPARATE scan rather than another GROUP BY
    // member on the one above: adding `model` there would fan the surface and
    // provenance folds out per model as well, and those two breakdowns must keep
    // footing to the row exactly. This one is a proportional indicator and does
    // not (see fetchCostCentreTeammateTierMix on NULL models).
    const tierByKey = await fetchCostCentreTeammateTierMix(tx, ccId, window)
    const byKey = foldDriverBreakdown(raws)
    const entries = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total)
    const rows: DriverRow[] = entries.map(([key, agg]) => {
      const usd = agg.total
      return {
        key: key || `__null_${axis}`,
        label: agg.label ?? 'Unattributed',
        usd,
        sharePct: burnUsd > 0 ? usd / burnUsd : 0,
        spendClass: 'indicative' as SpendClass,
        indicativeReason: 'usage-not-yet-billed',
        surfaceBreakdown: driverSurfaceBreakdown(agg.bySurface),
        provenanceBreakdown: driverProvenanceBreakdown(agg.byProvenance),
        // ABSENT, never an empty array, when this person's spend carried no
        // model at all: the renderer reads absence as "not available" and an
        // empty bar as "no frontier usage", and only one of those is true.
        ...(tierByKey.get(key)?.length ? { tierBreakdown: tierByKey.get(key) } : {}),
        ...(key
          ? { dims: teammateDrillDims(factsByKey.get(key) ?? NO_TEAMMATE_DRILL_FACTS) }
          : {}),
      }
    })
    return { rows, headlineUsd: burnUsd, denominatorLabel: `${BU_LABEL_LOWER} burn` }
  }

  // 'surface' (requirement 2): this CC's own vendor-lane axis — see the
  // identical note in fetchAcrossDrivers. Copilot lanes never appear (pooled
  // usage carries no cost-owning unit — the SAME structural exclusion as the
  // "Burn by vendor" donut, cost-centre/CcDrill.vue).
  if (axis === 'surface') {
    const raws = await tx.execute<{
      key: string | null
      label: string | null
      tool: string | null
      provenance: string | null
      value: string
    }>(sql`
      SELECT NULL::text AS key, NULL::text AS label, u.tool AS tool, u.usage_provenance AS provenance,
             COALESCE(SUM(u.cost_usd), 0)::text AS value
      FROM v_complete_usage_current u
      WHERE u.cost_owning_unit_id = ${ccId}::uuid AND ${win}
      GROUP BY u.tool, u.usage_provenance`)
    const folded = foldDriverBreakdown(raws).get('') ?? {
      label: null,
      total: 0,
      bySurface: new Map<Vendor, number>(),
      byProvenance: new Map<string, number>(),
    }
    const rows: DriverRow[] = [...folded.bySurface.entries()]
      .filter(([, usd]) => usd !== 0)
      .sort(([a], [b]) => VENDOR_LANES.indexOf(a) - VENDOR_LANES.indexOf(b))
      .map(([lane, usd]) => {
        const byProvenance = new Map<string, number>()
        for (const r of raws) {
          if (toolToVendor(r.tool) !== lane || !r.provenance) continue
          byProvenance.set(r.provenance, (byProvenance.get(r.provenance) ?? 0) + Number(r.value))
        }
        return {
          key: lane,
          label: VENDOR_LABELS[lane],
          usd,
          sharePct: burnUsd > 0 ? usd / burnUsd : 0,
          spendClass: 'indicative' as SpendClass,
          indicativeReason: 'usage-not-yet-billed' as const,
          provenanceBreakdown: driverProvenanceBreakdown(byProvenance),
        }
      })
    return { rows, headlineUsd: burnUsd, denominatorLabel: `${BU_LABEL_LOWER} burn` }
  }

  interface Raw extends Record<string, unknown> {
    key: string | null
    label: string | null
    value: string
    /** Only populated on the 'model' axis (R1-M3) — see the model branch below. */
    provenance?: string | null
    /** Only populated on the 'model' axis (mig 0124, r1-H5): WHY a NULL-model
     *  row carries no model — see shared/reports/model-attribution.ts. */
    gap_reason?: string | null
  }
  const grouped: Raw[] = [
    ...(await tx.execute<Raw>(sql`
      SELECT u.model AS key, u.model AS label, u.usage_provenance AS provenance,
             u.model_gap_reason AS gap_reason,
             COALESCE(SUM(u.cost_usd), 0)::text AS value
      FROM v_complete_usage_current u
      WHERE u.cost_owning_unit_id = ${ccId}::uuid AND ${win}
      -- GROUP BY includes usage_provenance (R1-M3, mig 0101) AND
      -- model_gap_reason (mig 0124, r1-H5) — see the identical note in
      -- fetchAcrossDrivers (server/reporting/engine/drivers.ts): distinct
      -- remainder REASONS must stay distinct rows, not collapse into one
      -- bare provenance bucket.
      GROUP BY u.model, u.usage_provenance, u.model_gap_reason
      ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
  ]
  /*
   * FOLD BY DRIVER KEY (mig 0124) — same reason as the engine's model axis
   * (server/reporting/engine/drivers.ts): after the arm-3 fan-out a named
   * model can arrive on MORE than one provenance at this scope (arm-1 OTel +
   * an arm-3 fan-out of the same id), and a per-provenance GROUP BY would
   * double-list its bar. The shared-helper key is the fold identity — named
   * models merge across provenances, remainder keys are provenance+reason
   * scoped and never collide; the provenance mix survives in the breakdown.
   */
  const byKey = new Map<string, Raw & { provMap: Map<string, number> }>()
  for (const r of grouped) {
    const key = modelDriverKey(r.key, r.provenance, r.gap_reason)
    const usd = Number(r.value)
    const cur = byKey.get(key)
    if (cur) {
      cur.value = String(Number(cur.value) + usd)
      if (r.provenance) cur.provMap.set(r.provenance, (cur.provMap.get(r.provenance) ?? 0) + usd)
    } else {
      byKey.set(key, { ...r, provMap: new Map(r.provenance ? [[r.provenance, usd]] : []) })
    }
  }
  const raws = [...byKey.values()].sort((a, b) => Number(b.value) - Number(a.value))

  const rows: DriverRow[] = raws.map((r) => {
    const usd = Number(r.value)
    return {
      // model axis (R1-M3, mig 0101 + mig 0124): route the NULL-model
      // remainder through the shared helper so its key/label are reason-typed
      // — see the identical note in fetchAcrossDrivers. This is the ONLY axis
      // reaching here now ('teammate'/'surface' return above). The reason
      // itself rides the row (`gap_reason`) — the coverage footer's operand.
      key: modelDriverKey(r.key, r.provenance, r.gap_reason),
      label: modelDriverLabel(r.key, r.provenance, r.gap_reason),
      usd,
      sharePct: burnUsd > 0 ? usd / burnUsd : 0,
      spendClass: 'indicative' as SpendClass,
      indicativeReason: 'usage-not-yet-billed',
      ...(r.gap_reason ? { gap_reason: r.gap_reason } : {}),
      ...(r.provMap.size ? { provenanceBreakdown: driverProvenanceBreakdown(r.provMap) } : {}),
    }
  })
  return { rows, headlineUsd: burnUsd, denominatorLabel: `${BU_LABEL_LOWER} burn` }
}

// ── Roster scope (the OVER-THE-SOFT-CAP card's population) ───────────────────
/**
 * The §A clamp for "the people PLACED in this cost centre" — the population
 * `fetchOverSoftCap` anchors on.
 *
 * WHY THIS IS NOT THE BURN CLAMP, and must not become it. Every other query in this
 * module clamps `u.cost_owning_unit_id = ccId`, which is the cost centre OF THE
 * TAGGED PROJECT. That is right for a burn figure and catastrophic for a card about
 * spend with NO project on it: the reconciled arm carries NULL there by construction
 * and untagged emitted spend has no project to take a unit from, so a burn-clamped
 * scan omits exactly the people the card exists to surface. The population is
 * therefore `teammate.org_unit_id`, and the returned predicate addresses the roster
 * alias `t`, never the usage alias `u` (server/reporting/engine/over-soft-cap.ts).
 *
 * THE SUBTREE, not `org_unit_id = ccId`. Both placement doors are live and they
 * differ: the bulk PLACE action refuses a non-cost-owning target
 * (`placeTeammate`, 'cost-owning-only'), but the per-row /admin/users move accepts
 * any active unit in the region ('any-active-unit'), so people genuinely sit on
 * plain `team` nodes BELOW a cost centre. Clamping to the id alone would drop them
 * from their own cost centre's roster while their spend still homed to it. Reuses
 * `orgSubtreeIds` — the region clamp inside it is load-bearing, because org_unit
 * paths are unique only per region.
 *
 * NO NEW RBAC. The caller has already been authorised against this cc by
 * {@link resolveCostCentreDrill} (owner OR region/subtree); this reads one row by
 * primary key to turn that id into its path.
 */
export async function costCentreRosterScope(tx: Tx, ccId: string): Promise<UsageScope> {
  const [ou] = [
    ...(await tx.execute<{ path: string; region_id: string }>(sql`
      SELECT path::text AS path, region_id::text AS region_id
        FROM org_unit WHERE id = ${ccId}::uuid LIMIT 1`)),
  ]
  /*
   * A cost centre that vanished between the drill's own resolve and this read
   * clamps to NO ONE rather than to everyone. `wholeCompanyUsage` here would hand a
   * cost-centre owner the entire company's roster — the exact failure
   * engine/scope.ts's discriminated union exists to make impossible to reach by
   * accident, so it must not be reached deliberately either.
   */
  if (!ou) return clampedUsage(sql`FALSE`)
  return clampedUsage(sql`t.org_unit_id IN (${orgSubtreeIds(ou.path, ou.region_id)})`)
}

// ── The two heroes (budgets + people, side by side) ──────────────────────────
/**
 * The cost-centre owner's two lists, answered TOGETHER.
 *
 * ── WHY BOTH, AND WHY NOT A PIVOT ────────────────────────────────────────────
 * Region and whole-company scope offer an axis selector because at that width a
 * reader is exploring. A cost-centre owner is not: they own exactly two things —
 * the BUDGETS the money went to and the PEOPLE who spent it — and toggling
 * between the only two questions they hold is friction, not a feature
 * (04-prototype-delta.md §5b).
 *
 * ── TWO LISTS, TWO DENOMINATORS, BOTH §A ─────────────────────────────────────
 * Deliberately NOT one headline. `budgets` foots to Σ of the cost centre's own
 * projects and `people` foots to the cost-centre BURN, and those are different
 * numbers by construction: arm 2 carries a real `project_id` with a NULL
 * `cost_owning_unit_id`, and arm 3 carries a cost home with no project at all.
 * Each list therefore ships its OWN `headlineUsd`/`denominatorLabel` and the
 * renderer must show each row set against its own — see
 * {@link fetchCostCentreBurnDrivers} for the full argument. Both are the §A usage
 * lane; neither is a bill figure.
 *
 * Pure delegation: no query lives here. Whatever the axes mean, they mean it
 * once, so the heroes cannot drift from the single-axis answer the same endpoint
 * still serves at `?axis=`.
 */
export interface CostCentreHeroes {
  /** The BUDGET axis — every project this centre leads, uncapped. */
  budgets: CostCentreBurnDriversResult
  /** The PEOPLE axis — every teammate whose spend homed here, uncapped. */
  people: CostCentreBurnDriversResult
}

export async function fetchCostCentreHeroes(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  burnUsd: number,
): Promise<CostCentreHeroes> {
  const [budgets, people] = await Promise.all([
    fetchCostCentreBurnDrivers(tx, ccId, window, 'project', burnUsd),
    fetchCostCentreBurnDrivers(tx, ccId, window, 'teammate', burnUsd),
  ])
  return { budgets, people }
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/** CC-grid CSV — one row per cost centre (burn vs allocation + both mechanics). */
export function cardsToCsv(
  cards: CostCentreCard[],
  meta: { month: string; asOfDate: string | null },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope business-units · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'}`
    ),
    // `charge_usd` (§B chargeback, the bill lane) sits beside `burn_usd` (§A usage) and is
    // ALWAYS present regardless of the on-screen lane, so the export is complete in both.
    'cost_centre,region,burn_usd,charge_usd,allocation_usd,utilisation_pct,exhaustion_date,projected_month_end_usd',
    ...cards.map((c) =>
      [
        csvEscape(c.displayName),
        csvEscape(c.regionCode),
        usd(c.burnUsd),
        usd(c.chargeUsd),
        usd(c.allocationUsd),
        c.utilisation != null ? (c.utilisation * 100).toFixed(1) : 'n/a',
        c.exhaustionDate ?? 'n/a',
        c.forecast ? usd(c.forecast.projectedUsd) : 'n/a',
      ].join(','),
    ),
  ]
  return lines.join('\n') + '\n'
}

/**
 * Over-the-soft-cap CSV — one row per teammate OVER the cap, in the card's own
 * order (unallocated descending).
 *
 * ONLY the over-cap rows are rows. `withinAllowance` is a count and a sum on screen
 * and it is a count and a sum in the header here — it is deliberately not expanded
 * into rows, because a file listing every roster member with $0.00 unallocated is a
 * contact list for people there is no conversation to have with, which is the
 * failure mode this card was rebuilt to avoid. The header carries the denominator
 * so the file is still honest about what it is a subset of.
 *
 * `cap_multiple` is `n/a`, never `0` or `inf`, when the cap is configured to $0 —
 * the same absence the JSON reports as `null`.
 *
 * Every teammate over the cap is listed. `SUM(unallocated_usd)` down the file
 * therefore foots to `over`'s own total by construction, with no synthetic tail
 * row for a reader to reconcile around.
 */
export function overSoftCapToCsv(
  data: OverSoftCap,
  meta: {
    month: string
    ccLabel: string
  },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope business-unit over-soft-cap · bu=${meta.ccLabel} · month=${meta.month}` +
      ` · soft_cap_usd=${usd(data.softCapUsd)} · roster=${data.rosterCount}` +
      ` · roster_usd=${usd(data.rosterUsd)}` +
      ` · within_allowance=${data.withinAllowance.teammates}` +
      ` · within_allowance_unallocated_usd=${usd(data.withinAllowance.unallocatedUsd)}`
    ),
    'teammate,unallocated_usd,cap_multiple,tagged_rate_pct,projects,group',
    ...data.over.map((r) =>
      [
        csvEscape(r.teammate),
        usd(r.unallocatedUsd),
        r.capMultiple != null ? r.capMultiple.toFixed(1) : 'n/a',
        (r.taggedRate * 100).toFixed(1),
        String(r.projects),
        csvEscape(r.group),
      ].join(','),
    ),
  ]
  return lines.join('\n') + '\n'
}

/**
 * Drill drivers CSV — one row per driver (byte-identical to the DriversTable),
 * at any size.
 */
export function driversToCsv(
  rows: DriverRow[],
  meta: { month: string; asOfDate: string | null; axis: string; ccLabel: string },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope business-unit drivers · bu=${meta.ccLabel} · axis=${meta.axis} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'}`
    ),
    'driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)},` +
        `${driverProvenanceCsvCells(r).join(',')},${csvEscape(driverSurfaceMixCsvCell(r))}`,
    ),
  ]
  return lines.join('\n') + '\n'
}

// ── The hero payload (parity: BAND 1 + its four tiles + budget coverage) ─────
/*
 * The cost-centre scope reads the SAME engine primitives the Region widths do,
 * with this scope's predicates supplied instead of declared away. That is the
 * whole reason `server/reporting/engine/` exists, and it is why closing this
 * parity gap is wiring rather than a second implementation: a cost-centre KPI
 * row computed independently is exactly how the two Region widths drifted
 * before they were merged onto `ScopeHero`.
 *
 * THE TWO CLAMPS ARE NOT THE SAME COLUMN, and the aliasing is load-bearing:
 *   §A usage   — `u.cost_owning_unit_id` on the current-lens views, matching the
 *                alias the engine's own FROM uses AND `fetchCostCentreBurnDrill`
 *                above, so the hero's headline IS the burn the page already
 *                shows rather than a second number over the same window.
 *   §B finance — unaliased `cost_owning_unit_id` on the `v_finance_*` views,
 *                the clamp `fetchCostCentreTierExposure` and
 *                `fetchCostCentreCharge` already use.
 * Mixing them is NOT silent — Postgres raises "missing FROM-clause entry" and the
 * request 500s (it took down 21 integration tests in one go). Written once here
 * and reused rather than repeated at each call site. An earlier revision of this
 * sentence said "silently returns zero rows", which is both wrong and the more
 * dangerous reading: it would send the next person looking for missing data.
 */
const ccUsageClamp = (ccId: string): UsageScope => clampedUsage(sql`u.cost_owning_unit_id = ${ccId}::uuid`)

/*
 * THE UNALIASED TWIN. Half the engine's queries write `FROM v_usage_rollup_current`
 * with no alias and half write `FROM v_usage_rollup_current u`, and the predicate has
 * to match the query it lands in:
 *
 *   UNALIASED  fetchKpiCore (kpis.ts:206,:247) · fetchPerPerson (per-person.ts:80)
 *              fetchUsageWeeklyLanes (usage-series.ts:45) · fetchChargebackTrend
 *   ALIASED u. fetchDailyMetrics (usage-series.ts:133) · fetchUsageBudgetCoverage
 *              (usage-coverage.ts:156) · fetchSpendTrend / fetchActiveTrend
 *
 * Getting it wrong is NOT a type error and NOT a silent zero — Postgres rejects
 * the unknown correlation name and the whole request 500s. That is the good
 * case. It cost 21 integration tests here, and the region wrappers had the
 * answer in a comment the entire time ("the clamp addresses UNALIASED
 * region_id / org_unit_id, matching the cohort query's own FROM").
 *
 * `tests/integration/reports/cost-centre-engine-wrappers.test.ts` executes every
 * wrapper below against a real database, because that is the only check that
 * distinguishes these two constants.
 */
const ccUsageClampUnaliased = (ccId: string): UsageScope =>
  clampedUsage(sql`cost_owning_unit_id = ${ccId}::uuid`)

/**
 * §A + §B KPI figures for one cost centre — `genuineUsd`, `chargeableUsd`,
 * `activeUsers` and both MoM deltas, over the same window the drill uses.
 *
 * `monthFloorKey` must vary with the usage clamp (month-floor.ts) or two centres
 * share a cached floor and one of them reports the other's earliest month.
 */
export async function fetchCostCentreKpis(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<ReportKpiCore> {
  return fetchKpiCore(
    tx,
    {
      // UNALIASED on both lanes: fetchKpiCore's own FROM clauses carry no alias
      // (engine/kpis.ts:206, :247), exactly as `fetchRegionalKpis` clamps
      // ('region_id', 'org_unit_id') rather than 'u.region_id'.
      usage: ccUsageClampUnaliased(ccId),
      finance: clampedFinance(sql`cost_owning_unit_id = ${ccId}::uuid`),
      monthFloorKey: `cc:${ccId}`,
    },
    window,
    opts,
  )
}

/**
 * The §A per-person cohort behind the "Median per person" tile — the same engine
 * read both Region widths take, clamped to this centre. Its denominator is the
 * SAME population `fetchCostCentreKpis` counts as `activeUsers`, so the tile and
 * the headcount beside it cannot contradict each other.
 */
export async function fetchCostCentrePerPerson(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  opts: { momMonthRange?: MonthRangeUtc | null; asOfDate?: string | null } = {},
): Promise<PerPersonKpi> {
  // UNALIASED — the cohort query's FROM carries no alias (engine/per-person.ts:80),
  // the same reason `fetchRegionalPerPerson` clamps unqualified columns.
  return fetchPerPerson(tx, ccUsageClampUnaliased(ccId), window, opts)
}

/** §A per-day usage series — the sparkline under the Attributed-usage tile. */
export async function fetchCostCentreDailyMetrics(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  clock: ServerClock,
): Promise<DailyMetric[]> {
  return fetchDailyMetrics(tx, ccUsageClamp(ccId), window, clock)
}

/** §B per-day Anthropic chargeback series — the Chargeable tile's sparkline. */
export async function fetchCostCentreChargebackTrend(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  clock: ServerClock,
): Promise<ChargeDailyPoint[]> {
  return fetchChargebackTrend(tx, clampedFinance(sql`cost_owning_unit_id = ${ccId}::uuid`), window, clock)
}

/**
 * §A budget coverage of this centre's headline — how much of its attributed
 * usage sits on a budgeted project, and how much sits outside the budget lens.
 *
 * Clamped by the SAME §A predicate as the KPIs above, so `totalUsd` IS the
 * headline and the four parts foot to the number they render beside. The
 * `scopeLabel` is the CENTRE's own name because that is the clamp: the note
 * names the denominator in the reader's words, and a component cannot see a SQL
 * predicate (contract C11), so the label travels with the figure.
 */
export async function fetchCostCentreUsageBudgetCoverage(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
  scopeLabel: string | null,
): Promise<UsageBudgetCoverage> {
  return fetchUsageBudgetCoverage(tx, ccUsageClamp(ccId), window, scopeLabel)
}

// ── The rolling band (parity: BAND 2 and its four cards) ────────────────────
/*
 * THE UNALIASED TWIN, and it is not a stylistic choice. `fetchUsageWeeklyLanes`
 * selects `FROM v_usage_rollup_current` with NO alias, so a `u.`-qualified predicate
 * does not resolve there — and because the mismatch is a missing correlation
 * name, Postgres REJECTS the statement outright with "missing FROM-clause entry
 * for table \"u\"" — the request 500s rather than quietly returning no rows. (An
 * earlier revision of this comment said it would "simply draw nothing", which is
 * the opposite of what happened and would have sent the next reader looking for
 * a data problem instead of an error.) `fetchRegionalUsageWeeklyLanes` uses the unaliased
 * form for exactly this reason. Two clamps, each named for the query shape it
 * belongs to, is cheaper than one clamp that is silently wrong half the time.
 */

/** §A per-day vendor split for the rolling spend-trend chart. */
export async function fetchCostCentreSpendTrend(
  tx: Tx,
  ccId: string,
  range: UsageWindow,
): Promise<{ series: TrendPoint[]; windowDays: number }> {
  return fetchSpendTrend(tx, ccUsageClamp(ccId), range)
}

/** §A distinct active developers per tool per day. Not additive across lanes. */
export async function fetchCostCentreActiveTrend(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  return fetchActiveTrend(tx, ccUsageClamp(ccId), window)
}

/** §A weekly surface lanes — the operand behind "Where the AI spend goes". */
export async function fetchCostCentreUsageWeeklyLanes(
  tx: Tx,
  ccId: string,
  window: UsageWindow,
): Promise<UsageSurfaceWeeklyCell[]> {
  return fetchUsageWeeklyLanes(tx, ccUsageClampUnaliased(ccId), window)
}
