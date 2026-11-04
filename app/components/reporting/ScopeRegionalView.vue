<script setup lang="ts">
/*
 * ScopeRegionalView — the PRESENTATIONAL Regional dashboard, rebuilt to the locked
 * design language + AEUF parity (build-design §3). Region-scoped mirror of the
 * Across-Regions flagship: "how does ONE region use the tools, and who/what drives
 * it?"
 *
 * PURE + prop-driven (the fetches + URL state live in the ScopeRegional
 * container), so every render state is unit-testable. Never hand SVG — the branded
 * chart kit throughout (this also fixes the old bug where Claude rendered harmony
 * PURPLE; the kit paints Claude = brand-hunger MAGENTA, Copilot = brand-vision
 * blue):
 *
 *   header (region picker + DateRangeControl + ONE settling chip)
 *     → BAND 1 · the selected period
 *         hero (forecast headline + KPI tiles + budget coverage, neutral MoM)
 *         → [top-level] spend by practice (magnitude ranked bars, click-to-drill)
 *         → top models + drivers (axis switch) + concentration → Signals
 *     → BAND 2 · the rolling window
 *         provider split (hero + active-developers trend)
 *         → spend trend (day-grain, two vendors, 7-day mean, dashed run-rate tail)
 *         → spend per active developer → behavioural exposure
 *
 * TWO BANDS, BECAUSE THERE ARE TWO WINDOWS — the same fix, and the same reason,
 * as the whole-company width (ScopeAcrossRegionsView): the KPI figures answer over
 * the selected PERIOD and the trend/behaviour cards over a DECOUPLED rolling
 * window, and interleaving them left each card to explain its own number against
 * a headline computed over something else. Both widths read their band strings
 * from band-labels.ts, so the two cannot name one window two ways.
 *
 * Body renders exactly ONE of skeleton / error / empty / data; the header (with
 * the date control) persists across states so the range stays adjustable while a
 * fetch is in flight. Every figure is PROVISIONAL — the settling chip says so.
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import UiRegionSelector from '../ui/RegionSelector.vue'
import { regionSelectorOptions, regionSelectorVisible } from './region-options'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import ReportBand from './ReportBand.vue'
import DateRangeControl from './DateRangeControl.vue'
import LaneToggle from './LaneToggle.vue'
import UsageOnlyCard from './UsageOnlyCard.vue'
import ChargebackSplitCard from './ChargebackSplitCard.vue'
import ChargebackTrendCard from './ChargebackTrendCard.vue'
import ReportHeaderNotes from './ReportHeaderNotes.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import DriversTable, { type AxisOption } from './DriversTable.vue'
import {
  projectDrillTarget,
  dimFact, teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
  type DrillTarget,
} from './drill-contract'
import ConcentrationCohortCard from './across/ConcentrationCohortCard.vue'
import type { ConcentrationStats } from './regional/build-concentration'
import UiCard from '../ui/Card.vue'
import LaneLegend from './LaneLegend.vue'
import ScopeHero from './ScopeHero.vue'
import SurfaceHeroCard from './SurfaceHeroCard.vue'
import ActiveUsersTrendCard from './across/ActiveUsersTrendCard.vue'
import TierExposureCard from './TierExposureCard.vue'
import SpendPerDeveloperCard from './SpendPerDeveloperCard.vue'
import RegionalSpendTrend from './regional/RegionalSpendTrend.vue'
import RegionalPracticeRank from './regional/RegionalPracticeRank.vue'
import RegionalChargebackRank from './regional/RegionalChargebackRank.vue'
import RegionalTopModels from './regional/RegionalTopModels.vue'
import RegionalSignals from './regional/RegionalSignals.vue'
import { buildRegionalTrend } from './regional/build-regional-trend'
import { buildSurfaceHero } from './build-surface-hero'
import { monthLabel } from './window-labels'
import { periodBandWindow, rollingBandNote } from './band-labels'
import { BUDGET_LABEL } from '#shared/reports/vocabulary'
import {
  buildChargebackLaneTrend,
  buildChargebackLaneTrendWeekly,
  buildChargebackDonut,
  chargebackLegendLanes,
} from './build-chargeback-trend'
import type { ReportLane } from '../../composables/useReportState'
import type { RegionalReport, RegionalDriversResp, RegionalTrendResp } from './regional/regional-view-types'
import { chargebackScopeClause } from '#shared/reports/types'
import type { ActiveTrend, ProviderState, DriverRow } from '#shared/reports/types'
import type { BehaviourReport } from '#shared/reports/behaviour'

const props = withDefaults(
  defineProps<{
    report: RegionalReport | null
    drivers: RegionalDriversResp | null
    modelDrivers: RegionalDriversResp | null
    concentration: ConcentrationStats | null
    trend: RegionalTrendResp | null
    activeTrend: ActiveTrend | null
    /**
     * The two behaviour cards, over the SAME rolling window as `trend` /
     * `activeTrend`. `null` while in flight; each card renders its own loading
     * state rather than the page holding a skeleton for the slowest fetch.
     */
    behaviour: BehaviourReport | null
    /** The active lens (§A usage ⇄ §B chargeback) — drives the full re-lens. */
    lane?: ReportLane
    /** Label for the (rolling) trend window, e.g. "Last 60 days". */
    trendWindowLabel?: string
    pending: boolean
    /**
     * A refetch is in flight while a PREVIOUS response is still rendered. Not
     * the same as `pending`: the skeleton is gated on `pending && !report`,
     * which is false on every refetch, so without this the screen presented one
     * scope's figures under another scope's name as though settled.
     */
    refetching?: boolean
    error?: unknown
    driversAxis: string
    /** The export endpoint params echo the current scope so the CSV matches the screen. */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
    /*
     * THE DRILL CONTRACT (D29/D30, fix 7) — supplied by the container, which is
     * where the Nuxt-context reads live. Fail-closed defaults keep this view
     * mountable (and every name plain text) without either.
     */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
    /** Admin-only "Fix org homing →" — from the container's session; fail-closed. */
    canFixHoming?: boolean
  }>(),
  {
    error: undefined,
    lane: 'usage',
    trendWindowLabel: undefined,
    refetching: false,
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
    canFixHoming: false,
  },
)

