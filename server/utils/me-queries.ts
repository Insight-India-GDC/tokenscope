/*
 * Shared "me"-scoped read queries.
 *
 * These pure functions are the single source of truth for the developer's
 * own usage / projects / activity-vocabulary reads. They take an explicit
 * caller identity (teammateId / regionId / role) plus a transaction handle
 * with the RLS GUCs already set, so they can be driven from EITHER:
 *
 *   - the REST endpoints (`/api/v1/me/*`, `/api/v1/projects/search`), via
 *     `withRequestRls(event, (tx) => ...)` using the cookie session; OR
 *   - the MCP tools (`/api/mcp`), via `withRlsContext(db, ctx, (tx) => ...)`
 *     using the OAuth-bearer-resolved teammate.
 *
 * Extracted from the endpoints verbatim (behaviour-preserving) so the MCP
 * surface reuses the exact same SQL — no second copy to drift. The endpoints
 * keep ownership of request parsing / response shaping; only the query bodies
 * moved here.
 */
import { sql } from 'drizzle-orm'
import { ACTIVITY_LABEL_MAX, PROJECT_NAME_MAX, cleanDisplayText } from '../../shared/schemas/display-text'
import { splitBounds, type RollupGate } from '../usage/rollup-gate'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { activeProjectPredicate, endedProjectExpr } from '../db/project-predicates'
import { oauthScopeLabel } from '../../shared/oauth-scopes'
import {
  NON_CODE_CLAUDE_TOOLS,
  toolLabel,
  type NonCodeClaudeTool,
} from '../../shared/usage/surface'
import { monthToDateWindow, monthStartIso as monthStartIsoFor } from './period'
import { activityDisplayLabel } from './activity-vocabulary'
import { baseAllowanceUsd } from './base-allowance'

type Tx = PostgresJsDatabase<Record<string, unknown>>

const ACTIVE_NOW_WINDOW_MINUTES = 30

// ── usage ────────────────────────────────────────────────────────────────

interface BucketRow extends Record<string, unknown> {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: string
  allocation_total_usd: string
  allocation_mode: string
  is_active_now: boolean
  source: 'assigned' | 'contributed' | 'both'
  ended: boolean
  /** Distinct clients (e.g. claude-code, copilot-cli) that contributed this month. */
  tools: string[] | null
}

export interface UsageBucket {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: number
  allocation_total_usd: string
  allocation_mode: string
  is_active_now: boolean
  source: 'assigned' | 'contributed' | 'both'
  ended: boolean
  /** Distinct contributing clients this month (for the per-project brand marks). */
  tools: string[]
}

export interface TaggedSpend {
  activity: string
  cost_usd: string
  tokens: number
  sessions: number
  /** Distinct contributing clients for this activity (for the brand marks). */
  tools: string[]
}

/**
 * Unallocated (no project budget) spend for the month, split FOUR ways by the
 * decision each item is in: tagged-by-activity ("spill"), genuinely-untagged
 * ("needs tagging"), dismissed ("decided: leave it unallocated", mig 0094), and
 * UNTAGGABLE (§A arm 3, mig 0101 — provider usage with no session and no
 * unaccounted_usage row to carry a tag). Accurate, month-scoped, and UNCAPPED — the
 * single source the dashboard's unallocated/tagged cards consume, replacing the
 * prior client-side composition off the LIMIT-100, all-time
 * /me/sessions/untagged list.
 *
 *   total_cost_usd = tagged_cost_usd + untagged_cost_usd + dismissed_cost_usd
 *                    + untaggable_cost_usd
 *
 * Dismissal moves spend between the middle two buckets and NEVER out of the
 * total: it is a worklist decision, not a ledger write. See
 * docs/design/needs-tagging-worklist.md.
 *
 * UNTAGGABLE is a different state from untagged, and the reporting surfaces
 * already split them on the same predicate (`usage_provenance`, see
 * server/reporting/engine/usage-coverage.ts). Only the first three buckets can
 * ever reach the needs-tagging queue, because that queue is a list of decisions
 * the developer can actually make.
 */
export interface UnallocatedSummary {
  total_cost_usd: string
  total_tokens: number
  tagged_cost_usd: string
  untagged_cost_usd: string
  needs_tagging_count: number
  /** Of needs_tagging_count: conversations. */
  needs_tagging_sessions: number
  /** Of needs_tagging_count: API-reconciled (§A) day items. */
  needs_tagging_days: number
  /** Decided-and-left-unallocated: still in total_cost_usd, out of the queue. */
  dismissed_cost_usd: string
  dismissed_count: number
  /**
   * §A arm 3 (mig 0101): provider-reported usage on a surface that carries no
   * session and no unaccounted_usage row, so there is nothing to attach a
   * project or an activity to. Inside total_cost_usd; never inside the
   * needs-tagging queue.
   *
   * NOT "no reconciled row": half of this arm is sourced FROM
   * reconciliation_record (the Copilot coding-agent lane, via
   * v_teammate_usage_daily — mig 0101:255-275). What it has no row in is
   * unaccounted_usage, which is the one that carries project_id and activity.
   */
  untaggable_cost_usd: string
  /** Of the untaggable bucket: (day, tool) items the providers reported. */
  untaggable_count: number
  soft_cap_usd: string
  over_soft_cap: boolean
}

/** One day of a non-Code surface's bill (== usage: pure-metered Anthropic). */
export interface SurfaceDaySpend {
  day: string // 'YYYY-MM-DD' (UTC); gap days are absent, charts pad
  usd: string
}

/**
 * §B display-only (#142): the requester's month-to-date spend on ONE non-Code
 * Claude surface (Chat / Cowork / Office / Chrome / Design / Slack / other),
 * from `actual_spend` — the provider bill IS the usage for pure-metered
 * Anthropic. No rate card, no attribution_record, no sessions: these lanes are
 * chargeback-only and NEVER taggable (the UI renders them read-only).
 */
export interface SurfaceSpend {
  tool: NonCodeClaudeTool
  label: string
  mtd_usd: string
  days: SurfaceDaySpend[]
}

export interface UsageSummary {
  month_to_date: string
  total_cost_usd: string
  total_tokens: number
  total_allocation_usd: string
  base_allowance_usd: string
  total_quota_usd: string
  buckets: UsageBucket[]
  unallocated: UnallocatedSummary
  tagged_spend: TaggedSpend[]
  /** Non-Code Claude surface spend (§B, read-only) — zero surfaces elided. */
  surfaces: SurfaceSpend[]
  freshness_minutes_ago: number
  note: string
}

/**
 * The developer's current-month-to-date project bucket split (cost, tokens,
 * allocation, activity) plus the additive-quota summary. Extracted from
 * GET /api/v1/me/usage — identical SQL and response shape.
 */
