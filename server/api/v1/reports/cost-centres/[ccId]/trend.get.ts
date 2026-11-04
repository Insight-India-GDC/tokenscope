/*
 * GET /api/v1/reports/cost-centres/[ccId]/trend — BAND 2, the rolling band.
 *
 * The approved prototype draws four surfaces on the cost-centre page below the
 * month band — Active developers over time, Spend trend, Spend per active
 * developer, and Where the AI spend goes. None were built, because they live in
 * the unconditional tail of the prototype's `across()` rather than inside an
 * `if(SK==='cc')` block, so nobody looking for cost-centre code found them.
 * `docs/design/reporting-consolidation/inventory.json` records them;
 * `tests/unit/reporting/prototype-parity.test.ts` asserts them.
 *
 * ── ONE ROUTE, NOT THREE ─────────────────────────────────────────────────────
 * Region splits this across `/trend`, `/active-trend` and `/behaviour` because
 * its cards load independently at whole-company width, where each scan is
 * expensive. A cost centre is one drill on one clamp, and the four cards share a
 * single band and a single window: three round-trips would buy nothing and would
 * let the band's own cards disagree about the window they cover. So they are
 * fetched together and the band is drawn from one answer.
 *
 * ── THE WINDOW IS THE CALLER'S, AND IT IS NOT THE MONTH ──────────────────────
 * The band is a ROLLING window (~60 days ending at the settled edge), computed
 * client-side by `rollingTrendWindow(clock)` and passed as `from`/`to` — the same
 * mechanism `ScopeAcrossRegions` uses, so both scopes' bands mean the same thing.
 * It deliberately does not sum into the month band above it, and the card copy
 * says so.
 *
 * AUTHZ IS TWO GATES, and the first one was missing until 2026-08-10.
 * `requireReportScope(event, tx, 'cost-centre')` asks whether the caller may see
 * this SCOPE at all — the sibling list route has always asked it, these did not.
 * Then `resolveCostCentreDrill`, the anti-IDOR gate: absent, retired, non-cost-owning, foreign-region and unowned all collapse
 * to one 403 rather than leaking which cost-centre ids exist.
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { requireReportScope, costCentreScopeOpts } from '../../../../../auth/report-scope'
import { withRequestRls } from '../../../../../db/request-rls'
import { withReportCache, identityKey, normalizedQuery } from '../../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../../reporting/params'
import {
  resolveCostCentreDrill,
  fetchCostCentreSpendTrend,
  fetchCostCentreActiveTrend,
  fetchCostCentreUsageWeeklyLanes,
  fetchCostCentreDailyMetrics,
} from '../../../../../reporting/cost-centres'
import { buildPerDeveloperSeries } from '../../../../../../shared/reports/per-developer'
import { requestClock } from '../../../../../utils/request-clock'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { getValidated } from '../../../../../utils/validated-body'
import { MONTH_REGEX } from '../../../../../utils/period'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  /*
   * The project's own two helpers, not h3's raw pair. `requireUuidParam` retires
   * the `/^[0-9a-f-]{36}$/i` shape this route was first written with — it accepts
   * 36 hex chars with no dashes, which then reaches the `::uuid` cast and raises
   * 22P02 as a 500 (the defect class that helper's header documents). And
   * `getValidated` returns an RFC-9457 400 where a bare `Query.parse` throws a
   * ZodError that is not an H3Error, i.e. another 500.
   */
  const ccId = requireUuidParam(event, 'ccId', 'Business Unit id')
  const query = await getValidated(event, Query)
  // ONE clock for this request — the window resolver and the day series read the
  // same instant (Reporting.md §3a).
  const clock = requestClock(event)
  const win = resolveReportWindow(query, { now: new Date(clock.now) })

  // Authz tx first, compute tx only for a cache-miss leader — the same shape the
  // drill route uses.
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
    [
      'cost-centres/trend',
      `cc:${cc.id}`,
      normalizedQuery(query),
      identityKey(session),
      `grant:${grants.costCentre}`,
      // The settled edge moves the series' right-hand bound, so it belongs in the
      // key — two callers a midnight apart must not share a body.
      clock.settledThrough,
    ],
    () =>
      withRequestRls(event, async (tx) => {
        const [trend, activeTrend, usageWeeklyLanes, daily] = await Promise.all([
          fetchCostCentreSpendTrend(tx, cc.id, win),
          fetchCostCentreActiveTrend(tx, cc.id, win),
          fetchCostCentreUsageWeeklyLanes(tx, cc.id, win),
          fetchCostCentreDailyMetrics(tx, cc.id, win, clock),
        ])
        /*
         * INCLUSIVE bounds, from the window's own labels. `endIso` is the
         * half-open EXCLUSIVE end (`params.ts:185`, "+1 day"), so slicing it
         * labels a 60-day band as 61 days and hands `buildSurfaceHero` a `today`
         * one day past the data — which at a week boundary invents an empty
         * in-progress week and drops the wrong period from the deltas. The
         * region route returns `win.from` / `win.to` for exactly this reason.
         */
        const window = { from: win.from, to: win.to }
        return {
          window,
          windowDays: trend.windowDays,
          series: trend.series,
          // `ActiveTrend` carries its own window: the card labels itself from
          // the frame it was computed over, never from an ambient one.
          activeTrend: { window, series: activeTrend },
          usageWeeklyLanes,
          /*
           * DERIVED from the same `daily` scan, not a second query — spend per
           * active developer is Σ spend ÷ Σ actives over a trailing frame, and
           * both operands are already on `DailyMetric`. A separate fetch could
           * disagree with the spend trend beside it.
           */
          perDeveloper: buildPerDeveloperSeries(daily, window),
        }
      }),
  )
})
