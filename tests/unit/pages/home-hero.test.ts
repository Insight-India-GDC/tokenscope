// @vitest-environment happy-dom
/*
 * The dashboard hero (app/pages/index.vue).
 *
 * WHAT IS PINNED HERE
 *
 *   the band       — the month, its TOTAL (a figure that appeared nowhere on
 *                    this page before), and the day of the month;
 *   the identities — month = project spend + unallocated, and project spend =
 *                    on-budget + no-budget. The hero splits the month across
 *                    two cards and a sub-line, so a reader can only trust it if
 *                    the parts foot;
 *   one lens       — the hero is made entirely of §A constructs (budgets,
 *                    allocations, the soft cap), so there is no lens control on
 *                    this page and exactly one money scalar in the card;
 *   the projection — where the budgeted month lands IS the health signal here,
 *                    which is why there is no pill beside it;
 *   the two-segment unallocated bar — tagged spend is a DECISION, not a gap, so
 *                    it is never painted as one;
 *   the chargeable line — the payer is the COST CENTRE, and there are THREE
 *                    reasons a dollar does or does not reach it.
 *
 * The figures below are the settled prototype's mid-month fixture, so the
 * numbers a reviewer sees here are the numbers that were signed off.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import HomePage from '../../../app/pages/index.vue'
import LensDisclosure from '../../../app/components/me/LensDisclosure.vue'
// Real, not stubbed: the freshness copy is the assertion in the last block.
import UiFreshness from '../../../app/components/ui/Freshness.vue'

const COST_CENTRE = 'APAC · CTO'
const CHARGEABLE = '5.12'
const PROVIDER_REPORTED = '1449.70'

/** Day 14 of 31 — the settled mid-month fixture. */
const DAY = 14
const DAYS_IN_MONTH = 31

const runRate = (mtd: string, daysElapsed = DAY) => ({
  projected_month_end_usd: ((Number(mtd) / daysElapsed) * DAYS_IN_MONTH).toFixed(2),
  days_elapsed: daysElapsed,
  days_in_month: DAYS_IN_MONTH,
  method: 'linear-mtd',
  is_projection: true,
})

const bucket = (
  code: string,
  name: string,
  cost: string,
  allocation: string,
  extra: Record<string, unknown> = {},
) => ({
  project_code: code,
  display_name: name,
  cost_usd: cost,
  tokens: 1_000_000,
  allocation_total_usd: allocation,
  is_active_now: false,
  source: 'assigned',
  ended: false,
  tools: [],
  ...extra,
})

/*
 * 362.03 + 358.46 + 101.71 + 0.00 = 822.20 (`total_cost_usd`), against 3,000.00
 * of allocation. Unallocated 106.88 + 38.07 = 144.95. Month = 967.15.
 */
const BUCKETS = [
  bucket('apac-internal-projects', 'APAC Internal Projects', '362.03', '1000.00'),
  bucket('tokenscope-public', 'TokenScope Support', '358.46', '1000.00', { is_active_now: true }),
  bucket('tuckwell-support', 'Foundation Scholarship Portal', '101.71', '500.00'),
  bucket('apac-q2-presales', 'APAC Q2 Solutions Presales', '0.00', '500.00'),
]

const disclosure = {
  attributed_usage_usd: '967.15',
  provider_reported_usd: PROVIDER_REPORTED,
  chargeable_usd: CHARGEABLE,
  declared_personal: [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      subscription_type: 'Claude Max 20',
      monthly_cost_usd: '200.00',
      declared_at: '2026-07-30T09:00:00.000Z',
      usage_mtd_usd: '953.60',
    },
  ],
  declared_personal_usage_usd: '953.60',
  tool_gaps: [],
  cost_centre: COST_CENTRE,
  billing_states: [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      state: 'declared-personal',
      usd: '953.60',
      subscription_type: 'Claude Max 20',
    },
    { tool: 'copilot-cli', label: 'Copilot', state: 'exempt', usd: '8.43', subscription_type: null },
    {
      tool: 'claude-ai',
      label: 'Claude Chat',
      state: 'charged',
      usd: CHARGEABLE,
      subscription_type: null,
    },
  ],
}

type Deep = Record<string, unknown>

