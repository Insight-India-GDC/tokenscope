/*
 * §A usage series, scope-parameterised — the usage-lane half of the shared
 * reporting engine.
 *
 * SEPARATE FROM chargeback-series.ts ON PURPOSE. That module reads
 * v_finance_bill_chargeback (the §B BILL lane); this one reads the §A USAGE
 * lane — through `usage_rollup_daily`, the day-grain rollup whose content is
 * DEFINED as an aggregate of v_complete_usage (docs/design/usage-rollup-lane.md
 * R5; both reads here are day/week-grain, so the rollup serves them exactly).
 * Consistency contract C2 is "one lane per axis,
 * firewall-enforced", and §A and §B answer different questions on different
 * grains — a figure from one must never be summed with a figure from the other
 * (docs/design/provider-billing-attribution-model.md). Keeping them in one file
 * because both happen to be "series" would put the two lanes one autocomplete
 * apart, which is how they get mixed.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ServerClock } from '../../../shared/reports/clock'
import type { DailyMetric, UsageSurfaceWeeklyCell } from '../../../shared/reports/types'
import { mergeWeeklyLaneRows, type UsageWindow } from '../params'
import { scopeSql, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * The canonical §A weekly lane series over the window: usage_rollup_daily
 * grouped by ISO week × tool, tools folded to registry lane ids by
 * mergeWeeklyLaneRows. ISO week derives from `day` (usage-rollup-lane.md R5) —
 * every arm-2/3 row was day-grain already, and arm-1 intra-day times were never
 * load-bearing for a week bucket.
 *
 * EVERY §A surface rides this natively, including copilot and copilot-agent —
 * there is no GitHub firewall here, because that firewall exists only to keep
 * usage-basis rows out of a BILLED view, and this view IS the usage basis.
 *
 * Σ cells over a window equals the same scope's `genuineUsd` headline for that
 * window, cent-exactly (test-pinned) — which is the property that stops this
 * hero disagreeing with the KPI above it. NOT zero-filled: the client's week
 * axis does that, and a week with no usage is a gap in this series rather than
 * a claimed zero. NEVER summed with a §B chargeback figure.
 */
export async function fetchUsageWeeklyLanes(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
): Promise<UsageSurfaceWeeklyCell[]> {
  const rows = await tx.execute<{ week_start: string; tool: string | null; usd: string }>(sql`
    SELECT date_trunc('week', day::timestamp)::date::text AS week_start, tool,
           COALESCE(SUM(cost_usd), 0)::text AS usd
    FROM v_usage_rollup_current
    WHERE ${scopeSql(scope)}
      AND day >= ${window.startIso.slice(0, 10)}::date AND day < ${window.endIso.slice(0, 10)}::date
    GROUP BY 1, tool
    ORDER BY 1`)
  return mergeWeeklyLaneRows(rows)
}

/**
 * Per-day §A usage over the window: spend, tokens and the people who SPENT that
 * day (Σ `cost_usd` positive — the same definition `fetchKpiCore.activeUsers`
 * uses, because this series is the sparkline drawn under that number).
 *
 * ZERO-FILLED across every day of the window THAT HAS ALREADY HAPPENED, and no
 * further (generate_series LEFT JOIN the aggregate). Both halves are
 * load-bearing, because this feeds a sparkline:
 *
 *   - a PAST day with no in-scope usage IS emitted, as a genuine 0 — we looked
 *     and found none, and dropping it would compress scattered activity into
 *     contiguous points and misstate the shape of the month;
 *   - a FUTURE day is NOT emitted, because nothing has been measured there. On
 *     day 3 of a 31-day month the old axis padded 28 zeros to the right edge,
 *     which draws as "spend collapsed to zero on day 4 and never recovered" —
 *     an assertion about days that have not occurred.
 *
 * The generated axis' upper bound is therefore
 *
 *   LEAST( endDate - 1 day,                          -- never past the window
 *          GREATEST( clock.settledThrough,           -- never past the settled edge …
 *                    MAX(day carrying in-scope data) ) )  -- … unless data exists
 *
 * `window.endIso` is EXCLUSIVE, so the first arm stops the axis one day before
 * it exactly as before. The `GREATEST` arm is NOT cosmetic: a row timestamped
 * beyond the edge still counts in the window's headline, so without it that row
 * would be dropped from the series while remaining in the total, silently
 * breaking Σ(series) === headline (test-pinned). A window whose start is after
 * the bound yields NO rows, which is the correct answer: nothing in it has
 * happened yet.
 *
 * ── THE EDGE IS `settledThrough`, NOT `CURRENT_DATE` (fix-sprint F1/D2) ──────
 * This arm read `CURRENT_DATE`, and the doc comment argued the case: "CURRENT_DATE
 * is the DATA clock — the DB and the app share a deployment." Under D3 that is
 * exactly the reasoning being retired. SQL's `CURRENT_DATE` is a *third* clock
 * (after the server's and the browser's), and it is a WALL-CLOCK fact where the
 * axis needs a COVERAGE fact. The gap between the two is the morning dip:
 * `CURRENT_DATE` pulls the axis onto a day that is three hours old at 09:00
 * Sydney, the LEFT JOIN pads it to 0, and the chart draws a collapse.
 * `settledThrough` — the last COMPLETE UTC day — stops the axis where the data
 * is finished, and today appears only if it genuinely carries rows (the MAX(day)
 * arm), where the client draws it partial. Fixing only the browser MOVES the
 * dip; this is where it actually lives.
 *
 * `clock` is a REQUIRED parameter and this query holds NO clock of its own. That
 * is the contract: one resolution, made at the endpoint boundary, seen by the
 * SQL and the browser alike — which is also what makes a deterministic "today"
 * testable at all.
 *
 * The lane is aliased `u` and clamps must address `u.`-qualified
 * columns. That is not cosmetic: the regional caller's predicate is
 * built by `scope.usageScope('u.teammate_id')`, so the alias
 * here is part of this function's contract with its callers.
 */
