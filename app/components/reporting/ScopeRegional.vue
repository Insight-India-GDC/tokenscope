<script setup lang="ts">
/*
 * ScopeRegional — the DATA CONTAINER for the Region scope's SINGLE-REGION width
 * (build-design §3; 04-prototype-delta.md §6), rebuilt on the reporting chart kit.
 *
 * It is no longer a scope of its own: `ScopeRegion` mounts it whenever the region
 * selector is on a region rather than "All regions". Its requests carry that region
 * (or none, meaning the caller's server-resolved default), which is what routes the
 * endpoint to `clampedUsage` rather than the whole-company answer.
 *
 * Owns every fetch and reads the URL state via useReportState (the sole owner of
 * month + region + ou + the custom `from`/`to` range), then hands everything to
 * the pure ScopeRegionalView tree.
 *
 * WINDOW: all fetches honour the active window — a custom `[from, to]` range when
 * the DateRangeControl set one, else `month` (else the server's current-month
 * default). Forecast/MoM come back null for a custom range; the View hides them.
 *
 * DRIVERS: three cuts so each card is stable and self-contained —
 *   - `drivers`         : the switchable DriversTable (axis = table state). On the
 *     teammate axis it READS `teammateDrivers` rather than requesting the same URL
 *     a second time under its own key, and it renders a response only while that
 *     response's OWN `axis` and `region` are the ones on screen (teammate-cut.ts).
 *   - `modelDrivers`    : Top-models ranked bar (axis=model)
 *   - `teammateDrivers` : Concentration (axis=teammate) — computed client-side,
 *     through the same on-screen test
 *
 * TREND: the trend request carries its own `region` (no axis), so it goes through the
 * REGION half of that test too (`trendOnScreen`) — one guard for every trend-derived
 * surface. `active-trend` returns no region and is NOT covered —
 * see teammate-cut.ts.
 *
 * BEHAVIOUR: `/reports/region/behaviour` reflects back BOTH the width it answered
 * at and the region it answered for, so it takes the same test
 * (`behaviourOnScreen`). Its pending and error refs are read like every other
 * request's — a request whose three refs are discarded is a request that reports a
 * half-loaded screen as settled and a failed one as an answer.
 *
 * DEFAULT REGION: resolved SERVER-SIDE (resolveRegionalScope) and reflected back
 * as `report.region`. This container does not second-guess it. It used to: it
 * waited for the first response, ranked the regions by spend with an extra
 * across-regions request, then patched the URL — which recomputed every query
 * object and re-issued all seven fetches, so the whole first round was discarded
 * and the user watched one region's figures flip to another's.
 *
 * MoM: the endpoint returns it (`kpis.momDeltaPct`, engine/kpis.ts), day-paced
 * under the same clamp as the total. The client-side prior-month fetch that used
 * to stand in for it is gone.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ScopeRegionalView from './ScopeRegionalView.vue'
import { useReportState } from '../../composables/useReportState'
import { rollingTrendWindow } from './trend-window'
import { useDrillGrants, useDrillWindow } from '../../composables/useDrillContract'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { buildConcentration } from './regional/build-concentration'
import {
  behaviourOnScreen,
  cutOnScreen,
  driversForAxis,
  teammateCutOnScreen,
  tableSharesTeammateCut,
  trendOnScreen,
} from './regional/teammate-cut'
import type { RegionalReport, RegionalDriversResp, RegionalTrendResp } from './regional/regional-view-types'
import type { ActiveTrend } from '#shared/reports/types'
import type { BehaviourReport } from '#shared/reports/behaviour'

const rs = useReportState()

/*
 * THE DRILL CONTRACT's two container-level reads (D29/D30). They live HERE, with
 * every other fetch and URL read on this scope, and travel down as props — the
 * presentational view stays mountable without a Nuxt context, which is the same
 * split every other prop on it already follows.
 */
const drillGrants = useDrillGrants()
const drillWindow = useDrillWindow()
// "Fix org homing →" opens /admin, which bounces non-admins: show it to admins only.
const { isAdmin: canFixHoming } = useAdminAccess()

// The drivers-table axis is table-local (not URL state). Reset on entering/leaving
// a drill so a stale "practice" axis can't survive it.
//
// PROJECT, not teammate: the unit of account is the budgeted project (decisions
// D1) — a region owner's first question is which projects are behaving, and
// person-level detail is a spot-check, never the default view.
const axis = ref('project')
watch(
  () => rs.ou.value,
  () => {
    axis.value = 'project'
  },
)