const baseFixture = () => ({
  month_to_date: '2026-07',
  total_cost_usd: '822.20',
  total_tokens: 564_240_000,
  total_allocation_usd: '3000.00',
  base_allowance_usd: '100.00',
  total_quota_usd: '3100.00',
  buckets: BUCKETS.map((b) => ({ ...b })),
  unallocated: {
    total_cost_usd: '144.95',
    total_tokens: 100,
    tagged_cost_usd: '106.88',
    untagged_cost_usd: '38.07',
    needs_tagging_count: 2,
    needs_tagging_sessions: 2,
    needs_tagging_days: 0,
    dismissed_cost_usd: '0.00',
    dismissed_count: 0,
    untaggable_cost_usd: '0.00',
    untaggable_count: 0,
    soft_cap_usd: '100.00',
    over_soft_cap: true,
  },
  tagged_spend: [],
  surfaces: [],
  freshness_minutes_ago: 1,
  note: '',
  headline: {
    lane: 'usage',
    month: '2026-07',
    mtd_usd: '822.20',
    run_rate: runRate('822.20'),
    quota: {
      total_usd: '3100.00',
      base_allowance_usd: '100.00',
      allocation_usd: '3000.00',
      projection: { state: 'not-at-this-pace' },
    },
  },
  disclosure: structuredClone(disclosure),
  // The OTel-lane onboarding fact (r2). An established emitter by default.
  has_ever_emitted: true,
})

const passThrough = (tag: string) => ({
  template: `<div data-stub="${tag}"><slot /><slot name="actions" /></div>`,
})

const STUBS = {
  UiPageHead: {
    props: ['title', 'sub', 'eyebrow', 'crumbs'],
    template:
      '<div data-stub="page-head"><h1>{{ title }}</h1><p>{{ sub }}</p><slot name="actions" /></div>',
  },
  UiCard: passThrough('card'),
  UiEyebrow: passThrough('eyebrow'),
  UiBadge: {
    props: ['kind', 'dot'],
    template: '<span data-stub="badge" :data-kind="kind"><slot /></span>',
  },
  UiButton: passThrough('button'),
  UiEmptyState: true,
  UiFetchErrorBanner: true,
  UiFreshness,
  UiPbar: { props: ['pct'], template: '<div data-testid="pbar" :data-pct="pct" />' },
  UiToolPill: true,
  NuxtLink: passThrough('link'),
  Icon: true,
  UsageModelBadge: true,
  HomeRecentSpendStrip: true,
  HomeNeedsTaggingPanel: true,
  HomeOtherSurfacesPanel: true,
  HomeTagSessionDialog: true,
  SessionDetailDrawer: true,
  ActivityDetailDrawer: true,
  ProviderDayDetailDrawer: true,
  // §F4: Activity owns its own keyset fetch; its behaviour is pinned in
  // tests/unit/components/activity-card.test.ts. Here only the MOUNT matters.
  ActivityCard: { template: '<div data-testid="activity-card-stub" />' },
  ConnectClientDialog: true,
  MeLensDisclosure: LensDisclosure,
}

const FORMAT_MOCKS = {
  fmtUsd: (n: number | string | null | undefined) =>
    n == null || n === '' || !Number.isFinite(Number(n))
      ? '—'
      : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  fmtTokens: (n: number) => String(n),
  fmtTimeAgo: () => 'just now',
  clientMeta: () => ({ name: 'Claude Code', icon: 'logos:claude-icon' }),
  apiErrorDetail: (_e: unknown, fallback: string) => fallback,
}

/** Whatever the page passed as `query` to the home endpoint (expected: nothing). */
let sentQuery: unknown

async function mountPage(patch: (f: Deep) => void = () => {}) {
  for (const [k, v] of Object.entries(FORMAT_MOCKS)) vi.stubGlobal(k, v)
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', displayName: 'Priya Nair' }),
    ensure: async () => {},
  }))
  vi.stubGlobal('usePersonalLens', () => ref('usage'))
  vi.stubGlobal('useRefreshOnVisible', () => {})
  const fixture = baseFixture() as unknown as Deep
  patch(fixture)
  sentQuery = undefined
  vi.stubGlobal('useFetch', (url: string, opts?: { query?: unknown; default?: () => unknown }) => {
    const isHome = url.startsWith('/api/v1/me/home')
    if (isHome) sentQuery = opts?.query
    return {
      data: ref(isHome ? fixture : (opts?.default?.() ?? {})),
      refresh: vi.fn(),
      pending: ref(false),
      error: ref(null),
    }
  })
  const Parent = defineComponent({
    components: { HomePage },
    template: '<Suspense><HomePage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: FORMAT_MOCKS } })
  await flushPromises()
  return w
}

/** `width: 73.7%` → 73.7. */
function widthOf(style: string | undefined): number {
  const m = /width:\s*([\d.]+)%/.exec(style ?? '')
  return m ? Number(m[1]) : Number.NaN
}

afterEach(() => vi.unstubAllGlobals())

describe('dashboard — the band header', () => {
  it('carries the month, the month TOTAL and the day of the month', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="month-band"]').text()).toContain('July 2026')
    expect(w.find('[data-testid="month-band-total"]').text()).toBe('$967.15')
    expect(w.find('[data-testid="month-band-basis"]').text()).toBe(
      'attributed usage · month to date · day 14 of 31',
    )
  })

  it('the total IS project spend plus unallocated — the identity, not a third number', async () => {
    /*
     * The hero prints the month across two cards, and neither of them is the
     * month. The band is the only place the whole figure appears, so it has to
     * be exactly the sum of the parts drawn beneath it.
     */
    const f = baseFixture()
    const expected = Number(f.total_cost_usd) + Number(f.unallocated.total_cost_usd)
    expect(expected).toBeCloseTo(967.15, 2)
    const w = await mountPage()
    expect(w.find('[data-testid="month-band-total"]').text()).toBe('$967.15')
  })

  it('moves with the parts — more unallocated moves the band', async () => {
    // Guard the guard: without this the assertion above would pass against a
    // band hard-coded to the fixture's own literal.
    const w = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '244.95'
      u.untagged_cost_usd = '138.07'
    })
    expect(w.find('[data-testid="month-band-total"]').text()).toBe('$1,067.15')
  })
})