// The active lens: chargeback re-lenses the hero + swaps the practice rank for the
// §B chargeback-by-cost-centre ranking, and replaces the inherently-§A analytics
// (provider split / trend / drivers / signals) with a "usage-only"
// placeholder — never a broken empty card.
const isChargeback = computed(() => props.lane === 'chargeback')

const emit = defineEmits<{
  /** The region SELECTOR moved — a region id or the `all` sentinel (§6). */
  'update:region': [regionId: string]
  'update:driversAxis': [axis: string]
  drill: [ouId: string]
  clearDrill: []
}>()

/*
 * The region selector, at the single-region width — the SAME control and the SAME
 * option list the whole-company width renders (region-options.ts), so "All regions"
 * is the first option here too when the caller holds it. That is what makes the two
 * widths one scope rather than two views that each have a region dropdown.
 *
 * Hidden when the options do not amount to a choice: a caller granted only their own
 * region sees no control (§6, "nothing rendered"), which is what the previous
 * `regionOptions.length > 0` test happened to produce and this now states directly.
 */
const regionOptions = computed(() => (props.report ? regionSelectorOptions(props.report) : []))
const showRegionSelector = computed(
  () => Boolean(props.report) && regionSelectorVisible(props.report!),
)

// Exactly one of skeleton / error / empty / data.
/*
 * EXHAUSTIVE, not merely mutually exclusive — see ScopeAcrossRegionsView for the
 * full account. `pending && !report` left `(report:null, pending:false, no error)`
 * matching nothing, which is the SSR-pass state for a `server: false` fetch, so
 * every cold load rendered an empty body. Absence of data IS the loading state.
 */
const showError = computed(() => Boolean(props.error))
const showSkeleton = computed(() => !showError.value && !props.report)
const isEmpty = computed(
  () =>
    Boolean(props.report) &&
    props.report!.kpis.genuineUsd === 0 &&
    props.report!.kpis.chargeableUsd === 0 &&
    props.report!.kpis.activeUsers === 0,
)
const showData = computed(() => Boolean(props.report) && !showError.value && !isEmpty.value)

/*
 * The refetch state is only meaningful over a body that is showing FIGURES.
 * The header renders in every state, so gating the chip on `refetching` alone
 * put "Updating figures…" above an error banner — implying the error was about
 * to be replaced — and above the empty state, which has no figures to update.
 */
