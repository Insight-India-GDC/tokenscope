/*
 * Activity list — the ONE union read behind `GET /me/activity` and its CSV
 * (design: docs/design/developer-pages-consolidation/04-fix-sprint-design.md
 * §F4, D17-D20). The contract, and why the list holds both row kinds, is
 * documented on `shared/schemas/activity.ts`; this module is the mechanism.
 *
 * ONE SORT KEY, AND IT IS THE UTC DAY (D18). The two kinds have different
 * natural grains — a conversation is an instant, a provider-recorded day is a
 * bucket — so the only key they can BOTH honestly answer is the UTC day. Within
 * a day the order is completed by a rank (sessions before the day-level record)
 * and, for sessions only, their last event; the day-level rows sort among
 * themselves on their id. Every leg is a real, stored value: nothing is
 * synthesised to make the sort work, which is the whole point.
 *
 * KEYSET, NOT OFFSET. The sort tuple is `(day, rank, ts, id)`, ALL DESCENDING —
 * deliberately uniform, so the resumption predicate is one Postgres row-value
 * comparison (`(...) < (...)`) rather than four hand-rolled OR-chains that drift.
 * The tuple is total: `id` is unique within a kind and `rank` separates the
 * kinds, so no two rows tie and no row can be skipped or repeated across pages.
 *
 * BOTH SIDES BOUNDED — A WORK BOUND, NOT A FAIRNESS ONE. Each branch applies the
 * SAME keyset predicate and its own `LIMIT n+1` before the union; the union then
 * re-sorts and takes n+1. Taking the global top-n from the per-branch top-n is
 * EXACT — it is the same page an unbounded union would produce, which is the
 * whole point: the bound changes what is READ, never what is RETURNED.
 *
 * So it is not a fairness device and this module does not claim one. A teammate
 * whose newest n records are all sessions gets a first page of all sessions, and
 * their provider-recorded days appear further down the SAME descending-day
 * order, exactly where the day they belong to falls. That is the ordering
 * contract, not starvation: nothing is dropped, and a walk of the pages reaches
 * every row of both kinds. A guarantee that each page held some of each kind
 * would be a different (and dishonest) list — it would have to reorder records
 * away from the one sort key they can both answer.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { z } from 'zod'
import { conversationKeyExpr } from '../db/conversation-key'
import { endedProjectExpr } from '../db/project-predicates'
import { breakdownFields, fetchBreakdownCells, groupCells } from './breakdowns'
import {
  isRealUtcDay,
  type ActivityFilters,
  type ActivityProviderDayRow,
  type ActivityRow,
  type ActivitySessionRow,
} from '../../shared/schemas/activity'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * Within one UTC day, sessions sort ABOVE the provider-recorded day. Both legs
 * are DESC, so the session rank is the higher number. The rank also keeps the
 * `ts` leg from ever comparing across kinds — a provider day's `ts` is the empty
 * string (it has no instant), and that value is a sort placeholder that never
 * reaches the payload.
 */
const RANK_SESSION = 1
const RANK_PROVIDER_DAY = 0

/**
 * The instant format used for BOTH the session sort leg and the `ts_last` the
 * client renders — one expression, so the value the list is ordered on and the
 * value the reader sees can never be different instants.
 */
const TS_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)

export interface ActivityCursor {
  day: string
  rank: number
  ts: string
  id: string
}

const CursorTuple = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealUtcDay),
  z.number().int().min(0).max(1),
  z.string().max(64),
  z.string().max(256),
])

export function encodeActivityCursor(c: ActivityCursor): string {
  return Buffer.from(JSON.stringify([c.day, c.rank, c.ts, c.id]), 'utf8').toString('base64url')
}

/** Returns null for anything that is not a cursor this module minted. */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  try {
    const parsed = CursorTuple.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    if (!parsed.success) return null
    const [day, rank, ts, id] = parsed.data
    return { day, rank, ts, id }
  } catch {
    return null
  }
}

/** The row-value comparison that resumes the scan. One predicate, both branches. */
function keysetPredicate(dayExpr: SQL, rank: number, tsExpr: SQL, idExpr: SQL, c: ActivityCursor): SQL {
  return sql`(${dayExpr}, ${sql.raw(String(rank))}::int, ${tsExpr}, ${idExpr})
             < (${c.day}::date, ${c.rank}::int, ${c.ts}::text, ${c.id}::text)`
}

