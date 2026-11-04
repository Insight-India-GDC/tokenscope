/*
 * Consumption read-model — series, window pivots, run-rate and velocity
 * over attribution_aggregate (brief §6.4). The /me/usage and
 * /me/projects endpoints are thin consumers; NO dashboard SQL in handlers.
 *
 * NAMING. This module is the read-model behind the page now called MY USAGE
 * (`/usage`, served by `server/api/v1/me/usage.get.ts`). The module keeps the
 * name `consumption` deliberately: it is internal, no user reads it, and
 * renaming it would churn ~28 importers for no reader's benefit. "Consumption"
 * is not a word the product says out loud any more — one word, one meaning.
 *
 * Perf contract (brief §6.5): list/series/mix queries read the AGGREGATE
 * only. The single sanctioned raw-ledger exception is the per-project
 * DETAIL page (member contribution, activity mix, untagged pressure):
 * one-project-at-a-time, month-bounded, served by the (project_id,
 * ts_event) / (teammate_id, ts_event) indexes — codified in
 * tests/unit/server/consumption-perf-gate.test.ts.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { activeProjectPredicate } from '../db/project-predicates'
import { cacheStats, pivotByModel, pivotByTokenType, type BreakdownCell } from './breakdowns'
import type { CacheStats, ModelSpend, TokenTypeSpend } from '../../shared/schemas/usage'
import { classifyQuerySource } from '../../shared/usage/query-source'
import type { InsightCell } from './insights'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export type AggScope = 'teammate' | 'project'

// ── Aggregate reads ──────────────────────────────────────────────────────

export interface DaySpend {
  day: string
  cost_usd: string
  tokens: number
}

export interface ModelDaySpend {
  day: string
  model: string
  cost_usd: string
}

interface SeriesRow extends Record<string, unknown> {
  day: string
  cost_usd: string
  tokens: string
}

/** Daily spend series for a scope over the trailing window (gap days absent). */
export async function fetchDailySeries(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<DaySpend[]> {
  const rows = await tx.execute<SeriesRow>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(total_tokens)::text AS tokens
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1 ORDER BY 1
  `)
  return [...rows].map((r) => ({
    day: r.day,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
  }))
}

interface ModelSeriesRow extends Record<string, unknown> {
  day: string
  model: string
  cost_usd: string
}

/**
 * Daily per-model spend (the stacked-by-model toggle). Teammate scope only in
 * practice since 07-model-axis D7: the PROJECT page's model series moved to
 * the §A lane (`completeProjectModelSeries`, server/usage/complete-spend.ts)
 * because this aggregate is OTel-only and a tagged fill day's models never
 * reached it.
 */
export async function fetchModelSeries(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<ModelDaySpend[]> {
  const rows = await tx.execute<ModelSeriesRow>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           model,
           SUM(total_cost_usd)::text AS cost_usd
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1, model ORDER BY 1
  `)
  return [...rows].map((r) => ({
    day: r.day,
    model: r.model,
    cost_usd: Number(r.cost_usd).toFixed(2),
  }))
}

export interface WindowTotals {
  cost_usd: number
  tokens: number
  advisory_cost_usd: number
  by_model: ModelSpend[]
  by_token_type: TokenTypeSpend[]
  cache: CacheStats
  aux: {
    main_tokens: number
    aux_tokens: number
    unknown_tokens: number
    aux_cost_usd: string
    aux_share: number | null
  }
}

interface WindowRow extends Record<string, unknown> {
  model: string
  token_type: string
  query_source: string | null
  tokens: string
  cost_usd: string
  advisory_cost_usd: string
}

/**
 * One windowed pull per scope → totals + every pivot the page needs.
 * Reuses the breakdowns pivot/cache math by mapping aggregate cells into
 * BreakdownCell (the conversation axis collapses to '').
 */