export async function getMyUsage(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
  gate: RollupGate | null = null,
): Promise<UsageSummary> {
  const monthStartIso = monthStartIsoFor(now)
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const monthEndIso = monthEnd.toISOString()
  const nowIso = now.toISOString()
  /*
   * TWO windows, and they are not interchangeable (server/utils/period.ts):
   *
   *   spendEndIso  — MONTH TO DATE. "What have you spent" must stop at now. The
   *     spend reads here were previously bounded BELOW only, so a row dated
   *     later this month (clock-skewed emission, a backfill) counted toward a
   *     month-to-date figure. PR #217 introduced monthToDateWindow and moved
   *     five project surfaces onto it; these developer heroes were the last
   *     unbounded callers.
   *   monthEndIso  — the CALENDAR-month bound, used ONLY for allocation
   *     overlap below. A top-up effective on the 28th is real budget for the
   *     month on the 3rd, so the cap must see the whole month even though the
   *     spend must not.
   */
  const spendEndIso = monthToDateWindow(now).endIso
  const activeCutoff = new Date(now.getTime() - ACTIVE_NOW_WINDOW_MINUTES * 60_000).toISOString()

  /*
   * The split source for the project money, on getMyUsage's OWN gate. It cannot
   * borrow the page's: that one is validated against the page window, and
   * coverage is a property of the WINDOW — this read uses month-to-date, which
   * can reach further back. Borrowing it would open the rollup for a range its
   * contract never covered, and a false open produces wrong money.
   */
  const gb = gate ? splitBounds(gate, { startIso: monthStartIso, endIso: spendEndIso }) : null
  const projectUsageSource = gate && gb
    ? sql`
        SELECT r.project_id, r.cost_usd, r.tokens, r.tool
          FROM usage_rollup_daily r
         WHERE r.teammate_id = ${teammateId}::uuid
           AND r.day >= ${gb.rollupFrom}::date
           AND r.day <= ${gb.rollupTo}::date
        UNION ALL
        SELECT u.project_id, u.cost_usd, u.tokens, u.tool
          FROM v_complete_usage u
         WHERE u.teammate_id = ${teammateId}::uuid
           AND u.ts_event >= ${gb.liveFrom}::timestamptz
           AND u.ts_event <  ${spendEndIso}::timestamptz`
    : sql`
        SELECT u.project_id, u.cost_usd, u.tokens, u.tool
          FROM v_complete_usage u
         WHERE u.teammate_id = ${teammateId}::uuid
           AND u.ts_event >= ${monthStartIso}::timestamptz
           AND u.ts_event <  ${spendEndIso}::timestamptz`

  const rows = await tx.execute<BucketRow>(
    sql`
      -- candidate projects: union of assigned-to-user AND contributed-by-user-this-month
      WITH
      /*
       * ONE scan of the seam, feeding BOTH the contributor lane and the money.
       * This query used to read v_complete_usage twice on the same teammate and
       * window: once for DISTINCT project_id, then again in the LEFT JOIN for
       * the sums. The join's project_id = p.id implies the lane's
       * project_id IS NOT NULL, so the second read was a strict SUBSET of the
       * first and one GROUP BY yields both.
       *
       * Not licensed by D2 (usage-read-path-performance.md), whose shortcut is
       * for TEXTUALLY identical predicates; these are only semantically
       * related, so the equivalence is argued above and pinned by the golden.
       */
      project_usage AS (
        SELECT p2.project_id,
               SUM(p2.cost_usd) AS cost_usd,
               SUM(p2.tokens)   AS tokens,
               array_agg(DISTINCT p2.tool ORDER BY p2.tool) AS tools
          FROM (${projectUsageSource}) p2
         WHERE p2.project_id IS NOT NULL
         GROUP BY p2.project_id
      ),
      user_project AS (
        -- ASSIGNMENT lane — gated on end_date (D5): an open assignment to an
        -- ENDED project must NOT keep a $0 bucket in "My usage" (the reported
        -- leak). Ended projects with real pre-end spend still surface via the
        -- contributor lane below (flagged ended); ended + no spend -> no row.
        SELECT pa.project_id, TRUE AS is_assigned, FALSE AS is_contributor
          FROM project_assignment pa
          JOIN project p ON p.id = pa.project_id
         WHERE pa.teammate_id = ${teammateId}::uuid
           AND pa.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
           AND ${activeProjectPredicate('p')}
        UNION ALL
        -- CONTRIBUTOR lane, through the §A seam. v_complete_usage already
        -- unions OTel-emitted spend (arm 1) with the reconciled API gap the dev
        -- tagged to a project (arm 2) and applies the quarantine exclusion, so
        -- this is one read where it used to be two hand-rolled ones. Arm 3
        -- (provider-only) carries a NULL project_id by construction and so
        -- cannot produce a bucket — which is correct, it has no project to
        -- belong to.
        SELECT pu.project_id, FALSE AS is_assigned, TRUE AS is_contributor
          FROM project_usage pu
      ),
      candidate AS (
        SELECT project_id,
               bool_or(is_assigned)    AS is_assigned,
               bool_or(is_contributor) AS is_contributor
          FROM user_project
         GROUP BY project_id
      )
      SELECT
        p.code AS project_code,
        p.display_name AS display_name,
        -- §A project cost, THROUGH THE SEAM. This was an OTel sum plus a scalar
        -- subquery over unaccounted_usage — a second, hand-rolled definition of
        -- a figure that v_complete_usage already answers. PR #217 moved five
        -- project surfaces onto that seam and left this one behind, so the
        -- homepage hero and the project page could disagree about the same
        -- project BY CONSTRUCTION (ADR 0012 decision 1).
        COALESCE(pu.cost_usd, 0)::text AS cost_usd,
        COALESCE(pu.tokens, 0)::text AS tokens,
        /*
         * The personal figure: the member's own cap in force at the reader's
         * instant; else, when a pool is in force, that pool (an uncapped member
         * draws on it); else, as before, any cap or pool overlapping the month.
         * Without the first two, a cap whose period ended mid-month would stay
         * the figure after a new period began, and an approved budget request
         * (which raises the pool in force) would move it by $0.
         */
        COALESCE(
          (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective @> ${nowIso}::timestamptz
              AND al.teammate_id = ${teammateId}::uuid),
          CASE WHEN EXISTS (
            SELECT 1 FROM allocation al
             WHERE al.scope_type = 'project'
               AND al.scope_id = p.id
               AND al.allocation_kind = 'baseline'
               AND al.teammate_id IS NULL
               AND al.effective @> ${nowIso}::timestamptz)
          THEN (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
              AND al.teammate_id IS NULL)
          END,
          (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
              AND al.teammate_id = ${teammateId}::uuid),
          (SELECT SUM(al.budget_usd)::text
             FROM allocation al
            WHERE al.scope_type = 'project'
              AND al.scope_id = p.id
              AND al.allocation_kind IN ('baseline', 'top-up')
              AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)')
              AND al.teammate_id IS NULL),
          '0'
        ) AS allocation_total_usd,
        p.allocation_mode AS allocation_mode,
        EXISTS (
          SELECT 1
            FROM attribution_record arn
           WHERE arn.teammate_id = ${teammateId}::uuid
             AND arn.project_id = p.id
             AND arn.ts_event >= ${activeCutoff}::timestamptz
             -- §A integrity: a dev-confirmed forgery must not make a project look "active".
             AND NOT EXISTS (
               SELECT 1 FROM session_quarantine sq
               WHERE sq.teammate_id = arn.teammate_id AND sq.conversation_id = COALESCE(arn.claude_session_id, arn.instance_id::text)
                 AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
        ) AS is_active_now,
        CASE
          WHEN c.is_assigned AND c.is_contributor THEN 'both'
          WHEN c.is_assigned THEN 'assigned'
          ELSE 'contributed'
        END AS source,
        -- D5: keep the bucket in the MTD aggregate (real pre-end spend), but
        -- flag it so the UI can collapse it into an "Ended" section. Dropping
        -- it would under-report the dev's month + corrupt the quota math.
        ${endedProjectExpr('p')} AS ended,
        -- Distinct contributing clients this month. The pre-aggregate already
        -- computed them per project; COALESCE covers the assigned-but-no-spend
        -- bucket, which must report [] rather than [null] — the same guarantee
        -- array_remove gave when this was aggregated here.
        COALESCE(pu.tools, ARRAY[]::text[]) AS tools
      FROM project p
      JOIN candidate c ON c.project_id = p.id
      -- The quarantine exclusion that used to be spelled out here lives INSIDE
      -- v_complete_usage (mig 0082/0101), so it cannot drift out of step with
      -- every other §A surface the way a copy would.
      -- The SAME pre-aggregate the contributor lane read. LEFT, so a project
      -- with an assignment and no spend keeps its zero bucket.
      LEFT JOIN project_usage pu ON pu.project_id = p.id
      ORDER BY p.code
    `,
  )

  let totalCost = 0
  let totalTokens = BigInt(0)
  let totalAllocation = 0
  for (const r of rows) {
    totalCost += Number(r.cost_usd)
    totalTokens += BigInt(r.tokens)
    totalAllocation += Number(r.allocation_total_usd)
  }

  // Freshness must reflect the teammate's MOST RECENT activity regardless of
  // project — INCLUDING unallocated spend (project_id IS NULL). The per-project
  // last_event_at above only sees rows joined to a candidate project, so a
  // teammate whose recent spend is all untagged (e.g. an unassigned device
  // dogfooding) would show an ever-staler "Updated X min ago" while their
  // unallocated total kept growing. Query teammate-wide, no project filter.
  // Intentionally NOT month-scoped (unlike the project buckets above): freshness
  // must reflect the teammate's latest activity regardless of month, so on the
  // 1st of a month "Updated X min ago" still shows their real last event rather
  // than snapping to "never". `freshness_minutes_ago` can therefore reference a
  // prior-month event — matches the pre-existing behaviour, not a regression.
  const freshRows = await tx.execute<{ last_event_at: string | null }>(
    sql`SELECT MAX(ts_event)::text AS last_event_at
          FROM attribution_record
         WHERE teammate_id = ${teammateId}::uuid`,
  )
  const lastEventAt = [...freshRows][0]?.last_event_at ?? null
  const lastEventMs = lastEventAt === null ? null : new Date(lastEventAt).getTime()

  // ONE global constant, read through the shared policy fn so the manager-facing
  // "over the soft cap" card (server/reporting/engine/over-soft-cap.ts) and this
  // page cannot apply different arithmetic to the same rule.
  const baseAllowance = baseAllowanceUsd()
  const totalQuotaUsd = baseAllowance + totalAllocation

  const freshnessMinutesAgo =
    lastEventMs === null ? 0 : Math.max(0, Math.round((now.getTime() - lastEventMs) / 60_000))

  // Unallocated (no project budget) spend — month-scoped + uncapped. Extracted to
  // getUnallocatedSummary so it's the single source for the dashboard cards + CLI.
  const { unallocated, tagged_spend } = await getUnallocatedSummary(
    tx,
    teammateId,
    monthStartIso,
    baseAllowance,
    spendEndIso,
  )

  // §B (#142) — the requester's non-Code Claude surface spend, MTD, per day,
  // straight from actual_spend (bill == usage on the pure-metered Anthropic
  // lane). Filter derives from NON_CODE_CLAUDE_TOOLS — never hand-copied
  // literals — so a new surface lane lands here without touching this query.
  const surfaces = await getMySurfaceSpend(tx, teammateId, monthStartIso, monthEndIso)

  return {
    month_to_date: monthStartIso.slice(0, 7),
    total_cost_usd: totalCost.toFixed(2),
    total_tokens: Number(totalTokens),
    total_allocation_usd: totalAllocation.toFixed(2),
    base_allowance_usd: baseAllowance.toFixed(2),
    total_quota_usd: totalQuotaUsd.toFixed(2),
    buckets: [...rows].map((r) => ({
      project_code: r.project_code,
      // Reaches every member's agent (MCP my_usage): bounded on the way out for
      // rows written before mig 0155's NOT VALID constraints.
      display_name: r.display_name == null ? r.display_name : cleanDisplayText(r.display_name, PROJECT_NAME_MAX),
      cost_usd: Number(r.cost_usd).toFixed(2),
      tokens: Number(r.tokens),
      allocation_total_usd: Number(r.allocation_total_usd).toFixed(2),
      allocation_mode: r.allocation_mode,
      is_active_now: r.is_active_now,
      source: r.source,
      ended: r.ended,
      tools: Array.isArray(r.tools) ? r.tools : [],
    })),
    unallocated,
    tagged_spend,
    surfaces,
    freshness_minutes_ago: freshnessMinutesAgo,
    note:
      [...rows].length === 0
        ? 'No project assignments yet — ask your admin to assign you.'
        : 'Updated from attribution_record (Epic 6 OTel read path).',
  }
}

