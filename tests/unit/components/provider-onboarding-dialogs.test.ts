// @vitest-environment happy-dom
/*
 * ProviderOrgDialog + ProviderEnterpriseDialog — the reconciliation-provider
 * onboarding modals that replace the seed.ts templates.
 *
 * Contract under test (the load-bearing UX, not pixel layout):
 *  - ProviderOrgDialog anthropic path: Discover button gates on a valid
 *    credential name; a 200 auto-fills the (read-only) org id + variant and a
 *    note; a 422 surfaces the SAFE classified reason inline (no raw error/key).
 *  - ProviderOrgDialog github path: shows the enterprise picker (github-only),
 *    hides the credential/discover fields, and POSTs api_kind=null.
 *  - ProviderEnterpriseDialog: rejects a mixed-case github slug client-side
 *    (the submit stays disabled) and surfaces a served 409 inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderOrgDialog from '../../../app/components/admin/ProviderOrgDialog.vue'
import ProviderEnterpriseDialog from '../../../app/components/admin/ProviderEnterpriseDialog.vue'

const ENTERPRISES = [
  { id: 'e-gh', provider: 'github', externalId: 'acme-corp', displayName: 'Acme (GitHub)' },
  { id: 'e-an', provider: 'anthropic', externalId: 'org-x', displayName: 'Acme (Anthropic)' },
]
const REGIONS = [
  { id: 'r-apac', code: 'apac', displayName: 'APAC' },
  { id: 'r-amer', code: 'amer', displayName: 'Americas' },
]

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ProviderOrgDialog — anthropic discover flow', () => {
  it('gates Discover on a valid credential name, then auto-fills org id + variant on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      organizationId: 'org-discovered-123',
      apiKindDetected: 'enterprise-analytics',
      keyFormatLooksLike: 'analytics',
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(ProviderOrgDialog, {
      props: { open: true, target: null, enterprises: ENTERPRISES, regions: REGIONS, canDiscoverOrg: true, canCreateAnthropicOrg: true },
    })
    await flushPromises()

    // Anthropic is the default provider → discover surface is present.
    const discoverBtn = wrapper.find('[data-testid="po-discover"]')
    expect(discoverBtn.exists()).toBe(true)
    // Disabled until a valid credential name is typed.
    expect(discoverBtn.attributes('disabled')).toBeDefined()

    await wrapper.find('[data-testid="po-cred"]').setValue('acme-admin-key')
    expect(wrapper.find('[data-testid="po-discover"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-testid="po-discover"]').trigger('click')
    await flushPromises()

    // Called the discover endpoint with the credential name.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/reconciliation/anthropic/discover',
      expect.objectContaining({ method: 'POST', body: { credentialSecretName: 'acme-admin-key' } }),
    )
    // Auto-filled + read-only org id, success note, variant switched.
    const orgId = wrapper.find('[data-testid="po-org-id"]')
    expect((orgId.element as HTMLInputElement).value).toBe('org-discovered-123')
    expect(orgId.attributes('readonly')).toBeDefined()
    expect(wrapper.find('[data-testid="po-discover-note"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="po-discover-note"]').text()).toContain('Enterprise Analytics')
  })

  it('surfaces the SAFE 422 reason inline (no raw error leak)', async () => {
    const fetchMock = vi.fn().mockRejectedValue({ data: { reason: '403-forbidden-scope' } })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(ProviderOrgDialog, {
      props: { open: true, target: null, enterprises: ENTERPRISES, regions: REGIONS, canDiscoverOrg: true, canCreateAnthropicOrg: true },
    })
    await flushPromises()
    await wrapper.find('[data-testid="po-cred"]').setValue('acme-admin-key')
    await wrapper.find('[data-testid="po-discover"]').trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-testid="po-discover-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text().toLowerCase()).toContain('forbidden')
    // The org id was NOT auto-filled on failure.
    expect((wrapper.find('[data-testid="po-org-id"]').element as HTMLInputElement).value).toBe('')
  })

  it('a region admin is not offered the Anthropic create path, which could only end in 403', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(ProviderOrgDialog, {
      props: { open: true, target: null, enterprises: ENTERPRISES, regions: REGIONS, canDiscoverOrg: false, canCreateAnthropicOrg: false },
    })
    await flushPromises()

    // Starts on github, has no anthropic option, and says why.
    const select = wrapper.find('[data-testid="po-provider"]')
    expect((select.element as HTMLSelectElement).value).toBe('github')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['github'])
    expect(wrapper.find('[data-testid="po-anthropic-platform-only"]').exists()).toBe(true)
    // No credential field, no Discover, nothing fetched.
    expect(wrapper.find('[data-testid="po-cred"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="po-discover"]').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ProviderOrgDialog — github path', () => {
  it('shows the github-only enterprise picker and POSTs api_kind=null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ id: 'new-org' })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mount(ProviderOrgDialog, {
      props: { open: true, target: null, enterprises: ENTERPRISES, regions: REGIONS },
    })
    await flushPromises()

    await wrapper.find('[data-testid="po-provider"]').setValue('github')
    await flushPromises()

    // Credential/discover fields gone; github org id + enterprise picker present.
    expect(wrapper.find('[data-testid="po-discover"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="po-org-id-gh"]').exists()).toBe(true)
    const picker = wrapper.find('[data-testid="po-enterprise"]')
    expect(picker.exists()).toBe(true)
    // Only the github enterprise is offered (anthropic filtered out) + the "none" option.
    const options = picker.findAll('option')
    expect(options.map((o) => o.text()).join(' ')).toContain('Acme (GitHub)')
    expect(options.map((o) => o.text()).join(' ')).not.toContain('Acme (Anthropic)')

    // ADR-0010 D4: the github org→region home picker is present and offers the regions.
    const regionPicker = wrapper.find('[data-testid="po-region"]')
    expect(regionPicker.exists()).toBe(true)
    expect(regionPicker.findAll('option').map((o) => o.text()).join(' ')).toContain('APAC')

    await wrapper.find('[data-testid="po-org-id-gh"]').setValue('acme-engineering')
    await wrapper.find('[data-testid="po-display-name"]').setValue('Acme Engineering')
    await picker.setValue('e-gh')
    await regionPicker.setValue('r-apac')
    await wrapper.find('[data-testid="po-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/reconciliation/orgs',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          provider: 'github',
          externalOrgId: 'acme-engineering',
          apiKind: null,
          credentialSecretName: null,
          providerEnterpriseId: 'e-gh',
          regionId: 'r-apac',
        }),
      }),
    )
    expect(wrapper.emitted('saved')).toBeTruthy()
  })
})

describe('ProviderEnterpriseDialog — Copilot billing (ADR-0010 D1/D2)', () => {
  it('shows the Copilot billing fields for github and sends flat + allowance', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ id: 'new-ent' })
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ProviderEnterpriseDialog, { props: { open: true, target: null } })
    await flushPromises()

    // Default provider is github → Copilot billing section is present.
    expect(wrapper.find('[data-testid="pe-copilot-billing"]').exists()).toBe(true)
    await wrapper.find('[data-testid="pe-external-id"]').setValue('acme-corp')
    await wrapper.find('[data-testid="pe-display-name"]').setValue('Acme')
    await wrapper.find('[data-testid="pe-flat"]').setValue('39')
    await wrapper.find('[data-testid="pe-allowance"]').setValue('70')
    await wrapper.find('[data-testid="pe-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/reconciliation/enterprises',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ flatSeatPriceUsd: 39, includedAllowanceUsd: 70 }),
      }),
    )
  })

  it('hides the Copilot billing fields for anthropic (pure metered — no flat/allowance)', async () => {
    vi.stubGlobal('$fetch', vi.fn())
    const wrapper = mount(ProviderEnterpriseDialog, { props: { open: true, target: null } })
    await flushPromises()
    // Default provider github → section visible; switching to anthropic hides it reactively.
    expect(wrapper.find('[data-testid="pe-copilot-billing"]').exists()).toBe(true)
    await wrapper.find('[data-testid="pe-provider"]').setValue('anthropic')
    await flushPromises()
    expect(wrapper.find('[data-testid="pe-copilot-billing"]').exists()).toBe(false)
  })
})

describe('ProviderOrgDialog — github slug lowercase guard (mig 0064)', () => {
  it('warns + disables submit on a mixed-case github org slug', async () => {
    vi.stubGlobal('$fetch', vi.fn())
    const wrapper = mount(ProviderOrgDialog, {
      props: { open: true, target: null, enterprises: ENTERPRISES, regions: REGIONS },
    })
    await flushPromises()
    await wrapper.find('[data-testid="po-provider"]').setValue('github')
    await flushPromises()
    await wrapper.find('[data-testid="po-org-id-gh"]').setValue('Acme-Engineering')
    await wrapper.find('[data-testid="po-display-name"]').setValue('Acme Engineering')
    await flushPromises()

    expect(wrapper.find('[data-testid="po-slug-warn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="po-submit"]').attributes('disabled')).toBeDefined()
  })
})

describe('ProviderEnterpriseDialog', () => {
  it('rejects a mixed-case github slug client-side (submit stays disabled)', async () => {
    vi.stubGlobal('$fetch', vi.fn())
    const wrapper = mount(ProviderEnterpriseDialog, {
      props: { open: true, target: null },
    })
    await flushPromises()
    // Default provider is github.
    await wrapper.find('[data-testid="pe-external-id"]').setValue('Acme-Corp')
    await wrapper.find('[data-testid="pe-display-name"]').setValue('Acme')
    await flushPromises()

    expect(wrapper.find('[data-testid="pe-slug-warn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pe-submit"]').attributes('disabled')).toBeDefined()
  })

  it('surfaces a served 409 inline and does not emit saved', async () => {
    const fetchMock = vi.fn().mockRejectedValue({
      data: { data: { detail: "A github enterprise with external_id 'acme-corp' already exists." } },
    })
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = mount(ProviderEnterpriseDialog, {
      props: { open: true, target: null },
    })
    await flushPromises()
    await wrapper.find('[data-testid="pe-external-id"]').setValue('acme-corp')
    await wrapper.find('[data-testid="pe-display-name"]').setValue('Acme')
    await wrapper.find('[data-testid="pe-submit"]').trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-testid="provider-enterprise-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('already exists')
    expect(wrapper.emitted('saved')).toBeFalsy()
  })
})
