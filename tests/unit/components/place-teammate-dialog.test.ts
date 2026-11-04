// @vitest-environment happy-dom
/*
 * PlaceTeammateDialog — a plain confirmation of a move. The history re-home
 * (checkbox, From date, "Check what would move", "Repair history") left the
 * product: reports group by where people sit now, so there is no recorded
 * usage to carry across.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PlaceTeammateDialog from '../../../app/components/admin/PlaceTeammateDialog.vue'

function mountDialog() {
  return mount(PlaceTeammateDialog, {
    props: { open: true, teammateLabel: 'kaito@x.test', toUnitName: 'APAC · CTO' },
  })
}

describe('PlaceTeammateDialog', () => {
  it('renders no history controls', () => {
    const wrapper = mountDialog()
    for (const id of ['pt-move-history', 'pt-from', 'pt-check', 'pt-span']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    }
    const text = wrapper.text().replace(/\s+/g, ' ')
    expect(text).not.toContain('Repair history')
    expect(text).not.toMatch(/stays on the old|future usage only/)
  })

  it('says where their usage will report, naming the destination', () => {
    const text = mountDialog().find('[data-testid="pt-explainer"]').text().replace(/\s+/g, ' ')
    expect(text).toContain('APAC · CTO')
    expect(text).toMatch(/where each person sits now/)
  })

  it('confirms the placement with no payload', async () => {
    const wrapper = mountDialog()
    const confirm = wrapper.find('[data-testid="pt-confirm"]')
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirm.trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[]])
  })

  it('cancel emits cancel', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-testid="pt-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
