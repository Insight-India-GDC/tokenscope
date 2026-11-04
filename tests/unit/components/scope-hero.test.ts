// @vitest-environment happy-dom
/*
 * ScopeHero — the Region scope's whole-company headline + KPI row, against the
 * owner-signed prototype (docs/design/reporting-consolidation/prototype.html,
 * band 1 of the `across` view and its numbered `note('fix N', …)` entries).
 *
 * The fixture reproduces the prototype's OWN numbers on purpose, so the expected
 * strings in this file can be read straight off the design:
 *
 *   July 2026 · $39,702.37 · attributed usage · the whole company · month to date · day 14 of 31
 *   ATTRIBUTED USAGE  $39,702.37  every provider, tagged or not   ↑ 31% vs last month
 *   CHARGEABLE        $9,420.18   reaches a cost centre           ↓ 4%  vs last month
 *   ACTIVE PEOPLE     207         spent on any provider           ↑ 24  vs last month
 *                                 29 of 207 …
 *   MEDIAN PER PERSON $138.10     half of 207 are below this      ↓ 6%  vs last month
 *                                 26% top 1% · 48% top 5% · 63% top 10%
 *
 * What each block guards, and the mutation that turns it red, is stated on the
 * describe — a test that cannot fail certifies nothing.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeHero from '../../../app/components/reporting/ScopeHero.vue'
import type { AcrossReport } from '../../../app/components/reporting/across-report-types'
// Asserted through the CONSTANT: these tests are about the CLAIM, and pinning
// the noun made a vocabulary change read as a behaviour regression.
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

// ClientOnly + VChart are Nuxt globals the reporting charts mount inside.
const global = {
  stubs: { ClientOnly: { template: '<div><slot /></div>' }, VChart: true },
}

const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-14',
  // The request clock's last SETTLED day — `today − 1`. The 14-day fixture runs
  // to 2026-07-14, so its last point IS today and the sparks may say so.
  settledThrough: '2026-07-13',
  providerStates: [],
  coverage: { applicable: true, denominator: 207, connected: 29, nonConnected: 178, stale: false },
  scope: 'region' as const,
}

/** Fourteen days of §A daily metrics — the SAME window the headline was summed over. */
const dailyMetrics = Array.from({ length: 14 }, (_, i) => ({
  day: `2026-07-${String(i + 1).padStart(2, '0')}`,
  genuineUsd: 2835.88,
  tokens: 1_000_000,
  activeUsers: 200 + i,
}))

const chargeDaily = dailyMetrics.map((d) => ({ day: d.day, chargeUsd: 672.87 }))

function makeReport(over: Partial<AcrossReport> = {}): AcrossReport {
  return {
    meta,
    width: 'all-regions',
    region: null,
    regionOptions: [],
    allRegionsAvailable: true,
    kpis: {
      genuineUsd: 39_702.37,
      chargeableUsd: 9420.18,
      anthropicChargeableUsd: 9420.18,
      tokens: 10_470_000_000,
      activeUsers: 207,
      momDeltaPct: 0.31,
      chargeMomDeltaPct: -0.04,
      avgPerUserUsd: 39_702.37 / 207,
      billedTeammates: 180,
      billedTokens: 9_000_000_000,
      avgChargePerBilledUser: 52.33,
    },
    copilot: { mode: 'chargeback', pending: false, chargeableUsd: 3000 },
    forecast: {
      asOfDate: '2026-07-14',
      daysElapsed: 14,
      dayOfMonth: 14,
      daysInMonth: 31,
      factor: 31 / 14,
      meteredMtdUsd: 39_702.37,
      meteredProjectedUsd: 87_912.53,
      projectedUsd: 87_912.53,
    },
    actualUsd: 39_702.37,
    dailyMetrics,
    budgetCoverage: {
      scopeLabel: 'the whole company',
      totalUsd: 39_702.37,
      budgetedUsd: 23_027.37,
      taggedNoBudgetUsd: 10_719.64,
      untaggedUsd: 4764.28,
      untaggableUsd: 1191.08,
    },
    chargeDaily,
    chargebackProviderSplit: { anthropicUsd: 6420.18, copilotUsd: 3000 },
    chargebackLanes: [{ lane: 'claude', chargeUsd: 9420.18 }],
    perPerson: {
      medianUsd: 138.1,
      top1: 0.26,
      top5: 0.48,
      top10: 0.63,
      emittingPeople: 29,
      peopleMomDelta: 24,
      medianMomDeltaPct: -0.06,
    },
    providerSplit: {
      claudeCode: { spendUsd: 30_000, activeUsers: 150 },
      copilotCli: { spendUsd: 9702.37, activeUsers: 90 },
      copilotAgent: { spendUsd: 0, activeUsers: 0 },
      other: { spendUsd: 0, activeUsers: 0 },
    },
    regionCards: [],
    chargebackByRegion: [],
    ...over,
  }
}

