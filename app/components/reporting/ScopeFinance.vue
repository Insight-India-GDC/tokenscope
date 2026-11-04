<script setup lang="ts">
/*
 * ScopeFinance — the DATA CONTAINER + persistent header for the FINANCE (§B
 * chargeback / bill-reconciliation) scope. Owns the fetches
 * (`/reports/finance{,/[couId]}`), the URL state (via useReportState), and the
 * header (title + DateRangeControl + the ONE consolidated settling chip), then hands
 * the pure body props to ScopeFinanceView. Keeping the header here (not in the view)
 * is deliberate: the view stays bare-mountable / unit-testable, while the header —
 * which self-wires the useReportState-bound DateRangeControl — lives where the router
 * is always present.
 *
 * WINDOW: a custom `[from, to]` range wins when the DateRangeControl set one; else
 * Finance DEFAULTS to the LAST COMPLETE month (you cannot charge back a month in
 * progress). The bill/chargeback surfaces are month-grained, so a custom range picks
 * up the whole `period_month`s it spans (server side). The per-CoU DRILL windows on the
 * SAME period as the index (the full range in quarter mode), so the drill's Chargeable
 * foots to the index's per-CoU total — never to just the range's first month.
 *
 * The CoU drill reuses the shared `cc` URL key (a CoU IS a cost-owning unit); a tab
 * switch already clears `cc`, so no stale drill survives a scope change.
 */
import { computed, ref, watch } from 'vue'
import ScopeFinanceView from './ScopeFinanceView.vue'
import FinancePeriodControl from './FinancePeriodControl.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import CoverageMarker from './CoverageMarker.vue'
import { useReportState } from '../../composables/useReportState'
import { useDrillGrants } from '../../composables/useDrillContract'
import { useAdminAccess } from '../../composables/useAdminAccess'
import type { DrillFrame } from './drill-contract'
import type { FinanceReport, FinanceDrill } from './finance-report-types'
import type { SettlingState } from '#shared/reports/types'
import { monthLabel, quarterLabel } from './window-labels'
import { lastCompleteMonth } from './period-presets'



const rs = useReportState()

/*
 * "Last complete month" — the finance default — comes from the SERVER's clock
 * (F1/D3). This file held a BYTE-IDENTICAL copy of FinancePeriodControl's own
 * `lastCompleteMonth(now = new Date())`: the control and the scope that consumes
 * it each computed the default month separately and agreed by luck. One
 * definition now, shared, and pure (`period-presets.ts`).
 */
const { today } = useServerClock()
const financeDefaultMonth = computed(() =>
  today.value ? lastCompleteMonth(today.value) : null,
)

/*
 * THE DRILL CONTRACT's two container-level reads (D29/D30). They live HERE, with
 * every other fetch and URL read on this scope, and travel down as props — the
 * presentational view stays mountable without a Nuxt context, which is the same
 * split every other prop on it already follows.
 */
const drillGrants = useDrillGrants()

// Active window: a custom range wins when BOTH bounds are set; else the finance
// month default (last complete month — an in-progress month cannot be charged back).
const isRange = computed(() => Boolean(rs.from.value && rs.to.value))
/**
  * The month the figures are actually for. `null` until the clock lands AND no
  * explicit `?month` is set — the fetches below hold rather than requesting a
  * month nobody resolved.
  */
const effectiveMonth = computed<string | null>(() => rs.month.value ?? financeDefaultMonth.value)

// The window params both the index AND the drill bind on — a custom `[from, to]` range
// in quarter mode, else the finance month default (region is index-only, added below).
const windowQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {}
  if (isRange.value) {
    q.from = rs.from.value as string
    q.to = rs.to.value as string
  } else if (effectiveMonth.value) {
    q.month = effectiveMonth.value
  }
  return q
})

/*
 * THE DRILL WINDOW IS THE EFFECTIVE WINDOW, not the raw URL keys (r3-M6).
 *
 * `useDrillWindow()` reads `useReportState` verbatim, which is right on every
 * scope whose default window IS the current month. Finance is the ONE surface
 * with a different default (last complete month), so a bare `/reporting?scope=
 * finance` has `rs.month === null` while its figures are July's: a teammate link
 * built from the raw keys carried no `month` at all, and the drill opened on
 * AUGUST — different data than the row that was clicked, or a 403 when the
 * subject has no August row in the frame. The window is therefore derived from
 * the SAME `windowQuery` the two fetches bind on, so a link can never carry a
 * window different from the figures beside it.
 */
// "Fix org homing →" opens /admin, which bounces non-admins: show it to admins only.
const { isAdmin: canFixHoming } = useAdminAccess()

const drillWindow = computed<Omit<DrillFrame, 'src'>>(() =>
  isRange.value
    ? { month: null, from: rs.from.value as string, to: rs.to.value as string }
    : { month: effectiveMonth.value ?? null, from: null, to: null },
)

const indexQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = { ...windowQuery.value }
  if (rs.region.value) q.region = rs.region.value
  return q
})

/*
 * ── THE FETCH ACTUALLY HOLDS NOW (external review) ───────────────────────────
 *
 * `effectiveMonth` is null until the clock lands, and the comment on it said the
 * fetches "hold rather than requesting a month nobody resolved". They did not:
 * `useFetch` fired immediately with an EMPTY query, so the first paint of a cold
 * `/reporting?scope=finance` asked the server to pick its own window — which is
 * a second clock, the exact thing F1/D3 removes — and then replaced it a moment
 * later once the real month arrived. Two windows, one screen, and the header
 * label belonged to only one of them.
 *
 * `immediate: false` plus the guard below is what honours the claim. Once the
 * window resolves, `useFetch`'s own watch on the reactive `query` keeps every
 * later change refetching exactly as before.
 */
