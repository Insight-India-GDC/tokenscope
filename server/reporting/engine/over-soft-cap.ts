/*
 * §A unallocated spend over the SOFT CAP, scope-parameterised — the cost-centre
 * lead's conversation list (docs/design/reporting-consolidation/04-prototype-delta.md
 * §5, order item 2).
 *
 * THE CLAIM: unallocated spend over the soft cap should be on a budget.
 *
 * ── THE CAP IS AN EXISTING POLICY, NOT A THRESHOLD INVENTED HERE ─────────────
 * `NUXT_BASE_ALLOWANCE_USD` (server/utils/base-allowance.ts, default 100) is ONE
 * GLOBAL CONSTANT, and the developer's own page already badges `over_soft_cap`
 * against it per person (server/utils/me-queries.ts). This applies the SAME policy
 * to the manager's view, through the SAME function, with the SAME `>=` comparison
 * — a `>` here would list a developer as within allowance whose own page badges
 * them Over, and neither reader could tell which surface was lying.
 *
 * Two earlier drafts of this card invented gates — a $250 materiality floor, then a
 * 60% tagging rate. Both were guesses and both were unnecessary. THE RATE IS NOT A
 * GATE: someone tagging 88% of a large total can still leave 8× the cap
 * unallocated, and filtering on the rate would drop exactly the heavy user who most
 * needs the nudge. Only the cap gates; the rate rides along as context.
 *
 * ── ROSTER-ANCHORED, NOT BURN-ANCHORED ──────────────────────────────────────
 * The obvious query — scan `v_complete_usage WHERE cost_owning_unit_id = <cc>` —
 * is wrong for this card, and wrong in the direction that hides the problem.
 * `cost_owning_unit_id` on the §A lane is the cost centre OF THE TAGGED PROJECT
 * (server/usage/complete-spend.ts), so:
 *
 *   - the reconciled arm (`unaccounted_usage`, mig 0101/0113) carries NULL there BY
 *     CONSTRUCTION — every Copilot reconciliation row included;
 *   - untagged emitted spend carries NULL there too, because there is no project to
 *     take a cost centre from.
 *
 * A burn-anchored scan therefore omits, specifically and silently, the people whose
 * spend is not on a budget — which is the entire population this card exists to
 * surface. So the FROM clause is the ROSTER (teammate placement), usage is LEFT
 * JOINed onto it, and the denominator is named separately from project burn
 * (`rosterUsd`, never "burn") so no reader can reconcile the two and conclude one is
 * broken.
 *
 * ── THE CLAMP ADDRESSES `t`, THE ROSTER — NOT `u`, THE USAGE LANE ───────────
 * Every other §A engine primitive takes a clamp over the usage lane `u` (the
 * current-lens views). This one takes a clamp over `t.region_id` / `t.org_unit_id`
 * on the `teammate` roster: the people, not their rows. The alias difference is
 * what keeps the two from being confused: `u` is not in scope where this
 * predicate is applied, so a clamp written for the usage lane raises "missing
 * FROM-clause entry for table u" rather than silently answering a different one.
 *
 * That is why the scope predicate is applied at the OUTER level only. Pushing it
 * into the usage sub-select would put `u` in scope beside `t` and turn that loud
 * failure into a silent correlated capture.
 *
 * ── NO ACTION BUTTONS, AND THE RETURNED SHAPE CARRIES NONE ──────────────────
 * `tagUnaccountedTx` (server/utils/tag-unaccounted.ts) permits only a record's OWN
 * teammate to tag it, so a cost-centre owner cannot action another person's row.
 * Nothing here returns a record id, an action or an affordance — the payload is a
 * name, an amount and a reason to make contact.
 *
 * ── LANE ────────────────────────────────────────────────────────────────────
 * Pure §A: `v_complete_usage` for the money, `teammate` / `project_assignment` /
 * `project` for the population and the memberships. No bill-lane figure is an
 * operand (consistency contract C2), and no raw ledger table is read (the lane
 * firewall, tests/unit/server/reports-lane-firewall.test.ts).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { OverSoftCap, OverSoftCapRow } from '#shared/reports/types'
import { endedProjectExpr } from '../../db/project-predicates'
import { baseAllowanceUsd } from '../../utils/base-allowance'
import type { UsageWindow } from '../params'
import {
  TEAMMATE_DRILL_FACTS,
  teammateDrillFacts,
  type TeammateDrillFactRow,
} from '../teammate-drill-facts'
import { scopeSql, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

const num = (v: unknown): number => Number(v ?? 0)

/** One roster member as the query returns them, before the cap is applied. */
interface RosterRow extends Record<string, unknown>, TeammateDrillFactRow {
  teammate_id: string
  teammate: string
  total_usd: string
  allocated_usd: string
  unallocated_usd: string
  projects: string
}

