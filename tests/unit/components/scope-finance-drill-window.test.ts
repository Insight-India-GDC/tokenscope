// @vitest-environment happy-dom
/*
 * r3-M6 — FINANCE'S DRILL LINKS CARRY FINANCE'S WINDOW.
 *
 * Finance is the ONE reporting scope whose default window is not the current
 * month: you cannot charge back a month in progress, so a bare
 * `/reporting?scope=finance` shows the LAST COMPLETE month. Its teammate drill
 * links were built from `useDrillWindow()`, which reads the raw `useReportState`
 * keys — all null in that default state. The link therefore carried no `month`,
 * and `drill-contract`'s `frameWindow()` correctly filled in the CURRENT month:
 * a row of July money opening an August page (different data), or a 403 when
 * the subject has no August row in the frame.
 *
 * The window a link carries must be the window the figures beside it were read
 * at — so it is derived from the SAME computed the two fetches bind on.
 *
 * ── MIGRATED BY F1 (clock-rot-audit.md §F-a) ────────────────────────────────
 * The expectations here were `lastCompleteMonth()` / `currentMonth()`
 * re-implemented from the component and reading `new Date()` — the only test
 * documenting the finance default-window contract, written against the browser
 * clock it was documenting. The clock is stubbed now, so the months are
 * literals: "July, because the pinned server day is in August".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
// Imported AFTER the mocks below by hoisting: `vi.mock` calls are lifted above
// every import, so the component picks up the stubbed composables.
import ScopeFinance from '../../../app/components/reporting/ScopeFinance.vue'
import { stubServerClock } from '../../helpers/server-clock'

const rs = {
  month: ref<string | null>(null),
  from: ref<string | null>(null),
  to: ref<string | null>(null),
  region: ref<string | null>(null),
  cc: ref<string | null>(null),
  patch: vi.fn(),
}

vi.mock('../../../app/composables/useReportState', () => ({ useReportState: () => rs }))
vi.mock('../../../app/composables/useDrillContract', () => ({
  useDrillGrants: () => computed(() => ({ teammate: 'people-scope', project: 'region-wide' })),
  /*
   * The raw-URL window reader. Finance must NOT use it — its default window is
   * not in the URL at all — so calling it here is the failure, not a fallback.
   */
  useDrillWindow: () => {
    throw new Error('Finance must derive its drill window from its EFFECTIVE window')
  },
}))

/*
 * The pinned server clock. 15 August 2026 ⇒ the last COMPLETE month is July —
 * the finance default, and deliberately not the month the clock is in.
 */
const TODAY = '2026-08-15T09:14:00Z'
const LAST_COMPLETE_MONTH = '2026-07'
const CURRENT_MONTH = '2026-08'

const STUBS = {
  ScopeFinanceView: {
    props: ['drillWindow'],
    template: '<div data-testid="view">{{ JSON.stringify(drillWindow) }}</div>',
  },
  FinancePeriodControl: true,
  SettlingStateChip: true,
  CoverageMarker: true,
}

/*
 * `execute` is the seam the container now drives: the index fetch is declared
 * `immediate: false` and only runs once the window RESOLVES (F1/D3 — the file's
 * own comment promised the fetches hold; they did not, and fired with an empty
 * query on first paint). Spying on it is how a test can see the hold at all.
 *
 * The counter is PER MOUNT, not a module-level `let`: `rs` is shared and the
 * components from earlier `it`s stay mounted, so a shared counter would also be
 * ticked by their watchers when a later test writes to the state.
 */
let calls = { n: 0 }
const executeCalls = () => calls.n
function mountFinance(clockAt: string | null = TODAY) {
  const mine = { n: 0 }
  calls = mine
  stubServerClock(clockAt)
  // The container reads the session for the admin-only "Fix org homing →".
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'manager' }) }))
  vi.stubGlobal('useFetch', () => ({
    data: ref(null),
    pending: ref(false),
    error: ref(null),
    execute: () => {
      mine.n += 1
    },
  }))
  vi.stubGlobal('$fetch', async () => null)
  return mount(ScopeFinance, { global: { stubs: STUBS } })
}

