// @vitest-environment happy-dom
/*
 * CcProjectTable — the restored P&L-owner project table, and its placement as the
 * Cost-Centre scope's PRIMARY table.
 *
 * The defect this closes is not cosmetic: a cost-centre owner opened their scope
 * and was shown a list of PEOPLE, when the question they hold is "which project is
 * burning my budget, and should we extend it". `/me/cost-centres` could always
 * answer it — burn vs allocation, run-rate, exhaustion date and the PM, per
 * project — but its page was deleted at the reporting cutover, so the browser had
 * no way to ask.
 *
 * Every assertion below is on a figure or a word that changes a decision: the
 * per-project budget position, the RAG state, the PM's name, the run-out date, and
 * the reconciliation that explains why Σ projects is NOT the cost centre's burn.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CcProjectTable from '../../../app/components/reporting/cost-centre/CcProjectTable.vue'
import ScopeCostCentreView from '../../../app/components/reporting/ScopeCostCentreView.vue'
import type { CostCentreCard, CostCentreProject } from '../../../shared/schemas/cost-centres'
import type { CostCentreReport } from '../../../app/components/reporting/cost-centre/cost-centre-view-types'
// Asserted through the CONSTANT: these tests are about the CLAIM, and pinning
// the noun made a vocabulary change read as a behaviour regression.
import { BU_LABEL_LOWER_PLURAL } from '#shared/reports/vocabulary'

// NuxtLink is a Nuxt global; render it as an anchor so the drill-through target
// (the project page, where the by-teammate contribution lives) is assertable.
//
// The `to` is now a ROUTE OBJECT, not a string: the drill contract carries the
// entry scope + window as query (developer pages D30), and a stub that rendered
// `:href="to"` would print `[object Object]` and quietly pass any assertion
// about the path. Serialising it here keeps BOTH the path and the carried state
// assertable, which is the whole point of the round-trip.
const linkHref = (to: unknown): string => {
  if (typeof to === 'string') return to
  const r = to as { path?: string; query?: Record<string, string> }
  const q = r.query ? new URLSearchParams(r.query).toString() : ''
  return `${r.path ?? ''}${q ? `?${q}` : ''}`
}
const global = {
  stubs: {
    NuxtLink: {
      props: ['to'],
      computed: { href(): string { return linkHref((this as { to: unknown }).to) } },
      template: '<a :href="href"><slot /></a>',
    },
    DateRangeControl: true,
    LaneToggle: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

function project(over: Partial<CostCentreProject> = {}): CostCentreProject {
  return {
    id: 'p1',
    code: 'PROJ-A',
    display_name: 'Apollo',
    type: 'billable',
    wbs_code: null,
    end_date: null,
    ended: false,
    member_count: 4,
    cross_cou_member_count: 1,
    managers: ['Dana Reyes'],
    mtd_cost_usd: '120.00',
    allocation_usd: '100.00',
    utilisation: 1.2,
    projected_exhaustion_date: '2026-07-13',
    velocity: {
      current_week_usd: '44.00',
      trailing_mean_usd: '20.00',
      delta_pct: 1.2,
      is_flagged: true,
    },
    ...over,
  }
}

function card(over: Partial<CostCentreCard> = {}): CostCentreCard {
  return {
    id: 'cc1',
    code: 'ENG',
    display_name: 'Engineering',
    region_code: 'apac',
    project_count: 2,
    member_count: 6,
    cross_cou_member_count: 1,
    mtd_cost_usd: '150.00',
    allocation_usd: '400.00',
    utilisation: 0.375,
    reconciliation: {
      burn_usd: '175.00',
      ingest_only_usd: '40.00',
      untagged_usd: '0.00',
      foreign_project_usd: '10.00',
      off_centre_usd: '25.00',
      member_untagged_usd: '9.00',
    },
    projects: [
      project(),
      project({
        id: 'p2',
        code: 'PROJ-B',
        display_name: 'Borealis',
        managers: [],
        member_count: 2,
        cross_cou_member_count: 0,
        mtd_cost_usd: '30.00',
        allocation_usd: '0.00',
        utilisation: null,
        projected_exhaustion_date: null,
        velocity: { current_week_usd: '0.00', trailing_mean_usd: '0.00', delta_pct: null, is_flagged: false },
      }),
    ],
    omitted_projects: { count: 0, cost_usd: '0.00', dormant_count: 0 },
    ...over,
  }
}

const mountTable = (cards: CostCentreCard[] = [card()]) =>
  mount(CcProjectTable, { global, props: { cards, windowLabel: 'July 2026' } })

describe('CcProjectTable — one row per PROJECT, with its budget position', () => {
  it('renders each project with burn, allocation, utilisation RAG, run-rate, exhaustion date and PM', () => {
    const w = mountTable()
    const apollo = w.find('[data-testid="cc-project-PROJ-A"]')
    expect(apollo.exists()).toBe(true)
    expect(apollo.text()).toContain('Apollo')
    expect(apollo.text()).toContain('$120') // burn
    expect(apollo.text()).toContain('$100') // allocation
    expect(apollo.text()).toContain('Over budget') // RAG, from utilisation 1.2
    expect(apollo.attributes('data-state')).toBe('over')
    expect(apollo.text()).toContain('$44') // run-rate (this week)
    expect(w.find('[data-testid="cc-project-pm-PROJ-A"]').text()).toContain('Dana Reyes')
    expect(w.find('[data-testid="cc-project-exhaustion-PROJ-A"]').text()).toContain('2026-07-13')
  })

  it('a project with NO allocation reads "No budget set", never a fake on-track claim', () => {
    const w = mountTable()
    const borealis = w.find('[data-testid="cc-project-PROJ-B"]')
    expect(borealis.attributes('data-state')).toBe('none')
    expect(borealis.text()).toContain('No budget set')
    expect(borealis.text()).not.toContain('On track')
    // …and an unmanaged project says so rather than showing an empty PM slot.
    expect(w.find('[data-testid="cc-project-pm-PROJ-B"]').exists()).toBe(false)
    expect(borealis.text()).toContain('no project manager assigned')
  })

  /*
   * THE DRILL CONTRACT (developer pages D29/D30, fix 7). This row used to link
   * unconditionally and carry NO scope or window, so the target opened on its
   * own defaults and "back" could not restore the report. Both arms are pinned:
   * with the grant it is a real link carrying the entry frame; without it, plain
   * text — never a live-looking row that 403s on click.
   */
  it('a project row drills to the PROJECT page, carrying the entry scope + window', () => {
    const w = mount(CcProjectTable, {
      global,
      props: {
        cards: [card()],
        windowLabel: 'July 2026',
        drillGrants: { teammate: 'people-scope', project: 'member-in-scope' },
        drillWindow: { month: '2026-07' },
      },
    })
    const href = w.find('[data-testid="cc-project-PROJ-A"]').attributes('href')
    expect(href).toContain('/projects/PROJ-A')
    expect(href).toContain('src=cc%3Acc1')
    expect(href).toContain('month=2026-07')
  })

  it('WITHOUT the project grant the same row is plain text — no href, no link role', () => {
    const w = mountTable()
    const row = w.find('[data-testid="cc-project-PROJ-A"]')
    expect(row.exists()).toBe(true)
    expect(row.attributes('href')).toBeUndefined()
    expect(row.element.tagName).toBe('DIV')
  })

  it('ranks by burn, not by the server’s project code order', () => {
    const w = mountTable()
    const codes = w.findAll('[data-testid^="cc-project-PROJ-"]').map((el) => el.attributes('data-testid'))
    expect(codes).toEqual(['cc-project-PROJ-A', 'cc-project-PROJ-B']) // 120 before 30
    const reversed = mountTable([
      card({ projects: [card().projects[1]!, card().projects[0]!] }),
    ])
    const stillByBurn = reversed
      .findAll('[data-testid^="cc-project-PROJ-"]')
      .map((el) => el.attributes('data-testid'))
    expect(stillByBurn).toEqual(['cc-project-PROJ-A', 'cc-project-PROJ-B'])
  })

  it('the header KPI is the cost-centre ROLL-UP, named for the window it covers', () => {
    const w = mountTable()
    expect(w.find('[data-testid="cc-projects-rollup-ENG"]').text()).toContain('$150')
    const section = w.find('[data-testid="cc-projects-ENG"]')
    expect(section.text()).toContain('$400') // the derived allocation roll-up
    expect(section.text()).toContain('July 2026') // never an unlabelled "now"
    expect(section.text()).toContain('2 projects')
    expect(section.text()).toContain(`1 from other ${BU_LABEL_LOWER_PLURAL}`)
  })

  it('reconciles Σ projects to the cost centre’s own burn, naming EVERY term between them', () => {
    const rec = mountTable().find('[data-testid="cc-projects-reconciliation-ENG"]')
    /*
     * The WHOLE equation, operators included. Asserting only that the amounts
     * appear lets a sign flip through: 150 + 40 + 10 + 25 = 225 renders every one
     * of those figures and reconciles to nothing, and the assertion stays green.
     * The signs ARE the reconciliation — off-centre money is on the project side
     * and not on the burn side, so it subtracts.
     */
    const equation = rec.text().replace(/\s+/g, ' ').trim()
    expect(equation).toContain(
      "Projects $150.00 + $40.00 provider usage with no session to tag + $10.00 on another business unit's projects " +
        "− $25.00 on this business unit's projects, homed elsewhere = $175.00 business unit burn.",
    )
    // And it actually holds: 150 + 40 + 10 − 25 = 175.
    expect(150 + 40 + 10 - 25).toBe(175)
    // A zero term is elided — an owner should read the terms that MOVE the number.
    expect(rec.text()).not.toContain('homed here, no project claim')
    // The teammate-axis term sits OUTSIDE the identity and says so.
    expect(rec.text()).toContain('$9')
    expect(rec.text()).toContain('never added to the burn')
  })

  it('names the off-centre term for what the query actually selects', () => {
    // The SQL takes every row on THIS centre's projects whose usage row is homed
    // anywhere else — reconciled rows (no home at all) AND rows emitted under a
    // different cost centre. "reconciled usage with no emit home" named only the
    // first half and sent an owner hunting reconciliation for cross-centre emits.
    const rec = mountTable().find('[data-testid="cc-projects-reconciliation-ENG"]')
    expect(rec.text()).toContain("on this business unit's projects, homed elsewhere")
    expect(rec.text()).not.toContain('reconciled usage with no emit home')
  })

  it('a centre that leads no projects says so instead of rendering an empty table', () => {
    const w = mountTable([card({ projects: [], project_count: 0 })])
    expect(w.find('[data-testid="cc-projects-empty-ENG"]').exists()).toBe(true)
    expect(w.findAll('[data-testid^="cc-project-PROJ-"]').length).toBe(0)
  })

  it('a project outside the LIVE window carries no run-rate — a rate is not a period figure', () => {
    // velocity is null when the server withheld it (the window no longer reaches
    // now). Rendering a $0.00 "this week" beside June's burn would read as a quiet
    // week rather than a measurement that does not apply.
    const w = mountTable([
      card({ projects: [project({ velocity: null }), project({ id: 'p2', code: 'PROJ-B', velocity: null })] }),
    ])
    const row = w.find('[data-testid="cc-project-PROJ-A"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).not.toContain('this week')
    expect(w.find('[data-testid="cc-project-velocity-PROJ-A"]').exists()).toBe(false)
    // The burn figure itself is untouched — only the live rate is withheld.
    expect(row.text()).toContain('$120')
  })

  it('names the projects it did NOT list, with their Σ, so the roll-up still adds up', () => {
    const w = mountTable([
      card({
        project_count: 9,
        omitted_projects: { count: 7, cost_usd: '12.50', dormant_count: 4 },
      }),
    ])
    const note = w.find('[data-testid="cc-projects-omitted-ENG"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('3 lower-ranked projects totalling $12.50')
    expect(note.text()).toContain('4 ended projects with no spend in this window')
    expect(note.text()).toContain('counted in the total above')
  })

  it('a centre whose every project is held back does NOT claim it has none', () => {
    // "No projects have this cost centre as their lead yet" is a different, false
    // statement about a centre with ten finished projects and no current spend.
    const w = mountTable([
      card({
        projects: [],
        project_count: 3,
        omitted_projects: { count: 3, cost_usd: '0.00', dormant_count: 3 },
      }),
    ])
    expect(w.find('[data-testid="cc-projects-empty-ENG"]').exists()).toBe(false)
    const note = w.find('[data-testid="cc-projects-none-active-ENG"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('3 ended projects with no spend in this window')
  })
})

// ── Placement: the owner's projects LEAD the cost-centre scope ────────────────
const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: [],
  coverage: null,
  scope: 'cost-centre' as const,
}