const mountHero = (over: Partial<AcrossReport> = {}, lane: 'usage' | 'chargeback' = 'usage') =>
  mount(ScopeHero, { props: { report: makeReport(over), lane }, global })

const tile = (w: ReturnType<typeof mountHero>, id: string) => w.find(`[data-testid="scope-kpi-${id}"]`)

/*
 * MUTATION: restore the run-rate headline (swap `heroUsd` for
 * `forecast.projectedUsd` and the context for "On track for") — the first two
 * assertions go red. Deleting the `paceLabel` segment reddens the third.
 */
describe('ScopeHero — the headline is the figure, not the projection', () => {
  it('reads period · figure · what it is of · how far through', () => {
    const w = mountHero()
    expect(w.find('[data-testid="scope-hero-period"]').text()).toBe('July 2026')
    expect(w.find('[data-testid="scope-hero-total"]').text()).toBe('$39,702.37')
    expect(w.find('[data-testid="scope-hero-context"]').text()).toBe(
      'attributed usage · the whole company · month to date · day 14 of 31',
    )
  })

  it('never presents the run-rate as the headline', () => {
    const w = mountHero()
    const line = w.find('[data-testid="scope-hero-line"]').text()
    expect(line).not.toContain('On track for')
    // The projection is real (forecast.projectedUsd = 87,912.53) and deliberately absent here.
    expect(line).not.toContain('87,912')
  })

  it('a CLOSED month (no forecast) says "full month", never a day count it does not have', () => {
    const w = mountHero({ forecast: null })
    const ctx = w.find('[data-testid="scope-hero-context"]').text()
    expect(ctx).toContain('full month')
    expect(ctx).not.toContain('month to date')
    expect(ctx).not.toContain('day ')
  })

  it('a CUSTOM RANGE names its own bounds and claims no month pacing', () => {
    const w = mountHero({
      forecast: null,
      meta: { ...meta, range: { from: '2026-06-01', to: '2026-07-15' } },
    })
    expect(w.find('[data-testid="scope-hero-period"]').text()).toBe('2026-06-01 → 2026-07-15')
    const ctx = w.find('[data-testid="scope-hero-context"]').text()
    expect(ctx).not.toContain('month to date')
    expect(ctx).not.toContain('full month')
  })

  it('CHARGEBACK lane re-lenses the headline to the §B cost-of-record', () => {
    const w = mountHero({}, 'chargeback')
    expect(w.find('[data-testid="scope-hero-total"]').text()).toBe('$9,420.18')
    expect(w.find('[data-testid="scope-hero-context"]').text()).toContain('chargeable')
  })
})

/*
 * MUTATION: re-add a `<ScopeKpiTile label="Tokens" …>` / `label="Avg usage / user"`
 * / `data-testid="scope-kpi-mom"` tile to the row — the matching assertion here
 * goes red. fix 2 / fix 2b.
 */
