/*
 * The wire shapes the Cost-Centre reporting endpoints return, shared by the
 * ScopeCostCentre container (to type its useFetch/$fetch generics) and the
 * ScopeCostCentreView (its props). Pure types — no runtime.
 */
import type {
  CostCentreScope,
  DriverRow,
  Forecast,
  OverSoftCap,
  ReportMeta,
  ChargeDailyPoint,
  DailyMetric,
  UsageBudgetCoverage,
} from '#shared/reports/types'
import type { TierExposure } from '#shared/reports/tier-exposure'
import type { ScopePerPerson } from './scope-hero-types'

/** One CC card — burn (project-CoU usage axis) vs allocation + the two mechanics. */
export interface CostCentreCard {
  id: string
  code: string
  displayName: string
  regionCode: string
  burnUsd: number
  /**
   * §B chargeback for the CC over the window (`v_finance_chargeback_month`) — the
   * chargeback-lane figure the list shows instead of `burnUsd` in chargeback mode.
   * Anthropic always; Copilot pooled net only when validated. NEVER summed with burn.
   */
  chargeUsd: number
  allocationUsd: number
  utilisation: number | null
  /** Mechanic 1 — budget-exhaustion DATE (a date, never a dollar). */
  exhaustionDate: string | null
  /** Mechanic 2 — run-rate dollar projection (null when the month is closed). */
  forecast: Forecast | null
  asOfDate: string | null
}

export interface CostCentreReport {
  meta: ReportMeta
  cards: CostCentreCard[]
  /**
   * WHERE THE READER IS — server-derived from the resolver that clamped the
   * cards (F5 D23). Optional so pre-scope fixtures still typecheck; a view must
   * therefore treat absence as "this build has no scope block", never as "you
   * can see no cost centres" (that is `options: []`).
   */
  scope?: CostCentreScope
  /**
   * The endpoint's axis statement. Still on the wire, but UNRENDERED since D8b
   * (the top layer stops explaining itself): rationale is not UI copy, and the
   * consequence a reader needs is the view's own unattributed-gap note.
   */
  laneNote: string
  /**
   * §B — copilot chargeback ON but the window is not month-aligned → the pooled (monthly)
   * Copilot net is withheld from every card's `chargeUsd` (never a partial slice). The
   * chargeback-mode view shows a "Copilot pooled (monthly) not shown for partial-month
   * ranges" caveat instead of a silent $0. Optional (absent ⇒ false) so pre-existing
   * fixtures need not set it.
   */
  copilotChargebackPartialMonth?: boolean
}

export interface CostCentreDrill {
  meta: ReportMeta
  cc: { id: string; code: string; displayName: string; regionCode: string }
  /**
   * §A usage BURN on the current-lens cost_owning_unit_id — the SAME lane as the
   * tracker card burn, so the drill reconciles to the tracker row (chargeback /
   * billing for this CC lives in the Finance tab, never mixed in here).
   */
  burnUsd: number
  /**
   * §B — what this centre is CHARGED over the window; the SAME figure its card
   * in the list carries, from the same fetcher. Rendered INSTEAD of `burnUsd` in
   * the chargeback lane, never beside it and never summed with it: the two are
   * different lanes over different bases (contract C2).
   */
  chargeUsd: number
  /**
   * The Copilot pool is POOLED-MONTHLY, so it is withheld from `chargeUsd` on a
   * window that is not month-aligned. True means "a real charge is missing from
   * the figure" — the surface must caveat it rather than let it read as $0.
   */
  copilotChargebackPartialMonth: boolean
  /** Burn split by vendor (feeds the donut). Copilot pooled NULL-CoU is excluded. */
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
  /**
   * DERIVED: the roll-up of this centre's projects' current-effective
   * baseline+top-up budgets (0 if none). Not a budget set on the cost centre —
   * the budgeted unit of account is the project, so any surface rendering this
   * says where it came from.
   */
  allocationUsd: number
  /**
   * Unallocated spend over the soft cap, ROSTER-anchored — the people PLACED in
   * this cost centre, not the `cost_owning_unit_id` burn axis every other figure on
   * this drill uses. Its `rosterUsd` is a DIFFERENT denominator from `burnUsd` and
   * the card names it as one; the two are not slices of each other.
   */
  overSoftCap: OverSoftCap
  axis: string
  /** The CC burn — what the driver rows sum back to. */
  headlineUsd: number
  denominatorLabel: string
  rows: DriverRow[]
  /**
   * The screen's two lists (04-prototype-delta.md §5b). Each foots to its OWN
   * `headlineUsd` in the SAME §A lane, and the two headlines legitimately differ
   * (the budget axis is clamped on the project's cost centre, the people axis on
   * the usage row's) — render each against its own or the rows read as failing
   * to add up.
   */
  budgets: CostCentreDriverList
  people: CostCentreDriverList
  /**
   * §B Behavioural exposure — billed spend banded by model tier, clamped to this
   * CC's cost-owning unit, over the SAME window as the burn above.
   *
   * A SEPARATE FIELD, never folded into `vendor` or `burnUsd`: the burn is
   * usage-basis (`v_complete_usage`) and this is provider-billed
   * (`provider_usage_fact`). The two are never summed (consistency contract C2),
   * and a shape that invited it would be the mixed-lens defect the reporting
   * consolidation exists to remove.
   */
  exposure: TierExposure
  /*
   * ── THE HERO PAYLOAD ──────────────────────────────────────────────────────
   * Structurally `ScopeHeroReport` (scope-hero-types.ts), so this scope renders
   * the SAME hero component both Region widths do rather than a third KPI row
   * that can drift from them. The approved prototype draws these on this page —
   * they sit in the unconditional tail of `across()`, which `cc(d)` runs — and
   * none of it was built until the parity gate made the gap visible.
   */
  kpis: {
    genuineUsd: number
    chargeableUsd: number
    activeUsers: number
    momDeltaPct: number | null
    chargeMomDeltaPct: number | null
  }
  copilot: { pending: boolean; partialMonthUnavailable?: boolean }
  /** Non-null EXACTLY when the viewed month is the in-progress one. */
  forecast: Forecast | null
  dailyMetrics?: DailyMetric[]
  chargeDaily?: ChargeDailyPoint[]
  budgetCoverage: UsageBudgetCoverage
  perPerson?: ScopePerPerson
}

/** One hero's rows plus the denominator they sum back to. */
export interface CostCentreDriverList {
  rows: DriverRow[]
  headlineUsd: number
  denominatorLabel: string
}
