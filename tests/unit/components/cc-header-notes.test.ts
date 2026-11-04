// @vitest-environment happy-dom
/*
 * CcHeaderNotes — the Cost-centres top layer's caveat collapse (D8b, slice S5;
 * design test 24 / r1-M5).
 *
 * The header used to stack THREE per-provider "chip + text" settlement pairs,
 * the coverage sentence, the placement note, the lane explainer under the
 * toggle and an italic axis paragraph. D8b collapses that to ONE settlement
 * chip (least-settled across providers, popover carrying each provider's own
 * clock) plus a compact coverage chip (sentence in its tooltip). Prose/layout
 * ONLY — the information is relocated, never reworded; the axis paragraph
 * alone is deleted (rationale is not UI copy).
 *
 * MUTATIONS these pin:
 *  - aggregate rule → "first provider's state": the mixed-state test goes red
 *    (the fixture's FIRST provider is 'settling'; the chip must read the
 *    second's 'Estimated').
 *  - all-settled → any third word on the chip: the no-chip test goes red.
 *  - any removed prose creeping back into the top layer: the absence tests go red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import CcHeaderNotes from '../../../app/components/reporting/cost-centre/CcHeaderNotes.vue'
import ScopeCostCentreView from '../../../app/components/reporting/ScopeCostCentreView.vue'
import { PLACEMENT_NOTE } from '../../../app/components/reporting/lane-captions'
import type { CostCentreReport } from '../../../app/components/reporting/cost-centre/cost-centre-view-types'
import type { ProviderState, ReportCoverageMeta } from '#shared/reports/types'

const COVERAGE_UNKNOWN_SENTENCE =
  'a GitHub enterprise census is unavailable or capped — no denominator claimed'

function provider(
  vendor: string,
  state: ProviderState['state'],
  settlesAt?: string,
): ProviderState {
  return { vendor: vendor as ProviderState['vendor'], state, settlesAt, closeRun: false }
}

const coverageUnknown: ReportCoverageMeta = {
  applicable: true,
  denominator: null,
  connected: 2,
  nonConnected: 0,
  stale: false,
}

/*
 * ORDER IS LOAD-BEARING: the FIRST provider is 'settling' and the SECOND is
 * 'estimated', so an aggregate that reads the first provider's state (the
 * mutation) or the majority prints 'Settling' — only the least-settled rule
 * prints 'Estimated'.
 */
const mixedStates: ProviderState[] = [
  provider('anthropic', 'settling', '2026-08-30'),
  provider('usage', 'estimated'),
]

const allSettled: ProviderState[] = [
  provider('anthropic', 'settled', '2026-06-30'),
  provider('github', 'settled', '2026-07-04'),
  provider('usage', 'settled', '2026-07-04'),
]

describe('CcHeaderNotes — design test 24: the least-settled aggregate (r1-M5)', () => {
  it('providers in DIFFERENT states → ONE chip, on the least-settled state', () => {
    const w = mount(CcHeaderNotes, { props: { providerStates: mixedStates } })
    const triggers = w.findAll('[data-testid="cc-header-notes-trigger"]')
    expect(triggers).toHaveLength(1)
    // Any 'estimated' → 'Estimated' — NOT the first provider's 'Settling'.
    expect(triggers[0]!.text()).toBe('Estimated')
  })

  it('the popover lists each provider\'s OWN clock, exactly as the three chips rendered it', () => {
    const w = mount(CcHeaderNotes, { props: { providerStates: mixedStates } })
    const panel = w.find('[data-testid="cc-header-notes-panel"]')
    expect(panel.exists()).toBe(true)
    // Provider name + its own state + its own descriptor — nothing averaged.
    const anthropic = panel.find('[data-testid="cc-notes-settling-anthropic"]')
    expect(anthropic.exists()).toBe(true)
    expect(anthropic.text()).toContain('Anthropic')
    expect(anthropic.text()).toContain('Settling')
    expect(anthropic.text()).toContain('provisional until 2026-08-30')
    const usage = panel.find('[data-testid="cc-notes-settling-usage"]')
    expect(usage.exists()).toBe(true)
    expect(usage.text()).toContain('Usage')
    expect(usage.text()).toContain('Estimated')
    expect(usage.text()).toContain('month in progress')
  })

  it("'settling' beside 'settled' → the chip reads Settling (the ladder, not a binary)", () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: [provider('anthropic', 'settled'), provider('usage', 'settling', '2026-09-04')] },
    })
    expect(w.find('[data-testid="cc-header-notes-trigger"]').text()).toBe('Settling')
  })

  it('ALL settled → no settlement chip at all', () => {
    const w = mount(CcHeaderNotes, { props: { providerStates: allSettled } })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-header-notes-trigger"]').exists()).toBe(false)
  })

  it('no provider states at all → no settlement chip', () => {
    const w = mount(CcHeaderNotes, { props: { providerStates: [] } })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
  })
})

describe('CcHeaderNotes — the coverage caveat stays its own compact chip (D8b)', () => {
  it('renders the pill with the sentence in its TOOLTIP, never inline', () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: mixedStates, coverage: coverageUnknown },
    })
    const marker = w.find('[data-testid="coverage-marker"]')
    expect(marker.exists()).toBe(true)
    expect(marker.text()).toContain('Coverage unknown')
    expect(marker.attributes('title')).toBe(COVERAGE_UNKNOWN_SENTENCE)
    // The sentence lives in the sr-only node (a11y) — once, never visibly.
    expect(w.find('[data-testid="coverage-marker-sr"]').text()).toBe(COVERAGE_UNKNOWN_SENTENCE)
    expect(w.text().split(COVERAGE_UNKNOWN_SENTENCE).length - 1).toBe(1)
  })

  it('renders INDEPENDENTLY of the settlement chip — all settled cannot hide an unclaimed denominator', () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: allSettled, coverage: coverageUnknown },
    })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
    expect(w.find('[data-testid="coverage-marker"]').text()).toContain('Coverage unknown')
  })
})