/**
 * Unallocated (no project budget) spend for the month, split tagged-by-activity
 * ("spill") vs genuinely-untagged ("needs tagging") vs untaggable (§A arm 3).
 * Aggregates per CONVERSATION first (MAX(activity), matching the untagged
 * worklist's session semantics), then rolls up by activity. Month-scoped +
 * UNCAPPED — the accurate single source the dashboard's unallocated/tagged cards
 * AND the usage MCP prompt both consume (replacing the prior client-side
 * composition off the LIMIT-100, all-time /me/sessions/untagged list). Exported
 * so the MCP surface can reuse it.
 *
 * ALL THREE §A completeness arms are counted (ADR 0012 decision 1a — "your
 * usage" means all of it). Arms 1 and 2 are read from their own tables because
 * this function needs the worklist identity the seam does not expose (the
 * conversation key, the activity, the dismissal); arm 3 is read THROUGH
 * `v_complete_usage`, whose `usage_provenance = 'provider-usage'` selects
 * exactly that arm — the same predicate the reporting coverage decomposition
 * splits on (server/reporting/engine/usage-coverage.ts).
 */
export async function getUnallocatedSummary(
  tx: Tx,
  teammateId: string,
  monthStartIso: string,
  /**
   * The soft cap this summary's `over_soft_cap` is decided against. Passed in
   * rather than read here so ONE call resolves the policy per request — and named
   * `baseAllowance` so it cannot shadow the `baseAllowanceUsd()` policy fn that
   * produced it (server/utils/base-allowance.ts).
   */
  baseAllowance: number,
  /*
   * The EXCLUSIVE upper bound, as an instant. Required, not optional: both arms
   * below were bounded BELOW only, so a projectless emission or an
   * unaccounted_usage day dated later this month counted toward a month-to-date
   * figure. The bucket path in getMyUsage was fixed for exactly this and these
   * two adjacent queries were missed — a default here would let the next caller
   * inherit the same hole silently.
   *
   * EXCLUSIVE, for every caller and every arm (r4-M2). The month-to-date callers
   * pass `now`; `/me/usage` passes the RESOLVED window's own exclusive end
   * (`clampedEnd`), which for a past month is the next month's 00:00Z. The day
   * arm below used to compare `uu.day <= spendEndIso::date`, which is
   * month-to-date-correct for the first shape (today's own row survives) and
   * WRONG for the second: `2026-08-01T00:00:00Z::date` admitted a fill row dated
   * 2026-08-01 into a July window, so the four-way split could exceed the
   * `untagged_usd` it must foot to.
   */
  spendEndIso: string,
): Promise<{ unallocated: UnallocatedSummary; tagged_spend: TaggedSpend[] }> {
  /*
   * The last DAY the exclusive instant bound admits — the day containing the
   * final instant strictly before `spendEndIso`. Derived here, in UTC, rather
   * than in SQL: `::date` on a timestamptz resolves in the session's TimeZone,
   * and `uu.day` is a UTC calendar day.
   *
   *   now  = 2026-08-05T14:23Z   → 2026-08-05  (today's own fill row survives)
   *   July = 2026-08-01T00:00Z   → 2026-07-31  (August's first day is outside)
   *
   * Both callers stay correct off ONE bound, which is why this is derived from
   * the shared argument rather than converted at each call site.
   */
  const lastDayInclusive = new Date(Date.parse(spendEndIso) - 1).toISOString().slice(0, 10)
  const unallocRows = await tx.execute<{
    activity: string | null
    kind: 'session' | 'day' | 'provider'
    dismissed: boolean
    cost_usd: string
    tokens: string
    sessions: string
    tools: string[] | null
  }>(
    sql`
      WITH conv AS (
        SELECT COALESCE(ar.claude_session_id, ar.instance_id::text) AS conv,
               MAX(ar.activity) AS activity,
               MAX(ar.tool)     AS tool,
               SUM(ar.cost_usd) AS cost,
               SUM(ar.tokens)   AS tokens
          FROM attribution_record ar
         WHERE ar.teammate_id = ${teammateId}::uuid
           AND ar.project_id IS NULL
           AND ar.ts_event >= ${monthStartIso}::timestamptz
           AND ar.ts_event <  ${spendEndIso}::timestamptz
           -- §A integrity: a conversation the dev CONFIRMED as a forgery (over-emission
           -- → session_quarantine reason='api-uncorroborated') is excluded from usage.
           AND NOT EXISTS (
             SELECT 1 FROM session_quarantine sq
             WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = COALESCE(ar.claude_session_id, ar.instance_id::text)
               AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
         GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text)
      ),
      -- Each item carries the DECISION it is in: which kind of item it is, and
      -- whether the teammate has dismissed it (mig 0094 — decided to leave it
      -- unallocated). Dismissal never removes an item from this union: it moves
      -- it between the untagged and dismissed buckets below, and the unallocated
      -- TOTAL is unchanged either way.
      unalloc AS (
        SELECT c.conv, c.activity, c.tool, c.cost, c.tokens,
               'session'::text AS kind,
               EXISTS (
                 SELECT 1 FROM session_assignment sa
                  WHERE sa.teammate_id = ${teammateId}::uuid
                    AND sa.claude_session_id = c.conv
                    AND sa.dismissed_at IS NOT NULL
               ) AS dismissed
          FROM conv c
        -- §A: per-day "unaccounted usage" (provider API truth OTel missed) is also
        -- unallocated spend that needs tagging — one item per (day, tool), counted
        -- like a conversation so the dashboard's needs-tagging total includes it.
        UNION ALL
        SELECT 'unaccounted:' || uu.id::text AS conv,
               uu.activity,
               uu.tool,
               uu.cost_usd AS cost,
               uu.tokens   AS tokens,
               'day'::text AS kind,
               uu.dismissed_at IS NOT NULL AS dismissed
          FROM unaccounted_usage uu
         WHERE uu.teammate_id = ${teammateId}::uuid
           AND uu.project_id IS NULL
           AND uu.cost_usd > 0
           AND uu.day >= ${monthStartIso}::date
           -- day-grained lane: the last day the EXCLUSIVE instant bound admits
           -- (see lastDayInclusive above) — a bare "<= spendEndIso::date" would
           -- let the first day OUTSIDE a resolved window in.
           AND uu.day <= ${lastDayInclusive}::date
        -- §A arm 3 (mig 0101), through the seam. Genuine provider usage on a
        -- surface that can never be OTel-emitted or reconciled into a taggable
        -- row (the non-Code Claude surfaces, the Copilot coding-agent lane). It
        -- carries project_id NULL BY CONSTRUCTION, so it IS unallocated spend and
        -- belongs in this total (ADR 0012 decision 1a) — omitting it left the
        -- /consumption headline short of the same dollars the reporting surfaces
        -- already count. It is UNTAGGABLE, not untagged: there is no session and
        -- no unaccounted_usage row to attach a project or an activity to, so its
        -- own kind below keeps it out of the needs-tagging queue rather than
        -- landing it in a queue the developer cannot action. (Half of this arm IS
        -- sourced from reconciliation_record — the Copilot coding-agent lane, via
        -- v_teammate_usage_daily — so "no reconciled row" would be false; what it
        -- has no row in is unaccounted_usage, which is the taggable one.) One item
        -- per (day, tool) — the grain v_teammate_usage_daily already aggregates to.
        UNION ALL
        -- ONE item per (day, tool) — the KEY grain, not the view-row grain
        -- (design 07-model-axis-subtraction-build.md r1-H4). Mig 0124 fans a
        -- provider day out into per-model rows plus a remainder, so counting
        -- view rows here would inflate untaggable_count with model
        -- cardinality. The GROUP BY folds each key back to one item (the
        -- DISTINCT (teammate, day, tool) count — teammate is already clamped),
        -- and the SUMs keep the dollars/tokens identical to the pre-fan-out
        -- single row because Σ per key is invariant by construction (0124).
        -- The key filter is HAVING SUM(cost) > 0, not per-row cost > 0: a
        -- token-only fan-out row must not drop its tokens from a key whose
        -- money is on its sibling rows.
        SELECT 'provider:' || u.tool || ':' || u.ts_event::date::text AS conv,
               NULL::text AS activity,
               u.tool,
               SUM(u.cost_usd) AS cost,
               SUM(u.tokens)   AS tokens,
               'provider'::text AS kind,
               FALSE AS dismissed
          FROM v_complete_usage u
         WHERE u.teammate_id = ${teammateId}::uuid
           AND u.project_id IS NULL
           AND u.usage_provenance = 'provider-usage'
           AND u.ts_event >= ${monthStartIso}::timestamptz
           -- The SAME exclusive instant bound as both arms above. Arm 3's
           -- ts_event is the DAY at 00:00Z (mig 0101:268 casts
           -- v_teammate_usage_daily.day), so an exclusive bound on the instant
           -- admits today's own row under a month-to-date "now" and excludes the
           -- first day outside a resolved window — the two shapes the arm-2
           -- sibling reaches through lastDayInclusive.
           AND u.ts_event <  ${spendEndIso}::timestamptz
         GROUP BY u.tool, u.ts_event::date
        HAVING SUM(u.cost_usd) > 0
      )
      SELECT activity,
             kind,
             dismissed,
             SUM(cost)::text   AS cost_usd,
             SUM(tokens)::text AS tokens,
             COUNT(*)::text    AS sessions,
             array_remove(array_agg(DISTINCT tool ORDER BY tool), NULL) AS tools
        FROM unalloc
       GROUP BY activity, kind, dismissed
    `,
  )

  let unallocCost = 0
  let unallocTokens = BigInt(0)
  let taggedCost = 0
  let untaggedCost = 0
  let dismissedCost = 0
  let untaggableCost = 0
  let untaggableCount = 0
  let needsTaggingSessions = 0
  let needsTaggingDays = 0
  let dismissedCount = 0
  // The grain is now (activity, kind, dismissed), so one activity can arrive as
  // several rows — accumulate per activity rather than pushing per row, or the
  // spill card would show "Research" twice.
  const byActivity = new Map<
    string,
    { cost: number; tokens: bigint; sessions: number; tools: Set<string> }
  >()
  for (const r of unallocRows) {
    const cost = Number(r.cost_usd)
    const items = Number(r.sessions)
    unallocCost += cost
    unallocTokens += BigInt(r.tokens)
    if (r.kind === 'provider') {
      // §A arm 3. Real unallocated usage, so it stays in the total above — but
      // it is untaggable BY CONSTRUCTION (mig 0101), which is a different state
      // from untagged. Routing it to `untaggedCost` would put spend the
      // developer has no way to act on into a queue of actions they owe.
      untaggableCost += cost
      untaggableCount += items
      continue
    }
    if (r.activity === null || r.activity === '') {
      // No activity — the item is either awaiting a decision, or the teammate
      // has made one: "leave it unallocated". Both stay in the unallocated
      // total; only one of them is work the developer still owes.
      if (r.dismissed) {
        dismissedCost += cost
        dismissedCount += items
      } else {
        untaggedCost += cost
        if (r.kind === 'day') needsTaggingDays += items
        else needsTaggingSessions += items
      }
    } else {
      taggedCost += cost
      // Reaches the agent (MCP my_usage tagged_spend): clean before keying, so a
      // legacy control-bearing label is bounded and labels that clean to the same
      // text merge their totals.
      const label = cleanDisplayText(r.activity, ACTIVITY_LABEL_MAX) || '(unlabelled)'
      const acc = byActivity.get(label) ?? { cost: 0, tokens: BigInt(0), sessions: 0, tools: new Set<string>() }
      acc.cost += cost
      acc.tokens += BigInt(r.tokens)
      acc.sessions += items
      for (const t of Array.isArray(r.tools) ? r.tools : []) acc.tools.add(t)
      byActivity.set(label, acc)
    }
  }
  const taggedSpend: TaggedSpend[] = [...byActivity.entries()]
    .map(([activity, a]) => ({
      activity,
      cost_usd: a.cost.toFixed(2),
      tokens: Number(a.tokens),
      sessions: a.sessions,
      tools: [...a.tools].sort(),
    }))
    .sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd))

  return {
    unallocated: {
      total_cost_usd: unallocCost.toFixed(2),
      total_tokens: Number(unallocTokens),
      tagged_cost_usd: taggedCost.toFixed(2),
      untagged_cost_usd: untaggedCost.toFixed(2),
      needs_tagging_count: needsTaggingSessions + needsTaggingDays,
      needs_tagging_sessions: needsTaggingSessions,
      needs_tagging_days: needsTaggingDays,
      dismissed_cost_usd: dismissedCost.toFixed(2),
      dismissed_count: dismissedCount,
      untaggable_cost_usd: untaggableCost.toFixed(2),
      untaggable_count: untaggableCount,
      soft_cap_usd: baseAllowance.toFixed(2),
      // >= (not >) to match the dashboard's "Over" badge threshold (>= 100% of base).
      // The manager-facing card applies the SAME comparison
      // (server/reporting/engine/over-soft-cap.ts) — a `>` there would list a
      // developer as within allowance whose own page badges them Over.
      over_soft_cap: unallocCost >= baseAllowance,
    },
    tagged_spend: taggedSpend,
  }
}

