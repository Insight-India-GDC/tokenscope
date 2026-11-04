// @vitest-environment happy-dom
/*
 * ScopeRegionalView — the presentational Regional (single-region) tree, rebuilt to
 * the locked design language + AEUF parity. Verifies build-design §3's "exactly one
 * of skeleton / error / empty / data" contract, the hero KPI pair, the provider
 * split + spend trend + practice rank + top-models + drivers +
 * concentration section, the Copilot chargeback "pending" vs "included" chip, the
 * cross-region-only region selector, and the practice drill breadcrumb.
 *
 * The View renders the real (auto-import-backed) DateRangeControl and the ECharts
 * client kit; both are stubbed here so the pure View mounts without a Nuxt runtime.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeRegionalView from '../../../app/components/reporting/ScopeRegionalView.vue'
import { makeReport, regionalViewGlobal } from './helpers/regional-report-fixture'
import type {
  RegionalDriversResp,
  RegionalTrendResp,
} from '../../../app/components/reporting/regional/regional-view-types'
import {
  computeConcentration,
  type ConcentrationStats,
} from '../../../shared/reports/concentration'
import type { ActiveTrend, Seasonality } from '../../../shared/reports/types'
// Asserted through the CONSTANT: these tests are about the CLAIM, and pinning
// the noun made a vocabulary change read as a behaviour regression.
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'
import { PLACEMENT_NOTE } from '../../../app/components/reporting/lane-captions'

// DateRangeControl self-wires to the auto-imported useReportState (undefined outside
const global = regionalViewGlobal




// `region` is null here because the VIEW never reads it: the on-screen guard that
// does (teammate-cut.ts) lives in the container, one level up.
const drivers: RegionalDriversResp = {
  axis: 'teammate',
  width: 'region',
  region: null,
  headlineUsd: 50,
  rows: [
    { key: 'd', label: 'dave', usd: 30, sharePct: 0.6, spendClass: 'pooled-usage' },
    { key: 'a', label: 'alice', usd: 20, sharePct: 0.4, spendClass: 'indicative' },
  ],
}

const modelDrivers: RegionalDriversResp = {
  axis: 'model',
  width: 'region',
  region: null,
  headlineUsd: 50,
  rows: [
    { key: 'opus', label: 'claude-opus-4', usd: 32, sharePct: 0.64, spendClass: 'indicative' },
    { key: 'sonnet', label: 'claude-sonnet-4', usd: 18, sharePct: 0.36, spendClass: 'indicative' },
  ],
}

const trend: RegionalTrendResp = {
  width: 'region',
  // Null for the same reason the drivers fixtures above are: the VIEW never reads
  // it. The on-screen region guard that does (teammate-cut.ts `trendOnScreen`)
  // lives in the container, one level up.
  region: null,
  // The ONE shared window object the billed hero + donut bind on (iter-2 I1).
  window: { from: '2026-07-01', to: '2026-07-31' },
  windowDays: 31,
  // §A wire keys are the registry tool ids (the V2-Regional widening — the
  // pre-widening display names 'Claude'/'Copilot' are gone).
  series: [
    { day: '2026-07-02', key: 'claude-code', value: 20 },
    { day: '2026-07-03', key: 'copilot-cli', value: 8 },
  ],
  // §B daily Anthropic chargeback series (bill lane) — feeds the §B spend-trend card.
  chargeSeries: [
    { day: '2026-07-02', chargeUsd: 6 },
    { day: '2026-07-03', chargeUsd: 6 },
  ],
  // The per-lane widening (lane-visuals V2-Regional) — Σ lanes per day == chargeSeries[day].
  chargeLanes: [
    { day: '2026-07-02', lane: 'claude', chargeUsd: 6 },
    { day: '2026-07-03', lane: 'claude', chargeUsd: 4 },
    { day: '2026-07-03', lane: 'claude-ai', chargeUsd: 2 },
  ],
  // Canonical §A per-surface weekly usage cells (requirement 1) — the usage-view
  // hero + donut. Now the SAME basis as the KPI strip above them.
  usageWeeklyLanes: [
    { weekStart: '2026-06-29', lane: 'claude', usd: 30 },
    { weekStart: '2026-06-29', lane: 'claude-ai', usd: 12 },
    { weekStart: '2026-07-06', lane: 'claude', usd: 14 },
    { weekStart: '2026-07-06', lane: 'claude-ai', usd: 5 },
  ],
}

/*
 * Built from the REAL shared implementation rather than hand-written, for two
 * reasons: the card renders `cohorts`, which only that function produces, and a
 * hand-written fixture can encode a shape the code never emits (this one used to
 * — top1 0.6 / top10 1.0 over two people, with people-noun segment labels).
 *
 * 40 teammates, because the card is gated at 30: below that a decile is one or
 * two named individuals, so it deliberately renders nothing.
 */
