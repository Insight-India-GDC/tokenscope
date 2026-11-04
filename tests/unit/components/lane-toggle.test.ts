// @vitest-environment happy-dom
/*
 * LaneToggle — ONE lens control with two owners (ADR 0012).
 *
 * The reporting scopes bind nothing and let it self-wire to useReportState (the
 * sole owner of the reporting `?lane=`). The personal surfaces bind `v-model`,
 * because useReportState writes the whole reporting query and would stamp
 * `scope=region` onto a dashboard URL.
 *
 * Both paths are pinned here because a control that silently keeps writing to
 * the report URL while a page thinks it owns the value is a toggle that appears
 * to do nothing — and because growing a SECOND toggle component for the
 * personal pages is the duplication this shape exists to avoid.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import LaneToggle from '../../../app/components/reporting/LaneToggle.vue'
import { PERSONAL_LENS_COPY } from '../../../shared/usage/lens'

/** The lane useReportState would own, so the uncontrolled path can be observed. */
function stubReportState(initial: 'usage' | 'chargeback' = 'usage') {
  const lane = ref(initial)
  vi.stubGlobal('useReportState', () => ({ lane }))
  return lane
}

afterEach(() => vi.unstubAllGlobals())

describe('LaneToggle — uncontrolled (the reporting scopes)', () => {
  it('reflects and writes the report URL lane', async () => {
    const lane = stubReportState('usage')
    const w = mount(LaneToggle)
    expect(w.find('[data-testid="lane-usage"]').attributes('aria-pressed')).toBe('true')
    await w.find('[data-testid="lane-chargeback"]').trigger('click')
    expect(lane.value).toBe('chargeback')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('shows the reporting-area caption by default', () => {
    stubReportState()
    const w = mount(LaneToggle)
    expect(w.find('[data-testid="lane-caption"]').text()).toContain('Provider usage truth')
  })
})

describe('LaneToggle — controlled (the personal surfaces)', () => {
  it('reflects the bound value, not the report URL', () => {
    stubReportState('usage')
    const w = mount(LaneToggle, { props: { modelValue: 'chargeback' } })
    expect(w.find('[data-testid="lane-chargeback"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="lane-usage"]').attributes('aria-pressed')).toBe('false')
  })

  it('emits instead of writing the report URL — the page owns the value', async () => {
    /*
     * If the control wrote through to useReportState here, flipping the lens on
     * the dashboard would mutate the reporting query and leave the page's own
     * lane untouched: a toggle that visibly does nothing.
     */
    const lane = stubReportState('usage')
    const w = mount(LaneToggle, { props: { modelValue: 'usage' } })
    await w.find('[data-testid="lane-chargeback"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['chargeback']])
    expect(lane.value).toBe('usage')
  })

  it('renders the caption it is given — the surfaces answer `usage` from different sources', async () => {
    stubReportState()
    const captions = {
      usage: PERSONAL_LENS_COPY.usage.caption,
      chargeback: PERSONAL_LENS_COPY.chargeback.caption,
    }
    const w = mount(LaneToggle, { props: { modelValue: 'usage', captions } })
    expect(w.find('[data-testid="lane-caption"]').text()).toContain('Every token you spent')
    expect(w.find('[data-testid="lane-caption"]').text()).not.toContain('Provider usage truth')
    await w.setProps({ modelValue: 'chargeback' })
    expect(w.find('[data-testid="lane-caption"]').text()).toContain(
      'Copilot is billed pooled per Business Unit',
    )
  })
})

describe('the chargeback caption says which part of "cost-of-record" it cannot deliver', () => {
  it('names the pooled grain AND the breakdowns it makes single-provider', () => {
    /*
     * "Copilot pooled per cost-centre (pending validation)" named the pooling and
     * stopped there, leaving a reader to infer that every breakdown under this
     * lens was still both providers. It is not: Copilot raises ONE pooled invoice
     * per cost centre, so the per-teammate and per-model rankings carry
     * Anthropic's charge alone — which is exactly what the labels above them now
     * have to say, and the caption is where a reader is told why.
     */
    stubReportState('chargeback')
    const caption = mount(LaneToggle).find('[data-testid="lane-caption"]').text()
    expect(caption).toContain('pooled invoice per Business Unit')
    expect(caption).toMatch(/per-person and per-model breakdowns are Anthropic/i)
  })
})
