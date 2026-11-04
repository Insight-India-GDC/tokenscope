/*
 * GET /api/v1/reports/finance/[couId]?month — the Finance CoU drill
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3, Wave 5).
 *
 * READS (build-design §4 — §B bill lanes, teammate-homed / org-map-homed):
 *   - Anthropic per-teammate charges → `v_finance_bill_chargeback` (the bill names
 *     the person; exempt + copilot already excluded by the view).
 *   - Copilot per-org pooled lines (license net + overage net, org→CoU-map-homed) →
 *     `copilot_pool_bill`, OR a pool-utilisation card — chosen by `copilot.mode`.
 *   - project overlay → `v_finance_project_overlay` (chargeable split, Anthropic).
 *   - Overage Drivers (D-Q6, chargeback mode + paid overage > 0): per-teammate
 *     EXCESS above per-seat share × proportional INDICATIVE share of the paid overage
 *     (from the usage lane `v_teammate_usage_daily` copilot branch) — INFORMATIONAL,
 *     never a charge; the shares sum back to the paid overage.
 *
 * RBAC (owner-decisions D-Q5): `requireReportScope(..., 'finance')` —
 * `platform-admin` as the baseline role, PLUS any teammate holding an active
 * `finance` report-access grant, whatever their role. It is region-unbounded, so
 * anti-IDOR here = a non-existent / non-cost-owning id is a 404
 * (resolveFinanceCou), never a 500 or a silent empty.
 *
 * HOMING (D-Homing): current-org interim ("homed to current org structure").
 * No `attribution_record` / raw `actual_spend` (the lane firewall, §7(7)).
 */
import { defineEventHandler, getValidatedQuery, getRouterParam, createError } from 'h3'
import { z } from 'zod'
import { requireReportScope } from '../../../../auth/report-scope'
import { requireAuth } from '../../../../utils/auth'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  identityKey,
  normalizedQuery,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveFinanceCou,
  fetchAnthropicCharges,
  fetchCopilotPool,
  fetchFinanceProjectOverlay,
  fetchOverageDrivers,
  lastCompleteMonth,
  HOMING_NOTE,
} from '../../../../reporting/finance'
import { providerStatesForWindow } from '../../../../reports/settling'
import { reportCoverageMeta } from '../../../../reports/coverage-meta'
import { copilotChargebackEnabled, copilotFinanceMode } from '../../../../reports/copilot-mode'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import type { ReportMeta } from '../../../../../shared/reports/types'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

export default defineEventHandler(async (event) => {
  // Validate as a real UUID (as index.get.ts / export.get.ts do) — a lax `[0-9a-f-]{36}`
  // regex admits 36-char shapes (e.g. all-dashes) that pass the gate then 500 on the ::uuid
  // cast in resolveFinanceCou. A structurally invalid id is a clean 400, never a 500 (L1).
  const couIdResult = z.string().uuid().safeParse(getRouterParam(event, 'couId'))
  if (!couIdResult.success) {
    throw createError({ statusCode: 400, statusMessage: 'invalid Business Unit id' })
  }
  const couId = couIdResult.data
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  // Month OR custom from/to window — MIRRORS the finance index (index.get.ts): the §B
  // bill/chargeback surfaces are month-grained, so a quarter (FinancePeriodControl)
  // picks up the whole `period_month`s it spans (`period_month >= from-month AND <
  // to-month+1`). No month/range → default to the LAST COMPLETE month (you cannot
  // chargeback an in-progress one). Month mode is byte-identical to the old path. This
  // keeps the per-CoU drill footing to the range-summed index per-CoU total.
  const win = resolveReportWindow(
    { ...query, month: query.month ?? (query.from || query.to ? undefined : lastCompleteMonth(now)) },
    { now },
  )
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))
  const copilotChargeback = copilotChargebackEnabled()

  // Authz tx first (plan D5/r1-M2): the finance gate + CoU resolution run
  // LIVE, then the connection is released; the compute tx below runs only for
  // a cache-miss leader.
  //
  // Whole-company finance drill: same finance gate as the finance index
  // (reportGrants.finance === true). Denies are audited.
  const cou = await withRequestRls(event, async (tx) => {
    await requireReportScope(event, tx, 'finance')
    return await resolveFinanceCou(tx, couId)
  })
  const session = await requireAuth(event)

  return await withReportCache(
    event,
    // couId is a ROUTE PARAM, not a query param — named in the key explicitly
    // (r1-H1: two drills with identical queries must never share a body).
    ['finance/drill', `cou:${cou.id}`, normalizedQuery(query), identityKey(session)],
    () => withRequestRls(event, async (tx) => {
    const anthropic = await fetchAnthropicCharges(tx, cou.id, win)
    const pool = await fetchCopilotPool(tx, cou.id, win)
    const projectOverlay = await fetchFinanceProjectOverlay(tx, cou.id, win, anthropic.totalUsd)

    // Overage Drivers: ONLY when the CoU has PAID overage in chargeback mode (D-Q6).
    const overageDrivers =
      copilotChargeback && pool.overageNetUsd > 0
        ? await fetchOverageDrivers(tx, cou.id, win, {
            overageNetUsd: pool.overageNetUsd,
            poolUsd: pool.poolUsd,
            seats: pool.seats,
          })
        : null

    // Chargeable = license + overage ONLY. pool.unclassifiedNetUsd (mig 0085) is surfaced
    // on the drill but NEVER charged — unclassified money waits for SKU classification
    // (design D2; runbook docs/build/worker-scheduler.md).
    const copilotChargeableUsd = pool.licenseNetUsd + pool.overageNetUsd
    const chargeableUsd = anthropic.totalUsd + (copilotChargeback ? copilotChargeableUsd : 0)

    const meta: ReportMeta = {
      month,
      monthFloor: month,
      asOfDate: null,
      providerStates: providerStatesForWindow(win, now),
      coverage: await reportCoverageMeta(tx),
      scope: 'finance',
      // Present only in custom-range (quarter) mode so the drill discloses the window.
      ...(win.isMonth ? {} : { range: { from: win.from, to: win.to } }),
    }

    return {
      meta,
      cou: { id: cou.id, code: cou.code, displayName: cou.displayName, regionCode: cou.regionCode },
      anthropicCharges: anthropic.charges,
      anthropicChargeableUsd: anthropic.totalUsd,
      copilot: {
        mode: copilotFinanceMode(),
        pending: !copilotChargeback,
        // Chargeback mode → the per-org pooled lines; pool-utilisation mode → the card.
        pooledLines: copilotChargeback ? pool.lines : null,
        poolUtilisation: copilotChargeback ? null : pool.utilisation,
        chargeableUsd: copilotChargeback ? copilotChargeableUsd : null,
        licenseNetUsd: pool.licenseNetUsd,
        overageNetUsd: pool.overageNetUsd,
        // Visible in BOTH modes, badged "needs mapping", never part of chargeableUsd.
        unclassifiedNetUsd: pool.unclassifiedNetUsd,
        // UNSETTLED CoU-month (a pooled line has usage but no read license SKU): licenseNetUsd —
        // and thus chargeableUsd — silently drops the unread license. Surface it in chargeback
        // mode so the drill caveats the Chargeable headline + shows amber, not green (M2).
        unsettled: copilotChargeback && pool.unsettled,
      },
      chargeableUsd,
      projectOverlay,
      projectHeadlineUsd: anthropic.totalUsd,
      overageDrivers,
      homingNote: HOMING_NOTE,
    }
    }),
  )
})
