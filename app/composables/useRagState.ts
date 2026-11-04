/*
 * useRagState — shared RAG threshold computation.
 *
 * Single source of truth for "percent → severity" — used by UiPbar, UiKpi,
 * and any consumer that needs RAG state without a
 * component. Thresholds match design-notes §Screen 2:
 *   < 0.75 → green / harmony  (Healthy)
 *   ≥ 0.75 → amber             (Watch)
 *   ≥ 0.90 → red               (Critical — approaching budget)
 *   > 1.00 → red               (Over — actually over budget)
 *
 * COLOUR (ragOf) and LABEL (ragLabel) are deliberately distinct: red at 90–100%
 * is a hard warning but NOT "over". "Over" is reserved for spend that has crossed
 * the budget (pct > 1) — labelling 91% as "Over" reads as over-budget when it isn't.
 */
export type RagSeverity = 'green' | 'amber' | 'red'

export function ragOf(pct: number): RagSeverity {
  if (pct >= 0.9) return 'red'
  if (pct >= 0.75) return 'amber'
  return 'green'
}

/** Human label for a RAG percentage. "Over" only once the budget is exceeded. */
export function ragLabel(pct: number): string {
  if (pct > 1) return 'Over'
  if (pct >= 0.9) return 'Critical'
  if (pct >= 0.75) return 'Watch'
  return 'Healthy'
}

export function useRagState(pct: () => number) {
  const sev = ragOf(pct())
  return { sev }
}

/**
 * Where a budget will LAND at month end — the basis behind the per-project pill
 * on the dashboard.
 *
 * `ragOf` above answers a different question: what share of the budget is gone
 * right now. On a budget row that is the wrong question, because it has no
 * calendar in it: 90% of a budget on day 28 is a month that finishes about on
 * plan, and 90% on day 5 is a month that finishes at roughly six times the
 * budget, and raw percent calls both of them the same thing. Every project on
 * the dashboard read "Healthy" as a result — including one at $0.00 of $500,
 * where nothing had happened at all.
 *
 * The words, colours and position of the pill are unchanged; only this basis is
 * new. Kept a PURE function of four numbers so the truth table is testable
 * without a component (tests/unit/components/budget-pace.test.ts).
 *
 *   over         already over the allocation — a FACT; a top-up flips it
 *   pace-over    not over yet, but on this pace will be — a FORECAST
 *   warning      on this pace, finishes at 85-100% of the allocation
 *   healthy      on this pace, finishes under 85% of the allocation
 *   not-started  an allocation, and nothing spent against it yet
 *   no-budget    no allocation to measure against
 *
 * `over` and `pace-over` were ONE state (both returned 'over') until D8 split
 * them: a fact and a forecast wearing the same word meant the pill could not
 * say which of two things it meant, and a reader could not tell whether a
 * top-up was already needed or merely likely to be.
 *
 * `daysElapsed` is the DAY OF THE MONTH (`RunRate.days_elapsed`), so month-to-
 * date spend is the running total at the END of that day and the elapsed
 * fraction is `daysElapsed / daysInMonth` — 1 on the last day, where the
 * projection correctly degenerates to the actual.
 */
export type BudgetPace =
  | 'no-budget' | 'not-started' | 'too-early' | 'healthy' | 'warning' | 'pace-over' | 'over'

/** Projected-at-month-end share of the allocation at which the pill turns amber. */
const PACE_WARNING_AT = 0.85

/**
 * Days of month-to-date needed before a projection is worth drawing. Shared
 * with the hero's run-rate so the two cannot drift apart.
 */
export const PACE_MIN_DAYS = 3

/**
 * Where THIS spend lands at month end, in dollars — the figure behind the
 * `pace-over` row's "on pace for ~$X" line and the hero's month-end
 * projection. One function on purpose (r1-M4): the hero's projection is the
 * PORTFOLIO total and was once nearly reused per row, which would have printed
 * every project's combined landing under each individual pill.
 *
 * Same day-floor and clamp semantics as `budgetPace`'s forecast branch, with
 * one honest difference: where `budgetPace` clamps a degenerate calendar
 * (`daysInMonth <= 0`) so the projection degenerates to the actual — i.e. it
 * extrapolates nothing — a dollar FIGURE that "extrapolates nothing" is not a
 * projection at all, so this returns `null` and no line is drawn. `null`
 * likewise below the PACE_MIN_DAYS floor: two days of a month is not a pace.
 */
