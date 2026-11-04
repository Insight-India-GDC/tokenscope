// @vitest-environment happy-dom
/*
 * AdminGovernanceDialsSection — render + save contract for the governance
 * dials editor (S4).
 *
 * Persona contract under test:
 *  - region admin: no scope picker; sees platform value + own-region override
 *    + effective (override wins); Save PUTs region scope for their region.
 *  - org-wide (platform-admin): scope picker; platform scope
 *    PUTs without region_id; switching scope to a region surfaces that
 *    region's override.
 *  - served validation errors surface via the err toast; no `saved` emit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import GovernanceDialsSection from '../../../app/components/admin/GovernanceDialsSection.vue'
import type { GovernanceDialsData } from '../../../app/components/admin/GovernanceDialsSection.vue'

const REGION_APAC = '11111111-1111-1111-1111-111111111111'
const REGION_EMEA = '22222222-2222-2222-2222-222222222222'

function fixture(): GovernanceDialsData {
  const at = '2026-06-10 00:00:00+00'
  return {
    keys: [
      'velocity.spike_threshold',
      'reconciliation.gap_threshold',
      'reconciliation.epsilon_usd',
      'reconciliation.lag_buffer_hours',
    ],
    platform: [
      { key: 'velocity.spike_threshold', value: 0.25, updated_at: at },
      { key: 'reconciliation.gap_threshold', value: 0.05, updated_at: at },
      { key: 'reconciliation.epsilon_usd', value: 1, updated_at: at },
      { key: 'reconciliation.lag_buffer_hours', value: 24, updated_at: at },
    ],
    region_overrides: [
      {
        key: 'velocity.spike_threshold',
        region_id: REGION_APAC,
        region_code: 'APAC',
        value: 0.5,
        updated_at: at,
      },
      {
        key: 'reconciliation.epsilon_usd',
        region_id: REGION_EMEA,
        region_code: 'EMEA',
        value: 2,
        updated_at: at,
      },
    ],
  }
}

const REGIONS = [
  { id: REGION_APAC, code: 'APAC', display_name: 'Asia Pacific' },
  { id: REGION_EMEA, code: 'EMEA', display_name: 'Europe, Middle East & Africa' },
]

function mountRegionAdmin(data: GovernanceDialsData = fixture()) {
  return mount(GovernanceDialsSection, {
    props: { data, regions: [], orgWide: false, regionId: REGION_APAC, regionCode: 'APAC' },
  })
}

function mountOrgWide(data: GovernanceDialsData = fixture()) {
  return mount(GovernanceDialsSection, {
    props: { data, regions: REGIONS, orgWide: true, regionId: null, regionCode: null },
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('AdminGovernanceDialsSection', () => {
  it('a switch setting’s checkbox is named by the policy, not by Yes/No', () => {
    const base = fixture()
    const key = 'projects.pm_own_region_only'
    const w = mountOrgWide({
      ...base,
      keys: [...base.keys, key],
      platform: [...base.platform, { key, value: 0, updated_at: '2026-06-10 00:00:00+00' }],
      switch_keys: [key],
      platform_only_keys: [key],
    })
    const box = w.find(`[data-testid="governance-input-${key}"]`)
    expect(box.attributes('type')).toBe('checkbox')
    expect(box.attributes('aria-label')).toBe('Project Managers create only in their own region')
  })

  it('renders a row per dial with label, explanation and platform value', () => {
    const wrapper = mountRegionAdmin()
    expect(wrapper.find('[data-testid="settings-governance-dials"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Velocity spike threshold')
    expect(wrapper.text()).toContain('current week vs 4-week mean')
    expect(wrapper.text()).toContain('OTel-vs-actuals gap worker alert fraction')
    expect(wrapper.text()).toContain('Reconciliation matched-band in USD')
    expect(wrapper.text()).toContain('Reconciliation walk-back lag buffer (hours)')
    expect(
      wrapper.find('[data-testid="governance-platform-reconciliation.lag_buffer_hours"]').text(),
    ).toBe('24')
  })

  it('region admin: no scope picker; own-region override wins as effective', () => {
    const wrapper = mountRegionAdmin()
    expect(wrapper.find('[data-testid="settings-governance-scope"]').exists()).toBe(false)
    // velocity.spike_threshold has an APAC override (0.5) shadowing platform 0.25.
    expect(wrapper.find('[data-testid="governance-platform-velocity.spike_threshold"]').text()).toBe('0.25')
    expect(wrapper.find('[data-testid="governance-override-velocity.spike_threshold"]').text()).toBe('0.5')
    expect(wrapper.find('[data-testid="governance-effective-velocity.spike_threshold"]').text()).toBe('0.5')
    expect(wrapper.find('[data-testid="governance-source-velocity.spike_threshold"]').text()).toBe('region override')
    // EMEA's epsilon override is NOT this region admin's — falls back to platform.
    expect(wrapper.find('[data-testid="governance-override-reconciliation.epsilon_usd"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="governance-effective-reconciliation.epsilon_usd"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="governance-source-reconciliation.epsilon_usd"]').text()).toBe('platform')
    // No invented "clear override" — only the honest note.
    expect(wrapper.text()).toContain('Overrides cannot be removed in v1, only re-valued.')
  })

  it('org-wide: scope picker, platform scope shows no override; region scope shows it', async () => {
    const wrapper = mountOrgWide()
    const scope = wrapper.find('[data-testid="settings-governance-scope"]')
    expect(scope.exists()).toBe(true)
    // Platform scope (default): no caller-relevant override.
    expect(wrapper.find('[data-testid="governance-override-velocity.spike_threshold"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="governance-source-velocity.spike_threshold"]').text()).toBe('platform')
    // Switch to APAC: its override surfaces and wins.
    await scope.setValue(REGION_APAC)
    expect(wrapper.find('[data-testid="governance-override-velocity.spike_threshold"]').text()).toBe('0.5')
    expect(wrapper.find('[data-testid="governance-effective-velocity.spike_threshold"]').text()).toBe('0.5')
    expect(wrapper.find('[data-testid="governance-source-velocity.spike_threshold"]').text()).toBe('region override')
  })

  it('region admin save PUTs region scope for their own region and emits saved', async () => {
    const put = vi.fn().mockResolvedValue({})
    vi.stubGlobal('$fetch', put)
    const wrapper = mountRegionAdmin()
    await wrapper.find('[data-testid="governance-input-reconciliation.gap_threshold"]').setValue('0.1')
    await wrapper.find('[data-testid="governance-save-reconciliation.gap_threshold"]').trigger('click')
    await flushPromises()
    expect(put).toHaveBeenCalledWith('/api/v1/admin/governance-settings', {
      method: 'PUT',
      body: {
        key: 'reconciliation.gap_threshold',
        scope_type: 'region',
        region_id: REGION_APAC,
        value: 0.1,
      },
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.find('[data-testid="settings-governance-toast-ok"]').exists()).toBe(true)
  })

  it('org-wide save at platform scope PUTs platform scope without region_id', async () => {
    const put = vi.fn().mockResolvedValue({})
    vi.stubGlobal('$fetch', put)
    const wrapper = mountOrgWide()
    await wrapper.find('[data-testid="governance-input-reconciliation.lag_buffer_hours"]').setValue('48')
    await wrapper.find('[data-testid="governance-save-reconciliation.lag_buffer_hours"]').trigger('click')
    await flushPromises()
    expect(put).toHaveBeenCalledWith('/api/v1/admin/governance-settings', {
      method: 'PUT',
      body: { key: 'reconciliation.lag_buffer_hours', scope_type: 'platform', value: 48 },
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('surfaces a served RFC-9457 validation error via the err toast (no saved emit)', async () => {
    const put = vi.fn().mockRejectedValue({
      data: {
        data: { detail: "Value 99 for 'reconciliation.gap_threshold' is outside (0, 1]." },
      },
    })
    vi.stubGlobal('$fetch', put)
    const wrapper = mountRegionAdmin()
    await wrapper.find('[data-testid="governance-input-reconciliation.gap_threshold"]').setValue('99')
    await wrapper.find('[data-testid="governance-save-reconciliation.gap_threshold"]').trigger('click')
    await flushPromises()
    const toast = wrapper.find('[data-testid="settings-governance-toast-err"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('is outside (0, 1]')
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
})
