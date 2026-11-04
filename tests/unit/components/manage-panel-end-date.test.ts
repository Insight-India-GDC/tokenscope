// @vitest-environment happy-dom
/*
 * ManagePanel — the end date (spec A8).
 *
 *   - Moving the end date to today or earlier asks first. That check needs the
 *     SERVER's today; until the clock lands the save is disabled, or a past
 *     date would save without the confirmation.
 *   - The copy states what the code does: tagging stops at the end date, tagged
 *     spend spills to unallocated only after the grace period, spend already
 *     attributed stays, and extending later does not move spend back by itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ManagePanel from '../../../app/components/projects/ManagePanel.vue'

const PROJECT = '9a1e0000-0000-4000-8000-0000000000a1'

function mountPanel(todayUtc: string | null) {
  const patch = vi.fn().mockResolvedValue({})
  vi.stubGlobal('$fetch', patch)
  vi.stubGlobal('useFetch', () => ({ data: ref({ members: [] }), refresh: vi.fn() }))
  vi.stubGlobal('useDebouncedSearch', () => ({ run: vi.fn(), cancel: vi.fn(), pending: ref(false) }))
  vi.stubGlobal('apiErrorDetail', (_e: unknown, f: string) => f)
  vi.stubGlobal('fmtUsd', (v: string) => `$${v}`)
  const w = mount(ManagePanel, {
    props: { projectId: PROJECT, endDate: null, ended: false, budgetAllocationId: 'a1', todayUtc, pendingRequests: [], requestsState: 'ready' as const },
    global: {
      stubs: {
        UiCard: { template: '<div><slot /></div>' },
        UiEyebrow: { template: '<div><slot /></div>' },
        UiBadge: true,
        NuxtLink: { template: '<a><slot /></a>' },
        UiButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
      },
      mocks: { fmtUsd: (v: string) => `$${v}` },
    },
  })
  return { w, patch }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ManagePanel end date', () => {
  it('cannot save a date before the server clock has landed', async () => {
    const { w, patch } = mountPanel(null)
    await w.find('[data-testid="manage-end-input"]').setValue('2020-01-01')
    const save = w.find('[data-testid="manage-end-save"]')
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    await flushPromises()
    expect(patch).not.toHaveBeenCalled()
  })

  it('with the clock, a past date asks first and saves only on confirmation', async () => {
    const { w, patch } = mountPanel('2026-08-15')
    await w.find('[data-testid="manage-end-input"]').setValue('2026-08-10')
    await w.find('[data-testid="manage-end-save"]').trigger('click')
    expect(patch).not.toHaveBeenCalled()
    const confirm = w.find('[data-testid="manage-end-confirm"]').text()
    expect(confirm).toContain('can no longer be tagged')
    expect(confirm).toContain('already attributed to it stays')
    expect(confirm).toContain('plus the grace period')
    expect(confirm).not.toMatch(/members' spend goes to unallocated/)
    await w.find('[data-testid="manage-end-confirm-yes"]').trigger('click')
    await flushPromises()
    expect(patch).toHaveBeenCalledOnce()
  })

  it('a future date saves directly', async () => {
    const { w, patch } = mountPanel('2026-08-15')
    await w.find('[data-testid="manage-end-input"]').setValue('2026-12-31')
    await w.find('[data-testid="manage-end-save"]').trigger('click')
    await flushPromises()
    expect(patch).toHaveBeenCalledOnce()
    expect(w.find('[data-testid="manage-end-explainer"]').text()).toContain('does not, by itself, move that spend back')
  })
})
