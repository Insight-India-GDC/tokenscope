/*
 * The scope a reporting query is answered for — the ONE place the difference
 * between "this region" and "the whole company" is expressed.
 *
 * WHY THIS TYPE EXISTS. across-regions.ts is regional.ts with the scope
 * predicate deleted: pairing the exported query functions and normalising away
 * naming and the predicate, 7 of 12 pairs are >=70% line-identical. Every
 * performance fix therefore had to be applied twice — the cost-owner LATERAL
 * fix in #219 was applied to fetchRegionalDrivers AND fetchAcrossDrivers in the
 * same commit — and every fix applied to only one copy is a silent divergence.
 * The two copies had already drifted: their (day, lane) map-key separators
 * differ, one a space and one a NUL escape.
 *
 * WHY A DISCRIMINATED UNION RATHER THAN `SQL | null`. Consistency contract C1
 * is "only one module builds a scope clause", and the hazard a shared engine
 * introduces is a caller silently getting the WRONG clamp — a whole-company
 * query inheriting a region predicate, or worse, a region query losing one and
 * reporting another region's money. A nullable argument makes "unclamped" the
 * same shape as "forgot to pass it". `wholeCompany` is a value you have to
 * write, so an unclamped query is a declaration in the diff, greppable in
 * review, rather than an omission nobody sees.
 */
import { sql, type SQL } from 'drizzle-orm'

/*
 * The LANE a clamp is built for, carried in the type.
 *
 * §A clamps address the people in a placement (`currentPlacementTeammates`) or
 * the current-lens columns of v_usage_rollup_current / v_complete_usage_current;
 * §B clamps address (region_id, cost_owning_unit_id) on v_finance_bill_chargeback. They
 * are different columns over different grains: an org unit that is not
 * cost-owning exists in the §A clamp and not the §B one. Handing a finance
 * clamp to the usage engine therefore type-checked and silently DROPPED usage
 * in non-cost-owning child units — a smaller number with nothing on the page
 * to contradict it.
 *
 * The phantom parameter makes that a compile error. Consistency contract C2
 * ("one lane per axis, firewall-enforced") is the rule; this is the enforcement
 * at the only point where both lanes are in scope at once.
 */
export type Lane = 'usage' | 'finance'

export type ReportScope<L extends Lane = Lane> =
  | { readonly kind: 'whole-company'; readonly lane: L }
  | { readonly kind: 'clamped'; readonly lane: L; readonly predicate: SQL }

export type UsageScope = ReportScope<'usage'>
export type FinanceScope = ReportScope<'finance'>

/*
 * No clamp: every row in the lane.
 *
 * Named exports rather than a default, and one per lane, because a
 * whole-company total is a CLAIM about the whole company. This makes an
 * unclamped query a declaration visible in the diff and greppable in review,
 * rather than an omission nobody sees.
 *
 * To be precise about what this does and does not buy: it prevents a clamp
 * being FORGOTTEN, not a caller deliberately asking for whole-company data.
 * Any module can import these. Authorisation lives in the scope resolvers
 * (resolveRegionalScope and friends), not here.
 */
export const wholeCompanyUsage: UsageScope = { kind: 'whole-company', lane: 'usage' }
export const wholeCompanyFinance: FinanceScope = { kind: 'whole-company', lane: 'finance' }

/** Clamp the §A usage lane — predicates over (region_id, org_unit_id). */
export function clampedUsage(predicate: SQL): UsageScope {
  return { kind: 'clamped', lane: 'usage', predicate }
}

/** Clamp the §B finance lane — predicates over (region_id, cost_owning_unit_id). */
export function clampedFinance(predicate: SQL): FinanceScope {
  return { kind: 'clamped', lane: 'finance', predicate }
}

/**
 * A §A clamp over the PEOPLE who sit inside a placement scope now
 * (docs/design/current-org-lens/00-design.md §3.1): `<teammateCol> IN (SELECT
 * id FROM teammate WHERE <placement over the teammate's current region / unit>)`.
 *
 * Why a teammate set rather than a predicate on the current views' placement
 * columns: those columns come from a join, so a filter on them cannot use the
 * stamped (region_id, day) / (org_unit_id, day) indexes, while this one uses the
 * (teammate_id, …) indexes. It is also correct on every relation that carries a
 * teammate_id (the rollup, the raw lane, provider_usage_fact), so one clamp
 * serves both lanes of the drivers toggle. A row with no teammate is in no
 * placement scope, as before.
 *
 * `= ANY(ARRAY(subquery))`, not `IN (subquery)`: the array is an initplan, so the
 * predicate is a plain column filter the planner pushes into every arm of
 * v_complete_usage and serves from the teammate indexes. `IN` became a hash
 * semi-join over the whole window, ~2x slower on the raw lane (measured on a
 * 1.5k-person synthetic estate).
 *
 * `placement` receives the teammate's column names; the alias `pt` is private to
 * the subquery so it cannot capture an outer `t`.
 */
export function currentPlacementTeammates(
  teammateCol: string,
  placement: (regionCol: string, orgUnitCol: string) => SQL,
): SQL {
  return sql`${sql.raw(teammateCol)} = ANY(ARRAY(SELECT pt.id FROM teammate pt WHERE ${placement('pt.region_id', 'pt.org_unit_id')}))`
}

/**
 * The scope as a fragment that is safe to `AND` into a WHERE clause.
 *
 * PARENTHESISED, and that is load-bearing rather than tidiness. AND binds
 * tighter than OR, so an unwrapped predicate containing a top-level OR
 * re-associates when the caller appends its window:
 *
 *   WHERE region = A OR region = B AND day >= x AND day < y
 *     parses as  region = A OR (region = B AND day >= x AND day < y)
 *
 * — every region-A row in HISTORY joins the result, ignoring the window.
 * Verified against Postgres: a 2020 row is returned inside a June-2026 window.
 * Today's predicates happen to be self-parenthesised
 * (server/auth/org-subtree-scope.ts:48), so nothing leaks in production, but a
 * function whose contract is "safe to AND" must actually be safe to AND —
 * otherwise the next predicate written without outer parens is a silent
 * window bypass on a money figure.
 *
 * Whole-company renders `TRUE` rather than an empty string: an empty fragment
 * would make `WHERE ${scopeSql(s)} AND day >= ...` a syntax error, and the
 * temptation to fix that by moving the AND into the caller is how one caller
 * ends up dropping the clamp entirely.
 */
export function scopeSql(scope: ReportScope): SQL {
  return scope.kind === 'clamped' ? sql`(${scope.predicate})` : sql`TRUE`
}