// Active window: a custom range wins when BOTH bounds are set; else the month
// param (absent ⇒ the endpoints default to the current UTC month) + region/ou.
const scopeQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {}
  if (rs.from.value && rs.to.value) {
    q.from = rs.from.value
    q.to = rs.to.value
  } else if (rs.month.value) {
    q.month = rs.month.value
  }
  if (rs.region.value) q.region = rs.region.value
  if (rs.ou.value) q.ou = rs.ou.value
  return q
})
// Drivers / top-models / concentration window on the SAME active period + scope as the
// KPI index (scopeQuery): a custom `[from, to]` range when set, else `month`, plus
// region/ou. No longer month-anchored — they reflect the FULL selected range (the
// drivers endpoint windows it usage-lane-cleanly; the CSV export windows the same range).
/*
 * `lane` rides EVERY drivers request, so the page's toggle reaches the rows and
 * not just the headline above them. It is part of the query key by construction
 * (the computed feeds `useFetch`'s `query`), so flipping the lane refetches
 * rather than re-rendering the other lane's numbers under a new label.
 */
const driversQuery = computed(() => ({
  ...scopeQuery.value,
  axis: axis.value,
  lane: rs.lane.value,
}))
const modelQuery = computed(() => ({ ...scopeQuery.value, axis: 'model', lane: rs.lane.value }))
const teammateQuery = computed(() => ({
  ...scopeQuery.value,
  axis: 'teammate',
  lane: rs.lane.value,
}))

// ── Trend window (decoupled) — rolling ~60 days in month mode, else the range,
// region/ou-scoped. Mirrors the Across flagship so the trend / active-users /
// behaviour cards show a rich trailing window instead of the current month's sliver.
const ROLLING_DAYS = 60
/*
 * The rolling band ends at the SERVER's settled edge, never at a browser
 * `new Date()` (F1/D3 + D6). `rollingTrendWindow` is shared with
 * ScopeAcrossRegions — the two used to hold byte-identical copies of this
 * arithmetic, which is how the two trends a reader compares side by side end up
 * on different x-extents.
 */