const concentration: ConcentrationStats = computeConcentration(
  Array.from({ length: 40 }, (_, i) => Math.round((10_000 / (i + 1)) * 100) / 100),
)

const activeTrend: ActiveTrend = {
  window: { from: '2026-07-01', to: '2026-07-31' },
  series: [
    { day: '2026-07-02', claudeCode: 2, copilot: 1 },
    { day: '2026-07-03', claudeCode: 2, copilot: 1 },
  ],
}

const seasonality: Seasonality = {
  window: { from: '2026-07-01', to: '2026-07-31' },
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

const baseProps = {
  drivers,
  modelDrivers,
  concentration,
  trend,
  activeTrend,
  seasonality,
  driversAxis: 'teammate',
  exportParams: { scope: 'regional', report: 'drivers', axis: 'teammate', month: '2026-07' },
  exportFilename: 'tokenscope-regional-drivers-teammate-2026-07.csv',
}

const seen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="regional-data"]').exists(),
})

describe('ScopeRegionalView — the four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: null, pending: true }, global })
    expect(seen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the fetch failed', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: null, pending: false, error: new Error('boom') }, global })
    const s = seen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the period has no genuine/chargeable/active data', () => {
    const report = makeReport({
      kpis: { genuineUsd: 0, chargeableUsd: 0, anthropicChargeableUsd: 0, tokens: 0, activeUsers: 0, chargeMomDeltaPct: null },
      practices: [],
    })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders hero KPIs + provider split + trend + practice rank + models + drivers + concentration + export, and NO seasonality card', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(seen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })

    /*
     * The §A tile carries the §A total and NOTHING from the bill lane. It used to
     * append "≈ $12.00 will be charged (Anthropic; Copilot pending)" — a §B figure
     * on a §A tile that sits directly beside the real Chargeable tile. That went at
     * the whole-company width with prototype fix 2b and is gone here for the same
     * reason: both widths render one component.
     */
    const kpi = w.find('[data-testid="scope-kpi-genuine"]')
    expect(kpi.text()).toContain('Attributed usage')
    expect(kpi.text()).toContain('$50')
    expect(kpi.text()).toContain('every provider, tagged or not')
    expect(kpi.text().toLowerCase()).not.toContain('will be charged')
    expect(kpi.text().toLowerCase()).not.toContain('not an invoice')

    expect(w.find('[data-testid="scope-hero"]').exists()).toBe(true)
    // requirement 1: the canonical §A composition hero + its pinned donut REPLACE
    // the old billed-showback basis; SAME basis as the §A KPI strip above.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-hero-basis"]').text()).toContain('attributed usage · all surfaces · weekly')
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="across-active-trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-trend-card"]').exists()).toBe(true)
    /*
     * "When spend happens" is DELETED, both lenses and both widths (prototype
     * `note('back', …)`: day-of-week seasonality is interesting once, not every
     * week). Asserted as an ABSENCE, like the surface donut before it, so the
     * card cannot creep back in unnoticed.
     */
    expect(w.find('[data-testid="regional-seasonality"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-top-models"]').exists()).toBe(true)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="concentration-cohort-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('requirement 5: every provider clock survives, inside the ONE notes disclosure', () => {
    /*
     * The chips MOVED out of the header stack into a single disclosure (see
     * ReportHeaderNotes) — they were not deleted, and requirement 5 still holds.
     * Containment, not existence: a chip back in the header would pass an
     * `exists()` check and re-create the defect.
     */
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="regional-settling"]').exists()).toBe(true)
    const panel = w.find('[data-testid="report-header-notes-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="notes-settling-anthropic"]').exists()).toBe(true)
    expect(panel.find('[data-testid="notes-settling-usage"]').exists()).toBe(true)
    // ONE affordance, and its trigger states the state without being opened.
    expect(w.findAll('[data-testid="report-header-notes"]')).toHaveLength(1)
    expect(w.find('[data-testid="report-header-notes-trigger"]').text().length).toBeGreaterThan(0)
    // The lens explainer came too; it is no longer printed under the control.
    expect(w.find('[data-testid="lane-caption"]').exists()).toBe(false)
    // Where usage is counted: the current-org lens, stated in the panel.
    expect(panel.find('[data-testid="notes-placement"]').text()).toBe(PLACEMENT_NOTE)
    expect(w.text()).not.toContain('point-in-time')
  })
})