describe('dashboard — the budgeted card', () => {
  it('the figure is the spend that HAS a budget, over the allocations', async () => {
    const w = await mountPage()
    const figure = w.find('[data-testid="hero-primary-figure"]')
    expect(figure.text()).toContain('$822.20')
    expect(figure.text()).toContain('$3,000.00')
    expect(figure.attributes('data-mtd-scalar')).toBe('usage')
    expect(w.text()).toContain('Budgeted · 4 budgets')
  })

  it('names spend on projects with no budget separately, and it foots', async () => {
    /*
     * A project with no allocation contributes nothing to the bar's
     * denominator, so folding its spend into the figure above the bar would
     * inflate "% of allocated" with money that has no budget behind it. It is
     * named on its own line instead — and the two still sum to project spend,
     * which is what the band adds unallocated to.
     */
    const w = await mountPage((f) => {
      ;(f.buckets as unknown[]).push(bucket('skunkworks', 'Skunkworks', '23.10', '0.00'))
      f.total_cost_usd = '845.30'
    })
    expect(w.find('[data-testid="hero-primary-figure"]').text()).toContain('$822.20')
    expect(w.find('[data-testid="hero-no-budget-spend"]').text()).toBe(
      'plus $23.10 on projects with no budget set',
    )
    expect(822.2 + 23.1).toBeCloseTo(845.3, 2)
    expect(w.find('[data-testid="month-band-total"]').text()).toBe('$990.25')
    // The eyebrow counts BUDGETS, so the unbudgeted project is not one.
    expect(w.text()).toContain('Budgeted · 4 budgets')
  })

  it('with NO budget anywhere, the figure is project spend — not a forced $0.00', async () => {
    /*
     * `budgetedSpend` sums buckets with an allocation, so with none it is
     * ARITHMETICALLY FORCED to $0.00 — the eyebrow already said "0 budgets" and
     * the 40px figure below restated it, carrying no information, while the
     * month's actual money sat in an 11px "plus ..." sub-line beneath it. On the
     * demo developer that was 65% of the month.
     *
     * Reverting either half of the fix turns this red.
     */
    const w = await mountPage((f) => {
      f.buckets = [
        bucket('mga', 'Migration Assist', '23.41', '0.00'),
      ] as unknown as typeof f.buckets
      f.total_cost_usd = '23.41'
      // `totals.allocations` reads this, NOT the buckets — zero budgets means
      // zero allocation, which is the state the card mis-rendered.
      f.total_allocation_usd = '0.00'
    })
    // The card names what it is actually showing.
    expect(w.text()).toContain('On projects · 0 budgets')
    expect(w.text()).not.toContain('Budgeted · 0 budgets')
    // The figure is the money, not the tautology.
    const figure = w.find('[data-testid="hero-primary-figure"]')
    expect(figure.text()).toContain('$23.41')
    expect(figure.text()).toContain('no budget allocated')
    // ...and it is not ALSO repeated underneath as a "plus".
    expect(w.find('[data-testid="hero-no-budget-spend"]').exists()).toBe(false)
  })

  it('says nothing about no-budget spend when there is none', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="hero-no-budget-spend"]').exists()).toBe(false)
  })

  it('the share sub-line is percent-of-allocated and the day, in that order', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="hero-budgeted-share"]').text()).toBe(
      '27% of allocated · day 14 of 31',
    )
  })

  it('projects the month end from the figure above it', async () => {
    // 822.20 / 14 x 31 = 1,820.59 — a run rate on the BUDGETED figure, not on
    // the payload's whole-month one, which would land a bigger number under a
    // bar drawn from a smaller one.
    const w = await mountPage()
    expect(w.find('[data-testid="hero-projection"]').text()).toBe('≈$1,820.59 by month end')
  })

  it('withholds the projection before day 3', async () => {
    const w = await mountPage((f) => {
      ;(f.headline as Deep).run_rate = runRate('126.61', 1)
    })
    expect(w.find('[data-testid="hero-projection"]').text()).toBe('too early to project')
  })

  it('drops the aggregate token count', async () => {
    /*
     * A Fable 5 token and an Opus 5 token differ by orders of magnitude in
     * price, so one summed number measures nothing and invites a per-token
     * mental model that is wrong. The fixture still carries 564,240,000 — the
     * assertion is that the hero does not print it.
     */
    const w = await mountPage()
    const hero = w.find('[data-testid="hero-figures"]')
    expect(hero.text()).not.toContain('564240000')
    expect(hero.text().toLowerCase()).not.toContain('tokens')
  })

  it('has no status pill — the projection is the health signal', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="hero-status"]').exists()).toBe(false)
  })
})

