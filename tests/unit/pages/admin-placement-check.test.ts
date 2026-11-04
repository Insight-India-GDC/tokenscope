// @vitest-environment happy-dom
/*
 * /admin/placement-check: default filter, manual-row confirmation, apply
 * results, the Why expand and the group-by-manager view. `$fetch` and
 * `useLazyFetch` are the only fakes; the page and its components run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import PlacementCheckPage from '../../../app/pages/admin/placement-check.vue'
import { isPlacementApplicable, buildPlacementApplyItems } from '../../../app/utils/placement-check-view'
import type {
  PlacementCheckResponse,
  PlacementCheckRow,
  PlacementVerdict,
} from '../../../shared/placement/placement-check'

const APAC = '9a1e0000-0000-4000-8000-0000000000a1'
const EMEA = '9a1e0000-0000-4000-8000-0000000000e1'
const U_CORE = '9a1e0000-0000-4000-8000-0000000000c1'
const U_EDGE = '9a1e0000-0000-4000-8000-0000000000c2'
const U_UNPLACED = '9a1e0000-0000-4000-8000-0000000000f1'

const id = (n: number) => `9a1e0000-0000-4000-8000-${String(n).padStart(12, '0')}`

function row(n: number, verdict: PlacementVerdict, over: Partial<PlacementCheckRow> = {}): PlacementCheckRow {
  const regionMove = verdict === 'move-region'
  return {
    teammateId: id(n),
    name: `Person ${n}`,
    email: `p${n}@example.com`,
    current: { regionId: APAC, regionName: 'APAC', orgUnitId: U_UNPLACED, orgUnitName: 'Unplaced', onHolding: true },
    derived: {
      regionId: regionMove ? EMEA : APAC,
      regionName: regionMove ? 'EMEA' : 'APAC',
      orgUnitId: regionMove ? U_EDGE : U_CORE,
      orgUnitName: regionMove ? 'Edge' : 'Core',
      onHolding: false,
      step: 'chain-unit',
    },
    verdict,
    manual: verdict === 'manual',
    provenance: null,
    spend30d: n * 10,
    gatheredAt: '2026-10-21T00:00:00Z',
    why: {
      rule: null,
      owner: { oid: 'oid-owner', name: 'Olive Owner' },
      leader: null,
      ambiguousOwners: [],
      chain: [
        { oid: `oid-${n}`, name: `Person ${n}`, email: `p${n}@example.com` },
        { oid: 'oid-mgr', name: 'Mona Manager', email: 'mona@example.com' },
        { oid: 'oid-owner', name: 'Olive Owner', email: 'olive@example.com' },
      ],
      walkEnd: 'top-of-chart',
    },
    seen: { regionId: APAC, orgUnitId: U_UNPLACED, provenance: null },
    ...over,
  }
}

function response(rows: PlacementCheckRow[]): PlacementCheckResponse {
  const counts = new Map<PlacementVerdict, { count: number; spend30d: number }>()
  for (const r of rows) {
    const c = counts.get(r.verdict) ?? { count: 0, spend30d: 0 }
    c.count++
    c.spend30d += r.spend30d
    counts.set(r.verdict, c)
  }
  return {
    cycle: { id: id(999), startedAt: '2026-10-21T00:00:00Z' },
    remaining: 0,
    failedThisCycle: 0,
    evidenceAge: { oldest: '2026-10-20T00:00:00Z', newest: '2026-10-21T00:00:00Z' },
    summary: [...counts].map(([verdict, c]) => ({ verdict, ...c })),
    rows,
  }
}

let fixture: PlacementCheckResponse
const refreshSpy = vi.fn(async () => {})
const fetchMock = vi.fn()

const passThrough = (tag: string) => ({ template: `<div data-stub="${tag}"><slot /></div>` })
const STUBS = {
  UiPageHead: { props: ['title', 'sub', 'eyebrow'], template: '<h1>{{ title }}</h1>' },
  UiCard: passThrough('card'),
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button type="button"><slot /></button>' },
  UiFetchErrorBanner: { props: ['error', 'label'], template: '<div v-if="error" data-testid="fetch-error-banner" />' },
  AdminPageSkeleton: { template: '<div data-testid="admin-skeleton" />' },
}

async function mountPage(rows: PlacementCheckRow[], query: Record<string, string> = {}): Promise<VueWrapper> {
  fixture = response(rows)
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useRoute', () => ({ params: {}, query }))
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'platform-admin' }) }))
  vi.stubGlobal('useLazyFetch', () => ({ data: ref(fixture), error: ref(null), refresh: refreshSpy }))
  vi.stubGlobal('$fetch', fetchMock)
  const w = mount(PlacementCheckPage, { global: { stubs: STUBS } })
  await flushPromises()
  return w
}

beforeEach(() => {
  fetchMock.mockReset()
  refreshSpy.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('placement check page: default view', () => {
  it('hides ok rows by default, sorts by spend, and still counts them in the summary', async () => {
    const w = await mountPage([row(1, 'ok'), row(2, 'move-unit'), row(3, 'move-region')])
    expect(w.find(`[data-testid="placement-row-${id(1)}"]`).exists()).toBe(false)
    const shown = w.findAll('[data-testid^="placement-row-"]').map((r) => r.attributes('data-testid'))
    expect(shown).toEqual([`placement-row-${id(3)}`, `placement-row-${id(2)}`])
    expect(w.find('[data-testid="placement-summary-ok"]').text()).toContain('1')

    await w.find('[data-testid="placement-filter-verdict"]').setValue('all')
    expect(w.find(`[data-testid="placement-row-${id(1)}"]`).exists()).toBe(true)
  })

  it('offers a checkbox only on applicable verdicts', async () => {
    const w = await mountPage([row(1, 'needs-owner'), row(2, 'place'), row(3, 'lookup-failed')])
    expect(w.find(`[data-testid="placement-select-${id(2)}"]`).exists()).toBe(true)
    expect(w.find(`[data-testid="placement-select-${id(1)}"]`).exists()).toBe(false)
    expect(w.find(`[data-testid="placement-select-${id(3)}"]`).exists()).toBe(false)
  })

  it('shows unknown provenance when nothing recorded it and the row is not manual', async () => {
    const w = await mountPage([row(1, 'move-unit'), row(2, 'manual')])
    expect(w.find(`[data-testid="placement-row-${id(1)}"]`).text()).toContain('Unknown')
    expect(w.find(`[data-testid="placement-row-${id(2)}"]`).text()).toContain('Placed by an admin')
  })
})

describe('placement check page: filters from the query string', () => {
  const value = (w: VueWrapper, testid: string) => (w.find(`[data-testid="${testid}"]`).element as HTMLSelectElement).value
  /** The text of the select's chosen option (happy-dom has no `:checked` selector). */
  const chosen = (w: VueWrapper, testid: string) =>
    w.findAll(`[data-testid="${testid}"] option`).find((o) => (o.element as HTMLOptionElement).selected)?.text() ?? null

  it('opens filtered to the verdict and regions a link names', async () => {
    const w = await mountPage([row(1, 'move-region'), row(2, 'move-unit'), row(3, 'move-region')], { verdict: 'move-region', current: APAC, derived: EMEA })
    expect(value(w, 'placement-filter-verdict')).toBe('move-region')
    expect(value(w, 'placement-filter-current-region')).toBe(APAC)
    expect(value(w, 'placement-filter-derived-region')).toBe(EMEA)
    expect(w.findAll('[data-testid^="placement-row-"]').map((r) => r.attributes('data-testid'))).toEqual([
      `placement-row-${id(3)}`,
      `placement-row-${id(1)}`,
    ])
  })

  it('ignores a verdict it does not know; keeps a region no row has, showing nobody and naming the filter', async () => {
    const w = await mountPage([row(1, 'move-region'), row(2, 'move-unit')], { verdict: 'bogus', current: 'not-a-region', derived: EMEA })
    expect(value(w, 'placement-filter-verdict')).toBe('not-ok')
    expect(value(w, 'placement-filter-current-region')).toBe('not-a-region')
    expect(chosen(w, 'placement-filter-current-region')).toBe('No region matches this filter')
    expect(value(w, 'placement-filter-derived-region')).toBe(EMEA)
    expect(w.findAll('[data-testid^="placement-row-"]')).toHaveLength(0)
    expect(w.text()).toContain('Nobody has the region this link names. Pick Any to widen the view.')

    await w.find('[data-testid="placement-filter-current-region"]').setValue('')
    expect(w.findAll('[data-testid^="placement-row-"]').map((r) => r.attributes('data-testid'))).toEqual([`placement-row-${id(1)}`])
  })

  it('with no query, keeps the default view', async () => {
    const w = await mountPage([row(1, 'ok'), row(2, 'move-unit')])
    expect(value(w, 'placement-filter-verdict')).toBe('not-ok')
    expect(value(w, 'placement-filter-current-region')).toBe('')
    expect(value(w, 'placement-filter-current-unit')).toBe('')
    expect(value(w, 'placement-filter-derived-unit')).toBe('')
  })

  const shownIds = (w: VueWrapper) => w.findAll('[data-testid^="placement-row-"]').map((r) => r.attributes('data-testid'))

  it('opens filtered to the units a link names, so two groups in one region open on different people', async () => {
    const toEdge = row(2, 'place', { derived: { regionId: APAC, regionName: 'APAC', orgUnitId: U_EDGE, orgUnitName: 'Edge', onHolding: false, step: 'chain-unit' } })
    const fromCore = row(3, 'place', { current: { regionId: APAC, regionName: 'APAC', orgUnitId: U_CORE, orgUnitName: 'Core', onHolding: false } })
    const w = await mountPage([row(1, 'place'), toEdge, fromCore], {
      verdict: 'place',
      current: APAC,
      derived: APAC,
      currentUnit: U_UNPLACED,
      derivedUnit: U_CORE,
    })
    expect(value(w, 'placement-filter-current-unit')).toBe(U_UNPLACED)
    expect(value(w, 'placement-filter-derived-unit')).toBe(U_CORE)
    expect(shownIds(w)).toEqual([`placement-row-${id(1)}`])
    const options = w.findAll('[data-testid="placement-filter-derived-unit"] option').map((o) => o.text())
    expect(options).toEqual(['Any', 'APAC · Core', 'APAC · Edge'])

    await w.find('[data-testid="placement-filter-derived-unit"]').setValue(U_EDGE)
    expect(shownIds(w)).toEqual([`placement-row-${id(2)}`])
  })

  it('a unit of none means no unit on that side; a key left out means any', async () => {
    const regionOnly = row(2, 'move-region', {
      derived: { regionId: EMEA, regionName: 'EMEA', orgUnitId: null, orgUnitName: null, onHolding: true, step: 'chain-region' },
    })
    const rows = () => [row(1, 'move-region'), regionOnly]
    let w = await mountPage(rows(), { verdict: 'move-region', derivedUnit: 'none' })
    expect(value(w, 'placement-filter-derived-unit')).toBe('none')
    expect(shownIds(w)).toEqual([`placement-row-${id(2)}`])
    expect(w.findAll('[data-testid="placement-filter-derived-unit"] option').map((o) => o.text())).toEqual(['Any', 'No Business Unit', 'EMEA · Edge'])

    w = await mountPage(rows(), { verdict: 'move-region' })
    expect(value(w, 'placement-filter-derived-unit')).toBe('')
    expect(shownIds(w)).toEqual([`placement-row-${id(2)}`, `placement-row-${id(1)}`])
  })

  it('keeps a unit no row has, so a link to an unsaved unit shows nobody rather than other groups’ people', async () => {
    // The Review step's preview names a unit by its draft key until it is saved.
    const all = [row(1, 'place'), row(2, 'place'), row(3, 'move-region')]
    let w = await mountPage(all, { verdict: 'place', current: APAC, derived: APAC, currentUnit: U_UNPLACED, derivedUnit: 'new:oid-a1' })
    expect(shownIds(w)).toEqual([])
    expect(value(w, 'placement-filter-derived-unit')).toBe('new:oid-a1')
    expect(chosen(w, 'placement-filter-derived-unit')).toBe('No Business Unit matches this filter')
    expect(w.text()).toContain('Nobody has the Business Unit this link names. Pick Any to widen the view.')
    // The known filters still list their rows' units; picking one of them is the way out.
    await w.find('[data-testid="placement-filter-derived-unit"]').setValue(U_CORE)
    expect(shownIds(w)).toEqual([`placement-row-${id(2)}`, `placement-row-${id(1)}`])
    expect(w.findAll('[data-testid="placement-filter-derived-unit"] option').map((o) => o.text())).toEqual(['Any', 'APAC · Core', 'EMEA · Edge'])

    w = await mountPage(all, { verdict: 'move-region', currentUnit: 'not-a-unit', derivedUnit: U_EDGE })
    expect(value(w, 'placement-filter-current-unit')).toBe('not-a-unit')
    expect(value(w, 'placement-filter-derived-unit')).toBe(U_EDGE)
    expect(shownIds(w)).toEqual([])
  })
})