// ── non-Code Claude surfaces (§B display, #142) ────────────────────────────

/**
 * The REQUESTING teammate's month-to-date spend on the non-Code Claude
 * surfaces, per surface per day, from `actual_spend`. §B display ONLY: for
 * pure-metered Anthropic the per-(user, day) bill IS the usage, so no rate
 * card and no attribution_record are involved, and there is nothing to tag —
 * these lanes are source-incapable of sessions (excluded from §A by mig 0084).
 * Surfaces with zero MTD spend are elided; order follows the canonical
 * NON_CODE_CLAUDE_TOOLS display order.
 */
export async function getMySurfaceSpend(
  tx: Tx,
  teammateId: string,
  monthStartIso: string,
  monthEndIso: string,
): Promise<SurfaceSpend[]> {
  const laneList = sql.join(
    NON_CODE_CLAUDE_TOOLS.map((t) => sql`${t}`),
    sql.raw(', '),
  )
  const rows = await tx.execute<{ tool: string; day: string; usd: string }>(sql`
    SELECT a.tool, a.date::text AS day, SUM(a.cost_usd)::text AS usd
      FROM actual_spend a
     WHERE a.teammate_id = ${teammateId}::uuid
       AND a.date >= ${monthStartIso.slice(0, 10)}::date
       AND a.date <  ${monthEndIso.slice(0, 10)}::date
       AND a.tool IN (${laneList})
     GROUP BY a.tool, a.date
     ORDER BY a.tool, a.date
  `)
  const byTool = new Map<string, SurfaceDaySpend[]>()
  for (const r of rows) {
    const days = byTool.get(r.tool) ?? []
    days.push({ day: r.day, usd: Number(r.usd).toFixed(2) })
    byTool.set(r.tool, days)
  }
  const out: SurfaceSpend[] = []
  for (const tool of NON_CODE_CLAUDE_TOOLS) {
    const days = byTool.get(tool)
    if (!days) continue
    const mtd = days.reduce((acc, d) => acc + Number(d.usd), 0)
    if (mtd <= 0) continue // elide zero surfaces
    out.push({ tool, label: toolLabel(tool), mtd_usd: mtd.toFixed(2), days })
  }
  return out
}