interface UnionRow extends Record<string, unknown> {
  kind: string
  id: string
  sort_day: string
  sort_rank: number
  sort_ts: string
  day: string
  tool: string
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  /** NULL only on a provider day the provider reported no token quantity for. */
  tokens: string | null
  cost_usd: string
  attributed: boolean
  ts_last: string | null
  instance_id: string | null
  partly_ended: boolean | null
  ended_project_code: string | null
  dismissed: boolean | null
}

/**
 * The OTel-observed conversations. Grouped on the shared conversation key, so a
 * subagent never becomes its own row and a legacy instance-keyed conversation
 * still appears. The sort day is the day of the conversation's LAST event —
 * the same instant the row displays, so the order can never look random.
 *
 * TWO PHASES, ONE STATEMENT (docs/design/request-floor-performance.md §F6).
 * The from/to bounds and the keyset cursor compare against MAX(ts_event), so
 * they can only live in HAVING — the per-conversation aggregate is unbounded
 * by construction, over a table RANGE-partitioned on ts_event. Phase 1
 * (`ranked`) therefore ranks conversation keys with the slimmest aggregate
 * that can answer the HAVING + ORDER BY (project joined ONLY when the filter
 * needs p.code; no array_agg sorts), and takes the page's n keys. Phase 2
 * builds the full row shape for only those keys. Both phases apply the SAME
 * WHERE quals and group on the SAME key, and phase 1 ranks on the UNFILTERED
 * per-conversation MAX — identical HAVING semantics — so the output is
 * row-identical to the single-phase aggregate it replaces.
 */