describe('placement check page: retry failed', () => {
  const failedRow = () => {
    const r = row(1, 'lookup-failed')
    r.why = { ...r.why, walkEnd: 'graph-error' }
    return r
  }

  it('is offered only when this cycle has failed lookups to retry', async () => {
    let w = await mountPage([failedRow()])
    expect(w.find('[data-testid="placement-check-retry"]').exists()).toBe(false)

    fixture = { ...response([failedRow()]), failedThisCycle: 1 }
    vi.stubGlobal('useLazyFetch', () => ({ data: ref(fixture), error: ref(null), refresh: refreshSpy }))
    w = mount(PlacementCheckPage, { global: { stubs: STUBS } })
    await flushPromises()
    expect(w.find('[data-testid="placement-check-retry"]').exists()).toBe(true)
  })
})

describe('placement check page: region-only moves', () => {
  it('applies a region-only move onto the target region with no unit', () => {
    const r = row(7, 'move-region', {
      derived: { regionId: EMEA, regionName: 'EMEA', orgUnitId: null, orgUnitName: null, onHolding: true, step: 'chain-region' },
    })
    expect(isPlacementApplicable(r)).toBe(true)
    expect(buildPlacementApplyItems([r], false)[0]!.target).toEqual({ regionId: EMEA, orgUnitId: null })
  })
})