const { clock } = useServerClock()
const trendScopeQuery = computed<Record<string, string>>(() => {
  const band = rs.from.value && rs.to.value
    ? { from: rs.from.value, to: rs.to.value }
    : clock.value
      ? rollingTrendWindow(clock.value, ROLLING_DAYS)
      : null
  /*
   * NO CLOCK YET ⇒ NO from/to, and the endpoint serves its own default (the
   * current UTC month). NEVER a browser-guessed band: a guessed edge is the
   * defect, and it would be in force exactly while the page is first painted.
   * The clock is SSR-resolved and hydrated with the page, so in practice this
   * branch is not taken; when it is, the query changes once and refetches.
   */
  const q: Record<string, string> = band ? { from: band.from, to: band.to } : {}
  if (rs.region.value) q.region = rs.region.value
  if (rs.ou.value) q.ou = rs.ou.value
  return q
})
const trendWindowLabel = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value} → ${rs.to.value}` : `Last ${ROLLING_DAYS} days`,
)

const {
  data: report,
  pending,
  error,
} = useFetch<RegionalReport>('/api/v1/reports/region', {
  query: scopeQuery,
  key: 'reports-regional',
  lazy: true,
  server: false,
  // No auto-retry on 5xx (plan D9) — every report fetch on this page opts out.
  retry: false,
})
/*
 * The switchable table's own cut. Driven by hand (immediate/watch off) rather
 * than by useFetch's own watcher so it can be SKIPPED on the teammate axis,
 * where it would request the exact URL `teammateDrivers` already has in flight
 * under a different key — and Nuxt shares promises per key, not per URL.
 *
 * `driversQuery` carries the axis, so every axis change genuinely needs a new
 * response and this watcher fires for all of them but that one.
 */
const {
  data: axisDrivers,
  error: driversError,
  pending: driversPending,
  execute: fetchAxisDrivers,
} = useFetch<RegionalDriversResp>('/api/v1/reports/region/drivers', {
  query: driversQuery,
  key: 'reports-regional-drivers',
  lazy: true,
  server: false,
  retry: false,
  immediate: false,
  watch: false,
})
onMounted(() => {
  // Registered from `onMounted`, which does not run during SSR — the same
  // client-only contract `server: false` gives the other six requests, and unlike
  // an `import.meta.client` guard it is a real runtime path a test can drive.
  watch(
    driversQuery,
    () => {
      if (!tableSharesTeammateCut(axis.value)) void fetchAxisDrivers()
    },
    { immediate: true },
  )
})
const { data: modelDrivers, error: modelError, pending: modelPending } = useFetch<RegionalDriversResp>('/api/v1/reports/region/drivers', {
  query: modelQuery,
  key: 'reports-regional-drivers-model',
  lazy: true,
  server: false,
  retry: false,
})
const { data: teammateDrivers, error: teammateError, pending: teammatePending } = useFetch<RegionalDriversResp>('/api/v1/reports/region/drivers', {
  query: teammateQuery,
  key: 'reports-regional-drivers-teammate',
  lazy: true,
  server: false,
  retry: false,
})
const { data: trend, error: trendError, pending: trendPending } = useFetch<RegionalTrendResp>('/api/v1/reports/region/trend', {
  query: trendScopeQuery,
  key: 'reports-regional-trend',
  lazy: true,
  server: false,
  retry: false,
})
const { data: activeTrend, error: activeError, pending: activePending } = useFetch<ActiveTrend>('/api/v1/reports/region/active-trend', {
  query: trendScopeQuery,
  key: 'reports-regional-active-trend',
  lazy: true,
  server: false,
  retry: false,
})
/*
 * NO SEASONALITY FETCH. "When spend happens" is deleted at both widths
 * (prototype `note('back', …)`: day-of-week seasonality is interesting once, not
 * every week), along with its §B twin, so nothing here consumes
 * `/reports/region/seasonality`. Its pending/error refs left the aggregations
 * below with it — a request nobody renders must not be able to blank this page.
 * The endpoint itself is untouched.
 */
/*
 * The two BEHAVIOUR cards ride the TREND window, not the KPI one: they are the
 * rolling band's cards, and a share metric or a 30-vs-30 delta needs a window
 * long enough to hold two halves — which the current month's opening days are not.
 *
 * ALL THREE REFS ARE READ, like every other request on this page. Destructuring
 * `data` alone left this request outside `anyPending` and `anyError`: a screen
 * whose behaviour cards were still in flight reported itself SETTLED, and a
 * behaviour request that failed left the previous answer on screen with no
 * banner — the exact "stale figures presented as settled" state the refetch
 * marking exists to stop, reached through the one request nobody wired up.
 */
const {
  data: behaviour,
  error: behaviourError,
  pending: behaviourPending,
} = useFetch<BehaviourReport>('/api/v1/reports/region/behaviour', {
  query: trendScopeQuery,
  key: 'reports-regional-behaviour',
  lazy: true,
  server: false,
  retry: false,
})

/*
 * The switchable table's request is the one that may not have run (teammate
 * axis), so ALL THREE of its refs — data, pending, error — are inert history
 * there. Each of the three reads whichever request is actually serving the table;
 * `drivers` additionally requires the payload's own `axis` AND its own `region` to
 * be the ones on screen, so a lagging response — from the previous axis or the
 * previous region — cannot render under the wrong heading (teammate-cut.ts).
 *
 * The heading is `report.region.displayName`, so `report.region.id` is what the
 * payload is measured against: the region actually being named beside it.
 */
const headingRegionId = computed(() => report.value?.region?.id ?? null)
const drivers = computed(() =>
  driversForAxis(axis.value, headingRegionId.value, axisDrivers.value, teammateDrivers.value),
)
// Top models — its own axis-fixed request, through the same on-screen test. It is a
// third independently-resolved response beside the two above; without this it could
// rank the previous region's models under the new region's heading.
const modelCut = computed(() => cutOnScreen(modelDrivers.value, 'model', headingRegionId.value))
/*
 * The trend response, through the REGION half of the same test (it has no axis).
 * One request, four cards — the usage composition hero, its pinned donut, the §A
 * spend trend and the §B chargeback trend (plus the lane legends built from them) —
 * all of which would otherwise draw the previous region's series under the new
 * region's heading, beside drivers cards that had correctly gone empty.
 *
 * This guard covers the drivers and trend payloads and NOTHING ELSE on the page.
 * Anything not routed through teammate-cut.ts can still lag a region behind —
 * see that module's header for why the boundary is stated as what IS covered
 * rather than as a list of what is not.
 */
const trendCut = computed(() => trendOnScreen(trend.value, headingRegionId.value))
/*
 * The behaviour response, through the same test — WIDTH and region, since this
 * container is only ever the single-region width and a whole-company payload
 * carries `region: null` legitimately. Without it the two behaviour cards were
 * the last unguarded pair on the page: after a region switch they drew the
 * previous region's tier exposure and per-developer curve under the new region's
 * heading, beside drivers and trend cards that had correctly gone empty.
 */
const behaviourCut = computed(() => behaviourOnScreen(behaviour.value, headingRegionId.value))
const tablePending = computed(() =>
  tableSharesTeammateCut(axis.value) ? teammatePending.value : driversPending.value,
)
const tableError = computed(() =>
  tableSharesTeammateCut(axis.value) ? teammateError.value : driversError.value,
)

/*
 * REFETCHING — true while any of the in-flight requests is still running AND a
 * previous response is still on screen.
 *
 * They land at different times (measured: 3.2s, 2.1s, 3.3s, 4.8s, 5.1s, 8.3s,
 * 10.2s), and each one flips its own card as it arrives. `pending` alone
 * cannot express that: the skeleton is gated on `pending && !report`, which is
 * false on every refetch because the OLD response is still present. So changing
 * region showed the previous region's figures, unmarked, for several seconds
 * while cards flipped one at a time — a mixture of two scopes presented as a
 * settled answer. Marking the body provisional is the honest rendering of a
 * state that genuinely IS provisional.
 */
const anyPending = computed(
  () =>
    pending.value ||
    tablePending.value ||
    modelPending.value ||
    teammatePending.value ||
    trendPending.value ||
    activePending.value ||
    behaviourPending.value,
)
/*
 * FIRST LOAD is not a refetch. The primary report usually resolves before the
 * other six, so `report` becomes truthy while they are still in flight — and
 * "Updating figures…" over a screen that has never shown a complete answer is
 * simply wrong. A generation is only a REFETCH once one has fully settled.
 */
const hasSettledOnce = ref(false)
watch(anyPending, (busy) => {
  if (!busy && report.value) hasSettledOnce.value = true
})

/*
 * Any of them failing, not just the primary. A failed drivers request left the
 * previous scope's table on screen with `refetching` back to false — i.e.
 * stale figures presented as settled, which is the very state this slice
 * exists to stop. The banner is the honest rendering; a partial screen is not.
 */
const anyError = computed(
  () =>
    error.value ??
    tableError.value ??
    modelError.value ??
    teammateError.value ??
    trendError.value ??
    activeError.value ??
    behaviourError.value ??
    undefined,
)

const refetching = computed(
  () => anyPending.value && Boolean(report.value) && hasSettledOnce.value && !anyError.value,
)

// Concentration — computed client-side from the axis-stable teammate cut, held to
// the SAME on-screen test the drivers table applies. The card has no axis switch, so
// it used to read the ref directly; that left it showing the previous region's people
// under the new region's heading, beside a table that had correctly gone empty.
const concentration = computed(() => {
  const cut = teammateCutOnScreen(teammateDrivers.value, headingRegionId.value)
  return cut ? buildConcentration(cut.rows) : null
})

/*
 * NO CLIENT-SIDE MoM. This used to hold a `momDeltaPct` ref fed by a SECOND
 * `/api/v1/reports/region` fetch of the paced previous month, re-deriving the
 * as-of day-of-month clip that server/reporting/params.ts `momPaceWindow` already
 * implements — a second implementation of one figure, on the width that was
 * already the drifted one. The delta now rides `kpis.momDeltaPct`, computed by the
 * shared KPI engine under the SAME clamp as the total it is a delta of.
 */

// ── Export (byte-identical to the drivers table) ─────────────────────────────
// Windows the SAME active period + scope as the on-screen drivers (scopeQuery), so
// screen == CSV in every mode — month AND custom range.
//
// `lane` is part of "byte-identical" now, not decoration: without it, exporting
// from the chargeback view downloaded ATTRIBUTED rows for the BILLED table on
// screen, under a filename that named neither.
const exportParams = computed(() => ({
  scope: 'region',
  report: 'drivers',
  axis: axis.value,
  lane: rs.lane.value,
  ...scopeQuery.value,
}))
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(
  () => `tokenscope-regional-drivers-${axis.value}-${windowSlug.value}.csv`,
)

function onRegion(regionId: string) {
  // Switching region clears any drill (its `ou` belongs to the old region).
  rs.patch({ region: regionId || null, ou: null })
}
</script>

<template>
  <ScopeRegionalView
    :report="report ?? null"
    :drivers="drivers"
    :model-drivers="modelCut"
    :concentration="concentration"
    :trend="trendCut"
    :active-trend="activeTrend ?? null"
    :behaviour="behaviourCut"
    :lane="rs.lane.value"
    :trend-window-label="trendWindowLabel"
    :pending="pending"
    :refetching="refetching"
    :error="anyError"
    :drivers-axis="axis"
    :export-params="exportParams"
    :export-filename="exportFilename"
    :drill-grants="drillGrants"
    :drill-window="drillWindow"
    :can-fix-homing="canFixHoming"
    @update:region="onRegion"
    @update:drivers-axis="axis = $event"
    @drill="rs.patch({ ou: $event })"
    @clear-drill="rs.patch({ ou: null })"
  />
</template>