// ── provider-truth MTD (visuals-iter2 §I3 "one honest number") ──────────────

/**
 * The requester's provider-truth month-to-date spend — the SAME per-user
 * source /me/usage's §A reconciliation reads: Σ v_teammate_usage_daily
 * (claude-code + every non-Code Claude surface from actual_spend, PLUS the
 * Copilot reconciliation usage the view lanes in — mig 0086 keeps the two
 * arms double-count-free by construction). No attribution math anywhere:
 * this is what the providers say the user consumed.
 *
 * A4 (mig 0101): this used to ALSO add Σ actual_spend over the non-Code Claude
 * surfaces as a second operand, because migration 0084 had excluded those
 * surfaces from v_teammate_usage_daily. Migration 0101 (A1) restored them to
 * the view, which made that second operand a DUPLICATE — doubling every
 * non-Code dollar on this "one honest number" surface (R1-H7). The operand is
 * removed; v_teammate_usage_daily alone is now the complete provider-truth
 * source. Pinned by a mixed-surface conservation test
 * (tests/integration/me/consumption-hero.test.ts).
 */
export async function getMyProviderTruthMtd(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
): Promise<string> {
  const monthStart = monthStartIsoFor(now).slice(0, 10)
  /*
   * MONTH TO DATE, bounded at BOTH ends. `day >= monthStart` alone let a
   * future-dated reconciliation row — including one in a LATER month — into
   * today's provider total, and this figure feeds the materiality decision
   * behind the declared-personal disclosure, so a stray row moved a
   * user-facing claim as well as a number.
   *
   * `day <= today` rather than `< now`: this lane is DAY-grained (a bill day is
   * the whole day), so an exclusive instant bound would drop today's own row.
   */
  const today = new Date(now.getTime()).toISOString().slice(0, 10)
  const rows = await tx.execute<{ usd: string }>(sql`
    SELECT COALESCE((
      SELECT SUM(usage_usd) FROM v_teammate_usage_daily
      WHERE teammate_id = ${teammateId}::uuid
        AND day >= ${monthStart}::date
        AND day <= ${today}::date
    ), 0)::text AS usd
  `)
  return Number([...rows][0]?.usd ?? 0).toFixed(2)
}

