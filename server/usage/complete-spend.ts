/*
 * complete-spend — THE §A spend seam. One lane, one window, one definition of
 * "what a project has spent", at every grain any surface needs.
 *
 * ── WHY THIS IS THE ONLY PLACE ───────────────────────────────────────────────
 * "Project spend this month" used to be computed in five places from three
 * sources: `attribution_aggregate` (the project header + the /projects cards),
 * `attribution_record` (the team-contribution table, the activity donut, the
 * budget editor, the manager rollup) and `v_complete_usage` (the budget alert).
 * The consequences were all real: a page rendered a stale cron-refreshed
 * headline above a live table with nothing disclosing it; "Manage budget →"
 * walked the PM to a DIFFERENT number at the moment they decided whether to
 * extend; and the alert that paged them was computed on a third lane again.
 *
 * The worst of it was structural, not cosmetic. `attribution_aggregate` and
 * `attribution_record` carry OTel-EMITTED spend only. `v_complete_usage`
 * additionally carries arm 2 (the API−OTel reconciliation gap) and arm 3 (the
 * ingest-only lane). At today's adoption most consumption arrives via
 * reconciliation, so the project manager's headline was structurally the
 * SMALLEST number in the product, and a PM reporting cost-versus-profit from it
 * under-reported cost. The gap widens as adoption grows.
 *
 * So: every project figure on every surface comes from this module, reading
 * `v_complete_usage` filtered on `project_id`. A second query that "agrees
 * today" is the defect, not the fix.
 *
 * ── THE LANE, AND WHAT IT CANNOT CARRY (mig 0101) ────────────────────────────
 * `v_complete_usage` is three UNION ALL arms and their coverage is NOT uniform:
 *
 *   arm 1 `otel-emitted`   attribution_record. Carries project_id, activity,
 *                          model, token_type, identity_state.
 *   arm 2 `api-reconciled` unaccounted_usage (the API−OTel gap). Carries
 *                          project_id and activity — it is taggable in the same
 *                          needs-tagging flow. Since migs 0123/0124 the view
 *                          fans each fill row into its write-time MEASURED
 *                          per-model children plus at most ONE reason-typed
 *                          NULL-model remainder (07-model-axis D3/D4);
 *                          `token_type` stays 'unknown' on every arm-2 row.
 *   arm 3 `provider-usage` the ingest-only surfaces (non-Code Claude, the
 *                          coding-agent lane). `project_id` is NULL BY
 *                          CONSTRUCTION: this money is untaggable, so it can
 *                          never be an operand of a project budget. `activity`
 *                          and `model` are NULL for the same structural reason.
 *
 * Two rules follow, and both are enforced by the functions below rather than
 * left to each caller:
 *   1. A project total on this lane CANNOT include arm-3 spend. That money must
 *      never be silently dropped and must never render as a zero — it gets an
 *      EXPLICIT, separately labelled bucket
 *      ({@link completeProjectMemberLaneExclusions}).
 *   2. The per-MODEL split of a project total covers arms 1+2: the reconciled
 *      arm's measured children fan out of the view (migs 0123/0124) and
 *      {@link completeProjectModelMix} keeps its reason-typed remainders as
 *      remainder ROWS (one per reason, `__`-sentinel keys) that the Top-models
 *      coverage footer prices — never category rows. Every project total still
 *      reports `reconciledUsd` — a PROVENANCE disclosure (how much of the
 *      headline was reconciled rather than emitted), no longer a claim that
 *      the reconciled share has no model axis.
 *
 * ── TOOL COMPLETENESS ────────────────────────────────────────────────────────
 * Copilot per-user usage does NOT reach `attribution_record` (native OTLP is
 * default-off), so any figure reading the ledger alone is silently blind to
 * Copilot: a Copilot-heavy project never trips its budget. Per-tool cost math
 * runs ONCE at ingest (azure-monitor-reader's computeCopilotCost vs token rate
 * cards), so `cost_usd` is uniform and readers must never re-implement per-tool
 * cost. There is no `tool` branching here or in any caller.
 *
 * ── THE PROVISIONAL OPTION ───────────────────────────────────────────────────
 * `identity_state = 'provisional'` means the teammate/device binding is not yet
 * confirmed. Manager-facing figures drop it (an unconfirmed binding must never
 * page a PM or move a budget decision), and the five project sites all set
 * {@link ProjectSpendOptions.excludeProvisional} so the page, the budget editor
 * and the alert cannot disagree. It is a NAMED option on this function rather
 * than a second query, and every total reports `provisionalUsd` alongside so a
 * surface can say WHY its number differs from the raw lane instead of quietly
 * differing. This is deliberately NOT what `getMyUsage` does: a dev's own
 * homepage correctly shows their pre-confirmation spend. Different audience,
 * different rule — do not "fix" one to match the other.
 */
import { sql, type SQL } from 'drizzle-orm'
import { splitBounds, type RollupGate } from './rollup-gate'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { modelDriverKey, modelDriverLabel } from '../../shared/reports/model-attribution'
import type { ModelDaySpend, ProjectModelRow } from '../../shared/schemas/usage'

type AnyDb = PostgresJsDatabase<typeof schema> | PostgresJsDatabase<Record<string, unknown>>

/**
 * Half-open UTC window `[startIso, endIso)` — the one window semantics.
 *
 * Field names are deliberately IDENTICAL to `server/reporting/params.ts`'s
 * `UsageWindow`, so the two are structurally interchangeable and a reporting
 * window can be handed straight to a project-spend call. They used to differ
 * (`sinceIso`/`untilIso` here), which is a duplication of exactly the kind this
 * module exists to remove — and it silently mis-typed a caller in review.
 */
export interface SpendWindow {
  /** Inclusive lower bound (ISO instant). */
  startIso: string
  /** EXCLUSIVE upper bound (ISO instant). */
  endIso: string
}

export interface ProjectSpendOptions {
  /**
   * Restrict to these project ids. Omit (or pass null) for EVERY tagged
   * project — the budget-alert scan. An empty array returns an empty map
   * without a round-trip.
   */
  projectIds?: readonly string[] | null
  /**
   * Drop `identity_state = 'provisional'` from the headline (see the module
   * header). Manager-facing producers set this; it is reported back as
   * `provisionalUsd` on every row so the omission can be disclosed.
   */
  excludeProvisional?: boolean
}

export interface ProjectSpendTotals {
  /** Σ cost_usd on the lane for this project in the window. THE project figure. */
  costUsd: number
  tokens: number
  /** Arm 1 share — the only part with a model / token-type axis. */
  otelUsd: number
  /** Arm 2 share — present on this lane, ABSENT from `attribution_aggregate`. */
  reconciledUsd: number
  /**
   * Provisional-identity spend in the window. EXCLUDED from `costUsd` when
   * `excludeProvisional` is set, included otherwise — either way it is the
   * figure a surface quotes when explaining the headline.
   */
  provisionalUsd: number
}

/** One member's contribution to a project — same lane, same window, finer grain. */
export interface ProjectMemberSpend {
  teammateId: string
  displayName: string | null
  email: string
  costUsd: number
  tokens: number
  activeDays: number
  lastEvent: string | null
}

