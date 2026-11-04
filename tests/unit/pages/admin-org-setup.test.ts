// @vitest-environment happy-dom
/*
 * /admin/org-setup and its Admin home card. `$fetch` (a small fake server) and
 * `useLazyFetch` are the only fakes; the page, its step components and the
 * composables run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, type Ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import OrgSetupPage from '../../../app/pages/admin/org-setup.vue'
import OrgSetupHomeCard from '../../../app/components/admin/OrgSetupHomeCard.vue'
import type {
  OrgSetupDecision,
  OrgSetupDecisionsResponse,
  OrgSetupPreviewResponse,
  OrgSetupUnitItem,
  OrgSetupUnitResult,
  OrgTreeResponse,
} from '../../../shared/org-setup/contract'
import type { PlacementCheckResponse, PlacementCheckRow } from '../../../shared/placement/placement-check'
import { APAC, EMEA, U_CORE, U_EDGE, U_FAR, U_UNPLACED, checkRow, group, side, tree, uuid } from '../helpers/org-setup-fixture'

interface Call {
  url: string
  method: string
  body: unknown
}

const emptyPreview = (): OrgSetupPreviewResponse => ({ byNode: {}, groups: [], notMoved: {}, manual: [] })

let server: {
  tree: OrgTreeResponse
  decisions: OrgSetupDecisionsResponse
  preview: OrgSetupPreviewResponse
  checkRows: PlacementCheckRow[]
  leaders: Record<string, { id: string; leader_oid: string }[]>
  pass: (body: { retryFailed?: boolean }) => Promise<unknown>
  units: (items: OrgSetupUnitItem[]) => OrgSetupUnitResult[]
  /** DELETE of an owner or a region leader. */
  revoke: () => Promise<unknown>
  search: { oid: string; email: string; display_name: string; department: null; job_title: null }[]
}
let calls: Call[]
const fetchMock = vi.fn()
const lazy = new Map<string, { data: Ref<unknown>; error: Ref<unknown>; refresh: () => Promise<void>; opts: { immediate?: boolean } }>()

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

async function route(url: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const method = opts.method ?? 'GET'
  calls.push({ url, method, body: opts.body })
  if (url.startsWith('/api/v1/admin/directory/search')) return { results: server.search }
  if (url === '/api/v1/admin/org-setup/settings' && method === 'PUT') {
    const body = opts.body as { top?: OrgTreeResponse['settings']['top']; readCadence?: 'month' | 'week' }
    if (body.top) server.tree.settings.top = body.top
    if (body.readCadence) server.tree.settings.readCadence = body.readCadence
    return server.tree.settings
  }
  if (url === '/api/v1/admin/org-setup/preview') return clone(server.preview)
  if (url === '/api/v1/admin/org-setup/units') return { results: server.units((opts.body as { items: OrgSetupUnitItem[] }).items) }
  if (url === '/api/v1/admin/org-setup/dismissals') return { created: true }
  if (url === '/api/v1/admin/placement-check/pass') return server.pass((opts.body ?? {}) as { retryFailed?: boolean })
  if (url === '/api/v1/admin/placement-check' && method === 'GET') {
    return { cycle: null, remaining: 0, failedThisCycle: 0, evidenceAge: { oldest: null, newest: null }, summary: [], rows: server.checkRows } satisfies PlacementCheckResponse
  }
  if (url === '/api/v1/admin/placement-check/apply') {
    const items = (opts.body as { items: { teammateId: string }[] }).items
    return { batchId: uuid(500), results: items.map((i) => ({ teammateId: i.teammateId, outcome: 'moved' })) }
  }
  const leaders = /^\/api\/v1\/admin\/regions\/([^/]+)\/leaders$/.exec(url)
  if (leaders && method === 'GET') return { leaders: server.leaders[decodeURIComponent(leaders[1]!)] ?? [] }
  if (leaders && method === 'POST') return { id: uuid(600) }
  if (/\/leaders\/[^/]+$/.test(url) && method === 'DELETE') return server.revoke()
  if (url === '/api/v1/admin/regions' && method === 'POST') return { id: uuid(800), code: 'x', display_name: 'X' }
  if (/^\/api\/v1\/admin\/org-units\/[^/]+\/owners$/.test(url)) return { id: uuid(601) }
  if (/^\/api\/v1\/admin\/org-units\/[^/]+\/owners\/[^/]+$/.test(url) && method === 'DELETE') return server.revoke()
  throw new Error(`unrouted ${method} ${url}`)
}

