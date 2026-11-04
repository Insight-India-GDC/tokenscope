// @vitest-environment happy-dom
/*
 * THE REGIONAL CONTAINER ASKS EACH QUESTION ONCE — AND RENDERS THE ANSWER IT ASKED FOR.
 *
 * `docs/design/reporting-stakeholder-visibility/00-decisions.md` §5b Five: "the
 * reporting surfaces discard roughly half their requests … Fix by deleting work,
 * not optimising it."
 *
 * Two deletions are pinned here.
 *
 * 1. The default region is the SERVER's answer. ScopeRegional used to wait for
 *    the first response, fetch the whole-company region ranking to find the
 *    biggest region, and patch the URL — which recomputed every query object and
 *    re-issued all seven fetches, so the entire first round was thrown away and
 *    the user watched one region's figures flip to another's. The rule now lives
 *    in resolveRegionalScope (tests/integration/reports/regional-default-region).
 *
 * 2. The switchable DriversTable and the Concentration card request the SAME URL
 *    whenever the table's axis is 'teammate' — under two different `useFetch`
 *    keys, and Nuxt shares in-flight promises per KEY, so it was two round-trips
 *    for one answer. teammate-cut.ts decides which request serves the table.
 *
 * Deletion (2) creates a hazard that is worse than the duplicate it removes: a
 * request that never runs leaves its `data`/`pending`/`error` refs holding the
 * PREVIOUS axis's state forever. So the container must read the request that is
 * actually serving the table on all three of those, and the table must render a
 * payload only when the payload itself says it is the axis AND the region on
 * screen. The concentration card and the top-models bar read their own axis-fixed
 * requests directly, so they are held to the same test — otherwise they would show
 * the previous region's rows beside a table that had correctly gone blank. The trend
 * request feeds four more cards and carries a region but no axis, so it takes the
 * REGION half of that test. `active-trend` and `seasonality` carry no region at all
 * and are NOT covered — see the last describe.
 *
 * The container is MOUNTED here, not read as source. `useFetch`/`useRoute`/
 * `useRouter`/`$fetch` are Nuxt auto-imports, so they are stubbed as globals and
 * ScopeRegionalView is mocked; every assertion below is on what the container
 * requested and what it handed the view. A source-substring check would pass with
 * any of these behaviours inverted, which is precisely how the gap it was meant to
 * cover got shipped.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, h as createEl, nextTick, reactive, ref, unref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import {
  TEAMMATE_AXIS,
  behaviourOnScreen,
  cutOnScreen,
  driversForAxis,
  tableSharesTeammateCut,
  teammateCutOnScreen,
  trendOnScreen,
} from '../../../app/components/reporting/regional/teammate-cut'
import type {
  RegionalDriversResp,
  RegionalTrendResp,
} from '../../../app/components/reporting/regional-report-types'
import type { BehaviourReport } from '../../../shared/reports/behaviour'

/** The region the header is naming — every fixture below defaults to this one. */
const SCREEN_REGION = { id: 'region-zebra', code: 'drz', displayName: 'Zebra Region' }
/** A DIFFERENT region: what a lagging response, or the deleted rule's pick, carries. */
const OTHER_REGION = { id: 'region-aardvark', code: 'dra', displayName: 'Aardvark Region' }

const resp = (
  axis: string,
  label: string,
  region: RegionalDriversResp['region'] = SCREEN_REGION,
  width: RegionalDriversResp['width'] = 'region',
): RegionalDriversResp => ({
  axis,
  width,
  region,
  headlineUsd: 10,
  rows: [{ key: 'k', label, usd: 10, sharePct: 1, spendClass: 'indicative' }],
})

/**
 * A trend response for one region. ONE request feeds four cards (the usage
 * composition hero, its pinned donut, the §A spend trend and the §B chargeback
 * trend), and unlike a drivers cut it has no axis — only the region.
 */
