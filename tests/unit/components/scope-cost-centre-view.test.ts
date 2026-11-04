// @vitest-environment happy-dom
/*
 * ScopeCostCentreView — the rebuilt Cost-Centre BUDGET TRACKER (reporting-redesign
 * wave B). Verifies build-design §3's "exactly one of skeleton / error / empty /
 * data" contract (for BOTH the grid and the drill), the RAG budget-state
 * distinction (over / near / on-track / no-budget-set), the two visually distinct
 * on-track mechanics (exhaustion DATE vs run-rate DOLLAR), and the §A BURN drill
 * (burn headline + vendor donut + drivers, incl. a placement-moved top spender).
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeCostCentreView from '../../../app/components/reporting/ScopeCostCentreView.vue'
import type {
  CostCentreReport,
  CostCentreDrill,
} from '../../../app/components/reporting/cost-centre/cost-centre-view-types'
import type { OverSoftCap } from '#shared/reports/types'
// Asserted through the CONSTANT, not the words: this pair of assertions is
// about WHICH CLAMP each hero states, and hard-coding the noun made a
// vocabulary change look like a behaviour regression.
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

// DateRangeControl self-wires to the auto-imported useReportState (undefined outside
// Nuxt); ClientOnly/VChart are Nuxt/nuxt-echarts globals. Stub all so the View mounts.
const global = {
  stubs: {
    DateRangeControl: true,
    LaneToggle: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
    // BAND 2's cards. Stubbed so a test can hand this view a `trend` purely to
    // exercise Band 1's empty-state guard (which must know whether the band
    // below carries money) without mounting four charting components that pull
    // in `useReportState`.
    ActiveUsersTrendCard: true,
    SpendTrendCard: true,
    SpendPerDeveloperCard: true,
    SurfaceHeroCard: true,
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
  coverage: { applicable: true, denominator: 3, connected: 3, nonConnected: 0, stale: false },
  scope: 'cost-centre' as const,
}

function forecast(projectedUsd: number) {
  return {
    asOfDate: '2026-07-02',
    daysElapsed: 2,
    daysInMonth: 31,
    factor: 15.5,
    meteredMtdUsd: projectedUsd / 15.5,
    meteredProjectedUsd: projectedUsd,
    projectedUsd,
  }
}

// Four cards spanning every RAG state: over / near / on-track / no-budget-set.
function makeReport(over: Partial<CostCentreReport> = {}): CostCentreReport {
  return {
    meta,
    laneNote: 'Business Unit burn is usage on the projects each Business Unit leads.',
    cards: [
      { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', burnUsd: 120, chargeUsd: 90, allocationUsd: 100, utilisation: 1.2, exhaustionDate: '2026-07-13', forecast: forecast(775), asOfDate: '2026-07-02' },
      { id: 'b', code: 'b', displayName: 'Practice B', regionCode: 'rb', burnUsd: 85, chargeUsd: 60, allocationUsd: 100, utilisation: 0.85, exhaustionDate: '2026-07-20', forecast: forecast(500), asOfDate: '2026-07-02' },
      { id: 'c', code: 'c', displayName: 'Practice C', regionCode: 'rc', burnUsd: 40, chargeUsd: 25, allocationUsd: 100, utilisation: 0.4, exhaustionDate: null, forecast: forecast(300), asOfDate: '2026-07-02' },
      { id: 'd', code: 'd', displayName: 'Practice D', regionCode: 'rd', burnUsd: 10, chargeUsd: 0, allocationUsd: null, utilisation: null, exhaustionDate: null, forecast: forecast(60), asOfDate: '2026-07-02' },
    ],
    summary: {
      totalBurnUsd: 255,
      totalAllocationUsd: 300,
      countOverBudget: 1,
      countNearBudget: 1,
      countOnTrack: 1,
      countNotStarted: 0,
      countNoAllocation: 1,
      asOfDate: '2026-07-02',
    },
    ...over,
  }
}

/*
 * The over-the-soft-cap card's payload. Roster-anchored, so `rosterUsd` is
 * deliberately UNEQUAL to the drill's burn: they are different denominators over
 * different populations, and a fixture where they matched could not catch a view
 * that rendered one under the other's label.
 */