const STUBS = {
  UiPageHead: { props: ['title', 'sub', 'eyebrow'], template: '<h1>{{ title }}</h1>' },
  UiCard: { template: '<div><slot /></div>' },
  UiFetchErrorBanner: { props: ['error', 'label'], template: '<div v-if="error" data-testid="fetch-error-banner" />' },
  AdminPageSkeleton: { template: '<div data-testid="admin-skeleton" />' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}

function stubGlobals(role = 'platform-admin') {
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useSession', () => ({ session: ref({ role }) }))
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('useLazyFetch', (url: string, opts: { immediate?: boolean } = {}) => {
    const source = () => (url.endsWith('/tree') ? server.tree : url.endsWith('/decisions') ? server.decisions : url.endsWith('/settings') ? server.tree.settings : null)
    const entry = {
      data: ref<unknown>(opts.immediate === false ? null : clone(source())),
      error: ref<unknown>(null),
      refresh: async () => {
        entry.data.value = clone(source())
      },
      opts,
    }
    lazy.set(url, entry)
    return entry
  })
}

async function mountPage(): Promise<VueWrapper> {
  stubGlobals()
  const w = mount(OrgSetupPage, { global: { stubs: STUBS } })
  await flushPromises()
  return w
}

const tid = (id: string) => `[data-testid="${id}"]`
const postsTo = (pred: (url: string) => boolean, method = 'POST') => calls.filter((c) => c.method === method && pred(c.url))

beforeEach(() => {
  calls = []
  lazy.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(route)
  server = {
    tree: tree(),
    decisions: { read: tree().read, decisions: [] },
    preview: emptyPreview(),
    checkRows: [],
    leaders: { [EMEA]: [{ id: uuid(300), leader_oid: 'oid-e' }], [APAC]: [{ id: uuid(301), leader_oid: 'oid-a' }] },
    pass: async () => ({ checked: 0, errors: 0, remaining: 0 }),
    units: (items) => items.map((i) => ({ ownerOid: i.ownerOid, status: 'created', orgUnitId: `id-${i.ownerOid}`, code: 'x' })),
    revoke: async () => ({ ok: true }),
    search: [{ oid: 'oid-top', email: 'tess@example.com', display_name: 'Tess Top', department: null, job_title: null }],
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ── Step 1 ───────────────────────────────────────────────────────────────────

describe('step 1: top of the organisation', () => {
  async function pickTop(w: VueWrapper) {
    await w.find(tid('org-setup-top-picker-search')).setValue('tess')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    await w.find(tid('org-setup-top-picker-pick-oid-top')).trigger('click')
    await w.find(tid('org-setup-top-save')).trigger('click')
  }

  it('saves the top, reads the directory pass by pass and opens Continue only when nobody is left', async () => {
    vi.useFakeTimers()
    server.tree = tree({ settings: { top: null, readCadence: 'month', updatedAt: null }, nodes: [] })
    const w = await mountPage()
    expect(w.find(tid('org-setup-top')).text()).toContain('Who is at the top of the organisation?')

    let finishSecond!: () => void
    server.pass = async () => {
      if (server.tree.read.remaining === 300) {
        server.tree.read.remaining = 150
        return { checked: 150, errors: 0, remaining: 150 }
      }
      await new Promise<void>((r) => (finishSecond = r))
      server.tree.read.remaining = 0
      return { checked: 150, errors: 0, remaining: 0 }
    }
    const put = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/admin/org-setup/settings' && opts?.method === 'PUT') server.tree.read = { ...server.tree.read, remaining: 300, complete: false }
      return put(url, opts)
    })

    await pickTop(w)
    await flushPromises()
    expect(postsTo((u) => u === '/api/v1/admin/org-setup/settings', 'PUT')[0]!.body).toEqual({
      top: { oid: 'oid-top', name: 'Tess Top', email: 'tess@example.com' },
    })
    expect(w.find(tid('org-setup-read-progress')).text()).toBe('150 of 300 people read.')
    expect(w.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('150')
    expect(w.find(tid('org-setup-read-continue')).attributes('disabled')).toBeDefined()

    finishSecond()
    await flushPromises()
    expect(w.find(tid('org-setup-read-progress')).text()).toBe('300 of 300 people read.')
    expect(w.find(tid('org-setup-read-continue')).attributes('disabled')).toBeUndefined()
    await w.find(tid('org-setup-read-continue')).trigger('click')
    expect(w.find(tid('org-setup-regions')).exists()).toBe(true)
  })

  it('after Stop, Continue stays closed while people are left and Read directory picks up', async () => {
    vi.useFakeTimers()
    server.tree = tree({ settings: { top: null, readCadence: 'month', updatedAt: null } })
    let finish!: () => void
    server.pass = async () => {
      await new Promise<void>((r) => (finish = r))
      server.tree.read = { ...server.tree.read, remaining: 150 }
      return { checked: 150, errors: 0, remaining: 150 }
    }
    const put = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/admin/org-setup/settings' && opts?.method === 'PUT') server.tree.read = { ...server.tree.read, remaining: 300, complete: false }
      return put(url, opts)
    })
    const w = await mountPage()
    await pickTop(w)
    await flushPromises()
    await w.find(tid('org-setup-read-stop')).trigger('click')
    finish()
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/placement-check/pass'))).toHaveLength(1)
    expect(w.find(tid('org-setup-read-continue')).attributes('disabled')).toBeDefined()
    expect(w.find(tid('org-setup-read-continue-reading')).text()).toBe('Read directory (150 left)')
  })

  it('with failed lookups offers Retry failed and Continue without N people instead of Continue', async () => {
    vi.useFakeTimers()
    server.tree = tree({ settings: { top: null, readCadence: 'month', updatedAt: null } })
    server.pass = async (body) => {
      if (body.retryFailed) return { checked: 3, errors: 1, remaining: 0 }
      server.tree.read = { ...server.tree.read, remaining: 0, failed: 3 }
      return { checked: 10, errors: 3, remaining: 0 }
    }
    const w = await mountPage()
    await pickTop(w)
    await flushPromises()

    expect(w.find(tid('org-setup-read-continue')).exists()).toBe(false)
    expect(w.find(tid('org-setup-read-failed')).text()).toContain('3 people could not be read')
    expect(w.find(tid('org-setup-read-continue-without')).text()).toBe('Continue without 3 people')

    await w.find(tid('org-setup-read-retry')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/placement-check/pass')).at(-1)!.body).toEqual({ retryFailed: true })
    expect(w.find(tid('org-setup-retry-result')).text()).toBe('Retried 3: 2 read, 1 still failing.')

    await w.find(tid('org-setup-read-continue-without')).trigger('click')
    expect(w.find(tid('org-setup-regions')).exists()).toBe(true)
  })

  it('Change on the overview reopens step 1 with the current person; keeping them saves nothing', async () => {
    vi.useFakeTimers()
    const w = await mountPage()
    await w.find(tid('org-setup-overview-change-top')).trigger('click')
    expect(w.find(tid('org-setup-top-chosen')).text()).toContain('Tess Top')
    expect(w.find(tid('org-setup-top-save')).text()).toBe('Keep Tess Top')
    await w.find(tid('org-setup-top-save')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/settings'), 'PUT')).toHaveLength(0)
    expect(w.find(tid('org-setup-overview')).exists()).toBe(true)
  })

  it('a different top person is warned about a new directory read, then saved and read', async () => {
    vi.useFakeTimers()
    server.search = [{ oid: 'oid-other', email: 'omar@example.com', display_name: 'Omar Other', department: null, job_title: null }]
    const w = await mountPage()
    await w.find(tid('org-setup-overview-change-top')).trigger('click')
    await w.find(tid('org-setup-top-picker-search')).setValue('omar')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    await w.find(tid('org-setup-top-picker-pick-oid-other')).trigger('click')
    expect(w.find(tid('org-setup-top-change-warning')).exists()).toBe(false)

    await w.find(tid('org-setup-top-save')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-top-change-warning')).text()).toBe('Changing the top person starts a new directory read.')
    expect(postsTo((u) => u.endsWith('/org-setup/settings'), 'PUT')).toHaveLength(0)
    expect(w.find(tid('org-setup-top-save')).text()).toBe('Change and read the directory')

    await w.find(tid('org-setup-top-save')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/settings'), 'PUT')[0]!.body).toEqual({
      top: { oid: 'oid-other', name: 'Omar Other', email: 'omar@example.com' },
    })
    expect(postsTo((u) => u.endsWith('/placement-check/pass'))).toHaveLength(1)
    expect(w.find(tid('org-setup-read')).exists()).toBe(true)

    await w.find(tid('org-setup-top-cancel')).exists()
  })

  it('Cancel leaves the top person alone', async () => {
    const w = await mountPage()
    await w.find(tid('org-setup-overview-change-top')).trigger('click')
    await w.find(tid('org-setup-top-cancel')).trigger('click')
    expect(w.find(tid('org-setup-overview')).exists()).toBe(true)
    expect(postsTo((u) => u.endsWith('/org-setup/settings'), 'PUT')).toHaveLength(0)
  })
})

// ── Step 2 ───────────────────────────────────────────────────────────────────

async function openRegions(): Promise<VueWrapper> {
  const w = await mountPage()
  await w.find(tid('org-setup-overview-regions')).trigger('click')
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return w
}
const lastPreviewBody = () => postsTo((u) => u.endsWith('/org-setup/preview')).at(-1)?.body

describe('step 2: regions', () => {
  it('shows the top person’s larger reports and folds the small ones', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    expect(w.find(tid('org-setup-region-row-oid-a')).exists()).toBe(true)
    expect(w.find(tid('org-setup-region-row-oid-s1')).exists()).toBe(false)
    const more = w.find(tid('org-setup-regions-show-small'))
    expect(more.text()).toBe('Show 2 more people with fewer than 5 users under them (5 people)')
    await more.trigger('click')
    expect(w.find(tid('org-setup-region-row-oid-s1')).exists()).toBe(true)
  })

  it('asks the server what an unsaved pick changes and shows its answer', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    expect(lastPreviewBody()).toEqual({ leaders: [], newUnits: [] })
    server.preview = {
      ...emptyPreview(),
      byNode: { 'oid-a': { regionChanges: 35, unitChanges: 0, groups: [group('move-region', 35, side(APAC, 'APAC', null, null), side(EMEA, 'EMEA', null, null))] } },
    }

    await w.find(tid('org-setup-region-pick-oid-a')).setValue(EMEA)
    await flushPromises()
    expect(w.find(tid('org-setup-preview-status')).text()).toBe('Updating…')
    const before = postsTo((u) => u.endsWith('/preview')).length
    await vi.advanceTimersByTimeAsync(399)
    expect(postsTo((u) => u.endsWith('/preview')).length).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(lastPreviewBody()).toEqual({ leaders: [{ oid: 'oid-a', regionId: EMEA }], newUnits: [] })
    expect(w.find(tid('org-setup-region-change-oid-a')).text()).toContain('35 move from APAC to EMEA')
    expect(w.find(tid('org-setup-preview-status')).text()).toBe('')
    // 5 of 40 are in EMEA today: not "most".
    expect(w.find(tid('org-setup-region-most-oid-a')).exists()).toBe(false)
  })

  it('save revokes the moved leaders first, then assigns, then refetches; nobody moves', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-e')).setValue(APAC)
    await w.find(tid('org-setup-region-pick-oid-a')).setValue(EMEA)
    calls = []
    await w.find(tid('org-setup-regions-save')).trigger('click')
    await flushPromises()

    const writes = calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/preview')).map((c) => `${c.method} ${c.url}`)
    expect(writes).toEqual([
      `DELETE /api/v1/admin/regions/${EMEA}/leaders/${uuid(300)}`,
      `DELETE /api/v1/admin/regions/${APAC}/leaders/${uuid(301)}`,
      `POST /api/v1/admin/regions/${APAC}/leaders`,
      `POST /api/v1/admin/regions/${EMEA}/leaders`,
    ])
    expect(calls.find((c) => c.method === 'POST' && c.url === `/api/v1/admin/regions/${EMEA}/leaders`)!.body).toEqual({
      leader_oid: 'oid-a',
      leader_email: 'oid-a@example.com',
      kind: 'region-svp',
      display_name: 'Ada Apac',
    })
    expect(calls.some((c) => c.url.includes('/placement-check/apply'))).toBe(false)
    expect(w.find(tid('org-setup-regions-saved')).exists()).toBe(true)
  })

  it('expands a person’s managers in place, and an owner’s row says their people follow the unit', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-a')).setValue('__split')
    expect(w.find(tid('org-setup-region-row-oid-a2')).exists()).toBe(true)
    expect(w.find(tid('org-setup-region-owns-oid-a2')).text()).toBe('Their people follow their Business Unit, Core.')
    // The split option is not a pick.
    expect(lastPreviewBody()).toEqual({ leaders: [], newUnits: [] })
  })

  it('creates a new region inline and picks it', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-s1')).exists()
    await w.find(tid('org-setup-region-pick-oid-e')).setValue('__new')
    await w.find(tid('org-setup-new-region-name')).setValue('North America')
    expect((w.find(tid('org-setup-new-region-code')).element as HTMLInputElement).value).toBe('north-america')
    await w.find(tid('org-setup-new-region')).trigger('submit')
    await flushPromises()
    expect(postsTo((u) => u === '/api/v1/admin/regions')[0]!.body).toEqual({ code: 'north-america', display_name: 'North America' })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(lastPreviewBody()).toEqual({ leaders: [{ oid: 'oid-e', regionId: uuid(800) }], newUnits: [] })
  })
})