const windowResolved = computed(() => isRange.value || effectiveMonth.value != null)
const {
  data: report,
  pending,
  error,
  execute: executeReport,
} = useFetch<FinanceReport>('/api/v1/reports/finance', {
  query: indexQuery,
  key: 'reports-finance',
  lazy: true,
  server: false,
  immediate: false,
  // No auto-retry on 5xx (plan D9) — every report fetch on this page opts out.
  retry: false,
})
watch(
  windowResolved,
  (resolved) => {
    if (resolved) void executeReport()
  },
  { immediate: true },
)

// The drill is a per-`cc` (CoU) resource — fetch imperatively so a null `cc` never
// fires a request, and a missing CoU surfaces its 404 here.
const drill = ref<FinanceDrill | null>(null)
const drillPending = ref(false)
const drillError = ref<unknown>(null)
watch(
  [() => rs.cc.value, windowQuery, windowResolved],
  async () => {
    const cc = rs.cc.value
    // The drill holds for the SAME reason the index does: a drill fetched on an
    // unresolved window is a different period than the row that was clicked.
    if (!cc || !windowResolved.value) {
      drill.value = null
      drillError.value = null
      drillPending.value = false
      return
    }
    drillPending.value = true
    drillError.value = null
    try {
      drill.value = await $fetch<FinanceDrill>(`/api/v1/reports/finance/${cc}`, {
        query: windowQuery.value,
        retry: false,
      })
    } catch (e) {
      drillError.value = e
      drill.value = null
    } finally {
      drillPending.value = false
    }
  },
  { immediate: true },
)

// ── Header meta ──────────────────────────────────────────────────────────────
// A range produced by the period control is always a whole quarter — label it as
// such ("Q2 2026"); fall back to the raw span for any hand-crafted URL range.
// quarterLabel checks BOTH bounds (window-labels.ts): naming a period from its
// start alone labelled a three-quarter span "Q2 2026".
const windowLabel = computed(() => {
  if (isRange.value) {
    return (
      quarterLabel(rs.from.value as string, rs.to.value as string) ??
      `${rs.from.value} → ${rs.to.value}`
    )
  }
  return effectiveMonth.value ? monthLabel(effectiveMonth.value) : ''
})
// Show the "defaults to last complete month" note only in that default state.
const isDefaultMonth = computed(
  () =>
    !isRange.value &&
    financeDefaultMonth.value != null &&
    effectiveMonth.value === financeDefaultMonth.value,
)

// ONE consolidated settling chip: the honest whole-lane state is the LEAST settled of
// the month's provider states (never overclaim). estimated < settling < settled.
const RANK: Record<SettlingState, number> = { estimated: 0, settling: 1, settled: 2 }
const consolidatedState = computed(() => {
  const ps = report.value?.meta.providerStates ?? []
  const first = ps[0]
  if (!first) return null
  return ps.reduce((min, p) => (RANK[p.state] < RANK[min.state] ? p : min), first)
})
const coverage = computed(() => report.value?.meta.coverage ?? null)

// Export (ledger CSV) is month-grained (D-Q8 grain cost-centre × provider × month) —
// anchor to the window's representative (start) month in range mode.
const exportMonth = computed<string | null>(() =>
  isRange.value ? (rs.from.value as string).slice(0, 7) : effectiveMonth.value,
)
const exportParams = computed(() => {
  const p: Record<string, string> = { scope: 'finance', report: 'ledger' }
  if (exportMonth.value) p.month = exportMonth.value
  if (rs.region.value) p.region = rs.region.value
  return p
})
const exportFilename = computed(() => `tokenscope-finance-ledger-${exportMonth.value}.csv`)
</script>

<template>
  <div data-testid="scope-finance-container">
    <!-- ── Header (persists across index / drill and every fetch state) ──────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Chargeback &amp; reconciliation
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">Finance</h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <span class="text-[12px] font-semibold text-carbon-2 tabular-nums" data-testid="finance-window-label">
            {{ windowLabel }}
          </span>
          <SettlingStateChip
            v-if="consolidatedState"
            :state="consolidatedState.state"
            :horizon-date="consolidatedState.settlesAt"
            data-testid="finance-settling"
          />
          <CoverageMarker :coverage="coverage" />
          <span
            v-if="isDefaultMonth"
            class="text-[11px] text-carbon-3 italic"
          >Finance defaults to the last complete month — an in-progress month can't be charged back.</span>
        </div>
      </div>

      <FinancePeriodControl class="shrink-0" />
    </header>

    <ScopeFinanceView
      :report="report ?? null"
      :drill="drill"
      :is-drill="Boolean(rs.cc.value)"
      :pending="pending"
      :error="error"
      :drill-pending="drillPending"
      :drill-error="drillError"
      :export-params="exportParams"
      :export-filename="exportFilename"
      :ledger-month-only="isRange"
      :drill-grants="drillGrants"
      :drill-window="drillWindow"
      :can-fix-homing="canFixHoming"
      @drill="rs.patch({ cc: $event })"
      @clear-drill="rs.patch({ cc: null })"
    />
  </div>
</template>
