/*
 * engine/trend-series — the §A day-grained trend reads, for ANY scope.
 *
 * ── WHY THESE MOVED ──────────────────────────────────────────────────────────
 * Both of these lived in `reporting/regional.ts` typed to a `RegionalScope`, and
 * exactly one line in each was region-specific: the WHERE predicate. That is the
 * whole reason the cost-centre scope had no spend trend and no active-developer
 * trend while the approved prototype has always drawn both on it — the code was
 * reachable only by a caller that could produce a `RegionalScope`.
 *
 * Taking a `UsageScope` instead is the same generalisation `fetchKpiCore`,
 * `fetchDailyMetrics` and `fetchPerPerson` already made, and it is what makes a
 * second implementation unnecessary. Copying these into `cost-centres.ts` was
 * the alternative, and it is precisely how the two Region widths drifted into
 * publishing different KPI rows before they were merged onto one component.
 *
 * ── ONE BEHAVIOURAL DIFFERENCE, DELIBERATE ───────────────────────────────────
 * `scopeSql()` parenthesises the predicate; the region call sites inlined it
 * bare. For a self-parenthesised predicate (which `org-subtree-scope.ts:48`
 * produces) the SQL is equivalent, so region output is unchanged — pinned by
 * `tests/integration/reports/regional.test.ts` and `seasonality-active-trend.test.ts`,
 * both green before and after the move. The parens are strictly safer: an
 * unwrapped top-level OR re-associates against the window and returns history
 * (see the reasoning on `scopeSql` itself).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ActiveTrendPoint } from '../../../shared/reports/types'
import { laneListSql, SECTION_A_USAGE_TOOLS } from '../../../shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '../../../shared/usage/surface'
import { COPILOT_CLI_TOOL, COPILOT_AGENT_TOOL } from '../../../shared/usage/github-surface'
import type { UsageWindow } from '../params'
import { scopeSql, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface TrendPoint {
  day: string
  /**
   * §A trend key — the three named §A usage tools plus the live `other`
   * catch-all (the three-lane §A ceiling). Registry-driven tool ids, never the
   * display names they used to be.
   */
  key: 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'
  value: number
}

/**
 * Per-day §A vendor split over the window, for the stacked bars — one point per
 * (day, lane) with a POSITIVE cost. `copilot-agent` is a real, live
 * `v_complete_usage` lane (migration 0101's ingest-only completeness arm), so
 * its points appear on any day the coding agent is used.
 *
 * Only positive cells are emitted: a zero point would draw a segment of no
 * height that still occupies a legend slot, implying a lane was used when it
 * was not. The `other` bucket is a live catch-all (`NOT IN (...) OR IS NULL`)
 * so a newly registered surface cannot vanish from the total.
 */
export async function fetchSpendTrend(
  tx: Tx,
  scope: UsageScope,
  range: UsageWindow,
): Promise<{ series: TrendPoint[]; windowDays: number }> {
  // Day-grain §A read → usage_rollup_daily (usage-rollup-lane.md R5): `tool` is
  // in the rollup grain, so the per-lane FILTER sums translate 1:1.
  const rows = await tx.execute<{ day: string; claude: string; copilot: string; agent: string; other: string }>(sql`
    SELECT to_char(u.day, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${CLAUDE_CODE_TOOL}), 0)::text AS claude,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${COPILOT_CLI_TOOL}), 0)::text AS copilot,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${COPILOT_AGENT_TOOL}), 0)::text AS agent,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR u.tool IS NULL), 0)::text AS other
    FROM v_usage_rollup_current u
    WHERE ${scopeSql(scope)}
      AND u.day >= ${range.startIso.slice(0, 10)}::date
      AND u.day <  ${range.endIso.slice(0, 10)}::date
    GROUP BY 1 ORDER BY 1`)
  const series: TrendPoint[] = []
  for (const r of rows) {
    if (Number(r.claude) > 0) series.push({ day: r.day, key: 'claude-code', value: Number(r.claude) })
    if (Number(r.copilot) > 0) series.push({ day: r.day, key: 'copilot-cli', value: Number(r.copilot) })
    if (Number(r.agent) > 0) series.push({ day: r.day, key: 'copilot-agent', value: Number(r.agent) })
    if (Number(r.other) > 0) series.push({ day: r.day, key: 'other', value: Number(r.other) })
  }
  // Window length in days — the half-open [start, end) span. For a month window
  // this is the month length; for a custom range it is the span.
  const windowDays = Math.round(
    (new Date(range.endIso).getTime() - new Date(range.startIso).getTime()) / 86_400_000,
  )
  return { series, windowDays }
}

/**
 * Distinct ACTIVE developers per tool per day over the window.
 *
 * NOT additive across lanes: a developer active in both tools counts in each
 * line, which is why the card says so rather than summing them.
 *
 * The two lane filters read the REGISTRY constants. They were bare `'claude-code'`
 * / `'copilot-cli'` string literals before this move — a direct breach of
 * Reporting.md rule 3 ("lane filters come from the registry, never from a literal
 * list pasted into SQL"), and the sibling query three functions away already did
 * it correctly. Fixed here because moving the code is the moment it is cheapest
 * to fix, and a literal that agrees with the registry today is still a literal
 * that will not follow it tomorrow.
 */
export async function fetchActiveTrend(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  // COUNT(DISTINCT teammate_id) is exact on the rollup — teammate_id is in the
  // grain (usage-rollup-lane.md R2/R5), so a cell-set spans the same people.
  const rows = await tx.execute<{ day: string; claude: number; copilot: number }>(sql`
    SELECT to_char(u.day, 'YYYY-MM-DD') AS day,
           COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = ${CLAUDE_CODE_TOOL})::int AS claude,
           COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = ${COPILOT_CLI_TOOL})::int AS copilot
    FROM v_usage_rollup_current u
    WHERE ${scopeSql(scope)}
      AND u.day >= ${window.startIso.slice(0, 10)}::date
      AND u.day <  ${window.endIso.slice(0, 10)}::date
    GROUP BY 1 ORDER BY 1`)
  return [...rows].map((r) => ({
    day: r.day,
    claudeCode: Number(r.claude),
    copilot: Number(r.copilot),
  }))
}
