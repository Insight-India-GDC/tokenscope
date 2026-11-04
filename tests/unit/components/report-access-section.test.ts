// @vitest-environment happy-dom
/*
 * ReportAccessSection — grant/revoke contract for the per-teammate
 * report-access surface (mig 0129), which replaces the retired org-wide
 * report-visibility dial (report-visibility-section.test.ts). Model: that
 * suite's render + toast + mocked-$fetch shape, plus CouOwnersModal's
 * search/assign/revoke mechanics.
 *
 * Contract under test:
 *  - renders one row per grant: "System (migration)" fallback for a null
 *    granted_by_name, an em-dash for a null expiry, an 'Expired' badge (with
 *    the row action still offered) for status:'expired';
 *  - grant flow: search → pick → permission → confirm → POST body asserted
 *    ({ teammate_id, permission, expires_at? });
 *  - the picker offers exactly the positive permissions (no deny option);
 *  - a served RFC-9457 error on grant surfaces via the err toast, no
 *    `changed` emit;
 *  - the row action is one button, two clicks (arm, then fire) → DELETE with
 *    the row's id, emits `changed`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReportAccessSection from '../../../app/components/admin/ReportAccessSection.vue'
import type { ReportAccessData } from '../../../app/components/admin/ReportAccessSection.vue'

function fixture(): ReportAccessData {
  return {
    grants: [
      {
        id: '9a1e0000-0000-4000-8000-000000000001',
        teammate_id: '9a1e0000-0000-4000-8000-000000000011',
        display_name: 'Priya Iyer',
        email: 'priya.iyer@example.com',
        role: 'developer',
        permission: 'operational',
        granted_by: null,
        granted_by_name: null,
        granted_at: '2026-06-01T00:00:00.000Z',
        expires_at: null,
        status: 'active',
      },
      {
        id: '9a1e0000-0000-4000-8000-000000000002',
        teammate_id: '9a1e0000-0000-4000-8000-000000000012',
        display_name: 'Mara Holloway',
        email: 'mara.holloway@example.com',
        role: 'platform-admin',
        permission: 'finance',
        granted_by: '9a1e0000-0000-4000-8000-000000000099',
        granted_by_name: 'Lena Park',
        granted_at: '2026-05-01T00:00:00.000Z',
        expires_at: '2026-06-01T00:00:00.000Z',
        status: 'expired',
      },
    ],
  }
}

function mountSection(data: ReportAccessData = fixture()) {
  return mount(ReportAccessSection, { props: { data } })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Type search text and let useDebouncedSearch's 250ms window elapse. */
async function search(wrapper: ReturnType<typeof mountSection>, term: string) {
  await wrapper.find('[data-testid="report-access-search"]').setValue(term)
  await wrapper.find('[data-testid="report-access-search"]').trigger('input')
  vi.advanceTimersByTime(300)
  await vi.runAllTimersAsync()
  await flushPromises()
}