const trendFor = (
  region: RegionalTrendResp['region'],
  usd: number,
  width: RegionalTrendResp['width'] = 'region',
): RegionalTrendResp => ({
  width,
  region,
  window: { from: '2026-07-01', to: '2026-07-31' },
  windowDays: 31,
  // `usd` fingerprints WHICH region's series this is, so an assertion that the
  // right one is on screen cannot be satisfied by the wrong one.
  series: [{ day: '2026-07-02', key: 'claude-code', value: usd }],
  chargeSeries: [{ day: '2026-07-02', chargeUsd: 6 }],
  chargeLanes: [{ day: '2026-07-02', lane: 'claude', chargeUsd: 6 }],
  usageWeeklyLanes: [],
})
/** The two regions' series, distinguishable by value alone. */
const ZEBRA_TREND_USD = 20
const AARDVARK_TREND_USD = 77

/**
 * A behaviour response for one region. It carries BOTH the width it answered at
 * and the region it answered for, and `frontierUsd` fingerprints which region's
 * exposure this is so an assertion cannot be satisfied by the other one.
 */
const behaviourFor = (
  region: BehaviourReport['region'],
  frontierUsd: number,
  width: BehaviourReport['width'] = 'region',
): BehaviourReport => {
  const window = { from: '2026-07-01', to: '2026-07-31' }
  return {
    window,
    width,
    region,
    exposure: {
      window,
      bandOrder: ['frontier'],
      providers: [
        {
          provider: 'anthropic',
          kind: 'banded',
          availability: 'present',
          unit: 'tokens',
          // The fingerprint: whose exposure this is, readable from one number.
          bandedSpendUsd: frontierUsd,
          unbandedSpendUsd: 0,
          unbandedNote: null,
          totalConsumption: null,
          bands: [],
          cells: [],
        },
      ],
    } as unknown as BehaviourReport['exposure'],
    perDeveloper: {
      window,
      points: [],
      deltas: null,
      deltaDays: 30,
    },
  }
}
/** The two regions' exposure, distinguishable by value alone. */
const ZEBRA_FRONTIER_USD = 31
const AARDVARK_FRONTIER_USD = 92

/** The region id the header is showing, as the container passes it to the guard. */
const ON = SCREEN_REGION.id

// ── the decision, as a pure function ─────────────────────────────────────────
describe('which request serves the switchable drivers table', () => {
  it('the teammate axis is served by the concentration card’s request', () => {
    expect(tableSharesTeammateCut(TEAMMATE_AXIS)).toBe(true)
    const picked = driversForAxis(TEAMMATE_AXIS, ON, resp('teammate', 'stale own'), resp('teammate', 'Zoe'))
    expect(picked?.rows[0]?.label).toBe('Zoe')
  })

  it.each(['project', 'model', 'practice', 'surface'])(
    'the %s axis is served by the table’s own request',
    (axis) => {
      expect(tableSharesTeammateCut(axis)).toBe(false)
      const picked = driversForAxis(axis, ON, resp(axis, 'Project Zebra'), resp('teammate', 'Zoe'))
      expect(picked?.rows[0]?.label).toBe('Project Zebra')
    },
  )

  it('a payload is rendered only under its OWN axis’ heading, in both directions', () => {
    /*
     * The property, stated as the code now delivers it: the choice is keyed on
     * `resp.axis` (set by drivers.get.ts from the validated `?axis=`), not on which
     * ref happened to hold it. Keying on the ref would hand a stale payload to the
     * table in either direction — the teammate axis never re-requests the table's
     * own cut, and every other axis renders while its own request is still in
     * flight over the previous axis' data.
     */
    expect(driversForAxis(TEAMMATE_AXIS, ON, resp('project', 'Project Zebra'), null)).toBeNull()
    expect(driversForAxis(TEAMMATE_AXIS, ON, null, resp('project', 'Project Zebra'))).toBeNull()
    expect(driversForAxis('project', ON, resp('teammate', 'Zoe'), null)).toBeNull()
    expect(driversForAxis('project', ON, resp('model', 'Sonnet'), resp('teammate', 'Zoe'))).toBeNull()
  })

  it('a missing response is null, not undefined — the View’s prop is nullable', () => {
    expect(driversForAxis('project', ON, undefined, undefined)).toBeNull()
    expect(driversForAxis(TEAMMATE_AXIS, ON, undefined, undefined)).toBeNull()
  })
})