describe('dashboard — the unallocated card', () => {
  it('draws tagged and untagged as SEPARATE segments against one scale', async () => {
    const w = await mountPage()
    const tagged = widthOf(w.find('[data-testid="unallocated-bar-tagged"]').attributes('style'))
    const untagged = widthOf(w.find('[data-testid="unallocated-bar-untagged"]').attributes('style'))
    // 106.88 and 38.07 of a 144.95 total (past the 100.00 cap, so the total is
    // the scale).
    expect(tagged).toBeCloseTo((106.88 / 144.95) * 100, 1)
    expect(untagged).toBeCloseTo((38.07 / 144.95) * 100, 1)
  })

  it('is NEVER solid amber when every unallocated dollar is decided', async () => {
    /*
     * The defect: a single bar coloured by percent-of-cap painted the whole
     * thing red and labelled the card "Over" while every dollar in it was
     * tagged. Tagged spend is an ANSWER, not a gap (D5) — the alarm colour
     * belongs to the untagged part only.
     */
    const w = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.tagged_cost_usd = '144.95'
      u.untagged_cost_usd = '0.00'
      u.needs_tagging_count = 0
    })
    expect(widthOf(w.find('[data-testid="unallocated-bar-untagged"]').attributes('style'))).toBe(0)
    expect(
      widthOf(w.find('[data-testid="unallocated-bar-tagged"]').attributes('style')),
    ).toBeCloseTo(100, 1)
    expect(w.find('[data-testid="hero-unallocated-state"]').text()).toBe(
      'Above the cap · $0.00 undecided',
    )
  })

  it('marks the soft cap only when the total is past it', async () => {
    const over = await mountPage()
    const tick = over.find('[data-testid="unallocated-soft-cap-tick"]')
    expect(tick.exists()).toBe(true)
    // 100.00 of a 144.95 total.
    expect(tick.attributes('style')).toContain('left: 68.9')

    const under = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '45.00'
      u.tagged_cost_usd = '30.00'
      u.untagged_cost_usd = '15.00'
      u.over_soft_cap = false
    })
    expect(under.find('[data-testid="unallocated-soft-cap-tick"]').exists()).toBe(false)
  })

  it('names the split, then says where the total stands against the cap', async () => {
    const over = await mountPage()
    expect(over.text()).toContain('tagged $106.88')
    expect(over.text()).toContain('untagged $38.07')
    expect(over.find('[data-testid="hero-unallocated-state"]').text()).toBe(
      'Above the cap · $38.07 undecided',
    )

    const within = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '45.00'
      u.tagged_cost_usd = '30.00'
      u.untagged_cost_usd = '15.00'
      u.over_soft_cap = false
    })
    expect(within.find('[data-testid="hero-unallocated-state"]').text()).toBe(
      'Within your allowance',
    )

    const none = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '0.00'
      u.tagged_cost_usd = '0.00'
      u.untagged_cost_usd = '0.00'
      u.needs_tagging_count = 0
      u.over_soft_cap = false
    })
    expect(none.find('[data-testid="hero-unallocated-state"]').text()).toBe(
      'Nothing outside a budget this month',
    )
  })

  it('a ZERO soft cap is not an allowance you are inside, nor a cap you are above', async () => {
    /*
     * Two wrong answers, one after the other. The original guard was
     * `softCap > 0 && spend > softCap`, so no configured allowance reported
     * "Within your allowance" — inside a thing that does not exist. Dropping
     * the guard made `overSoftCap` true against a zero cap, so the same account
     * then read "Above the cap" when there was no cap, and the branch added for
     * this case became unreachable because it sat BELOW it in the template.
     * The state is computed once now, so ordering cannot decide the verdict.
     */
    const w = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '10.00'
      u.untagged_cost_usd = '10.00'
      u.tagged_cost_usd = '0.00'
      u.soft_cap_usd = '0.00'
      u.over_soft_cap = false
    })
    const state = w.find('[data-testid="hero-unallocated-state"]').text()
    expect(state).toBe('No allowance configured')
    expect(state).not.toContain('Above the cap')
    expect(state).not.toContain('Within your allowance')
  })

  it('still names the dismissed and no-session parts, so the four foot to the total', async () => {
    /*
     * `total_cost_usd` is tagged + untagged + dismissed + untaggable
     * (server/utils/me-queries.ts). The bar draws the first two; the other two
     * are money inside the printed total, so they stay named — otherwise four
     * parts' worth of money renders under two labels.
     */
    const w = await mountPage((f) => {
      const u = f.unallocated as Deep
      u.total_cost_usd = '154.77'
      u.dismissed_cost_usd = '0.52'
      u.dismissed_count = 1
      u.untaggable_cost_usd = '9.30'
      u.untaggable_count = 2
    })
    expect(w.find('[data-testid="hero-dismissed"]').text()).toContain('0.52')
    const chip = w.find('[data-testid="hero-untaggable"]')
    expect(chip.text()).toContain('no session')
    expect(chip.text()).toContain('9.30')
    // Labelled by WHAT IT IS, not by what the system cannot do to it.
    expect(chip.text().toLowerCase()).not.toContain('taggable')
    // ...and the tooltip must not imply the spend escapes the cap.
    expect(chip.attributes('title')).toContain('soft cap')
    expect(106.88 + 38.07 + 0.52 + 9.3).toBeCloseTo(154.77, 2)
  })
})

