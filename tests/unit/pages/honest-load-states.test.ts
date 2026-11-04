// @vitest-environment happy-dom
/*
 * Issue 488 — a page that was refused or failed must not say "nothing here".
 *
 * `/allocations`, `/inbox` and the teammate drill each read through `useFetch`
 * with an empty `default`, so a refused or failed read used to render the same
 * confident empty state as a genuinely empty one (or, on the drill, a blank
 * body). Each page now tells three answers apart: EMPTY (the server answered
 * with nothing), REFUSED (a 4xx with a reason: `isConfirmedRejection`) and
 * FAILED (no answer or a 5xx: the contents are unknown).
 *
 * Also here: the unknown-route page (`app/error.vue`), the admin-only "Fix org
 * homing →", the inbox drawer's "Open project →" and the Project budgets scope
 * note. And issue 486: no copy on these pages promises Teams or email.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import AllocationsPage from '../../../app/pages/allocations/index.vue'
import InboxPage from '../../../app/pages/inbox.vue'
import TeammatePage from '../../../app/pages/reporting/teammate/[id].vue'
import ErrorPage from '../../../app/error.vue'
import InboxDrawer from '../../../app/components/inbox/InboxDrawer.vue'
import UnallocatedRemediationLink from '../../../app/components/reporting/UnallocatedRemediationLink.vue'
import FinanceCouTable from '../../../app/components/reporting/finance/FinanceCouTable.vue'
import type { InboxItem } from '../../../app/components/inbox/types'

const REGION = '9a1e0000-0000-4000-8000-0000000000a1'
const SUBJECT = '9a1e0000-0000-4000-8000-0000000000b1'

/** What `useFetch` hands a page for each server answer. */
const FORBIDDEN = { statusCode: 403, data: { statusMessage: 'Forbidden' }, message: '[GET] 403 Forbidden' }
const BAD_REQUEST = { statusCode: 400, data: { data: { detail: 'The window is not a real month.' } } }
const SERVER_ERROR = { statusCode: 500, data: null, message: '[GET] 500 Internal Server Error' }
const NETWORK = new TypeError('Failed to fetch')

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const EMPTY_STATE = { props: ['headline', 'sub'], template: '<div><b>{{ headline }}</b><p>{{ sub }}</p><slot /></div>' }
const PAGE_HEAD = { props: ['sub', 'title', 'eyebrow'], template: '<header><p data-testid="page-sub">{{ sub }}</p><slot name="actions" /></header>' }
const STUBS = {
  UiPageHead: PAGE_HEAD,
  UiCard: PASS,
  UiEmptyState: EMPTY_STATE,
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button><slot /></button>' },
  InfoDot: true,
  InboxFilterBar: true,
  NuxtLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' },
}

function stubSession(role: string, teammateId = '9a1e0000-0000-4000-8000-0000000000c1') {
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId, email: 'me@x.test', displayName: 'Me', role, regionId: REGION }),
    ensure: async () => {},
  }))
}

function stubFetch(answer: { data?: unknown; error?: unknown }) {
  const refresh = vi.fn()
  vi.stubGlobal('useFetch', (url: unknown, opts?: { default?: () => unknown }) => {
    if (url === '/api/v1/reports/meta') return { data: ref(null), error: ref(null), pending: ref(false) }
    const fallback = opts?.default ? opts.default() : null
    return {
      data: ref(answer.data ?? fallback),
      error: ref(answer.error ?? null),
      pending: ref(false),
      refresh,
    }
  })
  return refresh
}

async function mountPage(page: unknown) {
  const Parent = defineComponent({ components: { Page: page as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtUsd: (v: string) => `$${v}` } } })
  await flushPromises()
  return w
}

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
})

const NO_TEAMS_OR_EMAIL = /\bteams\b|e-?mail|off-channel/i

// ── /allocations ────────────────────────────────────────────────────────────