const drillWindowOf = (w: ReturnType<typeof mountFinance>) =>
  JSON.parse(w.find('[data-testid="view"]').text()) as {
    month: string | null
    from: string | null
    to: string | null
  }

beforeEach(() => {
  rs.month.value = null
  rs.from.value = null
  rs.to.value = null
  rs.region.value = null
  rs.cc.value = null
})

describe('ScopeFinance — the drill window is the EFFECTIVE window (r3-M6)', () => {
  it('the DEFAULT state carries the last complete month, not an empty window', () => {
    const w = mountFinance()
    const dw = drillWindowOf(w)
    expect(dw.month).toBe(LAST_COMPLETE_MONTH)
    // The defect it replaces: an absent month, which the drill contract fills
    // in with the CURRENT month — a different period than the figures shown.
    expect(dw.month).not.toBeNull()
    expect(dw.month).not.toBe(CURRENT_MONTH)
    expect(dw.from).toBeNull()
    expect(dw.to).toBeNull()
  })

  it('an explicit month wins — the link follows what the reader selected', () => {
    rs.month.value = '2026-03'
    const w = mountFinance()
    expect(drillWindowOf(w)).toEqual({ month: '2026-03', from: null, to: null })
  })

  it('a quarter range carries the RANGE and no month — one window, never both', () => {
    rs.from.value = '2026-04-01'
    rs.to.value = '2026-06-30'
    const w = mountFinance()
    expect(drillWindowOf(w)).toEqual({ month: null, from: '2026-04-01', to: '2026-06-30' })
  })
})

describe('the finance default month comes from the SERVER clock (F1/D3)', () => {
  it('BEFORE the clock lands the drill window carries no month — it does not guess', () => {
    // FinancePeriodControl and ScopeFinance used to hold BYTE-IDENTICAL copies
    // of `lastCompleteMonth(now = new Date())`: the control and the scope that
    // consumes it each computed the default separately, and agreed by luck.
    // Neither may invent a billing period from a browser clock.
    const w = mountFinance(null)
    expect(drillWindowOf(w).month).toBeNull()
  })

  it('the default follows the SERVER day, not the viewer\'s', () => {
    // Same wall-clock moment, a server day either side of a month boundary: the
    // finance default must move with the server, and only with the server.
    expect(drillWindowOf(mountFinance('2026-08-15T09:14:00Z')).month).toBe('2026-07')
    expect(drillWindowOf(mountFinance('2026-09-01T00:30:00Z')).month).toBe('2026-08')
    expect(drillWindowOf(mountFinance('2027-01-01T00:30:00Z')).month).toBe('2026-12')
  })
})

describe('the index fetch HOLDS until the window resolves (external review)', () => {
  /*
   * The file's own comment on `effectiveMonth` promised it: "the fetches below
   * hold rather than requesting a month nobody resolved". They did not —
   * `useFetch` fired immediately with an EMPTY query, so a cold
   * `/reporting?scope=finance` asked the SERVER to pick the window, which is a
   * second clock (F1/D3), and then replaced it once the real month arrived.
   * Two windows, one screen, and the header label belonged to only one of them.
   *
   * RED ON REVERT: drop `immediate: false` (and the guard watch) and the first
   * case executes on mount with nothing resolved.
   */
  it('does not fetch before the clock lands and no ?month is set', () => {
    mountFinance(null)
    expect(executeCalls()).toBe(0)
  })

  it('fetches as soon as the window resolves from the clock', () => {
    mountFinance()
    expect(executeCalls()).toBe(1)
  })

  it('fetches immediately when the URL already carries the window', () => {
    rs.month.value = '2026-03'
    mountFinance(null) // no clock at all — the URL is window enough
    expect(executeCalls()).toBe(1)
  })
})