function makeOverSoftCap(over: Partial<OverSoftCap> = {}): OverSoftCap {
  return {
    softCapUsd: 100,
    rosterCount: 4,
    rosterUsd: 1210,
    allocatedUsd: 690,
    unallocatedUsd: 520,
    over: [
      {
        teammateId: 't1', teammate: 'Phil H', unallocatedUsd: 400, capMultiple: 4,
        taggedRate: 0.5, projects: 2, group: 'on-projects',
      },
      {
        teammateId: 't2', teammate: 'Dana W', unallocatedUsd: 110, capMultiple: 1.1,
        taggedRate: 0, projects: 0, group: 'on-no-project',
      },
    ],
    withinAllowance: { teammates: 2, unallocatedUsd: 10, fullyAllocated: 1 },
    ...over,
  }
}

/** Nobody over the cap AND nothing consumed — the genuinely empty roster. */
const emptyOverSoftCap: OverSoftCap = {
  softCapUsd: 100,
  rosterCount: 3,
  rosterUsd: 0,
  allocatedUsd: 0,
  unallocatedUsd: 0,
  over: [],
  withinAllowance: { teammates: 3, unallocatedUsd: 0, fullyAllocated: 0 },
}

/**
 * The PEOPLE hero's rows — the §A burn axis, footing to the CC burn.
 * Phil H is the largest spender whose CURRENT placement moved; §A homes by
 * emit-time cost_owning_unit_id, so he STAYS in the burn (the bug this fixes).
 */
function peopleRows(): CostCentreDrill['people']['rows'] {
  return [
    { key: 'ph', label: 'Phil H', usd: 90, sharePct: 0.6257, spendClass: 'indicative' },
    { key: 'al', label: 'alice', usd: 33.83, sharePct: 0.2352, spendClass: 'indicative' },
    { key: 'el', label: 'ellen', usd: 20, sharePct: 0.1391, spendClass: 'indicative' },
  ]
}

/**
 * The BUDGETS hero's rows — the project axis, footing to Σ of the cost centre's
 * own projects, which is DELIBERATELY not the burn. Each carries its allocation:
 * a number, or an explicit `null` for a budget nobody has set.
 */
function budgetRows(): CostCentreDrill['budgets']['rows'] {
  return [
    { key: 'p1', label: 'Apollo', usd: 150, sharePct: 0.7895, spendClass: 'indicative', budgetUsd: 200 },
    { key: 'p2', label: 'Borealis', usd: 40, sharePct: 0.2105, spendClass: 'indicative', budgetUsd: null },
  ]
}

function makeDrill(over: Partial<CostCentreDrill> = {}): CostCentreDrill {
  return {
    /*
     * THE HERO PAYLOAD. Required by `CostCentreDrill` since the cost-centre scope
     * reached prototype parity: the month band and its four tiles are drawn by the
     * SAME `ScopeHero` both Region widths use, so a drill without these fields is
     * not a valid response — the component reads `kpis.genuineUsd` directly rather
     * than defending against a shape the type forbids.
     */
    kpis: {
      genuineUsd: 1050,
      chargeableUsd: 820,
      activeUsers: 14,
      momDeltaPct: null,
      chargeMomDeltaPct: null,
    },
    copilot: { pending: true },
    forecast: null,
    budgetCoverage: {
      totalUsd: 1050,
      budgetedUsd: 700,
      taggedNoBudgetUsd: 200,
      untaggedUsd: 150,
      unmatchedUsd: 0,
      scopeLabel: 'AI Apps & Data',
    },
    meta,
    cc: { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra' },
    overSoftCap: makeOverSoftCap(),
    // §A usage BURN — the SAME lane as the tracker card burn.
    burnUsd: 143.83,
    // §B — what the centre is CHARGED. Never summed with the burn above.
    chargeUsd: 96.4,
    copilotChargebackPartialMonth: false,
    vendor: { claudeUsd: 143.83, copilotUsd: 0, otherUsd: 0 },
    allocationUsd: 500,
    // The `?axis=` single-axis answer the endpoint still serves for a script, a
    // saved link and the CSV export. The SCREEN reads the two heroes below.
    axis: 'project',
    headlineUsd: 190,
    denominatorLabel: "this cost centre's projects",
    rows: budgetRows(),
    budgets: { rows: budgetRows(), headlineUsd: 190, denominatorLabel: "this cost centre's projects" },
    people: { rows: peopleRows(), headlineUsd: 143.83, denominatorLabel: 'cost-centre burn' },
    ...over,
  }
}

const baseProps = {
  exportParams: { scope: 'cost-centre', report: 'cards', month: '2026-07' },
  exportFilename: 'tokenscope-cost-centres-2026-07.csv',
  budgetsExportParams: { scope: 'cost-centre', report: 'drivers', cc: 'a', axis: 'project', month: '2026-07' },
  budgetsExportFilename: 'tokenscope-cost-centre-drivers-project-2026-07.csv',
  peopleExportParams: { scope: 'cost-centre', report: 'drivers', cc: 'a', axis: 'teammate', month: '2026-07' },
  peopleExportFilename: 'tokenscope-cost-centre-drivers-teammate-2026-07.csv',
  drillPending: false,
}

const gridSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="cc-grid-data"]').exists(),
})