describe('placement check page: apply', () => {
  it('select-all skips manual rows; a selected manual row needs a second confirmation', async () => {
    const w = await mountPage([row(1, 'move-unit'), row(2, 'move-region'), row(3, 'manual')])
    await w.find('[data-testid="placement-select-all"]').trigger('click')
    expect((w.find(`[data-testid="placement-select-${id(3)}"]`).element as HTMLInputElement).checked).toBe(false)
    expect((w.find(`[data-testid="placement-select-${id(1)}"]`).element as HTMLInputElement).checked).toBe(true)

    await w.find(`[data-testid="placement-select-${id(3)}"]`).trigger('change')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')

    expect(w.find('[data-testid="placement-apply-region-count"]').text()).toContain('1 person moves region')
    expect(w.find('[data-testid="placement-apply-region-count"]').text()).toContain('signed out of the web app')
    expect(w.find('[data-testid="placement-apply-unit-count"]').text()).toContain('2 people move')

    const submit = w.find('[data-testid="placement-apply-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await submit.trigger('click')
    expect(fetchMock).not.toHaveBeenCalled()

    await w.find('[data-testid="placement-apply-confirm-manual"]').setValue(true)
    expect(w.find('[data-testid="placement-apply-submit"]').attributes('disabled')).toBeUndefined()
    fetchMock.mockResolvedValue({ batchId: id(500), results: [] })
    await w.find('[data-testid="placement-apply-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/v1/admin/placement-check/apply')
    const items = (opts as { body: { items: Array<{ teammateId: string; confirmManual?: boolean; target: unknown }> } }).body.items
    expect(items.map((i) => i.teammateId).sort()).toEqual([id(1), id(2), id(3)])
    expect(items.find((i) => i.teammateId === id(3))!.confirmManual).toBe(true)
    expect(items.find((i) => i.teammateId === id(1))!.confirmManual).toBeUndefined()
    expect(items.find((i) => i.teammateId === id(2))!.target).toEqual({ regionId: EMEA, orgUnitId: U_EDGE })
  })

  it('without manual rows, submits straight away with no confirmation box', async () => {
    const w = await mountPage([row(1, 'move-unit')])
    await w.find(`[data-testid="placement-select-${id(1)}"]`).trigger('change')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')
    expect(w.find('[data-testid="placement-apply-manual"]').exists()).toBe(false)
    expect(w.find('[data-testid="placement-apply-submit"]').attributes('disabled')).toBeUndefined()
  })

  it('sends a selection above the endpoint cap in batches and lists every outcome', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i + 1, 'move-unit'))
    const w = await mountPage(rows)
    await w.find('[data-testid="placement-select-all"]').trigger('click')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')
    fetchMock.mockImplementation(async (_url: string, opts: { body: { items: Array<{ teammateId: string }> } }) => ({
      batchId: id(500),
      results: opts.body.items.map((i) => ({ teammateId: i.teammateId, outcome: 'moved' })),
    }))
    await w.find('[data-testid="placement-apply-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls.map((c) => (c[1] as { body: { items: unknown[] } }).body.items.length)).toEqual([200, 5])
    expect(w.find('[data-testid="placement-apply-summary"]').text()).toContain('205 moved')
  })

  it('lists each outcome with a human reason for refusals, then refetches', async () => {
    const w = await mountPage([row(1, 'move-unit'), row(2, 'place')])
    await w.find('[data-testid="placement-select-all"]').trigger('click')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')
    fetchMock.mockResolvedValue({
      batchId: id(500),
      results: [
        { teammateId: id(1), outcome: 'moved' },
        { teammateId: id(2), outcome: 'refused', reason: 'changed-since-check' },
      ],
    })
    await w.find('[data-testid="placement-apply-submit"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="placement-apply-summary"]').text()).toContain('1 moved, 1 refused')
    const moved = w.find(`[data-testid="placement-apply-outcome-${id(1)}"]`).text()
    expect(moved).toContain('Person 1')
    expect(moved).toContain('Moved')
    expect(moved).toContain('APAC · Core')
    const refused = w.find(`[data-testid="placement-apply-outcome-${id(2)}"]`).text()
    expect(refused).toContain('Refused')
    expect(refused).toContain('changed after this page loaded')
    expect(refreshSpy).toHaveBeenCalled()
  })

  async function applyFailing(err: unknown, rows = [row(1, 'move-unit')]) {
    const w = await mountPage(rows)
    await w.find('[data-testid="placement-select-all"]').trigger('click')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')
    fetchMock.mockRejectedValue(err)
    await w.find('[data-testid="placement-apply-submit"]').trigger('click')
    await flushPromises()
    return w
  }

  it('a refused apply says nothing was changed, in the server’s words when it gave them', async () => {
    const w = await applyFailing({ statusCode: 400, data: { statusMessage: 'Too many items.' } })
    expect(w.find('[data-testid="placement-apply-error"]').text()).toBe('Too many items.')
    const bare = await applyFailing({ statusCode: 403, data: {} })
    expect(bare.find('[data-testid="placement-apply-error"]').text()).toBe('Apply failed. Nothing was changed.')
  })

  it('an apply that failed without an answer says the outcome is unknown, never "Nothing was changed"', async () => {
    const w = await applyFailing(new TypeError('Failed to fetch'))
    const text = w.find('[data-testid="placement-apply-error"]').text()
    expect(text).toContain('We could not tell whether the apply went through')
    expect(text).not.toContain('Nothing was changed')
  })

  it('a later batch that failed without an answer does not claim the rest were not changed', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i + 1, 'move-unit'))
    const w = await mountPage(rows)
    await w.find('[data-testid="placement-select-all"]').trigger('click')
    await w.find('[data-testid="placement-apply-open"]').trigger('click')
    fetchMock
      .mockImplementationOnce(async (_url: string, opts: { body: { items: Array<{ teammateId: string }> } }) => ({
        batchId: id(500),
        results: opts.body.items.map((i) => ({ teammateId: i.teammateId, outcome: 'moved' })),
      }))
      .mockRejectedValueOnce({ statusCode: 504, data: { statusMessage: 'Gateway Timeout' } })
    await w.find('[data-testid="placement-apply-submit"]').trigger('click')
    await flushPromises()
    const text = w.find('[data-testid="placement-apply-partial-error"]').text()
    expect(text).toContain('Apply stopped after 200')
    expect(text).toContain('could not tell whether the next batch was applied')
    expect(text).not.toContain('not changed')
  })
})

