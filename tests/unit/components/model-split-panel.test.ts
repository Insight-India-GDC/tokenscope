// @vitest-environment happy-dom
/*
 * ModelSplitPanel — the Top-models body after the model-axis subtraction
 * (docs/design/reporting-consolidation/07-model-axis-subtraction-build.md D6).
 *
 * The card RANKS MODELS ONLY. A NULL-model row is a reason-typed REMAINDER and
 * renders as the one-line coverage footer — never as a category row, never as
 * a group band, never as a bar. This file pins:
 *
 *   - no remainder ever reaches the ranked chart (the pre-existing rule);
 *   - the group bands and their testids are GONE (design D6 "dead after
 *     this"), including on a remainder-heavy response;
 *   - the footer prices the named models against the panel's own denominator
 *     and segments the remainder by reason — Copilot day-grain wording,
 *     awaiting-detail (revision drift FOLDED in), generic for everything else
 *     including an UNKNOWN reason (default-safe, design test 20);
 *   - design test 21: a remainder-ONLY response renders ZERO category rows and
 *     a footer — on the across mount, the regional mount, and the billed lane;
 *   - design test 14 (unit half): a response CONTAINING remainder rows renders
 *     no category rows, footer present;
 *   - the billed lane note and the empty states survive unchanged.
 *
 * MUTATIONS — each assertion below was run with its fix reverted:
 *   - route remainders back into `knownBars`: the "never a bar" tests go red.
 *   - render the old group sections again: the zero-category tests go red.
 *   - treat an unknown reason as its own segment/category: the default-safe
 *     test goes red.
 *   - divide the footer share by Σ(known) instead of `denominatorUsd`: the
 *     own-denominator test goes red (it reads 100%, not 60%).
 *   - drop the `isBilled` branch from the lane note: the lane-note tests go
 *     red in one direction or the other.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelSplitPanel from '../../../app/components/reporting/ModelSplitPanel.vue'
import TopModelsCard from '../../../app/components/reporting/across/TopModelsCard.vue'
import RegionalTopModels from '../../../app/components/reporting/regional/RegionalTopModels.vue'
import {
  BILLED_NO_MODEL_KEY,
  BILLED_NO_MODEL_LABEL,
  MODEL_GAP_REASON_LABELS,
  UNATTRIBUTED_MODEL_KEY,
  modelBucketNote,
  modelDriverKey,
} from '../../../shared/reports/model-attribution'
import type { BilledLaneMeta, DriverRow } from '../../../shared/reports/types'

/*
 * ChartRankedBar is stubbed, and the stub is what makes "is it a bar?" testable:
 * the rows it is HANDED are the ranking. A remainder that never reaches this
 * prop cannot appear in the chart however the chart is later restyled.
 */
const RankedStub = {
  name: 'ChartRankedBar',
  props: ['rows', 'topN', 'valueFormat'],
  template: '<div data-testid="ranked-stub">{{ rows.map(r => r.label).join("|") }}</div>',
}

function row(over: Partial<DriverRow> = {}): DriverRow {
  return { key: 'claude-opus-5', label: 'claude-opus-5', usd: 60, sharePct: 0.6, spendClass: 'billed', ...over }
}

/** A reason-typed remainder row, keyed/labelled the way the server does it. */
function remainder(
  reason: string,
  usd: number,
  provenance: 'api-reconciled' | 'provider-usage' = 'api-reconciled',
): DriverRow {
  return row({
    key: modelDriverKey(null, provenance, reason),
    label: MODEL_GAP_REASON_LABELS[reason as keyof typeof MODEL_GAP_REASON_LABELS] ?? 'Not split by model',
    usd,
    sharePct: 0,
    gap_reason: reason,
  })
}

function billedLane(over: Partial<BilledLaneMeta> = {}): BilledLaneMeta {
  return { availability: 'present', billedUsd: 100, consumptionUsd: 0, arms: [], ...over }
}

const mountPanel = (props: Record<string, unknown> = {}) =>
  mount(ModelSplitPanel, {
    props: { rows: [row()], denominatorUsd: 100, lane: 'billed', ...props },
    global: { stubs: { ChartRankedBar: RankedStub } },
  })

type AnyWrapper = ReturnType<typeof mountPanel>

/** The labels handed to the ranked chart, in order. */
const rankedLabels = (w: AnyWrapper): string[] => {
  const stub = w.findComponent(RankedStub)
  return stub.exists() ? (stub.props('rows') as { label: string }[]).map((r) => r.label) : []
}

/** No category row, group band or badge exists anywhere in the wrapper. */
const expectZeroCategoryRows = (w: AnyWrapper) => {
  expect(w.find('[data-testid="model-split-structural"]').exists()).toBe(false)
  expect(w.find('[data-testid="model-split-not-carried"]').exists()).toBe(false)
  expect(w.find('[data-testid="model-split-flag"]').exists()).toBe(false)
  expect(w.html()).not.toContain('model-split-row-')
}