/**
 * Minutes since the requester's provider feeds last landed anything — the
 * STALEST of actual_spend (Anthropic analytics poll, `pulled_at`) and
 * reconciliation_record (GitHub usage engine, `computed_at`). LEAST (not
 * GREATEST — iter2 review r1): the leg feeds the page's "as fresh as its
 * stalest source" worst-of line, so the OLDEST sub-feed timestamp (= most
 * minutes ago) must win — a fresh GitHub pull must never hide a 3-day-old
 * Anthropic pull. Postgres LEAST/GREATEST skip NULL operands (SQL-standard
 * deviation): one feed absent → the other's timestamp; both absent → NULL
 * (this function returns null — no feed has landed anything yet).
 */
export async function getMyProviderFeedFreshness(
  tx: Tx,
  teammateId: string,
): Promise<number | null> {
  const rows = await tx.execute<{ minutes: string | null }>(sql`
    SELECT FLOOR(EXTRACT(EPOCH FROM (now() - LEAST(
      (SELECT MAX(pulled_at) FROM actual_spend WHERE teammate_id = ${teammateId}::uuid),
      (SELECT MAX(computed_at) FROM reconciliation_record
        WHERE teammate_id = ${teammateId}::uuid AND provider = 'github')
    ))) / 60)::text AS minutes
  `)
  const m = [...rows][0]?.minutes
  return m == null ? null : Math.max(0, Number(m))
}

// ── my projects (memberships) ──────────────────────────────────────────────

export interface MyProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  /** Budget type — billable / pursuit / internal (so the UI reads as a typed budget, not just "project"). */
  type: string
}

/**
 * The projects the caller is a CURRENT member of (active assignment). These are
 * the projects a teammate can attribute spend to. Extracted from
 * GET /api/v1/me/projects.
 */