function sessionsBranch(teammateId: string, f: ActivityFilters, c: ActivityCursor | null, n: number): SQL {
  const key = conversationKeyExpr('ar')
  const dayExpr = sql`(MAX(ar.ts_event) AT TIME ZONE 'UTC')::date`
  const tsExpr = sql`to_char(MAX(ar.ts_event) AT TIME ZONE 'UTC', ${TS_FORMAT})`

  const where: SQL[] = [sql`ar.teammate_id = ${teammateId}::uuid`]
  if (f.tool) where.push(sql`ar.tool = ${f.tool}`)

  const having: SQL[] = []
  if (f.from) having.push(sql`${dayExpr} >= ${f.from}::date`)
  if (f.to) having.push(sql`${dayExpr} <= ${f.to}::date`)
  // A conversation can span projects; it matches a project filter if ANY of its
  // rows is on that project — the same "touched it" reading the row's own
  // project column already has.
  if (f.project) having.push(sql`bool_or(p.code = ${f.project})`)
  if (f.tagged === 'tagged') having.push(sql`bool_or(ar.project_id IS NOT NULL)`)
  if (f.tagged === 'untagged') having.push(sql`bool_or(ar.project_id IS NULL)`)
  if (c) having.push(keysetPredicate(dayExpr, RANK_SESSION, tsExpr, key, c))

  // Phase-2 key filter: the OR-of-two-equalities shape conversation-key.ts
  // documents, NEVER COALESCE(...) IN (...) — the COALESCE form drags every
  // row through an expression, while here the claude_session_id arm is
  // index-servable and the legacy instance_id::text arm (pre-0016 rows only)
  // stays a filter bounded by the teammate qual. A row belongs to a ranked
  // key when its claude_session_id hits the set, or (legacy pre-0016 rows
  // only) when claude_session_id IS NULL and its instance id does — exactly
  // the rows whose COALESCE key equals that key, so phase 2 regroups the same
  // populations phase 1 ranked (§F6).
  const rankedKeyFilter = sql`(ar.claude_session_id IN (SELECT r.id FROM ranked r)
             OR (ar.claude_session_id IS NULL
                 AND ar.instance_id::text IN (SELECT r.id FROM ranked r)))`

  return sql`
    WITH ranked AS (
      SELECT ${key} AS id
      FROM attribution_record ar
      ${f.project ? sql`LEFT JOIN project p ON p.id = ar.project_id` : sql``}
      WHERE ${sql.join(where, sql` AND `)}
      GROUP BY ${key}
      ${having.length ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
      -- The final sort minus its rank leg: rank is constant on this branch,
      -- so these three legs ARE the full order (§F6).
      ORDER BY ${dayExpr} DESC, ${tsExpr} DESC, ${key} DESC
      LIMIT ${n}
    )
    SELECT * FROM (
      SELECT
        'session'::text                       AS kind,
        ${key}                                AS id,
        ${dayExpr}                            AS sort_day,
        ${sql.raw(String(RANK_SESSION))}::int AS sort_rank,
        ${tsExpr}                             AS sort_ts,
        ${dayExpr}::text                      AS day,
        MAX(ar.tool)                          AS tool,
        /*
         * ONE project, picked ONCE. A conversation can span projects, and three
         * independent MAX()es picked three times: MAX(project_id) ranks by uuid
         * TEXT while MAX(code)/MAX(display_name) rank by code, so a two-project
         * conversation could return one project's id beside another's code --
         * a tuple naming no project that exists. It reaches the card, the CSV
         * and (worse) the re-tag dialog, which pre-selects project_id.
         *
         * So all three read the SAME ordering and therefore the SAME row:
         * greatest p.code among the projects this conversation actually touched.
         * project.code is UNIQUE (drizzle/schema/projects.ts), so the order is
         * total and the pick is deterministic, not merely usually-consistent.
         * The FILTER drops the untagged rows -- their p.* are NULL, and DESC
         * sorts NULLS FIRST, which would otherwise hand back "no project" for a
         * conversation that has one.
         *
         * The "touched it" project FILTER above is unchanged and still means
         * what it says: a row matching project=X may display project Y, because
         * the conversation is on both. One record cannot name two projects.
         */
        (array_agg(ar.project_id::text ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_id,
        (array_agg(p.code ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_code,
        (array_agg(p.display_name ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_display_name,
        MAX(ar.activity)                      AS activity,
        SUM(ar.tokens)::text                  AS tokens,
        SUM(ar.cost_usd)::text                AS cost_usd,
        bool_or(ar.project_id IS NOT NULL)    AS attributed,
        ${tsExpr}                             AS ts_last,
        MAX(ar.instance_id::text)             AS instance_id,
        (bool_or(${endedProjectExpr('p')})
         AND bool_or(NOT (${endedProjectExpr('p')}))) AS partly_ended,
        MAX(p.code) FILTER (WHERE ${endedProjectExpr('p')}) AS ended_project_code,
        NULL::boolean                         AS dismissed
      FROM attribution_record ar
      LEFT JOIN project p ON p.id = ar.project_id
      -- Same WHERE quals as phase 1 (teammate qual stays: RLS + the
      -- teammate index), so each ranked key regroups the exact row population
      -- phase 1 aggregated — every HAVING fact phase 1 established therefore
      -- still holds and is not re-checked here (§F6).
      WHERE ${sql.join(where, sql` AND `)}
        AND ${rankedKeyFilter}
      GROUP BY ${key}
    ) s
    ORDER BY s.sort_day DESC, s.sort_rank DESC, s.sort_ts DESC, s.id DESC
    LIMIT ${n}
  `
}

/**
 * The provider-recorded days — EVERY one of them, tagged or not, dismissed or
 * not. That is the fix: `unaccounted_usage` rows leave the worklist the moment
 * they are decided, and before this list existed that made them unfindable.
 *
 * WHAT COUNTS AS A RECORD: money OR tokens. `cost_usd` and `tokens` are two
 * INDEPENDENT residuals — the writer takes `GREATEST(0, api − otel)` of each
 * separately (unaccounted-reconciliation.ts), so a day whose dollars are fully
 * corroborated while its token count is not lands as `cost_usd = 0,
 * tokens > 0`. That is a provider-recorded day with a measured quantity on it,
 * and the previous `cost_usd > 0` alone silently dropped it from a list whose
 * whole claim is that it holds every provider-recorded day — the NULL-vs-0
 * defect wearing the other axis. Both zero stays out: that is the reconciliation
 * artefact (an orphan the reconciler zeroed but kept for its tagging decision),
 * a record of nothing the teammate did.
 */
