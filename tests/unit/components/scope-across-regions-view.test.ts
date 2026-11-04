// @vitest-environment happy-dom
/*
 * ScopeAcrossRegionsView — the presentational Across-Regions (whole-company) tree.
 * Verifies build-design §3's "exactly one of skeleton / error / empty / data"
 * contract, the KPI tiles, the provider split + active-users trend, the
 * heatmap card, the drivers/top-models/concentration section, the Copilot "pending"
 * chip, and the DATAVIZ rule that a MoM delta is NEUTRAL (arrow, never RAG green).
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeAcrossRegionsView from '../../../app/components/reporting/ScopeAcrossRegionsView.vue'
import type {
  AcrossReport,
  AcrossDriversResp,
} from '../../../app/components/reporting/across-report-types'
import type { AcrossTrend, Seasonality, ActiveTrend } from '../../../shared/reports/types'

// DateRangeControl self-wires to the auto-imported useReportState (undefined outside
// Nuxt); ClientOnly/VChart are Nuxt/nuxt-echarts globals. Stub all so the View mounts.
const global = {
  stubs: {
    DateRangeControl: true,
    LaneToggle: true,
    // LaneSwitchLink self-wires to useReportState (undefined outside Nuxt) —
    // stubbed exactly like LaneToggle (iter-2 I5 cross-links).
    LaneSwitchLink: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: [
    { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-08-30', closeRun: false as const },
    { vendor: 'usage' as const, state: 'settling' as const, settlesAt: '2026-09-04', closeRun: false as const },
  ],
  coverage: { applicable: true, denominator: 5, connected: 4, nonConnected: 1, stale: false },
  scope: 'across' as const,
}

const dailyMetrics = [
  { day: '2026-07-08', genuineUsd: 30, tokens: 2000, activeUsers: 2 },
  { day: '2026-07-09', genuineUsd: 28, tokens: 2000, activeUsers: 3 },
]

function makeReport(over: Partial<AcrossReport> = {}): AcrossReport {
  return {
    meta,
    // The whole-company WIDTH of the Region scope, with its selector fields: the
    // caller here holds "All regions" plus two regions, so the control renders.
    width: 'all-regions',
    region: null,
    regionOptions: [
      { id: 'r1', code: 'ra', displayName: 'Region A' },
      { id: 'r2', code: 'rb', displayName: 'Region B' },
    ],
    allRegionsAvailable: true,
    kpis: {
      genuineUsd: 58,
      chargeableUsd: 12,
      anthropicChargeableUsd: 12,
      tokens: 4000,
      activeUsers: 3,
      momDeltaPct: 28 / 30,
      chargeMomDeltaPct: null,
      avgPerUserUsd: 58 / 3,
      billedTeammates: 2,
      billedTokens: 3000,
      avgChargePerBilledUser: 6,
    },
    copilot: { mode: 'pool-utilisation', pending: true, chargeableUsd: null },
    forecast: null,
    actualUsd: 58,
    dailyMetrics,
    // The coverage qualifier for `kpis.genuineUsd` — the four parts foot to it (58),
    // as the server guarantees, so the fixture cannot certify a note that does not add up.
    budgetCoverage: {
      // The name the SERVER attaches beside `wholeCompanyUsage`, not one this view
      // may invent — the across view has no prop to pass a label through any more.
      scopeLabel: 'the whole company',
      totalUsd: 58,
      budgetedUsd: 6,
      taggedNoBudgetUsd: 14,
      untaggedUsd: 30,
      untaggableUsd: 8,
    },
    // §B per-day Anthropic chargeback (bill lane) — the Chargeable-tile sparkline source.
    chargeDaily: [
      { day: '2026-07-08', chargeUsd: 6 },
      { day: '2026-07-09', chargeUsd: 6 },
    ],
    // §A per-person cohort — the Median-per-person tile's operand. Three active
    // people here, which is BELOW the five-person floor, so the tile is suppressed
    // (a median of three names an individual). AcrossHero's own suite covers the
    // rendered tile; this fixture proves the view passes the payload through.
    perPerson: {
      medianUsd: 20,
      top1: 30 / 58,
      top5: 30 / 58,
      top10: 30 / 58,
      emittingPeople: 2,
      peopleMomDelta: 1,
      medianMomDeltaPct: 0.25,
    },
    // §B provider split (bill lane) — Anthropic vs Copilot pooled (null while pending).
    chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null },
    // §B per-lane chargeback totals (lane-visuals V2) — Σ == anthropicChargeableUsd (12).
    chargebackLanes: [
      { lane: 'claude', chargeUsd: 10 },
      { lane: 'claude-ai', chargeUsd: 2 },
    ],
    providerSplit: {
      claudeCode: { spendUsd: 40, activeUsers: 2 },
      copilotCli: { spendUsd: 15, activeUsers: 2 },
      // Three-lane §A ceiling: copilot-agent reads 0 today (absent from v_complete_usage).
      copilotAgent: { spendUsd: 0, activeUsers: 0 },
      other: { spendUsd: 3, activeUsers: 1 },
    },
    regionCards: [
      { regionId: 'ra', code: 'ra', displayName: 'Region A', genuineUsd: 50, anthropicChargeableUsd: 12, copilotChargeableUsd: 120, chargeableUsd: 12, activeUsers: 2, avgPerUserUsd: 25, sharePct: 50 / 58 },
      { regionId: 'rb', code: 'rb', displayName: 'Region B', genuineUsd: 8, anthropicChargeableUsd: 0, copilotChargeableUsd: 0, chargeableUsd: 0, activeUsers: 1, avgPerUserUsd: 8, sharePct: 8 / 58 },
    ],
    // §B chargeback-by-region ranking (bill lane) — the chargeback-lane swap for regionCards.
    chargebackByRegion: [
      { regionId: 'ra', label: 'Region A', chargeableUsd: 12 },
      { regionId: 'rb', label: 'Region B', chargeableUsd: 0 },
    ],
    ...over,
  }
}

const drivers: AcrossDriversResp = {
  axis: 'teammate',
  headlineUsd: 58,
  rows: [
    { key: 'd', label: 'dave', usd: 30, sharePct: 30 / 58, spendClass: 'pooled-usage' },
    { key: 'a', label: 'alice', usd: 20, sharePct: 20 / 58, spendClass: 'indicative' },
    { key: 'b', label: 'bob', usd: 8, sharePct: 8 / 58, spendClass: 'indicative' },
  ],
  concentration: {
    activeUsers: 3,
    totalUsd: 58,
    top1: 30 / 58,
    top5: 30 / 58,
    top10: 50 / 58,
    segments: [
      { key: 'power', label: 'Power users', count: 1, totalUsd: 30, sharePct: 30 / 58, avgUsd: 30, medianUsd: 30 },
      { key: 'heavy', label: 'Heavy users', count: 1, totalUsd: 20, sharePct: 20 / 58, avgUsd: 20, medianUsd: 20 },
      { key: 'typical', label: 'Typical users', count: 0, totalUsd: 0, sharePct: 0, avgUsd: 0, medianUsd: 0 },
      { key: 'light', label: 'Light users', count: 1, totalUsd: 8, sharePct: 8 / 58, avgUsd: 8, medianUsd: 8 },
    ],
  },
}

const modelDrivers: AcrossDriversResp = {
  axis: 'model',
  headlineUsd: 58,
  rows: [
    { key: 'opus', label: 'claude-opus-4', usd: 38, sharePct: 38 / 58, spendClass: 'indicative' },
    { key: 'sonnet', label: 'claude-sonnet-4', usd: 20, sharePct: 20 / 58, spendClass: 'indicative' },
  ],
  concentration: drivers.concentration,
}

const trend: AcrossTrend = {
  window: { from: '2026-05-12', to: '2026-07-10' },
  series: [
    { day: '2026-07-08', key: 'claude-code', value: 12 },
    { day: '2026-07-09', key: 'copilot-cli', value: 6 },
  ],
  // §B daily Anthropic chargeback series (bill lane) — feeds the §B spend-trend card.
  chargeSeries: [
    { day: '2026-07-08', chargeUsd: 6 },
    { day: '2026-07-09', chargeUsd: 6 },
  ],
  // The per-lane widening (lane-visuals V2) — Σ lanes per day == chargeSeries[day].
  chargeLanes: [
    { day: '2026-07-08', lane: 'claude', chargeUsd: 6 },
    { day: '2026-07-09', lane: 'claude', chargeUsd: 4 },
    { day: '2026-07-09', lane: 'claude-ai', chargeUsd: 2 },
  ],
  // Canonical §A per-surface weekly usage cells (requirement 1) — the usage-view
  // hero + donut. Now the SAME basis as the KPI strip above them.
  usageWeeklyLanes: [
    { weekStart: '2026-06-29', lane: 'claude', usd: 40 },
    { weekStart: '2026-06-29', lane: 'claude-ai', usd: 18 },
    { weekStart: '2026-07-06', lane: 'claude', usd: 22 },
    { weekStart: '2026-07-06', lane: 'claude-ai', usd: 9 },
  ],
}

const seasonality: Seasonality = {
  window: { from: '2026-05-12', to: '2026-07-10' },
  weeks: ['2026-W27', '2026-W28'],
  cells: [
    { dow: 0, weekIdx: 0, value: 10 },
    { dow: 2, weekIdx: 1, value: 20 },
  ],
  // §B day-of-week Anthropic chargeback (bill lane), 7 buckets — feeds the §B dow card.
  chargeDow: [
    { dow: 0, chargeUsd: 8 },
    { dow: 1, chargeUsd: 0 },
    { dow: 2, chargeUsd: 4 },
    { dow: 3, chargeUsd: 0 },
    { dow: 4, chargeUsd: 0 },
    { dow: 5, chargeUsd: 0 },
    { dow: 6, chargeUsd: 0 },
  ],
}

const activeTrend: ActiveTrend = {
  window: { from: '2026-05-12', to: '2026-07-10' },
  series: [
    { day: '2026-07-08', claudeCode: 2, copilot: 1 },
    { day: '2026-07-09', claudeCode: 3, copilot: 2 },
  ],
}

const baseProps = {
  drivers,
  modelDrivers,
  trend,
  seasonality,
  activeTrend,
  driversAxis: 'teammate',
  trendWindowLabel: 'Last 60 days',
  exportParams: { scope: 'across-regions', report: 'drivers', axis: 'teammate', month: '2026-07' },
  exportFilename: 'tokenscope-across-regions-drivers-teammate-2026-07.csv',
}

const seen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="across-data"]').exists(),
})

describe('ScopeAcrossRegionsView — the four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: null, pending: true }, global })
    expect(seen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the fetch failed', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: null, pending: false, error: new Error('boom') }, global })
    const s = seen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the period has no genuine/chargeable/active data', () => {
    const report = makeReport({ kpis: { genuineUsd: 0, chargeableUsd: 0, anthropicChargeableUsd: 0, tokens: 0, activeUsers: 0, momDeltaPct: null, chargeMomDeltaPct: null, avgPerUserUsd: 0 }, regionCards: [] })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders KPIs + surface hero + trends + region + drivers + models + export, and NO seasonality card', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    const kpi = w.find('[data-testid="scope-kpi-genuine"]')
    expect(kpi.text()).toContain('Attributed usage')
    expect(kpi.text()).toContain('$58')
    // ONE subline (prototype fix 2b): the "≈ $X will be charged" caption is gone —
    // it put a §B estimate inside a §A tile that already sits beside the real
    // chargeable figure. The Copilot-pending caveat rides the Chargeable tile.
    expect(kpi.text().toLowerCase()).not.toContain('will be charged')
    expect(w.find('[data-testid="scope-kpi-chargeable"]').text().toLowerCase()).toContain('copilot pending')
    expect(w.find('[data-testid="scope-hero"]').exists()).toBe(true)
    // requirement 1: the canonical §A composition hero + its pinned donut REPLACE
    // the old billed-showback basis; SAME basis as the §A KPI strip above.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-hero-basis"]').text()).toContain('attributed usage · all surfaces · weekly')
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-active-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(true)
    /*
     * "When spend happens" is DELETED, both lenses and both widths (prototype
     * `note('back', …)`: day-of-week seasonality is interesting once, not every
     * week). Asserted as an ABSENCE, like the surface donut before it, so the
     * card cannot creep back in unnoticed.
     */
    expect(w.find('[data-testid="across-seasonality-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-region-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-drivers-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-top-models"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('requirement 5: every provider clock and the coverage marker survive, inside the ONE notes disclosure', () => {
    /*
     * The chips MOVED, they were not deleted. They used to stack in the header
     * above the first figure — three of them saying the same "month in progress"
     * — so the reader met six lines of caveat before the headline. Requirement 5
     * is still satisfied: every vendor clock renders, and so does the coverage
     * marker, just one disclosure deeper.
     *
     * This asserts CONTAINMENT, not mere existence: a chip that escaped back into
     * the header would still pass an `exists()` check while re-creating the exact
     * defect this change removes.
     */
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const panel = w.find('[data-testid="report-header-notes-panel"]')
    expect(panel.exists()).toBe(true)
    // The fixture's meta.providerStates carries BOTH anthropic and usage.
    expect(panel.find('[data-testid="notes-settling-anthropic"]').exists()).toBe(true)
    expect(panel.find('[data-testid="notes-settling-usage"]').exists()).toBe(true)
    // requirement 5 (coverage): the CoverageMarker still wires through meta.coverage.
    const coverage = panel.find('[data-testid="coverage-marker"]')
    expect(coverage.exists()).toBe(true)
    expect(coverage.text()).toContain('4')
    expect(coverage.text()).toContain('5')
    // The lens explainer came with them — it is no longer printed under the control.
    expect(panel.find('[data-testid="notes-lane-caption"]').text()).toContain('Provider usage truth')
    expect(w.find('[data-testid="lane-caption"]').exists()).toBe(false)
  })

  it('the notes TRIGGER states the provisional/coverage state without being opened', () => {
    /*
     * The one thing this collapse must not cost: a reader discovering only by
     * clicking that a figure is provisional. The trigger is not an icon — it
     * carries the collapsed settling word AND, when the denominator is unclaimed,
     * the coverage word.
     */
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const trigger = w.find('[data-testid="report-header-notes-trigger"]')
    expect(trigger.exists()).toBe(true)
    // Both fixture clocks are 'settling' → SettlingStateChip's own word for it.
    expect(trigger.text()).toContain('Settling')
    // ONE affordance, not one per caveat.
    expect(w.findAll('[data-testid="report-header-notes"]')).toHaveLength(1)
  })

  it('the collapsed settling word follows the WEAKEST clock, not the majority', () => {
    /*
     * Three chips became one, so the one must not round the disagreement away in
     * the flattering direction. With one estimated provider among settling ones
     * the summary reads "Estimated" — the least settled state — or the collapse
     * would have made the page look further along than its weakest source.
     */
    const report = makeReport({
      meta: {
        ...meta,
        providerStates: [
          { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-08-30', closeRun: false as const },
          { vendor: 'usage' as const, state: 'estimated' as const, settlesAt: '2026-09-04', closeRun: false as const },
        ],
      },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="report-header-notes-trigger"]').text()).toContain('Estimated')
  })

  /*
   * ONE CHIP, NOT THREE. The header used to carry a settling chip, a coverage chip
   * AND a "What these figures are" link. The settling word leads because "is this
   * final?" is the question every figure on the page raises; coverage is a
   * qualifier on one denominator and moves inside.
   *
   * MUTATION: render `coverageWord` on the trigger again beside `settlingWord` —
   * the "exactly one" assertion goes red.
   */
  it('collapses to exactly ONE chip, and drops the separate link', () => {
    const report = makeReport({
      meta: { ...meta, coverage: { applicable: true, denominator: null, connected: 4, nonConnected: 0, stale: false } },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    const trigger = w.find('[data-testid="report-header-notes-trigger"]')
    expect(trigger.text()).toBe('Settling')
    expect(trigger.text()).not.toContain('Coverage')
    expect(w.html()).not.toContain('What these figures are')
    // Nothing is deleted — the coverage marker is inside the panel.
    expect(w.find('[data-testid="report-header-notes-panel"] [data-testid="coverage-marker"]').text())
      .toContain('Coverage unknown')
  })

  /*
   * …but coverage still gets the chip to ITSELF when there is no settling clock,
   * so an unclaimed denominator can never go unsignalled.
   *
   * MUTATION: make `chipWord` read `settlingWord` alone — this goes red.
   */
  it('an unclaimed denominator with no settling clock still raises the chip', () => {
    const report = makeReport({
      meta: {
        ...meta,
        providerStates: [],
        coverage: { applicable: true, denominator: null, connected: 4, nonConnected: 0, stale: false },
      },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="report-header-notes-trigger"]').text()).toBe('Coverage unknown')
  })

  /*
   * A PAGE WITH NOTHING TO CAVEAT SAYS NOTHING.
   *
   * MUTATION: gate the disclosure on the lane caption again (the old `hasContent`)
   * — the chip reappears over a page with nothing provisional on it and this goes red.
   */
  it('renders NO chip when nothing is provisional and coverage is claimed', () => {
    const report = makeReport({
      meta: {
        ...meta,
        providerStates: [],
        coverage: { applicable: true, denominator: 5, connected: 5, nonConnected: 0, stale: false },
      },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="report-header-notes"]').exists()).toBe(false)
  })
})

describe('ScopeAcrossRegionsView — every KPI tile carries its OWN delta (no standalone MoM card)', () => {
  it('rising: the attributed-usage tile carries an up arrow, no RAG-green tint', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const t = w.find('[data-testid="scope-kpi-genuine"]')
    const delta = t.find('[data-testid="kpi-delta"]')
    expect(delta.exists()).toBe(true)
    expect(delta.text()).toContain('\u2191')
    expect(delta.text()).toContain('93%') // fmtPct(|28/30|), unsigned — the arrow carries direction
    expect(delta.text()).toContain('vs last month')
    expect(t.html()).not.toContain('rag-green')
    expect(t.html()).not.toContain('rag-red')
  })

  it('falling: down arrow, no RAG-red tint', () => {
    const report = makeReport({ kpis: { ...makeReport().kpis, momDeltaPct: -0.2 } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    const delta = w.find('[data-testid="scope-kpi-genuine"]').find('[data-testid="kpi-delta"]')
    expect(delta.text()).toContain('\u2193')
    expect(delta.text()).toContain('20%')
    expect(delta.html()).not.toContain('rag-red')
    expect(delta.html()).not.toContain('rag-green')
  })

  it('there is no standalone "MoM change" tile to be ambiguous about its lane', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="scope-kpi-mom"]').exists()).toBe(false)
    expect(w.find('[data-testid="scope-kpi-row"]').text()).not.toContain('MoM')
  })

  it('withholds the delta (never hides the figure) when there is no prior operand', () => {
    const report = makeReport({ kpis: { ...makeReport().kpis, momDeltaPct: null } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    const t = w.find('[data-testid="scope-kpi-genuine"]')
    expect(t.exists()).toBe(true)
    expect(t.find('[data-testid="kpi-delta"]').exists()).toBe(false)
    expect(t.find('[data-testid="kpi-delta-empty"]').text()).toBe('too early to compare')
  })
})

describe('ScopeAcrossRegionsView — Concentration is folded into the Median KPI (fix 6)', () => {
  it('renders NO standalone Concentration card, in either lane', () => {
    for (const lane of ['usage', 'chargeback'] as const) {
      const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false, lane }, global })
      expect(w.find('[data-testid="concentration-card"]').exists()).toBe(false)
      // ...and no "usage only" stand-in where it used to sit either.
      expect(w.find('[data-testid="across-drivers-section"]').text()).not.toContain('Spend concentration')
    }
  })

  it('and does not re-publish the percentiles anywhere else on the page', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    // The fixture's three active people are below the five-person floor, so the
    // Median tile is suppressed here — which means NOTHING on this page states a
    // concentration percentile. One fact, one home, and no second answer.
    expect(w.find('[data-testid="scope-kpi-median"]').exists()).toBe(false)
    expect(w.text()).not.toContain('top 10%')
    expect(w.text()).not.toContain('Power users')
  })
})

describe('ScopeAcrossRegionsView — the Copilot chargeback marker', () => {
  it('shows the "pending" chip in pool-utilisation mode (pre-Wave-0 validation)', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const chip = w.find('[data-testid="scope-copilot-pending"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text().toLowerCase()).toContain('pending')
  })

  it('hides the pending chip once chargeback mode is validated', () => {
    const report = makeReport({ copilot: { mode: 'chargeback', pending: false, chargeableUsd: 120 }, kpis: { genuineUsd: 58, chargeableUsd: 132, anthropicChargeableUsd: 12, tokens: 4000, activeUsers: 3, momDeltaPct: 28 / 30, chargeMomDeltaPct: null, avgPerUserUsd: 58 / 3 } })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false }, global })
    expect(w.find('[data-testid="scope-copilot-pending"]').exists()).toBe(false)
  })
})