// ── the same test on the REGION dimension ────────────────────────────────────
describe('a payload is rendered only under its OWN region’s heading', () => {
  /*
   * The axis guard alone was never enough. The heading is the primary report's
   * `region.displayName`, and the drivers requests resolve their scope separately —
   * so after a region switch the drivers ref still holds the PREVIOUS region's
   * answer on the SAME axis. Keyed on axis only, that renders: another region's
   * money under this region's name, which is the exact state the server-side
   * default-region rule exists to prevent, reached from the client side instead.
   */
  it('the right axis from the WRONG region is not the answer on screen', () => {
    expect(driversForAxis('project', ON, resp('project', 'Aardvark project', OTHER_REGION), null)).toBeNull()
    expect(driversForAxis(TEAMMATE_AXIS, ON, null, resp('teammate', 'Ann', OTHER_REGION))).toBeNull()
    // …and the SAME call with the region on screen DOES render, so the guard is
    // discriminating rather than a blanket null.
    expect(
      driversForAxis('project', ON, resp('project', 'Project Zebra'), null)?.rows[0]?.label,
    ).toBe('Project Zebra')
  })

  it('renders nothing while the header names no region at all', () => {
    // Before the primary report lands there is no region beside the figures, and a
    // breakdown rendered then would be a figure with no stated scope.
    expect(driversForAxis('project', null, resp('project', 'Project Zebra'), null)).toBeNull()
    expect(driversForAxis('project', undefined, resp('project', 'Project Zebra'), null)).toBeNull()
  })

  it('matches on region ID, not the display name two regions can share', () => {
    // `region.display_name` has no unique constraint (only `region.code` does), so
    // a name match would let a same-named twin through.
    const twin = { id: 'region-twin', code: 'drt', displayName: SCREEN_REGION.displayName }
    expect(driversForAxis('project', ON, resp('project', 'Twin project', twin), null)).toBeNull()
  })

  it('holds for the concentration card and the top-models bar, not just the table', () => {
    // Both read their own axis-fixed request DIRECTLY; both would otherwise show the
    // previous region's rows beside a table that had correctly gone empty.
    expect(teammateCutOnScreen(resp('teammate', 'Zoe'), ON)?.rows[0]?.label).toBe('Zoe')
    expect(teammateCutOnScreen(resp('teammate', 'Ann', OTHER_REGION), ON)).toBeNull()
    expect(teammateCutOnScreen(resp('project', 'Project Zebra'), ON)).toBeNull()

    expect(cutOnScreen(resp('model', 'Sonnet'), 'model', ON)?.rows[0]?.label).toBe('Sonnet')
    expect(cutOnScreen(resp('model', 'Sonnet', OTHER_REGION), 'model', ON)).toBeNull()
    expect(cutOnScreen(resp('teammate', 'Zoe'), 'model', ON)).toBeNull()
  })

  /*
   * THE REGION → "ALL REGIONS" TRANSITION, which a region-only guard cannot see.
   *
   * A whole-company payload carries `region: null` LEGITIMATELY, and the heading
   * carries `null` too during the switch — so the two compare EQUAL and every
   * card renders company-wide figures under the vanishing region's name. This is
   * not the same state as "the header has not landed yet": there, the payload is
   * a REGION payload and its non-null region fails the match. Here both sides are
   * null and only `width` tells them apart.
   */
  it('a whole-company payload never renders under a region heading, on ANY cut', () => {
    // Every guarded payload class, at the whole-company width, with the region
    // null on BOTH sides — the exact shape a region-only check lets through.
    expect(driversForAxis('project', null, resp('project', 'Company-wide', null, 'all-regions'), null)).toBeNull()
    expect(driversForAxis(TEAMMATE_AXIS, null, null, resp('teammate', 'Everyone', null, 'all-regions'))).toBeNull()
    expect(teammateCutOnScreen(resp('teammate', 'Everyone', null, 'all-regions'), null)).toBeNull()
    expect(cutOnScreen(resp('model', 'Opus', null, 'all-regions'), 'model', null)).toBeNull()
    expect(trendOnScreen(trendFor(null, 999, 'all-regions'), null)).toBeNull()
    expect(behaviourOnScreen(behaviourFor(null, 999, 'all-regions'), null)).toBeNull()

    // …and the guard is still DISCRIMINATING rather than a blanket null: the same
    // payloads at the clamped width, matching the heading, do render.
    expect(driversForAxis('project', ON, resp('project', 'Project Zebra'), null)?.rows[0]?.label).toBe(
      'Project Zebra',
    )
    expect(trendOnScreen(trendFor(SCREEN_REGION, ZEBRA_TREND_USD), ON)?.series[0]?.value).toBe(
      ZEBRA_TREND_USD,
    )
  })

  it('holds for the BEHAVIOUR response — the region', () => {
    /*
     * The last unguarded pair on the page. `/reports/region/behaviour` has always
     * returned its resolved width and region; nothing compared them, so after a
     * region switch the two behaviour cards drew the previous region's tier
     * exposure and per-developer curve under the new region's name.
     */
    expect(
      behaviourOnScreen(behaviourFor(SCREEN_REGION, ZEBRA_FRONTIER_USD), ON)?.exposure,
    ).toBeDefined()
    expect(behaviourOnScreen(behaviourFor(OTHER_REGION, AARDVARK_FRONTIER_USD), ON)).toBeNull()
    // Before the header names a region, nothing renders — same rule as the cuts.
    expect(behaviourOnScreen(behaviourFor(SCREEN_REGION, ZEBRA_FRONTIER_USD), null)).toBeNull()
    expect(behaviourOnScreen(null, ON)).toBeNull()

    // The WIDTH is checked too, and it is not redundant: a whole-company payload
    // carries `region: null` LEGITIMATELY, so a region-only check would let a
    // company-wide exposure figure render under one region's heading during the
    // window where the header names none.
    expect(behaviourOnScreen(behaviourFor(null, 999, 'all-regions'), null)).toBeNull()
  })

  it('holds for the trend response too — no axis to match, only the region', () => {
    // The trend's window is deliberately different from the report's (a rolling ~60
    // days in month mode), so the region is the only dimension the two payloads can
    // be compared on at all.
    expect(trendOnScreen(trendFor(SCREEN_REGION, ZEBRA_TREND_USD), ON)?.series[0]?.value).toBe(
      ZEBRA_TREND_USD,
    )
    expect(trendOnScreen(trendFor(OTHER_REGION, AARDVARK_TREND_USD), ON)).toBeNull()
    // …and before the header names a region, nothing renders — same rule as the cuts.
    expect(trendOnScreen(trendFor(SCREEN_REGION, ZEBRA_TREND_USD), null)).toBeNull()
    expect(trendOnScreen(null, ON)).toBeNull()
  })
})