/*
 * ── The VIEW wiring: the top layer stops explaining itself ───────────────────
 *
 * Mounted through ScopeCostCentreView so a chip escaping back into the header —
 * or a piece the view forgot to pass — cannot pass on the component alone. The
 * REAL LaneToggle mounts here (useReportState stubbed) so "no caption under the
 * control" is asserted against the control, not against a stub.
 */
const meta = {
  month: '2026-07',
  monthFloor: '2026-01',
  asOfDate: '2026-07-10',
  providerStates: mixedStates,
  coverage: coverageUnknown,
  scope: 'cost-centre' as const,
}

function makeReport(): CostCentreReport {
  return {
    meta,
    laneNote:
      'Business Unit burn is usage on the projects each Business Unit leads. Pooled Copilot usage with no Business Unit is excluded here and shown in the finance drill.',
    cards: [
      { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', burnUsd: 120, chargeUsd: 90, allocationUsd: 100, utilisation: 1.2, exhaustionDate: null, forecast: null, asOfDate: '2026-07-10' },
      { id: 'b', code: 'b', displayName: 'Practice B', regionCode: 'rb', burnUsd: 85, chargeUsd: 60, allocationUsd: 100, utilisation: 0.85, exhaustionDate: null, forecast: null, asOfDate: '2026-07-10' },
    ],
    summary: {
      totalBurnUsd: 205,
      totalAllocationUsd: 200,
      countOverBudget: 1,
      countNearBudget: 1,
      countOnTrack: 0,
      countNotStarted: 0,
      countNoAllocation: 0,
      asOfDate: '2026-07-10',
    },
  }
}

const global = {
  stubs: {
    DateRangeControl: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
  },
}

const baseProps = {
  report: makeReport(),
  drill: null,
  isDrill: false,
  pending: false,
  drillPending: false,
  exportParams: {},
  exportFilename: 'x.csv',
  budgetsExportParams: {},
  budgetsExportFilename: 'x.csv',
  peopleExportParams: {},
  peopleExportFilename: 'x.csv',
}

function mountView() {
  vi.stubGlobal('useReportState', () => ({ lane: ref('usage') }))
  return mount(ScopeCostCentreView, { global, props: baseProps })
}

afterEach(() => vi.unstubAllGlobals())

describe('ScopeCostCentreView — the top layer carries the collapse (D8b wiring)', () => {
  it('ONE least-settled settlement chip; the old three chip+text pairs are gone from the header', () => {
    const w = mountView()
    expect(w.find('[data-testid="cc-header-notes-trigger"]').text()).toBe('Estimated')
    // The old per-provider header chips no longer exist…
    expect(w.find('[data-testid="cc-settling-anthropic"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-settling-usage"]').exists()).toBe(false)
    // …and EVERY per-provider chip in the DOM lives inside the popover panel.
    const all = w.findAll('[data-testid^="cc-notes-settling-"]')
    const inPanel = w.find('[data-testid="cc-header-notes-panel"]').findAll('[data-testid^="cc-notes-settling-"]')
    expect(all).toHaveLength(2)
    expect(inPanel).toHaveLength(all.length)
  })

  it('all providers settled → the view shows NO settlement chip', () => {
    vi.stubGlobal('useReportState', () => ({ lane: ref('usage') }))
    const report = { ...makeReport(), meta: { ...meta, providerStates: allSettled } }
    const w = mount(ScopeCostCentreView, { global, props: { ...baseProps, report } })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
  })

  it('the removed prose no longer renders; the tooltip-preserved prose rides the popover', () => {
    const w = mountView()
    const text = w.text()

    // DELETED — the axis paragraph. Rationale is not UI copy.
    expect(w.find('[data-testid="cc-lane-note"]').exists()).toBe(false)
    expect(text).not.toContain('Business Unit burn is usage on the projects each Business Unit leads')
    expect(text).not.toContain('shown in the finance drill')

    // TOOLTIP + A11Y — the coverage sentence: `title` for pointer users, an
    // sr-only node for the accessibility tree (`title` alone never reaches
    // screen readers or touch — PR #235 Copilot review), never VISIBLE text.
    expect(w.find('[data-testid="coverage-marker"]').attributes('title')).toBe(COVERAGE_UNKNOWN_SENTENCE)
    const srNode = w.find('[data-testid="coverage-marker-sr"]')
    expect(srNode.classes()).toContain('sr-only')
    expect(srNode.text()).toBe(COVERAGE_UNKNOWN_SENTENCE)
    // Exactly one occurrence in the DOM text — the sr-only one. Zero visible.
    expect(text.split(COVERAGE_UNKNOWN_SENTENCE).length - 1).toBe(1)

    // POPOVER-PRESERVED — the placement note appears exactly once, in the panel.
    const panel = w.find('[data-testid="cc-header-notes-panel"]')
    expect(panel.find('[data-testid="cc-notes-placement"]').text()).toBe(PLACEMENT_NOTE)
    expect(text.split(PLACEMENT_NOTE)).toHaveLength(2)
    // The retired point-in-time claim is gone (current-org lens).
    expect(text).not.toContain('point-in-time')

    // POPOVER-PRESERVED — the lane explainer left the control (the REAL LaneToggle
    // renders here, captionless) and appears exactly once, in the panel.
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-caption"]').exists()).toBe(false)
    expect(panel.find('[data-testid="cc-notes-lane-caption"]').text()).toContain('Provider usage truth')
    expect(text.split('Provider usage truth')).toHaveLength(2)
  })
})
