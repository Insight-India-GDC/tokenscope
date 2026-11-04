// @vitest-environment happy-dom
/*
 * F5 — the cost-centre owner's page, as it RENDERS.
 *
 * The outcome under test: an owner lands on THEIR centre and sees, without
 * clicking anything, what they are accountable for, what the money went to, and
 * who spent it. Most of this was built and then put behind a door with no
 * handle — `CcDrill` mounted only inside a `v-else-if` reachable by clicking a
 * name in a budget table — so these assertions are as much about REACHABILITY
 * as about content.
 *
 * T23 the page lands scoped, names the centre, and the selector is absent when
 *     there is one option.
 * T24 both tables, no pivot chips, no truncation — a 14-person centre lists 14.
 * T25 the project row carries both operands.
 * T30 the Projects table: share, this month, against-budget including over-100%
 *     and "no budget", the "Not on a project" row, and a tier breakdown whose
 *     unmatched models land in `unclassified`.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeCostCentreView from '../../../app/components/reporting/ScopeCostCentreView.vue'
import type {
  CostCentreReport,
  CostCentreDrill,
} from '../../../app/components/reporting/cost-centre/cost-centre-view-types'
import type { CostCentreScope, DriverRow, OverSoftCap } from '#shared/reports/types'

const global = {
  stubs: {
    DateRangeControl: true,
    LaneToggle: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: [],
  coverage: { applicable: true, denominator: 3, connected: 3, nonConnected: 0, stale: false },
  scope: 'cost-centre' as const,
}

const ONE_OPTION: CostCentreScope = {
  options: [{ id: 'cc-1', displayName: 'AI Apps & Data', regionCode: 'apac', owned: true }],
  defaultCcId: 'cc-1',
  scopeLabel: 'AI Apps & Data',
}
const THREE_OPTIONS: CostCentreScope = {
  options: [
    { id: 'cc-0', displayName: 'APAC · CTO', regionCode: 'apac', owned: false },
    { id: 'cc-1', displayName: 'AI Apps & Data', regionCode: 'apac', owned: true },
    { id: 'cc-2', displayName: 'EMEA · CTO', regionCode: 'emea', owned: false },
  ],
  defaultCcId: 'cc-1',
  scopeLabel: 'AI Apps & Data',
}

function makeReport(scope: CostCentreScope | undefined = ONE_OPTION): CostCentreReport {
  return {
    meta,
    laneNote: '',
    scope,
    cards: [
      { id: 'cc-1', code: 'c1', displayName: 'AI Apps & Data', regionCode: 'apac', burnUsd: 120, chargeUsd: 90, allocationUsd: 100, utilisation: 1.2, exhaustionDate: null, forecast: null, asOfDate: null },
      { id: 'cc-2', code: 'c2', displayName: 'EMEA · CTO', regionCode: 'emea', burnUsd: 0, chargeUsd: 0, allocationUsd: 500, utilisation: 0, exhaustionDate: null, forecast: null, asOfDate: null },
    ],
    summary: {
      totalBurnUsd: 120,
      totalAllocationUsd: 600,
      countOverBudget: 1,
      countNearBudget: 0,
      countOnTrack: 0,
      countNotStarted: 1,
      countNoAllocation: 0,
      asOfDate: null,
    },
  }
}

const emptyOverSoftCap: OverSoftCap = {
  softCapUsd: 100,
  rosterCount: 14,
  rosterUsd: 1000,
  allocatedUsd: 1000,
  unallocatedUsd: 0,
  over: [],
  withinAllowance: { teammates: 14, unallocatedUsd: 0, fullyAllocated: 14 },
}

/*
 * FOURTEEN people — the prototype's own number (`R:628-630`: *"At 14 people and
 * 9 projects the list IS the population — truncating it would hide the person
 * the owner came to find"*). Chosen so a top-10 cap is visibly wrong: the
 * fourteenth is the one a truncated list drops.
 */