// ── the container, mounted ───────────────────────────────────────────────────
const viewRenders = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('../../../app/components/reporting/ScopeRegionalView.vue', () => ({
  default: defineComponent({
    name: 'ScopeRegionalViewMock',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => {
        viewRenders.push({ ...attrs })
        return createEl('div', { 'data-testid': 'regional-view-mock' })
      }
    },
  }),
}))

// Imported AFTER the mock declaration for readability; `vi.mock` is hoisted above it.
const { default: ScopeRegional } = await import('../../../app/components/reporting/ScopeRegional.vue')

interface FakeRequest {
  data: Ref<unknown>
  pending: Ref<boolean>
  error: Ref<unknown>
  execute: () => Promise<void>
}

/** Every `useFetch`/`$fetch` the container made, and every hand-driven execute(). */
interface Harness {
  byKey: Map<string, FakeRequest>
  /** (key, url, axis) for each useFetch the container declared. */
  declared: { key: string; url: string; axis?: string }[]
  /** The axis each hand-driven execute() actually asked the server for. */
  executedAxes: string[]
  /** Every URL passed to `$fetch` (the MoM prior-month read is the only legitimate one). */
  dollarFetchUrls: string[]
  /** Every URL query the container wrote back to the address bar. */
  routerReplaces: unknown[]
  setAxis: (axis: string) => Promise<void>
  view: () => Record<string, unknown>
}

let harness: Harness

function lastRender(): Record<string, unknown> {
  const r = viewRenders[viewRenders.length - 1]
  if (!r) throw new Error('ScopeRegionalView never rendered')
  return r
}