/**
 * Unallocated spend over the soft cap for one scope and window.
 *
 * @param scope  A §A clamp addressing **`t.region_id` / `t.org_unit_id`** on the
 *               `teammate` roster (current placement). See the module header.
 *
 * ── WHAT THIS PRIMITIVE DECIDES, AND WHAT THE CALLER DECIDES ────────────────
 * The caller's scope decides WHICH cost centre. Everything else is policy and lives
 * here, once, so no caller can ship a variant of it:
 *
 *   - `t.is_active = TRUE`. A roster is the people who are HERE. This is the same
 *     definition of occupancy the rest of the product already uses for a unit's
 *     headcount (server/api/v1/admin/org-units.get.ts counts placements with
 *     `is_active = TRUE`; org-units/[id].delete.ts guards on "the home of any ACTIVE
 *     teammate"), so `rosterCount` IS the cost centre's placement count rather than a
 *     second, differently-drawn population. The consequence is stated rather than
 *     hidden: a deactivated leaver's unallocated spend is not in `rosterUsd`. That is
 *     deliberate — every row on this card is a person to contact, and a leaver is not
 *     one — and `rosterUsd` is named as the roster's total, never as the centre's.
 *
 *   - UNALLOCATED = `project_id IS NULL`, over ALL THREE §A arms. Identical to the
 *     definition the developer's own page sums (getUnallocatedSummary reads arms 1
 *     and 2 from their own tables for the worklist identity it needs, and arm 3
 *     through this same view), so the number a manager reads is the number the
 *     developer sees. Arm 3 IS included even though it is untaggable: the developer's
 *     own unallocated total counts it (ADR 0012 decision 1a), so excluding it here
 *     would put a smaller figure in front of the manager than the person they are
 *     about to call is looking at.
 *
 *   - ACTIVE MEMBERSHIP = `effective @> now()` AND NOT `endedProjectExpr` — the SAME
 *     two gates `tagUnaccountedTx` applies before it will accept a tag. Evaluated at
 *     `now()`, not over the window, because the question is "could they tag this
 *     today", which is a fact about now. That agreement is the whole point of the
 *     split: a nudge sent to someone whose only projects have ENDED is an instruction
 *     they cannot follow — the write path would 409 them — so they belong in
 *     `on-no-project`, where the action is a PM's.
 *
 * ── THE TWO IDENTITIES THIS RETURNS, AND WHY THEY HOLD ──────────────────────
 *   `allocatedUsd + unallocatedUsd = rosterUsd` — two FILTER aggregates over one
 *   scan, split on a NOT NULL / IS NULL pair, so they partition by construction.
 *
 *   `over.length + withinAllowance.teammates = rosterCount` — every roster row takes
 *   exactly one branch of one `if` below. Mutually exclusive and exhaustive.
 */