export async function getMyProjects(tx: Tx, teammateId: string): Promise<MyProject[]> {
  const rows = await tx.execute<MyProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type
    FROM project p
    JOIN project_assignment pa ON pa.project_id = p.id
    WHERE pa.teammate_id = ${teammateId}::uuid AND pa.effective @> now()
      -- Exclude ENDED projects from tag-eligibility — don't route new work onto
      -- a dead project (D2 spill is the backstop if any slips through).
      AND ${activeProjectPredicate('p')}
    ORDER BY p.code
  `)
  // display_name reaches every member's agent (MCP list_my_projects); bound it on
  // the way out too, for rows written before mig 0155's NOT VALID constraints.
  return [...rows].map((r) => ({ ...r, display_name: cleanDisplayText(r.display_name, PROJECT_NAME_MAX) }))
}

// ── resolve a repo's .tokenscope code → a member budget ─────────────────────

export interface ResolvedRepoProject extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  /** Budget type — billable / pursuit / internal. */
  type: string
}

/**
 * Resolve a repo's `.tokenscope` reference — given a project **code** OR a
 * **code_hash** (never a filesystem path: the server must not persist any repo
 * path or cwd, per the design doc's privacy note) — to a project the caller is a
 * CURRENT member of. Returns the project metadata on a match, or `null` when the
 * ref doesn't resolve to a member budget (unknown code, or a real project the
 * caller is not assigned to — both collapse to "not yours", no existence oracle).
 *
 * Membership-gated exactly like getMyProjects (active assignment, active
 * project), so the `/tokenscope-project` and `/tokenscope-tag` skills can confirm
 * a repo's `.tokenscope` code maps to a real budget before they act on it.
 * Exactly one of `code` / `codeHash` is matched; `codeHash` wins if both given.
 */
export async function resolveRepoProject(
  tx: Tx,
  teammateId: string,
  ref: { code?: string; codeHash?: string },
): Promise<ResolvedRepoProject | null> {
  // Neither ref → nothing to resolve. Guard here too (not only at the MCP tool)
  // so a bare process call can't build `p.code = NULL` (which matches nothing,
  // but make the contract explicit rather than relying on SQL NULL semantics).
  if (!ref.codeHash && !ref.code) return null
  // Match on code_hash when supplied, else on code. The caller passes one; this
  // is a code-constant choice, not user-controlled SQL structure. The VALUE is
  // parameter-bound (drizzle `sql` interpolation), never raw-concatenated.
  const matchPredicate = ref.codeHash
    ? sql`p.code_hash = ${ref.codeHash}`
    : sql`p.code = ${ref.code}`

  const rows = await tx.execute<ResolvedRepoProject>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.type
    FROM project p
    JOIN project_assignment pa ON pa.project_id = p.id
    WHERE pa.teammate_id = ${teammateId}::uuid AND pa.effective @> now()
      AND ${matchPredicate}
      -- Same active-project gate as getMyProjects: don't resolve a dead budget.
      AND ${activeProjectPredicate('p')}
    LIMIT 1
  `)
  const row = [...rows][0]
  // Returned by the MCP resolve_repo_project tool: bounded like getMyProjects.
  return row ? { ...row, display_name: cleanDisplayText(row.display_name, PROJECT_NAME_MAX) } : null
}

// ── activity types ─────────────────────────────────────────────────────────

export interface ActivityType {
  label: string
  is_standard: boolean
  /** True if the CALLER has used this activity before (their own tag). */
  is_mine: boolean
}

/**
 * The activity-tag suggestion list, ordered for the human doing the tagging:
 *   1. the caller's OWN previously-used activities (most-used first, in THEIR
 *      casing) — the ones they actually reach for;
 *   2. then the hybrid standard / region vocabulary (title-cased for display —
 *      the seed is lowercase), deduped case-insensitively against (1).
 *
 * The case-insensitive dedup means a caller who has used 'Research' sees only
 * their 'Research', not a second standard 'research' — so capitalising the
 * standard set never splits their own tagged-spend buckets. Suggestion source,
 * NOT an allow-list (the stored value stays free-form). Used by both
 * GET /api/v1/me/activity-types and the MCP `list_activity_types` tool.
 */
export async function getActivityTypes(
  tx: Tx,
  regionId: string,
  teammateId: string,
): Promise<ActivityType[]> {
  // (1) the caller's own activities, most-used first; (2) the standard / region
  // vocabulary. Concurrent issuance on ONE tx connection: postgres-js pipelines
  // and answers in order — no per-query await gaps (fully one wave on
  // prepared statements), no cross-dependencies
  // (docs/design/request-floor-performance.md F5).
  const [mineRows, stdRows] = await Promise.all([
    tx.execute<{ label: string }>(sql`
    SELECT activity AS label
      FROM session_assignment
     WHERE teammate_id = ${teammateId}::uuid
       AND activity IS NOT NULL
       AND btrim(activity) <> ''
     GROUP BY activity
     ORDER BY COUNT(*) DESC, lower(activity)
  `),
    tx.execute<{ label: string; is_standard: boolean }>(sql`
    SELECT label, is_standard
      FROM activity_type
     WHERE is_active = TRUE
       AND (region_id IS NULL OR region_id = ${regionId}::uuid)
     ORDER BY sort_order, lower(label)
  `),
  ])
  const stdByLower = new Map([...stdRows].map((r) => [r.label.toLowerCase(), r]))

  const seen = new Set<string>()
  const out: ActivityType[] = []
  // Both sources reach the agent (MCP list_activity_types): the caller's own
  // free-form tags (session_assignment.activity, which predate any input bound)
  // and the admin vocabulary. Clean both before de-duplicating; drop what
  // cleans to nothing.
  for (const raw of mineRows) {
    const r = { label: cleanDisplayText(raw.label, ACTIVITY_LABEL_MAX) }
    if (!r.label) continue
    const key = r.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: r.label, is_standard: stdByLower.has(key), is_mine: true })
  }
  for (const r of stdRows) {
    // Admin-authored and shown to every member's agent: bounded on the way out
    // (rows before mig 0155 are not covered by its NOT VALID constraint).
    const display = cleanDisplayText(activityDisplayLabel(r.label), ACTIVITY_LABEL_MAX)
    if (!display) continue
    const key = display.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: display, is_standard: r.is_standard, is_mine: false })
  }
  return out
}

// ── quarantined (heartbeat-uncovered) spend ─────────────────────────────────

export interface QuarantinedSession extends Record<string, unknown> {
  session_id: string
  instance_id: string
  cost_usd: string
  tokens: number
  session_ts_start: string
  session_ts_end: string
  last_bearer_at: string | null
  reason: string
  detected_at: string
}

/**
 * The caller's OPEN quarantined sessions — spend claiming an instance whose
 * authenticated heartbeat ([ts_start, last_bearer_at + grace]) does NOT span the
 * session's [min,max] ts_event. Surfaced as "unverified spend" pending
 * reconciliation. This is the cross-instance-spoof signal (a spoofer can't mint a
 * /bearer for a victim's instance, so there's no covering heartbeat); it does NOT
 * catch full credential theft (the thief owns the instance, so it heartbeats as
 * the victim). INFORMATIONAL — reconciliation, not this read, decides truth.
 *
 * Reads the worker-maintained session_quarantine table. teammate_id is filtered
 * explicitly (defense in depth) AND the table is RLS teammate-scoped, so a caller
 * only ever sees their own rows — exactly like the other /me reads.
 */
export async function getMyQuarantinedSpend(
  tx: Tx,
  teammateId: string,
): Promise<QuarantinedSession[]> {
  const rows = await tx.execute<QuarantinedSession>(sql`
    SELECT
      sq.conversation_id                       AS session_id,
      sq.instance_id::text                     AS instance_id,
      sq.cost_usd::text                        AS cost_usd,
      sq.tokens::text                          AS tokens,
      sq.session_ts_start::text                AS session_ts_start,
      sq.session_ts_end::text                  AS session_ts_end,
      sq.last_bearer_at::text                  AS last_bearer_at,
      sq.reason                                AS reason,
      sq.detected_at::text                     AS detected_at
    FROM session_quarantine sq
    WHERE sq.teammate_id = ${teammateId}::uuid
      AND sq.resolved_at IS NULL
    ORDER BY sq.session_ts_end DESC
  `)
  return [...rows].map((r) => ({
    session_id: r.session_id,
    instance_id: r.instance_id,
    cost_usd: Number(r.cost_usd).toFixed(2),
    tokens: Number(r.tokens),
    session_ts_start: r.session_ts_start,
    session_ts_end: r.session_ts_end,
    last_bearer_at: r.last_bearer_at,
    reason: r.reason,
    detected_at: r.detected_at,
  }))
}

