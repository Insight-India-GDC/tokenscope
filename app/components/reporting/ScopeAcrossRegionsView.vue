<script setup lang="ts">
/*
 * ScopeAcrossRegionsView — the whole-of-company FinOps dashboard (build-design §3).
 *
 * PURE + prop-driven (the fetches + URL state live in the ScopeAcrossRegions
 * container), so every render state is unit-testable without a Nuxt runtime.
 * Answers "what is the company on track to spend this period, and who/what is
 * driving it" with the branded chart kit — never hand SVG:
 *
 *   header (title + region selector + lane toggle + DateRangeControl, and ONE
 *   notes disclosure carrying every caveat — ReportHeaderNotes)
 *     → BAND 1 · the selected period (month-to-date or the custom range)
 *         hero (the period's ACTUAL figure + four KPI tiles, each with its own
 *         delta) + budget coverage (a four-part bar, not prose)
 *         → Regions (table: people · usage · share, click-to-drill) — the ONLY
 *           place this page answers "which region" (`note('fix 4a', …)`)
 *         → top drivers (pivot chips, region NOT among them) + top models
 *         → concentration (how few people the spend sits with)
 *     → BAND 2 · the rolling window
 *         active developers → spend trend (7-day mean, dashed run-rate tail)
 *         → spend per active developer → where the AI spend goes
 *         → behavioural exposure
 *
 * THE PERIOD BAND HAS NO HEADER. Its hero already opens with the whole sentence
 * ("August 2026 · $5,741.89 · attributed usage · the whole company · month to
 * date · day 3 of 31"), so a band header above it stated the same window a
 * second time, one line earlier, without the figure. The ROLLING band keeps its
 * header — "does not sum into August" is a fact no card inside it carries.
 *
 * CONCENTRATION IS IN BAND 1, not band 2 where the prototype draws it, because
 * `drivers.concentration` is fetched on the PERIOD window. The prototype's bands
 * are visual; ours are a contract (see below), and its percentiles have to agree
 * with the period-windowed Median-per-person tile.
 *
 * TWO BANDS, BECAUSE THERE ARE TWO WINDOWS. The KPI figures answer over the
 * selected PERIOD; the trend/behaviour cards answer over a DECOUPLED
 * rolling window (the container's `trendWindowQuery`). The page used to interleave
 * them with nothing but per-card captions to tell them apart, so a $409 60-day
 * donut sat under a $12,855 month-to-date headline and read as an error. Each
 * window is now stated once, on a band header, and every card is inside the band
 * whose window it was fetched over — which is also what lets the cards' own
 * captions go back to naming one thing.
 *
 * The ORDER changed for that: the period cards are contiguous above the rolling
 * ones rather than split around them. A band whose members are not adjacent is
 * not a band.
 *
 * Body renders exactly ONE of skeleton / error / empty / data; the header (with
 * the date control) persists across states so the range stays adjustable while a
 * fetch is in flight. Every figure is PROVISIONAL — the settling clock says so.
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import UiRegionSelector from '../ui/RegionSelector.vue'
import { regionSelectorOptions, regionSelectorVisible, ALL_REGIONS_LABEL } from './region-options'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import ReportBand from './ReportBand.vue'
import DateRangeControl from './DateRangeControl.vue'
import LaneToggle from './LaneToggle.vue'
import ChargebackSplitCard from './ChargebackSplitCard.vue'
import ChargebackTrendCard from './ChargebackTrendCard.vue'
import ReportHeaderNotes from './ReportHeaderNotes.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import LaneLegend from './LaneLegend.vue'
import ScopeHero from './ScopeHero.vue'
import ConcentrationCohortCard from './across/ConcentrationCohortCard.vue'
import SurfaceHeroCard from './SurfaceHeroCard.vue'
import ActiveUsersTrendCard from './across/ActiveUsersTrendCard.vue'
import TierExposureCard from './TierExposureCard.vue'
import SpendPerDeveloperCard from './SpendPerDeveloperCard.vue'
import SpendTrendCard from './across/SpendTrendCard.vue'
import RegionRankCard from './across/RegionRankCard.vue'
import TopDriversCard from './across/TopDriversCard.vue'
import {
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from './drill-contract'
import TopModelsCard from './across/TopModelsCard.vue'
import { buildAcrossTrend } from './across/build-trend'
import { periodBandWindow, rollingBandNote } from './band-labels'
import { buildSurfaceHero } from './build-surface-hero'
import {
  buildChargebackLaneTrend,
  buildChargebackLaneTrendWeekly,
  buildChargebackDonut,
  chargebackLegendLanes,
} from './build-chargeback-trend'
import type { ReportLane } from '../../composables/useReportState'
import type { AcrossReport, AcrossDriversResp } from './across/across-view-types'
import {
  ALL_REGIONS,
  type AcrossTrend,
  type ActiveTrend,
  type ProviderState,
} from '#shared/reports/types'
import type { BehaviourReport } from '#shared/reports/behaviour'

const props = withDefaults(
  defineProps<{
    report: AcrossReport | null
    trend: AcrossTrend | null
    activeTrend: ActiveTrend | null
    /**
     * The two behaviour cards, over the SAME rolling window as `trend` /
     * `activeTrend`. `null` while in flight; each card renders its own loading
     * state rather than the page holding a skeleton for the slowest fetch.
     */
    behaviour: BehaviourReport | null
    drivers: AcrossDriversResp | null
    /** The dedicated axis=model drivers response (Top-models card). */
    modelDrivers: AcrossDriversResp | null
    pending: boolean
    error?: unknown
    driversAxis: string
    /** The active lens (§A usage ⇄ §B chargeback) — drives the full re-lens. */
    lane?: ReportLane
    /** Label for the (decoupled) trend window — rolling or custom range. */
    trendWindowLabel?: string
    /**
     * The word over the drivers' VALUE column — the period those rows cover.
     * Passed down rather than derived here: the container owns the window, and a
     * period named anywhere else is a claim about data it did not request.
     */
    driversPeriodLabel?: string
    /** Export endpoint params echo the current scope so the CSV matches the screen. */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
    /** THE DRILL CONTRACT (D29/D30) — from the container; fail-closed defaults. */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
  }>(),
  {
    error: undefined,
    lane: 'usage',
    trendWindowLabel: undefined,
    driversPeriodLabel: 'Spend',
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
  },
)