// ── Step 3 ───────────────────────────────────────────────────────────────────

async function openUnits(regionId = APAC): Promise<VueWrapper> {
  const w = await mountPage()
  await w.find(tid(`org-setup-region-card-units-${regionId}`)).trigger('click')
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return w
}

describe('step 3: business units', () => {
  it('locks existing owners in this region, disables owners elsewhere, and shows saved coverage', async () => {
    vi.useFakeTimers()
    const w = await openUnits()
    const core = w.find(tid('org-setup-unit-check-oid-a2')).element as HTMLInputElement
    expect(core.checked).toBe(true)
    expect(core.disabled).toBe(true)
    expect(w.find(tid('org-setup-unit-owns-oid-a2')).text()).toContain('Owns Core.')
    expect(w.find(tid('org-setup-unit-owns-oid-a2')).find('a').attributes('href')).toBe(`/admin/regions/${APAC}`)
    const far = w.find(tid('org-setup-unit-check-oid-a3')).element as HTMLInputElement
    expect(far.disabled).toBe(true)
    expect(far.checked).toBe(false)
    expect(w.find(tid('org-setup-unit-elsewhere-oid-a3')).text()).toBe('Owns Far in EMEA.')
    expect(w.find(tid('org-setup-units-progress')).text()).toBe('14 of 40 in a Business Unit today')
    expect(w.find(tid('org-setup-unit-row-oid-a1a')).attributes('style')).toContain('padding-left: 72px')
  })

  it('does not list people nobody reports to', async () => {
    vi.useFakeTimers()
    const w = await openUnits()
    expect(w.find(tid('org-setup-unit-row-oid-a1a1')).exists()).toBe(false)
    expect((w.find(tid('org-setup-unit-check-oid-a1a')).element as HTMLInputElement).disabled).toBe(false)
  })

  it('says whether a region has no leader or a leader outside the tree', async () => {
    vi.useFakeTimers()
    const AMER = uuid(777)
    server.tree.regions.push({ id: AMER, name: 'Americas', users: 0, inUnit: 0, leaders: [] })
    const w = await openUnits(AMER)
    expect(w.find(tid('org-setup-units-empty')).text()).toBe('This region has no leader yet. Pick one on the Regions step first.')
    server.tree.regions[2]!.leaders = [{ leaderId: uuid(302), oid: 'oid-outside', name: 'Ola Outside', email: null }]
    await lazy.get('/api/v1/admin/org-setup/tree')!.refresh()
    await flushPromises()
    expect(w.find(tid('org-setup-units-empty')).text()).toBe("No one to tick here: this region's leaders are outside the top person's line, or nobody reports to them.")
  })

  it('a unit ticked on one tab is neither ticked nor saved under another', async () => {
    vi.useFakeTimers()
    const w = await openUnits()
    await w.find(tid('org-setup-unit-check-oid-a1a')).setValue(true)
    // Ben Cloud becomes EMEA's leader: Cat Lee now shows on the EMEA tab too.
    await w.find(tid('org-setup-step-regions')).trigger('click')
    await w.find(tid('org-setup-region-pick-oid-a')).setValue('__split')
    await w.find(tid('org-setup-region-pick-oid-a1')).setValue(EMEA)
    await w.find(tid('org-setup-step-units')).trigger('click')
    await w.find(tid(`org-setup-units-tab-${EMEA}`)).trigger('click')
    expect(w.find(tid('org-setup-unit-row-oid-a1a')).exists()).toBe(true)
    expect((w.find(tid('org-setup-unit-check-oid-a1a')).element as HTMLInputElement).checked).toBe(false)
    expect(w.find(tid('org-setup-unit-name-oid-a1a')).exists()).toBe(false)

    await w.find(tid('org-setup-units-save')).trigger('click')
    await flushPromises()
    const sent = postsTo((u) => u.endsWith('/org-setup/units')).map((c) => (c.body as { items: OrgSetupUnitItem[] }).items).flat()
    expect(sent).toEqual([{ ownerOid: 'oid-a1a', name: "Cat Lee's team", regionId: APAC, parentUnitId: null }])
  })

  it('ticking drafts a unit with a default name, nests it, and previews it', async () => {
    vi.useFakeTimers()
    const w = await openUnits()
    await w.find(tid('org-setup-unit-check-oid-a1')).setValue(true)
    await w.find(tid('org-setup-unit-check-oid-a1a')).setValue(true)
    await w.find(tid('org-setup-unit-check-oid-a2a')).setValue(true)

    expect((w.find(tid('org-setup-unit-name-oid-a1')).element as HTMLInputElement).value).toBe('Cloud & Data')
    expect((w.find(tid('org-setup-unit-name-oid-a1a')).element as HTMLInputElement).value).toBe("Cat Lee's team")
    expect(w.find(tid('org-setup-unit-parent-oid-a1')).text()).toBe("New unit inside APAC's default unit")
    expect(w.find(tid('org-setup-unit-parent-oid-a1a')).text()).toBe('New unit inside Cloud & Data')
    expect(w.find(tid('org-setup-unit-parent-oid-a2a')).text()).toBe('New unit inside Core')

    await w.find(tid('org-setup-unit-name-oid-a1')).setValue('Cloud')
    expect(w.find(tid('org-setup-unit-parent-oid-a1a')).text()).toBe('New unit inside Cloud')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect((lastPreviewBody() as { newUnits: unknown[] }).newUnits).toEqual([
      { key: 'new:oid-a1', ownerOid: 'oid-a1', regionId: APAC, name: 'Cloud' },
      { key: 'new:oid-a1a', ownerOid: 'oid-a1a', regionId: APAC, name: "Cat Lee's team" },
      { key: 'new:oid-a2a', ownerOid: 'oid-a2a', regionId: APAC, name: "Eve Ng's team" },
    ])
  })

  it('a save whose reply was lost still counts once the tree shows the owner owning the unit', async () => {
    vi.useFakeTimers()
    // The first POST committed but its reply never arrived: the retry is refused, and
    // the refreshed tree now shows Eve owning a unit in APAC.
    server.units = (items) => {
      const node = server.tree.nodes.find((n) => n.oid === 'oid-a2a')!
      node.owns = [{ orgUnitId: 'id-lost', name: "Eve Ng's team", regionId: APAC }]
      return items.map((i) => ({ ownerOid: i.ownerOid, status: 'refused', reason: 'already-owns-a-bu', detail: 'Eve Ng already owns a unit.' }))
    }
    const w = await openUnits()
    await w.find(tid('org-setup-unit-check-oid-a2a')).setValue(true)
    await w.find(tid('org-setup-units-save')).trigger('click')
    await flushPromises()

    expect(w.find(tid('org-setup-unit-error-oid-a2a')).exists()).toBe(false)
    expect(w.find(tid('org-setup-unit-owns-oid-a2a')).text()).toContain("Owns Eve Ng's team.")
    expect((w.find(tid('org-setup-unit-check-oid-a2a')).element as HTMLInputElement).disabled).toBe(true)
    // Nothing is left to send: a second save makes no request.
    const before = postsTo((u) => u.endsWith('/org-setup/units')).length
    await w.find(tid('org-setup-units-save')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/units')).length).toBe(before)
  })

  it('saves parents before children and lists a refusal on its row', async () => {
    vi.useFakeTimers()
    server.units = (items) =>
      items.map((i) =>
        i.ownerOid === 'oid-a2a'
          ? { ownerOid: i.ownerOid, status: 'refused', reason: 'already-owns-a-bu', detail: 'Eve Ng already owns Ops.' }
          : { ownerOid: i.ownerOid, status: 'created', orgUnitId: `id-${i.ownerOid}`, code: 'x' },
      )
    const w = await openUnits()
    await w.find(tid('org-setup-unit-check-oid-a1')).setValue(true)
    await w.find(tid('org-setup-unit-check-oid-a1a')).setValue(true)
    await w.find(tid('org-setup-unit-check-oid-a2a')).setValue(true)
    await w.find(tid('org-setup-units-save')).trigger('click')
    await flushPromises()

    const bodies = postsTo((u) => u.endsWith('/org-setup/units')).map((c) => (c.body as { items: OrgSetupUnitItem[] }).items)
    expect(bodies).toEqual([
      [
        { ownerOid: 'oid-a1', name: 'Cloud & Data', regionId: APAC, parentUnitId: null },
        { ownerOid: 'oid-a2a', name: "Eve Ng's team", regionId: APAC, parentUnitId: U_CORE },
      ],
      [{ ownerOid: 'oid-a1a', name: "Cat Lee's team", regionId: APAC, parentUnitId: 'id-oid-a1' }],
    ])
    expect(w.find(tid('org-setup-unit-error-oid-a2a')).text()).toBe('Eve Ng already owns Ops.')
    expect((w.find(tid('org-setup-unit-check-oid-a2a')).element as HTMLInputElement).checked).toBe(true)
    expect((w.find(tid('org-setup-unit-check-oid-a1')).element as HTMLInputElement).checked).toBe(false)
  })
})

// ── Step 4 ───────────────────────────────────────────────────────────────────

const T_MANUAL = uuid(9001)

async function openReview(): Promise<VueWrapper> {
  server.preview = {
    byNode: {},
    groups: [
      group('place', 12, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_CORE, 'Core')),
      group('move-region', 5, side(APAC, 'APAC', U_CORE, 'Core'), side(EMEA, 'EMEA', U_EDGE, 'Edge')),
      group('ok', 50, side(APAC, 'APAC', U_CORE, 'Core'), side(APAC, 'APAC', U_CORE, 'Core')),
    ],
    notMoved: { 'needs-owner': 7, 'lookup-failed': 2 },
    manual: [{ teammateId: T_MANUAL, name: 'Max Manual', email: 'max@example.com', from: 'APAC · Core', to: 'EMEA · Edge' }],
  }
  const w = await openRegions()
  await w.find(tid('org-setup-step-review')).trigger('click')
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return w
}