describe('ScopeCostCentreView — the grid four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: null, drill: null, isDrill: false, pending: true } })
    expect(gridSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the grid fetch failed', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false, error: new Error('boom') } })
    const s = gridSeen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when there are no cost centres in scope', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport({ cards: [] }), drill: null, isDrill: false, pending: false } })
    expect(gridSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders the budget tracker + summary strip + export', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(gridSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="cc-summary-strip"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-budget-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-row-a"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('requirement 5, one popover deeper: every provider clock + the coverage marker survive the collapse (D8b)', () => {
    /*
     * The chips MOVED, they were not deleted. The header used to stack a
     * chip+text pair PER provider plus the coverage sentence; D8b collapses
     * that to ONE least-settled settlement chip whose popover carries each
     * provider's own clock, and a compact coverage chip whose sentence rides
     * its tooltip. The deep assertions on the aggregate rule + removed prose
     * live in cc-header-notes.test.ts (design test 24).
     */
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="cc-settling"]').exists()).toBe(true)
    // Both fixture clocks are 'settling' → the ONE chip carries that word.
    expect(w.find('[data-testid="cc-header-notes-trigger"]').text()).toBe('Settling')
    // Each provider's own clock renders INSIDE the popover, same component, same fields.
    const panel = w.find('[data-testid="cc-header-notes-panel"]')
    expect(panel.find('[data-testid="cc-notes-settling-anthropic"]').exists()).toBe(true)
    expect(panel.find('[data-testid="cc-notes-settling-usage"]').exists()).toBe(true)
    // Coverage keeps a chip of its OWN; the fixture's claimed 3-of-3 rides the tooltip.
    const coverage = w.find('[data-testid="coverage-marker"]')
    expect(coverage.exists()).toBe(true)
    expect(coverage.text()).toContain('Coverage known')
    expect(coverage.attributes('title')).toContain('3 of 3')
  })
})

describe('ScopeCostCentreView — the RAG budget states are visually distinct', () => {
  it('over / near / on-track rows carry their reserved status label; no-budget is clean', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="cc-row-a"]').text()).toContain('Over budget')
    expect(w.find('[data-testid="cc-row-b"]').text()).toContain('Near budget')
    expect(w.find('[data-testid="cc-row-c"]').text()).toContain('On track')
    // No-allocation row: the CLEAN "No budget set" state + hint, never a fake on-track claim.
    const noBudget = w.find('[data-testid="cc-row-d"]')
    expect(noBudget.text()).toContain('No budget set')
    expect(noBudget.text()).toContain('Set an allocation to track burn against budget')
    expect(noBudget.text()).not.toContain('On track')
  })

  it('a budgeted row renders a projected-exhaustion DATE and a separate run-rate DOLLAR', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const exhaustion = w.find('[data-testid="cc-row-exhaustion-a"]')
    expect(exhaustion.exists()).toBe(true)
    expect(exhaustion.text()).toContain('2026-07-13') // Mechanic 1 — a DATE
    expect(exhaustion.text().toLowerCase()).toContain('budget')
    const rowA = w.find('[data-testid="cc-row-a"]')
    expect(rowA.text()).toContain('$775') // Mechanic 2 — the run-rate DOLLAR
    // The no-exhaustion on-track row 'c' has no exhaustion element but still a run-rate.
    expect(w.find('[data-testid="cc-row-exhaustion-c"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-row-c"]').text()).toContain('$300')
  })
})

const drillSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="cc-drill-data"]').exists(),
})

describe('ScopeCostCentreView — the drill four exclusive states', () => {
  it('SKELETON while the drill is pending with no drill data', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: true } })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the drill fetch failed (e.g. a 403 anti-IDOR)', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillError: new Error('403') } })
    expect(drillSeen(w).error).toBe(true)
  })

  it('EMPTY when the cost centre has no burn, NO CHARGE, no budget rows and its roster consumed nothing', () => {
    // EVERY conjunct is needed to reach empty — see the cases below for why.
    const drill = makeDrill({
      burnUsd: 0,
      chargeUsd: 0,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      rows: [],
      overSoftCap: emptyOverSoftCap,
      budgets: { rows: [], headlineUsd: 0, denominatorLabel: "this cost centre's projects" },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('STILL empty when the month is $0 — but it ACKNOWLEDGES the rolling band', () => {
    /*
     * Dev, 2026-08-10. The page announced "No usage recorded for CTO in this
     * period" with sixty days of spend charts drawn directly underneath it.
     * Both halves were individually correct — the month really was $0 and the
     * rolling window really had money — and Band 2 renders independently on
     * purpose, so that a quiet month cannot hide a healthy trend. What nobody
     * wrote was the other direction: an empty state is a claim about the
     * SCREEN, so it has to know what is about to render below it.
     */
    const drill = makeDrill({
      burnUsd: 0,
      chargeUsd: 0,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      rows: [],
      overSoftCap: emptyOverSoftCap,
      budgets: { rows: [], headlineUsd: 0, denominatorLabel: "this cost centre's projects" },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const trend = {
      window: { from: '2026-06-11', to: '2026-08-09' },
      windowDays: 60,
      series: [{ day: '2026-07-01', key: 'claude-code' as const, value: 92.94 }],
      activeTrend: { points: [], toolKeys: [] },
      usageWeeklyLanes: [],
      perDeveloper: { points: [], deltas: null },
    } as unknown as NonNullable<Parameters<typeof mount>[1]>
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false, trend },
    })
    /*
     * The first fix SUPPRESSED the state. An external review pointed out that
     * trades one lie for another — a genuinely empty July viewed while the
     * rolling window holds June and August would render a zero-valued drill
     * instead of saying the month was empty. The state is TRUE, so it stays and
     * reconciles itself with what is drawn below it.
     */
    expect(drillSeen(w).empty).toBe(true)
    expect(w.find('[data-testid="report-empty"]').text()).toMatch(
      /rolling window below covers a different range and does carry spend/i,
    )
  })

  it('says nothing about the band when the band is flat — no caveat for a non-event', () => {
    // The guard tests MONEY, not the payload's existence: keying it on `trend`
    // being non-null would suppress the empty state for a genuinely dead BU and
    // leave the reader with nothing at all.
    const drill = makeDrill({
      burnUsd: 0,
      chargeUsd: 0,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      rows: [],
      overSoftCap: emptyOverSoftCap,
      budgets: { rows: [], headlineUsd: 0, denominatorLabel: "this cost centre's projects" },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const trend = {
      window: { from: '2026-06-11', to: '2026-08-09' },
      windowDays: 60,
      series: [{ day: '2026-07-01', key: 'claude-code' as const, value: 0 }],
      activeTrend: { points: [], toolKeys: [] },
      usageWeeklyLanes: [],
      perDeveloper: { points: [], deltas: null },
    } as unknown as NonNullable<Parameters<typeof mount>[1]>
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false, trend },
    })
    expect(drillSeen(w).empty).toBe(true)
    expect(w.find('[data-testid="report-empty"]').text()).not.toMatch(/rolling window below/i)
  })

  it('the empty state never asserts WHY the BU is empty', () => {
    /*
     * It used to say "No active teammates are placed in this cost centre, SO
     * there is no usage to report." The BU's own owner read that while holding
     * $4,666.97 of that month's spend: they were homed on the region DEFAULT BU
     * (the dumping ground admin flags as "N of M do not belong here"), so the
     * roster was empty and the sentence was a true fact about placement dressed
     * as a cause. It is false as a cause either way — burn is project-homed, so
     * roster size does not determine the total in either direction.
     */
    const drill = makeDrill({
      burnUsd: 0,
      chargeUsd: 0,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      rows: [],
      overSoftCap: { ...emptyOverSoftCap, rosterCount: 0 },
      budgets: { rows: [], headlineUsd: 0, denominatorLabel: "this cost centre's projects" },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    const txt = w.find('[data-testid="report-empty"]').text()
    expect(txt).not.toMatch(/so there is no usage to report/i)
    // It still reports the observation, and names the other route to the money.
    expect(txt).toMatch(/no-one is currently homed/i)
    expect(txt).toMatch(/follows the project it is tagged to/i)
  })

  it('NOT empty when the burn is $0 but the centre is CHARGED — §B money is not "no usage"', () => {
    /*
     * The shape §A and §B exist to keep apart: Copilot's pooled bill homes to a
     * cost centre with nothing attributed behind it, so the §A burn is $0 while
     * real money is charged. Gating "empty" on the §A lane alone would print
     * "No usage recorded for Practice A" to an owner being billed $96.40 — and
     * the chargeback lane renders exactly that figure one element down.
     */
    const drill = makeDrill({
      burnUsd: 0,
      chargeUsd: 96.4,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      rows: [],
      overSoftCap: emptyOverSoftCap,
      budgets: { rows: [], headlineUsd: 0, denominatorLabel: "this cost centre's projects" },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
  })

  it('NOT empty when the burn is $0 but the roster is over the cap — the case the card exists for', () => {
    /*
     * The regression this pins. `cost_owning_unit_id` is the TAGGED PROJECT's cost
     * centre, so a cost centre whose people tag nothing has $0 burn and no drivers
     * while its roster is over the soft cap. Gating "empty" on the burn alone
     * replaced the over-the-soft-cap card with "No burn for this cost centre and
     * month yet" — hiding the unallocated money BECAUSE it was unallocated, which
     * is the one failure this card cannot have.
     */
    const drill = makeDrill({ burnUsd: 0, vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 }, rows: [] })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="cc-over-soft-cap"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-osc-headline"]').text()).toContain('$510')
  })

  it('is NOT empty when the BUDGET axis carries money the burn axis structurally cannot', () => {
    /*
     * Arm 2 (`api-reconciled`) carries a real project with a NULL
     * `cost_owning_unit_id`, so a cost centre can genuinely have $0 burn and a
     * populated Budgets hero. Gating emptiness on the burn alone would tell such
     * an owner there is nothing here while holding the rows that prove otherwise.
     */
    const drill = makeDrill({
      burnUsd: 0,
      vendor: { claudeUsd: 0, copilotUsd: 0, otherUsd: 0 },
      people: { rows: [], headlineUsd: 0, denominatorLabel: 'cost-centre burn' },
    })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="cc-hero-budgets"]').text()).toContain('Apollo')
  })

  it('DATA renders the burn headline, the vendor donut, BOTH heroes + an export each', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    const headline = w.find('[data-testid="cc-burn-headline"]')
    // The burn headline is the §A usage burn — the SAME figure as the tracker row.
    expect(headline.text()).toContain('$143.83')
    // Framed against the CC's current allocation when set.
    expect(headline.text()).toContain('$500.00')
    expect(w.find('[data-testid="cc-drill-vendor-split"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-hero-budgets"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-hero-people"]').exists()).toBe(true)
    // TWO tables, not one pivoted table.
    expect(w.findAll('[data-testid="drivers-table"]')).toHaveLength(2)
    // The §A drill states the one fact a reader is misled without — the burn is
    // what homed HERE, not a person's total — and no §B showback columns.
    expect(w.find('[data-testid="cc-drill-lane-note"]').text().toLowerCase()).toContain(
      "not a person's total usage",
    )
    expect(w.find('[data-testid="cc-showback-vs-chargeable"]').exists()).toBe(false)
    // One export per hero — each list is its own answer with its own denominator.
    expect(w.findAll('[data-testid="export-csv-button"]')).toHaveLength(2)
  })

  it('BUDGETS leads and PEOPLE follows — the unit of account is the budget (D1)', () => {
    /*
     * With no axis selector there is no default to carry "budgets first"; ORDER
     * is what carries it. A person view arriving first is the exact regression
     * the old `axis = ref('project')` guard existed to prevent, so it is pinned
     * on the rendered DOM rather than on a ref that no longer exists.
     */
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const heroes = w
      .find('[data-testid="cc-drill-heroes"]')
      .findAll(':scope > section')
      .map((h) => h.attributes('data-testid'))
    expect(heroes).toEqual(['cc-hero-budgets', 'cc-hero-people'])
  })

  it('offers NO pivot selector — the owner sees both questions at once', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(w.find('[data-testid="drivers-axis"]').exists()).toBe(false)
  })

  it('the top spender whose placement MOVED still appears in the PEOPLE hero (the bug fix)', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const people = w.find('[data-testid="cc-hero-people"]')
    expect(people.exists()).toBe(true)
    // Phil H is the CC's largest spender; his current placement moved, but §A homes by
    // emit-time cost_owning_unit_id, so he is NOT dropped from the burn drill.
    expect(people.text()).toContain('Phil H')
    // BOTH heroes reconcile to their OWN headline (no DriversTable sum-back is RED).
    const sumbacks = w.findAll('[data-testid="drivers-sumback"]')
    expect(sumbacks).toHaveLength(2)
    expect(sumbacks.map((s) => s.attributes('data-mismatch'))).toEqual(['false', 'false'])
  })

  it('neither hero truncates — every row it is handed is rendered', () => {
    /*
     * At one cost centre the list IS the population: a top-N hides the budget or
     * the person the owner opened the page to find. The uncapped population
     * variant is proven server-side (tests/integration/reports/cost-centre-
     * heroes.test.ts); this pins the RENDERER, which is the other half — a table
     * that silently sliced its rows would defeat an uncapped query.
     */
    const many = Array.from({ length: 63 }, (_, i) => ({
      key: `p${i}`,
      label: `Budget ${i}`,
      usd: 100 - i,
      sharePct: (100 - i) / 4221,
      spendClass: 'indicative' as const,
      budgetUsd: 500,
    }))
    const drill = makeDrill({
      budgets: { rows: many, headlineUsd: 4221, denominatorLabel: "this cost centre's projects" },
    })
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    const budgetTable = w.find('[data-testid="cc-hero-budgets"] [data-testid="drivers-table"]')
    expect(budgetTable.findAll('tbody tr')).toHaveLength(63)
    expect(budgetTable.text()).toContain('Budget 62')
  })

  it('the BUDGETS hero carries consumption against each budget, not a share of the scope', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const budgets = w.find('[data-testid="cc-hero-budgets"]')
    // Apollo: $150 of a $200 budget → 75%, stated with the budget it is against.
    const apollo = budgets.find('[data-testid="drivers-budget-p1"]').text().replace(/\s+/g, ' ')
    expect(apollo).toContain('75%')
    expect(apollo).toContain('$200.00')
    // Borealis has NO allocation — that is a missing decision, never 0% of $0.
    const borealis = budgets.find('[data-testid="drivers-budget-p2"]').text()
    expect(borealis).toContain('no budget set')
    expect(borealis).not.toContain('0%')
    // The PEOPLE hero has no budget concept, so it keeps the share column.
    expect(w.find('[data-testid="cc-hero-people"] [data-testid="drivers-budget-ph"]').exists()).toBe(false)
  })

  it('names the cost-centre allocation as DERIVED from its budgets', () => {
    // The budgeted unit of account is the project; a cost-centre figure is the
    // roll-up of its projects' allocations, never a budget set on the centre.
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const headline = w.find('[data-testid="cc-burn-headline"]').text().replace(/\s+/g, ' ')
    expect(headline).toContain('derived')
    expect(headline.toLowerCase()).toContain("roll-up of this business unit's budgets")
  })

  it("the BUDGETS hero names its DIFFERENT denominator on its face", () => {
    // The project axis is clamped on the project's own cost-owning unit, not on
    // the usage row's — arm 2 of the §A lane carries a real project with a NULL
    // cost-owning unit. So its rows foot to Σ projects, NOT to the burn. Showing
    // that without saying so would look like a table that does not add up.
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const note = w.find('[data-testid="cc-drill-project-axis-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('$190.00') // the budget denominator
    expect(note.text()).toContain('$143.83') // the burn it deliberately differs from
  })

  it('states the HOMING rule the way the lane actually works', () => {
    /*
     * `cost_owning_unit_id` on the §A lane is the TAGGED PROJECT's cost centre on
     * the emitted arm (tag-session.ts sets `cou = p.cost_owning_unit_id`, and NULL
     * when there is no project), and the SPENDER's own centre — a placement
     * snapshot taken at ingest — on the untaggable provider arm. It is NOT "where
     * usage was emitted", and that sentence is the single fact the whole clamp
     * argument rests on: stated backwards, an operator reading the drill concludes
     * the burn follows the emitter and that a cross-centre tag cannot land here.
     */
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false },
    })
    /*
     * The MECHANISM moved to the code comments — it explained how the two
     * denominators are built, which is engine/budget-axis.ts's business. What the
     * screen keeps is the consequence: the two figures are not meant to match, and
     * the burn is not a person's total. Both name their own numbers.
     */
    const note = w.find('[data-testid="cc-drill-project-axis-note"]').text().replace(/\s+/g, ' ')
    expect(note).not.toContain('homed by where usage was emitted')
    expect(note).toContain('not meant to match it')
    expect(note).not.toContain('A budget is homed by the cost centre that owns it')
    const lane = w.find('[data-testid="cc-drill-lane-note"]').text().replace(/\s+/g, ' ')
    expect(lane).toContain(`homed to this ${BU_LABEL_LOWER}`)
    expect(lane).toContain("not a person's total usage")
    expect(lane).not.toContain('Money lands here two ways')
    expect(lane).not.toContain('Finance tab')
  })

  it('each hero states ITS OWN clamp — neither borrows the other’s sentence', () => {
    /*
     * Arm 3 carries a real cost-owning unit and NO project by construction, so
     * the PEOPLE hero contains money that belongs to no budget — "each person's
     * spend on this cost centre's budgets" would deny the existence of money its
     * own rows are made of. And the BUDGETS hero is clamped on the project's
     * cost centre, so "homed to this cost centre" is equally false there.
     */
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false },
    })
    const peopleNote = w.find('[data-testid="cc-hero-people-note"]').text().replace(/\s+/g, ' ')
    expect(peopleNote).toContain(`homed to this ${BU_LABEL_LOWER}`)
    expect(peopleNote).toContain('not their total usage')
    expect(peopleNote).not.toContain(`spend on this ${BU_LABEL_LOWER}'s budgets`)
    // The arm-3 mechanism ("including provider usage with no session to tag…")
    // explained WHY the clamp is what it is; the clamp itself is the claim.
    expect(peopleNote).not.toContain('no session to tag')

    const budgetsNote = w.find('[data-testid="cc-hero-budgets-note"]').text().replace(/\s+/g, ' ')
    expect(budgetsNote).toContain(`for the budgets this ${BU_LABEL_LOWER} owns`)
    expect(budgetsNote).not.toContain(`homed to this ${BU_LABEL_LOWER}`)
  })
})