describe('ScopeHero — four tiles: no Tokens, no avg-per-user, no standalone MoM', () => {
  it('renders exactly the four the prototype names, in order', () => {
    // The row's own children, in DOM order — a per-tile `find` would pass on a row
    // that had them shuffled, or that carried a fifth.
    const row = mountHero().find('[data-testid="scope-kpi-row"]')
    const labels = row.element.children
    expect([...labels].map((el) => el.querySelector('span')?.textContent?.trim())).toEqual([
      'Attributed usage',
      'Chargeable',
      'Active people',
      'Median per person',
    ])
  })

  it('has no Tokens tile, no avg-per-user tile and no standalone MoM tile', () => {
    const w = mountHero()
    expect(tile(w, 'tokens').exists()).toBe(false)
    expect(tile(w, 'avg').exists()).toBe(false)
    expect(tile(w, 'mom').exists()).toBe(false)
    const row = w.find('[data-testid="scope-kpi-row"]').text()
    expect(row).not.toContain('Tokens')
    expect(row).not.toContain('Avg usage')
    expect(row).not.toContain('MoM')
  })

  it('the sublines are ONE line each — no second caption under the money tiles', () => {
    const w = mountHero()
    expect(tile(w, 'genuine').text()).toContain('every provider, tagged or not')
    // The old two-caption stack ("≈ $X will be charged" + "not an invoice") is gone:
    // a chargeable estimate under the attributed figure was the §B lane leaking
    // into a §A tile that already sits beside the real chargeable one.
    expect(tile(w, 'genuine').text()).not.toContain('will be charged')
    expect(tile(w, 'genuine').text()).not.toContain('not an invoice')
    expect(tile(w, 'chargeable').text()).toContain(`reaches a ${BU_LABEL_LOWER}`)
  })
})

/*
 * MUTATION: drop the `delta-label`/`delta-basis` bindings from any one tile — that
 * tile's assertion goes red. Swap `peopleDelta` to a percentage — the "no %" guard
 * goes red. fix 2 / fix 2c.
 */
describe('ScopeHero — every tile carries its OWN delta', () => {
  it('money tiles carry a PERCENTAGE delta with a direction arrow', () => {
    const w = mountHero()
    expect(tile(w, 'genuine').find('[data-testid="kpi-delta"]').text()).toContain('↑')
    expect(tile(w, 'genuine').find('[data-testid="kpi-delta"]').text()).toContain('31%')
    expect(tile(w, 'genuine').find('[data-testid="kpi-delta"]').text()).toContain('vs last month')
    expect(tile(w, 'chargeable').find('[data-testid="kpi-delta"]').text()).toContain('↓')
    expect(tile(w, 'chargeable').find('[data-testid="kpi-delta"]').text()).toContain('4%')
    expect(tile(w, 'median').find('[data-testid="kpi-delta"]').text()).toContain('↓')
    expect(tile(w, 'median').find('[data-testid="kpi-delta"]').text()).toContain('6%')
  })

  it('the COUNT tile carries an ABSOLUTE delta — never a percentage of a headcount', () => {
    const d = tile(mountHero(), 'active').find('[data-testid="kpi-delta"]')
    expect(d.text()).toContain('↑')
    expect(d.text()).toContain('24')
    expect(d.text()).toContain('vs last month')
    expect(d.text()).not.toContain('%')
  })

  it('a delta is a MAGNITUDE, not a status — arrow only, never a RAG tint', () => {
    const w = mountHero()
    const html = w.find('[data-testid="scope-kpi-row"]').html()
    expect(html).not.toContain('rag-green')
    expect(html).not.toContain('rag-red')
  })

  it('withholds rather than invents when there is no prior operand', () => {
    const w = mountHero({
      kpis: { ...makeReport().kpis, momDeltaPct: null, chargeMomDeltaPct: null },
      perPerson: { ...makeReport().perPerson!, peopleMomDelta: null, medianMomDeltaPct: null },
    })
    for (const id of ['genuine', 'chargeable', 'active', 'median']) {
      expect(tile(w, id).find('[data-testid="kpi-delta"]').exists()).toBe(false)
      expect(tile(w, id).find('[data-testid="kpi-delta-empty"]').text()).toBe('too early to compare')
    }
  })

  it('a custom range says it has no MONTH to compare against, not that it is too early', () => {
    const w = mountHero({
      forecast: null,
      meta: { ...meta, range: { from: '2026-06-01', to: '2026-07-15' } },
      kpis: { ...makeReport().kpis, momDeltaPct: null, chargeMomDeltaPct: null },
      perPerson: { ...makeReport().perPerson!, peopleMomDelta: null, medianMomDeltaPct: null },
    })
    expect(tile(w, 'genuine').find('[data-testid="kpi-delta-empty"]').text()).toBe(
      'no month-on-month for a custom range',
    )
  })
})

