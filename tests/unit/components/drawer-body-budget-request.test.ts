/*
 * DrawerBodyBudgetRequest — the inbox side of budget requests (spec §5, A10).
 * A manager's item links to the project's Manage drawer; an item that fell
 * back to the region's admins (routing_scope stamped) says so and links there
 * too (the project page opens for an admin in scope); the requester's item
 * states the decision.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DrawerBodyBudgetRequest from '../../../app/components/inbox/DrawerBodyBudgetRequest.vue'

const stubs = { UiButton: { props: ['to'], template: '<a :href="to" data-testid="budget-request-open-project"><slot /></a>' } }
const request = {
  quota_request_id: '9a1e0000-0000-4000-8000-000000000001',
  project_code: 'ACME-1',
  project_name: 'Acme',
  requester_name: 'Ada',
  amount_usd: '50',
  reason: 'Load tests',
}

describe('DrawerBodyBudgetRequest', () => {
  it('a manager’s request item links to the Manage drawer', () => {
    const w = mount(DrawerBodyBudgetRequest, { props: { category: 'quota-request', body: request }, global: { stubs } })
    expect(w.find('[data-testid="budget-request-facts"]').text()).toContain('Ada asked for $50.00 more budget on Acme')
    expect(w.find('[data-testid="budget-request-open-project"]').attributes('href')).toBe('/projects/ACME-1#manage')
    expect(w.find('[data-testid="budget-request-no-manager"]').exists()).toBe(false)
  })

  it('an admin-routed item explains the missing manager and links to the project page, which opens for an admin in scope', () => {
    const w = mount(DrawerBodyBudgetRequest, {
      props: { category: 'quota-request', body: { ...request, routing_scope: 'region:x' } },
      global: { stubs },
    })
    expect(w.find('[data-testid="budget-request-no-manager"]').text()).toContain('where Manage opens for you as an admin')
    expect(w.find('[data-testid="budget-request-open-project"]').attributes('href')).toBe('/projects/ACME-1#manage')
  })

  it('the requester’s decision item names the amount added', () => {
    const w = mount(DrawerBodyBudgetRequest, {
      props: {
        category: 'quota-request-decided',
        body: { ...request, decision: 'approved', amount_usd: '50.00', approved_amount_usd: '40.00', note: 'Half now' },
      },
      global: { stubs },
    })
    const text = w.find('[data-testid="budget-request-decision"]').text()
    expect(text).toContain('$40.00')
    expect(text).toContain('you asked for $50.00')
    expect(w.text()).not.toMatch(/quota/i)
  })
})