export async function fetchOverSoftCap(
  tx: Tx,
  scope: UsageScope,
  window: UsageWindow,
): Promise<OverSoftCap> {
  const softCapUsd = baseAllowanceUsd()

  const rows = [
    ...(await tx.execute<RosterRow>(sql`
      WITH roster AS (
        SELECT t.id AS teammate_id,
               COALESCE(NULLIF(t.display_name, ''), t.email) AS teammate,
               -- THE DRILL FACTS, from the ONE shared producer
               -- (reporting/teammate-drill-facts.ts) -- never inferred by the card.
               -- (No backticks anywhere in this literal -- see the note in
               -- active_membership below.)
               --
               -- drill_is_active is redundant with the is_active = TRUE filter
               -- below, and is carried anyway ON PURPOSE (r5-H1). The card used to
               -- hard-code isActive: true and justify it by quoting that filter;
               -- that made a CLIENT decision depend on a SERVER predicate nothing
               -- rechecks, so loosening the roster would silently start rendering
               -- live links onto pages that 403. drill_is_provisional is the fact
               -- that was missing outright: a provisional shadow IS active, so it
               -- passed every conjunct this card could see.
               ${TEAMMATE_DRILL_FACTS}
          FROM teammate t
         WHERE t.is_active = TRUE
           AND ${scopeSql(scope)}
      ),
      -- The teammate's OWN §A total for the window, wherever it was homed. NOT
      -- clamped by the scope: this card asks "how much of this person's spend has
      -- no budget on it", and a person's spend is a fact about them. Re-applying a
      -- cost-centre clamp here would reintroduce the burn anchoring the roster
      -- exists to replace, and would report an unallocated figure smaller than the
      -- one the teammate's own page shows them.
      usage AS (
        SELECT u.teammate_id,
               COALESCE(SUM(u.cost_usd), 0) AS total_usd,
               COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NOT NULL), 0) AS allocated_usd,
               COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NULL), 0) AS unallocated_usd
          FROM v_complete_usage u
         WHERE u.teammate_id IN (SELECT teammate_id FROM roster)
           AND u.ts_event >= ${window.startIso}::timestamptz
           AND u.ts_event <  ${window.endIso}::timestamptz
         GROUP BY u.teammate_id
      ),
      -- COUNT(DISTINCT p.id), not COUNT(*): the assignment table's exclusion
      -- constraint forbids OVERLAPPING ranges for one (project, teammate) but not
      -- adjacent ones, so a re-assigned member can hold several rows for one project
      -- and only one of them can satisfy the effective test -- but DISTINCT is what
      -- makes that a property of the query rather than of the constraint.
      -- (No backticks anywhere in this literal: one inside a SQL comment CLOSES the
      -- sql template and the parse error points at the wrong line.)
      active_membership AS (
        SELECT pa.teammate_id, COUNT(DISTINCT p.id) AS projects
          FROM project_assignment pa
          JOIN project p ON p.id = pa.project_id
         WHERE pa.teammate_id IN (SELECT teammate_id FROM roster)
           AND pa.effective @> now()
           AND NOT ${endedProjectExpr('p')}
         GROUP BY pa.teammate_id
      )
      SELECT r.teammate_id::text AS teammate_id,
             r.teammate,
             r.drill_is_active,
             r.drill_is_provisional,
             COALESCE(us.total_usd, 0)::text       AS total_usd,
             COALESCE(us.allocated_usd, 0)::text   AS allocated_usd,
             COALESCE(us.unallocated_usd, 0)::text AS unallocated_usd,
             COALESCE(am.projects, 0)::text        AS projects
        FROM roster r
        LEFT JOIN usage us            ON us.teammate_id = r.teammate_id
        LEFT JOIN active_membership am ON am.teammate_id = r.teammate_id
       -- Ranked by the figure the card is about. The name breaks ties so the order
       -- is total and the CSV is reproducible between two identical requests.
       ORDER BY COALESCE(us.unallocated_usd, 0) DESC, r.teammate ASC`)),
  ]

  const over: OverSoftCapRow[] = []
  let rosterUsd = 0
  let allocatedUsd = 0
  let unallocatedUsd = 0
  let withinTeammates = 0
  let withinUnallocatedUsd = 0
  let fullyAllocated = 0

  for (const r of rows) {
    const total = num(r.total_usd)
    const allocated = num(r.allocated_usd)
    const unallocated = num(r.unallocated_usd)
    const projects = Number(r.projects)
    rosterUsd += total
    allocatedUsd += allocated
    unallocatedUsd += unallocated

    /*
     * `>=`, matching the shipped policy exactly (me-queries.ts `over_soft_cap`).
     *
     * `unallocated > 0` is a ZERO-DOLLAR GUARD, not a second threshold. For every
     * cap above $0 it is implied by the comparison beside it and changes nothing.
     * It bites only in the degenerate `NUXT_BASE_ALLOWANCE_USD=0` configuration,
     * where `>= 0` is true of every roster member and the card would otherwise list
     * the entire cost centre at $0.00 each — a page of people to contact about
     * nothing. A row on this card must always name money.
     */
    if (unallocated >= softCapUsd && unallocated > 0) {
      over.push({
        teammateId: r.teammate_id,
        teammate: r.teammate,
        // The drill contract's two client-unknowable conjuncts (D34), carried on
        // the ROW so the card renders a name as a link or as plain text BY FACT.
        // The row itself stays either way: this card's identities (`over.length +
        // withinAllowance.teammates = rosterCount`) are the reason it cannot just
        // drop an unconfirmed subject to close the door.
        ...teammateDrillFacts(r),
        unallocatedUsd: unallocated,
        // No multiple of zero exists. Reporting Infinity (which JSON renders as
        // null anyway) or a fabricated 0 would both be false statements.
        capMultiple: softCapUsd > 0 ? unallocated / softCapUsd : null,
        // Denominator is non-zero on this branch: unallocated > 0 ⇒ total > 0.
        taggedRate: total > 0 ? allocated / total : 0,
        projects,
        group: projects > 0 ? 'on-projects' : 'on-no-project',
      })
    } else {
      withinTeammates += 1
      withinUnallocatedUsd += unallocated
      // FULLY ALLOCATED means "spent, and all of it is on a budget" — `total > 0`
      // is load-bearing. Someone with no spend at all has allocated nothing; folding
      // them in would let a cost centre where nobody used anything report its whole
      // roster as a tagging success.
      if (total > 0 && unallocated === 0) fullyAllocated += 1
    }
  }

  return {
    softCapUsd,
    rosterCount: rows.length,
    rosterUsd,
    allocatedUsd,
    unallocatedUsd,
    over,
    withinAllowance: {
      teammates: withinTeammates,
      unallocatedUsd: withinUnallocatedUsd,
      fullyAllocated,
    },
  }
}