describe('ScopeRegionalView — the Copilot chargeback chip', () => {
  it('shows the "pending" chip in pool-utilisation mode (pre-Wave-0 validation)', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const chip = w.find('[data-testid="scope-copilot-pending"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text().toLowerCase()).toContain('pending')
    expect(w.find('[data-testid="copilot-chargeback-chip"]').exists()).toBe(false)
  })

  it('drops the footer chip once chargeback mode is validated (no empty footer band; the sub conveys inclusion)', () => {
    const report = makeReport({
      copilot: { mode: 'chargeback', pending: false, chargeableUsd: 120 },
      kpis: { genuineUsd: 50, chargeableUsd: 132, anthropicChargeableUsd: 12, tokens: 1000, activeUsers: 2, chargeMomDeltaPct: null },
    })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })
    // No footer chip at all when not pending (parity with the whole-company width — an unconditional footer
    // slot rendered an empty band that inflated the Chargeable tile, finding #5).
    expect(w.find('[data-testid="scope-copilot-pending"]').exists()).toBe(false)
    expect(w.find('[data-testid="copilot-chargeback-chip"]').exists()).toBe(false)
    // Copilot inclusion is still conveyed — via the Chargeable tile's sub, not a chip.
    expect(w.find('[data-testid="scope-kpi-chargeable"]').text().toLowerCase()).toContain(`reaches a ${BU_LABEL_LOWER}`)
  })
})

describe('ScopeRegionalView — region selector + drill', () => {
  it('shows the region selector only when regionOptions are present (cross-region roles)', () => {
    const noSelector = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(noSelector.find('[data-testid="region-scope-selector"]').exists()).toBe(false)

    const withSelector = mount(ScopeRegionalView, {
      props: {
        ...baseProps,
        report: makeReport({
          regionOptions: [
            { id: 'r1', code: 'ra', displayName: 'Region A' },
            { id: 'r2', code: 'rb', displayName: 'Region B' },
          ],
        }),
        pending: false,
      },
      global,
    })
    expect(withSelector.find('[data-testid="region-scope-selector"]').exists()).toBe(true)
  })

  it('renders the breadcrumbed practice drill when `ou` (report.drill) is set', () => {
    const report = makeReport({ drill: { ouId: 'a', code: 'a', displayName: 'Practice A' } })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })

    const crumb = w.find('[data-testid="regional-drill-crumb"]')
    expect(crumb.exists()).toBe(true)
    expect(crumb.text()).toContain('Practice A')

    // Inside a practice, the top-level practice ranking is replaced by the drill's
    // users table — the region-level ranking must NOT also render.
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(false)
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
  })
})

/*
 * ── Concentration: the SAME card as the whole-company width ──────────────────
 *
 * This width used to render the older ConcentrationCard — cohorts labelled
 * "Power users" / "Light users" (the people-nouns the prototype names as the
 * defect) and shares cut with `Math.ceil` where the other width used
 * `Math.round`. Two widths answered one question with different arithmetic under
 * different labels, and nothing could see it.
 */
