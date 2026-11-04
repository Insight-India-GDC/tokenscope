// @vitest-environment happy-dom
/*
 * BulkPlaceDialog — the PARTIAL-SUCCESS path, which is the one an admin hits
 * first and the only one where the dialog and the page behind it can disagree.
 *
 * The endpoint returns per-id outcomes precisely so one bad id cannot discard 39
 * good placements. That leaves the client with a state most dialogs never have:
 * some of the work committed, some did not, and the dialog stays open. Three
 * things have to be true at once, and each was wrong or missing:
 *   - the message says what DID happen, not just what failed;
 *   - the parent is told, so the 38 placed rows stop rendering as unplaced
 *     behind the dialog;
 *   - the selection becomes the ids still to place, so a retry does not
 *     resubmit the ones that already worked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BulkPlaceDialog from '../../../app/components/admin/BulkPlaceDialog.vue'

const TARGETS = [{ id: 'u-core', code: 'cc-core', display_name: 'A Core', depth: 1 }]
const NAMES: Record<string, string> = { a: 'Ann', b: 'Ben', c: 'Cara' }

function mountDialog(ids = ['a', 'b', 'c']) {
  return mount(BulkPlaceDialog, {
    props: {
      open: true,
      teammateIds: ids,
      targets: TARGETS,
      labelFor: (id: string) => NAMES[id] ?? id,
    },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('BulkPlaceDialog — partial success', () => {
  it('stays open, names the refusals, and hands the parent the failed ids', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      placed: 2,
      noop: 0,
      failed: 1,
      results: [
        { teammate_id: 'a', status: 'placed' },
        { teammate_id: 'b', status: 'placed' },
        { teammate_id: 'c', status: 'failed', reason: 'That Business Unit is retired — pick an active one.' },
      ],
    }))

    const wrapper = mountDialog()
    await wrapper.find('[data-testid="bulk-place-target"]').setValue('u-core')
    await wrapper.find('[data-testid="bulk-place-submit"]').trigger('click')
    await flushPromises()

    // Open, and honest about both halves.
    expect(wrapper.find('[data-testid="bulk-place-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bulk-place-error"]').text()).toContain('2 placed')
    expect(wrapper.find('[data-testid="bulk-place-error"]').text()).toContain('1 refused')

    // The refusal names the person and carries the server's own sentence.
    const failures = wrapper.find('[data-testid="bulk-place-failures"]').text()
    expect(failures).toContain('Cara')
    expect(failures).toContain('retired')

    // The parent is told — otherwise Ann and Ben sit on screen as unplaced.
    expect(wrapper.emitted('placed')).toBeUndefined() // not a clean run
    const partial = wrapper.emitted('partial')
    expect(partial).toHaveLength(1)
    expect(partial![0]![0]).toMatchObject({ placed: 2, failed: 1, unitName: 'A Core', failedIds: ['c'] })
  })

  it('a retry after a partial batch submits only what is left', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      placed: 2,
      noop: 0,
      failed: 1,
      results: [
        { teammate_id: 'a', status: 'placed' },
        { teammate_id: 'b', status: 'placed' },
        { teammate_id: 'c', status: 'failed', reason: 'nope' },
      ],
    })
    vi.stubGlobal('$fetch', fetchMock)

    const wrapper = mountDialog()
    await wrapper.find('[data-testid="bulk-place-target"]').setValue('u-core')
    await wrapper.find('[data-testid="bulk-place-submit"]').trigger('click')
    await flushPromises()

    // The parent narrows the selection to the failures; that is what comes back
    // down as the prop.
    const failedIds = (wrapper.emitted('partial')![0]![0] as { failedIds: string[] }).failedIds
    await wrapper.setProps({ teammateIds: failedIds })

    expect(wrapper.find('[data-testid="bulk-place-submit"]').text()).toContain('Place 1')
    await wrapper.find('[data-testid="bulk-place-submit"]').trigger('click')
    await flushPromises()

    // Ann and Ben are NOT resubmitted: re-placing them would be two no-op audits
    // and, before the server learned to detect that, two stripped provenances.
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/admin/users/bulk-place',
      expect.objectContaining({ body: { teammate_ids: ['c'], org_unit_id: 'u-core' } }),
    )
  })

  it('a clean run closes with a summary, and counts "already there" separately from placed', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      placed: 2,
      noop: 1,
      failed: 0,
      results: [
        { teammate_id: 'a', status: 'placed' },
        { teammate_id: 'b', status: 'placed' },
        { teammate_id: 'c', status: 'noop' },
      ],
    }))

    const wrapper = mountDialog()
    await wrapper.find('[data-testid="bulk-place-target"]').setValue('u-core')
    await wrapper.find('[data-testid="bulk-place-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('partial')).toBeUndefined()
    const placed = wrapper.emitted('placed')
    expect(placed).toHaveLength(1)
    // A no-op is not a placement: reporting 3 placed for 2 writes is how a
    // re-place looks like progress.
    expect(placed![0]![0]).toMatchObject({ placed: 2, noop: 1, unitName: 'A Core' })
  })
})

describe('BulkPlaceDialog — no history controls', () => {
  it('offers no history option at any batch size, and still submits a plain placement', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ placed: 60, noop: 0, failed: 0, results: [] })
    vi.stubGlobal('$fetch', fetchMock)
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`)

    const wrapper = mountDialog(ids)
    expect(wrapper.find('[data-testid="bulk-place-move-history"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bulk-place-history-capped"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/stays where it is|future usage only/)

    await wrapper.find('[data-testid="bulk-place-target"]').setValue('u-core')
    expect(wrapper.find('[data-testid="bulk-place-explainer"]').text()).toContain('A Core')
    await wrapper.find('[data-testid="bulk-place-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/users/bulk-place',
      expect.objectContaining({ body: { teammate_ids: ids, org_unit_id: 'u-core' } }),
    )
    expect(wrapper.emitted('placed')![0]![0]).not.toHaveProperty('historyRepaired')
  })
})
