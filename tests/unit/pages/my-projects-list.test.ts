// @vitest-environment happy-dom
/*
 * /projects (app/pages/projects/index.vue) — T20 (developer-pages W3 D25/D26),
 * the client half:
 *
 *   - the headline band's Σ IS the sum of the cards' `mine` values (the
 *     identity holds by construction — revert the band to any other operand
 *     and this goes red);
 *   - the "$X untagged → worklist" pull-through navigates to /usage;
 *   - the list has NO window control (MTD stays the recorded owner decision);
 *   - ONE pace vocabulary (fix 4): the card pill is budgetPace's word and the
 *     money line carries "on pace for ~$X by {monthEnd}";
 *   - cards order by PACE SEVERITY (the over-budget fact first);
 *   - velocity keeps its real 4-week note, with day-1 honesty when no
 *     baseline exists ("unknown, not quiet").
 *
 * Same mounting idiom as consumption-one-scalar.test.ts: stub the Nuxt
 * auto-import globals + UI kit, wrap in <Suspense>. The clock is pinned
 * (Date only — real timers stay, so flushPromises cannot hang) because the
 * pace vocabulary derives from day-of-month.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectsPage from '../../../app/pages/projects/index.vue'
import type { ProjectCard } from '../../../shared/schemas/usage'

const card = (over: Partial<ProjectCard> = {}): ProjectCard => ({
  id: 'p1',
  code: 'ACME-1',
  display_name: 'Acme Platform',
  type: 'billable',
  wbs_code: null,
  end_date: null,
  ended: false,
  member_count: 3,
  mtd_cost_usd: '60.00',
  allocation_usd: '200.00',
  utilisation: 0.3,
  projected_exhaustion_date: null,
  velocity: { current_week_usd: '20.00', trailing_mean_usd: '15.00', delta_pct: 0.33, is_flagged: true },
  mine_mtd_usd: '20.00',
  spark: [{ day: '2026-08-01', cost_usd: '4.00' }],
  ...over,
})

const STUBS = {
  UiPageHead: true,
  UiCard: { template: '<div><slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiEmptyState: true,
  ChartsUtilBar: true,
  NuxtLink: {
    props: ['to'],
    template: '<a :href="typeof to === \'string\' ? to : \'#\'"><slot /></a>',
  },
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`

async function mountPage(projects: ProjectCard[], untaggedUsd = '0.00', query: Record<string, string> = {}) {
  // Script-scope refs resolve via globalThis; template refs via the instance
  // proxy (mocks). Provide both (the consumption-one-scalar idiom).
  vi.stubGlobal('fmtUsd', fmtUsd)
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: 't1' }), ensure: async () => {} }))
  vi.stubGlobal('useRoute', () => ({ query }))
  vi.stubGlobal('useFetch', () => ({
    data: ref({ projects, total: projects.length, untagged_usd: untaggedUsd }),
    pending: ref(false),
    error: ref(null),
  }))
  const Parent = defineComponent({
    components: { ProjectsPage },
    template: '<Suspense><ProjectsPage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtUsd } } })
  await flushPromises()
  return w
}

beforeEach(() => {
  /*
   * MIGRATED BY F1 (clock-rot-audit.md §F-a, the most instructive landmine).
   *
   * This used to be `vi.useFakeTimers({ toFake: ['Date'] })`, and it was the one
   * clock-pinning test in the suite — which made it look like the good example.
   * It was not: A FAKE CLOCK DOES NOT MAKE A BROWSER-OWNED CLOCK CORRECT, IT
   * LEGITIMISES IT. `dayOfMonth` is `paceOf`'s DIVISOR, so "on pace for ~$124"
   * was money computed against whichever month the viewer's browser was in; on
   * 1 September at 09:00 Sydney the browser says day 1 while the server's UTC
   * month still has ten hours to run.
   *
   * Now the page reads the SERVER's day and `vi.setSystemTime` controls nothing,
   * so the clock is stubbed where it actually lives. Same fixture: day 15 of 31,
   * past the PACE_MIN_DAYS floor and the 7-day sparkline floor.
   */
  stubServerClock('2026-08-15T12:00:00Z')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/projects — the headline band (T20, D25)', () => {
  it('Σ contribution IS the sum of the cards’ mine values', async () => {
    const w = await mountPage([
      card(),
      card({ id: 'p2', code: 'BETA-2', display_name: 'Beta', mine_mtd_usd: '5.50' }),
    ])
    expect(w.find('[data-testid="projects-band-total"]').text()).toBe('$25.50')
    expect(w.find('[data-testid="projects-band"]').text()).toContain('your contribution · 2 projects')
    expect(w.find('[data-testid="projects-band"]').text()).toContain('day 15 of 31')
    expect(w.find('[data-testid="projects-band"]').text()).toContain('August 2026')
  })

  it('the untagged pull-through navigates to /usage (the worklist mount, D24)', async () => {
    const w = await mountPage([card()], '12.34')
    const link = w.find('[data-testid="projects-untagged-pullthrough"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('$12.34 untagged')
    expect(link.attributes('href')).toBe('/usage')
  })

  it('no untagged spend → no pull-through link (never a $0.00 nudge)', async () => {
    const w = await mountPage([card()], '0.00')
    expect(w.find('[data-testid="projects-untagged-pullthrough"]').exists()).toBe(false)
  })

  it('the list has NO window control — MTD is the recorded owner decision', async () => {
    const w = await mountPage([card()])
    expect(w.find('[data-testid="date-range-control"]').exists()).toBe(false)
    expect(w.find('[data-testid="window-30"]').exists()).toBe(false)
  })
})