describe('ScopeRegionalView — the Concentration card', () => {
  it('renders the cohort card, never the retired people-noun one', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const card = w.find('[data-testid="concentration-cohort-card"]')
    expect(card.exists()).toBe(true)
    expect(w.find('[data-testid="concentration-card"]').exists()).toBe(false)
    // Decile labels, not a taxonomy of humans.
    const text = card.text()
    expect(text).toContain('Top 1%')
    expect(text).toContain('Bottom 50%')
    expect(text).not.toContain('Power users')
    expect(text).not.toContain('Light users')
  })

  it('is CUT identically to the whole-company width — one distribution, two widths', () => {
    /*
     * Both widths feed the same `computeConcentration`. The card's headline
     * quotes `top10` and the first two cohorts are cut at the same index, so the
     * rendered sentence and the rendered legend cannot disagree.
     *
     * NOTE the honest asymmetry: the whole-company width ALSO has to agree with
     * its Median-per-person KPI. RegionalHero publishes no median and no
     * percentiles, so at this width the card is the only place the distribution
     * appears — there is nothing here for it to agree WITH. It is cut identically
     * regardless, so the two widths cannot disagree with each other.
     */
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const text = w.find('[data-testid="concentration-headline"]').text()
    // 40 people, top-10% cut = round(40 x 0.1) = 4.
    expect(text).toContain('4 of 40')
    expect(concentration.cohorts![0]!.sharePct + concentration.cohorts![1]!.sharePct).toBeCloseTo(
      concentration.top10,
      12,
    )
  })

  it('renders NOTHING below 30 people — a decile there is a named individual', () => {
    // The card's own MIN_COHORT, which IS the prototype's `if(people>=30)`. Both
    // widths share the one gate; they do not differ.
    const small = computeConcentration([500, 300, 200])
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report: makeReport(), pending: false, concentration: small },
      global,
    })
    expect(w.find('[data-testid="concentration-cohort-card"]').exists()).toBe(false)
  })
})