async function mountContainer(): Promise<Harness> {
  viewRenders.length = 0
  const byKey = new Map<string, FakeRequest>()
  const declared: { key: string; url: string; axis?: string }[] = []
  const executedAxes: string[] = []
  const dollarFetchUrls: string[] = []
  const routerReplaces: unknown[] = []

  const useFetchStub = (url: string, opts: Record<string, unknown>) => {
    const key = String(opts.key)
    const queryOf = () => (unref(opts.query) ?? {}) as Record<string, string>
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        data: ref(null),
        pending: ref(false),
        error: ref(null),
        execute: () => {
          executedAxes.push(queryOf().axis ?? '')
          return Promise.resolve()
        },
      }
      byKey.set(key, entry)
    }
    declared.push({ key, url, axis: queryOf().axis })
    return entry
  }

  const route = reactive({ query: {} as Record<string, string> })
  stubServerClock()
  // The container reads the session for the admin-only "Fix org homing →".
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'manager' }) }))
  vi.stubGlobal('useFetch', useFetchStub)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({
    replace: (to: unknown) => {
      routerReplaces.push(to)
    },
  }))
  vi.stubGlobal('$fetch', async (url: string) => {
    dollarFetchUrls.push(url)
    /*
     * The whole-company region ranking the DELETED default-region rule asked for,
     * in the shape that made it act: a region other than the one the report already
     * named, with usd > 0. Without it a restored block would throw on the missing
     * `rows`, be swallowed by its own `catch`, and never reach `rs.patch` — so the
     * two deletion guards below would stay green against the very code they exist
     * to forbid.
     */
    if (url.includes('across-regions')) return { rows: [{ key: OTHER_REGION.id, usd: 99 }] }
    return { kpis: { genuineUsd: 0 } }
  })

  mount(ScopeRegional)
  await flushPromises()

  return {
    byKey,
    declared,
    executedAxes,
    dollarFetchUrls,
    routerReplaces,
    async setAxis(axis: string) {
      const emit = lastRender()['onUpdate:driversAxis'] as (v: string) => void
      emit(axis)
      await nextTick()
      await flushPromises()
    },
    view: lastRender,
  }
}

/**
 * A settled primary report, so `refetching`'s first-load guard is satisfied. Its
 * `region` is the one the header names — what every drivers payload is measured
 * against.
 *
 * Shaped so the DELETED client rule would RUN against it, because a fixture that
 * cannot reach deleted code certifies nothing about its absence:
 *   - `region` — the server's resolved default. The old rule compared its own pick
 *     against exactly this before patching.
 *   - `regionOptions` NON-EMPTY. The old rule returned early on
 *     `regionOptions.length === 0`, so a fixture without them made both deletion
 *     guards below pass with the whole block pasted back verbatim (measured).
 */
const REPORT = {
  meta: { month: '2026-07', asOfDate: null },
  region: SCREEN_REGION,
  regionOptions: [SCREEN_REGION, OTHER_REGION],
  kpis: { genuineUsd: 100 },
}

/** The same report after the viewer switched to the other region. */
const REPORT_OTHER = { ...REPORT, region: OTHER_REGION }

async function set<T>(r: Ref<T>, v: T): Promise<void> {
  r.value = v
  await nextTick()
  await flushPromises()
}

/** Land a primary report, so the header names a region the cuts can be matched to. */
async function landReport(report: unknown = REPORT): Promise<void> {
  await set(harness.byKey.get('reports-regional')!.data, report)
}

beforeEach(async () => {
  harness = await mountContainer()
})

afterEach(() => vi.unstubAllGlobals())