describe('ScopeCostCentreView — the §A/§B lane re-lens (grid)', () => {
  it('USAGE lane (default): the summary primary tile is Total burn; rows show burn', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const primary = w.find('[data-testid="cc-summary-primary"]')
    expect(primary.text()).toContain('Total burn')
    expect(primary.text()).toContain('$255') // Σ burn (120+85+40+10)
    // The budget row shows the §A burn figure as the primary.
    expect(w.find('[data-testid="cc-row-a"]').text()).toContain('$120')
  })

  it('CHARGEBACK lane: primary tile is Total chargeback; rows show §B charge with burn-derived RAG/run-rate/exhaustion suppressed', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false, lane: 'chargeback' } })
    const primary = w.find('[data-testid="cc-summary-primary"]')
    expect(primary.text()).toContain('Total chargeback')
    expect(primary.text()).toContain('$175') // Σ chargeUsd (90+60+25+0)
    // The budget row re-lenses to the §B chargeback figure ($90 for Practice A, not $120 burn).
    const rowA = w.find('[data-testid="cc-row-a"]')
    expect(rowA.text()).toContain('$90')
    expect(rowA.text().toLowerCase()).toContain('chargeback')
    // Allocation context stays framed, but the §A burn-derived RAG chip / run-rate / exhaustion
    // are SUPPRESSED — they describe the burn, not the §B figure (no §B number over §A projections).
    expect(rowA.text()).toContain('allocated')
    expect(rowA.text()).not.toContain('Over budget')
    expect(rowA.text().toLowerCase()).not.toContain('on track for')
    expect(w.find('[data-testid="cc-row-exhaustion-a"]').exists()).toBe(false)
    // The whole-scope RAG rollup is burn-based → hidden behind a scope note (both the summary
    // strip and the budget table carry the "switch to Usage" note).
    expect(w.find('[data-testid="cc-summary-scope-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-budget-scope-note"]').exists()).toBe(true)
    // The burn-based RAG count tiles are not shown in chargeback mode.
    expect(w.text()).not.toContain('Over budget')
  })
})