// The active lens: chargeback re-lenses the hero HEADLINE and swaps the §A usage
// cards for their §B bill-lane analogues. The KPI tile row does NOT re-lens —
// both money figures render in both lenses and the two cohort tiles are §A in
// both — so no tile is greyed or relabelled to something it did not measure.
const isChargeback = computed(() => props.lane === 'chargeback')

const emit = defineEmits<{
  'update:driversAxis': [axis: string]
  /** The region SELECTOR moved — the payload is a region id or the `all` sentinel. */
  'update:region': [regionId: string]
  /** A region was chosen (ranked bar / driver drill) — narrow the scope to it. */
  'select-region': [regionId: string | null]
}>()

/*
 * The region selector, at the whole-company width. Built from the response's own
 * grant fields, so it offers exactly what this caller may pick — and it is how the
 * reader gets OUT of "All regions" into one region without leaving the scope.
 * Hidden when there is no genuine choice (regionSelectorVisible).
 */
const regionOptions = computed(() =>
  props.report ? regionSelectorOptions(props.report) : [],
)
const showRegionSelector = computed(() =>
  Boolean(props.report) && regionSelectorVisible(props.report!),
)

// Exactly one of skeleton / error / empty / data (build-design §3).
/*
 * The four body states must be EXHAUSTIVE, not merely mutually exclusive.
 *
 * `pending && !report` left a hole: with `report === null`, `pending === false`
 * and no error, all four predicates were false and the body rendered NOTHING.
 * That is exactly the state Nuxt reports on the SERVER pass for the container's
 * `useFetch(..., { lazy: true, server: false })` — the fetch is deliberately
 * skipped during SSR, so nothing is in flight and no data has arrived. Every
 * cold load shipped an empty body; a scope whose query is fast enough recovers
 * within ~100ms and only LOOKS intermittent.
 *
 * Absence of data IS the loading state, whichever pass we are on. `pending`
 * stays the honest in-flight marker (it keeps loaded data on screen across a
 * refetch) but can no longer be the difference between a body and a blank page.
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

// ── Band headers (band-labels.ts) ────────────────────────────────────────────
/*
 * ONLY THE ROLLING BAND RENDERS A HEADER. `periodWindow` is still computed
 * because the rolling band's own note is decided by comparing the two windows —
 * it is an OPERAND here, not a rendered string. `periodBandBasis` is no longer
 * called at all: the hero states the lane, the scope and the pace itself, and
 * that is the one place it is said.
 */