describe('ReportAccessSection', () => {
  it('renders one row per grant: migration fallback, em-dash expiry, Expired badge', () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="report-access-section"]').exists()).toBe(true)
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)

    expect(rows[0]!.text()).toContain('Priya Iyer')
    expect(rows[0]!.text()).toContain('System (migration)')
    expect(rows[0]!.text()).toContain('—')
    expect(rows[0]!.find('[data-testid^="report-access-status-"]').exists()).toBe(false)

    expect(rows[1]!.text()).toContain('Mara Holloway')
    expect(rows[1]!.text()).toContain('Lena Park')
    const statusBadge = wrapper.find('[data-testid="report-access-status-9a1e0000-0000-4000-8000-000000000002"]')
    expect(statusBadge.exists()).toBe(true)
    expect(statusBadge.text()).toContain('Expired')
    // Revoke stays available on an expired grant (B3).
    expect(
      wrapper.find('[data-testid="report-access-revoke-9a1e0000-0000-4000-8000-000000000002"]').exists(),
    ).toBe(true)
  })

  it('empty state names what baseline access everyone already has', () => {
    const wrapper = mountSection({ grants: [] })
    expect(wrapper.text()).toContain('No grants yet')
    expect(wrapper.text()).toContain('role and Business Unit ownership')
  })

  it('grant flow: search → pick → permission → confirm → POST { teammate_id, permission }', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/admin/report-access/teammate-search') {
        return {
          results: [
            {
              id: '9a1e0000-0000-4000-8000-000000000021',
              display_name: 'Anil Verma',
              email: 'anil.verma@example.com',
              role: 'manager',
              region_id: '9a1e0000-0000-4000-8000-0000000000f1',
            },
          ],
        }
      }
      if (url === '/api/v1/admin/report-access' && opts?.method === 'POST') {
        return { id: '9a1e0000-0000-4000-8000-000000000031' }
      }
      throw new Error(`unexpected fetch ${url} ${opts?.method ?? 'GET'}`)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mountSection({ grants: [] })
    await search(wrapper, 'anil')

    const hit = wrapper.find('[data-testid="report-access-hit-9a1e0000-0000-4000-8000-000000000021"]')
    expect(hit.exists()).toBe(true)
    await hit.trigger('click')

    await wrapper.find('[data-testid="report-access-permission-finance"]').trigger('change')

    const confirm = wrapper.find('[data-testid="report-access-confirm"]')
    expect(confirm.exists()).toBe(true)
    expect(confirm.text()).toContain('Anil Verma')
    expect(confirm.text()).toContain('company-wide')
    expect(confirm.text()).toContain('does not change their platform role')

    await wrapper.find('[data-testid="report-access-grant-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/report-access', {
      method: 'POST',
      body: { teammate_id: '9a1e0000-0000-4000-8000-000000000021', permission: 'finance' },
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('[data-testid="report-access-toast-ok"]').exists()).toBe(true)
  })

  it('a served RFC-9457 error on grant surfaces via the err toast (no changed emit)', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/admin/report-access/teammate-search') {
        return {
          results: [
            {
              id: '9a1e0000-0000-4000-8000-000000000022',
              display_name: 'Owen Cole',
              email: 'owen.cole@example.com',
              role: 'developer',
              region_id: '9a1e0000-0000-4000-8000-0000000000f1',
            },
          ],
        }
      }
      if (url === '/api/v1/admin/report-access' && opts?.method === 'POST') {
        return Promise.reject({
          data: { data: { detail: 'This teammate already holds an active operational grant.' } },
        })
      }
      throw new Error(`unexpected fetch ${url} ${opts?.method ?? 'GET'}`)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mountSection({ grants: [] })
    await search(wrapper, 'owen')
    await wrapper.find('[data-testid="report-access-hit-9a1e0000-0000-4000-8000-000000000022"]').trigger('click')
    await wrapper.find('[data-testid="report-access-permission-operational"]').trigger('change')
    await wrapper.find('[data-testid="report-access-grant-submit"]').trigger('click')
    await flushPromises()

    const toast = wrapper.find('[data-testid="report-access-toast-err"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('already holds an active operational grant')
    expect(wrapper.emitted('changed')).toBeUndefined()
  })

  it('the picker offers exactly the positive permissions — no deny option', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/admin/report-access/teammate-search') {
          return {
            results: [
              {
                id: '9a1e0000-0000-4000-8000-000000000023',
                display_name: 'Dana Reyes',
                email: 'dana.reyes@example.com',
                role: 'platform-admin',
                region_id: '9a1e0000-0000-4000-8000-0000000000f1',
              },
            ],
          }
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const wrapper = mountSection({ grants: [] })
    await search(wrapper, 'dana')
    await wrapper.find('[data-testid="report-access-hit-9a1e0000-0000-4000-8000-000000000023"]').trigger('click')

    const options = wrapper.findAll('input[name="report-access-permission"]').map((o) => o.attributes('value'))
    expect(options).toEqual(['operational', 'finance'])
    expect(wrapper.find('[data-testid="report-access-permission-revoke-all"]').exists()).toBe(false)
  })

  it('revoke: one button, two clicks — arm, then DELETE + emit changed', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') return { revoked: true, id: '9a1e0000-0000-4000-8000-000000000001' }
      throw new Error(`unexpected fetch ${url} ${opts?.method ?? 'GET'}`)
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mountSection()
    const testid = '[data-testid="report-access-revoke-9a1e0000-0000-4000-8000-000000000001"]'

    await wrapper.find(testid).trigger('click')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.find(testid).text()).toContain('Confirm')

    await wrapper.find(testid).trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/report-access/9a1e0000-0000-4000-8000-000000000001',
      { method: 'DELETE' },
    )
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('[data-testid="report-access-toast-ok"]').exists()).toBe(true)
  })
})
