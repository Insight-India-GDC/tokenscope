// @vitest-environment happy-dom
/*
 * Budget requests on the project page (spec §5): the Manage drawer and a
 * member's card tell loading, failed and empty apart. A list that did not load
 * must never read as "No requests waiting", and a failed load offers a retry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import ManagePanel from '../../../app/components/projects/ManagePanel.vue'
import BudgetRequestCard from '../../../app/components/projects/BudgetRequestCard.vue'

const PROJECT = '9a1e0000-0000-4000-8000-0000000000a1'
type State = 'loading' | 'error' | 'ready'

const STUBS = {
  UiCard: { template: '<div><slot /></div>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiBadge: true,
  NuxtLink: { template: '<a><slot /></a>' },
  UiButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
}

function stubGlobals() {
  vi.stubGlobal('$fetch', vi.fn())
  vi.stubGlobal('useFetch', () => ({ data: ref({ members: [] }), refresh: vi.fn() }))
  vi.stubGlobal('useDebouncedSearch', () => ({ run: vi.fn(), cancel: vi.fn(), pending: ref(false) }))
  vi.stubGlobal('apiErrorDetail', (_e: unknown, f: string) => f)
  vi.stubGlobal('fmtUsd', (v: string) => `$${v}`)
}

function mountPanel(requestsState: State) {
  stubGlobals()
  return mount(ManagePanel, {
    props: { projectId: PROJECT, endDate: null, ended: false, budgetAllocationId: 'a1', todayUtc: '2026-08-15', pendingRequests: [], requestsState },
    global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
  })
}

function mountCard(requestsState: State) {
  stubGlobals()
  return mount(BudgetRequestCard, {
    props: { projectId: PROJECT, ended: false, mine: [], requestsState },
    global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Manage section: pending budget requests', () => {
  it('a failed load says so and offers a retry, never "No requests waiting"', async () => {
    const w = mountPanel('error')
    const section = w.find('[data-testid="manage-budget-requests"]')
    expect(section.find('[data-testid="manage-requests-error"]').exists()).toBe(true)
    expect(section.text()).not.toContain('No requests waiting')
    await w.find('[data-testid="manage-requests-retry"]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('while loading it says so, not "No requests waiting"', () => {
    const w = mountPanel('loading')
    expect(w.find('[data-testid="manage-requests-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="manage-budget-requests"]').text()).not.toContain('No requests waiting')
  })

  it('a loaded empty list is "No requests waiting"', () => {
    const w = mountPanel('ready')
    expect(w.find('[data-testid="manage-requests-empty"]').text()).toBe('No requests waiting.')
    expect(w.find('[data-testid="manage-requests-error"]').exists()).toBe(false)
  })
})

describe('Member card: my budget requests', () => {
  it('a failed load says so, offers a retry, and hides the form (it cannot tell whether one is waiting)', async () => {
    const w = mountCard('error')
    expect(w.find('[data-testid="budget-request-load-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="budget-request-submit"]').exists()).toBe(false)
    await w.find('[data-testid="budget-request-retry"]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('a loaded empty list shows the form', () => {
    const w = mountCard('ready')
    expect(w.find('[data-testid="budget-request-submit"]').exists()).toBe(true)
    expect(w.find('[data-testid="budget-request-load-error"]').exists()).toBe(false)
  })
})