/** Applicable in the live check, but in none of the groups the Review step shows (Unplaced → Edge, APAC). */
const unrelated = (n: number) =>
  checkRow(n, 'place', { derived: { regionId: APAC, regionName: 'APAC', orgUnitId: U_EDGE, orgUnitName: 'Edge', onHolding: false, step: 'chain-unit' } })
const applies = () => postsTo((u) => u.endsWith('/placement-check/apply')).map((c) => (c.body as { items: { teammateId: string; confirmManual?: boolean }[] }).items)

describe('step 4: review and apply', () => {
  it('lists the move groups with filtered See who links, the region-move note, manual people unticked and what is not moved', async () => {
    vi.useFakeTimers()
    const w = await openReview()
    const groups = w.findAll('[data-testid^="org-setup-review-group-"]')
    expect(groups.map((g) => g.findAll('span').map((s) => s.text()).slice(0, 2))).toEqual([
      ['12', 'APAC · Unplaced → APAC · Core'],
      ['5', 'APAC · Core → EMEA · Edge'],
    ])
    expect(w.find(tid('org-setup-review-see-who-1')).attributes('href')).toBe(
      `/admin/placement-check?verdict=move-region&current=${APAC}&derived=${EMEA}&currentUnit=${U_CORE}&derivedUnit=${U_EDGE}`,
    )
    expect(w.find(tid('org-setup-review-region-note')).text()).toBe(
      'Each person is signed out of the web app once. Reports show their usage, including what they have already recorded, where they sit now.',
    )
    expect((w.find(tid(`org-setup-review-manual-${T_MANUAL}`)).element as HTMLInputElement).checked).toBe(false)
    const notMoved = w.find(tid('org-setup-review-not-moved-needs-owner'))
    expect(notMoved.text()).toContain('7')
    expect(notMoved.find('a').attributes('href')).toBe('/admin/placement-check?verdict=needs-owner')
    expect(w.find(tid('org-setup-review-apply')).text()).toBe('Save and move 17 people')
  })

  it('asks once with the live count, then moves only the rows in the shown groups, in batches of 200', async () => {
    vi.useFakeTimers()
    server.checkRows = [
      ...Array.from({ length: 205 }, (_, i) => checkRow(i + 1, 'place')),
      checkRow(9001, 'manual'),
      checkRow(9002, 'needs-owner'),
      unrelated(9003),
      checkRow(9004, 'move-region', { current: { regionId: APAC, regionName: 'APAC', orgUnitId: U_CORE, orgUnitName: 'Core', onHolding: false }, derived: { regionId: EMEA, regionName: 'EMEA', orgUnitId: U_EDGE, orgUnitName: 'Edge', onHolding: false, step: 'chain-unit' } }),
    ]
    const w = await openReview()
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    expect(applies()).toHaveLength(0)
    expect(w.find(tid('org-setup-move-title')).text()).toBe('Move 206 people?')
    expect(w.find(tid('org-setup-move-text')).text()).toBe('1 of them change region and are signed out of the web app once. This cannot be undone.')

    await w.find(tid('org-setup-move-cancel')).trigger('click')
    expect(w.find(tid('org-setup-move-confirm')).exists()).toBe(false)
    expect(applies()).toHaveLength(0)

    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    await w.find(tid('org-setup-move-go')).trigger('click')
    await flushPromises()
    expect(applies().map((a) => a.length)).toEqual([200, 6])
    const sent = applies().flat().map((i) => i.teammateId)
    expect(sent).not.toContain(uuid(9003))
    expect(sent).not.toContain(T_MANUAL)
    expect(sent).toContain(uuid(9004))
    expect(w.find(tid('org-setup-review-result')).text()).toBe('206 people moved.')
    expect(w.find(tid('org-setup-move-confirm')).exists()).toBe(false)

    calls = []
    // The preview re-reads after a move; Save and move waits for it.
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    await w.find(tid(`org-setup-review-manual-${T_MANUAL}`)).setValue(true)
    expect(w.find(tid('org-setup-review-apply')).text()).toBe('Save and move 18 people')
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    await w.find(tid('org-setup-move-go')).trigger('click')
    await flushPromises()
    expect(applies().map((a) => a.length)).toEqual([200, 7])
    expect(applies().flat().find((i) => i.teammateId === T_MANUAL)).toMatchObject({ confirmManual: true })
  })

  it('a group aimed at a unit created on save matches that unit’s new id in the live check', async () => {
    vi.useFakeTimers()
    const w = await openUnits()
    await w.find(tid('org-setup-unit-check-oid-a1')).setValue(true)
    server.preview = {
      ...emptyPreview(),
      groups: [group('place', 1, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', 'new:oid-a1', 'Cloud & Data'))],
    }
    server.checkRows = [
      checkRow(1, 'place', { derived: { regionId: APAC, regionName: 'APAC', orgUnitId: 'id-oid-a1', orgUnitName: 'Cloud & Data', onHolding: false, step: 'chain-unit' } }),
      unrelated(2),
    ]
    // The tick's preview (debounced) must land before Review reads its groups.
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    await w.find(tid('org-setup-step-review')).trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    // Unsaved: the unit has no id, so no placement-check filter can name it. No link
    // (a wider one would show other groups' people), just the count and the note.
    expect(w.find(tid('org-setup-review-group-0')).text()).toContain('1')
    expect(w.find(tid('org-setup-review-see-who-0')).exists()).toBe(false)
    expect(w.find(tid('org-setup-review-save-first-0')).text()).toBe('Save first to see who')
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/units'))).toHaveLength(1)
    // Saved: the group now names the unit by its id, and the link carries it.
    expect(w.find(tid('org-setup-review-save-first-0')).exists()).toBe(false)
    expect(w.find(tid('org-setup-review-see-who-0')).attributes('href')).toBe(
      `/admin/placement-check?verdict=place&current=${APAC}&derived=${APAC}&currentUnit=${U_UNPLACED}&derivedUnit=id-oid-a1`,
    )
    expect(w.find(tid('org-setup-move-title')).text()).toBe('Move 1 person?')
    await w.find(tid('org-setup-move-go')).trigger('click')
    await flushPromises()
    expect(applies().flat().map((i) => i.teammateId)).toEqual([uuid(1)])
  })

  it('with nobody in the shown groups waiting, says so and moves nobody', async () => {
    vi.useFakeTimers()
    server.checkRows = [unrelated(1)]
    const w = await openReview()
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-move-confirm')).exists()).toBe(false)
    expect(w.find(tid('org-setup-review-error')).text()).toContain('Nobody was moved.')
    expect(applies()).toHaveLength(0)
  })

  it('saves an unsaved leader pick before reading who moves', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-s1')).exists()
    await w.find(tid('org-setup-regions-show-small')).trigger('click')
    await w.find(tid('org-setup-region-pick-oid-s1')).setValue(EMEA)
    await w.find(tid('org-setup-step-review')).trigger('click')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    calls = []
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    const order = calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/preview')).map((c) => c.url)
    expect(order[0]).toBe(`/api/v1/admin/regions/${EMEA}/leaders`)
    expect(calls.findIndex((c) => c.url === '/api/v1/admin/placement-check')).toBeGreaterThan(0)
  })

  it('a failed preview offers Retry, and the apply button is usable once it works', async () => {
    vi.useFakeTimers()
    const good = fetchMock.getMockImplementation()!
    let fail = true
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url.endsWith('/org-setup/preview') && fail) throw { statusCode: 500, data: { data: { detail: 'Preview broke.' } } }
      return good(url, opts)
    })
    const w = await openReview()
    expect(w.find(tid('org-setup-review-status')).text()).toContain('Preview broke.')
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeDefined()

    fail = false
    await w.find(tid('org-setup-review-retry')).trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(w.find(tid('org-setup-review-status')).text()).toBe('')
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeUndefined()
    expect(w.find(tid('org-setup-review-apply')).text()).toBe('Save and move 17 people')
  })

  it('with nothing left to save or move, offers only the way back to the overview', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    server.preview = { ...emptyPreview(), notMoved: { 'no-signal': 3 } }
    await w.find(tid('org-setup-step-review')).trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(w.find(tid('org-setup-review-apply')).exists()).toBe(false)
    expect(w.find(tid('org-setup-review-later')).exists()).toBe(false)
    await w.find(tid('org-setup-review-done')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-overview')).exists()).toBe(true)
  })

  it('Move people later returns to the overview without moving anyone', async () => {
    vi.useFakeTimers()
    const w = await openReview()
    await w.find(tid('org-setup-review-later')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-overview')).exists()).toBe(true)
    expect(calls.some((c) => c.url.includes('/placement-check/apply'))).toBe(false)
  })

  it('Move people later saves the unsaved choices first, and stays here with the error when one does not save', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-a')).setValue(EMEA)
    await w.find(tid('org-setup-step-review')).trigger('click')
    const good = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === `/api/v1/admin/regions/${EMEA}/leaders` && opts?.method === 'POST') {
        calls.push({ url, method: 'POST', body: opts.body })
        throw { statusCode: 409, data: { data: { detail: 'Not today.' } } }
      }
      return good(url, opts)
    })
    calls = []
    await w.find(tid('org-setup-review-later')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u === `/api/v1/admin/regions/${EMEA}/leaders`)).toHaveLength(1)
    expect(w.find(tid('org-setup-overview')).exists()).toBe(false)
    expect(w.find(tid('org-setup-review-error')).text()).toBe('Some region leaders were not saved. See the Regions step.')

    fetchMock.mockImplementation(good)
    calls = []
    await w.find(tid('org-setup-review-later')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u === `/api/v1/admin/regions/${EMEA}/leaders`)[0]!.body).toMatchObject({ leader_oid: 'oid-a' })
    expect(calls.some((c) => c.url.includes('/placement-check/apply'))).toBe(false)
    expect(w.find(tid('org-setup-overview')).exists()).toBe(true)
  })

  it('Save and move waits for the preview: closed while one is loading, and after one failed', async () => {
    vi.useFakeTimers()
    const w = await openReview()
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeUndefined()

    await w.find(tid('org-setup-step-regions')).trigger('click')
    await w.find(tid('org-setup-region-pick-oid-a')).setValue(EMEA)
    await w.find(tid('org-setup-step-review')).trigger('click')
    expect(w.find(tid('org-setup-review-status')).text()).toBe('Updating…')
    expect(w.find(tid('org-setup-review-groups')).exists()).toBe(true)
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeUndefined()

    const good = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url.endsWith('/org-setup/preview')) throw { statusCode: 500, data: { data: { detail: 'Preview broke.' } } }
      return good(url, opts)
    })
    await w.find(tid('org-setup-step-regions')).trigger('click')
    await w.find(tid('org-setup-region-pick-oid-a')).setValue(APAC)
    await w.find(tid('org-setup-step-review')).trigger('click')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    // The last good preview is still on screen, and is not what the choices say now.
    expect(w.find(tid('org-setup-review-status')).text()).toContain('Preview broke.')
    expect(w.find(tid('org-setup-review-groups')).exists()).toBe(true)
    expect(w.find(tid('org-setup-review-apply')).attributes('disabled')).toBeDefined()
    await w.find(tid('org-setup-review-apply')).trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url === '/api/v1/admin/placement-check')).toBe(false)
  })
})

