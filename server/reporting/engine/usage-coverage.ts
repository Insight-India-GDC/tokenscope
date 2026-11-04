/*
 * §A budget coverage, scope-parameterised — the denominator a reporting surface
 * publishes beside the total it qualifies.
 *
 * WHY. Under 5% of enterprise consumption is on a budgeted project, so every
 * budget-shaped figure is a small fraction of real consumption and nothing on
 * screen said so ("Four — make reports honest about coverage",
 * docs/design/reporting-stakeholder-visibility/00-decisions.md §5b). This answers
 * the one question that closes that gap for a given scope and window: how much of
 * the consumption is inside the budget lens, and how much is outside it.
 *
 * ── SAME LANE, SAME WINDOW, SAME CLAMP AS THE HEADLINE ───────────────────────
 * ONE scan of usage_rollup_daily (the day-grain §A rollup the headline itself
 * reads — usage-rollup-lane.md R5; `project_id` and `usage_provenance` are both
 * in the rollup grain, so every FILTER below tests a cell dim, never a per-row
 * measure), clamped by the caller's UsageScope over the same
 * window the surface's own KPI used. That is what makes `totalUsd` the surface's
 * headline rather than a second opinion about it: the four parts are FILTER
 * aggregates over the same scan, so they foot to the total by construction and
 * cannot drift from it.
 *
 * NOT a project-spend producer, so it is deliberately absent from the PRODUCERS
 * list in tests/unit/server/project-spend-one-lane.test.ts. It publishes no
 * project's spend: `budgetedUsd` is a scope-grain aggregate over the budget
 * PREDICATE, never a per-project total, and no caller can decompose it back to
 * one. "Project spend this month" still has exactly one source
 * (server/usage/complete-spend.ts) and this module does not touch it, nor does it
 * move any lane read out of a pinned file — it adds a new one here.
 *
 * SEPARATE FROM usage-series.ts for the reason chargeback-series.ts is separate:
 * this one joins `allocation`, and the budget axis is a different question from
 * "what did this scope consume". Keeping it here means a change to what "budgeted"
 * means is one file, greppable, rather than a clause buried in a series query.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { UsageBudgetCoverage } from '#shared/reports/types'
import type { UsageWindow } from '../params'
import { scopeSql, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

const num = (v: unknown): number => Number(v ?? 0)

/**
 * The §A budget-coverage decomposition for one scope and window.
 *
 * `scopeLabel` IS AN ARGUMENT, not an inference, and it is required rather than
 * optional. The copy beside these figures names the scope they were summed over, and
 * the only place that name is knowable is the resolver that built `scope` — the
 * predicate is an opaque SQL fragment by the time it reaches here, and it is opaque
 * again by the time the number reaches a component. Requiring it means a new producer
 * of these figures cannot ship without deciding whose money it is publishing, which is
 * how the previous version got it wrong: the component guessed from `drill ?? region`
 * and named the whole region above one manager's subtree. Pass `null` ONLY when the
 * clamp genuinely resolves to no scope at all (see UsageBudgetCoverage.scopeLabel).
 *
 * The lane is aliased `u` and clamps must address `u.`-qualified columns (`u.teammate_id`, `u.cost_owning_unit_id`)
 * — the same contract `fetchDailyMetrics` has with its callers, and not cosmetic:
 * the query LEFT JOINs a second relation, so an unqualified column in a
 * caller's predicate would be ambiguous rather than merely untidy.
 *
 * PROVISIONAL IDENTITY IS INCLUDED, deliberately. The project-spend seam offers
 * `excludeProvisional` because a manager-facing project figure must not move on an
 * unconfirmed device binding; a reporting headline has no such option and counts
 * every row. This qualifies THAT headline, so it must count the same rows — an
 * exclusion here would make the parts stop footing to the total they sit beside.
 *
 * BUDGETED = a POOL allocation (see below) of kind `baseline` or `top-up`, on the
 * PROJECT axis, carrying a non-zero amount, whose effective range OVERLAPS the window
 * (`&&`) rather than containing a single instant. Each of those clauses is load-bearing:
 *
 *   - `scope_type = 'project'` — `allocation.scope_id` is a bare uuid with no FK, and
 *     the same table holds region/platform/teammate-scoped rows. Without the clamp a
 *     region budget whose id collided with a project's would fund that project.
 *   - `allocation_kind IN ('baseline','top-up')` — a top-up IS budget (D10: one budget
 *     axis, the project); a baseline-only predicate would report a topped-up project
 *     as unbudgeted.
 *   - `budget_usd > 0` — see below.
 *   - OVERLAP — a budget raised or first set mid-window is real budget for that window;
 *     `budget-alert` applies the same overlap rule to top-ups for the same reason.
 *
 * A $0 ALLOCATION IS NOT A BUDGET, decided here. Nothing stops one being written —
 * `budget_usd` is NUMERIC(14,2) NOT NULL with no positivity check, and both write
 * paths (`BudgetUsdSchema`, split.post.ts's cap regex) accept "0" — so the question
 * has an answer either way and silence would pick one by accident. It is excluded,
 * because the covered figure is read through the copy beside it: "is on a project
 * that had a budget for it". A project allocated $0 had no budget for it, and
 * counting it would move real spend into the covered bucket and overstate exactly
 * the share this decomposition exists to keep honest ("Four — make reports honest
 * about coverage"). ADR 0012's follow-up names the same shape as a defect in the
 * quota model: contributed-but-unbudgeted projects counted into a numerator with
 * $0 behind them, inflating the percentage. Its spend is reported as
 * tagged-but-unbudgeted, which is what it is.
 *
 * DISTINCT in the CTE so a project with a baseline AND two top-ups joins once —
 * without it, its spend would be counted three times and the parts would over-foot
 * the total.
 *
 * POOL ROWS ONLY (`teammate_id IS NULL`). A per-developer cap (mig 0008: a
 * project-scoped row carrying a `teammate_id`) is one member's share of the pool it
 * sits under, not a budget of its own. The split writes caps over the pool's exact
 * period and keeps sum(caps) within the pool, a pool period edit moves them with it,
 * and budget-request approval raises the cap with the pool's period. So any project
 * with a cap over $0 in the window has a pool row that already answers the question;
 * counting caps would only add a stranded cap with no pool behind it, which is not a
 * budget. It is the same filter the project budget figure uses
 * (fetchProjectAllocations in server/usage/consumption.ts).
 *
 * What that does NOT claim: coverage is measured at PROJECT grain. Spend by a
 * developer who has no cap of their own on a per_dev_fixed project lands in the
 * covered bucket, because the predicate is "had a budget for it", a membership
 * test, not "was within budget", an adequacy one. Adequacy is the budget-alert
 * surface's question, not this one's. tests/integration/reports/usage-budget-
 * coverage.test.ts pins the stranded-cap case.
 */