describe('the Regional container issues no request it throws away', () => {
  it('requests the table’s own cut on every axis EXCEPT teammate', async () => {
    // Mounted on the default axis (project, decisions D1) — one request.
    expect(harness.executedAxes).toEqual(['project'])

    // The teammate axis is the concentration card's URL under another key. Nuxt
    // shares in-flight promises per key, not per URL, so issuing it here is a
    // second network round-trip for an answer already on its way.
    await harness.setAxis(TEAMMATE_AXIS)
    expect(harness.executedAxes).toEqual(['project'])

    // Every other axis is a genuinely different question and must be asked.
    await harness.setAxis('model')
    expect(harness.executedAxes).toEqual(['project', 'model'])
    await harness.setAxis('practice')
    expect(harness.executedAxes).toEqual(['project', 'model', 'practice'])

    // …and returning to teammate skips again — the gate is not a one-shot.
    await harness.setAxis(TEAMMATE_AXIS)
    expect(harness.executedAxes).toEqual(['project', 'model', 'practice'])
  })

  it('still asks three DISTINCT drivers cuts — the collapse is not a deletion', async () => {
    // Dropping a cut instead of de-duplicating it would blank the top-models bar
    // or the concentration card.
    const driverCuts = harness.declared.filter((d) => d.url.endsWith('/reports/region/drivers'))
    expect(new Set(driverCuts.map((d) => d.key)).size).toBe(3)
    expect(new Set(driverCuts.map((d) => d.axis))).toEqual(new Set(['project', 'model', 'teammate']))
  })

  it('never asks an across-regions endpoint to second-guess the default region', async () => {
    // The deleted round-trip. The server resolves the default from the caller
    // alone; a client that re-ranked regions by spend would both waste the first
    // round AND make the answer depend on the window it was ranked over.
    //
    // REPORT carries a non-empty `regionOptions` and the URL names no region, which
    // is exactly the state the deleted rule acted on — without both, this passes
    // against the restored block.
    await landReport()
    await harness.setAxis(TEAMMATE_AXIS)
    await harness.setAxis('project')
    const urls = [...harness.declared.map((d) => d.url), ...harness.dollarFetchUrls]
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.filter((u) => u.includes('across-regions'))).toEqual([])
  })

  it('never patches a region of its own into the URL', async () => {
    // The other half of the deleted round-trip: the old container wrote the region
    // it had picked back into the address bar, which recomputed every query object
    // and re-issued all seven fetches.
    //
    // The stubbed ranking names OTHER_REGION — NOT the region REPORT resolved — so
    // the restored rule's `top.key !== r.region?.id` guard passes and it reaches
    // `rs.patch`. A ranking that agreed with the server would make this vacuous.
    await landReport()
    expect(harness.routerReplaces).toEqual([])
  })
})

describe('the table reads the request that is actually serving it', () => {
  it('renders the concentration card’s rows under the teammate heading', async () => {
    // The report lands FIRST, so the header names a region and the cuts below are
    // matched against it rather than falling out on a header that names none.
    await landReport()
    await set(harness.byKey.get('reports-regional-drivers')!.data, resp('project', 'Project Zebra'))
    await set(harness.byKey.get('reports-regional-drivers-teammate')!.data, resp('teammate', 'Zoe'))

    await harness.setAxis(TEAMMATE_AXIS)
    expect((harness.view().drivers as RegionalDriversResp | null)?.rows[0]?.label).toBe('Zoe')

    await harness.setAxis('project')
    expect((harness.view().drivers as RegionalDriversResp | null)?.rows[0]?.label).toBe('Project Zebra')
  })

  it('renders NOTHING rather than a payload from another axis', async () => {
    // The table's own ref holding a foreign axis is not hypothetical: on the
    // teammate axis its request never runs, and on every other axis it lags one
    // response behind while the new cut is in flight.
    // The report is landed FIRST so the region matches: the null below is caused by
    // the foreign axis alone, not by a header that names no region yet.
    await landReport()
    await harness.setAxis('project')
    await set(harness.byKey.get('reports-regional-drivers')!.data, resp('teammate', 'Zoe'))
    expect(harness.view().drivers).toBeNull()
  })

  it('surfaces the table’s error ONLY on the axes its request serves', async () => {
    const own = harness.byKey.get('reports-regional-drivers')!
    const stale = new Error('the project cut failed, three axes ago')

    // Teammate axis: the table's own request did not run, so its error ref is
    // inert history. Banner-ing it would blame a request nothing is waiting on.
    await harness.setAxis(TEAMMATE_AXIS)
    await set(own.error, stale)
    expect(harness.view().error).toBeUndefined()

    // Project axis: that same ref IS the table's request, so the error is real
    // and must reach the banner.
    await harness.setAxis('project')
    expect(harness.view().error).toBe(stale)
  })

  it('marks a refetch from the pending flag of the request serving the table', async () => {
    const own = harness.byKey.get('reports-regional-drivers')!
    const cut = harness.byKey.get('reports-regional-drivers-teammate')!

    // A first load is not a refetch: let one full generation settle first.
    await landReport()
    await set(cut.pending, true)
    await set(cut.pending, false)

    // Teammate axis + the table's OWN request pending. It is not serving the
    // table, so the screen is settled and must not claim to be updating.
    await harness.setAxis(TEAMMATE_AXIS)
    await set(own.pending, true)
    expect(harness.view().refetching).toBe(false)

    // Project axis: the same pending flag now IS the table's, and the figures on
    // screen are genuinely provisional.
    await harness.setAxis('project')
    expect(harness.view().refetching).toBe(true)
  })
})

