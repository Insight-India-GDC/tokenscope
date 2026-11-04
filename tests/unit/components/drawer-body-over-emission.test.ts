/*
 * The drawer reuses DrawerBodyOverEmission when another escalated item is
 * selected, so what it shows must follow its `body` prop, not the first one.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DrawerBodyOverEmission from '../../../app/components/inbox/DrawerBodyOverEmission.vue'
import InboxDrawer from '../../../app/components/inbox/InboxDrawer.vue'

const body = (name: string, usd: number) => ({
  teammateName: name,
  tool: 'claude-code',
  day: '2026-06-21',
  resolvedOverUsd: usd,
  currentOverUsd: usd,
  escalatedBy: 'teammate',
  actionHref: `/reporting/teammate/${name}?src=across`,
})

describe('DrawerBodyOverEmission', () => {
  it('shows the newly selected item when the drawer is reused', async () => {
    const w = mount(DrawerBodyOverEmission, {
      props: { body: body('Ada', 450) },
      global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
    })
    expect(w.find('[data-testid="over-emission-facts"]').text()).toContain('Ada')
    await w.setProps({ body: body('Grace', 120) })
    const facts = w.find('[data-testid="over-emission-facts"]').text()
    expect(facts).toContain('Grace')
    expect(facts).toContain('$120.00')
    expect(facts).not.toContain('Ada')
  })
})

describe('InboxDrawer', () => {
  // Every drawer body reads its item at setup; selecting another item of the
  // same kind must remount it, or the drawer shows the new subject over the
  // old item's figures.
  const item = (id: string, name: string) => ({
    id,
    category: 'over-emission-escalated',
    severity: 'attention' as const,
    subject: `Flag for ${name}`,
    body: body(name, 10),
    related_entity_kind: 'over-emission',
    related_entity_id: id,
    target_allocation_id: null,
    target_project_code: null,
    ack_state: 'unread' as const,
    ack_at: null,
    created_at: '2026-06-22T00:00:00Z',
  })

  it('remounts the body when another item of the same kind is selected', async () => {
    const w = mount(InboxDrawer, {
      props: { item: item('9a1e0000-0000-4000-8000-000000000001', 'Ada') },
      global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, UiButton: true, UiBadge: true } },
    })
    const first = w.find('[data-testid="drawer-body"]').element
    await w.setProps({ item: item('9a1e0000-0000-4000-8000-000000000002', 'Grace') })
    expect(w.find('[data-testid="drawer-body"]').element).not.toBe(first)
    expect(w.find('[data-testid="over-emission-facts"]').text()).toContain('Grace')
  })
})