/** One activity slice of a project — same lane, same window, finer grain. */
export interface ProjectActivitySpend {
  /** NULL = tagged to the project but no activity claim (untagged WITHIN the project). */
  activity: string | null
  costUsd: number
  tokens: number
}

/**
 * The money a project total CANNOT carry, for the project's own members.
 * Rendered as its own labelled bucket — never folded into a project figure,
 * never allowed to look like zero.
 *
 * ── NOT ADDITIVE ACROSS PROJECTS ─────────────────────────────────────────────
 * These figures are keyed on MEMBERSHIP, not on allocation. A teammate on three
 * projects contributes their WHOLE arm-3 spend to all three, because the money
 * carries no project axis at all (mig 0101) — there is nothing to divide it by.
 * So this is "what this project's people also spent", never "this project's
 * share", and summing it across projects multiplies the same dollars.
 *
 * That is why every field is prefixed `member`: a caller reaching for it to
 * build a total has to read the word first. Sum these across projects and the
 * answer is wrong; quote them per project, or ask at team/cost-centre scope
 * where the same money is counted exactly once.
 */
export interface ProjectLaneExclusions {
  /**
   * Arm 3 (`provider-usage`) spend by this project's members during their
   * membership window. Untaggable BY CONSTRUCTION (mig 0101) — no project
   * budget on any lane can ever include it. NON-ADDITIVE (see above).
   */
  memberIngestOnlyUsd: number
  /** The surfaces that money came from, so the label can name them. */
  memberIngestOnlyTools: string[]
}

/**
 * The reconciliation of a cost centre's own §A burn against the sum of its
 * projects' figures. The four residual terms are ≥ 0 and the identity is
 *
 *   burnUsd = Σ completeProjectSpend(the CC's projects)
 *           + ingestOnlyUsd + untaggedUsd + foreignProjectUsd
 *           − offCentreUsd
 *
 * `burnUsd` is returned WITH the terms rather than left for a caller to fetch
 * separately, because a reconciliation is only checkable against the thing it
 * reconciles to: a surface that renders the terms without the target cannot add
 * up, and the /me/cost-centres card shipped in exactly that state.
 *
 * `offCentreUsd` subtracts because it is money the PROJECT totals carry and the
 * CC burn does not (arm 2 rows carry a NULL `cost_owning_unit_id` by
 * construction), so it is present on the left of the identity and absent on the
 * right. Consistency contract §6.3 — the cost-centre→project node pair.
 *
 * ── THE BURN AXIS, AND WHY ONE TERM SITS OUTSIDE THE IDENTITY ────────────────
 * `cost_owning_unit_id` on the §A lane means "the cost centre of the PROJECT
 * this money was tagged to". Both writers set it that way and only that way —
 * `tag-session.ts` (`cou = p.cost_owning_unit_id`) and the ingest path in
 * `azure-monitor-reader.ts` (`cou = proj.cost_owning_unit_id`) — and both leave
 * it NULL when there is no project. So UNTAGGED money has no burn home on
 * EITHER arm; that is a property of the column's meaning, not of the
 * reconciliation arm.
 *
 * Which leaves a real hole: taggable spend that nobody has claimed for a
 * project is in the §A estate, in nobody's burn, and in none of the four terms
 * above. {@link CostCentreLaneResidual.memberUntaggedUsd} closes it on the only
 * dimension that money HAS — the person who spent it — and is therefore
 * reported OUTSIDE the identity, never summed into it. Mixing a teammate-home
 * figure into a project-home identity is how two axes become one wrong number.
 */
export interface CostCentreLaneResidual {
  /**
   * The cost centre's own §A burn in the window: Σ over rows whose
   * `cost_owning_unit_id` is this CC. The right-hand side of the identity.
   */
  burnUsd: number
  /** Homed at this CC, arm 3 — untaggable, so no project row can claim it. */
  ingestOnlyUsd: number
  /**
   * Homed at this CC, taggable (arms 1-2), but carrying no project claim.
   *
   * SCHEMA-LEGAL AND UNREACHABLE TODAY: `project_id` and `cost_owning_unit_id`
   * are independently nullable, but no writer sets the CoU without also setting
   * a project (see the axis note above), so nothing in production produces this
   * shape. The term stays because it is the ONLY thing separating `ingestOnly`
   * from itself — the two differ by a single `usage_provenance` clause, and
   * without a row in this shape a term that swallowed the other returns the same
   * total and the mutation survives. Real unclaimed money is
   * {@link memberUntaggedUsd}, not this.
   */
  untaggedUsd: number
  /** Homed at this CC but tagged to a project led by a DIFFERENT cost centre. */
  foreignProjectUsd: number
  /** Tagged to one of THIS CC's projects but not homed here (arm 2's NULL CoU). */
  offCentreUsd: number
  /**
   * Taggable §A spend (arms 1-2) carrying NEITHER a project claim NOR a burn
   * home, by teammates whose OWN home cost centre — the nearest cost-owning
   * ancestor of `teammate.org_unit_id` — is this one.
   *
   * OUTSIDE the identity above: it is measured on the teammate axis, not the
   * project-CoU axis, so adding it to a burn would be conflating two questions.
   * Reported because without it this money is in the §A total and in no cost
   * centre's anything — the estate's genuinely unaccounted middle. Disjoint from
   * {@link untaggedUsd} by construction (this term requires a NULL CoU, that one
   * requires a matching CoU), so the two can be shown side by side.
   *
   * Still not exhaustive, and honestly so: a teammate under no cost-owning
   * ancestor at all lands in neither. That population is the placement problem
   * `server/usage/unhomed-causes.ts` decomposes, not a spend-attribution one.
   */
  memberUntaggedUsd: number
}

// ── The one lane, the one window, the one option ─────────────────────────────

/** The §A lane. Named once so a reader can grep every consumer of it. */
const LANE = sql`v_complete_usage`

/**
 * The §A lane with each person's CURRENT placement (mig 0162,
 * docs/design/current-org-lens/00-design.md): for readers that clamp or group by
 * a Business Unit. Its cost_owning_unit_id is still the project's on tagged OTel
 * rows; only the person-placed rows move.
 */
const LANE_CURRENT = sql`v_complete_usage_current`

/**
 * The day-grain rollup of the lane (migs 0136/0138) — the PROJECT AXIS's
 * second source and nothing else's (usage-rollup-lane.md R5b.2). Content is
 * DEFINED as an aggregate of `v_complete_usage`, so the axis's grouping,
 * ranking, cap, tail-fold and provisional filter read identically off it;
 * what differs is freshness (≤ one worker cadence behind the live view).
 * Read through the current-lens view: both callers are report-scoped and clamp
 * by placement or Business Unit (docs/design/current-org-lens/00-design.md).
 */
const ROLLUP = sql`v_usage_rollup_current`

/**
 * Which table the project axis scans (usage-rollup-lane.md R5b).
 *
 * CONSTRAINT — `'rollup'` is for the two report-scoped callers ONLY:
 * `fetchBudgetAxis` (server/reporting/engine/budget-axis.ts, the drivers
 * project axis) and `fetchCostCentreBurnDrivers`'s project axis
 * (server/reporting/cost-centres.ts, the Business-Unit page population read).
 * The rollup lags the live view by up to one worker cadence (R5b.4), so a
 * real-time consumer — budget alerting, anything that pages a human — must
 * NOT opt in; it stays on the default `'view'`.
 */