function providerDaysBranch(teammateId: string, f: ActivityFilters, c: ActivityCursor | null, n: number): SQL {
  const where: SQL[] = [sql`u.teammate_id = ${teammateId}::uuid`, sql`(u.cost_usd > 0 OR u.tokens > 0)`]
  if (f.tool) where.push(sql`u.tool = ${f.tool}`)
  if (f.from) where.push(sql`u.day >= ${f.from}::date`)
  if (f.to) where.push(sql`u.day <= ${f.to}::date`)
  if (f.project) where.push(sql`p.code = ${f.project}`)
  if (f.tagged === 'tagged') where.push(sql`u.project_id IS NOT NULL`)
  if (f.tagged === 'untagged') where.push(sql`u.project_id IS NULL`)
  if (c) where.push(keysetPredicate(sql`u.day`, RANK_PROVIDER_DAY, sql`''::text`, sql`u.id::text`, c))

  return sql`
    SELECT
      'provider-day'::text                        AS kind,
      u.id::text                                  AS id,
      u.day                                       AS sort_day,
      ${sql.raw(String(RANK_PROVIDER_DAY))}::int  AS sort_rank,
      ''::text                                    AS sort_ts,
      u.day::text                                 AS day,
      u.tool                                      AS tool,
      u.project_id::text                          AS project_id,
      p.code                                      AS project_code,
      p.display_name                              AS project_display_name,
      u.activity                                  AS activity,
      -- NULL = "the provider never reported a token quantity for this day",
      -- which is not the same fact as zero. See the api CTE below.
      CASE WHEN api.tokens_reported IS FALSE THEN NULL ELSE u.tokens::text END AS tokens,
      u.cost_usd::text                            AS cost_usd,
      (u.project_id IS NOT NULL)                  AS attributed,
      NULL::text                                  AS ts_last,
      NULL::text                                  AS instance_id,
      NULL::boolean                               AS partly_ended,
      NULL::text                                  AS ended_project_code,
      (u.dismissed_at IS NOT NULL)                AS dismissed
    FROM unaccounted_usage u
    LEFT JOIN project p ON p.id = u.project_id
    /*
     * DID THE PROVIDER MEASURE TOKENS FOR THIS KEY AT ALL?
     * (No backticks in this literal: one inside a SQL comment closes the
     * template and the parse error points at the wrong line entirely.)
     *
     * unaccounted_usage.tokens is NOT NULL DEFAULT 0, and the writer feeds it
     * COALESCE(api_tokens, 0) -- so the "no quantity was ever reported" fact is
     * already flattened by the time it is stored. For Copilot that is EVERY row:
     * v_teammate_usage_daily's GitHub arm is literally
     *   NULL::bigint AS tokens -- copilot is metered in ai-credits, not tokens
     * (mig 0101), because ai_credit/usage reports no token quantity. Shipping
     * the stored 0 puts a measured-looking zero on the wire for something never
     * measured, and the reader cannot tell it from a real zero.
     *
     * So the ONE source the residual was computed FROM is asked the one question
     * the residual cannot answer. bool_or over the (teammate, day, tool) key:
     * FALSE = backed, and no arm reported tokens, so the wire says null. TRUE or
     * NULL (no backing row -- an orphan the reconciler has not yet reached)
     * keeps the stored value: a residual that WAS measured, or a zeroed orphan,
     * and inventing "unknown" for those would be the same fabrication mirrored.
     *
     * An aggregate with no GROUP BY always returns exactly one row, so this
     * LATERAL can never drop a day. Both source tables are keyed on
     * (teammate, date, ...) and neither carries RLS, so it is an index lookup
     * per row of a page already bounded to n + 1.
     */
    LEFT JOIN LATERAL (
      SELECT bool_or(d.tokens IS NOT NULL) AS tokens_reported
        FROM v_teammate_usage_daily d
       WHERE d.teammate_id = u.teammate_id AND d.day = u.day AND d.tool = u.tool
    ) api ON TRUE
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY u.day DESC, u.id DESC
    LIMIT ${n}
  `
}