describe('dashboard — one lens, and no lens control', () => {
  it('never asks the endpoint for a lane', async () => {
    // Every construct in the hero measures attributed usage, so there is no
    // second lane for it to be drawn in — and nothing to ask the server for.
    await mountPage()
    expect(sentQuery).toBeUndefined()
  })

  it('renders no lens toggle and exactly one money scalar in the card', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(false)
    expect(w.find('[data-testid="lens-switching"]').exists()).toBe(false)
    expect(w.find('[data-testid="hero-chargeback"]').exists()).toBe(false)
    const scalars = w.findAll('[data-mtd-scalar]')
    expect(scalars).toHaveLength(1)
    expect(scalars[0]!.attributes('data-mtd-scalar')).toBe('usage')
  })

  it('the lists under the hero still name their lens', async () => {
    const w = await mountPage()
    expect(w.text()).toContain('Attributed usage against allocated budgets')
    expect(w.text()).toContain('Attributed usage categorised with an activity')
  })
})

/*
 * RENDERING ONLY. Every test here injects `billing_states` as a prop, so it
 * proves the component draws what it is handed — never that the server derives
 * it. An external reviewer mutated the exempt predicate to `AND FALSE` and all
 * 33 tests here stayed green while the integration test went red. The derivation
 * is covered in tests/integration/me/lens-headline.test.ts, and that is where it
 * belongs; the name now says which question this file answers.
 */
