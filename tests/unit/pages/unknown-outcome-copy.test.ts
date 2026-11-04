// @vitest-environment happy-dom
/*
 * A failed change only says "nothing happened" when the server said so: a 4xx
 * with a body. A network failure or a 5xx leaves the outcome unknown (the
 * change may have landed before the failure), so the copy says it is unknown
 * and where to check before trying again, and never "Nothing was created".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import NewProjectPage from '../../../app/pages/projects/new.vue'
import RequestPage from '../../../app/pages/projects/request.vue'
import DetailPage from '../../../app/pages/admin/project-requests/[id].vue'
import ProjectRequestsPanel from '../../../app/components/projects/ProjectRequestsPanel.vue'
import BudgetRequestCard from '../../../app/components/projects/BudgetRequestCard.vue'
import ManagePanel from '../../../app/components/projects/ManagePanel.vue'

const REGION = '9a1e0000-0000-4000-8000-0000000000a1'
const UNIT = '9a1e0000-0000-4000-8000-0000000000b1'
const REQ_ID = '9a1e0000-0000-4000-8000-0000000000e1'
const PROJECT = '9a1e0000-0000-4000-8000-0000000000c1'

const NETWORK = new TypeError('Failed to fetch')
const REFUSED = { statusCode: 409, data: { data: { detail: 'Code ACME-1 is taken.' } } }

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const STUBS = {
  UiPageHead: PASS,
  UiBreadcrumb: true,
  UiCard: PASS,
  UiEyebrow: PASS,
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UiEmptyState: PASS,
  UiFetchErrorBanner: true,
  AdminPageSkeleton: true,
  NuxtLink: { template: '<a><slot /></a>' },
}

function stubNuxt(role: string, post: ReturnType<typeof vi.fn>) {
  stubServerClock('2026-08-15T12:00:00Z')
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useRoute', () => ({ params: { id: REQ_ID }, query: {} }))
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', email: 't1@x.test', displayName: 'T One', role, regionId: REGION }),
    ensure: async () => {},
  }))
  vi.stubGlobal('useFetch', (url: string) => {
    if (url === '/api/v1/pickers/business-units') {
      return {
        data: ref({ units: [{ id: UNIT, display_name: 'Unit', path: 'a.u', region_id: REGION, region_code: 'a', region_name: 'A' }], my_unit_id: UNIT }),
        error: ref(null),
        pending: ref(false),
      }
    }
    if (url === '/api/v1/me/capabilities') return { data: ref({ can_create_projects: false, pm_own_region_only: false, region_id: REGION }) }
    return { data: ref({ members: [], requests: [] }), error: ref(null), pending: ref(false), refresh: vi.fn() }
  })
  vi.stubGlobal('useDebouncedSearch', () => ({ run: vi.fn(), cancel: vi.fn(), pending: ref(false) }))
  vi.stubGlobal('navigateTo', vi.fn())
  vi.stubGlobal('$fetch', post)
  vi.stubGlobal('fmtUsd', (v: string) => `$${v}`)
}

async function mountPage(page: unknown) {
  const Parent = defineComponent({ components: { Page: page as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } } })
  await flushPromises()
  return w
}

// Unmount before the globals go: a page left mounted kept a debounced search
// that fired after $fetch was unstubbed and failed main's unit job.
enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/projects/new', () => {
  function stubCreate(error: string, outcomeUnknown: boolean) {
    vi.stubGlobal('useProjectCreate', () => ({ submitting: ref(false), error: ref(error), outcomeUnknown: ref(outcomeUnknown), submit: vi.fn() }))
  }

  it('an unknown outcome says so and never "Nothing was created"', async () => {
    stubNuxt('admin', vi.fn())
    stubCreate('Failed to fetch', true)
    const text = (await mountPage(NewProjectPage)).find('[data-testid="new-project-error"]').text()
    expect(text).toContain('could not tell whether the project was created')
    expect(text).not.toContain('Nothing was created')
  })

  it('a server refusal still says nothing was created', async () => {
    stubNuxt('admin', vi.fn())
    stubCreate('Code ACME-1 is taken.', false)
    const text = (await mountPage(NewProjectPage)).find('[data-testid="new-project-error"]').text()
    expect(text).toContain('Code ACME-1 is taken.')
    expect(text).toContain('Nothing was created')
  })
})

describe('/projects/request', () => {
  async function submitWith(err: unknown) {
    const post = vi.fn().mockRejectedValue(err)
    stubNuxt('developer', post)
    const w = await mountPage(RequestPage)
    await w.find('[data-testid="project-request-name"]').setValue('Acme data platform')
    await w.find('[data-testid="project-request-justification"]').setValue('Client work.')
    await w.find('[data-testid="project-request-budget"]').setValue('500')
    await w.find('[data-testid="project-request-submit"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalled()
    return w.find('[data-testid="project-request-error"]').text()
  }

  it('a network failure says the request may have been sent and where to check', async () => {
    const text = await submitWith(NETWORK)
    expect(text).toContain('could not tell whether your request was sent')
    expect(text).toContain('it is not sent twice')
    expect(text).toContain('My projects')
  })

  it('without crypto.randomUUID no key is sent, and the copy does not promise a safe resend', async () => {
    vi.stubGlobal('crypto', {})
    const text = await submitWith(NETWORK)
    expect(text).toContain('could not tell whether your request was sent')
    expect(text).toContain('before sending it again')
    expect(text).not.toContain('not sent twice')
  })

  it('a server refusal shows the server reason', async () => {
    expect(await submitWith(REFUSED)).toBe('Code ACME-1 is taken.')
  })

  it('a resend of the same content carries the same idempotency key; a change starts a new one', async () => {
    const post = vi.fn().mockRejectedValue(NETWORK)
    stubNuxt('developer', post)
    const w = await mountPage(RequestPage)
    await w.find('[data-testid="project-request-name"]').setValue('Acme data platform')
    await w.find('[data-testid="project-request-justification"]').setValue('Client work.')
    await w.find('[data-testid="project-request-budget"]').setValue('500')
    const send = async () => {
      await w.find('[data-testid="project-request-submit"]').trigger('click')
      await flushPromises()
    }
    await send()
    await send()
    await w.find('[data-testid="project-request-budget"]').setValue('600')
    await send()
    const keys = post.mock.calls.map((c) => (c[1] as { body: { idempotency_key: string } }).body.idempotency_key)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })
})

describe('/admin/project-requests/[id]', () => {
  const detail = {
    request: {
      id: REQ_ID, status: 'pending', requester_name: 'Ada', requester_email: 'ada@x.test', suggested_code: 'ACME-1',
      display_name: 'Acme', type: 'billable', region_id: REGION, region_name: 'A', cost_owning_unit_id: UNIT,
      unit_name: 'Unit', wbs_code: null, end_date: null, proposed_pm_teammate_id: 't1', pm_name: 'Ada', pm_email: 'ada@x.test',
      budget_usd: '100', budget_from: '2026-08-01T00:00:00Z', budget_to: '2026-09-01T00:00:00Z', justification: 'Because.',
      created_at: '2026-08-01T00:00:00Z', decided_by_name: null, decided_at: null, decision_note: null, created_project_code: null,
    },
    similar_projects: [],
  }

  it('an approve that failed without an answer does not claim nothing was created', async () => {
    stubNuxt('admin', vi.fn().mockRejectedValue(NETWORK))
    vi.stubGlobal('useLazyFetch', () => ({ data: ref(detail), error: ref(null), refresh: vi.fn() }))
    const w = await mountPage(DetailPage)
    await w.find('[data-testid="approve-request"]').trigger('click')
    await flushPromises()
    const text = w.find('[data-testid="decision-error"]').text()
    expect(text).toContain('could not tell whether the approval went through')
    expect(text).not.toContain('Nothing was created')
  })
})

describe('project-request withdraw (My projects)', () => {
  it('a network failure says the outcome is unknown', async () => {
    stubNuxt('developer', vi.fn().mockRejectedValue(NETWORK))
    const row = {
      id: REQ_ID, status: 'pending', display_name: 'Acme', unit_name: 'Unit', region_code: 'a', budget_usd: '100',
      decision_note: null, created_project_code: null, created_project_name: null,
    }
    vi.stubGlobal('useFetch', () => ({ data: ref({ requests: [row] }), error: ref(null), pending: ref(false), refresh: vi.fn() }))
    const w = await mountPage(ProjectRequestsPanel)
    await w.find(`[data-testid="withdraw-project-request-${REQ_ID}"]`).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').text()).toContain('could not tell whether the request was withdrawn')
  })
})

describe('budget requests and Manage saves', () => {
  const pending = {
    id: '9a1e0000-0000-4000-8000-0000000000f1', status: 'pending', amount_usd: '50.00', approved_amount_usd: null,
    reason: 'More tokens', requester_display_name: 'Ada', requester_email: 'ada@x.test', created_at: '2026-08-10T00:00:00Z',
    decision_note: null,
  }

  it('a member’s withdraw that failed without an answer says so and reloads the list', async () => {
    stubNuxt('developer', vi.fn().mockRejectedValue(NETWORK))
    const w = mount(BudgetRequestCard, {
      props: { projectId: PROJECT, ended: false, mine: [pending], requestsState: 'ready' },
      global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
    })
    await w.find(`[data-testid="budget-request-withdraw-${pending.id}"]`).trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="budget-request-error"]').text()).toContain('could not tell whether the request was withdrawn')
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('a refused withdraw shows the server reason and does not pretend to reload', async () => {
    stubNuxt('developer', vi.fn().mockRejectedValue(REFUSED))
    const w = mount(BudgetRequestCard, {
      props: { projectId: PROJECT, ended: false, mine: [pending], requestsState: 'ready' },
      global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
    })
    await w.find(`[data-testid="budget-request-withdraw-${pending.id}"]`).trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="budget-request-error"]').text()).toBe('Code ACME-1 is taken.')
    expect(w.emitted('changed')).toBeUndefined()
  })

  it('a manager’s budget save that failed without an answer says the outcome is unknown and reloads', async () => {
    stubNuxt('admin', vi.fn().mockRejectedValue({ statusCode: 502, data: {} }))
    const w = mount(ManagePanel, {
      props: { projectId: PROJECT, endDate: null, ended: false, budgetAllocationId: null, todayUtc: '2026-08-15', pendingRequests: [], requestsState: 'ready' },
      global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
    })
    await w.find('[data-testid="manage-budget-amount"]').setValue('100')
    await w.find('[data-testid="manage-budget-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="manage-budget-error"]').text()).toContain('could not tell whether the budget was set')
    expect(w.emitted('changed')).toHaveLength(1)
  })
})