/*
 * ── THE BLANK COST-CENTRE PAGE ────────────────────────────────────────────────
 *
 * Same defect class as Finance, same cause. The four states were asserted mutually
 * exclusive but never EXHAUSTIVE: `report === null` with `pending === false` and no
 * error matched none of them, so the body rendered nothing. That is the state Nuxt
 * reports on the SERVER pass for `useFetch(..., { lazy: true, server: false })` —
 * the fetch is deliberately skipped during SSR, so nothing is in flight and no data
 * has arrived. The header lives in this view, so the page painted its title, lane
 * toggle and date control over an empty page, then mismatched on hydration.
 *
 * "Exactly one of four" is only a guarantee if the four cover every input.
 */
describe('ScopeCostCentreView — the four states are EXHAUSTIVE (never a blank body)', () => {
  it('GRID: renders the skeleton when there is no report, nothing in flight and no error', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false },
    })
    expect(gridSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('DRILL: renders the skeleton when there is no drill, nothing in flight and no error', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: false },
    })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('GRID: every (report x pending x error) combination renders exactly one state', () => {
    for (const report of [null, makeReport()]) {
      for (const pending of [true, false]) {
        for (const error of [undefined, new Error('boom')]) {
          const w = mount(ScopeCostCentreView, {
            global,
            props: { ...baseProps, report, drill: null, isDrill: false, pending, error },
          })
          const lit = Object.entries(gridSeen(w)).filter(([, on]) => on).map(([k]) => k)
          expect(lit, `report=${report ? 'set' : 'null'} pending=${pending} error=${Boolean(error)}`).toHaveLength(1)
        }
      }
    }
  })

  it('DRILL: every (drill x drillPending x drillError) combination renders exactly one state', () => {
    for (const drill of [null, makeDrill()]) {
      for (const drillPending of [true, false]) {
        for (const drillError of [undefined, new Error('403')]) {
          const w = mount(ScopeCostCentreView, {
            global,
            props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false, drillPending, drillError },
          })
          const lit = Object.entries(drillSeen(w)).filter(([, on]) => on).map(([k]) => k)
          expect(lit, `drill=${drill ? 'set' : 'null'} pending=${drillPending} error=${Boolean(drillError)}`).toHaveLength(1)
        }
      }
    }
  })
})

/*
 * The prototype's `who` note: spend with no teammate reaches no cost centre, so the
 * cost-centre totals CANNOT sum to the whole-company total. The note is explicit
 * that this gap "needs saying here rather than being discovered on the Finance tab".
 */
describe('ScopeCostCentreView — the unattributed gap is stated, not hidden', () => {
  it('says the totals do not sum to the whole-company figure, and why', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false },
    })
    const note = w.find('[data-testid="cc-unattributed-gap-note"]')
    expect(note.exists()).toBe(true)
    const t = note.text().toLowerCase()
    expect(t).toContain('no teammate')
    expect(t).toContain('do not sum')
  })

  it('states it in chargeback mode too — the gap is not lane-specific', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false, lane: 'chargeback' },
    })
    expect(w.find('[data-testid="cc-unattributed-gap-note"]').exists()).toBe(true)
  })
})