function toRow(r: UnionRow): ActivityRow {
  const cursor = encodeActivityCursor({
    day: r.sort_day.slice(0, 10),
    rank: Number(r.sort_rank),
    ts: r.sort_ts ?? '',
    id: r.id,
  })
  const base = {
    id: r.id,
    day: r.day,
    tool: r.tool,
    project_id: r.project_id,
    project_code: r.project_code,
    project_display_name: r.project_display_name,
    activity: r.activity,
    // `Number(null)` is 0 — the exact coercion this column exists to avoid.
    tokens: r.tokens === null ? null : Number(r.tokens),
    cost_usd: Number(r.cost_usd).toFixed(2),
    attributed: r.attributed,
    cursor,
  }
  if (r.kind === 'session') {
    return {
      ...base,
      kind: 'session',
      // Both non-null by construction on this branch — the union widened the
      // columns. A session's tokens are OTel-observed: always a measurement.
      tokens: Number(r.tokens),
      ts_last: r.ts_last!,
      instance_id: r.instance_id,
      partly_ended: r.partly_ended ?? false,
      ended_project_code: r.ended_project_code,
    } satisfies ActivitySessionRow
  }
  return {
    ...base,
    kind: 'provider-day',
    dismissed: r.dismissed ?? false,
  } satisfies ActivityProviderDayRow
}

/**
 * One page of Activity. `limit` is the page size; the read asks for one extra
 * row to answer `has_more` without a second count query (and without ever
 * claiming a total, which this list does not have — D19).
 *
 * `withBreakdowns` adds the per-conversation model mix for the SESSION rows on
 * the page (bounded by the page size). The CSV does not need it.
 */
export async function fetchActivityPage(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  opts: { limit: number; cursor?: string | null; withBreakdowns?: boolean },
): Promise<{ rows: ActivityRow[]; hasMore: boolean; nextCursor: string | null }> {
  const cursor = opts.cursor ? decodeActivityCursor(opts.cursor) : null
  if (opts.cursor && !cursor) throw new Error('activity-list: invalid cursor')

  const probe = opts.limit + 1
  const branches: SQL[] = []
  if (f.kind === 'all' || f.kind === 'session') branches.push(sessionsBranch(teammateId, f, cursor, probe))
  if (f.kind === 'all' || f.kind === 'provider-day') {
    branches.push(providerDaysBranch(teammateId, f, cursor, probe))
  }
  // `kind` is a closed enum, so this cannot happen — but an empty UNION would be
  // a syntax error rather than an empty page, which is a bad way to find out.
  if (!branches.length) return { rows: [], hasMore: false, nextCursor: null }

  // Each branch carries its OWN ORDER BY + LIMIT (that is what "both sides
  // bounded" means), and Postgres requires a branch so shaped to be
  // parenthesised before it can take part in a UNION.
  const union = sql.join(
    branches.map((b) => sql`(${b})`),
    sql` UNION ALL `,
  )
  const raw = await tx.execute<UnionRow>(sql`
    SELECT * FROM (${union}) x
    ORDER BY x.sort_day DESC, x.sort_rank DESC, x.sort_ts DESC, x.id DESC
    LIMIT ${probe}
  `)

  const all = [...raw]
  const hasMore = all.length > opts.limit
  const page = all.slice(0, opts.limit).map(toRow)

  if (opts.withBreakdowns) {
    const convIds = page.filter((r) => r.kind === 'session').map((r) => r.id)
    if (convIds.length) {
      const cells = groupCells(await fetchBreakdownCells(tx, teammateId, convIds))
      for (const r of page) {
        if (r.kind === 'session') Object.assign(r, breakdownFields(cells.get(r.id) ?? []))
      }
    }
  }

  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length ? (page[page.length - 1]!.cursor ?? null) : null,
  }
}

/**
 * Every row matching the filters, up to `limit`, for the CSV. Walks the SAME
 * keyset the page does rather than re-implementing a bulk query, so "the CSV
 * matches what you are looking at" (D20) is true by construction and not by
 * two queries agreeing.
 */
export async function fetchActivityForExport(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  limit: number,
): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  // Page size is capped so one enormous export cannot become one enormous query.
  const step = 500
  while (out.length < limit) {
    const page: Awaited<ReturnType<typeof fetchActivityPage>> = await fetchActivityPage(tx, teammateId, f, {
      limit: Math.min(step, limit - out.length),
      cursor,
    })
    out.push(...page.rows)
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  return out
}