/*
 * The set named in this describe is the set that is GUARDED, and it is NOT every
 * card on the screen. Everything else can still lag a region behind while its
 * next response is in flight.
 *
 * Deliberately NOT enumerating the unguarded cards here. An earlier draft did,
 * and the list was already incomplete: it named active-trend and seasonality but
 * missed the MoM watcher, which only re-fires when a watched value CHANGES, so a
 * new region whose genuineUsd equals the old one's leaves the prior figure on
 * screen. A list of what is not covered reads as exhaustive and cannot be
 * checked; the describe name is the claim, and it names only what these
 * assertions prove.
 */
describe('the drivers table, the concentration card, top models and the trend render only the region the header names', () => {
  it('a lagging cross-region payload reaches NEITHER the table, the concentration card, top models NOR the trend', async () => {
    /*
     * The real sequence. The viewer switches region; `/reports/regional` is the
     * fastest of the seven (measured), so the HEADER flips to the new region while
     * the three drivers refs and the trend ref still hold the previous region's
     * answers — right axis, wrong region. Unguarded, every one of them renders under
     * the new region's name.
     */
    await landReport()
    await set(harness.byKey.get('reports-regional-drivers')!.data, resp('project', 'Project Zebra'))
    await set(harness.byKey.get('reports-regional-drivers-teammate')!.data, resp('teammate', 'Zoe'))
    await set(harness.byKey.get('reports-regional-drivers-model')!.data, resp('model', 'Sonnet'))
    await set(harness.byKey.get('reports-regional-trend')!.data, trendFor(SCREEN_REGION, ZEBRA_TREND_USD))

    // Everything agrees: all four are populated. Without this half the test would
    // pass with the cards permanently blank.
    expect((harness.view().drivers as RegionalDriversResp | null)?.rows[0]?.label).toBe('Project Zebra')
    expect(harness.view().concentration).not.toBeNull()
    expect((harness.view()['model-drivers'] as RegionalDriversResp | null)?.rows[0]?.label).toBe('Sonnet')
    expect((harness.view().trend as RegionalTrendResp | null)?.series[0]?.value).toBe(ZEBRA_TREND_USD)

    // The header now names the OTHER region; the four payloads still say Zebra.
    await landReport(REPORT_OTHER)
    expect(harness.view().drivers).toBeNull()
    expect(harness.view().concentration).toBeNull()
    expect(harness.view()['model-drivers']).toBeNull()
    expect(harness.view().trend).toBeNull()

    // …and each card comes back as the response for the region on screen lands.
    await set(harness.byKey.get('reports-regional-drivers')!.data, resp('project', 'Project Aardvark', OTHER_REGION))
    await set(harness.byKey.get('reports-regional-drivers-teammate')!.data, resp('teammate', 'Ann', OTHER_REGION))
    await set(harness.byKey.get('reports-regional-drivers-model')!.data, resp('model', 'Opus', OTHER_REGION))
    await set(harness.byKey.get('reports-regional-trend')!.data, trendFor(OTHER_REGION, AARDVARK_TREND_USD))
    expect((harness.view().drivers as RegionalDriversResp | null)?.rows[0]?.label).toBe('Project Aardvark')
    expect(harness.view().concentration).not.toBeNull()
    expect((harness.view()['model-drivers'] as RegionalDriversResp | null)?.rows[0]?.label).toBe('Opus')
    expect((harness.view().trend as RegionalTrendResp | null)?.series[0]?.value).toBe(
      AARDVARK_TREND_USD,
    )
  })

  it('a CACHED whole-company payload never draws under a region heading', async () => {
    /*
     * The `region=all` transition, at the container. `useFetch` caches per KEY,
     * so when the viewer moves between the clamped and whole-company widths the
     * same keys can be holding a payload computed at the OTHER width. That
     * payload carries `region: null` legitimately — and while the header is
     * mid-swap it names no region either, so a region-only comparison returns
     * EQUAL and whole-company drivers, models and trend draw under a region's
     * name. `width` is the only field that separates the two.
     */
    await landReport()
    await set(harness.byKey.get('reports-regional-drivers')!.data, resp('project', 'Project Zebra'))
    await set(harness.byKey.get('reports-regional-drivers-model')!.data, resp('model', 'Sonnet'))
    await set(harness.byKey.get('reports-regional-trend')!.data, trendFor(SCREEN_REGION, ZEBRA_TREND_USD))
    // Populated first — otherwise this passes with the cards permanently blank.
    expect(harness.view().drivers).not.toBeNull()
    expect(harness.view()['model-drivers']).not.toBeNull()
    expect(harness.view().trend).not.toBeNull()

    // The whole-company answers land on the SAME keys while the heading is still
    // a region's. Right axis, null region on both sides, wrong width.
    await set(
      harness.byKey.get('reports-regional-drivers')!.data,
      resp('project', 'Company-wide project', null, 'all-regions'),
    )
    await set(
      harness.byKey.get('reports-regional-drivers-model')!.data,
      resp('model', 'Company-wide Opus', null, 'all-regions'),
    )
    await set(harness.byKey.get('reports-regional-trend')!.data, trendFor(null, 999, 'all-regions'))
    expect(harness.view().drivers).toBeNull()
    expect(harness.view()['model-drivers']).toBeNull()
    expect(harness.view().trend).toBeNull()
  })
})

