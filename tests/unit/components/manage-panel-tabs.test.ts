// @vitest-environment happy-dom
/*
 * The Manage drawer's tabs (#477, docs/design/ideas/project-page-actions/SPEC.md
 * §4): Budget requests (N), Budget, End date, Members, in that order, each
 * holding today's section. Hidden sections stay mounted, so a half-filled form
 * survives a look at another tab.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import ManagePanel from '../../../app/components/projects/ManagePanel.vue'
import UiTabs from '../../../app/components/ui/Tabs.vue'

const PROJECT = '9a1e0000-0000-4000-8000-0000000000a1'
const STUBS = {
  UiTabs,
  UiBadge: true,
  NuxtLink: { template: '<a><slot /></a>' },
  UiButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
}
const pending = (n: string) => ({
  id: `9a1e0000-0000-4000-8000-00000000${n}`,
  project_id: PROJECT,
  requester_teammate_id: '9a1e0000-0000-4000-8000-0000000000f1',
  requester_display_name: 'Ava',
  requester_email: 'ava@example.com',
  amount_usd: '250.00',
  reason: 'Pairing',
  status: 'pending' as const,
  approved_amount_usd: null,
  decided_by_display_name: null,
  decided_at: null,
  decision_note: null,
  created_at: '2026-08-09T10:00:00Z',
})

function mountPanel(over: Record<string, unknown> = {}) {
  vi.stubGlobal('$fetch', vi.fn())
  vi.stubGlobal('useFetch', () => ({ data: ref({ members: [] }), refresh: vi.fn() }))
  vi.stubGlobal('useDebouncedSearch', () => ({ run: vi.fn(), cancel: vi.fn(), pending: ref(false) }))
  vi.stubGlobal('fmtUsd', (v: string) => `$${v}`)
  return mount(ManagePanel, {
    props: {
      projectId: PROJECT,
      endDate: null,
      ended: false,
      budgetAllocationId: null,
      todayUtc: '2026-08-15',
      pendingRequests: [pending('0a01'), pending('0a02')],
      requestsState: 'ready',
      ...over,
    },
    global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } },
  })
}

const SECTIONS = {
  requests: 'manage-budget-requests',
  budget: 'manage-budget',
  'end-date': 'manage-end-date',
  members: 'manage-members',
} as const

afterEach(() => vi.unstubAllGlobals())

describe('Manage drawer tabs', () => {
  it('lists the four tabs in the agreed order, with the waiting count on Budget requests', () => {
    const w = mountPanel()
    const labels = w.findComponent(UiTabs).findAll('button').map((b) => b.text().trim())
    expect(labels).toEqual(['Budget requests (2)', 'Budget', 'End date', 'Members'])
  })

  it('no count on Budget requests while the list is loading or failed to load', () => {
    for (const requestsState of ['loading', 'error'] as const) {
      const labels = mountPanel({ requestsState, pendingRequests: [] }).findComponent(UiTabs).findAll('button').map((b) => b.text().trim())
      expect(labels[0], requestsState).toBe('Budget requests')
    }
  })

  it('shows only the selected tab, marks it current, and keeps the others mounted', async () => {
    const w = mountPanel({ tab: 'requests' })
    for (const [key, testid] of Object.entries(SECTIONS)) {
      const section = w.find(`[data-testid="${testid}"]`)
      expect(section.exists(), key).toBe(true)
      expect((section.element as HTMLElement).style.display === 'none', key).toBe(key !== 'requests')
    }
    const tabs = w.findComponent(UiTabs).findAll('button')
    expect(tabs[0]!.attributes('aria-current')).toBe('true')
    expect(tabs[1]!.attributes('aria-current')).toBeUndefined()

    await tabs[3]!.trigger('click')
    expect(w.emitted('update:tab')?.at(-1)).toEqual(['members'])
  })

  it('a half-filled budget survives switching tabs', async () => {
    const w = mountPanel({ tab: 'budget' })
    await w.find('[data-testid="manage-budget-amount"]').setValue('120')
    await w.setProps({ tab: 'members' })
    await w.setProps({ tab: 'budget' })
    expect((w.find('[data-testid="manage-budget-amount"]').element as HTMLInputElement).value).toBe('120')
  })

  it('an ended project offers no budget change: no create form, no top-up, only a look (#514)', () => {
    const withBudget = mountPanel({ ended: true, tab: 'budget', budgetAllocationId: '9a1e0000-0000-4000-8000-0000000000b1' })
    expect(withBudget.find('[data-testid="manage-set-budget"]').exists()).toBe(false)
    expect(withBudget.find('[data-testid="manage-budget-save"]').exists()).toBe(false)
    expect(withBudget.find('[data-testid="manage-topup"]').exists()).toBe(false)
    expect(withBudget.find('[data-testid="manage-see-budget"]').text()).toBe('See the budget →')
    const without = mountPanel({ ended: true, tab: 'budget', budgetAllocationId: null })
    expect(without.find('[data-testid="manage-set-budget"]').exists()).toBe(false)
    expect(without.find('[data-testid="manage-budget-ended"]').text()).toBe('It has no budget for the current period.')
    // Not ended, no budget: the create form, as before.
    expect(mountPanel({ tab: 'budget', budgetAllocationId: null }).find('[data-testid="manage-set-budget"]').exists()).toBe(true)
  })

  it('top-ups only: says the budget exists, offers a top-up, and explains a baseline adds to it (#513)', () => {
    const w = mountPanel({ tab: 'budget', budgetAllocationId: null, budgetTopupAllocationId: '9a1e0000-0000-4000-8000-0000000000c1' })
    expect(w.find('[data-testid="manage-topups-only"]').text()).toBe(
      'This project\'s budget for the current period is top-ups only, with no baseline.',
    )
    expect(w.find('[data-testid="manage-topup"]').text()).toBe('Add to the budget →')
    expect(w.text()).not.toContain('This project has no budget for the current period')
    expect(w.text()).toContain('It is added to the top-ups, it does not replace them')
    // No change-or-split link: that editor changes a baseline, and there is none.
    expect(w.find('[data-testid="pm-manage-budget"]').exists()).toBe(false)
  })

  it('an ended project says its budget no longer changes', () => {
    expect(mountPanel({ ended: true }).find('[data-testid="manage-ended"]').text()).toBe(
      'This project has ended, so its budget no longer changes.',
    )
    expect(mountPanel().find('[data-testid="manage-ended"]').exists()).toBe(false)
  })
})
