/*
 * DrawerBodyProjectRequest — the requester's decision item names the project
 * as the admin created it, which may differ from what was asked for.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DrawerBodyProjectRequest from '../../../app/components/inbox/DrawerBodyProjectRequest.vue'

const stubs = { UiButton: { props: ['to'], template: '<a :href="to"><slot /></a>' } }
const decided = { requestId: '9a1e0000-0000-4000-8000-000000000001', displayName: 'Acme data platform', decision: 'approved', projectCode: 'ACME-DP' }

describe('DrawerBodyProjectRequest', () => {
  it('an approval renamed by the admin names both the request and the project created', () => {
    const w = mount(DrawerBodyProjectRequest, {
      props: { category: 'project-request-decided', body: { ...decided, projectName: 'Acme analytics' } },
      global: { stubs },
    })
    const text = w.find('[data-testid="project-request-decision"]').text()
    expect(text).toContain('Your request for Acme data platform was approved')
    expect(text).toContain('Acme analytics (ACME-DP)')
  })

  it('without projectName it names the code only, never the requested name as the created one', () => {
    const w = mount(DrawerBodyProjectRequest, { props: { category: 'project-request-decided', body: decided }, global: { stubs } })
    const text = w.find('[data-testid="project-request-decision"]').text()
    expect(text).toContain('the project is ACME-DP')
    expect(text).not.toContain('Acme data platform (ACME-DP)')
  })
})