export async function fetchUsageBudgetCoverage(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
  scopeLabel: string | null,
): Promise<UsageBudgetCoverage> {
  const [row] = [
    ...(await tx.execute<{
      total: string
      budgeted: string
      tagged_no_budget: string
      untagged: string
      untaggable: string
    }>(sql`
      WITH budgeted_project AS (
        SELECT DISTINCT al.scope_id AS project_id
          FROM allocation al
         WHERE al.scope_type = 'project'
           AND al.teammate_id IS NULL
           AND al.allocation_kind IN ('baseline', 'top-up')
           AND al.budget_usd > 0
           AND al.effective && tstzrange(${window.startIso}::timestamptz, ${window.endIso}::timestamptz, '[)')
      )
      SELECT COALESCE(SUM(u.cost_usd), 0)::text AS total,
             COALESCE(SUM(u.cost_usd) FILTER (
               WHERE u.project_id IS NOT NULL AND bp.project_id IS NOT NULL), 0)::text AS budgeted,
             COALESCE(SUM(u.cost_usd) FILTER (
               WHERE u.project_id IS NOT NULL AND bp.project_id IS NULL), 0)::text AS tagged_no_budget,
             -- The two NULL-project terms split on provenance, NOT on "everything
             -- else": arm 3 is untaggable by construction (mig 0101) and calling it
             -- untagged would report a structural absence as a bookkeeping gap.
             COALESCE(SUM(u.cost_usd) FILTER (
               WHERE u.project_id IS NULL AND u.usage_provenance <> 'provider-usage'), 0)::text AS untagged,
             COALESCE(SUM(u.cost_usd) FILTER (
               WHERE u.project_id IS NULL AND u.usage_provenance = 'provider-usage'), 0)::text AS untaggable
        FROM v_usage_rollup_current u
        LEFT JOIN budgeted_project bp ON bp.project_id = u.project_id
       WHERE ${scopeSql(scope)}
         AND u.day >= ${window.startIso.slice(0, 10)}::date
         AND u.day <  ${window.endIso.slice(0, 10)}::date`)),
  ]
  return {
    scopeLabel,
    totalUsd: num(row?.total),
    budgetedUsd: num(row?.budgeted),
    taggedNoBudgetUsd: num(row?.tagged_no_budget),
    untaggedUsd: num(row?.untagged),
    untaggableUsd: num(row?.untaggable),
  }
}