describe('placement check page: why and managers', () => {
  it('expands the chain with the owner marked and the walk end in words', async () => {
    const w = await mountPage([row(1, 'move-unit')])
    await w.find(`[data-testid="placement-why-toggle-${id(1)}"]`).trigger('click')
    const why = w.find(`[data-testid="placement-why-${id(1)}"]`)
    expect(why.find('[data-testid="placement-why-decisive"]').text()).toContain('Olive Owner owns Core')
    const chain = why.find('[data-testid="placement-why-chain"]').text()
    expect(chain).toContain('this person')
    expect(chain).toMatch(/Olive Owner[\s\S]*owns Core/)
    expect(why.find('[data-testid="placement-why-walk-end"]').text()).toContain('top of the reporting line')
  })

  it('names ambiguous owners with their units', async () => {
    const r = row(1, 'ambiguous-owner', {
      derived: { regionId: null, regionName: null, orgUnitId: null, orgUnitName: null, onHolding: false, step: null },
    })
    r.why = { ...r.why, owner: null, ambiguousOwners: [{ oid: 'oid-mgr', name: 'Mona Manager', unitNames: ['Core', 'Edge'] }] }
    const w = await mountPage([r])
    await w.find(`[data-testid="placement-why-toggle-${id(1)}"]`).trigger('click')
    expect(w.find('[data-testid="placement-why-chain"]').text()).toContain('owns 2 units (Core, Edge)')
  })

  it('warns on a decided row that also met an ambiguous owner nearer the person, and only there', async () => {
    const decided = row(1, 'place')
    decided.why = { ...decided.why, ambiguousOwners: [{ oid: 'oid-mgr', name: 'Mona Manager', unitNames: ['Core', 'Edge'] }] }
    const undecided = row(2, 'ambiguous-owner', {
      derived: { regionId: APAC, regionName: 'APAC', orgUnitId: null, orgUnitName: null, onHolding: true, step: 'chain-region' },
    })
    undecided.why = { ...undecided.why, owner: null, ambiguousOwners: decided.why.ambiguousOwners }
    const w = await mountPage([decided, undecided, row(3, 'place')])
    expect(w.find(`[data-testid="placement-ambiguous-warning-${id(1)}"]`).text()).toContain('nearer manager owns several')
    expect(w.find(`[data-testid="placement-ambiguous-warning-${id(2)}"]`).exists()).toBe(false)
    expect(w.find(`[data-testid="placement-ambiguous-warning-${id(3)}"]`).exists()).toBe(false)
    await w.find(`[data-testid="placement-why-toggle-${id(1)}"]`).trigger('click')
    expect(w.find('[data-testid="placement-why-ambiguous-warning"]').exists()).toBe(true)
  })

  it('groups needs-owner people by their nearest manager', async () => {
    const lone = row(3, 'needs-owner')
    lone.why = { ...lone.why, chain: [lone.why.chain[0]!, { oid: 'oid-other', name: 'Otto Other', email: null }] }
    const w = await mountPage([row(1, 'needs-owner'), row(2, 'needs-owner'), lone, row(4, 'move-unit')])
    await w.find('[data-testid="placement-view-managers"]').trigger('click')
    const groups = w.findAll('[data-testid^="placement-manager-"]')
    expect(groups.map((g) => g.attributes('data-testid'))).toEqual(['placement-manager-oid-mgr', 'placement-manager-oid-other'])
    expect(groups[0]!.text()).toContain('Mona Manager')
    expect(groups[0]!.text()).toContain('2 people')
    expect(groups[0]!.text()).toContain('reports to Olive Owner')
  })
})