describe('a remainder is never a bar in the ranking', () => {
  it('keeps the biggest remainder out of the chart entirely — and off the card as a row', () => {
    // The exact Dev shape: the non-model money is the LARGEST amount.
    const w = mountPanel({
      rows: [
        row({ key: BILLED_NO_MODEL_KEY, label: BILLED_NO_MODEL_LABEL, usd: 900, sharePct: 0.9 }),
        row({ key: 'claude-opus-5', label: 'claude-opus-5', usd: 60, sharePct: 0.06 }),
        row({ key: 'claude-sonnet-5', label: 'claude-sonnet-5', usd: 40, sharePct: 0.04 }),
      ],
      denominatorUsd: 1000,
    })
    expect(rankedLabels(w)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(rankedLabels(w)).not.toContain(BILLED_NO_MODEL_LABEL)
    // Not dropped from the page: the money is priced in the FOOTER now.
    expect(w.find('[data-testid="model-split-footer"]').text()).toContain('900')
    expectZeroCategoryRows(w)
  })

  it('does the same for every reason-typed remainder', () => {
    const w = mountPanel({
      rows: [
        remainder('provider-day-grain', 500),
        remainder('surface-remainder', 300, 'provider-usage'),
        row({ usd: 200, sharePct: 0.2 }),
      ],
      denominatorUsd: 1000,
      lane: 'attributed',
    })
    expect(rankedLabels(w)).toEqual(['claude-opus-5'])
    expectZeroCategoryRows(w)
  })
})

describe('the coverage footer (D6) prices the named models and each remainder reason', () => {
  it('divides the named total by the panel’s OWN denominator, not by Σ(known)', () => {
    const w = mountPanel({
      rows: [row({ usd: 60, sharePct: 0.6 }), remainder('unmodelled-provider-cost', 40)],
      denominatorUsd: 100,
      lane: 'attributed',
    })
    const named = w.find('[data-testid="model-split-footer-named"]').text().replace(/\s+/g, ' ')
    expect(named).toContain('Models named for $60.00')
    expect(named).toContain('60%') // 60/100 — Σ(known) alone would read 100%
    expect(named).toContain('of attributed spend')
  })

  it('segments day-grain Copilot money with its own wording and tooltip', () => {
    const w = mountPanel({
      rows: [row({ usd: 60 }), remainder('provider-day-grain', 30)],
      denominatorUsd: 90,
      lane: 'attributed',
    })
    const seg = w.find('[data-testid="model-split-footer-day-grain"]')
    expect(seg.exists()).toBe(true)
    expect(seg.text().replace(/\s+/g, ' ')).toContain(
      '$30.00 Copilot money is day-grain (provider reports no per-model dollars)',
    )
    // Tooltip carries the full sentence from modelBucketNote (D6).
    expect(seg.attributes('title')).toBe(
      modelBucketNote(modelDriverKey(null, 'api-reconciled', 'provider-day-grain')),
    )
  })

  it('FOLDS provider-revision-drift into the awaiting-detail segment', () => {
    const w = mountPanel({
      rows: [
        row({ usd: 50 }),
        remainder('awaiting-provider-detail', 20),
        remainder('provider-revision-drift', 10, 'provider-usage'),
      ],
      denominatorUsd: 80,
      lane: 'attributed',
    })
    const seg = w.find('[data-testid="model-split-footer-awaiting"]')
    expect(seg.text().replace(/\s+/g, ' ')).toContain('$30.00 awaiting provider detail')
    // ONE segment for both transient reasons — no drift segment of its own.
    expect(w.text()).not.toContain('revision')
  })

  it('an UNKNOWN reason folds into the generic remainder segment — never its own category (test 20)', () => {
    const w = mountPanel({
      rows: [
        row({ usd: 60 }),
        row({
          key: `${UNATTRIBUTED_MODEL_KEY}:reason-from-the-future`,
          label: 'Not split by model',
          usd: 25,
          gap_reason: 'reason-from-the-future',
        }),
        remainder('surface-remainder', 15, 'provider-usage'),
      ],
      denominatorUsd: 100,
      lane: 'attributed',
    })
    // 25 (unknown) + 15 (surface-remainder) fold into ONE generic segment.
    expect(w.find('[data-testid="model-split-footer-remainder"]').text().replace(/\s+/g, ' ')).toContain(
      '$40.00 not split by model',
    )
    expectZeroCategoryRows(w)
  })

  it('renders NO remainder segments when every dollar is named', () => {
    const w = mountPanel({ rows: [row({ usd: 100, sharePct: 1 })], denominatorUsd: 100, lane: 'attributed' })
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(true)
    expect(w.find('[data-testid="model-split-footer-day-grain"]').exists()).toBe(false)
    expect(w.find('[data-testid="model-split-footer-awaiting"]').exists()).toBe(false)
    expect(w.find('[data-testid="model-split-footer-remainder"]').exists()).toBe(false)
  })

  it('a response containing remainder rows renders ZERO category rows, footer present (test 14)', () => {
    const w = mountPanel({
      rows: [
        row({ usd: 60 }),
        remainder('provider-day-grain', 30),
        remainder('surface-remainder', 10, 'provider-usage'),
      ],
      denominatorUsd: 100,
      lane: 'attributed',
    })
    expectZeroCategoryRows(w)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(true)
  })
})

describe('a remainder-ONLY response: zero category rows + footer, both widths and the billed lane (test 21)', () => {
  const remainderOnly = [remainder('provider-day-grain', 70), remainder('awaiting-provider-detail', 30)]

  it('panel, attributed lane', () => {
    const w = mountPanel({ rows: remainderOnly, denominatorUsd: 100, lane: 'attributed' })
    expect(rankedLabels(w)).toEqual([])
    expectZeroCategoryRows(w)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(true)
    expect(w.find('[data-testid="model-split-footer-day-grain"]').text()).toContain('$70.00')
    expect(w.find('[data-testid="model-split-footer-awaiting"]').text()).toContain('$30.00')
    // The empty-ranking copy points at the coverage line rather than at groups.
    expect(w.find('[data-testid="model-split-empty"]').text()).toContain('coverage line')
  })

  it('the ACROSS mount (TopModelsCard)', () => {
    const w = mount(TopModelsCard, {
      props: {
        models: {
          axis: 'model',
          headlineUsd: 100,
          rows: remainderOnly,
          concentration: { top1Pct: 0, top5Pct: 0, top10Pct: 0, avgUsd: 0, medianUsd: 0, people: 0 },
          measureLanes: { rows: 'attributed' },
        },
      },
      global: { stubs: { ChartRankedBar: RankedStub } },
    } as never) as unknown as AnyWrapper
    expect(rankedLabels(w)).toEqual([])
    expectZeroCategoryRows(w)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(true)
  })

  it('the REGIONAL mount (RegionalTopModels)', () => {
    const w = mount(RegionalTopModels, {
      props: { rows: remainderOnly, headlineUsd: 100, lane: 'attributed' },
      global: { stubs: { ChartRankedBar: RankedStub } },
    } as never) as unknown as AnyWrapper
    expect(rankedLabels(w)).toEqual([])
    expectZeroCategoryRows(w)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(true)
  })

  it('the BILLED lane (BILLED_NO_MODEL row → footer, generic wording)', () => {
    const w = mountPanel({
      rows: [row({ key: BILLED_NO_MODEL_KEY, label: BILLED_NO_MODEL_LABEL, usd: 100, sharePct: 1 })],
      denominatorUsd: 100,
      lane: 'billed',
    })
    expect(rankedLabels(w)).toEqual([])
    expectZeroCategoryRows(w)
    const footer = w.find('[data-testid="model-split-footer"]')
    expect(footer.exists()).toBe(true)
    expect(footer.text().replace(/\s+/g, ' ')).toContain('$100.00 not split by model')
    expect(footer.text()).toContain('of billed spend')
    // Tooltip: the billed no-model sentence still fits through modelBucketNote.
    expect(w.find('[data-testid="model-split-footer-remainder"]').attributes('title')).toBe(
      modelBucketNote(BILLED_NO_MODEL_KEY)!,
    )
  })
})

describe('the lane note names the billed denominator on the billed lane, and only there', () => {
  it('says so in the billed lane, in ONE line', () => {
    const note = mountPanel({ lane: 'billed', denominatorUsd: 1234.5 })
      .find('[data-testid="model-split-lane-note"]')
      .text()
    expect(note.replace(/\s+/g, ' ').trim()).toBe(
      "Total billed $1,234.50 — the provider's bill, so it need not match the attributed headline above.",
    )
  })

  it('renders NO lane note at all in the attributed lane', () => {
    const w = mountPanel({ lane: 'attributed' })
    expect(w.find('[data-testid="model-split-lane-note"]').exists()).toBe(false)
    expect(w.text()).not.toContain("this card's own denominator")
    expect(w.text()).not.toContain('switch to')
  })
})

describe('an empty panel says WHY it is empty', () => {
  it('distinguishes "not derived yet" from "no spend" — and shows NO footer for a zero', () => {
    const w = mountPanel({
      rows: [],
      denominatorUsd: 0,
      billedLane: billedLane({ availability: 'no-data-yet' }),
    })
    expect(w.find('[data-testid="model-split-empty"]').text()).toContain(
      'No billed model breakdown derived for this period yet',
    )
    // No "Σ billed $0.00" and no "Models named for $0.00" under it — both would
    // read as measured zeros, the exact reading the sentence above denies.
    expect(w.find('[data-testid="model-split-lane-note"]').exists()).toBe(false)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(false)
  })

  it('renders a loading state, never an empty ranking, while rows are null', () => {
    const w = mountPanel({ rows: null })
    expect(w.text()).toContain('Loading models')
    expect(w.find('[data-testid="model-split-empty"]').exists()).toBe(false)
    expect(w.find('[data-testid="model-split-footer"]').exists()).toBe(false)
    expect(w.find('[data-testid="model-split-lane-note"]').exists()).toBe(false)
  })
})