describe('dashboard — RENDERING what reaches the cost centre (given states)', () => {
  it('names the amount and the COST CENTRE, human and region-qualified', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="chargeable-line"]').text()).toBe(
      '$5.12 of this month reaches APAC · CTO',
    )
    // The slug is an identifier you search or copy, never prose.
    expect(w.find('[data-testid="lens-disclosure-line"]').text()).not.toContain('apac-cto')
  })

  it('says "None of this month" rather than a bare zero when nothing is charged', async () => {
    const w = await mountPage((f) => {
      const d = f.disclosure as Deep
      d.chargeable_usd = '0.00'
      d.billing_states = (d.billing_states as { state: string }[]).filter(
        (b) => b.state !== 'charged',
      )
    })
    expect(w.find('[data-testid="chargeable-line"]').text()).toBe(
      'None of this month reaches APAC · CTO',
    )
  })

  it('falls back to the unqualified subject when no cost centre resolves', async () => {
    // `v_org_unit_cost_owner` is deliberately total via a LEFT JOIN, so a
    // placement with no cost-owning ancestor is a real state. It must not print
    // "reaches null".
    const w = await mountPage((f) => {
      ;(f.disclosure as Deep).cost_centre = null
    })
    expect(w.find('[data-testid="chargeable-line"]').text()).toBe(
      '$5.12 of this month is chargeable, but your placement resolves to no Business Unit',
    )
  })

  it('says nothing false when there is NO cost centre AND nothing chargeable', async () => {
    /*
     * The sibling of the case above, and it was left half-fixed: the chargeable
     * branch got a null guard and the zero branch did not, so it rendered
     * "None of this month reaches " with nothing after it. Walking one path and
     * not the other is the recurring shape on this project.
     */
    const w = await mountPage((f) => {
      const d = f.disclosure as Deep
      d.cost_centre = null
      d.chargeable_usd = '0.00'
      d.billing_states = []
    })
    const line = w.find('[data-testid="chargeable-line"]').text()
    expect(line).toBe('Nothing this month is chargeable to a Business Unit')
    expect(line).not.toContain('reaches ')
  })

  it('keeps the itemisation behind the (i) rather than on the fold', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="chargeable-breakdown"]').exists()).toBe(false)
    await w.find('[data-testid="chargeable-info-toggle"]').trigger('click')
    expect(w.find('[data-testid="chargeable-breakdown"]').exists()).toBe(true)
  })

  it('gives THREE genuinely different reasons, not one collapsed "nothing"', async () => {
    /*
     * "Nothing chargeable" collapses "no bill exists" and "a bill exists but is
     * not charged to you" into one claim, and only the first is a zero. Each
     * reason has to survive on its own.
     */
    const w = await mountPage()
    await w.find('[data-testid="chargeable-info-toggle"]').trigger('click')
    const pop = w.find('[data-testid="chargeable-breakdown"]').text()

    /*
     * 1. DECLARED PERSONAL. This row states the WINDOW, and nothing else.
     *
     * It is the third version of this sentence, and each predecessor was
     * rejected for claiming something the query does not compute. Both are
     * pinned as absences below so a fourth version cannot reintroduce one:
     *
     *   "so no Insight invoice exists" — a claim about the PROVIDER BILL. Mig
     *   0105:16-19: a declaration never changes an `actual_spend` chargeback
     *   verdict, so the same tool can appear here AND as `charged` in one
     *   month. This branch's own fixture puts `claude-code` in both states.
     *
     *   "This covers what you pay for yourself" — a claim about WHO FUNDED it.
     *   A declaration records that a plan exists; it cannot partition a tool's
     *   usage into personally-funded and enterprise-funded, and the query does
     *   not try to. It sums §A rows for the tool inside the interval.
     *
     * What survives is what `getMyDeclaredPersonal` actually returns.
     */
    expect(pop).toContain('$953.60')
    expect(pop).toContain('usage recorded while your declared Claude Max 20 was active')
    expect(pop).not.toContain('no Insight invoice exists')
    expect(pop).not.toContain('what you pay for yourself')

    // 2. NFR — real usage, no money, and a property of the AGREEMENT.
    expect(pop).toContain('$8.43')
    /*
     * NOT "on an NFR agreement". The predicate is `chargeback_exempt AND
     * governance_verdict_source = 'governance:tracked'`, and `tracked` is where
     * a provider org SITS BY DEFAULT before anyone classifies it commercially.
     * NFR is one reason an org is tracked-only; this row cannot tell which.
     */
    expect(pop).toContain('not charged on')
    expect(pop).not.toContain('NFR agreement')
    expect(pop).toContain('real usage, no money')
    expect(pop).toContain('a property of the agreement, not of Copilot')

    // 3. CHARGED — invoiced, and charged to the cost centre.
    expect(pop).toContain('$5.12')
    expect(pop).toContain('invoiced by Anthropic and charged to APAC · CTO')
  })

  it('never shortens the payer into a person', async () => {
    const w = await mountPage()
    await w.find('[data-testid="chargeable-info-toggle"]').trigger('click')
    const text = w.find('[data-testid="lens-disclosure-line"]').text().toLowerCase()
    expect(text).not.toContain('chargeable to you')
    expect(text).not.toContain('nothing chargeable')
  })

  it('offers the chargeback lane where it still reads — the usage-detail page', async () => {
    const w = await mountPage()
    await w.find('[data-testid="chargeable-info-toggle"]').trigger('click')
    expect(w.find('[data-testid="chargeback-view-link"]').exists()).toBe(true)
  })

  it('renders the sentence with no (i) when there is nothing to itemise', async () => {
    // No promise of a breakdown the payload cannot fill.
    const w = await mountPage((f) => {
      ;(f.disclosure as Deep).billing_states = []
    })
    expect(w.find('[data-testid="chargeable-line"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeable-info-toggle"]').exists()).toBe(false)
  })
})