const showRefetchState = computed(() => props.refetching && showData.value)

const drill = computed(() => props.report?.drill ?? null)

// ── Header meta ──────────────────────────────────────────────────────────────
// Settlement markers for ALL THREE vendor clocks (requirement 5 — "all places
// with adjacent §A/§B numbers show their respective marker"): ScopeHero
// always shows the §A attributed-usage figure ADJACENT to the §B chargeable
// figure, so the header shows usage's clock alongside anthropic's/github's.
const providerStates = computed<ProviderState[]>(() => props.report?.meta.providerStates ?? [])
const coverage = computed(() => props.report?.meta.coverage ?? null)

// ── Trend (+ run-rate projected tail) + Genuine sparkline ────────────────────
const built = computed(() =>
  buildRegionalTrend(
    props.trend?.series ?? [],
    props.report?.forecast ?? null,
    props.report?.meta.month ?? null,
  ),
)

// ── Usage-view composition hero + pinned donut (requirement 1, regional mirror) ─
// Canonical §A USAGE basis (region-clamped server-side), built from the trend
// response's weekly lane cells over its window — the ONE shared window object
// the hero and the donut both bind on (r2-2). `today` identifies the partial
// current week (rendered but excluded from ranking/deltas — r1-F4). It derives
// from SERVER data — the shared window's inclusive `to` (the rolling trend
// window ends on the server's today) — NEVER `new Date()` at setup scope: SSR
// and client hydration could evaluate that across a UTC midnight and disagree
// on the in-progress-week flag (hydration mismatch — iter2 review r1).
const todayUtc = computed(() => props.trend?.window?.to ?? null)
const surfaceHero = computed(() =>
  props.trend?.window
    ? buildSurfaceHero(props.trend.usageWeeklyLanes ?? [], {
        from: props.trend.window.from,
        to: props.trend.window.to,
        today: props.trend.window.to,
      })
    : null,
)
/*
 * NO PAGE-LEVEL LANE LEGEND IN THE USAGE LENS (mirrors the whole-company width).
 * SurfaceHeroCard renders its own totals bar — the same lanes, under the bars
 * they name, with each lane's dollars rather than only its colour. The
 * CHARGEBACK lens still needs one, because its two cards render none of their
 * own; it is rendered beside the first of them, inside band 1.
 */

// ── §B chargeback-lane cards + the page-level lane legend (lane-visuals V2-Regional) ─
// The scope view owns every chargeback card's series (the container fetched
// them), so the folded card inputs AND the page legend derive from the SAME
// computed data — atomic with the page's data, no provide/inject, no
// registration timing (V1 item 5, r2-3). The run-rate tail is month-anchored
// exactly like the §A trend: only the in-progress month (forecast non-null)
// projects; the tail's MTD operand itself is §B (the chargeback total series).
const chargebackTailMonth = computed(() =>
  props.report?.forecast && !props.report.meta.range ? props.report.meta.month : null,
)
const chargebackBuilt = computed(() =>
  buildChargebackLaneTrend(
    props.trend?.chargeLanes ?? [],
    props.trend?.chargeSeries ?? [],
    chargebackTailMonth.value,
  ),
)
// The WEEKLY regrouping of the same folded lane series (iter-2 I2/I4) — the
// chargeback trend card's default grain; Σ(weekly) == Σ(daily) by construction.
const chargebackWeekly = computed(() =>
  // Guarded like surfaceHero: a null trend (pre-load / error) must yield null,
  // never feed mondayOf('') — an unguarded computed here threw RangeError
  // (review r2 HIGH).
  props.trend?.window
    ? buildChargebackLaneTrendWeekly(props.trend.chargeLanes ?? [], props.trend.chargeSeries ?? [], todayUtc.value ?? props.trend.window.to)
    : null,
)
const chargebackDonut = computed(() => buildChargebackDonut(props.report?.chargebackLanes ?? []))
// The UNION of lanes the page's chargeback cards actually render this period
// (folded remainder as its single entry) — the ONE page-level legend's input.
const chargebackLegend = computed(() =>
  chargebackLegendLanes([chargebackBuilt.value.laneIds, chargebackDonut.value.laneIds]),
)
// The ONE page-level lane-mode signal (r3-6): both chargeback cards derive
// their mode from THIS (the legend union renders from ≥ 2 lanes — LaneLegend's
// own threshold), never from each card's private, differently-scoped data — so
// a $0-Anthropic / pooled-Copilot month can't leave the trend card on its
// legacy path while the split card renders the lane donut.
const chargebackLaneMode = computed(() => chargebackLegend.value.length >= 2)