const PEOPLE_ROWS: DriverRow[] = Array.from({ length: 14 }, (_, i) => ({
  key: `t${i}`,
  label: `Person ${i}`,
  usd: 140 - i * 10,
  sharePct: (140 - i * 10) / 1050,
  spendClass: 'indicative' as const,
  // The model-tier mix — the catalogue's bands, INCLUDING `unclassified` as a
  // band in its own right on the heaviest spender.
  ...(i === 0
    ? {
        tierBreakdown: [
          { band: 'frontier' as const, label: 'Frontier', usd: 100 },
          { band: 'unclassified' as const, label: 'Unclassified', usd: 40 },
        ],
      }
    : {}),
}))

/*
 * The Projects hero: a project over its budget, one with NO budget set, one
 * within, and the "Not on a project" row that carries no budget concept at all.
 * Each real project row carries BOTH operands (D25).
 */
const PROJECT_ROWS: DriverRow[] = [
  {
    key: 'p1', label: 'Atlas', usd: 570, sharePct: 0.57, spendClass: 'indicative',
    budgetUsd: 500, scopeShareUsd: 400, scopeShareLabel: 'this cost centre',
    dims: { project_code: 'ATLAS' },
  },
  {
    key: 'p2', label: 'Data Platform Migration', usd: 200, sharePct: 0.2,
    spendClass: 'indicative', budgetUsd: null, scopeShareUsd: 200,
    scopeShareLabel: 'this cost centre',
  },
  {
    key: 'p3', label: 'Customer Zero', usd: 100, sharePct: 0.1, spendClass: 'indicative',
    budgetUsd: 400, scopeShareUsd: 25, scopeShareLabel: 'this cost centre',
  },
  // No `budgetUsd` AND no `scopeShareUsd`: nothing a budget could be set on, and
  // its total already IS this centre's share by construction.
  { key: '__no_project', label: 'Not on a project', usd: 130, sharePct: 0.13, spendClass: 'indicative' },
]

function makeDrill(over: Partial<CostCentreDrill> = {}): CostCentreDrill {
  return {
    meta,
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
    cc: { id: 'cc-1', code: 'c1', displayName: 'AI Apps & Data', regionCode: 'apac' },
    overSoftCap: emptyOverSoftCap,
    burnUsd: 1050,
    vendor: { claudeUsd: 1050, copilotUsd: 0, otherUsd: 0 },
    allocationUsd: 900,
    axis: 'project',
    headlineUsd: 1000,
    denominatorLabel: "this cost centre's projects, and burn on none",
    rows: PROJECT_ROWS,
    budgets: {
      rows: PROJECT_ROWS,
      headlineUsd: 1000,
      denominatorLabel: "this cost centre's projects, and burn on none",
    },
    people: { rows: PEOPLE_ROWS, headlineUsd: 1050, denominatorLabel: 'cost-centre burn' },
    ...over,
  }
}

const baseProps = {
  exportParams: {},
  exportFilename: 'x.csv',
  budgetsExportParams: {},
  budgetsExportFilename: 'b.csv',
  peopleExportParams: {},
  peopleExportFilename: 'p.csv',
  drillPending: false,
}

const scoped = (scope?: CostCentreScope, extra: Record<string, unknown> = {}) =>
  mount(ScopeCostCentreView, {
    global,
    props: {
      ...baseProps,
      report: makeReport(scope),
      drill: makeDrill(),
      isDrill: true,
      pending: false,
      ...extra,
    },
  })

/*
 * ── T23 · THE PAGE LANDS SCOPED AND SAYS SO ─────────────────────────────────
 * `R:551-559`, note `scope` — *"the reader arrives already scoped … because
 * 'which cost centre am I looking at' must never be a question this page leaves
 * open."*
 */