export type ProjectAxisSource = 'view' | 'rollup'

/*
 * Every query below aliases the lane `u`, so the predicates hard-code that
 * prefix rather than taking an alias parameter. One shape, no string building.
 */

/** Half-open `[startIso, endIso)` on `ts_event` — the one window predicate. */
function windowPredicate(w: SpendWindow): SQL {
  return sql`u.ts_event >= ${w.startIso}::timestamptz AND u.ts_event < ${w.endIso}::timestamptz`
}

/**
 * The rollup path swaps the `ts_event` window for a `day` range, and the two
 * are equivalent ONLY for exact-UTC-midnight bounds: the rollup's `day` is the
 * event's UTC day, so a mid-day bound would silently drop or admit part of a
 * day. Report windows come from `resolveReportWindow` and comply structurally;
 * a non-midnight caller is a programmer error and must THROW, never undercount
 * (usage-rollup-lane.md R5b.2).
 */
function assertUtcMidnight(iso: string, bound: 'startIso' | 'endIso'): void {
  const d = new Date(iso)
  const midnight =
    !Number.isNaN(d.getTime()) &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  if (!midnight) {
    throw new Error(
      `projectAxisRows: source 'rollup' requires exact UTC-midnight window bounds; ${bound} = ${iso}`,
    )
  }
}

/**
 * A bound's UTC calendar day MUST come from the PARSED instant, never from the
 * raw string's first ten characters: {@link assertUtcMidnight} validates the
 * instant, so an offset-formatted UTC midnight (2026-09-01T23:00:00-01:00 IS
 * 2026-09-02T00:00:00Z) passes it while its raw digits name the prior day —
 * a silent full-day window shift (usage-rollup-lane.md R5b.2).
 */
const utcDayOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10)

/**
 * Half-open `[startIso, endIso)` translated to the rollup's `day` column.
 * Exact iff both bounds are UTC midnights ({@link assertUtcMidnight}): the
 * start midnight admits every event of its own UTC day, and the EXCLUSIVE end
 * midnight excludes its day on both representations (`ts_event < midnight`
 * admits no event of that day; `day < end::date` admits no such cell).
 */
function rollupWindowPredicate(w: SpendWindow): SQL {
  return sql`u.day >= ${utcDayOf(w.startIso)}::date AND u.day < ${utcDayOf(w.endIso)}::date`
}

/**
 * The rows that count toward a headline, given the named provisional option.
 * `TRUE` (not "no clause") so it composes inside a FILTER the same way.
 */
function includePredicate(excludeProvisional: boolean | undefined): SQL {
  return excludeProvisional ? sql`u.identity_state IS DISTINCT FROM 'provisional'` : sql`TRUE`
}

/** `project_id = ANY(...)`, or "any tagged project" when the caller passes none. */
function projectPredicate(ids: readonly string[] | null | undefined): SQL {
  if (!ids) return sql`u.project_id IS NOT NULL`
  return sql`u.project_id = ANY(ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}])`
}

const num = (v: unknown): number => Number(v ?? 0)

// ── Grain 1: the project total (THE function) ────────────────────────────────

/**
 * Σ complete §A spend per project over a window, across ALL teammates.
 *
 * THE definition of "project spend" — the project header, the /projects cards,
 * the cost-centre owner's project list, the budget editor and the budget alert
 * all read this and nothing else. Rows with a NULL
 * `project_id` are excluded: untagged, pooled and arm-3 spend belong to no
 * project budget (see {@link completeProjectMemberLaneExclusions} for how the
 * last of those is surfaced instead of dropped).
 *
 * Returns a Map keyed by project id. A project with no spend in the window is
 * ABSENT from the map — callers default to 0.
 */
/*
 * NO GATE PARAMETER, and the type is the enforcement.
 *
 * A RollupGate certifies ONE teammate's settled days. This function totals a
 * project across ALL of them, so no gate that exists can cover its rows: a
 * colleague's late write or pending re-home cannot close the caller's proof,
 * and a split read here would serve their stale rollup rows behind it.
 *
 * It briefly took one anyway, defaulted to null, with no caller passing it —
 * dead code holding the door open for a future caller to do the unsafe thing
 * under a proof that looked reassuring. Removed rather than documented: a
 * signature that cannot express the mistake is worth more than a comment
 * asking people not to make it.
 */
export async function completeProjectSpend(
  db: AnyDb,
  window: SpendWindow,
  opts: ProjectSpendOptions = {},
): Promise<Map<string, ProjectSpendTotals>> {
  if (opts.projectIds && opts.projectIds.length === 0) return new Map()
  const keep = includePredicate(opts.excludeProvisional)
  const rows = await db.execute<{
    project_id: string
    cost_usd: string
    tokens: string
    otel_usd: string
    reconciled_usd: string
    provisional_usd: string
  }>(sql`
    SELECT u.project_id::text AS project_id,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE ${keep}), 0)::text AS cost_usd,
           COALESCE(SUM(u.tokens)   FILTER (WHERE ${keep}), 0)::text AS tokens,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE ${keep} AND u.usage_provenance = 'otel-emitted'), 0)::text AS otel_usd,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE ${keep} AND u.usage_provenance = 'api-reconciled'), 0)::text AS reconciled_usd,
           COALESCE(SUM(u.cost_usd) FILTER (WHERE u.identity_state = 'provisional'), 0)::text AS provisional_usd
      FROM ${LANE} u
     WHERE ${windowPredicate(window)}
       AND ${projectPredicate(opts.projectIds)}
     GROUP BY u.project_id
  `)
  return new Map(
    [...rows].map((r) => [
      r.project_id,
      {
        costUsd: num(r.cost_usd),
        tokens: num(r.tokens),
        otelUsd: num(r.otel_usd),
        reconciledUsd: num(r.reconciled_usd),
        provisionalUsd: num(r.provisional_usd),
      },
    ]),
  )
}

/** One row of the PROJECT AXIS — a project, the untagged bucket, or the remainder. */
export interface ProjectAxisSpend {
  /**
   * The project, or NULL for the rows in scope that carry no project claim (the
   * "Untagged" bucket). Present only when the caller's scope admits NULL-project
   * rows: a scope expressed over `p` (e.g. `p.cost_owning_unit_id = …`) excludes
   * them by construction, so that shape never yields a null key.
   *
   * Also NULL on the REMAINDER row — distinguish the two on
   * {@link remainderProjects}, never on this field alone, or the remainder gets
   * labelled "Untagged" and the axis claims nobody tagged the money it folded.
   */
  projectId: string | null
  /** `display_name` (falling back to `code`); NULL on the untagged/remainder rows. */
  label: string | null
  /**
   * The project's own `code` — NULL on the untagged bucket and on the folded
   * remainder, which name no single project.
   *
   * It rides the axis because `/projects/{code}` is keyed on the CODE while this
   * axis keys on the id (developer pages D29): a driver row that cannot name its
   * target renders as plain text, and without the code EVERY project row would
   * be plain text on a surface whose whole point is that it drills.
   */
  code: string | null
  costUsd: number
  /**
   * How many ranked-out projects this row folds: 0 on a real project row and on
   * the untagged bucket, > 0 on the single remainder row. Label it with
   * {@link projectAxisRemainderLabel}.
   */
  remainderProjects: number
}