describe('draft choices while a save is running', () => {
  it('a leader picked while a save is running stays in the draft and goes with the next save', async () => {
    vi.useFakeTimers()
    const w = await openRegions()
    await w.find(tid('org-setup-region-pick-oid-a')).setValue(EMEA)
    let finish!: (v: unknown) => void
    const good = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === `/api/v1/admin/regions/${EMEA}/leaders` && opts?.method === 'POST') return new Promise((r) => (finish = r))
      return good(url, opts)
    })
    await w.find(tid('org-setup-regions-save')).trigger('click')
    await flushPromises()
    expect(finish).toBeDefined()

    await w.find(tid('org-setup-region-pick-oid-e')).setValue(APAC)
    finish({ id: uuid(600) })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect((lastPreviewBody() as { leaders: unknown[] }).leaders).toEqual([{ oid: 'oid-e', regionId: APAC }])

    fetchMock.mockImplementation(good)
    calls = []
    await w.find(tid('org-setup-regions-save')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u === `/api/v1/admin/regions/${APAC}/leaders`)[0]!.body).toMatchObject({ leader_oid: 'oid-e' })
  })
})

// ── Overview ─────────────────────────────────────────────────────────────────

function decision(kind: OrgSetupDecision['kind'], data: Record<string, unknown>): OrgSetupDecision {
  return { kind, subjectKey: `key-${kind}`, title: `Title ${kind}`, detail: `Detail ${kind}`, data }
}
const movesGroup = group('place', 1, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_CORE, 'Core'))
const T_OLD_OWNER = uuid(7001)
const L_OLD = uuid(7002)
function allDecisions(): OrgSetupDecision[] {
  return [
    decision('moves-waiting', { count: 1, groups: [movesGroup] }),
    decision('new-team', { oid: 'oid-a1a', name: 'Cat Lee', regionId: APAC, department: null, parentUnitId: U_CORE }),
    decision('new-head', { oid: 'oid-s1', name: 'Hal Small', regionId: APAC, regionName: 'APAC', count: 2 }),
    decision('owner-left', { oid: 'old-owner', name: 'Old Owner', orgUnitId: U_CORE, unitName: 'Core', regionId: APAC, ownerTeammateId: T_OLD_OWNER }),
    decision('leader-left', { oid: 'old-lead', name: 'Old Lead', regionId: EMEA, regionName: 'EMEA', leaderId: L_OLD }),
    decision('no-placement', { oid: 'oid-a1a', name: 'Cat Lee' }),
    decision('not-read', {}),
    decision('outside-top', {}),
    decision('unit-under-other-region', { orgUnitId: U_FAR, unitName: 'Far', regionId: EMEA }),
  ]
}