describe('placement check page: read directory', () => {
  // The fake server: a pass (or one cut off by a 504) lowers `server.remaining`; the
  // page only learns it by refreshing.
  const server = { remaining: 0, failed: 0 }
  const pass = (checked: number, remaining: number, errors = 0) => () => {
    server.remaining = remaining
    server.failed += errors
    return Promise.resolve({ checked, errors, remaining })
  }
  const timedOut = (remaining: number) => () => {
    server.remaining = remaining
    return Promise.reject({ statusCode: 504 })
  }
  async function mountQueued(remaining: number): Promise<VueWrapper> {
    await mountPage([])
    server.remaining = remaining
    server.failed = 0
    fixture = { ...response([]), remaining, evidenceAge: { oldest: null, newest: null } }
    const data = ref(fixture)
    const refresh = async () => {
      data.value = { ...data.value, remaining: server.remaining, failedThisCycle: server.failed }
    }
    vi.stubGlobal('useLazyFetch', () => ({ data, error: ref(null), refresh }))
    const w = mount(PlacementCheckPage, { global: { stubs: STUBS } })
    await flushPromises()
    return w
  }

  it('is the primary action once a check has people left, and says how many', async () => {
    const w = await mountQueued(300)
    const btn = w.find('[data-testid="placement-check-pass"]')
    expect(btn.text()).toBe('Read directory (300 left)')
    expect(w.find('[data-testid="placement-check-evidence-age"]').text()).not.toContain('Directory read between')
    expect(w.text()).toContain('Nobody read yet. Press Read directory.')
  })

  it('repeats passes until nothing remains and adds up what each read', async () => {
    const w = await mountQueued(300)
    fetchMock.mockImplementationOnce(pass(150, 150, 2)).mockImplementationOnce(pass(150, 0, 1))
    await w.find('[data-testid="placement-check-pass"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="placement-check-last-pass"]').text()).toBe('Read 300 so far, 0 remaining. 3 lookups failed in this check.')
    expect(w.find('[data-testid="placement-check-action-error"]').exists()).toBe(false)
  })

  it('stops when a pass reads nobody, so a stuck queue cannot spin', async () => {
    const w = await mountQueued(300)
    fetchMock.mockImplementationOnce(pass(0, 300))
    await w.find('[data-testid="placement-check-pass"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits out a pass still running after a 504 and carries on', async () => {
    vi.useFakeTimers()
    try {
      const w = await mountQueued(300)
      const stillRunning = { statusCode: 409, data: { data: { type: 'https://tokenscope.example.com/errors/worker-already-running' } } }
      fetchMock
        .mockImplementationOnce(timedOut(150))
        .mockRejectedValueOnce(stillRunning)
        .mockImplementationOnce(pass(150, 0))
      await w.find('[data-testid="placement-check-pass"]').trigger('click')
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await flushPromises()
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(w.find('[data-testid="placement-check-action-error"]').exists()).toBe(false)
      // The 150 read by the pass the gateway cut off count too.
      expect(w.find('[data-testid="placement-check-last-pass"]').text()).toContain('Read 300 so far')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on any other error and shows it', async () => {
    const w = await mountQueued(300)
    fetchMock.mockRejectedValueOnce({
      statusCode: 409,
      data: { data: { type: 'https://tokenscope.example.com/errors/worker-disabled', detail: "Worker 'placement-check' is disabled in Admin → Workers." } },
    })
    await w.find('[data-testid="placement-check-pass"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="placement-check-action-error"]').text()).toContain('is disabled')
  })

  it('leaving the page ends the run after the pass in flight', async () => {
    const w = await mountQueued(300)
    let finish!: (v: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    await w.find('[data-testid="placement-check-pass"]').trigger('click')
    w.unmount()
    finish({ checked: 150, errors: 0, remaining: 150 })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a retry reports what it re-read, not the queue count', async () => {
    const w = await mountQueued(0)
    server.failed = 3
    fixture.failedThisCycle = 3
    w.unmount()
    vi.stubGlobal('useLazyFetch', () => ({ data: ref({ ...fixture, failedThisCycle: 3 }), error: ref(null), refresh: async () => {} }))
    const w2 = mount(PlacementCheckPage, { global: { stubs: STUBS } })
    await flushPromises()
    fetchMock.mockResolvedValueOnce({ checked: 3, errors: 1, remaining: 0 })
    await w2.find('[data-testid="placement-check-retry"]').trigger('click')
    await flushPromises()
    expect(w2.find('[data-testid="placement-check-retry-result"]').text()).toBe('Retried 3: 2 read, 1 still failing.')
    expect(w2.find('[data-testid="placement-check-last-pass"]').exists()).toBe(false)
  })

  it('Stop ends the run after the pass in flight', async () => {
    const w = await mountQueued(300)
    let finish!: (v: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    await w.find('[data-testid="placement-check-pass"]').trigger('click')
    await w.find('[data-testid="placement-check-stop"]').trigger('click')
    finish({ checked: 150, errors: 0, remaining: 150 })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="placement-check-stop"]').exists()).toBe(false)
  })
})