/**
 * Max PROJECT rows a driver axis returns before the tail is folded into ONE
 * explicit remainder row.
 *
 * The whole-company project axis has NO natural bound — it groups every project
 * in the estate — and it is now the DEFAULT axis on all three scopes, so the
 * largest scope became the unbounded one the moment the default flipped.
 * 50 is the driver table's main-body scale (the ranked-bar chart above it shows
 * 10), and it is the DEFAULT rather than an opt-in parameter: a bound that each
 * caller has to remember is a bound the next caller will not have.
 *
 * A READABILITY bound on a ranked list, not a restriction on what a caller may
 * see: the folded tail is written into the file as an explicit row, and the
 * surfaces whose job is to show the whole population read
 * `completeProjectAxisPopulation` instead.
 */
export const PROJECT_AXIS_ROW_CAP = 50

/** Stable row key for the folded tail — never a project id. */
export const PROJECT_AXIS_REMAINDER_KEY = '__all_other_projects__'

/**
 * The remainder row's label. One vocabulary, one place, so every surface that
 * folds a project tail says it in the same words.
 */
export function projectAxisRemainderLabel(projects: number): string {
  return `(all other — ${projects} project${projects === 1 ? '' : 's'})`
}

/**
 * Σ complete §A spend GROUPED BY project across an arbitrary scope — the
 * project DRIVER axis, at every reporting grain that has one.
 *
 * The sibling of {@link completeProjectSpend} for the axis question rather than
 * the budget question: it keys on the project but keeps the rows the budget
 * function deliberately drops, so a caller whose rows must SUM BACK to a scope
 * headline (consistency contract §6.3) gets the untagged remainder as an
 * explicit row instead of a silent shortfall.
 *
 * ── ONE COPY, THREE SCOPES, AND THE CLAMP IS THE WHOLE DIFFERENCE ────────────
 * `scope` is a code-constructed SQL predicate over the lane alias `u` AND/OR the
 * LEFT-JOINed `project` alias `p`. Which alias it names is not a stylistic
 * choice — it decides which arms of the lane survive (mig 0101):
 *
 *   over `u`  (region / org-unit / whole-company): every arm in scope. NULL
 *             `project_id` rows fall into the untagged bucket, so the rows sum
 *             back to the scope's own usage total.
 *   over `p`  (a cost centre's projects): the PROJECT's stable home, which is
 *             also the basis of the allocation denominator. Arm 2 rows carry a
 *             NULL `cost_owning_unit_id` BY CONSTRUCTION while carrying a real
 *             `project_id`, so clamping a cost centre on the USAGE row's
 *             `cost_owning_unit_id` instead would delete every reconciled dollar
 *             from the axis — at today's adoption, most of it.
 *
 * Rows sum back to whatever total the caller derives FROM THESE ROWS; they do
 * not sum back to a headline computed on a different clamp, and a caller that
 * pairs the `p` clamp with a `u`-clamped headline is asserting an identity that
 * does not hold (see `CostCentreLaneResidual` for the terms between them).
 *
 * ── RANKED AND CAPPED ────────────────────────────────────────────────────────
 * At most {@link PROJECT_AXIS_ROW_CAP} PROJECT rows come back; the rest are
 * folded into ONE named remainder row — see {@link projectAxisRows}. THIS is the
 * ranked seam every exploratory driver table reads, and its cap is what the
 * whole-company default axis depends on.
 *
 * A scope where the list IS the population (one cost centre) must NOT read this
 * with a bigger `limit` — it reads {@link completeProjectAxisPopulation}, so the
 * ranked seam keeps its meaning on every other surface.
 */
export async function completeProjectAxisSpend(
  db: AnyDb,
  window: SpendWindow,
  opts: { scope: SQL; excludeProvisional?: boolean; limit?: number; source?: ProjectAxisSource },
): Promise<ProjectAxisSpend[]> {
  return projectAxisRows(db, window, {
    scope: opts.scope,
    excludeProvisional: opts.excludeProvisional,
    limit: opts.limit ?? PROJECT_AXIS_ROW_CAP,
    source: opts.source,
  })
}

/**
 * Σ complete §A spend GROUPED BY project across a scope, **UNCAPPED** — every
 * project in the scope, no ranking cut, no folded remainder row.
 *
 * ── WHY THIS IS A SEPARATE FUNCTION AND NOT A BIGGER CAP ─────────────────────
 * {@link completeProjectAxisSpend} is a RANKED seam: its answer is "the projects
 * that are burning this scope, and one named row for everything else". That is
 * the right answer for a whole-company or regional driver table, where the axis
 * groups every project in the estate and the reader is exploring. Raising its
 * cap to serve one scope would change what the seam MEANS for every other
 * surface reading it — the largest scope would quietly become the unbounded one
 * again, which is the exact regression {@link PROJECT_AXIS_ROW_CAP} exists to
 * prevent.
 *
 * This variant answers a different question, and only where that question is
 * asked: at a single cost centre, the list **is** the population. A top-N there
 * hides the row the owner opened the page to find, and the folded "(all other —
 * N projects)" row is not a thing they can act on — they own each of those
 * projects individually. So: no cap, and the caller states on its face that the
 * list is complete.
 *
 * Bound in practice by the SCOPE, not by a limit: pass a predicate that clamps
 * to one cost centre (or an equally narrow set). Handing this a whole-company
 * clamp would ship the estate to render one table — use the ranked seam there.
 *
 * The untagged bucket (a NULL `projectId` row) still appears when the caller's
 * clamp admits NULL-project rows, exactly as in the ranked seam, so the rows
 * still sum back to the caller's own headline. `remainderProjects` is 0 on every
 * row this returns — there is no folded tail to name.
 */
export async function completeProjectAxisPopulation(
  db: AnyDb,
  window: SpendWindow,
  opts: { scope: SQL; excludeProvisional?: boolean; source?: ProjectAxisSource },
): Promise<ProjectAxisSpend[]> {
  return projectAxisRows(db, window, { ...opts, limit: null })
}

/**
 * The one project-axis query, ranked-and-capped or uncapped.
 *
 * ── RANKED AND CAPPED IN SQL, WITH THE TAIL NAMED (limit != null) ────────────
 * At most `limit` PROJECT rows come back; the rest are folded into ONE remainder
 * row (`remainderProjects > 0`) so the axis still SUMS BACK to its headline.
 * Ranking and truncation happen in the DATABASE — the whole-company scope groups
 * every project in the estate, and shipping all of them to JS to render (or to
 * throw away) is the work of the estate to draw one table. The untagged bucket
 * is NEVER folded into the remainder: it is not a project, and "(all other — N
 * projects)" must not be the label on money nobody tagged.
 *
 * With `limit === null` the rank filter and the tail row are BOTH absent, not
 * merely widened — so a caller cannot end up with a remainder row of zero
 * projects, and `remainderProjects` is 0 everywhere.
 *
 * `source: 'rollup'` swaps only the FROM and the window translation
 * (usage-rollup-lane.md R5b.2). CONSTRAINT: the provisional filter is
 * equivalent on pre-aggregated cells only because `identity_state` is IN the
 * rollup grain (mig 0138) — removing it from the grain silently breaks
 * `excludeProvisional` here. {@link ProjectAxisSource} says who may opt in.
 */