export function projectedMonthEnd(
  spendUsd: number,
  daysElapsed: number,
  daysInMonth: number,
): number | null {
  if (daysElapsed < PACE_MIN_DAYS) return null
  if (!(daysInMonth > 0)) return null
  /*
   * The elapsed fraction has to be in (0, 1] for the projection to mean
   * anything, so the day is clamped into the month rather than trusted — a
   * day past the month's end degenerates to the actual, not beyond it. (This
   * clamp moved here from `budgetPace` in the D8 split so the pill's verdict
   * and the figure printed beside it cannot be computed two different ways.)
   */
  const elapsed = Math.min(Math.max(daysElapsed, 1), daysInMonth) / daysInMonth
  return spendUsd / elapsed
}

export function budgetPace(
  spendUsd: number,
  allocationUsd: number,
  daysElapsed: number,
  daysInMonth: number,
): BudgetPace {
  if (!(allocationUsd > 0)) return 'no-budget'
  if (!(spendUsd > 0)) return 'not-started'
  const usedPct = spendUsd / allocationUsd
  /*
   * `> 1`, matching `ragFromPct` twelve lines up. The two lived in one file
   * disagreeing about the same boundary: exactly 100% of a budget is spent,
   * not exceeded, and the copy says "over" and "past".
   */
  /*
   * ALREADY over is a FACT and is never gated by the day floor below — you are
   * past the allocation whether it is the 1st or the 31st, and no forecast is
   * involved in saying so. (My first version of the floor swallowed this case,
   * which suppressed a fact rather than a projection. The test caught it.)
   * Since D8 the fact also keeps the word "Over" to itself — the forecast
   * branch below returns 'pace-over' and reads "On pace to exceed".
   */
  if (usedPct > 1) return 'over'
  /*
   * Everything past here IS a forecast, so it takes the same day floor the
   * hero's run-rate takes. A pill reading "Over" beside a hero saying "too
   * early to project" is one page holding two positions on whether a few days
   * can carry a month-end figure — and on day 1 a single heavy session
   * projects to 31x itself.
   */
  /*
   * No `daysElapsed > 0` guard. That guard let 0 and negative days fall PAST
   * the floor and into the clamp below, which projects them as day 1 — so
   * `budgetPace(400, 1000, 0, 31)` returned "Over" while day 1 returned
   * "too early". A missing or nonsensical day is the case with the LEAST
   * evidence behind it, not the most.
   */
  if (daysElapsed < PACE_MIN_DAYS) return 'too-early'
  /*
   * The clamp that keeps the elapsed fraction in (0, 1] lives in
   * `projectedMonthEnd` since D8 (one arithmetic for the verdict and the
   * printed figure). The degenerate input (0 of 0) is the page's pre-fetch
   * default, which renders no rows; the helper answers it with `null`
   * ("nothing to extrapolate"), and the ACTUAL stands in here — the same
   * "extrapolates nothing rather than dividing by zero into Over" this branch
   * always had, when it clamped 0-of-0 to day 1 of 1 inline.
   */
  const projected = projectedMonthEnd(spendUsd, daysElapsed, daysInMonth)
  const projectedPct = (projected ?? spendUsd) / allocationUsd
  /* `> 1`, like the already-over check above and like `ragFromPct`. Landing
   * exactly ON the allocation is spending it, not exceeding it. Since D8 this
   * is 'pace-over', not 'over': it is a FORECAST, and it no longer borrows the
   * fact's word. */
  if (projectedPct > 1) return 'pace-over'
  if (projectedPct >= PACE_WARNING_AT) return 'warning'
  return 'healthy'
}

/**
 * The pill's word for a pace state. The vocabulary was unchanged from the
 * raw-percent pill until D8 split 'over': "Over" now belongs to the FACT
 * alone (spend past the allocation), and the FORECAST says what it is —
 * "On pace to exceed". Every other word is still the original.
 */
export function budgetPaceLabel(pace: BudgetPace): string {
  if (pace === 'over') return 'Over'
  if (pace === 'pace-over') return 'On pace to exceed'
  if (pace === 'warning') return 'Warning'
  if (pace === 'healthy') return 'Healthy'
  if (pace === 'not-started') return 'Not started'
  if (pace === 'too-early') return 'Too early'
  return 'No budget set'
}

/** The pill's `UiBadge` kind for a pace state. */
export function budgetPaceKind(pace: BudgetPace): 'rag-green' | 'rag-amber' | 'rag-red' | 'neutral' {
  if (pace === 'over') return 'rag-red'
  /*
   * A forecast is amber, not red (D8): red is reserved for money already past
   * the allocation — a fact. Amber is "act before it becomes one", the same
   * urgency band 'warning' occupies.
   */
  if (pace === 'pace-over') return 'rag-amber'
  if (pace === 'warning') return 'rag-amber'
  if (pace === 'healthy') return 'rag-green'
  return 'neutral'
}