describe('ScopeAcrossRegionsView — the §A/§B lane re-lens', () => {
  it('publishes the coverage denominator beside the §A total, naming the whole company', () => {
    /*
     * The whole point of the qualifier is that it travels with the total, and the
     * scope it names must be the node's own (contract C11) — here, the enterprise.
     */
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const note = w.find('[data-testid="budget-coverage-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('the whole company')
    // It is a qualifier ON the headline: the denominator it names IS kpis.genuineUsd.
    expect(Number(note.attributes('data-total-usd'))).toBe(makeReport().kpis.genuineUsd)
  })

  it('withholds the §A coverage note under a CHARGEBACK headline', () => {
    // Its parts partition the attributed-usage total, not the chargeable one — under
    // a §B headline it would read as qualifying a figure it was never computed from.
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    expect(w.find('[data-testid="budget-coverage-note"]').exists()).toBe(false)
  })

  it('USAGE lane (default): the §A analytics render full-fidelity, region rank reads "Usage by region"', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    // The billed hero + donut lead (iter-2 I1); §A cards present, no placeholder.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-drivers-section"]').exists()).toBe(true)
    expect(w.find('[data-testid="usage-only-card"]').exists()).toBe(false)
    /*
     * NO page-level LaneLegend in the usage lens any more: SurfaceHeroCard
     * carries its own totals legend, under the bars it names and with each
     * lane's dollars beside it. A second key at the top of the page would be
     * the weaker of two.
     */
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(false)
    const totals = w.find('[data-testid="surface-hero-totals-legend"]')
    expect(totals.exists()).toBe(true)
    expect(totals.text()).toContain('Claude Code')
    // The hero shows the usage headline; the KPI money tiles are not greyed.
    expect(w.find('[data-testid="across-region-rank"]').text()).toContain(
      'Attributed usage by region',
    )
    // The row no longer re-lenses tile-by-tile, and Tokens was deleted outright
    // (prototype `note('fix 2b', …)`), so there is no greyed §A tile to check.
    expect(w.find('[data-testid="scope-kpi-genuine"]').exists()).toBe(true)
    expect(w.find('[data-testid="scope-kpi-tokens"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane: the HEADLINE re-lenses; the tile row does not; §A cards swap to §B', () => {
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    // Hero re-lensed to the §B chargeable cost-of-record.
    const hero = w.find('[data-testid="scope-hero"]')
    expect(hero.find('[data-testid="scope-hero-total"]').text()).toBe('$12.00')
    expect(hero.find('[data-testid="scope-hero-context"]').text()).toContain('chargeable')

    // The TILE ROW does not re-lens: both money figures render in both lenses
    // ("both matter equally"), and the two cohort tiles are §A in both — so no
    // tile is greyed, swapped, or relabelled to a bill-lane analogue it is not.
    expect(w.find('[data-testid="scope-kpi-genuine"]').exists()).toBe(true)
    expect(w.find('[data-testid="scope-kpi-chargeable"]').exists()).toBe(true)
    const active = w.find('[data-testid="scope-kpi-active"]')
    expect(active.text()).toContain('Active people')
    expect(active.text()).not.toContain('Billed teammates')
    expect(w.find('[data-testid="scope-kpi-row"]').text()).not.toContain('Billed tokens')
    // The hero's ONE surviving caveat: the two cohort tiles do not re-lens, which
    // nothing else on the row says. The three sentences that used to sit beside it
    // restated the Chargeable tile's own subline and the lane definition.
    const caveat = w.find('[data-testid="scope-chargeback-caveat"]').text()
    expect(caveat).toBe('Active people and Median per person are attributed usage in both lenses.')

    // §A/usage cards RE-LENS to their §B bill-lane analogue (not a usage-only
    // placeholder); the billed hero + donut are usage-view elements and yield too.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-trend-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="chargeback-split-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-card"]').exists()).toBe(true)
    // Its §B twin went with it — the DoW card WAS the seasonality card re-lensed.
    expect(w.find('[data-testid="chargeback-dow-card"]').exists()).toBe(false)

    /*
     * DRIVERS + TOP MODELS NOW RE-LENS TOO. This block used to assert the whole
     * bundle went usage-only, on the reasoning that "the bill lane has NO model
     * dim". That reasoning is no longer true and was never true of the provider:
     * the 2026-08-02 wire capture shows Anthropic sending `data[].model` on
     * 255/255 cost-report rows and Copilot sending
     * `totals_by_language_model[].model` on 756/756, and mig 0118/0120 land both
     * in `provider_usage_fact`. Keeping the placeholder left a chargeback reader
     * with a headline and no breakdown — the question "what is driving it?" had
     * no answer on the page at all.
     *
     * CONCENTRATION no longer needs a placeholder either: the card is gone (fix 6
     * folded its percentiles into the Median-per-person KPI), so this section now
     * carries NO usage-only stand-in at all — every card in it answers the
     * selected lane.
     */
    expect(w.find('[data-testid="across-drivers-section"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-drivers-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-top-models"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="usage-only-card"]').length).toBe(0)

    // The region ranking re-titles + re-ranks to the §B chargeback field.
    expect(w.find('[data-testid="across-region-rank"]').text()).toContain('Chargeback by region')
  })

  it('CHARGEBACK lane renders ONE page-level LaneLegend (union of the cards\' lanes) and lane-mode cards', () => {
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    // The page legend carries the lane union (claude + claude-ai across trend + donut);
    // labels come from the registry.
    const legend = w.find('[data-testid="lane-legend"]')
    expect(legend.exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-claude"]').text()).toContain('Claude Code')
    expect(w.find('[data-testid="lane-legend-claude-ai"]').text()).toContain('Claude Chat')
    // The split card renders the capped+folded lane donut; the trend card the
    // WEEKLY lane stack (iter-2 I2 — the default grain).
    expect(w.find('[data-testid="chargeback-split-donut"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-weekly"]').exists()).toBe(true)
    /*
     * USAGE mode carries NO page legend — SurfaceHeroCard's own totals legend
     * replaced it. The §B lanes must not leak into that card either: the two
     * bases stay separated, so a copilot CHARGEBACK lane can never appear in a
     * §A usage card's key.
     */
    const usage = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(usage.find('[data-testid="lane-legend"]').exists()).toBe(false)
    expect(usage.find('[data-testid="surface-hero-total-copilot-license"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane surfaces the copilot-unclassified badge (visible, never chargeable)', () => {
    const report = makeReport({
      chargebackLanes: [
        { lane: 'claude', chargeUsd: 10 },
        { lane: 'claude-ai', chargeUsd: 2 },
        { lane: 'copilot-license', chargeUsd: 100 },
        { lane: 'copilot-usage', chargeUsd: 20 },
        { lane: 'copilot-unclassified', chargeUsd: 7 },
      ],
      chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: 120 },
    })
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    const badge = w.find('[data-testid="chargeback-split-unclassified"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text().toLowerCase()).toContain('needs mapping')
    // The donut centre reads the CHARGEABLE total — unclassified (7) excluded: 132.
    const donut = w.find('[data-testid="chargeback-split-donut"]')
    expect(donut.exists()).toBe(true)
    // The unclassified lane is not colour-encoded → not a legend entry either.
    expect(w.find('[data-testid="lane-legend-copilot-unclassified"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-legend-copilot-license"]').exists()).toBe(true)
  })

  it('CHARGEBACK lane, $0 Anthropic + non-zero pooled Copilot: BOTH cards stay in lane mode (r3-6)', () => {
    // No Anthropic per-teammate chargeback this month, but validated pooled
    // Copilot lanes exist — the ONE page-level signal must put BOTH cards in
    // lane mode: donut on the split card, the lane-vocabulary EMPTY state on
    // the trend card — never the legacy single-series card silently.
    const report = makeReport({
      chargebackLanes: [
        { lane: 'copilot-license', chargeUsd: 100 },
        { lane: 'copilot-usage', chargeUsd: 20 },
      ],
      chargebackProviderSplit: { anthropicUsd: 0, copilotUsd: 120 },
    })
    const zeroTrend: AcrossTrend = {
      ...trend,
      chargeSeries: [
        { day: '2026-07-08', chargeUsd: 0 },
        { day: '2026-07-09', chargeUsd: 0 },
      ],
      chargeLanes: [],
    }
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, trend: zeroTrend, report, pending: false, lane: 'chargeback' },
      global,
    })
    // The page legend lists the Copilot lanes (the shared signal's source)...
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-copilot-license"]').exists()).toBe(true)
    // ...the split card renders the lane donut...
    expect(w.find('[data-testid="chargeback-split-donut"]').exists()).toBe(true)
    // ...and the trend card shows its LANE-MODE state: the lane vocabulary +
    // the explicit empty note — not the legacy single-series chart.
    const trendCard = w.find('[data-testid="chargeback-trend-card"]')
    expect(trendCard.text()).toContain('by surface')
    expect(w.find('[data-testid="chargeback-trend-lane-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-lanes"]').exists()).toBe(false)
  })

  it('the two lanes’ deltas never cross: each money tile carries its OWN lane’s MoM', () => {
    const report = makeReport({
      kpis: { ...makeReport().kpis, momDeltaPct: null, chargeMomDeltaPct: 0.5 },
    })
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report, pending: false, lane: 'chargeback' }, global })
    // §B has an operand and shows it; §A does not and says so — on its own tile.
    const charge = w.find('[data-testid="scope-kpi-chargeable"]')
    expect(charge.find('[data-testid="kpi-delta"]').text()).toContain('↑')
    expect(charge.find('[data-testid="kpi-delta"]').text()).toContain('50%')
    const genuine = w.find('[data-testid="scope-kpi-genuine"]')
    expect(genuine.find('[data-testid="kpi-delta"]').exists()).toBe(false)
    expect(genuine.find('[data-testid="kpi-delta-empty"]').exists()).toBe(true)
  })
})

/*
 * ── The two bands ────────────────────────────────────────────────────────────
 *
 * THE DEFECT. This page renders figures over TWO windows — the selected period
 * and a decoupled rolling one — and used to interleave them with nothing but
 * per-card captions to tell them apart. A $409 60-day donut sat directly under a
 * $12,855 month-to-date headline, so the page read as arithmetically broken.
 *
 * The band header is the whole fix, which makes MEMBERSHIP the thing to pin: a
 * rolling card that ends up under the period header is worse than the old page,
 * because the window is now stated confidently and wrongly. These assert DOM
 * containment rather than order — order alone would pass with the header in the
 * wrong place.
 */
describe('ScopeAcrossRegionsView — the period band and the rolling band', () => {
  const rangeMeta = { ...meta, range: { from: '2026-06-14', to: '2026-08-02' } }

  it('states the period window ONCE — on the hero, not also on a band header above it', () => {
    /*
     * The period band used to carry a header reading "July 2026 · attributed
     * usage · the whole company · month to date" directly above a hero opening
     * "July 2026 · $39,702.37 · attributed usage · the whole company · month to
     * date · day 14 of 31". The same window, the same lane and the same scope,
     * twice, one line apart — and only the second one carried the figure.
     *
     * This asserts the ABSENCE is real (no band header element at all in the
     * period band) AND that the sentence survived on the hero. Asserting only
     * the absence would pass on a page that had lost the window entirely.
     */
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const period = w.find('[data-testid="across-band-period"]')
    expect(period.exists()).toBe(true)
    expect(period.find('[data-testid="report-band-window"]').exists()).toBe(false)
    expect(period.find('[data-testid="report-band-basis"]').exists()).toBe(false)

    const hero = w.find('[data-testid="scope-hero-line"]')
    expect(hero.find('[data-testid="scope-hero-period"]').text()).toBe('July 2026')
    // Lane, scope and pace — the three things the deleted header also carried.
    // (`forecast: null` in this fixture ⇒ a closed month ⇒ "full month".)
    const context = hero.find('[data-testid="scope-hero-context"]').text()
    expect(context).toContain('attributed usage')
    expect(context).toContain('the whole company')
    expect(context).toContain('full month')

    // The ROLLING band keeps its header: it says something no card inside says.
    const rolling = w.find('[data-testid="across-band-rolling"]')
    expect(rolling.find('[data-testid="report-band-window"]').text()).toBe('Last 60 days')
    expect(rolling.find('[data-testid="report-band-basis"]').text()).toContain('rolling')
  })

  it('says on the rolling band that it does NOT sum into the month above it', () => {
    // The sentence the whole redesign turns on: without it a reader is left to
    // conclude the two totals disagree because one of them is wrong.
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="across-band-rolling"] [data-testid="report-band-note"]').text()).toBe(
      'does not sum into July',
    )
  })

  it('puts every ROLLING-window card inside the rolling band', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const rolling = w.find('[data-testid="across-band-rolling"]')
    for (const id of [
      'surface-hero-card',
      'across-active-trend-card',
      'across-trend-card',
      'spend-per-developer-card',
      'tier-exposure-card',
    ]) {
      expect(rolling.find(`[data-testid="${id}"]`).exists(), `${id} belongs to the rolling band`).toBe(true)
    }
  })

  it('puts every PERIOD-window card inside the period band, and leaks none into the other', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const period = w.find('[data-testid="across-band-period"]')
    for (const id of ['scope-hero', 'across-drivers-section']) {
      expect(period.find(`[data-testid="${id}"]`).exists(), `${id} belongs to the period band`).toBe(true)
    }
    const rolling = w.find('[data-testid="across-band-rolling"]')
    expect(rolling.find('[data-testid="scope-hero"]').exists()).toBe(false)
    expect(rolling.find('[data-testid="across-drivers-section"]').exists()).toBe(false)
  })

  it('does NOT claim two IDENTICAL windows fail to sum, in custom-range mode', () => {
    /*
     * In range mode the caller's from/to drives BOTH bands (the container's
     * `trendWindowQuery` returns it verbatim), so "does not sum into June" would
     * be false — and false in the direction that tells a reader two comparable
     * figures cannot be compared.
     */
    const report = makeReport({ meta: rangeMeta })
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report, pending: false, trendWindowLabel: '2026-06-14 → 2026-08-02' },
      global,
    })
    expect(w.find('[data-testid="across-band-rolling"] [data-testid="report-band-note"]').text()).toBe(
      'same window as the band above',
    )
    // The period window is now stated by the hero — the band above carries no
    // header of its own — so the range is asserted where it is actually printed.
    expect(w.find('[data-testid="scope-hero-period"]').text()).toBe('2026-06-14 → 2026-08-02')
  })

  it('carries NO page-level lane legend in the usage lens; the §B one sits with its cards', () => {
    /*
     * The legend used to float above both bands. In the USAGE lens it is gone
     * outright — SurfaceHeroCard's totals bar is the key now, under the bars it
     * names. In the CHARGEBACK lens it is still needed (both chargeback cards
     * render no legend of their own), so it moved down beside the first of them
     * rather than staying in the page chrome.
     */
    const usage = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(usage.findAll('[data-testid="lane-legend"]')).toHaveLength(0)

    const charge = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    // Still exactly ONE — moving it must not become duplicating it.
    expect(charge.findAll('[data-testid="lane-legend"]')).toHaveLength(1)
    expect(charge.find('[data-testid="across-band-period"] [data-testid="lane-legend"]').exists()).toBe(true)
  })

  it('bands the CHARGEBACK lens by window too — split card period, trend rolling', () => {
    /*
     * The §B split card reads the period's chargeback lanes and the §B trend card
     * reads the rolling series. They were adjacent, which made them look like one
     * window's pair.
     */
    const w = mount(ScopeAcrossRegionsView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    expect(w.find('[data-testid="across-band-period"] [data-testid="chargeback-split-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="across-band-rolling"] [data-testid="chargeback-trend-card"]').exists()).toBe(true)
    // The lane is named by the HERO now, not by a period-band header (there is none).
    expect(w.find('[data-testid="scope-hero-context"]').text()).toContain('chargeable')
  })

  /*
   * ── Band-2 order ──────────────────────────────────────────────────────────
   *
   * The prototype orders the rolling band: active developers → spend trend →
   * spend per active developer → where the AI spend goes. Dev LED with the last
   * of those — a composition breakdown offered before the reader has been told
   * whether the total moved or whether more people arrived.
   *
   * Asserted as relative DOM position, because "renders" was already true of all
   * four and told us nothing about the defect.
   */
  it('orders the rolling band: population → money → money per head → composition', () => {
    const w = mount(ScopeAcrossRegionsView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const html = w.find('[data-testid="across-band-rolling"]').html()
    const at = (id: string) => {
      const i = html.indexOf(`data-testid="${id}"`)
      expect(i, `${id} renders in the rolling band`).toBeGreaterThan(-1)
      return i
    }
    expect(at('across-active-trend-card')).toBeLessThan(at('across-trend-card'))
    expect(at('across-trend-card')).toBeLessThan(at('spend-per-developer-card'))
    expect(at('spend-per-developer-card')).toBeLessThan(at('surface-hero-card'))
    expect(at('surface-hero-card')).toBeLessThan(at('tier-exposure-card'))
  })
})