const periodWindow = computed(() =>
  props.report ? periodBandWindow(props.report.meta) : '',
)
/*
 * The rolling band falls back to the period's own label when no trend window was
 * supplied, so the two headers can genuinely be the same string. Everything the
 * rolling band says about its relationship to the period band keys off THAT
 * comparison rather than off the props behind it.
 */
const rollingWindow = computed(() => props.trendWindowLabel ?? periodWindow.value)
const sameWindow = computed(() => rollingWindow.value === periodWindow.value)
const rollingNote = computed(() =>
  props.report ? (rollingBandNote(props.report.meta, sameWindow.value) ?? undefined) : undefined,
)
// Nothing about a caller-chosen range is "rolling", so the word is dropped there
// rather than left describing a window it does not describe.
const rollingBasis = computed(() => (sameWindow.value ? 'daily' : 'rolling · daily'))

// ── Header meta ──────────────────────────────────────────────────────────────
// Settlement markers for ALL THREE vendor clocks (requirement 5 — "all places
// with adjacent §A/§B numbers show their respective marker"): ScopeHero always
// shows the §A attributed-usage figure ADJACENT to the §B chargeable figure
// (both lenses render both numbers — "the both matter equally rule"), so the
// header must show usage's clock alongside anthropic's/github's, not usage
// alone (the old single "ONE consolidated" chip silently implied the §B
// figures beside it settled on the SAME clock, which they do not).
const providerStates = computed<ProviderState[]>(() => props.report?.meta.providerStates ?? [])
const coverage = computed(() => props.report?.meta.coverage ?? null)

// ── Trend (+ run-rate projected tail) + Genuine sparkline ────────────────────
// The trend/active-users use the decoupled ROLLING window (container),
// but the projected tail is still anchored on the in-progress month's forecast so
// the dashed run-rate continuation lands correctly at month-end.
const built = computed(() =>
  buildAcrossTrend(
    props.trend?.series ?? [],
    props.report?.forecast ?? null,
    props.report?.meta.month ?? null,
  ),
)

// ── Usage-view composition hero + pinned donut (requirement 1) ───────────────
// Canonical §A USAGE basis, built from the trend response's weekly lane cells
// over its window — the ONE shared window object the hero and the donut both
// bind on (r2-2). `today` identifies the partial current week (rendered but
// excluded from fold ranking and the delta — r1-F4). It derives from SERVER
// data — the shared window's inclusive `to` (the rolling trend window ends on
// the server's today) — NEVER `new Date()` at setup scope: SSR and client
// hydration could evaluate that across a UTC midnight and disagree on the
// in-progress-week flag (hydration mismatch — iter2 review r1).
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
 * NO PAGE-LEVEL LANE LEGEND IN THE USAGE LENS. SurfaceHeroCard now renders its
 * own totals bar — the same lanes, under the bars they name, and carrying each
 * lane's dollars rather than only its colour. A second key at the top of the
 * page would be the weaker of two, above two bands it did not describe.
 *
 * The CHARGEBACK lens still needs one: ChargebackSplitCard and
 * ChargebackTrendCard deliberately render no legend of their own, so
 * `chargebackLegend` below is rendered beside the first of them, inside band 1.
 */

// ── §B chargeback-lane cards + the page-level lane legend (lane-visuals V2) ──
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

/*
 * CONCENTRATION — WHAT MOVED TO THE TILE, AND WHAT DID NOT.
 *
 * `note('fix 6', …)` folds Concentration "into Median per person", and the three
 * PERCENTILES did move there: they sit under the median tile, which is the other
 * half of the same question (what does a typical person spend, and how lopsided
 * is it). That part stands.
 *
 * The CARD was over-deleted with them. A percentile is not a population: "63% of
 * spend" never says how many humans that is, and the prototype still draws the
 * card — the sentence, the four-cohort bar and the per-cohort counts — because
 * "is this a conversation with three people or three hundred?" is the one
 * question the tile cannot answer. It is back, as ConcentrationCohortCard, off
 * `drivers.concentration` (which never stopped riding the drivers response).
 *
 * It shares the tile's arithmetic rather than restating it: the cohorts are cut
 * server-side at the same indices as top1/top10, so the two can only ever
 * publish one distribution. An earlier draft that re-derived them disagreed with
 * the tile by seven points.
 *
 * The `?report=concentration` CSV export is unaffected: it runs its own
 * `fetchConcentration`, not this field.
 *
 * STILL MISSING, and deliberately not faked: the prototype's model-tier
 * cross-tab per cohort ("what the heavy decile does differently"). It needs a
 * server measure joining cohorts to `model_catalog.tier`, which does not exist.
 * It is NOT approximated from TierExposureCard — that card's denominator is
 * billed spend over the rolling window, a different lane and a different period.
 */
