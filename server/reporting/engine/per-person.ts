/*
 * The §A per-person cohort a reporting KPI row publishes, scope-parameterised —
 * ONE implementation for the whole-company and single-region widths.
 *
 * WHY IT MOVED HERE. This was `fetchAcrossPerPerson` in across-regions.ts, on the
 * reasoning that only the whole-company width rendered a Median-per-person tile.
 * That was an accident of which width got the prototype's fix 6 applied to it, not
 * a property of the scopes: a region owner has exactly the same question ("what
 * does a typical person here spend, and how lopsided is it"), and the Region width
 * simply never had the tile built. Rather than write a second cohort query for it
 * — the divergence engine/scope.ts exists to prevent — the query takes a clamp.
 *
 * ONE FACT, ONE HOME (prototype fix 6): the median is what a typical person spends
 * and the three percentiles are how lopsided that is — the same question asked
 * twice, so they travel together on one tile rather than as a KPI and a separate
 * Concentration band that disagreed with it.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { computeConcentration } from '../../../shared/reports/concentration'
import { momPaceWindow, type UsageWindow } from '../params'
import type { MonthRangeUtc } from '../../utils/period'
import { scopeSql, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface PerPersonKpi {
  /**
   * Median of the per-teammate windowed totals. Computed over EVERY person in
   * the cohort — the query is not truncated, so this is a median and not a high
   * percentile of a top-N list.
   */
  medianUsd: number
  /** Cohort shares of the window total, FRACTIONS in [0,1]. */
  top1: number
  top5: number
  top10: number
  /**
   * The subset of the active cohort with at least one OTEL-EMITTED record in the
   * window (`v_complete_usage.usage_provenance = 'otel-emitted'`) — people
   * EMITTING through TokenScope, against the people who SPENT. The rollout gap,
   * and the one figure here that measures us rather than them.
   *
   * It is NOT an enrolment count: an enrolment that emitted nothing this window
   * is not in it, and this figure never reads `instance_attestation`.
   */
  emittingPeople: number
  /**
   * Active people MINUS the paced previous month's, an ABSOLUTE count delta (a
   * headcount wants a number of people, not a percentage of one). `null` when
   * there is no previous operand — a custom range has no month anchor, and a
   * month with no data has no as-of to pace by.
   */
  peopleMomDelta: number | null
  /** (median − prevMedian)/prevMedian as a FRACTION, or null (no prior operand). */
  medianMomDeltaPct: number | null
}

interface CohortRow extends Record<string, unknown> {
  cost: string
  emitting: boolean
}

/**
 * One ranked per-teammate query over the §A lane: Σ `cost_usd` per teammate,
 * DESC, keeping only teammates whose window total is POSITIVE.
 *
 * That `HAVING` is the SAME population `fetchKpiCore` counts as `activeUsers`,
 * deliberately — the tile says "half of N are below this" over the N beside it,
 * so the two must be one definition rather than two queries that agree today.
 *
 * The lane is UNALIASED, so a clamp must address bare columns (`teammate_id`, `cost_owning_unit_id`)
 * — the same addressing `fetchKpiCore`'s §A totals query takes, and what
 * `RegionalScope.usageScope('teammate_id')` builds.
 */
async function fetchCohort(tx: Tx, scope: UsageScope, window: UsageWindow) {
  // usage_rollup_daily, not the live view (usage-rollup-lane.md R5): teammate_id
  // and usage_provenance are both in the grain, so the per-teammate Σ and the
  // bool_or over cells answer exactly what they answered over rows.
  const rows = await tx.execute<CohortRow>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS cost,
           bool_or(usage_provenance = 'otel-emitted') AS emitting
    FROM v_usage_rollup_current
    WHERE ${scopeSql(scope)}
      AND day >= ${window.startIso.slice(0, 10)}::date
      AND day <  ${window.endIso.slice(0, 10)}::date
    GROUP BY teammate_id
    HAVING COALESCE(SUM(cost_usd), 0) > 0
    ORDER BY SUM(cost_usd) DESC`)
  const list = [...rows]
  return {
    stats: computeConcentration(list.map((r) => Number(r.cost))),
    emittingPeople: list.filter((r) => r.emitting === true).length,
  }
}

/**
 * The per-person KPI over `window` for one scope, with its month-over-month
 * operands taken from the PACED previous month — the same `momPaceWindow` clip
 * the §A money MoM uses, so "vs last month" means the same span on every tile in
 * the row rather than a partial month against a whole one.
 *
 * `asOfDate` is the §A data frontier (`fetchKpiCore(...).asOfDate`); absent it
 * (or absent a month anchor) both deltas are `null` and the tiles say so.
 */
export async function fetchPerPerson(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
  opts: { momMonthRange?: MonthRangeUtc | null; asOfDate?: string | null } = {},
): Promise<PerPersonKpi> {
  const { stats, emittingPeople } = await fetchCohort(tx, scope, window)

  let peopleMomDelta: number | null = null
  let medianMomDeltaPct: number | null = null
  if (opts.momMonthRange && opts.asOfDate) {
    const prevWindow = momPaceWindow(opts.momMonthRange, new Date(`${opts.asOfDate}T00:00:00.000Z`))
    const prev = await fetchCohort(tx, scope, prevWindow)
    /*
     * A count delta needs only that the previous window was MEASURED — 0 people
     * last month against 3 this month is "↑3", a fact. The median delta is a
     * RATIO and so additionally needs a non-zero divisor; withheld otherwise
     * rather than rendered as an infinite rise.
     */
    peopleMomDelta = stats.activeUsers - prev.stats.activeUsers
    medianMomDeltaPct =
      prev.stats.medianUsd > 0
        ? (stats.medianUsd - prev.stats.medianUsd) / prev.stats.medianUsd
        : null
  }

  return {
    medianUsd: stats.medianUsd,
    top1: stats.top1,
    top5: stats.top5,
    top10: stats.top10,
    emittingPeople,
    peopleMomDelta,
    medianMomDeltaPct,
  }
}