describe('overview', () => {
  it('shows the top person, a finished read, the cadence and a card per region from the server’s coverage', async () => {
    server.tree.read = { ...server.tree.read, failed: 4 }
    server.tree.regions[1]!.users = 0
    const w = await mountPage()
    expect(w.find(tid('org-setup-overview-top')).text()).toContain('Top of the organisation: Tess Top.')
    expect(w.find(tid('org-setup-overview-read')).text()).toMatch(/^Directory read .* ago\. 4 people not read\.$/)
    expect(w.find(tid('org-setup-overview-read-button')).exists()).toBe(false)
    expect(w.find(tid('org-setup-cadence-month')).attributes('aria-pressed')).toBe('true')
    expect(w.find(tid(`org-setup-region-card-leaders-${APAC}`)).text()).toBe('Led by Ada Apac')
    expect(w.find(tid(`org-setup-region-card-pct-${APAC}`)).text()).toBe('35% in a Business Unit')
    expect(w.find(tid(`org-setup-region-card-pct-${EMEA}`)).text()).toBe('Nobody here yet')

    await w.find(tid('org-setup-cadence-week')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/settings'), 'PUT')[0]!.body).toEqual({ readCadence: 'week' })
    expect(w.find(tid('org-setup-cadence-week')).attributes('aria-pressed')).toBe('true')
  })

  it('a leader is read from the leader table, not the tree; a read still running says what is left', async () => {
    server.tree.read = { ...server.tree.read, remaining: 150, complete: false }
    server.tree.regions[0]!.leaders = []
    server.tree.regions[1]!.leaders = [{ leaderId: uuid(302), oid: 'oid-outside', name: 'Ola Outside', email: null }]
    const w = await mountPage()
    expect(w.find(tid('org-setup-overview-read')).text()).toMatch(/^Directory read started .* ago, 150 people left to read\./)
    expect(w.find(tid('org-setup-overview-read-button')).text()).toBe('Read directory')
    // Ada leads APAC in the tree, but the leader table says nobody does; Ola is not in the tree at all.
    expect(w.find(tid(`org-setup-region-card-leaders-${APAC}`)).text()).toBe('No leader yet')
    expect(w.find(tid(`org-setup-region-card-leaders-${EMEA}`)).text()).toBe('Led by Ola Outside')
  })

  it('says nothing needs you when there are no decisions, and … while they load', async () => {
    const w = await mountPage()
    expect(w.find(tid('org-setup-decisions-title')).text()).toBe('For you to decide (0)')
    expect(w.find(tid('org-setup-decisions-empty')).text()).toBe(
      'Nothing needs you right now. New people are placed from their manager when they first sign in; anyone the directory cannot place shows up here.',
    )
    server.decisions = null as unknown as OrgSetupDecisionsResponse
    const loading = await mountPage()
    expect(loading.find(tid('org-setup-decisions-title')).text()).toBe('For you to decide (…)')
    expect(loading.find(tid('org-setup-decisions-empty')).exists()).toBe(false)
  })

  it('renders every decision kind with its own actions', async () => {
    server.decisions.decisions = allDecisions()
    server.checkRows = [checkRow(1, 'place')]
    const w = await mountPage()
    expect(w.find(tid('org-setup-decisions-title')).text()).toBe('For you to decide (9)')
    expect(w.find(tid('org-setup-decisions-empty')).exists()).toBe(false)
    const card = (k: string) => w.find(tid(`org-setup-decision-${k}`))
    for (const d of allDecisions()) expect(card(d.kind).text()).toContain(`Title ${d.kind}`)
    expect(card('moves-waiting').find(tid('org-setup-decision-move')).text()).toBe('Move 1 person')
    expect(card('moves-waiting').find(tid('org-setup-decision-review')).text()).toBe('Review one by one')
    const groupHref = `/admin/placement-check?verdict=place&current=${APAC}&derived=${APAC}&currentUnit=${U_UNPLACED}&derivedUnit=${U_CORE}`
    expect(card('moves-waiting').find(tid('org-setup-decision-review')).attributes('href')).toBe(groupHref)
    expect(card('moves-waiting').find(tid('org-setup-decision-see-who-0')).attributes('href')).toBe(groupHref)
    expect(card('new-team').find(tid('org-setup-decision-create-unit')).text()).toBe('Create a Business Unit for Cat Lee')
    expect(card('new-team').find(tid('org-setup-decision-leave')).text()).toBe('Leave them until the next read')
    expect(card('new-head').find(tid('org-setup-decision-review-regions')).text()).toBe('Review on the Regions step')
    expect(card('new-head').find(tid('org-setup-decision-leave')).text()).toBe('Leave it until the next read')
    expect(card('owner-left').find(tid('org-setup-decision-choose')).text()).toBe('Choose a new owner')
    expect(card('owner-left').find('a').text()).toBe('Open the region')
    expect(card('owner-left').find('a').attributes('href')).toBe(`/admin/regions/${APAC}`)
    expect(card('leader-left').find(tid('org-setup-decision-choose')).text()).toBe('Choose a new leader')
    expect(card('no-placement').find(tid('org-setup-decision-pick-region')).exists()).toBe(true)
    expect(card('not-read').find(tid('org-setup-decision-retry')).exists()).toBe(true)
    expect(card('outside-top').findAll('button')).toHaveLength(0)
    expect(card('unit-under-other-region').find(tid('org-setup-decision-keep')).text()).toBe('Keep it until the next read')
    expect(card('unit-under-other-region').find('a').text()).toBe('Open the region')
  })

  it('counts the live rows of the group on the button, asks once, and moves only those rows', async () => {
    server.decisions.decisions = [decision('moves-waiting', { count: 1, groups: [movesGroup] })]
    server.checkRows = [
      checkRow(1, 'place'),
      checkRow(2, 'move-region', { derived: { regionId: EMEA, regionName: 'EMEA', orgUnitId: U_EDGE, orgUnitName: 'Edge', onHolding: false, step: 'chain-unit' } }),
      checkRow(3, 'manual'),
      checkRow(4, 'place'),
    ]
    const w = await mountPage()
    // The stored count says 1; the live check has 2 in this group and 1 applicable row outside it.
    expect(w.find(tid('org-setup-decision-move')).text()).toBe('Move 2 people')
    await w.find(tid('org-setup-decision-move')).trigger('click')
    await flushPromises()
    expect(applies()).toHaveLength(0)
    expect(w.find(tid('org-setup-move-title')).text()).toBe('Move 2 people?')
    await w.find(tid('org-setup-move-go')).trigger('click')
    await flushPromises()
    expect(applies().flat().map((i) => i.teammateId)).toEqual([uuid(1), uuid(4)])
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe('2 people moved.')
    expect(w.find(tid('org-setup-move-confirm')).exists()).toBe(false)
  })

  it('new team: Create opens a form with the name and where the unit sits; only Create posts, with the typed name', async () => {
    server.decisions.decisions = [
      decision('new-team', { oid: 'oid-a1a', name: 'Cat Lee', regionId: APAC, department: null, parentUnitId: U_CORE, parentUnitName: 'APAC (default)' }),
    ]
    const w = await mountPage()
    expect(w.find(tid('org-setup-decision-create-form')).exists()).toBe(false)
    await w.find(tid('org-setup-decision-create-unit')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/units'))).toHaveLength(0)
    expect((w.find(tid('org-setup-decision-create-name')).element as HTMLInputElement).value).toBe("Cat Lee's team")
    expect(w.find(tid('org-setup-decision-create-parent')).text()).toBe('It will sit inside APAC (default).')

    await w.find(tid('org-setup-decision-create-cancel')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-decision-create-form')).exists()).toBe(false)
    expect(postsTo((u) => u.endsWith('/org-setup/units'))).toHaveLength(0)

    await w.find(tid('org-setup-decision-create-unit')).trigger('click')
    await w.find(tid('org-setup-decision-create-name')).setValue('  Platform Engineering ')
    await w.find(tid('org-setup-decision-create-form')).trigger('submit')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/units')).map((c) => c.body)).toEqual([
      { items: [{ ownerOid: 'oid-a1a', name: 'Platform Engineering', regionId: APAC, parentUnitId: U_CORE }] },
    ])
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe('Created Platform Engineering. Nobody has moved yet; their moves wait here.')
    expect(w.find(tid('org-setup-decision-create-form')).exists()).toBe(false)
  })

  it('new team: the form prefills the manager’s department, and can be left until a later read', async () => {
    server.decisions.decisions = [decision('new-team', { oid: 'oid-a1', name: 'Ben Cloud', regionId: APAC, department: 'Cloud & Data' })]
    const w = await mountPage()
    await w.find(tid('org-setup-decision-create-unit')).trigger('click')
    expect((w.find(tid('org-setup-decision-create-name')).element as HTMLInputElement).value).toBe('Cloud & Data')
    // No unit named by the server: the line names the region rather than guessing a unit.
    expect(w.find(tid('org-setup-decision-create-parent')).text()).toBe('It will sit inside APAC.')
    await w.find(tid('org-setup-decision-create-name')).setValue('   ')
    expect(w.find(tid('org-setup-decision-create-go')).attributes('disabled')).toBeDefined()
    await w.find(tid('org-setup-decision-leave')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/dismissals'))[0]!.body).toEqual({ kind: 'new-team', subjectKey: 'key-new-team' })
    expect(postsTo((u) => u.endsWith('/org-setup/units'))).toHaveLength(0)
  })

  it('new team with no region yet: no Create, a link to pick a region at that person', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = [decision('new-team', { oid: 'oid-a1a', name: 'Cat Lee', regionId: null, department: null })]
    const w = await mountPage()
    const card = w.find(tid('org-setup-decision-new-team'))
    expect(card.find(tid('org-setup-decision-create-unit')).exists()).toBe(false)
    expect(card.text()).toContain('Detail new-team')
    await card.find(tid('org-setup-decision-pick-region')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-region-row-oid-a1a')).exists()).toBe(true)
  })

  it('new team: a refused unit is shown on the card', async () => {
    server.decisions.decisions = [decision('new-team', { oid: 'oid-a1a', name: 'Cat Lee', regionId: APAC })]
    server.units = (items) => items.map((i) => ({ ownerOid: i.ownerOid, status: 'refused', reason: 'already-owns-a-bu', detail: 'Cat Lee already owns Ops.' }))
    const w = await mountPage()
    await w.find(tid('org-setup-decision-create-unit')).trigger('click')
    await w.find(tid('org-setup-decision-create-form')).trigger('submit')
    await flushPromises()
    expect(w.find(tid('org-setup-decision-error')).text()).toBe('Cat Lee already owns Ops.')
    // The form stays open with the name, to fix and try again.
    expect(w.find(tid('org-setup-decision-create-form')).exists()).toBe(true)
  })

  async function replace(w: VueWrapper, kind: 'owner-left' | 'leader-left') {
    await w.find(tid(`org-setup-decision-${kind}`)).find(tid('org-setup-decision-choose')).trigger('click')
    await w.find(tid(`org-setup-decision-picker-${kind}-search`)).setValue('nia')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    await w.find(tid(`org-setup-decision-picker-${kind}-pick-oid-new`)).trigger('click')
    await flushPromises()
  }

  it('owner left / leader left: assigns the replacement, then removes the one who left', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = allDecisions().filter((d) => d.kind === 'owner-left' || d.kind === 'leader-left')
    server.search = [{ oid: 'oid-new', email: 'new@example.com', display_name: 'Nia New', department: null, job_title: null }]
    const w = await mountPage()
    calls = []
    await replace(w, 'owner-left')
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe('Nia New now owns Core.')
    await replace(w, 'leader-left')
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe('Nia New now leads EMEA.')

    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`)
    expect(writes).toEqual([
      `POST /api/v1/admin/org-units/${U_CORE}/owners`,
      `DELETE /api/v1/admin/org-units/${U_CORE}/owners/${T_OLD_OWNER}`,
      `POST /api/v1/admin/regions/${EMEA}/leaders`,
      `DELETE /api/v1/admin/regions/${EMEA}/leaders/${L_OLD}`,
    ])
    expect(postsTo((u) => u === `/api/v1/admin/org-units/${U_CORE}/owners`)[0]!.body).toEqual({ oid: 'oid-new' })
    expect(postsTo((u) => u === `/api/v1/admin/regions/${EMEA}/leaders`)[0]!.body).toEqual({
      leader_oid: 'oid-new',
      leader_email: 'new@example.com',
      kind: 'region-svp',
      display_name: 'Nia New',
    })
  })

  it('owner left: a failed removal after a successful assignment is said, with the way out', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = allDecisions().filter((d) => d.kind === 'owner-left')
    server.search = [{ oid: 'oid-new', email: 'new@example.com', display_name: 'Nia New', department: null, job_title: null }]
    server.revoke = async () => {
      throw { statusCode: 409, data: { data: { detail: 'Old Owner still owns a project.' } } }
    }
    const w = await mountPage()
    await replace(w, 'owner-left')
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe(
      'New owner set, but the old owner could not be removed: Old Owner still owns a project. Remove them on the region page.',
    )
    expect(w.find(tid('org-setup-decision-error')).exists()).toBe(false)
    expect(postsTo((u) => u === `/api/v1/admin/org-units/${U_CORE}/owners`)).toHaveLength(1)
  })

  it('owner left: a removal that failed without an answer does not claim the old owner stayed', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = allDecisions().filter((d) => d.kind === 'owner-left')
    server.search = [{ oid: 'oid-new', email: 'new@example.com', display_name: 'Nia New', department: null, job_title: null }]
    server.revoke = async () => {
      throw new TypeError('Failed to fetch')
    }
    const w = await mountPage()
    await replace(w, 'owner-left')
    expect(w.find(tid('org-setup-decision-notice')).text()).toBe(
      'New owner set. We could not tell whether the old owner was removed: check the region page.',
    )
  })

  it('no placement opens Regions with that person unfolded; not read retries the failed lookups', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = [decision('no-placement', { oid: 'oid-a1a', name: 'Cat Lee' }), decision('not-read', {})]
    const w = await mountPage()
    await w.find(tid('org-setup-decision-retry')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/placement-check/pass'))[0]!.body).toEqual({ retryFailed: true })

    await w.find(tid('org-setup-decision-pick-region')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-region-row-oid-a1a')).exists()).toBe(true)
  })

  it('new head opens Regions with that person shown, even when their row is folded away', async () => {
    vi.useFakeTimers()
    server.decisions.decisions = [decision('new-head', { oid: 'oid-s1', name: 'Hal Small', regionId: APAC, regionName: 'APAC', count: 2 })]
    const w = await mountPage()
    await w.find(tid('org-setup-decision-review-regions')).trigger('click')
    await flushPromises()
    expect(w.find(tid('org-setup-region-row-oid-s1')).exists()).toBe(true)
  })

  it('names the top person’s own home, Unassigned, or that they are not a user, from the server', async () => {
    const w = await mountPage()
    const line = () => w.find(tid('org-setup-overview-top-home'))
    expect(line().text()).toBe("Tess Top's own home in TokenScope: APAC · APAC (default). Change it on the Users page")
    expect(line().find(tid('org-setup-overview-top-home-link')).attributes('href')).toBe(`/admin/users?region=${APAC}&q=tess%40example.com`)

    server.tree.topHome = { kind: 'unassigned', teammateId: uuid(1), email: 'tess@example.com', regionId: uuid(77) }
    await lazy.get('/api/v1/admin/org-setup/tree')!.refresh()
    await flushPromises()
    expect(line().text()).toBe("Tess Top's own home in TokenScope: Unassigned. Change it on the Users page")
    expect(line().find('a').attributes('href')).toBe(`/admin/users?region=${uuid(77)}&q=tess%40example.com`)

    server.tree.topHome = { kind: 'not-a-user' }
    await lazy.get('/api/v1/admin/org-setup/tree')!.refresh()
    await flushPromises()
    expect(line().text()).toBe('Tess Top is not a TokenScope user.')
    expect(line().find('a').exists()).toBe(false)
  })

  it('a region card names up to three leaders; more fold behind Show all', async () => {
    const leader = (n: number, name: string) => ({ leaderId: uuid(400 + n), oid: `oid-l${n}`, name, email: null })
    server.tree.regions[0]!.leaders = [leader(1, 'Ann'), leader(2, 'Bo'), leader(3, 'Cy')]
    server.tree.regions[1]!.leaders = [leader(4, 'Di'), leader(5, 'Ed'), leader(6, 'Flo'), leader(7, 'Gil')]
    const w = await mountPage()
    expect(w.find(tid(`org-setup-region-card-leaders-${APAC}`)).text()).toBe('Led by Ann, Bo, Cy')
    expect(w.find(tid(`org-setup-region-card-leaders-more-${APAC}`)).exists()).toBe(false)

    const more = w.find(tid(`org-setup-region-card-leaders-more-${EMEA}`))
    expect(w.find(tid(`org-setup-region-card-leaders-${EMEA}`)).text()).toBe('Led by Di, Ed and 2 others Show all')
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(w.find(tid(`org-setup-region-card-leaders-all-${EMEA}`)).exists()).toBe(false)
    await more.trigger('click')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(more.attributes('aria-controls')).toBe(`org-setup-region-card-leaders-all-${EMEA}`)
    const all = w.find(tid(`org-setup-region-card-leaders-all-${EMEA}`))
    expect(all.attributes('id')).toBe(`org-setup-region-card-leaders-all-${EMEA}`)
    expect(all.findAll('li').map((li) => li.text())).toEqual(['Di', 'Ed', 'Flo', 'Gil'])
    await more.trigger('click')
    expect(w.find(tid(`org-setup-region-card-leaders-all-${EMEA}`)).exists()).toBe(false)
  })

  it('unit under another region: Keep it until the next read dismisses the decision', async () => {
    server.decisions.decisions = [decision('unit-under-other-region', { orgUnitId: U_FAR, unitName: 'Far', regionId: EMEA })]
    const w = await mountPage()
    await w.find(tid('org-setup-decision-keep')).trigger('click')
    await flushPromises()
    expect(postsTo((u) => u.endsWith('/org-setup/dismissals'))[0]!.body).toEqual({ kind: 'unit-under-other-region', subjectKey: 'key-unit-under-other-region' })
  })

  /** Keep fails with `err`; `landed` = the dismissal took effect before the failure. */
  async function keepFailing(err: unknown, landed = false) {
    server.decisions.decisions = [decision('unit-under-other-region', { orgUnitId: U_FAR, unitName: 'Far', regionId: EMEA })]
    fetchMock.mockImplementation(async (url: string, opts: { method?: string; body?: unknown } = {}) => {
      if (url === '/api/v1/admin/org-setup/dismissals') {
        calls.push({ url, method: opts.method ?? 'GET', body: opts.body })
        if (landed) server.decisions.decisions = []
        throw err
      }
      return route(url, opts)
    })
    const w = await mountPage()
    await w.find(tid('org-setup-decision-keep')).trigger('click')
    await flushPromises()
    return w
  }

  it('a refused action shows the server reason on the card', async () => {
    const w = await keepFailing({ statusCode: 409, data: { data: { detail: 'Already dismissed.' } } })
    expect(w.find(tid('org-setup-decision-error')).text()).toBe('Already dismissed.')
    expect(w.find(tid('org-setup-decision-notice')).exists()).toBe(false)
  })

  it('an action that failed without an answer says the outcome is unknown, never "Nothing was changed", and reloads', async () => {
    const w = await keepFailing(new TypeError('Failed to fetch'), true)
    const notice = w.find(tid('org-setup-decision-notice')).text()
    expect(notice).toContain('We could not tell whether that went through')
    expect(notice).not.toContain('Nothing was changed')
    // The reload shows the dismissal landed: the card is gone, the notice stays.
    expect(w.find(tid('org-setup-decision-keep')).exists()).toBe(false)
    expect(w.find(tid('org-setup-decision-error')).exists()).toBe(false)
  })
})

// ── Admin home card ─────────────────────────────────────────────────────────

describe('admin home card', () => {
  function mountCard(role = 'platform-admin') {
    stubGlobals(role)
    return mount(OrgSetupHomeCard, { global: { stubs: STUBS } })
  }

  it('invites setup before a top person is set', () => {
    server.tree.settings.top = null
    const w = mountCard()
    expect(w.find(tid('admin-org-setup-card')).attributes('href')).toBe('/admin/org-setup')
    expect(w.text()).toContain('Set up the organisation')
    expect(w.find(tid('admin-org-setup-card-start')).text()).toBe('Start')
  })

  it('lists the count and the first three titles while there is something to decide', () => {
    server.decisions.decisions = allDecisions().slice(0, 4)
    const w = mountCard()
    expect(w.find(tid('admin-org-setup-card-count')).text()).toBe('4 things to decide')
    expect(w.findAll(`${tid('admin-org-setup-card-titles')} li`).map((l) => l.text())).toEqual([
      'Title moves-waiting',
      'Title new-team',
      'Title new-head',
    ])
  })

  it('is hidden with nothing to decide, and for anyone but an Admin, who never fetches', () => {
    expect(mountCard().find(tid('admin-org-setup-card')).exists()).toBe(false)
    lazy.clear()
    server.tree.settings.top = null
    expect(mountCard('admin').find(tid('admin-org-setup-card')).exists()).toBe(false)
    expect([...lazy.values()].every((e) => e.opts.immediate === false)).toBe(true)
  })
})
