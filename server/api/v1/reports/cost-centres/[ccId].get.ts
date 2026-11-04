/*
 * GET /api/v1/reports/cost-centres/[ccId]?month&axis — the Cost-Centre BURN drill
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4, Wave 3).
 *
 * READS (§A completeness lane, the SAME axis as the tracker card burn):
 *   - burn total + vendor split → `v_complete_usage_current WHERE cost_owning_unit_id`
 *     (Copilot pooled NULL-CoU rows excluded by construction — the labelled §A gap).
 *   - axis drivers (project|teammate|model|surface): what/who is burning the budget.
 *     The three BURN axes sum back to `burnUsd`, on the same current-lens
 *     cost_owning_unit_id the burn is clamped by. The PROJECT axis is clamped on the project's own
 *     cost-owning unit and so carries its own `headlineUsd`/`denominatorLabel`
 *     (arm 2 has a real project and a NULL cost-owning unit — clamping it like the
 *     burn axes would delete every reconciled dollar). Render `headlineUsd`, never
 *     `burnUsd`, as the drivers' denominator.
 *   - the two HEROES the screen renders side by side (04-prototype-delta.md §5b):
 *     `budgets` (the project axis, UNCAPPED — at one cost centre the list IS the
 *     population) and `people` (the teammate axis). Each carries its own
 *     headline/denominator for the reason above; they are not two views of one
 *     total. `?axis=` still answers a SINGLE axis for a script, a saved link or
 *     the CSV export, and is the same computation aliased, never a second query.
 *   - the CC's current-effective allocation (burn-vs-budget context) — DERIVED,
 *     the roll-up of its projects' budgets, and labelled so on the face.
 * The §B chargeback/billing for this CC lives in the Finance scope's CoU drill —
 * NOT duplicated here (a budget-BURN tracker's drill shows consumption, not invoices).
 *
 * RBAC (build-design §2 — resource-anchored, anti-IDOR): grant iff the caller's
 * TWO GATES since 2026-08-10. `requireReportScope(event, tx, 'cost-centre')`
 * first — may this caller see the SCOPE at all — which the sibling list route
 * has always asked and this one did not, so a denied scope was reachable by
 * anyone the subtree predicate admits. Then the resource gate below.
 * region/subtree scope covers the CC (orgSubtreeScopePredicate) OR they OWN it
 * (an active cou_owner row) — folded INTO the resolving query
 * (resolveCostCentreDrill, S3 part e). A non-existent CC, a retired/non-cost-
 * owning unit, and a foreign/unowned CC all collapse to the SAME 403 — the old
 * two-step (existence 404, then ownership/region 403) was an existence oracle
 * over which cost centres exist in a region the caller can't see.
 *
 * No `attribution_record` / raw `actual_spend` / `v_finance_*` (the lane firewall, §7(7)).
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { requireReportScope, costCentreScopeOpts } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  identityKey,
  normalizedQuery,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveCostCentreDrill,
  fetchCostCentreBurnDrill,
  fetchCostCentreBurnDrivers,
  fetchCostCentreHeroes,
  fetchCostCentreAllocation,
  costCentreRosterScope,
  fetchCostCentreTierExposure,
  fetchCostCentreKpis,
  fetchCostCentrePerPerson,
  fetchCostCentreDailyMetrics,
  fetchCostCentreChargebackTrend,
  fetchCostCentreUsageBudgetCoverage,
  fetchCostCentreCharge,
  COST_CENTRE_DRILL_AXES,
} from '../../../../reporting/cost-centres'
import { fetchOverSoftCap } from '../../../../reporting/engine/over-soft-cap'
import { copilotChargebackEnabled } from '../../../../reports/copilot-mode'
import { requestClock } from '../../../../utils/request-clock'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { getValidated } from '../../../../utils/validated-body'
import { forecastForMonth } from '../../../../reports/forecast'
import { providerStatesForWindow } from '../../../../reports/settling'
import { reportCoverageMeta } from '../../../../reports/coverage-meta'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  // PROJECT is the default because the unit of account is the budgeted project
  // (decisions D1) — and the DEFAULT is the contract, not the browser's opening
  // pick. Every consumer that does not name an axis (a script, a saved link, the
  // CSV export) gets the same first answer the screen does; leaving it on
  // 'teammate' made "project-first" true only for the one caller that happened
  // to send `axis=project`.
  axis: z.enum(COST_CENTRE_DRILL_AXES).default('project'),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  /*
   * The project's helpers, for the reason their own headers give: the
   * `/^[0-9a-f-]{36}$/i` shape admits 36 dashless hex chars that reach the
   * `::uuid` cast and raise 22P02 as a 500, and a bare `Query.parse` throws a
   * ZodError that is not an H3Error — another 500. Fixed on /trend first; the
   * sibling kept them, which is how the pattern would have been copied again.
   */
  const ccId = requireUuidParam(event, 'ccId', 'Business Unit id')
  const query = await getValidated(event, Query)
  /*
   * ONE clock for this request, the same ownership rule every other scope
   * follows (Reporting.md §3a): the window resolver, the SQL day series and the
   * hero's "as at" all read the same instant. A `new Date()` here and a
   * `requestClock` inside the series would be two clocks that disagree across a
   * midnight, which is what used to draw as a dip.
   */
  const clock = requestClock(event)
  const now = new Date(clock.now)
  // Month OR custom from/to window — the SAME window resolveReportWindow gives the
  // tracker index/card. In range mode (This quarter / Custom) the drill burn windows
  // the WHOLE range, so the §A drill headline reconciles to the range-windowed
  // tracker card burn in EVERY mode. Month mode is byte-identical to the old path.
  const win = resolveReportWindow(query, { now })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  /*
   * MoM and the run-rate are MONTH-anchored (build-design §5). Over an arbitrary
   * span there is no previous period to pace against, so both are null rather
   * than computed over a window that cannot support them — the same rule the
   * Region widths apply.
   */
  const momMonthRange = win.isMonth ? win.monthRange : null

  // Authz tx first (plan D5/r1-M2): the grant and the drill's anti-IDOR gate
  // resolve LIVE, then the connection is released; the compute tx below runs
  // only for a cache-miss leader.
  //
  // An ACTIVE 'operational' report-access grant (grants.costCentre === 'all')
  // lets the caller drill ANY existing cost centre; non-elevated callers keep
  // the owner-OR-region gate.
  //
  // S3(e) collapsed resolveCostCentreDrill's outcomes to ONE status: absent,
  // retired, non-cost-owning, foreign-region and unowned all raise the same 403.
  // That is deliberate anti-IDOR — a 404-for-absent beside a 403-for-foreign is an
  // existence oracle for other regions' cost-centre ids. (This comment previously
  // said "still a 404", describing the pre-S3 behaviour; flagged in PR #204 review.)
  const { grants, cc } = await withRequestRls(event, async (tx) => {
    /*
     * THE SCOPE GRANT, not just the resource gate. `resolveCostCentreDrill`
     * answers "may this caller see THIS centre" (owner or subtree); it does not
     * answer "may this caller see the cost-centre scope AT ALL". Without this,
     * a policy mode that denies the scope was still bypassable by anyone the
     * subtree predicate happens to admit — and RLS is inert under the owner
     * connection, so nothing downstream catches it. The sibling LIST route has
     * always gated this way (`cost-centres/index.get.ts:81`); the drill never
     * did, and the /trend route inherited the omission by being modelled on it.
     */
    const { grants } = await requireReportScope(event, tx, 'cost-centre')
    const cc = await resolveCostCentreDrill(tx, session, ccId, costCentreScopeOpts(session, grants))
    return { grants, cc }
  })

  return await withReportCache(
    event,
    // ccId is a ROUTE PARAM, not a query param — named in the key explicitly
    // (r1-H1: two drills with identical queries must never share a body).
    [
      'cost-centres/drill',
      `cc:${cc.id}`,
      normalizedQuery(query),
      identityKey(session),
      `grant:${grants.costCentre}`,
      /*
       * The settled edge is IN the body now (`meta.settledThrough`, plus the day
       * series the hero's sparks are drawn from), so it has to be in the key. Two
       * callers either side of a midnight would otherwise share one entry and the
       * later one would get the previous day's frame — the trend route already
       * keys on it for the same reason.
       */
      clock.settledThrough,
    ],
    () => withRequestRls(event, async (tx) => {
    const burn = await fetchCostCentreBurnDrill(tx, cc.id, win)
    /*
     * The SCREEN reads both heroes; `?axis=` still answers ONE axis for the
     * callers nobody is watching (a script, a saved link, the CSV export — the
     * reason tests/integration/reports/default-axis.test.ts exists). The two are
     * the SAME function, aliased rather than re-queried, so the single-axis
     * answer and the hero can never be two numbers.
     */
    const heroes = await fetchCostCentreHeroes(tx, cc.id, win, burn.burnUsd)
    const drivers =
      query.axis === 'project'
        ? heroes.budgets
        : query.axis === 'teammate'
          ? heroes.people
          : await fetchCostCentreBurnDrivers(tx, cc.id, win, query.axis, burn.burnUsd)
    const allocationUsd = await fetchCostCentreAllocation(tx, cc.id)
    /*
     * The lead card: unallocated spend over the soft cap. ROSTER-anchored — its
     * clamp is teammate PLACEMENT in this cost centre, NOT the `cost_owning_unit_id`
     * burn axis every other figure on this response uses. That is the point of the
     * card: `cost_owning_unit_id` is the tagged PROJECT's cost centre, so a
     * burn-clamped scan omits precisely the people with nothing tagged. Its
     * denominator is therefore a different one from `burnUsd` and is named as such
     * (`rosterUsd`) rather than rendered beside it as if the two reconciled.
     */
    const overSoftCap = await fetchOverSoftCap(tx, await costCentreRosterScope(tx, cc.id), win)
    /*
     * §B Behavioural exposure — model-tier bands over `provider_usage_fact`,
     * clamped to this CC's cost-owning unit. It sits BESIDE the §A burn above
     * and is never summed with it: the burn is usage-basis, this is
     * provider-billed. That is the whole reason it is a separate field rather
     * than another `vendor`-style split on `burnUsd`.
     */
    const exposure = await fetchCostCentreTierExposure(tx, cc.id, win)
    /*
     * §B — what this centre is CHARGED, the same figure its card carries, from
     * the same extracted fetcher so the list and the drill can never disagree.
     *
     * It exists so the drill's lane toggle has something behind it: the owner's
     * ruling is that a cost-centre owner needs BOTH — "am I on track" is §B,
     * "what is driving it" is §A. Never summed with `burnUsd`; they are
     * different lanes over different bases (contract C2).
     */
    const charge = await fetchCostCentreCharge(tx, cc.id, win, {
      copilotChargeback: copilotChargebackEnabled(),
    })

    /*
     * ── THE HERO PAYLOAD (prototype parity: BAND 1 and its four tiles) ────────
     *
     * The approved prototype draws the month band, the four KPI tiles and the
     * budget-coverage note on THIS scope — they sit in the unconditional tail of
     * `across()`, which `cc(d)` runs (prototype.html; inventory.json records the
     * result). None of it was built, and nothing could see that until the parity
     * gate. Wired here from the SAME engine primitives both Region widths use,
     * so a third KPI implementation cannot drift from the other two.
     *
     * `kpis.genuineUsd` and `burn.burnUsd` are the same §A clamp over the same
     * window and must agree; they are computed separately only because one
     * carries the vendor split and the other the MoM/active-people operands.
     */
    const kpis = await fetchCostCentreKpis(tx, cc.id, win, {
      copilotChargeback: copilotChargebackEnabled(),
      momMonthRange,
      now,
    })
    const [perPerson, dailyMetrics, chargeDaily, budgetCoverage] = await Promise.all([
      fetchCostCentrePerPerson(tx, cc.id, win, { momMonthRange, asOfDate: kpis.asOfDate }),
      fetchCostCentreDailyMetrics(tx, cc.id, win, clock),
      fetchCostCentreChargebackTrend(tx, cc.id, win, clock),
      // The label names the clamp in the reader's words — this centre, not its
      // region (contract C11): the note's denominator IS this cost centre.
      fetchCostCentreUsageBudgetCoverage(tx, cc.id, win, cc.displayName),
    ])
    /*
     * Non-null EXACTLY when the viewed month is the in-progress one — the pacing
     * signal ScopeHero renders as "on pace for ~$X by <monthEnd>". Accrued plus a
     * LABELLED run-rate (ADR-0010 D3), never a bare forecast.
     */
    const asOf = kpis.asOfDate ? new Date(`${kpis.asOfDate}T00:00:00.000Z`) : null
    const forecast =
      win.isMonth && win.monthStr
        ? forecastForMonth({
            requestedMonth: win.monthStr,
            now,
            asOf,
            meteredMtdUsd: kpis.genuineUsd,
          })
        : null

    const meta: ReportMeta = {
      month,
      monthFloor: month,
      asOfDate: burn.asOf,
      providerStates: providerStatesForWindow(win, now),
      coverage: await reportCoverageMeta(tx),
      // The hero's sparks need the settled edge to say whether their last point
      // is a finished day; absent, they make no claim (MonthSpark).
      settledThrough: clock.settledThrough,
      scope: 'cost-centre',
      // Present only in custom-range mode so the drill discloses the active window.
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      cc: { id: cc.id, code: cc.code, displayName: cc.displayName, regionCode: cc.regionCode },
      burnUsd: burn.burnUsd,
      chargeUsd: charge.chargeUsd,
      copilotChargebackPartialMonth: charge.copilotChargebackPartialMonth,
      vendor: burn.vendor,
      allocationUsd,
      overSoftCap,
      axis: query.axis,
      headlineUsd: drivers.headlineUsd,
      denominatorLabel: drivers.denominatorLabel,
      rows: drivers.rows,
      // The screen's two lists. Each carries its OWN headline/denominator — they
      // are different totals by construction (see fetchCostCentreHeroes), so a
      // renderer must never foot one against the other's number.
      budgets: heroes.budgets,
      people: heroes.people,
      exposure,
      // ── The hero payload. Structurally what `ScopeHeroReport` binds on, so
      //    this scope renders the SAME component both Region widths do.
      kpis: {
        genuineUsd: kpis.genuineUsd,
        chargeableUsd: kpis.chargeableUsd,
        activeUsers: kpis.activeUsers,
        momDeltaPct: kpis.momDeltaPct,
        chargeMomDeltaPct: kpis.chargeMomDeltaPct,
      },
      copilot: {
        pending: !copilotChargebackEnabled(),
        partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
      },
      forecast,
      dailyMetrics,
      chargeDaily,
      budgetCoverage,
      perPerson,
    }
    }),
  )
})