export async function fetchWindowTotals(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  windowDays: number,
): Promise<WindowTotals> {
  const rows = await tx.execute<WindowRow>(sql`
    SELECT model, token_type, query_source,
           SUM(total_tokens)::text AS tokens,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(advisory_cost_usd)::text AS advisory_cost_usd
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY model, token_type, query_source
  `)
  const cells: BreakdownCell[] = []
  let cost = 0
  let tokens = 0
  let advisory = 0
  let mainTokens = 0
  let auxTokens = 0
  let unknownTokens = 0
  let auxCost = 0
  for (const r of [...rows]) {
    const c = Number(r.cost_usd)
    const t = Number(r.tokens)
    cost += c
    tokens += t
    advisory += Number(r.advisory_cost_usd)
    // Claude Code never sends the literal 'main' (our Copilot plugin does) —
    // so classify the raw wire token, never compare it
    // (shared/usage/query-source.ts). An equality test here read 100% of Claude
    // Code spend as harness overhead.
    const lane = classifyQuerySource(r.query_source)
    if (lane === 'unknown') unknownTokens += t
    else if (lane === 'main') mainTokens += t
    else {
      auxTokens += t
      auxCost += c
    }
    cells.push({
      conversation_id: '',
      model: r.model,
      token_type: r.token_type,
      tokens: t,
      cost_usd: c,
      tier2_cost_usd: Number(r.advisory_cost_usd),
      // attribution_aggregate carries no per-lane pricing fact, and nothing on
      // this path asks for one — null, never a fabricated `false`.
      lane_priced: null,
    })
  }
  // Pivots collapse the query_source axis by re-grouping in the shared helpers.
  const knownLanes = mainTokens + auxTokens
  return {
    cost_usd: cost,
    tokens,
    advisory_cost_usd: advisory,
    by_model: pivotByModel(cells),
    by_token_type: pivotByTokenType(cells),
    cache: cacheStats(cells),
    aux: {
      main_tokens: mainTokens,
      aux_tokens: auxTokens,
      unknown_tokens: unknownTokens,
      aux_cost_usd: auxCost.toFixed(2),
      aux_share: knownLanes > 0 ? Number((auxTokens / knownLanes).toFixed(4)) : null,
    },
  }
}

/** Aggregate cells in InsightCell shape (the detectors' input). */
export async function fetchInsightCellsFromWindow(
  tx: Tx,
  teammateId: string,
  windowDays = 28,
): Promise<InsightCell[]> {
  const rows = await tx.execute<WindowRow & { day: string }>(sql`
    SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
           model, token_type, query_source,
           SUM(total_tokens)::text AS tokens,
           SUM(total_cost_usd)::text AS cost_usd,
           SUM(advisory_cost_usd)::text AS advisory_cost_usd
    FROM attribution_aggregate
    WHERE scope_type = 'teammate' AND scope_id = ${teammateId}::uuid
      AND period_kind = 'day'
      AND period_start >= (now() - make_interval(days => ${windowDays}))
    GROUP BY 1, model, token_type, query_source
  `)
  return [...rows].map((r) => ({
    day: r.day,
    tool: 'claude-code',
    model: r.model,
    token_type: r.token_type,
    query_source: r.query_source,
    tokens: Number(r.tokens),
    cost_usd: Number(r.cost_usd),
  }))
}

/**
 * Advisory spend, WITH the days the rollup actually holds for the scope.
 * `usd` alone is a window total only if `materialisedDays` covers the window's
 * spending days — see {@link fetchAdvisorySpend}.
 */
export interface AdvisorySpend {
  usd: number
  /** UTC `YYYY-MM-DD` days in the window carrying at least one aggregate row. */
  materialisedDays: Set<string>
}

