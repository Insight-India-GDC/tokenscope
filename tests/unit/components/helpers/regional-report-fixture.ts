/*
 * The canonical RegionalReport fixture, shared by every test that mounts
 * ScopeRegionalView.
 *
 * It lives here rather than in one test file because a second copy is a second
 * definition: the view's required shape changes (a new required field, a
 * renamed lane) would then be satisfied in one test and quietly stale in the
 * other, which is how a test starts certifying a shape the component no longer
 * has.
 */
import type { RegionalReport } from '../../../../app/components/reporting/regional/regional-view-types'
import type { ProviderSplit } from '../../../../shared/reports/types'

/*
 * Mount options for the pure View. DateRangeControl / LaneToggle / LaneSwitchLink
 * self-wire to useReportState (a Nuxt auto-import, undefined here);
 * ClientOnly / VChart are Nuxt / nuxt-echarts globals the chart kit renders.
 * Shared for the same reason the fixture is: a test that stubs a DIFFERENT set
 * fails for reasons that have nothing to do with what it is asserting.
 */
export const regionalViewGlobal = {
  stubs: {
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    DateRangeControl: true,
    LaneToggle: true,
    LaneSwitchLink: true,
    UiRegionSelector: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

export const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: [
    { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-08-30', closeRun: false as const },
    { vendor: 'usage' as const, state: 'settling' as const, settlesAt: '2026-09-04', closeRun: false as const },
  ],
  scope: 'regional' as const,
}

export const providerSplit: ProviderSplit = {
  claudeCode: { spendUsd: 32, activeUsers: 2 },
  copilotCli: { spendUsd: 15, activeUsers: 1 },
  // Three-lane §A ceiling: copilot-agent reads 0 today (absent from v_complete_usage).
  copilotAgent: { spendUsd: 0, activeUsers: 0 },
  other: { spendUsd: 3, activeUsers: 1 },
}

export function makeReport(over: Partial<RegionalReport> = {}): RegionalReport {
  return {
    meta,
    region: { id: 'r1', code: 'ra', displayName: 'Region A' },
    regionOptions: [],
    drill: null,
    kpis: { genuineUsd: 50, chargeableUsd: 12, anthropicChargeableUsd: 12, tokens: 1000, activeUsers: 2, momDeltaPct: null, chargeMomDeltaPct: null, billedTeammates: 1, billedTokens: 800, avgChargePerBilledUser: 12 },
    copilot: { mode: 'pool-utilisation', pending: true, chargeableUsd: null },
    forecast: null,
    actualUsd: 50,
    dailyMetrics: [
      { day: '2026-07-02', genuineUsd: 20, tokens: 500, activeUsers: 2 },
      { day: '2026-07-03', genuineUsd: 30, tokens: 500, activeUsers: 2 },
    ],
    // The coverage qualifier for `kpis.genuineUsd` — the four parts foot to it (50),
    // as the server guarantees, so the fixture cannot certify a note that does not add up.
    // `scopeLabel` is the server's own name for the scope it clamped to; here that is
    // the region, matching `region.displayName`. Tests that need a DIFFERENT scope (a
    // drill, or a manager's subtree) must override it — the view may not derive one.
    budgetCoverage: {
      scopeLabel: 'Region A',
      totalUsd: 50,
      budgetedUsd: 8,
      taggedNoBudgetUsd: 12,
      untaggedUsd: 25,
      untaggableUsd: 5,
    },
    // §B per-day Anthropic chargeback (bill lane) — the Chargeable-tile sparkline source.
    chargeDaily: [
      { day: '2026-07-02', chargeUsd: 6 },
      { day: '2026-07-03', chargeUsd: 6 },
    ],
    // §B provider split (bill lane) — Anthropic vs Copilot pooled (null while pending).
    chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null },
    // §B per-lane chargeback totals (lane-visuals V2-Regional) — Σ == anthropicChargeableUsd (12).
    chargebackLanes: [
      { lane: 'claude', chargeUsd: 10 },
      { lane: 'claude-ai', chargeUsd: 2 },
    ],
    practices: [{ key: 'a', label: 'Practice A', value: 50, spendClass: 'indicative', isDefault: false }],
    chargebackByCostCentre: [
      { key: 'cou-a', label: 'Practice A', value: 12 },
      { key: '__unallocated', label: 'Unallocated', value: 0 },
    ],
    vendorSplit: null,
    exceptions: [],
    velocityThreshold: 0.25,
    providerSplit,
    ...over,
  }
}