describe('/allocations: empty, refused and failed are three answers', () => {
  it('a 403 says the reader has no access, never "no allocations"', async () => {
    stubSession('developer')
    stubFetch({ error: FORBIDDEN })
    const w = await mountPage(AllocationsPage)
    expect(w.find('[data-testid="allocations-refused"]').text()).toContain("You don't have access to project budgets.")
    expect(w.find('[data-testid="allocations-refused"]').text()).toContain('This is not an empty list')
    expect(w.find('[data-testid="allocations-empty"]').exists()).toBe(false)
    expect(w.text()).not.toMatch(/No (allocations|project budgets)/)
  })

  it('a refusal other than 403 quotes the server\'s reason', async () => {
    stubSession('manager')
    stubFetch({ error: BAD_REQUEST })
    const w = await mountPage(AllocationsPage)
    expect(w.find('[data-testid="allocations-refused"]').text()).toContain('Reason given: The window is not a real month.')
  })

  it.each([
    ['a 5xx', SERVER_ERROR],
    ['no answer', NETWORK],
  ])('%s says the list failed and its contents are unknown, with a retry', async (_label, err) => {
    stubSession('manager')
    const refresh = stubFetch({ error: err })
    const w = await mountPage(AllocationsPage)
    const failed = w.find('[data-testid="allocations-failed"]')
    expect(failed.text()).toContain("Project budgets didn't load.")
    expect(failed.text()).toContain("can't tell which budgets exist")
    expect(w.find('[data-testid="allocations-empty"]').exists()).toBe(false)
    await w.find('[data-testid="allocations-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
  })

  it('an answered empty list is the only thing that reads as empty', async () => {
    stubSession('manager')
    stubFetch({ data: { allocations: [] } })
    const w = await mountPage(AllocationsPage)
    expect(w.find('[data-testid="allocations-empty"]').text()).toContain('No project budgets in your scope yet.')
    expect(w.find('[data-testid="allocations-refused"]').exists()).toBe(false)
    expect(w.find('[data-testid="allocations-failed"]').exists()).toBe(false)
  })

  it.each([
    ['platform-admin', 'Showing projects across all regions (org-wide).'],
    // C20: a Region admin is clamped to their own region (allocation-scope.ts).
    ['admin', 'Showing every project in your region.'],
    ['manager', 'Showing the projects in your part of the org.'],
  ])('the scope note for %s matches the server\'s scope', async (role, note) => {
    stubSession(role)
    stubFetch({ data: { allocations: [] } })
    const w = await mountPage(AllocationsPage)
    expect(w.find('[data-testid="page-sub"]').text()).toContain(note)
  })
})

// ── /inbox ──────────────────────────────────────────────────────────────────

describe('/inbox: empty, refused and failed are three answers', () => {
  function stubInboxGlobals() {
    vi.stubGlobal('refreshNuxtData', vi.fn())
    vi.stubGlobal('fmtTimeAgo', () => 'just now')
  }

  it('a refusal says so with the server\'s reason, never "Nothing to see here."', async () => {
    stubInboxGlobals()
    stubFetch({ error: BAD_REQUEST })
    const w = await mountPage(InboxPage)
    const refused = w.find('[data-testid="inbox-refused"]')
    expect(refused.text()).toContain('The server refused to list your inbox.')
    expect(refused.text()).toContain('Reason given: The window is not a real month.')
    expect(w.text()).not.toContain('Nothing to see here.')
  })

  it.each([
    ['a 5xx', SERVER_ERROR],
    ['no answer', NETWORK],
  ])('%s says the inbox did not load and its contents are unknown', async (_label, err) => {
    stubInboxGlobals()
    const refresh = stubFetch({ error: err })
    const w = await mountPage(InboxPage)
    const failed = w.find('[data-testid="inbox-failed"]')
    expect(failed.text()).toContain("Your inbox didn't load.")
    expect(failed.text()).toContain("can't tell whether anything is waiting for you")
    expect(w.text()).not.toContain('Nothing to see here.')
    await w.find('[data-testid="inbox-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
  })

  it('an answered empty inbox is empty, and promises no Teams or email (issue 486)', async () => {
    stubInboxGlobals()
    stubFetch({ data: { items: [], total: 0 } })
    const w = await mountPage(InboxPage)
    expect(w.find('[data-testid="inbox-empty"]').text()).toContain('Nothing to see here.')
    expect(w.find('[data-testid="inbox-empty"]').text()).not.toMatch(NO_TEAMS_OR_EMAIL)
    // The subtitle says the opposite of the old promise, in plain words.
    const sub = w.find('[data-testid="page-sub"]').text()
    expect(sub).toContain('does not send them by Teams or email')
    expect(sub).not.toMatch(/you'll also see|pings|opted in/i)
  })
})

// ── the teammate drill ──────────────────────────────────────────────────────

describe('/reporting/teammate/{id}: every error has a body', () => {
  function stubDrillGlobals() {
    stubSession('manager')
    vi.stubGlobal('useRoute', () => ({ params: { id: SUBJECT }, query: { src: 'cc:x' } }))
    vi.stubGlobal('useReportState', () => ({
      src: ref('cc:x'),
      month: ref('2026-08'),
      from: ref(null),
      to: ref(null),
    }))
  }

  it('a 403 is the no-access card', async () => {
    stubDrillGlobals()
    stubFetch({ error: FORBIDDEN })
    const w = await mountPage(TeammatePage)
    expect(w.find('[data-testid="teammate-forbidden"]').exists()).toBe(true)
    expect(w.find('[data-testid="teammate-failed"]').exists()).toBe(false)
  })

  it('another refusal quotes the server\'s reason', async () => {
    stubDrillGlobals()
    stubFetch({ error: BAD_REQUEST })
    const w = await mountPage(TeammatePage)
    expect(w.find('[data-testid="teammate-refused"]').text()).toContain('Reason given: The window is not a real month.')
    expect(w.find('[data-testid="teammate-forbidden"]').exists()).toBe(false)
  })

  it.each([
    ['a 5xx', SERVER_ERROR],
    ['no answer', NETWORK],
  ])('%s says the view failed (it used to leave a blank body)', async (_label, err) => {
    stubDrillGlobals()
    const refresh = stubFetch({ error: err })
    const w = await mountPage(TeammatePage)
    const failed = w.find('[data-testid="teammate-failed"]')
    expect(failed.text()).toContain("This view didn't load")
    expect(failed.text()).toContain('no figures are shown for this teammate')
    expect(w.find('[data-testid="teammate-crumb"]').exists()).toBe(false)
    await w.find('[data-testid="teammate-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
  })
})

// ── app/error.vue ───────────────────────────────────────────────────────────

describe('app/error.vue: an unhandled error gets a real page', () => {
  const clear = vi.fn()
  function mountError(error: Record<string, unknown>) {
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('clearError', clear)
    return mount(ErrorPage, { props: { error: error as never } })
  }

  it('404 says the page does not exist, with no retry', () => {
    const w = mountError({ statusCode: 404, statusMessage: 'Page not found: /nope' })
    expect(w.text()).toContain("This page doesn't exist")
    expect(w.find('[data-testid="app-error-retry"]').exists()).toBe(false)
  })

  it('403 says the reader has no access', () => {
    const w = mountError({ statusCode: 403 })
    expect(w.text()).toContain("You don't have access to this page")
  })

  it('anything else says it failed, offers a retry and never prints the error itself', () => {
    const w = mountError({ statusCode: 500, message: 'relation "secret_table" does not exist', stack: 'at x (/srv/app.js)' })
    expect(w.text()).toContain('Something went wrong')
    expect(w.find('[data-testid="app-error-retry"]').exists()).toBe(true)
    expect(w.text()).not.toContain('secret_table')
    expect(w.text()).not.toContain('/srv/app.js')
  })

  it('"Go to the start" clears the error onto /', async () => {
    const w = mountError({ statusCode: 404 })
    await w.find('[data-testid="app-error-home"]').trigger('click')
    expect(clear).toHaveBeenCalledWith({ redirect: '/' })
  })
})

// ── admin-only and project links ────────────────────────────────────────────

describe('links open only doors the reader can walk through', () => {
  it('"Fix org homing →" renders only when the container says the reader is an admin', () => {
    const link = (canFix?: boolean) =>
      mount(UnallocatedRemediationLink, { props: canFix == null ? {} : { canFix }, global: { stubs: STUBS } })
    expect(link().find('[data-testid="unallocated-remediation-link"]').exists()).toBe(false)
    expect(link(false).find('[data-testid="unallocated-remediation-link"]').exists()).toBe(false)
    expect(link(true).find('[data-testid="unallocated-remediation-link"]').exists()).toBe(true)
  })

  it('the Finance table passes the decision through to its Unallocated row', () => {
    const cous = [
      { couId: null, code: null, displayName: 'Unallocated', regionCode: null, anthropicUsd: 0, copilotUsd: 20, copilotPending: false, chargeableUsd: 20 },
    ]
    const table = (canFixHoming: boolean) =>
      mount(FinanceCouTable, {
        props: { cous: cous as never, copilotPending: false, canFixHoming },
        global: { stubs: { ...STUBS, ChartRankedBar: true, LaneLegend: true } },
      })
    expect(table(false).find('[data-testid="unallocated-remediation-link"]').exists()).toBe(false)
    expect(table(true).find('[data-testid="unallocated-remediation-link"]').exists()).toBe(true)
  })

  it('the inbox drawer\'s "Open project →" opens the project page, not the budget editor', () => {
    const item: InboxItem = {
      id: '9a1e0000-0000-4000-8000-0000000000d1',
      category: 'over-budget',
      severity: 'attention',
      subject: 'ACME-1 over budget',
      body: {},
      related_entity_kind: 'project',
      related_entity_id: '9a1e0000-0000-4000-8000-0000000000e1',
      target_allocation_id: '9a1e0000-0000-4000-8000-0000000000f1',
      target_project_code: 'ACME 1',
      ack_state: 'read',
      ack_at: null,
      created_at: '2026-08-15T12:00:00Z',
    }
    const drawer = (it: InboxItem) =>
      mount(InboxDrawer, { props: { item: it }, global: { stubs: { ...STUBS, DrawerBodyOverBudget: true } } })
    const open = drawer(item).find('[data-testid="drawer-open-project"]')
    expect(JSON.parse(open.attributes('data-to')!)).toBe('/projects/ACME%201')
    // The server withholds the code from a recipient the page would refuse.
    expect(drawer({ ...item, target_project_code: null }).find('[data-testid="drawer-open-project"]').exists()).toBe(false)
  })
})