/**
 * Σ advisory (tier-2 / telemetry-only) spend for a scope over an EXPLICIT
 * half-open `[startIso, endIso)` window.
 *
 * Restores the project page's advisory disclosure (fix sprint D27). Two things
 * about the signature are deliberate:
 *
 *  - **Explicit bounds, not `windowDays`.** Every other read in this module says
 *    `period_start >= now() - N days`, which is the DATABASE's clock — a second
 *    definition of today (`clock-and-day-boundary.md`, and the static gate).
 *    The caller resolves the window from the request clock and passes it, so the
 *    footer's window is provably the one the chart above it drew.
 *  - **A number, not a formatted string.** Zero advisory must render NOTHING —
 *    never "$0.00", which would assert a measurement we have not made. The
 *    caller decides that, and it needs the number to decide it.
 *  - **The COVERED DAYS ride with the figure** (external review r2). Returning a
 *    bare number said "here is the window's advisory spend" whether the rollup
 *    had materialised thirty days of it or three: total absence answered `null`,
 *    but a window missing SOME days came back as a confident window total, which
 *    is the same unknown one step in. The days the aggregate actually holds a
 *    row for are returned alongside the sum so the caller can test them against
 *    the days it KNOWS carry spend and stop claiming the window when they
 *    disagree. This is a fact, not a completeness estimate: the aggregate cannot
 *    tell "the rollup has not run for this day" from "nothing was spent that
 *    day", and this function does not guess which — it reports what it holds.
 *  - **`null`, not `0`, when the aggregate has nothing to say.** `SUM` over an
 *    empty set is NULL, and the `COALESCE(…, 0)` that used to sit here spent
 *    that distinction: a scope whose rollup has not been materialised for this
 *    window (the aggregate is the ONE cron-fed lane on the project page) came
 *    back indistinguishable from a scope the rollup HAS covered and measured at
 *    zero advisory. NULL IS NOT 0 — this project's recurring defect class. The
 *    caller ships the absence through to the wire so the client can stay silent
 *    for the honest reason rather than for a fabricated one.
 *
 * POPULATION — read this before putting the number beside another figure.
 * `attribution_aggregate` carries NO identity dimension (drizzle/schema/
 * attribution.ts) and `aggregate-rollup.ts` applies no identity filter, so this
 * sum spans PROVISIONAL identities too. It is also the OTel rollup lane alone:
 * no arm-2 reconciliation, no arm-3 ingest-only, and none of `v_complete_usage`
 * arm 1's exclusions (quarantined sessions, the non-Claude-Code tool list). A
 * §A-lane figure drawn with `excludeProvisional` — which is every manager-facing
 * project figure — is therefore a DIFFERENT population, and no filter argument
 * here can close the gap: the dimension is not in the table. Callers must
 * disclose the basis rather than imply the two agree.
 */
export async function fetchAdvisorySpend(
  tx: Tx,
  scope: AggScope,
  scopeId: string,
  window: { startIso: string; endIso: string },
): Promise<AdvisorySpend | null> {
  const rows = await tx.execute<{ advisory_cost_usd: string | null; days: string[] | null }>(sql`
    SELECT SUM(advisory_cost_usd)::text AS advisory_cost_usd,
           ARRAY_AGG(DISTINCT (period_start AT TIME ZONE 'UTC')::date::text) AS days
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
      AND period_kind = 'day'
      AND period_start >= ${window.startIso}::timestamptz
      AND period_start <  ${window.endIso}::timestamptz
  `)
  const row = [...rows][0]
  if (row?.advisory_cost_usd == null) return null
  return { usd: Number(row.advisory_cost_usd), materialisedDays: new Set(row.days ?? []) }
}

// ── Velocity (project scope; the inbox velocity-watch convention) ───────

export interface VelocityState {
  current_week_usd: string
  trailing_mean_usd: string
  delta_pct: number | null
  is_flagged: boolean
}

/** Monday (UTC) of the ISO week containing `d`, as 'YYYY-MM-DD'. */
function isoWeekStartUtc(d: Date): string {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7 // Mon=0 … Sun=6
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)
  return new Date(monday).toISOString().slice(0, 10)
}

/**
 * Current ISO week (Mon UTC) vs the mean of the 4 prior weeks, from
 * aggregate day rows — flagged at `flagThreshold` above mean. Callers thread
 * the resolved 'velocity.spike_threshold' governance dial (mig 0049) in —
 * velocity-watch's bar, so the dashboard agrees with inbox alerts. Week keys
 * are DERIVED from the clock, never from "the latest week with data": a quiet
 * current week must read as $0 current spend, not as last week's spend
 * re-labelled.
 */