const windowLabel = computed(() => {
  const meta = props.report?.meta
  if (!meta) return ''
  return meta.range ? `${meta.range.from} → ${meta.range.to}` : monthLabel(meta.month)
})

/*
 * ── Band headers (band-labels.ts, shared with the whole-company width) ──
 *
 * ONLY THE ROLLING BAND RENDERS ONE, exactly as at the whole-company width.
 * `periodWindow` is still computed because the rolling band's own note is decided
 * by comparing the two windows — it is an OPERAND here, not a rendered string.
 */
const periodWindow = computed(() => (props.report ? periodBandWindow(props.report.meta) : ''))
/*
 * The rolling band falls back to the period's own label when no trend window was
 * supplied, so the two headers can genuinely be the same string. Everything this
 * band says about its relationship to the one above keys off THAT comparison
 * rather than off the props behind it.
 */
const rollingWindow = computed(() => props.trendWindowLabel ?? windowLabel.value)
const sameWindow = computed(() => rollingWindow.value === periodWindow.value)
const rollingNote = computed(() =>
  props.report ? (rollingBandNote(props.report.meta, sameWindow.value) ?? undefined) : undefined,
)
// Nothing about a caller-chosen range is "rolling", so the word is dropped there
// rather than left describing a window it does not describe.
const rollingBasis = computed(() => (sameWindow.value ? 'daily' : 'rolling · daily'))

// ── Drivers table axes ───────────────────────────────────────────────────────
// Project leads — the budgeted unit of account (decisions D1). The KEY stays
// `'project'` (the wire, the export column and every saved `?axis=` URL); only
// the WORD is the product's own — see shared/reports/vocabulary.ts.
//
// MODEL IS NOT ONE OF THEM (07-model-axis-subtraction-build.md D6, owner
// 2026-08-04): the RegionalTopModels card beside this table is the single
// model surface on this width and shows strictly more (provenance, coverage
// footer). The endpoint keeps accepting `axis=model` for that card's own
// fetch; axis state is component-local and never persisted.
const AXIS_OPTIONS: AxisOption[] = [
  { value: 'project', label: BUDGET_LABEL },
  { value: 'practice', label: 'Practice' },
  { value: 'teammate', label: 'Teammate' },
  { value: 'surface', label: 'Surface' },
]
// The drill's DriversTable is the "users" table — no practice-within-a-practice.
const DRILL_AXIS_OPTIONS: AxisOption[] = AXIS_OPTIONS.filter((o) => o.value !== 'practice')

/*
 * "share of X" under the table names the DENOMINATOR, so it has to name the
 * lane the denominator came from — and from the RESPONSE, not from the toggle.
 * The budget axis stays attributed in chargeback mode, so deriving this from
 * `props.lane` would put "billed" under an attributed total on exactly the axis
 * where the distinction matters most.
 */
/*
 * …and it names WHOSE charge it is. Copilot bills one pooled invoice per cost
 * centre, so on any axis that invoice cannot reach (teammate and model today)
 * this figure is Anthropic's alone — "region billed spend" over it is a claim
 * about the region that only one provider's money supports. The clause comes
 * from the response's `chargebackCoverage`, the same source as the gap sentences
 * the table renders, so neither this label nor this comment decides the set.
 */
const driversDenominator = computed(() => {
  const scope = drill.value ? 'practice' : 'region'
  if (props.drivers?.measureLanes?.rows !== 'billed') return `${scope} usage`
  const clause = chargebackScopeClause(props.drivers?.chargebackCoverage)
  return `${scope} billed spend${clause ? ` — ${clause}` : ''}`
})

// Only a PRACTICE-axis row carries a real drill target (its key is a cost-owning
// unit id); teammate / model / project have no regional scope to drill into.
function onTableDrill(row: DriverRow) {
  if (
    props.driversAxis === 'practice' &&
    row.key !== 'unattributed' &&
    !row.key.startsWith('__null')
  ) {
    emit('drill', row.key)
  }
}

