// @vitest-environment happy-dom
/*
 * /projects/new and /projects/request — defaults that come from data landing
 * AFTER setup (the picker units, the server clock).
 *
 *   - Server render: Vue runs a watcher's immediate pass during setup and never
 *     again on the server, so a default seeded by a watcher was missing from the
 *     server's HTML while the client (data already in the payload) had it. For
 *     an admin that flipped the route label: "Project manager" on the server,
 *     "Project manager (optional)" on the client — a hydration mismatch. The
 *     render below lands the data between setup and render, exactly as the
 *     server does.
 *   - The request form: when the session region arrived before the units, the
 *     requester's own Business Unit was never selected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSSRApp, defineComponent, h, nextTick, ref, Suspense, type Ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import { resolveServerClock } from '../../../shared/reports/clock'
import NewProjectPage from '../../../app/pages/projects/new.vue'
import RequestPage from '../../../app/pages/projects/request.vue'

const REGION = '9a1e0000-0000-4000-8000-0000000000a1'
const MY_UNIT = '9a1e0000-0000-4000-8000-0000000000b1'
const OTHER_UNIT = '9a1e0000-0000-4000-8000-0000000000b2'
const unitsPayload = {
  units: [
    { id: MY_UNIT, display_name: 'Mine', path: 'a.mine', region_id: REGION, region_code: 'a', region_name: 'A' },
    { id: OTHER_UNIT, display_name: 'Other', path: 'a.other', region_id: REGION, region_code: 'a', region_name: 'A' },
  ],
  my_unit_id: MY_UNIT,
}

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const STUBS = {
  UiPageHead: PASS,
  UiBreadcrumb: true,
  UiCard: PASS,
  UiButton: { template: '<button><slot /></button>' },
  UiEmptyState: PASS,
  NuxtLink: { template: '<a><slot /></a>' },
}

/**
 * Stub the Nuxt globals. `units` is the ref every units fetch returns, so a
 * test decides when the picker data lands. `onFetch` runs at each fetch call,
 * i.e. inside the page's setup.
 */
function stubNuxt(role: string, units: Ref<unknown>, onFetch: () => void = () => {}) {
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', email: 't1@x.test', displayName: 'T One', role, regionId: REGION }),
    ensure: async () => {},
  }))
  vi.stubGlobal('useFetch', (url: string) => {
    onFetch()
    if (url === '/api/v1/pickers/business-units') return { data: units, error: ref(null), pending: ref(false) }
    if (url === '/api/v1/me/capabilities') {
      return { data: ref({ can_create_projects: false, pm_own_region_only: false, region_id: REGION }) }
    }
    return { data: ref(null), error: ref(null), pending: ref(false) }
  })
  vi.stubGlobal('useProjectCreate', () => ({ submitting: ref(false), error: ref(null), submit: vi.fn() }))
  vi.stubGlobal('navigateTo', vi.fn())
  vi.stubGlobal('$fetch', vi.fn())
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/projects/new — the server renders what the client hydrates', () => {
  it('a region admin: picker data landing after setup still selects the region, so the PM label is the admin one', async () => {
    const units = ref<unknown>({ units: [], my_unit_id: null })
    // The server clock lands late too: the period must follow without a watcher.
    const clock = stubServerClock(null)
    let landed = false
    // Queued from inside the page's (post-await) setup, so the data lands once
    // setup has finished and before the render, as on the server.
    stubNuxt('admin', units, () => {
      if (landed) return
      landed = true
      queueMicrotask(() => {
        units.value = unitsPayload
        clock.value.value = resolveServerClock(new Date('2026-08-15T12:00:00Z'))
      })
    })
    const app = createSSRApp({ render: () => h(Suspense, null, { default: () => h(NewProjectPage) }) })
    for (const [name, c] of Object.entries(STUBS)) {
      app.component(name, c === true ? { render: () => null } : c)
    }
    const html = await renderToString(app)
    expect(html).toContain('Project manager (optional)')
    expect(html).toContain('value="2026-08-01"')
  })
})

describe('/projects/request — the requester’s own Business Unit', () => {
  async function mountRequest(units: Ref<unknown>) {
    stubNuxt('developer', units)
    stubServerClock('2026-08-15T12:00:00Z')
    const Parent = defineComponent({
      components: { RequestPage },
      template: '<Suspense><RequestPage /></Suspense>',
    })
    const w = mount(Parent, { global: { stubs: STUBS } })
    await flushPromises()
    return w
  }
  const couSelect = (w: ReturnType<typeof mount>) => w.find('select[data-testid="project-request-cou"]').element as HTMLSelectElement

  it('is selected when the units arrive after the session region', async () => {
    const units = ref<unknown>({ units: [], my_unit_id: null })
    const w = await mountRequest(units)
    units.value = unitsPayload
    await nextTick()
    expect(couSelect(w).value).toBe(MY_UNIT)
  })

  it('never overwrites the person’s own choice when the units refresh', async () => {
    const units = ref<unknown>(unitsPayload)
    const w = await mountRequest(units)
    expect(couSelect(w).value).toBe(MY_UNIT)
    await w.find('select[data-testid="project-request-cou"]').setValue(OTHER_UNIT)
    units.value = { ...unitsPayload }
    await nextTick()
    expect(couSelect(w).value).toBe(OTHER_UNIT)
  })
})
