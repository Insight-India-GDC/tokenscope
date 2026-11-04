// @vitest-environment happy-dom
/*
 * ProjectRequestsPanel (My projects) — the requester's own project requests.
 * An admin may change any proposed field on approval, so the proposal is
 * labelled as what was REQUESTED and the created project is named as it is.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import ProjectRequestsPanel from '../../../app/components/projects/ProjectRequestsPanel.vue'

const ID = '9a1e0000-0000-4000-8000-0000000000e1'
const base = {
  id: ID,
  display_name: 'Acme data platform',
  region_code: 'apac',
  unit_name: 'Data',
  budget_usd: '800',
  created_at: '2026-08-01T00:00:00Z',
  decided_at: '2026-08-02T00:00:00Z',
  decision_note: null,
}

function mountPanel(request: Record<string, unknown>) {
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: 't1', role: 'developer' }), ensure: async () => {} }))
  vi.stubGlobal('useFetch', (url: string) =>
    url === '/api/v1/me/project-requests'
      ? { data: ref({ requests: [request] }), refresh: vi.fn() }
      : { data: ref({ can_create_projects: false, pm_own_region_only: false, region_id: 'r' }) },
  )
  return mount(ProjectRequestsPanel, {
    global: {
      stubs: {
        UiButton: { template: '<button><slot /></button>' },
        UiBadge: { template: '<span><slot /></span>' },
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProjectRequestsPanel', () => {
  it('an approved request labels the proposal as requested and links the project as created', () => {
    const w = mountPanel({
      ...base,
      status: 'approved',
      created_project_code: 'ACME-DP',
      created_project_name: 'Acme Data Platform (renamed)',
    })
    expect(w.find(`[data-testid="my-project-request-asked-${ID}"]`).text()).toMatch(/^Requested: Data \(apac\), budget \$800/)
    const created = w.find(`[data-testid="my-project-request-created-${ID}"]`)
    expect(created.text()).toContain('Created as Acme Data Platform (renamed) · ACME-DP')
    expect(created.find('a').attributes('href')).toBe('/projects/ACME-DP')
  })

  it('a pending request has no created project', () => {
    const w = mountPanel({ ...base, status: 'pending', created_project_code: null, created_project_name: null })
    expect(w.find(`[data-testid="my-project-request-asked-${ID}"]`).text()).toContain('Requested:')
    expect(w.find(`[data-testid="my-project-request-created-${ID}"]`).exists()).toBe(false)
  })
})