/*
 * THE BEHAVIOUR REQUEST, WIRED LIKE EVERY OTHER ONE.
 *
 * It was declared as `const { data: behaviour } = useFetch(...)`, so its
 * `pending` and `error` refs were dropped on the floor and its payload went
 * straight to the view. Three consequences, all of them the screen asserting
 * something it does not know:
 *
 *   - a generation where only behaviour was still in flight reported itself
 *     SETTLED, with two cards mid-swap under a settled heading;
 *   - a failed behaviour request left the previous answer on screen with no
 *     banner — stale figures presented as an answer;
 *   - after a region switch the previous region's exposure rendered under the new
 *     region's name, beside drivers and trend cards that had correctly blanked.
 *
 * These are container assertions rather than pure-function ones because all three
 * are about WHICH REFS THE CONTAINER READS. `behaviourOnScreen` can be perfect
 * and every one of them still ship.
 */
describe('the behaviour request is read on all three of its refs', () => {
  it('a behaviour request still in flight marks the screen provisional', async () => {
    const behaviourReq = harness.byKey.get('reports-regional-behaviour')!

    // Let one full generation settle first — a first load is not a refetch.
    await landReport()
    await set(behaviourReq.pending, true)
    await set(behaviourReq.pending, false)
    expect(harness.view().refetching).toBe(false)

    // Behaviour ALONE is in flight. Every other request is idle, so if this ref
    // is not read the screen claims to be settled while two cards are swapping.
    await set(behaviourReq.pending, true)
    expect(harness.view().refetching).toBe(true)
  })

  it('a failed behaviour request reaches the error banner', async () => {
    const boom = new Error('behaviour blew up')
    await landReport()
    expect(harness.view().error).toBeUndefined()
    await set(harness.byKey.get('reports-regional-behaviour')!.error, boom)
    expect(harness.view().error).toBe(boom)
  })

  it('a lagging cross-region behaviour payload does not reach the view', async () => {
    /*
     * The real sequence, exactly as for the drivers and trend cuts above:
     * `/reports/region` is the fastest of the requests, so the HEADING flips to
     * the new region while the behaviour ref still holds the previous region's
     * answer.
     */
    await landReport()
    await set(
      harness.byKey.get('reports-regional-behaviour')!.data,
      behaviourFor(SCREEN_REGION, ZEBRA_FRONTIER_USD),
    )
    // Populated first — without this half the test passes with the cards
    // permanently blank.
    expect(harness.view().behaviour).not.toBeNull()

    await landReport(REPORT_OTHER)
    expect(harness.view().behaviour).toBeNull()

    // …and it comes back as the response for the region on screen lands.
    await set(
      harness.byKey.get('reports-regional-behaviour')!.data,
      behaviourFor(OTHER_REGION, AARDVARK_FRONTIER_USD),
    )
    expect(harness.view().behaviour).not.toBeNull()
    expect(
      (harness.view().behaviour as BehaviourReport).exposure.providers[0]!.bandedSpendUsd,
    ).toBe(AARDVARK_FRONTIER_USD)
  })
})