describe('ScopeRegionalView — the §A/§B lane re-lens', () => {
  it('publishes the coverage denominator beside the §A total, naming THIS region', () => {
    /*
     * The whole point of the qualifier is that it travels with the total. A note
     * rendered on a page the reader never opens qualifies nothing, and one naming
     * a scope other than this node's is a denominator the figures were not summed
     * over (contract C11).
     */
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    const note = w.find('[data-testid="budget-coverage-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Region A')
    // It is a qualifier ON the headline: the denominator it names IS kpis.genuineUsd.
    expect(Number(note.attributes('data-total-usd'))).toBe(makeReport().kpis.genuineUsd)
  })

  it('inside an `ou` drill, it renders the DRILLED unit\'s name — not the region\'s', () => {
    /*
     * The view's half of the drill case, and only that half. resolveRegionalScope
     * clamps every §A figure to the drilled unit's subtree and sets `scopeLabel` to
     * that unit; THAT choice is pinned in tests/integration/reports/
     * usage-budget-coverage.test.ts, which can see the predicate. What is provable
     * here is that a drill's name reaches the note while the region's name is on the
     * same report object and does not.
     */
    const report = makeReport({
      drill: { ouId: 'a', code: 'a', displayName: 'Practice A' },
      budgetCoverage: { ...makeReport().budgetCoverage, scopeLabel: 'Practice A' },
    })
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report, pending: false }, global })
    const note = w.find('[data-testid="budget-coverage-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Practice A')
    expect(note.text()).not.toContain('Region A')
  })

  it('for a SUBTREE-scoped caller it names the org unit, though the page is a region page', () => {
    /*
     * THE REGRESSION THIS FILE MISSED. A manager and a developer both hold `regional:
     * 'own-region'` (shared/auth/report-visibility.ts:99-103) and both are admitted to
     * this endpoint, but resolveRegionalScope maps them to the `app.user_org_path`
     * SUBTREE clause (server/auth/org-subtree-scope.ts) — so the figures on a region
     * page are one org unit's, while `report.region` still names the region and
     * `report.drill` is null.
     *
     * That combination is the whole defect: the hero used to compute `drill ??
     * region`, which resolves to "Region A" here, and rendered "Of the $50.00
     * attributed usage in Region A this period…" above a subtree's total. So the
     * fixture below is deliberately the SHAPE THE SERVER SENDS a manager — region
     * present, drill absent, coverage naming the unit — and the view must follow the
     * coverage, which is the only value that knows what the clamp covered.
     */
    const report = makeReport({
      budgetCoverage: { ...makeReport().budgetCoverage, scopeLabel: 'Platform Engineering' },
    })
    expect(report.region?.displayName).toBe('Region A')
    expect(report.drill).toBeNull()

    const note = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false },
      global,
    }).find('[data-testid="budget-coverage-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('of usage in Platform Engineering is on a project with a budget')
    expect(note.text()).not.toContain('Region A')
    expect(note.text()).not.toContain('this region')
  })

  it('withholds the §A coverage note under a CHARGEBACK headline', () => {
    // Its parts partition the attributed-usage total, not the chargeable one — under
    // a §B headline it would read as qualifying a figure it was never computed from.
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    expect(w.find('[data-testid="budget-coverage-note"]').exists()).toBe(false)
  })

  it('USAGE lane (default): the practice rank + §A analytics render; no usage-only placeholder', () => {
    const w = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-chargeback-rank"]').exists()).toBe(false)
    // The composition hero renders, and carries its OWN totals legend — so the
    // usage lens no longer needs (or draws) a page-level LaneLegend.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-hero-totals-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="usage-only-card"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane: hero re-lenses, practice rank swaps to chargeback-by-cost-centre, §A cards grey/swap', () => {
    // Seed a velocity exception so the "signals suppressed in chargeback" gate is real.
    const report = makeReport({
      exceptions: [{ teammateId: 't1', name: 'Spiker', currentWeekUsd: 100, baselineMeanUsd: 40, deltaPct: 1.5 }],
    })
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    // Hero shows the §B chargeable cost-of-record, on the shared hero's own line.
    expect(w.find('[data-testid="scope-hero-total"]').text()).toBe('$12.00')
    expect(w.find('[data-testid="scope-hero-context"]').text()).toContain('chargeable')

    // The §A practice rank is swapped for the §B chargeback-by-cost-centre ranking.
    expect(w.find('[data-testid="regional-practice-rank"]').exists()).toBe(false)
    const cbRank = w.find('[data-testid="regional-chargeback-rank"]')
    expect(cbRank.exists()).toBe(true)
    expect(cbRank.text()).toContain('Chargeback by Business Unit')

    /*
     * THE TILE ROW DOES NOT RE-LENS, at this width either. It used to swap three
     * tiles for "Billed teammates" / "Billed tokens" / "Avg charge / billed user"
     * — but Tokens and avg-per-user are deleted outright by prototype fix 2b, and
     * the cohort tiles are §A in both lenses ("both matter equally"). Both money
     * figures render in both lenses; only the headline moves.
     */
    expect(w.find('[data-testid="scope-kpi-tokens"]').exists()).toBe(false)
    expect(w.find('[data-testid="scope-kpi-avg"]').exists()).toBe(false)
    expect(w.find('[data-testid="scope-kpi-active"]').text()).toContain('Active people')
    expect(w.find('[data-testid="scope-kpi-row"]').text()).not.toContain('Billed tokens')
    expect(w.find('[data-testid="scope-chargeback-caveat"]').text()).toBe(
      'Active people and Median per person are attributed usage in both lenses.',
    )

    // §A/usage cards RE-LENS to their §B bill-lane analogue (not usage-only
    // placeholders); the billed hero + donut are usage-view elements and yield too.
    expect(w.find('[data-testid="surface-hero-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-donut-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-trend-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="chargeback-split-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-card"]').exists()).toBe(true)
    // Its §B twin went with it — the DoW card WAS the seasonality card re-lensed.
    expect(w.find('[data-testid="chargeback-dow-card"]').exists()).toBe(false)
    /*
     * DRIVERS + TOP MODELS NOW RE-LENS. The old note here read "no model dim in
     * the bill", which the 2026-08-02 wire capture disproves for both providers
     * (Anthropic `data[].model` 255/255; Copilot `totals_by_language_model[]`
     * 756/756) and which mig 0118/0120 land in `provider_usage_fact`. Keeping
     * the placeholder left a chargeback reader with a headline and no
     * breakdown.
     *
     * CONCENTRATION is the one that genuinely cannot follow — a distribution
     * over PEOPLE's consumption, with no equivalent cohort in the billed lane —
     * so the placeholder count is unchanged at one and now covers exactly it.
     */
    expect(w.find('[data-testid="drivers-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-top-models"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="usage-only-card"]').length).toBe(1)
    // Velocity signals (a §A usage signal) are suppressed in chargeback mode.
    expect(w.find('[data-testid="regional-signals"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane renders ONE page-level LaneLegend (union of the cards\' lanes) and lane-mode cards', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report: makeReport(), pending: false, lane: 'chargeback' },
      global,
    })
    /*
     * Still exactly ONE legend, and it now sits INSIDE the period band beside the
     * split card rather than floating above both bands in the page chrome.
     * Moving it must not become duplicating it.
     */
    expect(w.findAll('[data-testid="lane-legend"]')).toHaveLength(1)
    expect(w.find('[data-testid="regional-band-period"] [data-testid="lane-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-claude"]').text()).toContain('Claude Code')
    expect(w.find('[data-testid="lane-legend-claude-ai"]').text()).toContain('Claude Chat')
    // The split card renders the capped+folded lane donut; the trend card the
    // WEEKLY lane stack (iter-2 I2 — the default grain).
    expect(w.find('[data-testid="chargeback-split-donut"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-weekly"]').exists()).toBe(true)
    /*
     * USAGE mode carries NO page legend — SurfaceHeroCard's own totals legend
     * replaced it — and the §B copilot chargeback lanes never leak into that
     * card's key (the two bases stay separated).
     */
    const usage = mount(ScopeRegionalView, { props: { ...baseProps, report: makeReport(), pending: false }, global })
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
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    const badge = w.find('[data-testid="chargeback-split-unclassified"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text().toLowerCase()).toContain('needs mapping')
    // The unclassified lane is not a donut slice → not a legend entry either.
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
    const zeroTrend: RegionalTrendResp = {
      ...trend,
      chargeSeries: [
        { day: '2026-07-02', chargeUsd: 0 },
        { day: '2026-07-03', chargeUsd: 0 },
      ],
      chargeLanes: [],
    }
    const w = mount(ScopeRegionalView, {
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
    expect(w.find('[data-testid="chargeback-trend-card"]').text()).toContain('by surface')
    expect(w.find('[data-testid="chargeback-trend-lane-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="chargeback-trend-lanes"]').exists()).toBe(false)
  })

  it('CHARGEBACK lane + partial-month range, Copilot ON: pooled net WITHHELD — caveat, not a silent $0', () => {
    const report = makeReport({
      // Copilot chargeback validated (NOT pending) but the window is a partial-month range,
      // so the pooled (monthly) net is withheld — a DISTINCT state from pending.
      copilot: { mode: 'chargeback', pending: false, chargeableUsd: null, partialMonthUnavailable: true },
      chargebackProviderSplit: { anthropicUsd: 12, copilotUsd: null, partialMonthUnavailable: true },
    })
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report, pending: false, lane: 'chargeback' },
      global,
    })
    // The hero caveats the partial-month withholding (not the pending copy)...
    expect(w.find('[data-testid="scope-chargeback-partial-month-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="regional-chargeback-pending-note"]').exists()).toBe(false)
    // ...and the Chargeable tile does NOT claim "+ Copilot pooled net" (it is not folded here).
    expect(w.find('[data-testid="scope-kpi-chargeable"]').text().toLowerCase()).not.toContain(
      'copilot pooled net',
    )
    // The ChargebackSplitCard shows the partial-month state (not $0, not "pending validation").
    expect(w.find('[data-testid="chargeback-split-copilot-partial"]').exists()).toBe(true)
    expect(w.find('[data-testid="scope-copilot-pending"]').exists()).toBe(false)
  })
})

