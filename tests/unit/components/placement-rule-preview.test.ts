// @vitest-environment happy-dom
/*
 * PlacementRulePreview: posts the draft rule, lists who would derive a
 * different placement (from → to), states evidence age and the unchecked
 * count, and drops a result once the draft changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PlacementRulePreview from '../../../app/components/admin/PlacementRulePreview.vue'
import type { PlacementRulePreviewRequest, PlacementRulePreviewResponse } from '../../../shared/placement/placement-check'

const APAC = '9a1e0000-0000-4000-8000-0000000000a1'
const EMEA = '9a1e0000-0000-4000-8000-0000000000e1'
const T1 = '9a1e0000-0000-4000-8000-000000000001'

const DRAFT: PlacementRulePreviewRequest = { attribute: 'companyName', match_mode: 'exact', match_value: 'Acme UK', region_id: EMEA }

const RESPONSE: PlacementRulePreviewResponse = {
  evidenceAge: { oldest: '2026-10-20T00:00:00Z', newest: '2026-10-21T00:00:00Z' },
  unchecked: 4,
  changes: [
    {
      teammateId: T1,
      name: 'Ann',
      email: 'ann@example.com',
      from: { regionId: APAC, regionName: 'APAC', orgUnitId: null, orgUnitName: null, onHolding: false },
      to: { regionId: EMEA, regionName: 'EMEA', orgUnitId: null, orgUnitName: null, onHolding: false },
    },
  ],
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('$fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('PlacementRulePreview', () => {
  it('is disabled with no draft', () => {
    const w = mount(PlacementRulePreview, { props: { draft: null } })
    expect(w.find('[data-testid="rule-preview-run"]').attributes('disabled')).toBeDefined()
  })

  it('posts the draft and lists each change with evidence age and the unchecked count', async () => {
    fetchMock.mockResolvedValue(RESPONSE)
    const w = mount(PlacementRulePreview, { props: { draft: DRAFT } })
    await w.find('[data-testid="rule-preview-run"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/placement-check/preview', { method: 'POST', body: DRAFT })
    expect(w.find('[data-testid="rule-preview-summary"]').text()).toContain('1 person would derive a different placement')
    const change = w.find(`[data-testid="rule-preview-change-${T1}"]`).text()
    expect(change).toContain('Ann')
    expect(change).toMatch(/APAC · no Business Unit\s*→\s*EMEA · no Business Unit/)
    const age = w.find('[data-testid="rule-preview-age"]').text()
    expect(age).toContain('Based on directory records read between')
    expect(age).toContain('4 teammates are not checked yet or the directory lookup failed')
  })

  it('says so when nothing changes', async () => {
    fetchMock.mockResolvedValue({ ...RESPONSE, unchecked: 0, changes: [] })
    const w = mount(PlacementRulePreview, { props: { draft: DRAFT } })
    await w.find('[data-testid="rule-preview-run"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="rule-preview-summary"]').text()).toContain("nobody's derived placement changes")
    expect(w.find('[data-testid="rule-preview-changes"]').exists()).toBe(false)
  })

  it('drops the result when the draft changes', async () => {
    fetchMock.mockResolvedValue(RESPONSE)
    const w = mount(PlacementRulePreview, { props: { draft: DRAFT } })
    await w.find('[data-testid="rule-preview-run"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="rule-preview-result"]').exists()).toBe(true)
    await w.setProps({ draft: { ...DRAFT, match_value: 'Acme FR' } })
    expect(w.find('[data-testid="rule-preview-result"]').exists()).toBe(false)
  })
})