async function projectAxisRows(
  db: AnyDb,
  window: SpendWindow,
  opts: {
    scope: SQL
    excludeProvisional?: boolean
    limit: number | null
    source?: ProjectAxisSource
  },
): Promise<ProjectAxisSpend[]> {
  const source: ProjectAxisSource = opts.source ?? 'view'
  if (source === 'rollup') {
    assertUtcMidnight(window.startIso, 'startIso')
    assertUtcMidnight(window.endIso, 'endIso')
  }
  const axisLane = source === 'rollup' ? ROLLUP : LANE
  const axisWindow = source === 'rollup' ? rollupWindowPredicate(window) : windowPredicate(window)
  const limit = opts.limit
  // Both fragments are absent together: an uncapped run has no rank cut AND no
  // folded tail, so "capped" is one decision, not two that can disagree.
  const capFilter = limit != null ? sql`WHERE rn <= ${limit}` : sql``
  const tailRow =
    limit != null
      ? sql`
    UNION ALL
    -- The folded tail: one row, always last, carrying its own count so the
    -- label can name what it hides instead of a silent shortfall.
    SELECT NULL, NULL, NULL, COALESCE(SUM(cost_usd), 0)::text, COUNT(*)::int, 1,
           COALESCE(SUM(cost_usd), 0)
      FROM ranked WHERE rn > ${limit}
     HAVING COUNT(*) > 0`
      : sql``
  const rows = await db.execute<{
    project_id: string | null
    label: string | null
    code: string | null
    cost_usd: string
    remainder_projects: number
  }>(sql`
    WITH grouped AS (
      SELECT p.id AS project_id,
             COALESCE(p.display_name, p.code) AS label,
             p.code AS code,
             COALESCE(SUM(u.cost_usd), 0) AS cost_usd
        FROM ${axisLane} u
        LEFT JOIN project p ON p.id = u.project_id
       WHERE ${axisWindow}
         AND ${includePredicate(opts.excludeProvisional)}
         AND ${opts.scope}
       GROUP BY p.id, p.display_name, p.code
    ),
    ranked AS (
      -- Ranked over PROJECTS only; the untagged bucket is excluded here and
      -- re-joined below so a cap can never swallow it.
      SELECT g.*,
             ROW_NUMBER() OVER (ORDER BY g.cost_usd DESC NULLS LAST, g.label, g.project_id) AS rn
        FROM grouped g
       WHERE g.project_id IS NOT NULL
    )
    SELECT project_id::text AS project_id, label, code, cost_usd::text AS cost_usd,
           0 AS remainder_projects, 0 AS tail, cost_usd AS sort_usd
      FROM ranked ${capFilter}
    UNION ALL
    SELECT NULL, NULL, NULL, cost_usd::text, 0, 0, cost_usd
      FROM grouped WHERE project_id IS NULL${tailRow}
     -- sort_usd is the NUMERIC amount: ordering on the ::text cost_usd would rank
     -- "9.00" above "100.00" (lexicographic) and quietly mis-rank the whole axis.
     ORDER BY tail, sort_usd DESC NULLS LAST, label
  `)
  return [...rows].map((r) => ({
    projectId: r.project_id,
    label: r.label,
    code: r.code,
    costUsd: num(r.cost_usd),
    remainderProjects: Number(r.remainder_projects ?? 0),
  }))
}

