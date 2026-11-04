// @vitest-environment happy-dom
/*
 * /projects — the card sparkline stops at the SETTLED edge (external review).
 *
 * `sparkSeries` walked `denseDays(today, dayOfMonth(today))`, so it zero-filled
 * every elapsed day INCLUDING today — a day the server has not finished
 * measuring — and `MonthSpark` then drew the line down to the baseline on it.
 * That is the morning dip F1 exists to remove, rebuilt one layer up: NULL is
 * not 0, and an empty partial day is silence, not a measured zero.
 *
 * A settled day with no rows IS a measured zero and is still filled. Today is
 * admitted only when it CARRIES data, and only then is the endpoint drawn
 * hollow ("still accruing").
 *
 * Mounting idiom: my-projects-list.test.ts, with the REAL MonthSpark — the
 * drawing is the finding, so a stub would prove nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectsPage from '../../../app/pages/projects/index.vue'
import type { ProjectCard } from '../../../shared/schemas/usage'

/** Server day 2026-08-15 ⇒ settled through the 14th; 14 settled days in August. */
const SERVER_NOW = '2026-08-15T12:00:00Z'

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
  InfoDot: true,
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`

async function mountPage(projects: ProjectCard[]) {
  vi.stubGlobal('fmtUsd', fmtUsd)
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: 't1' }), ensure: async () => {} }))
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useFetch', () => ({
    data: ref({ projects, total: projects.length, untagged_usd: '0.00' }),
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

/** The drawn line's points, in `x,y` order. */
const linePoints = (w: Awaited<ReturnType<typeof mountPage>>) =>
  w.find('[data-testid="month-spark-line"]').attributes('points')!.split(' ')

beforeEach(() => stubServerClock(SERVER_NOW))
afterEach(() => vi.unstubAllGlobals())

describe('the card spark never pads the still-filling day', () => {
  /*
   * RED ON REVERT: rebuild the series with `denseDays(today, dayOfMonth(today))`
   * and the line grows a 15th point at the baseline — the fabricated zero.
   */
  it('draws the settled days only when today carries nothing yet', async () => {
    const w = await mountPage([card({ spark: [{ day: '2026-08-01', cost_usd: '4.00' }] })])
    // 1 Aug … 14 Aug — fourteen settled days, not fifteen.
    expect(linePoints(w)).toHaveLength(14)
    // And the endpoint is a FINISHED day, so it is solid, not "still accruing".
    expect(w.find('[data-testid="month-spark-endpoint"]').attributes('data-partial')).toBe('false')
  })

  it('a settled day with no rows is still a measured zero', async () => {
    const w = await mountPage([card({ spark: [{ day: '2026-08-14', cost_usd: '9.00' }] })])
    const pts = linePoints(w)
    expect(pts).toHaveLength(14)
    // The thirteen silent settled days sit on the baseline (y = 26): real zeros.
    expect(pts[0]!.split(',')[1]).toBe('26.0')
    // The 14th is the peak, so it draws at the top.
    expect(pts[13]!.split(',')[1]).toBe('2.0')
  })

  /*
   * RED ON REVERT: hardwire the hollow endpoint back into MonthSpark, or drop
   * the `partial` flag from `sparkOf`, and the two cases stop being told apart.
   */
  it('admits today when it CARRIES spend, and marks that point partial', async () => {
    const w = await mountPage([
      card({
        spark: [
          { day: '2026-08-14', cost_usd: '9.00' },
          { day: '2026-08-15', cost_usd: '3.00' },
        ],
      }),
    ])
    /*
     * FOURTEEN, not fifteen: today is ADMITTED (it carries real spend, so it is
     * not a fabricated zero) but it is not in the LINE. Clock doc D4 — the
     * partial day is "excluded from trend lines, means and any peak label" — and
     * the hero chart on /usage already honours it. This assertion previously
     * pinned the spark's divergence from that rule, which is what made every KPI
     * spark plunge to the floor each UTC morning while the hero beside it did
     * not. The endpoint assertions below are the test's real content and are
     * unchanged: the day is still shown, still marked partial, still hollow.
     */
    expect(linePoints(w)).toHaveLength(14)
    const end = w.find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('true')
    expect(end.attributes('fill')).toBe('var(--paper)')
  })
})