describe('T23 — the page lands scoped, names the centre, and only selects where there is a choice', () => {
  it('names the centre it is showing', () => {
    const w = scoped()
    const line = w.find('[data-testid="cc-scope-line"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('AI Apps & Data')
  })

  it('ONE option is a LABEL, not a selector', () => {
    const w = scoped(ONE_OPTION)
    expect(w.find('[data-testid="cc-scope-selector"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-scope-label"]').text()).toBe('AI Apps & Data')
  })

  it('a real choice gets a real control, listing every centre the reader holds', () => {
    const w = scoped(THREE_OPTIONS)
    const sel = w.find('[data-testid="cc-scope-selector"]')
    expect(sel.exists()).toBe(true)
    expect(sel.findAll('option').map((o) => o.text().trim())).toEqual([
      'APAC · CTO', 'AI Apps & Data (yours)', 'EMEA · CTO',
    ])
    // It is on the centre the reader is ON, not on the server's default.
    expect((sel.element as HTMLSelectElement).value).toBe('cc-1')
  })

  it('picking a centre asks the CONTAINER to rescope — the view never writes the URL', () => {
    const w = scoped(THREE_OPTIONS)
    const sel = w.find('[data-testid="cc-scope-selector"]')
    ;(sel.element as HTMLSelectElement).value = 'cc-2'
    sel.trigger('change')
    expect(w.emitted('drill')?.at(-1)).toEqual(['cc-2'])
  })

  it('renders in the UNSCOPED state too, so the architecture switch is never silent', () => {
    /*
     * A scope line that appeared only once a centre was chosen would leave the
     * pre-scope state looking exactly like the unlabelled page this fix is
     * about — and a reader would have no way to tell "not scoped yet" from
     * "this build has no scoping".
     */
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...baseProps, report: makeReport(THREE_OPTIONS), drill: null, isDrill: false, pending: false },
    })
    const line = w.find('[data-testid="cc-scope-line"]')
    expect(line.exists()).toBe(true)
    // With no `?cc=` yet it names where the reader is ABOUT to land.
    expect(line.text()).toContain('AI Apps & Data')
  })

  it('the lane toggle is PRESENT while scoped — the owner needs both lanes', () => {
    /*
     * REVERSES D24 (owner, 2026-08-06). The toggle was removed on the claim that
     * "CcDrill is §A-only by construction, so Chargeback changed nothing". Both
     * halves were false:
     *
     *   - The drawing has it. `controls(d)` renders BOTH lanes and is called
     *     UNCONDITIONALLY (`R:561`), before any scope branch; Region ships it.
     *     D24 cited the `scope` note "a cost-centre owner does not pivot"
     *     (`R:772`) — which governs the PIVOT control, not the LANE control.
     *   - Switching DOES change something: every card carries `chargeUsd`, the
     *     §B figure for that centre. Removing the control orphaned the figure.
     *
     * A cost-centre owner is accountable for a budget: "am I on track" is the
     * CHARGE, "what is driving it" is the USAGE. Both are theirs.
     */
    const w = scoped()
    expect(w.findComponent({ name: 'LaneToggle' }).exists()).toBe(true)
    expect(w.find('[data-testid="cc-usage-lane-pill"]').exists()).toBe(false)
  })

  it('in the chargeback lens the §A tables SAY they are still §A', () => {
    /*
     * The headline switches to `chargeUsd`; the two hero tables compute usage
     * burn and have no §B equivalent. Unlabelled, a reader would foot §A drivers
     * against a §B headline — the mixing `Reporting.md` §1 forbids. Building §B
     * drivers is a real slice; saying so is not.
     */
    const w = scoped(undefined, { lane: 'chargeback' })
    expect(w.find('[data-testid="cc-drill-lane-mismatch"]').exists()).toBe(true)
  })
})

/*
 * ── T24 · TWO LISTS, NO PIVOT, NO TRUNCATION ────────────────────────────────
 * `R:623-630` — *"A cost-centre owner does not pivot. They own exactly two axes
 * and want both on screen at once… Neither list is a 'top N'."*
 */
