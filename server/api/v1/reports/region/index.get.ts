/*
 * GET /api/v1/reports/region?month&region&ou? — the Region reporting scope, at
 * either of its two widths (04-prototype-delta.md §6; build-design §2/§3).
 *
 * ONE route, two widths. `?region=all` is the WHOLE-OF-COMPANY answer that used to
 * live at `/reports/across-regions`; anything else is one region, as
 * `/reports/regional` served it. They are not two scopes — the whole-company answer
 * is this scope with its clamp removed, which is why `engine/scope.ts` already had
 * `wholeCompanyUsage` and `clampedUsage` and the two composers were >=70% identical.
 *
 * READS (build-design §4 lane matrix), identical at both widths:
 *   - usage KPIs / ranking / coverage / trend → `v_complete_usage` (the §A lane).
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane). Copilot chargeable is gated on `copilot.mode`.
 *
 * RBAC: `resolveRegionRequest` — `all` requires the `across` grant (denies audited,
 * as they were on the retired route); a single region requires `regional` and then
 * runs the unchanged `resolveRegionalScope` branch (admin own-region force, org-wide
 * roles any region, dev/manager subtree, `ou` drill anti-IDOR).
 *
 * The response is DISCRIMINATED on `width`, not shaped into a false union: the two
 * widths answer different questions (region cards + concentration vs practices +
 * exceptions) and pretending otherwise would put an empty array where a reader
 * expects a number. `regionOptions` + `allRegionsAvailable` ride BOTH widths — they
 * are the selector, and the selector is how a reader moves between them.
 *
 * No `attribution_record` / raw `actual_spend` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../utils/auth'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  memoizedScan,
  identityKey,
  normalizedQuery,
  regionRequestKey,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import { resolveRegionRequest, isValidRegionParam } from '../../../../reporting/region-scope'
import {
  fetchAcrossKpis,
  fetchAcrossRegionCards,
  fetchAcrossChargebackByRegion,
  fetchProviderSplit,
  fetchAcrossDailyMetrics,
  fetchAcrossUsageBudgetCoverage,
  fetchAcrossChargebackTrend,
  fetchAcrossChargebackLanes,
  fetchAcrossPerPerson,
} from '../../../../reporting/across-regions'
import {
  fetchRegionalKpis,
  fetchRegionalPractices,
  fetchRegionalChargebackByCostCentre,
  fetchRegionalDailyMetrics,
  fetchRegionalUsageBudgetCoverage,
  fetchRegionalChargebackTrend,
  fetchRegionalChargebackLanes,
  fetchRegionalVendorSplit,
  fetchRegionalProviderSplit,
  fetchRegionalExceptions,
  fetchRegionalPerPerson,
} from '../../../../reporting/regional'
import { forecastForMonth } from '../../../../reports/forecast'
import { providerStatesForWindow } from '../../../../reports/settling'
import { reportCoverageMeta } from '../../../../reports/coverage-meta'
import { copilotChargebackEnabled, copilotFinanceMode } from '../../../../reports/copilot-mode'
import { resolveVelocitySpikeThreshold } from '../../../../reports/velocity'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  // `all` (the whole-company width) OR a region uuid. A malformed value is still a
  // 400 — never a silent fall-through to the caller's default region.
  region: z.string().refine(isValidRegionParam, 'region must be a uuid or "all"').optional(),
  ou: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  // ONE clock for this request (F1/D1): the window resolver, the SQL series
  // frontier and the response-cache key all read this same instant.
  const clock = requestClock(event)
  const now = new Date(clock.now)
  const win = resolveReportWindow(query, { now })
  const metaMonth = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const copilotChargeback = copilotChargebackEnabled()
  // MoM + forecast are MONTH-anchored (build-design §5): only a calendar-month window
  // carries them. A custom range computes the same aggregates over its bounds but
  // returns momDeltaPct/forecast null — an MTD delta over an arbitrary span is meaningless.
  const momMonthRange = win.isMonth ? win.monthRange : null

  /*
   * Two transactions, deliberately (report-cache.ts, plan D5/r1-M2): the authz
   * tx resolves the caller's grant + scope LIVE (a revoked grant 403s here,
   * never from cache) and releases its connection; the compute tx below runs
   * only for a cache-miss LEADER — waiters and hits hold no connection at all.
   */
  const req = await withRequestRls(event, (tx) =>
    resolveRegionRequest(event, tx, { region: query.region, ou: query.ou }),
  )
  const session = await requireAuth(event)
  const idKey = identityKey(session)

  return await withReportCache(
    event,
    ['region', normalizedQuery(query), idKey, regionRequestKey(req)],
    () => withRequestRls(event, async (tx) => {
    const selector = {
      regionOptions: req.regionOptions,
      allRegionsAvailable: req.allRegionsAvailable,
    }

    if (req.width === 'all-regions') {
      // Concurrent issuance on ONE tx connection: postgres-js pipelines and
      // answers in order — safe; the win is issuance without
      // per-query await gaps (one wave once statements are prepared on the
      // connection; first use still describes), not true
      // parallelism (docs/design/request-floor-performance.md F5). Only
      // `perPerson` consumes a wave-1 output (kpis.asOfDate), so it alone
      // waits for wave 2. The memoized reads may idle as memo waiters inside
      // the wave — by design (report-cache.ts header).
      const [
        kpis,
        regionCards,
        // §B chargeback-by-region ranking — the chargeback-lane swap for the usage region
        // cards. Sourced off the bill lane so a region with charge but no in-window usage
        // is not dropped, and it sums back to kpis.chargeableUsd.
        chargebackByRegion,
        providerSplit,
        // The daily-metrics + chargeback-trend reads are the exact series the
        // trend/behaviour endpoints serve — memoized (D8) so the page's
        // CONCURRENT XHRs compute each once, not once per endpoint.
        dailyMetrics,
        // §A budget coverage — the denominator the hero publishes beside `genuineUsd`,
        // on the SAME lane and window, so the parts foot to that headline.
        budgetCoverage,
        chargeDaily,
        chargebackLanes,
        coverage,
      ] = await Promise.all([
        fetchAcrossKpis(tx, win, { copilotChargeback, momMonthRange, now }),
        fetchAcrossRegionCards(tx, win, { copilotChargeback }),
        fetchAcrossChargebackByRegion(tx, win, { copilotChargeback }),
        fetchProviderSplit(tx, win),
        memoizedScan(
          ['across-daily-metrics', idKey, win.startIso, win.endIso, clock.settledThrough],
          () => fetchAcrossDailyMetrics(tx, win, clock),
        ),
        fetchAcrossUsageBudgetCoverage(tx, win),
        memoizedScan(
          ['across-charge-trend', idKey, win.startIso, win.endIso, clock.settledThrough],
          () => fetchAcrossChargebackTrend(tx, win, clock),
        ),
        fetchAcrossChargebackLanes(tx, win, { copilotChargeback }),
        reportCoverageMeta(tx),
      ])
      // §A per-person cohort — the median + its three percentiles + the emitting
      // split, over the SAME lane, scope and window as `kpis.activeUsers`, which is
      // the headcount the median's "half of N are below this" divides by.
      // After wave 1: consumes kpis.asOfDate.
      const perPerson = await fetchAcrossPerPerson(tx, win, {
        momMonthRange,
        asOfDate: kpis.asOfDate,
      })

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
        month: metaMonth,
        monthFloor: kpis.monthFloor ?? metaMonth,
        asOfDate: kpis.asOfDate,
        // The operand `dailyMetrics`/`chargeDaily` were cut on — shipped so the
        // hero's spark can say whether its last point is a finished day without
        // opening a second clock request (external review r2).
        settledThrough: clock.settledThrough,
        providerStates: providerStatesForWindow(win, now),
        coverage,
        scope: 'region',
        ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
      }

      return {
        meta,
        width: 'all-regions' as const,
        // No effective region: this width answers for no single one. Explicitly null
        // rather than absent, so a consumer reading `report.region.displayName` fails
        // loudly instead of rendering a heading it invented.
        region: null,
        ...selector,
        kpis: {
          genuineUsd: kpis.genuineUsd,
          chargeableUsd: kpis.chargeableUsd,
          anthropicChargeableUsd: kpis.anthropicChargeableUsd,
          tokens: kpis.tokens,
          activeUsers: kpis.activeUsers,
          momDeltaPct: kpis.momDeltaPct,
          chargeMomDeltaPct: kpis.chargeMomDeltaPct,
          avgPerUserUsd: kpis.avgPerUserUsd,
          billedTeammates: kpis.billedTeammates,
          billedTokens: kpis.billedTokens,
          avgChargePerBilledUser: kpis.avgChargePerBilledUser,
        },
        copilot: {
          mode: copilotFinanceMode(),
          pending: !copilotChargeback,
          partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
          chargeableUsd:
            copilotChargeback && !kpis.copilotPartialMonthUnavailable
              ? kpis.copilotChargeableUsd
              : null,
        },
        chargebackProviderSplit: {
          anthropicUsd: kpis.anthropicChargeableUsd,
          copilotUsd:
            copilotChargeback && !kpis.copilotPartialMonthUnavailable
              ? kpis.copilotChargeableUsd
              : null,
          partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
        },
        providerSplit,
        dailyMetrics,
        budgetCoverage,
        chargeDaily,
        chargebackLanes,
        perPerson,
        forecast,
        actualUsd: kpis.genuineUsd,
        regionCards,
        chargebackByRegion,
      }
    }

    const { scope } = req
    // Concurrent issuance on ONE tx connection: postgres-js pipelines and
    // answers in order — safe; the win is issuance without
    // per-query await gaps (one wave once statements are prepared on the
    // connection; first use still describes), not true parallelism
    // (docs/design/request-floor-performance.md F5). Wave 2 holds
    // the two reads that consume wave-1 outputs: `perPerson` (kpis.asOfDate)
    // and `exceptions` (the resolved threshold).
    const [
      kpis,
      // Top-level shows the practice ranking; the `ou` drill shows the vendor donut.
      practices,
      chargebackByCostCentre,
      vendorSplit,
      providerSplit,
      // Memoized for the same D8 reason as the all-regions branch — the regional
      // trend/behaviour endpoints serve these exact series.
      dailyMetrics,
      budgetCoverage,
      chargeDaily,
      chargebackLanes,
      threshold,
      coverage,
    ] = await Promise.all([
      fetchRegionalKpis(tx, scope, win, { copilotChargeback, momMonthRange, now }),
      scope.ou ? [] : fetchRegionalPractices(tx, scope, win),
      scope.ou ? [] : fetchRegionalChargebackByCostCentre(tx, scope, win, { copilotChargeback }),
      scope.ou ? fetchRegionalVendorSplit(tx, scope, win) : null,
      fetchRegionalProviderSplit(tx, scope, win),
      memoizedScan(
        ['regional-daily-metrics', idKey, scope.scopeKey, win.startIso, win.endIso, clock.settledThrough],
        () => fetchRegionalDailyMetrics(tx, scope, win, clock),
      ),
      fetchRegionalUsageBudgetCoverage(tx, scope, win),
      memoizedScan(
        ['regional-charge-trend', idKey, scope.scopeKey, win.startIso, win.endIso, clock.settledThrough],
        () => fetchRegionalChargebackTrend(tx, scope, win, clock),
      ),
      fetchRegionalChargebackLanes(tx, scope, win, { copilotChargeback }),
      resolveVelocitySpikeThreshold(tx, scope.effectiveRegionId),
      reportCoverageMeta(tx),
    ])

    const asOf = kpis.asOfDate ? new Date(`${kpis.asOfDate}T00:00:00.000Z`) : null
    const forecast =
      win.isMonth && win.monthStr
        ? forecastForMonth({ requestedMonth: win.monthStr, now, asOf, meteredMtdUsd: kpis.genuineUsd })
        : null

    const [perPerson, exceptions] = await Promise.all([
      // §A per-person cohort — the median + its three percentiles + the emitting
      // split, over the SAME lane, scope and window as `kpis.activeUsers`, which is
      // the headcount the median's "half of N are below this" divides by. The SAME
      // engine read the whole-company branch above makes, region-clamped.
      fetchRegionalPerPerson(tx, scope, win, {
        momMonthRange,
        asOfDate: kpis.asOfDate,
      }),
      fetchRegionalExceptions(tx, scope, threshold, now),
    ])

    const meta: ReportMeta = {
      month: metaMonth,
      monthFloor: kpis.monthFloor ?? metaMonth,
      asOfDate: kpis.asOfDate,
      // The operand `dailyMetrics`/`chargeDaily` were cut on — shipped so the
      // hero's spark can say whether its last point is a finished day without
      // opening a second clock request (external review r2).
      settledThrough: clock.settledThrough,
      providerStates: providerStatesForWindow(win, now),
      coverage,
      scope: 'region',
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      width: 'region' as const,
      region: scope.region,
      ...selector,
      drill: scope.ou
        ? { ouId: scope.ou.id, code: scope.ou.code, displayName: scope.ou.displayName }
        : null,
      kpis: {
        genuineUsd: kpis.genuineUsd,
        chargeableUsd: kpis.chargeableUsd,
        anthropicChargeableUsd: kpis.anthropicChargeableUsd,
        tokens: kpis.tokens,
        activeUsers: kpis.activeUsers,
        momDeltaPct: kpis.momDeltaPct,
        chargeMomDeltaPct: kpis.chargeMomDeltaPct,
        billedTeammates: kpis.billedTeammates,
        billedTokens: kpis.billedTokens,
        avgChargePerBilledUser: kpis.avgChargePerBilledUser,
      },
      copilot: {
        mode: copilotFinanceMode(),
        pending: !copilotChargeback,
        partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
        chargeableUsd:
          copilotChargeback && !kpis.copilotPartialMonthUnavailable
            ? kpis.copilotChargeableUsd
            : null,
      },
      chargebackProviderSplit: {
        anthropicUsd: kpis.anthropicChargeableUsd,
        copilotUsd:
          copilotChargeback && !kpis.copilotPartialMonthUnavailable
            ? kpis.copilotChargeableUsd
            : null,
        partialMonthUnavailable: kpis.copilotPartialMonthUnavailable,
      },
      chargebackLanes,
      providerSplit,
      dailyMetrics,
      budgetCoverage,
      chargeDaily,
      perPerson,
      forecast,
      actualUsd: kpis.genuineUsd,
      practices,
      chargebackByCostCentre,
      vendorSplit,
      exceptions,
      velocityThreshold: threshold,
    }
    }),
  )
})