export async function fetchDailyMetrics(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
  clock: ServerClock,
): Promise<DailyMetric[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const settledThrough = clock.settledThrough
  const rows = await tx.execute<{
    day: string
    genuine: string
    tokens: string
    active_users: number
  }>(sql`
    WITH
    -- Grouped per (day, teammate) first, then rolled up, so active_users is the
    -- SAME population the KPI tile above this sparkline counts: a person whose
    -- day nets to $0 did not spend that day. The flat COUNT(DISTINCT teammate_id)
    -- counted anyone carrying a row, so the line and the number it sat under
    -- measured different things.
    per_person AS (
      SELECT u.day AS day,
             u.teammate_id,
             SUM(u.cost_usd) AS genuine,
             SUM(u.tokens) AS tokens
      FROM v_usage_rollup_current u
      WHERE ${scopeSql(scope)}
        AND u.day >= ${startDate}::date
        AND u.day <  ${endDate}::date
      GROUP BY 1, 2
    ),
    agg AS (
      SELECT day,
             SUM(genuine) AS genuine,
             SUM(tokens) AS tokens,
             COUNT(*) FILTER (WHERE genuine > 0) AS active_users
      FROM per_person
      GROUP BY 1
    ),
    /*
     * The axis upper bound (see the doc comment). Declared AFTER agg because a
     * non-recursive WITH item may only reference siblings defined before it --
     * and it must read agg, not the raw lane, so the frontier is computed over
     * EXACTLY the rows the series sums. GREATEST/LEAST ignore NULLs, so an empty
     * agg degrades to LEAST(endDate - 1, settledThrough) rather than NULL.
     *
     * settledThrough is a BOUND TEXT PARAMETER cast by date_in, which never
     * consults the session TimeZone -- so this frontier is clock-free in both
     * senses: no wall clock, and no timezone dependency either.
     *
     * NO BACKTICKS ANYWHERE IN THIS QUERY: a backtick inside a SQL comment ends
     * the surrounding JS template literal, and the parse error it raises points
     * at the wrong line.
     */
    frontier AS (
      SELECT LEAST(
               ${endDate}::date - 1,
               GREATEST(${settledThrough}::date, (SELECT MAX(day) FROM agg))
             ) AS last_day
    ),
    days AS (
      SELECT g.day_ts::date AS day
      FROM frontier f,
           generate_series(
             ${startDate}::timestamp,
             f.last_day::timestamp,
             INTERVAL '1 day'
           ) AS g(day_ts)
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(a.genuine, 0)::text AS genuine,
           COALESCE(a.tokens, 0)::text AS tokens,
           COALESCE(a.active_users, 0)::int AS active_users
    FROM days d LEFT JOIN agg a ON a.day = d.day
    ORDER BY d.day`)
  return [...rows].map((r) => ({
    day: r.day,
    genuineUsd: Number(r.genuine),
    tokens: Number(r.tokens),
    activeUsers: Number(r.active_users),
  }))
}