/*
 * ── THE DRILL CONTRACT (developer pages D29/D30, fix 7) ─────────────────────
 *
 * This view's own scope token: the region it was computed FOR, or the
 * whole-company width. Read off the DRIVERS payload's `width`/`region` and not
 * off the URL, because that payload is what the rows were computed over — on a
 * region → "All regions" transition the URL moves before the response does, and
 * a token taken from the URL would frame a drill on a width the rows are not in.
 */
const drillGrants = computed(() => props.drillGrants)
const drillFrame = computed<DrillFrame>(() => {
  const d = props.drivers
  const src = !d ? null : d.width === 'all-regions' ? 'across' : d.region ? `region:${d.region.id}` : null
  return { ...props.drillWindow, src }
})

/**
 * Link · action · plain text, per row and per axis, all of it delegated to the
 * exported policy rules. The PRACTICE axis keeps its in-page `action` (the `?ou=`
 * pivot); teammate and project rows become real links by grant; model and
 * surface rows name no drillable subject and are plain text by construction.
 */
function driversDrillable(row: DriverRow): DrillTarget | null {
  if (props.driversAxis === 'practice') {
    return row.key !== 'unattributed' && !row.key.startsWith('__null') ? { kind: 'action' } : null
  }
  if (props.driversAxis === 'teammate') {
    if (row.key.startsWith('__null')) return null
    return teammateDrillTarget(
      drillGrants.value,
      {
        id: row.key,
        isActive: dimFact(row.dims, 'teammate_active'),
        // Server-carried (r4-H2): an unconfirmed shadow identity 403s at the
        // destination, so its row is a NAME, never a door.
        isProvisional: dimFact(row.dims, 'teammate_provisional'),
      },
      drillFrame.value,
    )
  }
  if (props.driversAxis === 'project') {
    return projectDrillTarget(drillGrants.value, row.dims?.project_code ?? null, drillFrame.value)
  }
  return null
}
</script>