/*
 * ── The two bands, at the single-region width ────────────────────────────────
 *
 * The same fix and the same failure mode as the whole-company width: the KPI
 * figures are over the selected period and the trend/behaviour cards over a
 * decoupled rolling one, and until the bands existed nothing on screen said so.
 * Both widths read their strings from band-labels.ts, so what is worth pinning
 * HERE is that this width bands the same way — a region reader must not get the
 * interleaved page back.
 */
describe('ScopeRegionalView — the period band and the rolling band', () => {
  const banded = (over: Record<string, unknown> = {}) =>
    mount(ScopeRegionalView, {
      props: {
        ...baseProps,
        report: makeReport(),
        pending: false,
        trendWindowLabel: 'Last 60 days',
        ...over,
      },
      global,
    })

  /*
   * THE PERIOD BAND HAS NO HEADER, at this width too. It kept one only because the
   * old RegionalHero stated neither the month nor the clamped scope; the shared
   * hero states both, so a header above it was the same window said twice.
   *
   * MUTATION: restore `:window-label="periodWindow" :basis="periodBasis"` on the
   * period ReportBand — the "no header" assertion goes red.
   */
  it('states the period window ONCE — on the hero, not also on a band header above it', () => {
    const w = banded()
    const period = w.find('[data-testid="regional-band-period"]')
    expect(period.find('[data-testid="report-band-window"]').exists()).toBe(false)
    expect(period.find('[data-testid="report-band-basis"]').exists()).toBe(false)
    // …and the month has NOT gone missing: the hero carries it.
    expect(w.find('[data-testid="scope-hero-period"]').text()).toBe('July 2026')
  })

  it('names the rolling window and says it does not sum into the month', () => {
    const w = banded()
    expect(w.find('[data-testid="regional-band-rolling"] [data-testid="report-band-window"]').text()).toBe(
      'Last 60 days',
    )
    expect(w.find('[data-testid="regional-band-rolling"] [data-testid="report-band-note"]').text()).toBe(
      'does not sum into July',
    )
  })

  it('names the SUBTREE the server clamped to, never the region above it (C11)', () => {
    /*
     * The scope word moved from the band header ONTO the hero line with the header
     * itself, and the contract did not move with it: a manager and a region admin
     * both hold `regional: 'own-region'`, but the manager's §A clamp is their org
     * SUBTREE. The hero reads the same server-set `budgetCoverage.scopeLabel` the
     * band did, never `report.region.displayName` beside it.
     *
     * MUTATION: point ScopeHero's `scopeLabel` at `report.region.displayName` —
     * this goes red with "Region A".
     */
    const report = makeReport({
      budgetCoverage: { ...makeReport().budgetCoverage, scopeLabel: 'Platform Engineering' },
    })
    const context = banded({ report }).find('[data-testid="scope-hero-context"]').text()
    expect(context).toContain('Platform Engineering')
    expect(context).not.toContain('Region A')
  })

  it('puts the rolling cards in the rolling band and the period cards in the period one', () => {
    const w = banded()
    const rolling = w.find('[data-testid="regional-band-rolling"]')
    for (const id of [
      'surface-hero-card',
      'across-active-trend-card',
      'regional-trend-card',
      'spend-per-developer-card',
      'tier-exposure-card',
    ]) {
      expect(rolling.find(`[data-testid="${id}"]`).exists(), `${id} belongs to the rolling band`).toBe(true)
    }
    const period = w.find('[data-testid="regional-band-period"]')
    expect(period.find('[data-testid="scope-hero"]').exists()).toBe(true)
    expect(period.find('[data-testid="regional-practice-rank"]').exists()).toBe(true)
    expect(rolling.find('[data-testid="scope-hero"]').exists()).toBe(false)
  })

  it('does not print a "does not sum" note when NO rolling window was supplied', () => {
    /*
     * `trendWindowLabel` is optional, and without it both headers carry the
     * period's own label. A caveat between two identical headers contradicts what
     * the reader can see.
     */
    const w = mount(ScopeRegionalView, {
      props: { ...baseProps, report: makeReport(), pending: false },
      global,
    })
    expect(w.find('[data-testid="regional-band-rolling"] [data-testid="report-band-note"]').text()).toBe(
      'same window as the band above',
    )
  })
})