describe('T24 — two lists side by side, no pivot chips, no truncation', () => {
  it('renders BOTH tables', () => {
    const w = scoped()
    expect(w.find('[data-testid="cc-hero-budgets"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-hero-people"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="drivers-table"]')).toHaveLength(2)
  })

  it('offers NO pivot chips — the prototype draws them only at company and region scope', () => {
    const w = scoped()
    expect(w.find('[data-testid="drivers-axis"]').exists()).toBe(false)
  })

  it('a 14-person centre lists 14 people — including the fourteenth, whom a top-10 drops', () => {
    const w = scoped()
    const people = w.find('[data-testid="cc-hero-people"] [data-testid="drivers-table"]')
    expect(people.findAll('tbody tr')).toHaveLength(14)
    expect(people.text()).toContain('Person 13')
  })

  it('the ranking is drawn ONCE per hero — in the table, by the column that names it', () => {
    /*
     * The regression the source guard in tests/unit/server/cc-owner-page.test.ts
     * pins is the `ChartRankedBar :top-n="10"` that sat above each table: it
     * showed ten of fourteen with nothing saying so, AND duplicated a ranking
     * the table's own bar already draws. Here is the surviving half — one
     * share-of-spend column per hero, named, over every row.
     */
    const w = scoped()
    expect(w.findAll('[data-testid="drivers-col-bar"]')).toHaveLength(2)
    const people = w.find('[data-testid="cc-hero-people"]')
    expect(people.findAll('[data-testid^="drivers-bar-"]')).toHaveLength(14)
  })
})

/*
 * ── T25 · BOTH OPERANDS ─────────────────────────────────────────────────────
 * The project axis is clamped on the PROJECT's cost-owning unit, so a row's own
 * total is the project's total across every centre that worked on it — the
 * right operand against its budget, and the wrong one for "what did MY centre
 * spend". Both are defensible and answer different questions, so the row shows
 * both rather than the axis picking one (03-snag-plan §8c).
 */
describe('T25 — the project row carries both operands', () => {
  it("shows the project's own total AND this cost centre's share of it", () => {
    const w = scoped()
    const row = w.find('[data-testid="cc-hero-budgets"]').findAll('tbody tr')[0]!
    const text = row.text().replace(/\s+/g, ' ')
    expect(text).toContain('$570.00') // the project's own total
    const share = w.find('[data-testid="drivers-scope-share-p1"]')
    expect(share.exists()).toBe(true)
    expect(share.text()).toContain('$400.00') // this centre's part of it
    expect(share.text()).toContain('this cost centre')
  })

  it('a project this centre barely touched says so, instead of claiming the whole total', () => {
    const w = scoped()
    expect(w.find('[data-testid="drivers-scope-share-p3"]').text()).toContain('$25.00')
  })

  it('the "Not on a project" row shows ONE figure — the two are the same by construction', () => {
    const w = scoped()
    expect(w.find('[data-testid="drivers-scope-share-__no_project"]').exists()).toBe(false)
  })
})

/*
 * ── T30 · THE PROJECTS TABLE ────────────────────────────────────────────────
 * `R:903-907` — hero('Projects', 'Every project carrying spend, against its
 * budget', …, ['project','share of spend','this month','against budget']), with
 * `['Not on a project', …, 'no project']` as its last row.
 */