</script>

<template>
  <div data-testid="scope-across-regions">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Region
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">
          {{ ALL_REGIONS_LABEL }}
        </h2>
        <!-- CONTROLS stay above the fold; COMMENTARY goes in the one disclosure
             beside them. The settling chips, the coverage marker, the
             placement note and the lane explainer used to stack here as six
             lines of caveat before the first figure. -->
        <div class="mt-2 flex items-center gap-3 flex-wrap" data-testid="across-settling">
          <UiRegionSelector
            v-if="showRegionSelector"
            :model-value="ALL_REGIONS"
            :options="regionOptions"
            data-testid="region-scope-selector"
            @update:model-value="emit('update:region', $event)"
          />
          <ReportHeaderNotes
            :provider-states="providerStates"
            :coverage="coverage"
            placement-note
            :lane="lane"
          />
        </div>
      </div>

      <div class="flex items-start gap-4 flex-wrap shrink-0">
        <!-- The lens explainer rides the disclosure, not the control. -->
        <LaneToggle :show-caption="false" />
        <DateRangeControl />
      </div>
    </header>

    <!-- ── Body: exactly one of skeleton / error / empty / data ────────────── -->
    <ReportSkeleton v-if="showSkeleton" :kpis="4" />

    <UiFetchErrorBanner v-else-if="showError" :error="error" />

    <ReportEmpty
      v-else-if="isEmpty"
      headline="Nothing to report across the company for this period yet."
      sub="As sessions and bills land for the selected range, this whole-company view fills in."
    />

    <div v-else-if="showData && report" data-testid="across-data" class="space-y-8">
      <!-- ══ BAND 1 · the selected period ══════════════════════════════════ -->
      <!-- NO BAND HEADER HERE. The hero's own first line already reads "August
           2026 · $5,741.89 · attributed usage · the whole company · month to
           date · day 3 of 31" — a header above it repeated the month, the lane
           and the scope one line earlier and carried no figure. The band stays
           (its testid is how tests assert membership); only the duplicate
           sentence goes. The ROLLING band below keeps its header, because it
           says something no card inside it says. -->
      <ReportBand data-testid="across-band-period">
        <ScopeHero :report="report" :lane="lane" />

        <!-- The §B lane legend sits with the cards that need it, not at the top
             of the page: the two chargeback cards render no legend of their own.
             The usage lens has none here because SurfaceHeroCard now carries its
             own totals legend under the bars it names. -->
        <template v-if="isChargeback">
          <LaneLegend :lanes="chargebackLegend" />
          <ChargebackSplitCard
            :split="report.chargebackProviderSplit"
            :donut="chargebackDonut"
            :lane-mode="chargebackLaneMode"
          />
        </template>

        <RegionRankCard
          :cards="report.regionCards"
          :chargeback-rows="report.chargebackByRegion"
          :lane="lane"
          @select="emit('select-region', $event)"
        />

        <!-- Top drivers + top models ANSWER THE SELECTED LANE. They were replaced
             wholesale by a usage-only placeholder in chargeback mode, which left a
             chargeback reader with a headline and no breakdown at all — the other
             half of the defect the lane toggle had.

             Each card states the lane it measured, from the response. -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="across-drivers-section">
          <TopDriversCard
            class="lg:col-span-2"
            :drivers="drivers"
            :axis="driversAxis"
            :lane="lane"
            :period-label="driversPeriodLabel"
            :drill-grants="props.drillGrants"
            :drill-window="props.drillWindow"
            @update:axis="emit('update:driversAxis', $event)"
          />
          <div class="space-y-4">
            <TopModelsCard :models="modelDrivers" />
          </div>
        </div>

        <!-- CONCENTRATION IS IN THE PERIOD BAND, not beside the rolling cards,
             because that is the window it was measured over: `concentration`
             rides the DRIVERS response, which the container fetches on
             `windowQuery` — the same window as the hero and the KPI tiles.

             The prototype renders it further down the page, below the rolling
             cards, but the prototype has no fetch behind it and its bands are
             visual only. Ours are a contract: every card sits inside the band
             whose window produced it. Putting a month-to-date cohort under a
             "Last 60 days · does not sum into August" header would re-introduce
             exactly the defect the bands exist to remove.

             It also has to agree with the Median-per-person tile above it, which
             publishes the same percentiles — and that tile is period-windowed.
             A rolling Concentration card would contradict it by construction.

             §A in both lenses: `provider_usage_fact` carries no cohort of people,
             so there is nothing to re-lens onto billed money (contract C2). -->
        <ConcentrationCohortCard :stats="drivers?.concentration ?? null" />
      </ReportBand>

      <!-- ══ BAND 2 · the rolling window ═══════════════════════════════════ -->
      <ReportBand
        :window-label="rollingWindow"
        :basis="rollingBasis"
        :note="rollingNote"
        data-testid="across-band-rolling"
      >
        <!-- Provider split / trend: the §A usage cards in usage mode, RE-LENSED to
             their §B bill-lane analogue in chargeback mode (the per-teammate bill
             lane HAS the daily / token grain — Anthropic; Copilot is pooled per
             cost-centre). -->
        <!-- THE ORDER IS THE PROTOTYPE'S: the population first, then the money,
             then the money PER head, and only then its composition. Dev used to
             lead with "Where the AI spend goes", which answers a breakdown
             question before the reader has been told whether the total moved or
             whether more people arrived. -->
        <template v-if="!isChargeback">
          <ActiveUsersTrendCard :active="activeTrend" :window-label="trendWindowLabel" />

          <SpendTrendCard
            :series="built.series"
            :forecast-from="built.forecastFrom"
            :window-label="trendWindowLabel"
          />

          <!-- Directly under the two cards it divides. The trend above cannot
               separate "more people" from "more spend per person", which are
               different conversations; this one can, and it says which. -->
          <SpendPerDeveloperCard
            :series="behaviour?.perDeveloper ?? null"
            :window-label="trendWindowLabel"
          />

          <!-- Composition hero (requirement 1): canonical §A usage, weekly, one
               $ panel + its own totals legend — same lane as the KPI strip, over
               THIS band's window. -->
          <SurfaceHeroCard :built="surfaceHero" :window-label="trendWindowLabel" />
          <!-- No surface DONUT. It restated the hero's own weekly legend in a
               second shape, and rendered as three unlabelled arcs around a total:
               the reader could not tell which arc was which surface without the
               card above it. A visual that needs another visual to be read is not
               carrying its own space (prototype: the donut is deleted there too). -->
        </template>
        <template v-else>
          <ChargebackTrendCard
            :series="trend?.chargeSeries ?? []"
            :built="chargebackBuilt"
            :built-weekly="chargebackWeekly"
            :lane-mode="chargebackLaneMode"
            :window-label="trendWindowLabel"
          />
          <!-- NO DoW CARD. It was "When spend happens" re-lensed onto the bill
               lane (its own header said it "REPLACES the §A seasonality heatmap
               in chargeback mode"), so it went with the card it mirrors — see
               the note below. Deleting the §A one and keeping its §B twin would
               have left the same standing card behind a lane toggle. -->
        </template>

        <!-- §B, and it renders in BOTH lenses on purpose: it is billed money
             banded by choice, so it is not a §A cut the chargeback lens replaces.
             Never summed with the §A figures above it (contract C2). It is in the
             rolling band because that is the window it was fetched over. -->
        <TierExposureCard :exposure="behaviour?.exposure ?? null" :window-label="trendWindowLabel" />

        <!--
          "WHEN SPEND HAPPENS" IS DELETED, both lenses. The prototype drops it by
          name: "Dropped for real: the Spend by surface donut … and When spend
          happens (day-of-week seasonality is interesting once, not every week)."

          The reason is about STANDING COST, not correctness. The heatmap was
          right; it just answered a question that does not change week to week,
          so it charged rent on every page load for an insight the reader already
          had. The surface donut went earlier for the same class of reason.

          Its §B twin (ChargebackDowCard) went with it, above.

          Behavioural exposure is therefore the last card in this band, which is
          also where the prototype ends.
        -->
      </ReportBand>

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