describe('dashboard — the per-project pill', () => {
  it('reads the pace, not the raw percent', async () => {
    /*
     * On day 14 of 31: 362.03/1000 projects to 80%, 358.46/1000 to 79%,
     * 101.71/500 to 45% — all healthy; the $0.00 of $500 project has not
     * started. Raw percent called all four "Healthy", including the last.
     */
    const w = await mountPage()
    expect(w.find('[data-testid="pace-apac-internal-projects"]').text()).toBe('Healthy')
    expect(w.find('[data-testid="pace-apac-q2-presales"]').text()).toBe('Not started')
    expect(w.find('[data-testid="pace-apac-q2-presales"]').attributes('data-kind')).toBe('neutral')
    // No row here is on pace to exceed, so no row carries the projection line —
    // the "on pace for ~$X" figure belongs to the pace-over pill alone.
    expect(w.find('[data-testid^="pace-projection-"]').exists()).toBe(false)
  })

  it('does NOT project on day 1 — the pill takes the hero\'s day floor', async () => {
    /*
     * $126.61 of $1,000 on day 1 projects to ~$3,925 and would read "Over".
     * The hero refuses to project before day 3; a pill shouting Over beside a
     * hero saying "too early to project" is one page holding two positions.
     */
    const w = await mountPage((f) => {
      f.buckets = [bucket('tokenscope-public', 'TokenScope Support', '126.61', '1000.00')]
      f.total_cost_usd = '126.61'
      f.total_allocation_usd = '1000.00'
      ;(f.headline as Deep).run_rate = runRate('126.61', 1)
    })
    expect(w.find('[data-testid="pace-tokenscope-public"]').text()).toBe('Too early')
    expect(w.find('[data-testid="pace-tokenscope-public"]').attributes('data-kind')).toBe('neutral')
  })

  it("turns 'On pace to exceed' on a pace that will not last the month, once there are days behind it", async () => {
    /*
     * Guard the guard: the SAME ratio at day 3 does project, so the test above
     * pins the FLOOR rather than the pill simply never speaking.
     *
     * This fixture ($379.83 of $1,000 on day 3 — the day-1 fixture's $126.61/
     * day pace, past the floor) is a FORECAST: the spend itself is still well
     * under the allocation, it merely projects to ~3.9x. Pre-D8 the pill said
     * "Over" (red) here — the same word as money already past the budget.
     * Under the split the forecast says what it is, in amber.
     */
    const w = await mountPage((f) => {
      f.buckets = [bucket('tokenscope-public', 'TokenScope Support', '379.83', '1000.00')]
      f.total_cost_usd = '379.83'
      f.total_allocation_usd = '1000.00'
      ;(f.headline as Deep).run_rate = runRate('379.83', 3)
    })
    expect(w.find('[data-testid="pace-tokenscope-public"]').text()).toBe('On pace to exceed')
    expect(w.find('[data-testid="pace-tokenscope-public"]').attributes('data-kind')).toBe('rag-amber')
    // The pill carries its number: this bucket's own landing, on the page's
    // month-end date (fixture month 2026-07, 31 days) — 379.83 / 3 x 31.
    expect(w.find('[data-testid="pace-projection-tokenscope-public"]').text()).toBe(
      'on pace for ~$3,924.91 by July 31',
    )
  })

  it("prints the row's OWN landing under the pill, not the portfolio's", async () => {
    /*
     * r1-M4 / design test 23: the projection under a pace-over pill is PER
     * BUCKET. Two projects on day 3 — 379.83 → ~$3,924.91 and 200.00 →
     * ~$2,066.67 by July 31. The portfolio (579.83) lands at ~$5,991.58: if
     * either row printed that, the line would be reusing the hero's
     * monthEndProjection, which is every project's combined total.
     */
    const w = await mountPage((f) => {
      f.buckets = [
        bucket('tokenscope-public', 'TokenScope Support', '379.83', '1000.00'),
        bucket('apac-internal-projects', 'APAC Internal Projects', '200.00', '1000.00'),
      ]
      f.total_cost_usd = '579.83'
      f.total_allocation_usd = '2000.00'
      ;(f.headline as Deep).run_rate = runRate('579.83', 3)
    })
    const a = w.find('[data-testid="pace-projection-tokenscope-public"]').text()
    const b = w.find('[data-testid="pace-projection-apac-internal-projects"]').text()
    expect(a).toBe('on pace for ~$3,924.91 by July 31')
    expect(b).toBe('on pace for ~$2,066.67 by July 31')
    for (const line of [a, b]) expect(line).not.toContain('$5,991.58')
  })

  it('leaves the no-budget row exactly as it was — text, not a pill', async () => {
    const w = await mountPage((f) => {
      ;(f.buckets as unknown[]).push(bucket('skunkworks', 'Skunkworks', '23.10', '0.00'))
      f.total_cost_usd = '845.30'
    })
    expect(w.find('[data-testid="pace-skunkworks"]').exists()).toBe(false)
    expect(w.find('[data-testid="usage-bucket-skunkworks"]').text()).toContain('no budget set')
  })
})