/*
 * MUTATION: label the tile "Active users / distinct teammates" again, or point the
 * emitting line at a different denominator — the assertions here go red. fix 2a.
 */
describe('ScopeHero — Active people counts everyone who SPENT', () => {
  it('says what it counted, and splits out who is emitting', () => {
    const t = tile(mountHero(), 'active')
    expect(t.text()).toContain('Active people')
    expect(t.text()).toContain('207')
    expect(t.text()).toContain('spent on any provider')
    expect(t.text()).not.toContain('distinct teammates')
    expect(t.find('[data-testid="kpi-note"]').text()).toBe('29 of 207 emitting through TokenScope')
  })

  it('the emitting split divides by the SAME headcount the tile shows', () => {
    const w = mountHero({ kpis: { ...makeReport().kpis, activeUsers: 90 } })
    const t = tile(w, 'active')
    expect(t.text()).toContain('90')
    expect(t.find('[data-testid="kpi-note"]').text()).toBe('29 of 90 emitting through TokenScope')
  })
})

/*
 * MUTATION: remove the `note`/`note-separated` bindings from the median tile (the
 * percentiles vanish), or drop the `showMedian` cohort gate (the small-n tile
 * appears) — the matching assertion goes red. fix 6.
 */
describe('ScopeHero — Concentration folded into Median per person', () => {
  it('carries the median, its denominator, its delta and the three percentiles', () => {
    const t = tile(mountHero(), 'median')
    expect(t.text()).toContain('Median per person')
    expect(t.text()).toContain('$138.10')
    expect(t.text()).toContain('half of 207 are below this')
    expect(t.find('[data-testid="kpi-note"]').text()).toBe('26% top 1% · 48% top 5% · 63% top 10%')
  })

  it('carries NO sparkline — there is no per-day median series to draw', () => {
    const t = tile(mountHero(), 'median')
    expect(t.find('[data-testid="month-spark"]').exists()).toBe(false)
  })

  it('is SUPPRESSED below five people — a median of four names an individual', () => {
    const w = mountHero({ kpis: { ...makeReport().kpis, activeUsers: 4 } })
    expect(tile(w, 'median').exists()).toBe(false)
    // The other three still render — the row degrades, it does not disappear.
    expect(tile(w, 'genuine').exists()).toBe(true)
    expect(tile(w, 'active').exists()).toBe(true)
  })

  it('is ABSENT (never a zero it did not measure) when the payload carries no cohort', () => {
    const w = mountHero({ perPerson: undefined })
    expect(tile(w, 'median').exists()).toBe(false)
    expect(tile(w, 'active').find('[data-testid="kpi-note"]').exists()).toBe(false)
  })
})

/*
 * MUTATION: put any floor back on ScopeKpiTile's spark (the retired
 * `SPARK_MIN_DAYS`, at 7 or at the prototype's old 3) — the day-1 and six-day
 * cases stop drawing a line and these go red. F2/D7, owner 2026-08-05: a
 * month's first days are not an error state.
 */