/** {@link completeProjectSpend} for ONE project, defaulted to a zero row. */
export async function completeOneProjectSpend(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<ProjectSpendTotals> {
  const byProject = await completeProjectSpend(db, window, { ...opts, projectIds: [projectId] })
  return (
    byProject.get(projectId) ?? {
      costUsd: 0,
      tokens: 0,
      otelUsd: 0,
      reconciledUsd: 0,
      provisionalUsd: 0,
    }
  )
}

// ── Grain 2: per member ──────────────────────────────────────────────────────

/**
 * Per-member contribution to ONE project — the SAME lane, window and
 * provisional option as {@link completeProjectSpend}, so the team table always
 * foots to the headline above it. Cost-per-active-day is derived by the caller
 * from `activeDays` (AEUF's intensity metric) rather than duplicated in SQL.
 */
export async function completeProjectSpendByMember(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<ProjectMemberSpend[]> {
  const rows = await db.execute<{
    teammate_id: string
    display_name: string | null
    email: string
    cost_usd: string
    tokens: string
    active_days: string
    last_event: string | null
  }>(sql`
    SELECT u.teammate_id::text AS teammate_id,
           MAX(t.display_name) AS display_name,
           MAX(t.email) AS email,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd,
           COALESCE(SUM(u.tokens), 0)::text AS tokens,
           COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)::text AS active_days,
           MAX(u.ts_event)::text AS last_event
      FROM ${LANE} u
      JOIN teammate t ON t.id = u.teammate_id
     WHERE ${projectPredicate([projectId])}
       AND ${windowPredicate(window)}
       AND ${includePredicate(opts.excludeProvisional)}
     GROUP BY u.teammate_id
     ORDER BY SUM(u.cost_usd) DESC
  `)
  return [...rows].map((r) => ({
    teammateId: r.teammate_id,
    displayName: r.display_name,
    email: r.email,
    costUsd: num(r.cost_usd),
    tokens: num(r.tokens),
    activeDays: num(r.active_days),
    lastEvent: r.last_event,
  }))
}

// ── Grain 3: per activity ────────────────────────────────────────────────────

/**
 * Per-activity mix for ONE project — same lane, window and option, so the donut
 * foots to the headline. `activity` reaches this lane on BOTH taggable arms
 * (mig 0113); arm 3 never appears here because it carries no project_id.
 */
export async function completeProjectSpendByActivity(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<ProjectActivitySpend[]> {
  const rows = await db.execute<{ activity: string | null; cost_usd: string; tokens: string }>(sql`
    SELECT u.activity,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd,
           COALESCE(SUM(u.tokens), 0)::text AS tokens
      FROM ${LANE} u
     WHERE ${projectPredicate([projectId])}
       AND ${windowPredicate(window)}
       AND ${includePredicate(opts.excludeProvisional)}
     GROUP BY u.activity
     ORDER BY SUM(u.cost_usd) DESC
  `)
  return [...rows].map((r) => ({
    activity: r.activity,
    costUsd: num(r.cost_usd),
    tokens: num(r.tokens),
  }))
}

// ── Grain 4: the model axis (the project page's mix + stacked series) ────────

/**
 * Per-model mix for ONE project over a RESOLVED window — the project page's
 * `mix.by_model`, reading THE lane (arms 1+2 via `project_id`) instead of the
 * OTel-only `attribution_aggregate` (07-model-axis D7): a tagged fill day's
 * measured models (mig 0123 children, fanned out by mig 0124) appear beside
 * the emitted ones, so the mix stops contradicting the headline it sits under.
 *
 * Two generalisations from the donut era (developer-pages W3 D27.4):
 *
 *  1. WINDOW (r1-H9): takes the page's resolved `[startIso, endIso)` bounds —
 *     month or custom, the same window as the hero — instead of a trailing
 *     30/90-day parameter, so the breakdown can never sit beside a
 *     differently-windowed headline.
 *  2. SHAPE: rows are REASON-TYPED, keyed/labelled through the ONE classifier
 *     (`modelDriverKey`/`modelDriverLabel`, shared/reports/model-attribution.ts)
 *     and folded by that key exactly like the reporting model axis — a named
 *     model merges across provenances; remainders stay one row PER REASON so
 *     the Top-models coverage footer can price each reason separately. The
 *     ONE-shared-bucket fold this replaces was the composition DONUT's
 *     contract ("this is a composition donut, not the Top-models card"); the
 *     donut dies under fix 3 and the Top-models treatment takes over.
 *     `ModelSplitPanel`'s classifier sends every `__`-sentinel key to the
 *     footer, so a remainder can never become a category row.
 *
 * The provisional option is OPT-IN and defaults OFF, preserving every existing
 * caller: the aggregate read this replaced had no identity_state axis, so
 * omitting it was a data-source switch rather than a semantics change. A
 * MANAGER-FACING caller whose headline drops provisional spend must pass the
 * SAME option here (r3-H2) — the panel divides by the mix's own Σ, and a Σ that
 * counts money the headline above it does not is two totals on one card.
 */
export async function completeProjectModelMix(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
  opts: { excludeProvisional?: boolean } = {},
): Promise<ProjectModelRow[]> {
  const rows = await db.execute<{
    model: string | null
    usage_provenance: string | null
    gap_reason: string | null
    tokens: string
    cost_usd: string
  }>(sql`
    SELECT u.model, u.usage_provenance, u.model_gap_reason AS gap_reason,
           COALESCE(SUM(u.tokens), 0)::text AS tokens,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM ${LANE} u
     WHERE u.project_id = ${projectId}::uuid
       AND ${includePredicate(opts.excludeProvisional)}
       AND ${windowPredicate(window)}
     GROUP BY u.model, u.usage_provenance, u.model_gap_reason
  `)
  // FOLD BY DRIVER KEY (the engine/drivers.ts model-axis idiom): a named model
  // can arrive on more than one provenance and must be ONE row; remainder keys
  // are provenance+reason-scoped and never collide.
  const byKey = new Map<
    string,
    { key: string; label: string; usd: number; tokens: number; gap_reason: string | null }
  >()
  for (const r of [...rows]) {
    const key = modelDriverKey(r.model, r.usage_provenance, r.gap_reason)
    const cur = byKey.get(key)
    if (cur) {
      cur.usd += num(r.cost_usd)
      cur.tokens += num(r.tokens)
    } else {
      byKey.set(key, {
        key,
        label: modelDriverLabel(r.model, r.usage_provenance, r.gap_reason),
        usd: num(r.cost_usd),
        tokens: num(r.tokens),
        gap_reason: r.model ? null : (r.gap_reason ?? null),
      })
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label))
    .map((r) => ({
      key: r.key,
      label: r.label,
      cost_usd: r.usd.toFixed(2),
      tokens: r.tokens,
      gap_reason: r.gap_reason,
    }))
}

/**
 * Per-day × per-model spend for ONE project — `series_by_model` (the daily
 * burn stack), same lane, same resolved window (r1-H9) and the SAME
 * reason-aware fold as {@link completeProjectModelMix}, so the stack's keys
 * are exactly the mix's labels (the page passes the mix's label order as
 * `keyOrder`; a key the mix does not name would be silently dropped from the
 * stack). Day-ordered like the aggregate read it replaced; gap days absent.
 *
 * Takes the SAME opt-in `excludeProvisional` as the mix, and for the same reason
 * (r3-H2/r4-H2): this stack is a per-day DECOMPOSITION of the headline above it,
 * so a day whose bar counts money the headline drops is a second total on one
 * card. Off by default, preserving every existing caller.
 */
export async function completeProjectModelSeries(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
  opts: { excludeProvisional?: boolean } = {},
): Promise<ModelDaySpend[]> {
  const rows = await db.execute<{
    day: string
    model: string | null
    usage_provenance: string | null
    gap_reason: string | null
    cost_usd: string
  }>(sql`
    SELECT (u.ts_event AT TIME ZONE 'UTC')::date::text AS day,
           u.model, u.usage_provenance, u.model_gap_reason AS gap_reason,
           SUM(u.cost_usd)::text AS cost_usd
      FROM ${LANE} u
     WHERE u.project_id = ${projectId}::uuid
       AND ${includePredicate(opts.excludeProvisional)}
       AND ${windowPredicate(window)}
     GROUP BY 1, u.model, u.usage_provenance, u.model_gap_reason
     ORDER BY 1
  `)
  // Fold per (day, label) with the reason-aware label, mirroring the mix's
  // fold. Insertion order preserves the SQL's day ordering.
  const byKey = new Map<string, { day: string; model: string; cost: number }>()
  for (const r of [...rows]) {
    const model = modelDriverLabel(r.model, r.usage_provenance, r.gap_reason)
    const key = `${r.day}\u0000${model}`
    const cur = byKey.get(key)
    if (cur) cur.cost += num(r.cost_usd)
    else byKey.set(key, { day: r.day, model, cost: num(r.cost_usd) })
  }
  return [...byKey.values()].map((r) => ({
    day: r.day,
    model: r.model,
    cost_usd: r.cost.toFixed(2),
  }))
}

/**
 * Per-model mix for ONE TEAMMATE over a RESOLVED window — the /usage
 * Top-models panel's rows (developer-pages W2 D20). Same lane, same
 * reason-typed remainder folding as {@link completeProjectModelMix}, scoped by
 * `teammate_id` over arms 1+2+3 (arm 3 carries a teammate even though it
 * carries no project), and taking the page's resolved `[startIso, endIso)`
 * bounds (r1-H9) so the panel and its denominator always follow the window.
 *
 * Returns the rows PLUS the mix's own Σ — the denominator every figure in the
 * panel divides by (`ModelSplitPanel.denominatorUsd` is "the RESPONSE's own
 * headline for this axis", never the page headline).
 */
export async function completeTeammateModelMix(
  db: AnyDb,
  teammateId: string,
  window: SpendWindow,
  gate: RollupGate | null = null,
): Promise<{ rows: ProjectModelRow[]; totalUsd: number }> {
  // Same aliased source swap as completeProjectSpend: model, usage_provenance
  // and model_gap_reason are all in the rollup grain, so the GROUP BY is
  // answerable on both arms and the query's meaning is untouched.
  const mb = gate ? splitBounds(gate, window) : null
  const mixSource = gate && mb
    ? sql`(
        SELECT r.teammate_id, r.model, r.usage_provenance, r.model_gap_reason, r.tokens, r.cost_usd
          FROM usage_rollup_daily r
         WHERE r.day >= ${mb.rollupFrom}::date
           AND r.day <= ${mb.rollupTo}::date
        UNION ALL
        SELECT v.teammate_id, v.model, v.usage_provenance, v.model_gap_reason, v.tokens, v.cost_usd
          FROM ${LANE} v
         WHERE v.ts_event >= ${mb.liveFrom}::timestamptz
           AND v.ts_event <  ${window.endIso}::timestamptz
      )`
    : sql`${LANE}`
  const rows = await db.execute<{
    model: string | null
    usage_provenance: string | null
    gap_reason: string | null
    tokens: string
    cost_usd: string
  }>(sql`
    SELECT u.model, u.usage_provenance, u.model_gap_reason AS gap_reason,
           COALESCE(SUM(u.tokens), 0)::text AS tokens,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM ${mixSource} u
     WHERE u.teammate_id = ${teammateId}::uuid
       -- On the BOUNDS, not the gate: see completeProjectSpend above.
       AND ${mb ? sql`TRUE` : windowPredicate(window)}
     GROUP BY u.model, u.usage_provenance, u.model_gap_reason
  `)
  // Fold by driver key (the engine/drivers.ts model-axis idiom): a named model
  // merges across provenances; remainder keys are provenance+reason-scoped and
  // never collide — one row PER REASON, so the coverage footer prices each.
  const byKey = new Map<
    string,
    { key: string; label: string; usd: number; tokens: number; gap_reason: string | null }
  >()
  for (const r of [...rows]) {
    const key = modelDriverKey(r.model, r.usage_provenance, r.gap_reason)
    const cur = byKey.get(key)
    if (cur) {
      cur.usd += num(r.cost_usd)
      cur.tokens += num(r.tokens)
    } else {
      byKey.set(key, {
        key,
        label: modelDriverLabel(r.model, r.usage_provenance, r.gap_reason),
        usd: num(r.cost_usd),
        tokens: num(r.tokens),
        gap_reason: r.model ? null : (r.gap_reason ?? null),
      })
    }
  }
  const folded = [...byKey.values()].sort(
    (a, b) => b.usd - a.usd || a.label.localeCompare(b.label),
  )
  return {
    rows: folded.map((r) => ({
      key: r.key,
      label: r.label,
      cost_usd: r.usd.toFixed(2),
      tokens: r.tokens,
      gap_reason: r.gap_reason,
    })),
    totalUsd: folded.reduce((a, r) => a + r.usd, 0),
  }
}

// ── Grain 5: per day (the /projects card sparklines) ─────────────────────────

/** One day of a project's windowed daily spend (gap days absent). */
export interface ProjectDaySpend {
  day: string
  costUsd: number
}

/**
 * Per-day §A spend for MANY projects in ONE round trip — the /projects card
 * sparklines (developer-pages W3 D26): the same lane, window and provisional
 * option as the card's MTD figure ({@link completeProjectSpend}), so the shape
 * drawn under the number is the number's own shape, not the OTel-only
 * rollup's. A project with no spend in the window is absent from the map.
 */
export async function completeProjectDailySpend(
  db: AnyDb,
  window: SpendWindow,
  opts: ProjectSpendOptions = {},
): Promise<Map<string, ProjectDaySpend[]>> {
  if (opts.projectIds && opts.projectIds.length === 0) return new Map()
  const rows = await db.execute<{ project_id: string; day: string; cost_usd: string }>(sql`
    SELECT u.project_id::text AS project_id,
           (u.ts_event AT TIME ZONE 'UTC')::date::text AS day,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM ${LANE} u
     WHERE ${windowPredicate(window)}
       AND ${projectPredicate(opts.projectIds)}
       AND ${includePredicate(opts.excludeProvisional)}
     GROUP BY u.project_id, 2
     ORDER BY 2
  `)
  const out = new Map<string, ProjectDaySpend[]>()
  for (const r of [...rows]) {
    const list = out.get(r.project_id) ?? []
    list.push({ day: r.day, costUsd: num(r.cost_usd) })
    out.set(r.project_id, list)
  }
  return out
}

// ── Grain 6: the caller's own contribution (the /projects list band) ─────────

/**
 * ONE teammate's per-project §A spend over a window (developer-pages W3 D25:
 * the "yours $X · N%" line and the list band's Σ). Same lane and window as the
 * project totals; pass the SAME `excludeProvisional` the card totals use, or a
 * caller's share can exceed 100% of the figure printed beside it.
 * Projects the teammate did not touch in the window are absent from the map.
 */
export async function completeTeammateProjectSpend(
  db: AnyDb,
  teammateId: string,
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<Map<string, number>> {
  const rows = await db.execute<{ project_id: string; cost_usd: string }>(sql`
    SELECT u.project_id::text AS project_id,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM ${LANE} u
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.project_id IS NOT NULL
       AND ${windowPredicate(window)}
       AND ${includePredicate(opts.excludeProvisional)}
     GROUP BY u.project_id
  `)
  return new Map([...rows].map((r) => [r.project_id, num(r.cost_usd)]))
}

/**
 * The caller's own TAGGABLE-but-untagged §A spend over a window — the list
 * band's "$X untagged → worklist" pull-through (W3 D25). Arms 1-2 only
 * (`usage_provenance <> 'provider-usage'`): arm 3 is untaggable by
 * construction (mig 0101), so it is not worklist pressure. Provisional rows
 * are INCLUDED — this is a self figure about the caller's own work-to-tag
 * (the getMyUsage audience rule), not a manager-facing budget operand.
 */
export async function completeTeammateUntaggedSpend(
  db: AnyDb,
  teammateId: string,
  window: SpendWindow,
): Promise<number> {
  const rows = await db.execute<{ cost_usd: string }>(sql`
    SELECT COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM ${LANE} u
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.project_id IS NULL
       AND u.usage_provenance <> 'provider-usage'
       AND ${windowPredicate(window)}
  `)
  return num([...rows][0]?.cost_usd)
}

// ── The excluded bucket: what a project total cannot carry ───────────────────

/**
 * Arm-3 spend by ONE project's members, during their membership window — the
 * money that is genuinely theirs and that NO project figure on any lane can
 * ever include (mig 0101: `project_id` is NULL by construction on that arm).
 *
 * NOT ADDITIVE across projects — see {@link ProjectLaneExclusions}.
 *
 * EXISTS rather than a JOIN: overlapping assignment windows for one member must
 * not multiply the same row into a phantom total (the same rule
 * `fetchUntaggedPressure` follows). Note that this de-duplicates WITHIN one
 * project only; the same dollar legitimately appears under every project the
 * member belongs to, which is what makes the figure non-additive.
 */
export async function completeProjectMemberLaneExclusions(
  db: AnyDb,
  projectId: string,
  window: SpendWindow,
): Promise<ProjectLaneExclusions> {
  const rows = await db.execute<{ cost_usd: string; tools: string[] | null }>(sql`
    SELECT COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd,
           -- ORDER BY, not just DISTINCT. array_agg's output order is unspecified;
           -- DISTINCT happens to sort today as an implementation detail of how it
           -- dedupes, and this array is rendered into a sentence, so relying on that
           -- would put a snapshot's stability on an unpromised behaviour.
           array_agg(DISTINCT u.tool ORDER BY u.tool) AS tools
      FROM ${LANE} u
     WHERE u.usage_provenance = 'provider-usage'
       AND ${windowPredicate(window)}
       AND EXISTS (
             SELECT 1 FROM project_assignment pa
              WHERE pa.teammate_id = u.teammate_id
                AND pa.project_id = ${projectId}::uuid
                AND pa.effective @> u.ts_event
           )
  `)
  const r = [...rows][0]
  return { memberIngestOnlyUsd: num(r?.cost_usd), memberIngestOnlyTools: r?.tools ?? [] }
}

const ZERO_RESIDUAL: CostCentreLaneResidual = {
  burnUsd: 0,
  ingestOnlyUsd: 0,
  untaggedUsd: 0,
  foreignProjectUsd: 0,
  offCentreUsd: 0,
  memberUntaggedUsd: 0,
}

/**
 * The cost-centre→project sum-back (consistency contract §6.3) for MANY cost
 * centres in ONE round trip. See {@link CostCentreLaneResidual} for the identity
 * it closes; pass the SAME window and provisional option the project figures
 * used, or the identity is being asserted across two different questions.
 *
 * Batched because the P&L card renders every cost centre a person owns, and a
 * per-centre call made the response N× a lane scan for no reason: the terms are
 * a GROUP BY on a set of ids, not N independent questions.
 *
 * A cost centre with no §A activity is ABSENT from the map — callers default to
 * {@link zeroCostCentreResidual}.
 */
export async function completeCostCentreProjectResiduals(
  db: AnyDb,
  costOwningUnitIds: readonly string[],
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<Map<string, CostCentreLaneResidual>> {
  if (costOwningUnitIds.length === 0) return new Map()
  const ccs = sql`ARRAY[${sql.join(
    costOwningUnitIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const keep = includePredicate(opts.excludeProvisional)

  /*
   * ONE row can belong to TWO of these cost centres at once — homed at A while
   * tagged to a project B leads is `foreignProject` for A and `offCentre` for B
   * — so the row is fanned out over its (at most two) candidate centres by the
   * LATERAL below rather than being assigned to one. A plain `GROUP BY
   * u.cost_owning_unit_id` would silently drop the second half of every
   * cross-centre pair, which is the exact money these terms exist to name.
   */
  const rows = await db.execute<{
    cou_id: string
    burn: string
    ingest_only: string
    untagged: string
    foreign_project: string
    off_centre: string
  }>(sql`
    WITH scoped AS (
      SELECT u.cost_usd,
             u.usage_provenance,
             u.project_id,
             u.cost_owning_unit_id AS home_cou,
             p.cost_owning_unit_id AS proj_cou
        FROM ${LANE_CURRENT} u
        LEFT JOIN project p ON p.id = u.project_id
       WHERE ${windowPredicate(window)}
         AND ${keep}
         AND (u.cost_owning_unit_id = ANY(${ccs}) OR p.cost_owning_unit_id = ANY(${ccs}))
    )
    SELECT c.cc::text AS cou_id,
      COALESCE(SUM(s.cost_usd) FILTER (WHERE s.home_cou = c.cc), 0)::text AS burn,
      COALESCE(SUM(s.cost_usd) FILTER (
        WHERE s.home_cou = c.cc AND s.usage_provenance = 'provider-usage'), 0)::text AS ingest_only,
      COALESCE(SUM(s.cost_usd) FILTER (
        WHERE s.home_cou = c.cc AND s.project_id IS NULL
          AND s.usage_provenance <> 'provider-usage'), 0)::text AS untagged,
      COALESCE(SUM(s.cost_usd) FILTER (
        WHERE s.home_cou = c.cc AND s.project_id IS NOT NULL
          AND s.proj_cou IS DISTINCT FROM c.cc), 0)::text AS foreign_project,
      COALESCE(SUM(s.cost_usd) FILTER (
        WHERE s.proj_cou = c.cc AND s.home_cou IS DISTINCT FROM c.cc), 0)::text AS off_centre
      FROM scoped s
      CROSS JOIN LATERAL (
        SELECT DISTINCT x AS cc
          FROM unnest(ARRAY[s.home_cou, s.proj_cou]) AS x
         WHERE x = ANY(${ccs})
      ) c
     GROUP BY c.cc
  `)

  /*
   * The teammate-axis term, deliberately its OWN statement. It keys on the
   * spender's home cost centre — a dimension the identity query never joins —
   * so folding it in would widen that query's WHERE and let teammate-homed rows
   * leak into the project-homed terms.
   */
  const memberRows = await db.execute<{ cou_id: string; member_untagged: string }>(sql`
    SELECT home.id::text AS cou_id,
           COALESCE(SUM(u.cost_usd), 0)::text AS member_untagged
      FROM ${LANE} u
      JOIN teammate t ON t.id = u.teammate_id
      JOIN org_unit tou ON tou.id = t.org_unit_id
      LEFT JOIN LATERAL (
        SELECT anc.id FROM org_unit anc
         WHERE anc.path @> tou.path
           AND anc.is_cost_owning_unit
           AND anc.region_id = tou.region_id
         ORDER BY nlevel(anc.path) DESC
         LIMIT 1
      ) home ON TRUE
     WHERE ${windowPredicate(window)}
       AND ${keep}
       AND u.project_id IS NULL
       AND u.cost_owning_unit_id IS NULL
       AND u.usage_provenance <> 'provider-usage'
       AND home.id = ANY(${ccs})
     GROUP BY home.id
  `)
  const memberByCc = new Map([...memberRows].map((r) => [r.cou_id, num(r.member_untagged)]))

  const out = new Map<string, CostCentreLaneResidual>()
  for (const r of [...rows]) {
    out.set(r.cou_id, {
      burnUsd: num(r.burn),
      ingestOnlyUsd: num(r.ingest_only),
      untaggedUsd: num(r.untagged),
      foreignProjectUsd: num(r.foreign_project),
      offCentreUsd: num(r.off_centre),
      memberUntaggedUsd: memberByCc.get(r.cou_id) ?? 0,
    })
  }
  // A centre whose ONLY §A money is untagged has no row in the identity query
  // (nothing is homed to it and no project of its leads spent) — it must still
  // report that money rather than be absent.
  for (const [ccId, usd] of memberByCc) {
    if (!out.has(ccId)) out.set(ccId, { ...ZERO_RESIDUAL, memberUntaggedUsd: usd })
  }
  return out
}

/** The all-zero residual — what a cost centre with no §A activity reconciles to. */
export function zeroCostCentreResidual(): CostCentreLaneResidual {
  return { ...ZERO_RESIDUAL }
}

/** {@link completeCostCentreProjectResiduals} for ONE cost centre. */
export async function completeCostCentreProjectResidual(
  db: AnyDb,
  costOwningUnitId: string,
  window: SpendWindow,
  opts: Omit<ProjectSpendOptions, 'projectIds'> = {},
): Promise<CostCentreLaneResidual> {
  const byCc = await completeCostCentreProjectResiduals(db, [costOwningUnitId], window, opts)
  return byCc.get(costOwningUnitId) ?? zeroCostCentreResidual()
}