export async function fetchProjectVelocity(
  tx: Tx,
  projectId: string,
  flagThreshold: number,
): Promise<VelocityState> {
  const byProject = await fetchProjectVelocities(tx, [projectId], () => flagThreshold)
  return byProject.get(projectId) ?? velocityFromWeeks(new Map(), flagThreshold)
}

/**
 * {@link fetchProjectVelocity} for MANY projects in ONE round trip. The
 * threshold stays PER PROJECT (`thresholdFor` is resolved on the project's own
 * region — R1 F2, the subject's region decides the bar), so batching the query
 * must not batch the dial.
 */
export async function fetchProjectVelocities(
  tx: Tx,
  projectIds: readonly string[],
  thresholdFor: (projectId: string) => number,
): Promise<Map<string, VelocityState>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx.execute<{ project_id: string; week: string; cost_usd: string }>(sql`
    SELECT scope_id::text AS project_id,
           date_trunc('week', period_start AT TIME ZONE 'UTC')::date::text AS week,
           SUM(total_cost_usd)::text AS cost_usd
    FROM attribution_aggregate
    WHERE scope_type = 'project'
      AND scope_id = ANY(ARRAY[${sql.join(
        projectIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
      AND period_kind = 'day'
      AND period_start >= date_trunc('week', now() AT TIME ZONE 'UTC') - interval '28 days'
    GROUP BY 1, 2 ORDER BY 1, 2
  `)
  const byProject = new Map<string, Map<string, number>>()
  for (const r of [...rows]) {
    let weeks = byProject.get(r.project_id)
    if (!weeks) byProject.set(r.project_id, (weeks = new Map()))
    weeks.set(r.week, Number(r.cost_usd))
  }
  return new Map(
    projectIds.map((id) => [
      id,
      velocityFromWeeks(byProject.get(id) ?? new Map(), thresholdFor(id)),
    ]),
  )
}

/** The velocity verdict from a project's week→spend map. One definition. */
function velocityFromWeeks(byWeek: Map<string, number>, flagThreshold: number): VelocityState {
  const now = new Date()
  const current = byWeek.get(isoWeekStartUtc(now)) ?? 0
  // The 4 prior week keys, zero-filled. A project with NO prior-week rows at
  // all has no baseline → delta null, unflagged (never divide a quiet
  // project into a flag).
  const priorKeys = [1, 2, 3, 4].map((w) =>
    isoWeekStartUtc(new Date(now.getTime() - w * 7 * 86_400_000)),
  )
  const hasHistory = priorKeys.some((k) => byWeek.has(k))
  const mean = priorKeys.reduce((a, k) => a + (byWeek.get(k) ?? 0), 0) / priorKeys.length
  const delta = hasHistory && mean > 0 ? (current - mean) / mean : null
  return {
    current_week_usd: current.toFixed(2),
    trailing_mean_usd: mean.toFixed(2),
    delta_pct: delta === null ? null : Number(delta.toFixed(4)),
    is_flagged: delta !== null && delta >= flagThreshold,
  }
}

// ── Membership + project context ─────────────────────────────────────────

export interface MemberProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
  // R1 F2/F3: region of the PROJECT — governance dials are resolved by
  // the subject's region, never the viewer's.
  region_id: string
  // 'member' (current assignment) | 'cou-owner' (active cou_owner row on
  // the project's lead CC; R1 F1 — the P&L drill-through path) | 'admin'
  // (an admin in scope who is neither: the project page only, aggregates
  // only, so the no-PM fallback can reach the Manage queue).
  access: 'member' | 'cou-owner' | 'admin'
}

/**
 * The caller's CURRENT admission to project `code`, or null — the
 * project-page gate. Two admission paths in one query (R1 F1): current
 * membership, OR active ownership of the project's lead cost-owning unit
 * (the CC owner is typically 2-3 levels removed and NOT a member, and
 * their P&L view links straight here). Membership wins the access label
 * when both hold. A caller with neither is indistinguishable from a
 * missing project (the [sid] 404 posture). Ended projects stay VISIBLE
 * (post-mortem view), flagged via `ended`.
 */
