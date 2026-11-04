// @vitest-environment happy-dom
/*
 * Reporting Wave-1b primitives — render + emit + a11y contracts.
 * The recurring guardrail across every chip/banner: the word "finalised" is
 * BANNED (settling honesty — nothing is billed-grade).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettlingStateChip from '../../../app/components/reporting/SettlingStateChip.vue'
import ProviderFreshnessBar from '../../../app/components/reporting/ProviderFreshnessBar.vue'
import ForecastBanner from '../../../app/components/reporting/ForecastBanner.vue'
import ExportCsvButton from '../../../app/components/reporting/ExportCsvButton.vue'
import ReportEmpty from '../../../app/components/reporting/ReportEmpty.vue'
import ReportSkeleton from '../../../app/components/reporting/ReportSkeleton.vue'
import type { ProviderState, ReportMeta } from '#shared/reports/types'

describe('SettlingStateChip', () => {
  it('renders the exact provisional copy for `settled` and NEVER "finalised"', () => {
    const w = mount(SettlingStateChip, { props: { state: 'settled' } })
    expect(w.text()).toContain('past settling horizon — provisional (no close run)')
    expect(w.text().toLowerCase()).not.toContain('finalised')
  })

  it('labels estimated / settling states without "finalised"', () => {
    const est = mount(SettlingStateChip, { props: { state: 'estimated' } })
    expect(est.text()).toContain('month in progress')
    const settling = mount(SettlingStateChip, {
      props: { state: 'settling', horizonDate: '2026-05-31', vendor: 'anthropic' },
    })
    expect(settling.text()).toContain('provisional until 2026-05-31')
    expect(settling.text()).toContain('Anthropic')
    for (const w of [est, settling]) expect(w.text().toLowerCase()).not.toContain('finalised')
  })
})

describe('ProviderFreshnessBar', () => {
  const providers: ProviderState[] = [
    { vendor: 'anthropic', state: 'settling', settlesAt: '2026-05-31', asOfDate: '2026-05-20', closeRun: false },
    { vendor: 'github', state: 'estimated', invoiceReconciled: false, closeRun: false },
  ]

  it('renders per-vendor provenance incl. the unreconciled-invoice honesty flag', () => {
    const w = mount(ProviderFreshnessBar, { props: { providers } })
    expect(w.text()).toContain('Anthropic')
    expect(w.text()).toContain('GitHub Copilot')
    expect(w.text()).toContain('as of 2026-05-20')
    expect(w.find('[data-testid="invoice-unreconciled"]').exists()).toBe(true)
    expect(w.text().toLowerCase()).not.toContain('finalised')
  })

  it('renders nothing when there is no provider data', () => {
    const w = mount(ProviderFreshnessBar, { props: { providers: [] } })
    expect(w.find('[data-testid="provider-freshness-bar"]').exists()).toBe(false)
  })
})

describe('ForecastBanner', () => {
  const meta: ReportMeta = {
    month: '2026-07',
    monthFloor: '2026-01',
    asOfDate: '2026-07-10',
    providerStates: [],
    scope: 'across',
  }

  it('shows the data-anchored projection for the in-progress month', () => {
    const w = mount(ForecastBanner, {
      props: {
        forecast: {
          asOfDate: '2026-07-10',
          daysElapsed: 10,
          daysInMonth: 30,
          factor: 3,
          meteredMtdUsd: 400,
          meteredProjectedUsd: 1200,
          projectedUsd: 1200,
        },
        meta,
      },
    })
    expect(w.text()).toContain('On track for')
    expect(w.text()).toContain('through day 10 of 30')
    expect(w.text().toLowerCase()).not.toContain('finalised')
  })

  it('itemises Copilot seat-final vs overage projection on expand — never a charge', async () => {
    const w = mount(ForecastBanner, {
      props: {
        forecast: {
          asOfDate: '2026-07-10',
          daysElapsed: 10,
          daysInMonth: 30,
          factor: 3,
          meteredMtdUsd: 400,
          meteredProjectedUsd: 1200,
          projectedUsd: 1200,
          copilot: {
            seatFinalUsd: 900,
            creditsMtdUsd: 40,
            projectedCreditsUsd: 120,
            poolUsd: 0,
            projectedOverageUsd: 120,
            spendClass: 'estimated',
          },
        },
        meta,
      },
    })
    await w.find('[data-testid="forecast-copilot-toggle"]').trigger('click')
    const detail = w.find('[data-testid="forecast-copilot-detail"]')
    expect(detail.exists()).toBe(true)
    expect(detail.text()).toContain('never a charge')
  })

  it('shows the actual + settling chip for a closed month (forecast null)', () => {
    const closedMeta: ReportMeta = {
      month: '2026-05',
      monthFloor: '2026-01',
      asOfDate: '2026-05-31',
      providerStates: [{ vendor: 'anthropic', state: 'settling', settlesAt: '2026-06-30', closeRun: false }],
      scope: 'across',
    }
    const w = mount(ForecastBanner, { props: { forecast: null, actualUsd: 980, meta: closedMeta } })
    expect(w.find('[data-testid="forecast-actual"]').text()).toContain('$980')
    expect(w.text()).toContain('actual for the month')
    expect(w.findComponent(SettlingStateChip).exists()).toBe(true)
  })
})

describe('ExportCsvButton', () => {
  it('labels the action "Export CSV" — never "Excel"', () => {
    const w = mount(ExportCsvButton, {
      props: {
        endpoint: '/api/v1/reports/export',
        params: { scope: 'finance', month: '2026-05' },
        filename: 'tokenscope-finance-2026-05.csv',
      },
    })
    expect(w.text()).toBe('Export CSV')
    expect(w.text().toLowerCase()).not.toContain('excel')
    expect(w.find('[data-testid="export-csv-button"]').attributes('title')).toContain(
      'tokenscope-finance-2026-05.csv',
    )
  })
})

describe('ReportEmpty / ReportSkeleton', () => {
  it('ReportEmpty renders a default headline', () => {
    const w = mount(ReportEmpty)
    expect(w.text()).toContain('Nothing to report for this month yet.')
  })

  it('ReportSkeleton announces a busy loading state to AT', () => {
    const w = mount(ReportSkeleton)
    const root = w.find('[data-testid="report-skeleton"]')
    expect(root.attributes('aria-busy')).toBe('true')
    expect(root.attributes('role')).toBe('status')
    expect(w.text()).toContain('Loading report…')
  })
})