describe('dashboard — the parts this change did not touch', () => {
  it('keeps the freshness line, without the ingestion caveat', async () => {
    const w = await mountPage()
    expect(w.text()).toContain('Updated 1 min ago')
    // Our mechanism, not the reader's problem — explain a lag where the data IS
    // stale, not beside a figure that is one minute old.
    expect(w.text()).not.toContain('Anthropic actuals lag')
  })

  it('does not hedge the primary figure', async () => {
    const w = await mountPage()
    const text = w.text().toLowerCase()
    for (const hedge of ['notional', 'not real spend', 'hypothetical', 'does not count']) {
      expect(text).not.toContain(hedge)
    }
    expect(w.text()).toContain('token spend')
  })

  it('keeps the connect buttons, the tagged card and the Activity table', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="connect-claude"]').exists()).toBe(true)
    expect(w.find('[data-testid="connect-desktop"]').exists()).toBe(true)
    expect(w.find('[data-testid="connect-copilot"]').exists()).toBe(true)
    expect(w.find('[data-testid="activity-card-stub"]').exists()).toBe(true)
    expect(w.find('[data-testid="spill-card"]').exists()).toBe(true)
  })
})

/*
 * ── THE ONBOARDING CTA — "has this person ever EMITTED?" (external review r2 +
 * owner ruling) ─────────────────────────────────────────────────────────────
 *
 * Two earlier answers were wrong in the same way: they were about RECORDS, not
 * about EMISSION. The last one derived emptiness from the Activity card's
 * `hasRows` — the current page of the current filter — which shows a brand-new-
 * developer CTA to an established one the moment a filter matches nothing or a
 * refresh fails, and which counts API-reported provider days as evidence of
 * emitting. The signal is now one server fact on `attribution_record` (the OTel
 * lane; its only writer is the Azure-Monitor reader), all-time and unfiltered.
 *
 * RED ON REVERT: restore `noAttributed && !activityCard.hasRows` and the
 * Copilot-only case goes red (spend on record ⇒ classified as onboarded); make
 * the signal anything that defaults to false/absent-is-empty and the unanswered
 * case goes red.
 */
describe('dashboard — the onboarding CTA is an OTel-emission question', () => {
  it('an established emitter never sees it', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="onboarding-cta"]').exists()).toBe(false)
  })

  it('a teammate with nothing on record at all sees it', async () => {
    const w = await mountPage((f) => {
      f.has_ever_emitted = false
      f.total_cost_usd = '0.00'
      f.buckets = []
      f.surfaces = []
    })
    expect(w.find('[data-testid="onboarding-cta"]').exists()).toBe(true)
  })

  it('SPEND ON RECORD IS NOT EMISSION: a Copilot-only teammate still sees it', async () => {
    /*
     * The API lane reports this person's days, so every record-shaped signal on
     * the page — the month total, the buckets, the Activity list F4 made a union
     * — says "established". They have emitted nothing. That is the rollout gap
     * the product measures, and it must not read as coverage.
     */
    const w = await mountPage((f) => {
      f.has_ever_emitted = false
    })
    expect(Number((baseFixture() as Deep).total_cost_usd)).toBeGreaterThan(0)
    expect(w.find('[data-testid="onboarding-cta"]').exists()).toBe(true)
  })

  /*
   * THE CTA NAMES WHICH OF THE TWO STATES IT IS IN (owner ruling 2026-08-06).
   * Classification alone was not enough: a Copilot-only teammate correctly got
   * the CTA and was then told "No usage yet", which is false to someone whose
   * spend we are already reporting — it reads as the product being broken
   * rather than as an invitation to enrol.
   * REVERT: collapse the two headlines back to one and the provider-only case
   * asserts a falsehood, which is what these two pin.
   */
  it('a Copilot-only teammate is told what we CAN see, not that there is nothing', async () => {
    const w = await mountPage((f) => {
      f.has_ever_emitted = false
    })
    expect(w.find('[data-testid="onboarding-headline-provider-only"]').exists()).toBe(true)
    expect(w.find('[data-testid="onboarding-headline-new"]').exists()).toBe(false)
    // The falsehood must be absent, not merely outweighed by other copy.
    expect(w.find('[data-testid="onboarding-cta"]').text()).not.toContain('No usage yet')
  })

  it('a genuinely new teammate still gets the plain invitation', async () => {
    const w = await mountPage((f) => {
      f.has_ever_emitted = false
      f.total_cost_usd = '0.00'
      f.buckets = []
      f.surfaces = []
    })
    expect(w.find('[data-testid="onboarding-headline-new"]').exists()).toBe(true)
    expect(w.find('[data-testid="onboarding-headline-provider-only"]').exists()).toBe(false)
  })

  it('an UNANSWERED signal is not emptiness — a failed fetch shows no CTA', async () => {
    // The awaited payload's default leaves the field unset; zero everything else
    // so only the missing fact can decide.
    const w = await mountPage((f) => {
      delete f.has_ever_emitted
      f.total_cost_usd = '0.00'
      f.buckets = []
      f.surfaces = []
    })
    expect(w.find('[data-testid="onboarding-cta"]').exists()).toBe(false)
  })
})