describe('ScopeHero — the spark spans the whole month, always (T7)', () => {
  it('draws over a full window, and the frame is the MONTH, not the data', () => {
    const w = mountHero()
    const t = tile(w, 'genuine')
    expect(t.find('[data-testid="month-spark-line"]').exists()).toBe(true)
    // 14 elapsed days of a 31-day month -> 17 days still to come, as dots.
    expect(t.findAll('[data-testid="month-spark-dot"]')).toHaveLength(17)
    expect(t.text()).not.toContain('not enough days yet')
  })

  /*
   * DAY 1 — the case the old floors could never draw and the parity gate never
   * captured, because it only ever shot mid-month. One point and thirty dots.
   */
  it('draws on DAY 1: one point, and the rest of the month as dots', () => {
    const w = mountHero({
      dailyMetrics: dailyMetrics.slice(0, 1),
      chargeDaily: chargeDaily.slice(0, 1),
    })
    for (const key of ['genuine', 'chargeable', 'active']) {
      const t = tile(w, key)
      expect(t.find('[data-testid="month-spark-endpoint"]').exists()).toBe(true)
      expect(t.findAll('[data-testid="month-spark-dot"]')).toHaveLength(30)
      expect(t.text()).not.toContain('not enough days yet')
    }
  })

  it('draws below a full week too — six days is six days of measured shape', () => {
    const w = mountHero({
      dailyMetrics: dailyMetrics.slice(0, 6),
      chargeDaily: chargeDaily.slice(0, 6),
    })
    expect(tile(w, 'genuine').find('[data-testid="month-spark-line"]').exists()).toBe(true)
    expect(tile(w, 'genuine').findAll('[data-testid="month-spark-dot"]')).toHaveLength(25)
    expect(w.text()).not.toContain('not enough days yet')
  })

  /*
   * The last drawn point is TODAY and today is still filling, so it is hollow —
   * the one partial mark lines, sparks and stacked bars share (F1/D5).
   */
  it('leaves the last point hollow, because today is still filling', () => {
    const end = tile(mountHero(), 'genuine').find('[data-testid="month-spark-endpoint"]')
    expect(end.exists()).toBe(true)
    expect(end.attributes('fill')).toBe('var(--paper)')
  })

  /*
   * THE FRAME CANNOT ANSWER "IS THE LAST POINT TODAY" (external review r2).
   *
   * RED ON REVERT: restore MonthSpark's `props.partial ?? span > n` inference (or
   * drop `:spark-partial` from these tiles) and the first case below draws the
   * still-accruing mark on 2026-07-13 — a SETTLED day — because the month still
   * has days to come. That is the false-partial defect the endpoint fix was
   * written to remove, relocated into the frame.
   */
  it('a series stopping at the SETTLED edge draws a solid endpoint, days left in the month or not', () => {
    const w = mountHero({
      // The normal §A shape most of the UTC day: the axis stops at
      // `settledThrough` because today carries no rows yet.
      dailyMetrics: dailyMetrics.slice(0, 13),
      chargeDaily: chargeDaily.slice(0, 13),
    })
    const t = tile(w, 'genuine')
    // 13 of 31 days drawn — the frame plainly has days to come …
    expect(t.findAll('[data-testid="month-spark-dot"]')).toHaveLength(18)
    // … and the endpoint is still SOLID, because 2026-07-13 is finished.
    const end = t.find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('false')
    expect(end.attributes('fill')).not.toBe('var(--paper)')
  })

  it('with no settledThrough on the payload it makes NO claim — no endpoint marker at all', () => {
    const noClock = { ...meta }
    delete (noClock as { settledThrough?: string }).settledThrough
    const w = mountHero({ meta: noClock })
    for (const key of ['genuine', 'chargeable', 'active']) {
      const t = tile(w, key)
      expect(t.find('[data-testid="month-spark-line"]').exists()).toBe(true)
      expect(t.find('[data-testid="month-spark-endpoint"]').exists()).toBe(false)
    }
  })
})

/*
 * THE REGION WIDTH GETS THE SAME ROW — the whole point of the component being
 * shared. This mounts a SINGLE-REGION payload (the shape
 * `/api/v1/reports/region?region=<uuid>` returns) rather than the whole-company
 * one every block above uses.
 *
 * MUTATION: give ScopeRegionalView its own hero again — or drop `perPerson` /
 * `momDeltaPct` from the regional branch of the route — and these go red. The
 * defect they pin is real and shipped: the region width carried a standalone MoM
 * tile, a Tokens tile and an avg-per-user tile, with no median at all.
 */