<template>
  <div data-testid="scope-regional">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Region
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">
          {{ report?.region?.displayName ?? 'Region' }}
        </h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap" data-testid="regional-settling">
          <UiRegionSelector
            v-if="showRegionSelector && !drill"
            :model-value="report?.region?.id ?? ''"
            :options="regionOptions"
            data-testid="region-scope-selector"
            @update:model-value="emit('update:region', $event)"
          />
          <!-- CONTROLS above the fold; COMMENTARY in the one disclosure beside
               them (see ReportHeaderNotes). -->
          <ReportHeaderNotes
            :provider-states="providerStates"
            :coverage="coverage"
            placement-note
            :lane="lane"
          />
          <!--
            The refetch is NAMED, not merely implied by a spinner: the figures
            below are the previous scope's until every request lands, and a
            user comparing two regions must not read a half-swapped screen as
            the answer.
          -->
          <span
            v-if="showRefetchState"
            class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-carbon-3"
            data-testid="regional-refetching"
            role="status"
          >
            <span
              class="inline-block h-1.5 w-1.5 rounded-full bg-brand-harmony animate-pulse"
              aria-hidden="true"
            />
            Updating figures…
          </span>
        </div>
      </div>

      <div class="flex items-start gap-4 flex-wrap shrink-0">
        <!-- The lens explainer rides the notes disclosure, not the control. -->
        <LaneToggle :show-caption="false" />
        <DateRangeControl />
      </div>
    </header>

    <!-- ── Body: exactly one of skeleton / error / empty / data ────────────── -->
    <ReportSkeleton v-if="showSkeleton" :kpis="6" />

    <UiFetchErrorBanner v-else-if="showError" :error="error" />

    <ReportEmpty
      v-else-if="isEmpty"
      headline="Nothing to report for this region and period yet."
      sub="As sessions and bills land for the selected range, this regional view fills in."
    />

    <div
      v-else-if="showData && report"
      data-testid="regional-data"
      class="space-y-8 transition-opacity duration-200"
      :class="showRefetchState ? 'opacity-50' : ''"
      :aria-busy="showRefetchState ? 'true' : 'false'"
    >
      <!-- Drill breadcrumb (practice) -->
      <nav
        v-if="drill"
        class="text-[12px] text-carbon-3"
        aria-label="Breadcrumb"
        data-testid="regional-drill-crumb"
      >
        <button type="button" class="hover:text-brand-harmony hover:underline" @click="emit('clearDrill')">
          {{ report.region?.displayName ?? 'Region' }}
        </button>
        <span class="mx-1.5">›</span>
        <span class="text-carbon-1 font-semibold">{{ drill.displayName }}</span>
      </nav>

      <!-- ══ BAND 1 · the selected period ══════════════════════════════════ -->
      <!-- NO BAND HEADER HERE, exactly as at the whole-company width.

           It used to render one, for a stated reason: RegionalHero carried
           neither the month name nor the C11 subtree scope label, so the header
           was the only place this width said which month and whose money. That
           reason expired the moment both widths started rendering ScopeHero,
           whose first line already reads "August 2026 · $1,863.63 · attributed
           usage · APAC · month to date · day 3 of 31" — the header would now be
           the same window said twice, one line apart, without the figure.

           The band element stays (its testid is how tests assert membership);
           only the duplicate sentence goes. The ROLLING band below keeps its
           header, because it says something no card inside it says. -->
      <ReportBand data-testid="regional-band-period">
        <ScopeHero :report="report" :lane="lane" />

        <!-- The §B lane legend sits with the cards that need it: the two
             chargeback cards render none of their own. The usage lens has none
             because SurfaceHeroCard carries its own totals legend. -->
        <template v-if="isChargeback">
          <LaneLegend :lanes="chargebackLegend" />
          <ChargebackSplitCard
            :split="report.chargebackProviderSplit"
            :donut="chargebackDonut"
            :lane-mode="chargebackLaneMode"
          />
        </template>

        <!-- Rank card (top-level only; the drill is already inside a practice): the §A
             practice ranking in usage mode ⇄ the §B chargeback-by-cost-centre ranking. -->
        <template v-if="!drill">
          <RegionalPracticeRank
            v-if="!isChargeback && report.practices.length"
            :practices="report.practices"
            @select="emit('drill', $event)"
          />
          <RegionalChargebackRank
            v-else-if="isChargeback"
            :rows="report.chargebackByCostCentre"
            :can-fix-homing="props.canFixHoming"
          />
        </template>

        <!-- Top models + drivers ANSWER THE SELECTED LANE. They used to be replaced
             wholesale by a usage-only placeholder in chargeback mode, which is the
             other half of the same defect the lane toggle had: the headline moved to
             the billed lane and the breakdown under it simply disappeared, so the
             one question a chargeback reader has ("what is driving it?") had no
             answer on the page at all.

             CONCENTRATION does NOT follow, and that is not an omission: it is a
             distribution over PEOPLE's consumption and `provider_usage_fact` carries
             no equivalent cohort. It keeps its §A placeholder rather than being
             re-labelled over billed data. -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 space-y-4">
            <RegionalTopModels
              :rows="modelDrivers ? modelDrivers.rows : null"
              :lane="modelDrivers?.measureLanes?.rows ?? 'attributed'"
              :chargeback-coverage="modelDrivers?.chargebackCoverage"
              :headline-usd="modelDrivers?.headlineUsd ?? null"
              :billed-lane="modelDrivers?.billedLane"
            />

            <UiCard>
              <div class="text-sm font-semibold text-carbon-1 mb-3">{{ drill ? 'Users' : 'Drivers' }}</div>
              <DriversTable
                v-if="drivers"
                :rows="drivers.rows"
                :headline-usd="drivers.headlineUsd"
                :axis="driversAxis"
                :axis-options="drill ? DRILL_AXIS_OPTIONS : AXIS_OPTIONS"
                :denominator-label="driversDenominator"
                :billed-lane="drivers.billedLane"
                :chargeback-coverage="drivers.chargebackCoverage"
                :drillable="driversDrillable"
                @update:axis="emit('update:driversAxis', $event)"
                @drill="onTableDrill"
              />
              <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading drivers…</p>
            </UiCard>
          </div>

          <!-- THE SAME CARD AS THE WHOLE-COMPANY WIDTH, on the same terms.
               This width used to render the older ConcentrationCard, whose
               cohorts were labelled Power / Heavy / Typical / Light USERS — the
               people-nouns the prototype names as the defect — and whose shares
               were cut with a different rounding rule (see build-concentration).
               One card, one cut, both widths.

               The gate is the card's own MIN_COHORT (30), which IS the
               prototype's `if(people>=30)`; the two widths do not differ.

               Its percentiles must agree with the Median-per-person tile above,
               which publishes the same three — and now does so at BOTH widths,
               since both render ScopeHero. Both are cut by the one shared
               implementation (shared/reports/concentration.ts), server-side for
               the tile and client-side for this card, so they cannot disagree. -->
          <ConcentrationCohortCard v-if="!isChargeback" :stats="concentration" />
          <UsageOnlyCard v-else-if="isChargeback" title="Spend concentration" :min-height="160" />
        </div>

        <RegionalSignals
          v-if="!isChargeback && report.exceptions.length"
          :exceptions="report.exceptions"
          :velocity-threshold="report.velocityThreshold"
          :drill-grants="drillGrants"
          :drill-frame="drillFrame"
        />
      </ReportBand>

      <!-- ══ BAND 2 · the rolling window ═══════════════════════════════════ -->
      <ReportBand
        :window-label="rollingWindow"
        :basis="rollingBasis"
        :note="rollingNote"
        data-testid="regional-band-rolling"
      >
        <!-- Provider split / trend: the §A usage cards in usage mode, RE-LENSED
             to their §B bill-lane analogue in chargeback mode (per-teammate Anthropic bill;
             Copilot is pooled per cost-centre). -->
        <!-- SAME ORDER AS THE WHOLE-COMPANY WIDTH, and the prototype's: the
             population, then the money, then the money per head, then its
             composition. This width had the same defect — it led with "Where the
             AI spend goes", a breakdown offered before the reader knows whether
             the total moved. -->
        <template v-if="!isChargeback">
          <ActiveUsersTrendCard :active="activeTrend" :window-label="trendWindowLabel ?? windowLabel" />

          <RegionalSpendTrend
            :series="built.series"
            :forecast-from="built.forecastFrom"
            :window-label="trendWindowLabel ?? windowLabel"
          />

          <!-- Directly under the two cards it divides. The trend above cannot
               separate "more people" from "more spend per person", which are
               different conversations; this one can, and it says which. -->
          <SpendPerDeveloperCard
            :series="behaviour?.perDeveloper ?? null"
            :window-label="trendWindowLabel ?? windowLabel"
          />

          <!-- Composition hero (requirement 1): canonical §A usage, weekly, one
               $ panel + its own totals legend — same lane as the KPI strip. -->
          <SurfaceHeroCard :built="surfaceHero" :window-label="trendWindowLabel ?? windowLabel" />
          <!-- No surface DONUT — see ScopeAcrossRegionsView: it restated the hero's
               own legend as unlabelled arcs and could not be read on its own. -->
        </template>
        <template v-else>
          <ChargebackTrendCard
            :series="trend?.chargeSeries ?? []"
            :built="chargebackBuilt"
            :built-weekly="chargebackWeekly"
            :lane-mode="chargebackLaneMode"
            :window-label="trendWindowLabel ?? windowLabel"
          />
          <!-- NO DoW CARD — it was "When spend happens" re-lensed onto the bill
               lane, so it went with the card it mirrors (see the note below). -->
        </template>

        <!-- §B, and it renders in BOTH lenses on purpose: it is billed money
             banded by choice, so it is not a §A cut the chargeback lens replaces.
             Never summed with the §A figures above it (contract C2). It is in the
             rolling band because that is the window it was fetched over. -->
        <TierExposureCard
          :exposure="behaviour?.exposure ?? null"
          :window-label="trendWindowLabel ?? windowLabel"
        />

        <!--
          "WHEN SPEND HAPPENS" IS DELETED at this width too, both lenses. The
          prototype drops it by name ("day-of-week seasonality is interesting
          once, not every week"), and a card deleted at one width and kept at the
          other is the divergence this consolidation exists to remove.
        -->
      </ReportBand>

      <!-- Export -->
      <div class="flex justify-end pt-2">
        <ExportCsvButton
          endpoint="/api/v1/reports/export"
          :params="exportParams"
          :filename="exportFilename"
        />
      </div>
    </div>
  </div>
</template>