const report: CostCentreReport = {
  meta,
  laneNote: 'Business Unit burn is usage on the projects each Business Unit leads.',
  cards: [
    {
      id: 'cc1', code: 'ENG', displayName: 'Engineering', regionCode: 'apac',
      burnUsd: 175, chargeUsd: 90, allocationUsd: 400, utilisation: 0.4375,
      exhaustionDate: null, forecast: null, asOfDate: '2026-07-10',
    },
  ],
  summary: {
    totalBurnUsd: 175, totalAllocationUsd: 400, countOverBudget: 0,
    countNearBudget: 0, countOnTrack: 1, countNotStarted: 0, countNoAllocation: 0, asOfDate: '2026-07-10',
  },
}

const scopeProps = {
  report,
  drill: null,
  isDrill: false,
  pending: false,
  drillPending: false,
  driversAxis: 'project',
  exportParams: {},
  exportFilename: 'x.csv',
  drillExportParams: {},
  drillExportFilename: 'y.csv',
  ownedWindowLabel: 'July 2026',
}

describe('ScopeCostCentreView — the owner’s projects are the scope’s primary table', () => {
  it('renders the project table ABOVE the cost-centre burn list', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...scopeProps, owned: [card()] } })
    const html = w.html()
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-project-PROJ-A"]').exists()).toBe(true)
    // Primary means FIRST: people and cost-centre rows come after the projects.
    expect(html.indexOf('cc-owned-projects')).toBeLessThan(html.indexOf('cc-budget-table'))
  })

  it('a viewer who owns nothing simply has no project section — not an error or a gate', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...scopeProps, owned: [] } })
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-grid-data"]').exists()).toBe(true)
    expect(w.find('[data-testid="fetch-error-banner"]').exists()).toBe(false)
  })

  it('is suppressed in CHARGEBACK mode — these are §A budget positions, not the bill', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...scopeProps, owned: [card()], lane: 'chargeback' as const },
    })
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(false)
  })

  it('a FAILED owner fetch is an error, not the same silence as owning nothing', () => {
    // The two were indistinguishable: both rendered no section. A 500, an expired
    // session or a revoked ownership grant then read as the correct answer "you
    // own no cost centres" — the one reading an owner cannot challenge.
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...scopeProps, owned: null, ownedError: new Error('boom') },
    })
    expect(w.find('[data-testid="cc-owned-projects-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(false)
    // …and the surrounding grid still renders (one failed section, not a dead page).
    expect(w.find('[data-testid="cc-grid-data"]').exists()).toBe(true)
  })

  it('an IN-FLIGHT owner fetch shows a placeholder, not an answer', () => {
    const w = mount(ScopeCostCentreView, {
      global,
      props: { ...scopeProps, owned: null, ownedPending: true },
    })
    expect(w.find('[data-testid="cc-owned-projects-pending"]').exists()).toBe(true)
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-owned-projects-error"]').exists()).toBe(false)
  })

  it('owning nothing is still SILENT — an empty list is an answer, not a failure', () => {
    const w = mount(ScopeCostCentreView, { global, props: { ...scopeProps, owned: [] } })
    expect(w.find('[data-testid="cc-owned-projects"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-owned-projects-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-owned-projects-pending"]').exists()).toBe(false)
  })
})