describe('ScopeHero — the SINGLE-REGION payload gets the identical row', () => {
  const regionalReport = {
    meta: { month: '2026-08', settledThrough: '2026-08-03' },
    kpis: {
      genuineUsd: 1863.63,
      chargeableUsd: 402.11,
      activeUsers: 42,
      momDeltaPct: 0.12,
      chargeMomDeltaPct: -0.03,
    },
    copilot: { pending: false },
    forecast: {
      asOfDate: '2026-08-03',
      daysElapsed: 3,
      dayOfMonth: 3,
      daysInMonth: 31,
      factor: 31 / 3,
      meteredMtdUsd: 1863.63,
      meteredProjectedUsd: 19_257.51,
      projectedUsd: 19_257.5,
    },
    dailyMetrics: dailyMetrics.slice(0, 8),
    chargeDaily: chargeDaily.slice(0, 8),
    budgetCoverage: {
      scopeLabel: 'APAC',
      totalUsd: 1863.63,
      budgetedUsd: 900,
      taggedNoBudgetUsd: 500,
      untaggedUsd: 400,
      untaggableUsd: 63.63,
    },
    perPerson: {
      medianUsd: 31.94,
      top1: 0.21,
      top5: 0.44,
      top10: 0.6,
      emittingPeople: 11,
      peopleMomDelta: 5,
      medianMomDeltaPct: -0.08,
    },
  }
  const mountRegion = (lane: 'usage' | 'chargeback' = 'usage') =>
    mount(ScopeHero, { props: { report: regionalReport, lane }, global })

  it('leads with the FIGURE and the region name, never the run-rate projection', () => {
    const w = mountRegion()
    expect(w.find('[data-testid="scope-hero-period"]').text()).toBe('August 2026')
    expect(w.find('[data-testid="scope-hero-total"]').text()).toBe('$1,863.63')
    expect(w.find('[data-testid="scope-hero-context"]').text()).toBe(
      'attributed usage · APAC · month to date · day 3 of 31',
    )
    const line = w.find('[data-testid="scope-hero-line"]').text()
    expect(line).not.toContain('On track for')
    // forecast.projectedUsd = 19,257.50 — real, and deliberately not the headline.
    expect(line).not.toContain('19,257')
  })

  it('carries no byline explaining the headline', () => {
    const html = mountRegion().html()
    expect(html).not.toContain('Run-rate projection')
    expect(html).not.toContain('month in progress')
    expect(html).not.toContain('attributed usage so far')
  })

  it('renders the SAME four tiles — no Tokens, no avg-per-user, no standalone MoM', () => {
    const row = mountRegion().find('[data-testid="scope-kpi-row"]')
    expect([...row.element.children].map((el) => el.querySelector('span')?.textContent?.trim())).toEqual([
      'Attributed usage',
      'Chargeable',
      'Active people',
      'Median per person',
    ])
    expect(row.text()).not.toContain('Tokens')
    expect(row.text()).not.toContain('Avg usage')
    expect(row.text()).not.toContain('MoM')
  })

  it('every tile carries its own delta, the headcount one ABSOLUTE', () => {
    const w = mountRegion()
    expect(w.find('[data-testid="scope-kpi-genuine"] [data-testid="kpi-delta"]').text()).toContain('12%')
    const people = w.find('[data-testid="scope-kpi-active"] [data-testid="kpi-delta"]').text()
    expect(people).toContain('5')
    expect(people).not.toContain('%')
  })

  it('publishes the median, its denominator and the three percentiles', () => {
    const t = mountRegion().find('[data-testid="scope-kpi-median"]')
    expect(t.text()).toContain('$31.94')
    expect(t.text()).toContain('half of 42 are below this')
    expect(t.find('[data-testid="kpi-note"]').text()).toBe('21% top 1% · 44% top 5% · 60% top 10%')
  })
})