export async function requireProjectMembership(
  tx: Tx,
  teammateId: string,
  code: string,
): Promise<MemberProject | null> {
  const rows = await tx.execute<MemberProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
           p.end_date::text AS end_date,
           (NOT ${activeProjectPredicate('p')}) AS ended,
           p.region_id::text AS region_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM project_assignment pa
             WHERE pa.project_id = p.id
               AND pa.teammate_id = ${teammateId}::uuid
               AND pa.effective @> now()
           ) THEN 'member' ELSE 'cou-owner' END AS access
    FROM project p
    WHERE p.code = ${code}
      AND (
        EXISTS (
          SELECT 1 FROM project_assignment pa
          WHERE pa.project_id = p.id
            AND pa.teammate_id = ${teammateId}::uuid
            AND pa.effective @> now()
        )
        OR EXISTS (
          SELECT 1 FROM cou_owner co
          WHERE co.org_unit_id = p.cost_owning_unit_id
            AND co.teammate_id = ${teammateId}::uuid
            AND co.revoked_at IS NULL
        )
      )
    LIMIT 1
  `)
  return [...rows][0] ?? null
}

/**
 * The same project row as {@link requireProjectMembership}, by code, with no
 * membership condition. The caller decides whether the viewer is an admin in
 * scope of `region_id`; this read admits nobody on its own.
 */
export async function findProjectForAdmin(tx: Tx, code: string): Promise<MemberProject | null> {
  const rows = await tx.execute<MemberProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
           p.end_date::text AS end_date,
           (NOT ${activeProjectPredicate('p')}) AS ended,
           p.region_id::text AS region_id,
           'admin' AS access
    FROM project p
    WHERE p.code = ${code}
    LIMIT 1
  `)
  return [...rows][0] ?? null
}

/** MTD project allocation (pool baseline + top-up), matching the quota model. */
export async function fetchProjectAllocation(tx: Tx, projectId: string): Promise<number> {
  const byProject = await fetchProjectAllocations(tx, [projectId])
  return byProject.get(projectId) ?? 0
}

/**
 * {@link fetchProjectAllocation} for MANY projects in ONE round trip. Same
 * predicate, same kinds — a GROUP BY over a set of ids, not N questions.
 * Absent from the map = no effective allocation; callers default to 0.
 *
 * `at` is the instant the budget is read at; omitted, SQL's now(). The budget
 * alert passes its own run clock so its cap is this figure at that instant.
 */
export async function fetchProjectAllocations(
  tx: Tx,
  projectIds: readonly string[],
  at?: string,
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx.execute<{ project_id: string; total: string }>(sql`
    SELECT scope_id::text AS project_id, COALESCE(SUM(budget_usd), 0)::text AS total
    FROM allocation
    WHERE scope_type = 'project'
      AND scope_id = ANY(ARRAY[${sql.join(
        projectIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
      AND allocation_kind IN ('baseline', 'top-up')
      -- The pool only. Per-developer caps (teammate_id set) are carve-outs of the
      -- pool, so adding them would count the same budget twice.
      AND teammate_id IS NULL
      AND effective @> ${at === undefined ? sql`now()` : sql`${at}::timestamptz`}
    GROUP BY scope_id
  `)
  return new Map([...rows].map((r) => [r.project_id, Number(r.total)]))
}

/*
 * `fetchMtdSpend` used to live here — MTD spend for a scope, from
 * `attribution_aggregate`. It is DELETED, not deprecated, on purpose.
 *
 * Every one of its callers asked it for PROJECT spend, and the aggregate is
 * OTel-emitted spend only: it has neither arm 2 (the API−OTel reconciliation
 * gap) nor arm 3, and it is refreshed by cron so it also lagged the live tables
 * rendered beside it. That made the project manager's headline structurally the
 * smallest number in the product. `completeProjectSpend`
 * (server/usage/complete-spend.ts) is the one definition now; keeping a
 * plausible-looking aggregate MTD helper in the dashboard read-model is exactly
 * how the second implementation would grow back.
 */