describe('T30 — the Projects table: share, this month, against budget, and the money on none', () => {
  it('names all four columns, so two bars on one row are not read as two series', () => {
    const w = scoped()
    const head = w.find('[data-testid="cc-hero-budgets"] thead').text().replace(/\s+/g, ' ')
    expect(head).toContain('Share of spend')
    expect(head).toContain('Against budget')
    // The VALUE column names the window it covers rather than a bare "Spend".
    expect(head).toContain('2026-07')
  })

  it('renders a share-of-spend bar per row', () => {
    const w = scoped()
    const budgets = w.find('[data-testid="cc-hero-budgets"]')
    expect(budgets.find('[data-testid="drivers-bar-p1"]').exists()).toBe(true)
    expect(budgets.find('[data-testid="drivers-bar-__no_project"]').exists()).toBe(true)
  })

  it('AGAINST BUDGET carries every state, including OVER 100% and "no budget"', () => {
    const w = scoped()
    const budgets = w.find('[data-testid="cc-hero-budgets"]')
    // Over 100% — a fact, and it renders as one rather than clamping to 100%.
    const over = budgets.find('[data-testid="drivers-budget-p1"]')
    expect(over.text().replace(/\s+/g, ' ')).toContain('114% of $500.00')
    expect(over.find('[data-testid="budget-state-consumed"]').classes()).toContain('text-rag-red')
    // No budget SET — a missing decision, never 0% and never $0.
    const none = budgets.find('[data-testid="drivers-budget-p2"]')
    expect(none.text()).toContain('no budget set')
    expect(none.text()).not.toContain('0%')
    // Within budget stays green.
    expect(
      budgets.find('[data-testid="drivers-budget-p3"]').find('[data-testid="budget-state-consumed"]').classes(),
    ).toContain('text-rag-green')
  })

  it('the "Not on a project" row is present, and is NOT a missing budget decision', () => {
    /*
     * Money homed to this centre with no project claim on it. Without it the
     * hero silently omits the one bucket its owner can act on — and it must
     * read "—" (nothing a budget could be set ON), never "no budget set".
     */
    const w = scoped()
    const budgets = w.find('[data-testid="cc-hero-budgets"]')
    expect(budgets.text()).toContain('Not on a project')
    const cell = budgets.find('[data-testid="drivers-budget-__no_project"]')
    expect(cell.text()).toContain('—')
    expect(cell.text()).not.toContain('no budget set')
  })

  it('the rows still reconcile to the hero headline with the extra row in them', () => {
    const w = scoped()
    const sumback = w.find('[data-testid="cc-hero-budgets"] [data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('false')
  })

  it('each sum-back names the base it reconciles to — neither borrows the word "headline"', () => {
    /*
     * Found by reading the rendered page, not by a gate: the Budgets footer read
     * "reconciles to headline $1,726.20 / $1,726.20" beside a page headline of
     * $302.82, because those rows carry each project's OWN total across every
     * cost centre (cost-centres.ts D25) rather than this centre's burn. Two
     * columns over, the People footer said "reconciles to headline $302.82" —
     * the same sentence pointing at a different figure on one screen.
     *
     * The People half is wrong in the OTHER lane instead: under chargeback the
     * headline is the charge, and the caveat above the tables already says they
     * "do not add up to it, and are not meant to". So neither table may name a
     * POSITION on the page; each names its own base, and stays true in both
     * lenses. The arithmetic was never in question — only the noun.
     */
    const w = scoped()
    const budgets = w.find('[data-testid="cc-hero-budgets"] [data-testid="drivers-sumback"]')
    expect(budgets.text()).toContain("these projects' own totals")
    expect(budgets.text()).not.toContain('headline')

    const people = w.find('[data-testid="cc-hero-people"] [data-testid="drivers-sumback"]')
    expect(people.text()).toContain('cost-centre burn')
    expect(people.text()).not.toContain('headline')
  })

  it('the PEOPLE table carries the model-tier mix, with `unclassified` as its own band', () => {
    /*
     * The column used to be blank, and the code claimed it needed a
     * `model_catalog.tier` primitive that "does not exist". It always existed;
     * the drill's server measure did not. `unclassified` renders as a band of
     * its own — folding it into the cheapest would understate frontier exposure
     * by exactly the spend nobody has classified yet.
     */
    const w = scoped()
    const people = w.find('[data-testid="cc-hero-people"]')
    expect(people.find('[data-testid="drivers-tier-mix-t0"]').exists()).toBe(true)
    const legend = people.find('[data-testid="drivers-tier-legend"]')
    expect(legend.exists()).toBe(true)
    expect(legend.text()).toContain('Frontier')
    expect(legend.text()).toContain('Unclassified')
    expect(people.find('[data-testid="drivers-tier-legend-unclassified"]').exists()).toBe(true)
    // The mix is on PEOPLE, never invented for the Projects axis.
    expect(w.find('[data-testid="cc-hero-budgets"] [data-testid="drivers-tier-legend"]').exists())
      .toBe(false)
  })
})