// ── oauth grants (authorized connections) ───────────────────────────────────

/** Grant lifecycle state — derived, never stored (design doc §Grant lifecycle). */
export type GrantState = 'active' | 'inactive' | 'revoked' | 'expired'

/** Window (days) past which a grant with no fresh use reads "inactive" (informational, never auto-revoked). */
export const GRANT_INACTIVE_DAYS = 14

/**
 * Plain-language scope label for the account / admin grant review UIs. Re-exports
 * the SHARED source (shared/oauth-scopes.ts) that the consent page also uses — so
 * a user reads the same words at grant time and at review time (no drift).
 */
export const grantScopeLabel = oauthScopeLabel

export interface Grant extends Record<string, unknown> {
  id: string
  /**
   * The oauth_client row's OWN id (S6 Attestation fix) — distinct from `id`
   * above (the grant/oauth_token row). Rendered beside client_name so a
   * forged/self-registered name never stands alone as the client's identity.
   */
  client_id: string
  client_name: string
  /** When the CLIENT itself was registered (S6 Attestation fix) — distinguishes a long-established app from one self-registered moments ago. */
  client_registered_at: string
  /** Space-delimited scopes split into the granted list. */
  scopes: string[]
  /** Plain-language label per scope, index-aligned with `scopes`. */
  scope_labels: string[]
  state: GrantState
  /** Stable per-row issuance instant — the grant's creation anchor. */
  created_at: string
  last_used_at: string | null
  /** True when the grant carries the emit scope (revoke cascades to the instance). */
  is_emit: boolean
}

interface GrantRow extends Record<string, unknown> {
  id: string
  client_id: string
  client_name: string
  client_registered_at: string
  scope: string
  state: GrantState
  created_at: string
  last_used_at: string | null
}

/**
 * Derived grant state, computed in SQL so the list and any future review UIs
 * agree on one truth table.
 *
 * `oauth_token` has NO `created_at` column (verified: migrations 0023/0030). The
 * STABLE per-row issuance anchor is `refresh_issued_at` (set once at issuance,
 * never bumped — unlike `access_issued_at`, which the non-rotating refresh bumps
 * every cycle). So the creation anchor and the active/inactive base both use
 * `COALESCE(last_used_at, refresh_issued_at)`.
 *
 * Precedence (terminal states win): revoked > expired > active/inactive. A
 * revoked grant reads "revoked" regardless of how recently it was used; an
 * expired-but-not-revoked grant reads "expired". A fresh grant (never used) is
 * active because `refresh_issued_at` is `now()` at issuance.
 */
function grantStateExpr() {
  return sql`
    CASE
      WHEN t.revoked_at IS NOT NULL THEN 'revoked'
      WHEN t.refresh_expires_at < now() THEN 'expired'
      WHEN COALESCE(t.last_used_at, t.refresh_issued_at)
             >= now() - (${GRANT_INACTIVE_DAYS}::text || ' days')::interval THEN 'active'
      ELSE 'inactive'
    END
  `
}

function projectGrant(r: GrantRow): Grant {
  const scopes = r.scope ? r.scope.split(' ').filter(Boolean) : []
  return {
    id: r.id,
    client_id: r.client_id,
    client_name: r.client_name,
    client_registered_at: r.client_registered_at,
    scopes,
    scope_labels: scopes.map(grantScopeLabel),
    state: r.state,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    is_emit: scopes.includes('tokenscope.emit'),
  }
}

/**
 * The caller's OWN authorized connections (oauth_token rows), joined to the
 * client name, with the derived lifecycle state. Owner-scoped by an explicit
 * `teammate_id` predicate — `oauth_token` has no RLS policy and the owner DB
 * connection makes RLS inert anyway, so this predicate IS the live gate (the
 * instance-list pattern). Multiple grants per user are expected (N machines /
 * re-enrol / reconnect) — disambiguated by created_at + last_used_at.
 */
export async function getMyGrants(tx: Tx, teammateId: string): Promise<Grant[]> {
  const rows = await tx.execute<GrantRow>(sql`
    SELECT
      t.id::text                AS id,
      c.client_id::text         AS client_id,
      c.client_name             AS client_name,
      c.created_at::text        AS client_registered_at,
      t.scope                   AS scope,
      ${grantStateExpr()}       AS state,
      t.refresh_issued_at::text AS created_at,
      t.last_used_at::text      AS last_used_at
    FROM oauth_token t
    JOIN oauth_client c ON c.client_id = t.client_id
    WHERE t.teammate_id = ${teammateId}::uuid
    ORDER BY COALESCE(t.last_used_at, t.refresh_issued_at) DESC, t.refresh_issued_at DESC
  `)
  return [...rows].map(projectGrant)
}

/**
 * Admin variant — a single teammate's grants, with the owning teammate's
 * identity carried on each row for the admin table. Region scoping is enforced
 * by the CALLER (the admin endpoint resolves the teammate's region_id and runs
 * requireRegionScope before calling this) — `oauth_token` has no region of its
 * own, so the join to teammate is where region lives.
 */
export interface AdminGrant extends Grant {
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
}

export async function getGrantsForTeammate(tx: Tx, teammateId: string): Promise<AdminGrant[]> {
  const rows = await tx.execute<
    GrantRow & { teammate_id: string; teammate_email: string; teammate_display_name: string | null }
  >(sql`
    SELECT
      t.id::text                AS id,
      c.client_id::text         AS client_id,
      c.client_name             AS client_name,
      c.created_at::text        AS client_registered_at,
      t.scope                   AS scope,
      ${grantStateExpr()}       AS state,
      t.refresh_issued_at::text AS created_at,
      t.last_used_at::text      AS last_used_at,
      tm.id::text               AS teammate_id,
      tm.email                  AS teammate_email,
      tm.display_name           AS teammate_display_name
    FROM oauth_token t
    JOIN oauth_client c ON c.client_id = t.client_id
    JOIN teammate tm    ON tm.id = t.teammate_id
    WHERE t.teammate_id = ${teammateId}::uuid
    ORDER BY COALESCE(t.last_used_at, t.refresh_issued_at) DESC, t.refresh_issued_at DESC
  `)
  return [...rows].map((r) => ({
    ...projectGrant(r),
    teammate_id: r.teammate_id,
    teammate_email: r.teammate_email,
    teammate_display_name: r.teammate_display_name,
  }))
}
