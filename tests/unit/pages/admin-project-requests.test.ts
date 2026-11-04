// @vitest-environment happy-dom
/*
 * Admin → Project requests (spec §3, A10).
 *
 *   - The list is the work queue, one page at a time: every pending request
 *     is reachable with Next, not only the first page's worth.
 *   - The detail page: a failed approve (a duplicate code is a 409) refreshes
 *     the request, and that refresh must not throw away the admin's edits.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref, watch, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ListPage from '../../../app/pages/admin/project-requests/index.vue'
import DetailPage from '../../../app/pages/admin/project-requests/[id].vue'

const REQ_ID = '9a1e0000-0000-4000-8000-0000000000e1'
const REGION = '9a1e0000-0000-4000-8000-0000000000a1'
const UNIT = '9a1e0000-0000-4000-8000-0000000000b1'

const PASS = { template: '<div><slot /></div>' }
const STUBS = {
  UiPageHead: PASS,
  UiCard: PASS,
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UiEmptyState: true,
  UiFetchErrorBanner: true,
  AdminPageSkeleton: true,
  NuxtLink: { template: '<a><slot /></a>' },
}

function stubCommon() {
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: 't1', role: 'admin', regionId: REGION }), ensure: async () => {} }))
  vi.stubGlobal('useRoute', () => ({ params: { id: REQ_ID }, query: {} }))
  vi.stubGlobal('useFetch', () => ({
    data: ref({
      units: [{ id: UNIT, display_name: 'Unit', path: 'a.u', region_id: REGION, region_code: 'a', region_name: 'A' }],
      my_unit_id: null,
    }),
    error: ref(null),
    pending: ref(false),
  }))
}

async function mountPage(page: unknown) {
  const Parent = defineComponent({ components: { Page: page as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, { global: { stubs: STUBS } })
  await flushPromises()
  return w
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const row = (n: number) => ({
  id: `9a1e0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
  status: 'pending',
  display_name: `Request ${n}`,
  requester_name: 'Ada',
  requester_email: 'ada@x.test',
  region_code: 'a',
  unit_name: 'Unit',
  budget_usd: '100',
  created_at: '2026-08-01T00:00:00Z',
  created_project_code: null,
})

describe('Admin → Project requests list', () => {
  /** A fake useLazyFetch that serves pages of `total` rows by the reactive offset it is handed. */
  function stubPages(total: number) {
    const calls: number[] = []
    vi.stubGlobal('useLazyFetch', (_url: string, opts: { query: { offset: Ref<number>; limit: number } }) => {
      const data = ref<unknown>(null)
      const load = () => {
        const offset = opts.query.offset.value
        calls.push(offset)
        const ids = Array.from({ length: total }, (_, i) => i + 1).slice(offset, offset + opts.query.limit)
        data.value = { requests: ids.map(row), total, offset, has_more: offset + ids.length < total }
      }
      load()
      watch(opts.query.offset, load)
      return { data, error: ref(null), refresh: vi.fn() }
    })
    return calls
  }

  it('pages through the queue: later requests are reachable with Next, and Previous comes back', async () => {
    stubCommon()
    const calls = stubPages(57)
    const w = await mountPage(ListPage)
    expect(w.find('[data-testid="project-requests-range"]').text()).toBe('Showing 1–50 of 57, oldest first.')
    expect(w.find('[data-testid="project-requests-prev"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="project-requests-next"]').trigger('click')
    await flushPromises()
    expect(calls).toEqual([0, 50])
    expect(w.find('[data-testid="project-requests-range"]').text()).toBe('Showing 51–57 of 57, oldest first.')
    expect(w.text()).toContain('Request 57')
    expect(w.find('[data-testid="project-requests-next"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="project-requests-prev"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Request 1')
  })

  it('shows no pager when every match is on the one page', async () => {
    stubCommon()
    stubPages(1)
    const w = await mountPage(ListPage)
    expect(w.find('[data-testid="project-requests-pager"]').exists()).toBe(false)
  })
})

describe('Admin → Project requests → one request', () => {
  const detail = (status = 'pending') => ({
    request: {
      id: REQ_ID,
      status,
      requester_name: 'Ada',
      requester_email: 'ada@x.test',
      suggested_code: 'ACME-1',
      display_name: 'Acme',
      type: 'billable',
      region_id: REGION,
      region_name: 'A',
      cost_owning_unit_id: UNIT,
      unit_name: 'Unit',
      wbs_code: null,
      end_date: null,
      proposed_pm_teammate_id: 't1',
      pm_name: 'Ada',
      pm_email: 'ada@x.test',
      budget_usd: '100',
      budget_from: '2026-08-01T00:00:00Z',
      budget_to: '2026-09-01T00:00:00Z',
      justification: 'Because.',
      created_at: '2026-08-01T00:00:00Z',
      decided_by_name: null,
      decided_at: null,
      decision_note: null,
      created_project_code: null,
    },
    similar_projects: [],
  })

  function stubDetail(data: Ref<unknown>, post: ReturnType<typeof vi.fn>) {
    stubCommon()
    // Every refresh hands back a NEW object, as a real refetch does.
    const refresh = vi.fn(async () => {
      data.value = typeof refreshTo === 'function' ? refreshTo() : detail()
    })
    let refreshTo: (() => unknown) | null = null
    vi.stubGlobal('useLazyFetch', () => ({ data, error: ref(null), refresh }))
    vi.stubGlobal('$fetch', post)
    return {
      refresh,
      setRefreshTo: (f: () => unknown) => {
        refreshTo = f
      },
    }
  }

  it('a failed approve keeps the admin’s edits', async () => {
    const data = ref<unknown>(detail())
    const post = vi.fn().mockRejectedValue({ statusCode: 409, data: { detail: 'Code ACME-2 is taken.' } })
    const { refresh } = stubDetail(data, post)
    const w = await mountPage(DetailPage)
    await w.find('[data-testid="approve-code"]').setValue('ACME-2')
    await w.find('[data-testid="approve-name"]').setValue('Acme, renamed')
    await w.find('[data-testid="approve-request"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalled()
    expect(w.find('[data-testid="decision-error"]').exists()).toBe(true)
    expect((w.find('[data-testid="approve-code"]').element as HTMLInputElement).value).toBe('ACME-2')
    expect((w.find('[data-testid="approve-name"]').element as HTMLInputElement).value).toBe('Acme, renamed')
  })

  it('a decision that landed reseeds the form from the decided request', async () => {
    const data = ref<unknown>(detail())
    const post = vi.fn().mockResolvedValue({})
    const { setRefreshTo } = stubDetail(data, post)
    setRefreshTo(() => detail('approved'))
    const w = await mountPage(DetailPage)
    await w.find('[data-testid="approve-code"]').setValue('ACME-2')
    await w.find('[data-testid="approve-request"]').trigger('click')
    await flushPromises()
    expect((w.find('[data-testid="approve-code"]').element as HTMLInputElement).value).toBe('ACME-1')
  })
})