describe('/projects — after creating a project for someone else', () => {
  it('names the created project and says why it is not listed', async () => {
    const w = await mountPage([card()], '0.00', { created: 'NEW-9' })
    const note = w.find('[data-testid="projects-created-notice"]').text()
    expect(note).toContain('NEW-9 was created')
    expect(note).toContain('not a member')
  })
  it('no notice on a plain visit', async () => {
    const w = await mountPage([card()])
    expect(w.find('[data-testid="projects-created-notice"]').exists()).toBe(false)
  })
})

describe('/projects — ONE pace vocabulary on the cards (fix 4, D15/D26)', () => {
  it('the pill is budgetPace’s word and the money line carries the on-pace figure', async () => {
    // 60 of 200 on day 15/31 → projected 124 → healthy, "on pace for ~$124".
    const w = await mountPage([card()])
    expect(w.find('[data-testid="pace-ACME-1"]').text()).toBe('Healthy')
    const line = w.find('[data-testid="spend-line-ACME-1"]').text()
    expect(line).toContain('$60.00 of $200.00')
    expect(line).toContain('30% used')
    expect(line).toContain('on pace for ~$124.00 by Aug 31')
  })

  it('over-budget is the FACT word, and no-budget says so instead of a percent', async () => {
    const w = await mountPage([
      card({ mtd_cost_usd: '300.00' }),
      card({ id: 'p2', code: 'NOB-1', mtd_cost_usd: '10.00', allocation_usd: '0.00', utilisation: null }),
    ])
    expect(w.find('[data-testid="pace-ACME-1"]').text()).toBe('Over')
    expect(w.find('[data-testid="pace-NOB-1"]').text()).toBe('No budget set')
    expect(w.find('[data-testid="spend-line-NOB-1"]').text()).toContain('no budget set')
  })

  it('cards order by PACE SEVERITY — the over-budget fact first, not code order', async () => {
    const w = await mountPage([
      card({ id: 'p1', code: 'AAA-1', mtd_cost_usd: '60.00' }), // healthy
      card({ id: 'p2', code: 'ZZZ-9', mtd_cost_usd: '300.00' }), // over
    ])
    const codes = w
      .findAll('[data-testid^="project-card-"]')
      .map((n) => n.attributes('data-testid'))
    expect(codes).toEqual(['project-card-ZZZ-9', 'project-card-AAA-1'])
  })
})

describe('/projects — the caller’s share on each card (D25/D26)', () => {
  it('renders "yours $X · N%" with the mini share bar', async () => {
    const w = await mountPage([card()])
    const mine = w.find('[data-testid="mine-ACME-1"]')
    expect(mine.text()).toContain('yours $20.00')
    expect(mine.text()).toContain('33%')
    expect(w.find('[data-testid="mine-share-bar-ACME-1"]').exists()).toBe(true)
  })

  it('a $0 project omits the share (no 0/0 percent)', async () => {
    const w = await mountPage([
      card({ mtd_cost_usd: '0.00', mine_mtd_usd: '0.00', utilisation: 0 }),
    ])
    const mine = w.find('[data-testid="mine-ACME-1"]')
    expect(mine.text()).toContain('yours $0.00')
    expect(mine.text()).not.toContain('%')
  })
})

describe('/projects — velocity stays real, with day-1 honesty (D26)', () => {
  it('shows the 4-week delta whenever a baseline exists', async () => {
    const w = await mountPage([card()])
    expect(w.find('[data-testid="velocity-note-ACME-1"]').text()).toContain('+33% vs 4-week avg')
  })

  it('no baseline → "velocity needs a baseline — unknown, not quiet"', async () => {
    const w = await mountPage([
      card({ velocity: { current_week_usd: '10.00', trailing_mean_usd: '0.00', delta_pct: null, is_flagged: false } }),
    ])
    expect(w.find('[data-testid="velocity-note-ACME-1"]').exists()).toBe(false)
    expect(w.find('[data-testid="velocity-baseline-ACME-1"]').text()).toContain(
      'velocity needs a baseline — unknown, not quiet',
    )
  })
})
