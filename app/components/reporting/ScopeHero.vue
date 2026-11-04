<script setup lang="ts">
/*
 * ScopeHero — the Region scope's headline + KPI tile row, at BOTH widths.
 *
 * ONE COMPONENT, TWO WIDTHS. This was `AcrossHero`, rendered only at the
 * whole-company width, while the single-region width had its own `RegionalHero`.
 * They drifted exactly as far apart as you would expect: the prototype's fixes 2 /
 * 2a / 2b / 2c / 6 were applied here and not there, so the region width still led
 * with a run-rate projection ("On track for $19,257.50") and still carried a
 * standalone MoM tile, a Tokens tile and an avg-per-user tile, with no median at
 * all. It binds on `ScopeHeroReport` — the fields both payloads carry — so it
 * cannot tell which width it is on, and therefore cannot diverge again.
 *
 * THE HEADLINE IS WHAT WAS ACTUALLY SPENT, not what we think will be. It used to
 * be the month-end run-rate ("On track for $79,701"), with the real attributed
 * usage demoted to a subline — a projection reading as the fact, in the largest
 * type on the page. The hero is now the period, the FIGURE, and what the figure
 * is of:
 *
 *   July 2026 · $39,702.37 · attributed usage · the whole company · month to date · day 14 of 31
 *
 * The run-rate is not deleted — the Spend-trend card still projects it as its
 * dashed month-end tail, from this same `forecast` — it is simply no longer the
 * thing a reader sees first.
 *
 * LANE (§A usage ⇄ §B chargeback — provider-billing-attribution-model.md). The
 * HEADLINE re-lenses: usage shows attributed usage, chargeback shows the
 * chargeable cost-of-record. The four tiles do NOT: both money figures are
 * rendered in both lenses (the "both matter equally" rule) with the active lane's
 * tile emphasised, and the two cohort tiles are §A in both. They are never summed
 * with each other (consistency contract C2) and no tile derives money from a ratio.
 *
 * THE ROW IS FOUR TILES, and each one carries its own delta:
 *   Attributed usage (§A) · Chargeable (§B) · Active people (§A) · Median per person (§A)
 *
 * What went, and why — the prototype's numbered fixes:
 *   fix 2  — the standalone "MoM change" tile is gone. It never said of WHAT, in
 *            a row where two tiles sit on different lanes. Each figure now carries
 *            its own month-on-month, so the basis is unambiguous by construction.
 *   fix 2b — Tokens and Avg-usage/user are gone. Tokens sums units priced orders of
 *            magnitude apart; a mean over this distribution is whoever is heaviest
 *            (on the dev stack, $6,427.50 across TWO people). A median survives —
 *            suppressed below five people, where a "median" names an individual.
 *   fix 2a — Active people counts everyone who SPENT (Σ cost_usd > 0), which is the
 *            same population the median divides by, with the emitting subset as its
 *            own line: people spending vs people emitting through TokenScope is the
 *            rollout gap.
 *   fix 6  — Concentration folded in here. The three percentiles sit under the
 *            median because they are the other half of one question: what does a
 *            typical person spend, and how lopsided is it.
 *
 * Every figure is PROVISIONAL — the settling indicator lives once in the page header.
 */
import { computed } from 'vue'
import ScopeKpiTile from './ScopeKpiTile.vue'
import BudgetCoverageNote from './BudgetCoverageNote.vue'
import UiBadge from '../ui/Badge.vue'
import { monthLabel } from './window-labels'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { ReportLane } from '../../composables/useReportState'
import type { ScopeHeroReport } from './scope-hero-types'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const props = defineProps<{
  report: ScopeHeroReport
  /** The active lens — drives the headline's figure and which money tile is emphasised. */
  lane: ReportLane
}>()

const k = computed(() => props.report.kpis)
const forecast = computed(() => props.report.forecast)
const copilot = computed(() => props.report.copilot)
const range = computed(() => props.report.meta.range ?? null)
const perPerson = computed(() => props.report.perPerson ?? null)
const isChargeback = computed(() => props.lane === 'chargeback')

// ── Sparklines, over the SAME window as the figure above them (fix 1) ────────
/*
 * `dailyMetrics` and `chargeDaily` are both fetched over the KPI window — the
 * one the headline was summed over — so each line and the number it sits under
 * are the same thing at two resolutions. They are NOT the page's rolling 60-day
 * trend window: a 60-day line under a this-month figure is two periods stacked,
 * which is the window defect in miniature. There is no minimum: a short
 * month-start draws a short line and dots for the rest (F2/D7).
 *
 * The Median tile carries none: there is no per-day median series, and resampling
 * one from a daily total would be a different statistic under the same label.
 */
/*
 * The spark's FRAME is the whole month (F2/D7): elapsed days as a line, the days
 * still to come as baseline dots out to month end. `forecast` is non-null
 * exactly when the viewed month is the in-progress one and it carries the day
 * count, so it is also the only server-supplied operand that can say how much
 * month is left — there is no browser clock in this path, by construction. A
 * custom range has no month ahead, so it draws no dots.
 */
const sparkSpan = computed(() =>
  range.value ? undefined : (forecast.value?.daysInMonth ?? undefined),
)

const daily = computed(() => props.report.dailyMetrics ?? [])
const genuineSpark = computed(() => daily.value.map((d) => d.genuineUsd))
const activeSpark = computed(() => daily.value.map((d) => d.activeUsers))
const chargeDaily = computed(() => props.report.chargeDaily ?? [])
const chargeDailySpark = computed(() => chargeDaily.value.map((d) => d.chargeUsd))

/*
 * IS THE LAST POINT A FINISHED DAY? ONLY THE SERIES CAN SAY (external review r2).
 *
 * MonthSpark used to infer the "still accruing" endpoint from the frame — days
 * left in the month ⇒ the line's last day is today. That is wrong here almost
 * every morning: `fetchDailyMetrics` stops the axis at `settledThrough` and
 * admits today ONLY if today already carries rows, so a mid-month series
 * normally ENDS on a finished day inside a month with days to come. The frame
 * said "partial", the data said "settled", and the tile drew the partial mark on
 * a completed day.
 *
 * The claim is now made from the SERVER's own two operands, on the SAME payload
 * the series arrived in (never `/api/v1/clock` — a second request, a second
 * instant): the series' last `day` against `meta.settledThrough`. With no
 * `settledThrough` (a payload predating the field) the answer is `undefined` and
 * the spark draws NO endpoint marker, which claims nothing either way.
 */
const settledThrough = computed(() => props.report.meta.settledThrough ?? null)
function partialOf(series: readonly { day: string }[]): boolean | undefined {
  const settled = settledThrough.value
  const last = series[series.length - 1]?.day
  if (!settled || !last) return undefined
  return last > settled
}
const genuinePartial = computed(() => partialOf(daily.value))
const chargePartial = computed(() => partialOf(chargeDaily.value))

// ── The hero line ────────────────────────────────────────────────────────────
/** The period the figure was summed over — a month name, or the range's own bounds. */
const periodTitle = computed(() =>
  range.value ? `${range.value.from} → ${range.value.to}` : monthLabel(props.report.meta.month),
)

const heroUsd = computed(() => (isChargeback.value ? k.value.chargeableUsd : k.value.genuineUsd))
const heroMeasure = computed(() => (isChargeback.value ? 'chargeable' : 'attributed usage'))

/*
 * WHOSE money, named by the resolver that built the clamp rather than typed in
 * here — the same label the budget-coverage note carries, because it is the same
 * decision (across-regions.ts, beside `wholeCompanyUsage`). Absent ⇒ the segment
 * is omitted rather than guessed at.
 */
const scopeLabel = computed(() => props.report.budgetCoverage?.scopeLabel ?? null)

/*
 * How far through the period the figure has got. `forecast` is non-null EXACTLY
 * when the viewed month is the in-progress one (server/reports/forecast.ts returns
 * null for any other month), so it is also what tells us the month is still
 * running — and it carries the day count the pacing claim needs.
 */
const paceLabel = computed(() => {
  if (range.value) return null
  const f = forecast.value
  // `dayOfMonth`, NOT `daysElapsed`: the latter anchors on the DATA and falls
  // back to the month start, so a BU with no usage yet read "day 1 of 31" on
  // the 10th. How far through the month we are is a clock fact.
  return f ? `month to date · day ${f.dayOfMonth} of ${f.daysInMonth}` : 'full month'
})

const heroContext = computed(() =>
  [heroMeasure.value, scopeLabel.value, paceLabel.value].filter(Boolean).join(' · '),
)

// ── Per-tile deltas ──────────────────────────────────────────────────────────
function trendOf(delta: number | null | undefined): 'up' | 'down' | 'flat' {
  if (delta == null || delta === 0) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

/**
 * Why a tile has no delta. A custom range has no month to compare against at all;
 * within a month the operand can still be withheld (the §B lane waits for the
 * month to close; the §A lane needs a prior month carrying data), and "too early
 * to compare" is true of both without inventing a reason the payload cannot
 * distinguish.
 */
const deltaEmpty = computed(() =>
  range.value ? 'no month-on-month for a custom range' : 'too early to compare',
)

/** Every delta on this row is against the same thing, said once. */
const DELTA_BASIS = 'vs last month'

/** A MONEY delta keeps the percentage: a proportion is what "more expensive" means. */
function pctDelta(pct: number | null | undefined): string | undefined {
  return pct == null ? undefined : fmtPct(Math.abs(pct))
}

const usageDelta = computed(() => pctDelta(k.value.momDeltaPct))
const chargeDelta = computed(() => pctDelta(k.value.chargeMomDeltaPct))
const medianDelta = computed(() => pctDelta(perPerson.value?.medianMomDeltaPct))

/**
 * A COUNT delta is absolute. "↑24" is a fact you can act on; "↑13% of a headcount"
 * is arithmetic the reader has to undo before they can (fix 2c). A flat month says
 * so in words rather than printing "0".
 */
const peopleDelta = computed(() => {
  const d = perPerson.value?.peopleMomDelta
  if (d == null) return undefined
  return d === 0 ? 'no change' : String(Math.abs(d))
})

// ── Tile 3 · Active people ───────────────────────────────────────────────────
/*
 * The rollout gap: of the people who spent, how many are emitting through
 * TokenScope. Both operands are this window, this scope, this lane — and the
 * denominator is the SAME `activeUsers` the median divides by.
 */
const emittingNote = computed(() =>
  perPerson.value ? `${perPerson.value.emittingPeople} of ${k.value.activeUsers} emitting through TokenScope` : undefined,
)

// ── Tile 4 · Median per person ───────────────────────────────────────────────
/*
 * Suppressed below five people. Under that a "median" names an individual's
 * spend, and a "top 1%" cohort is a person — a leaderboard wearing the clothes of
 * a distribution.
 */
const MIN_COHORT = 5
const showMedian = computed(() => perPerson.value != null && k.value.activeUsers >= MIN_COHORT)
const medianSub = computed(() => `half of ${k.value.activeUsers} are below this`)
const percentileNote = computed(() => {
  const p = perPerson.value
  if (!p) return undefined
  return `${fmtPct(p.top1)} top 1% · ${fmtPct(p.top5)} top 5% · ${fmtPct(p.top10)} top 10%`
})

// ── §B caveats on the chargeable figure ──────────────────────────────────────
// Copilot chargeback is ON but the active window is NOT month-aligned, so the pooled
// (monthly) Copilot net is withheld for this partial-month range (never a partial slice,
// never a silent $0 under a "+ Copilot pooled net" label). Distinct from `pending`.
const copilotUnavailable = computed(() => copilot.value.partialMonthUnavailable === true)

/**
 * One line, and it stays honest about WHICH providers reached a cost centre —
 * dropping the caveat to make the subline shorter would leave "reaches a cost
 * centre" overstating an Anthropic-only figure.
 */
const chargeableSub = computed(() =>
  copilot.value.pending
    ? `reaches a ${BU_LABEL_LOWER} · Anthropic only, Copilot pending`
    : copilotUnavailable.value
      ? `reaches a ${BU_LABEL_LOWER} · Anthropic only for a partial-month range`
      : `reaches a ${BU_LABEL_LOWER}`,
)
</script>

<template>
  <section data-testid="scope-hero" class="space-y-5">
    <!-- The figure, not the projection. -->
    <div>
      <div class="flex items-baseline gap-3 flex-wrap" data-testid="scope-hero-line">
        <span
          class="text-[15px] font-bold text-carbon-2"
          data-testid="scope-hero-period"
        >{{ periodTitle }}</span>
        <span
          class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
          data-testid="scope-hero-total"
        >{{ fmtUsd(heroUsd) }}</span>
        <span class="text-sm text-carbon-3" data-testid="scope-hero-context">{{ heroContext }}</span>
      </div>

      <p
        v-if="isChargeback && copilot.pending"
        class="mt-1.5 text-[11px] text-carbon-3 italic"
        data-testid="scope-chargeback-pending-note"
      >
        Copilot pooled chargeback is pending validation — chargeable is Anthropic only until then.
      </p>
      <p
        v-else-if="isChargeback && copilotUnavailable"
        class="mt-1.5 text-[11px] text-carbon-3 italic"
        data-testid="scope-chargeback-partial-month-note"
      >
        Copilot pooled chargeback is monthly — not shown for a partial-month range (Anthropic is day-accurate).
      </p>
    </div>

    <!-- KPI tiles — four, each carrying its own delta. -->
    <div
      class="kpi-row"
      data-testid="scope-kpi-row"
    >
      <ScopeKpiTile
        label="Attributed usage"
        :value="fmtUsd(k.genuineUsd)"
        sub="every provider, tagged or not"
        :delta-label="usageDelta"
        :delta-basis="DELTA_BASIS"
        :delta-trend="trendOf(k.momDeltaPct)"
        :delta-empty="deltaEmpty"
        :spark="genuineSpark"
        :spark-span="sparkSpan"
        :spark-partial="genuinePartial"
        :emphasis="!isChargeback"
        data-testid="scope-kpi-genuine"
      />

      <ScopeKpiTile
        label="Chargeable"
        :value="fmtUsd(k.chargeableUsd)"
        :sub="chargeableSub"
        :delta-label="chargeDelta"
        :delta-basis="DELTA_BASIS"
        :delta-trend="trendOf(k.chargeMomDeltaPct)"
        :delta-empty="deltaEmpty"
        :spark="chargeDailySpark"
        :spark-span="sparkSpan"
        :spark-partial="chargePartial"
        :emphasis="isChargeback"
        data-testid="scope-kpi-chargeable"
      >
        <template v-if="copilot.pending" #footer>
          <UiBadge
            kind="rag-amber"
            dot="amber"
            data-testid="scope-copilot-pending"
            :title="'Copilot pooled chargeback is not yet validated against the bill, so the chargeable total is Anthropic only until then.'"
          >Copilot pending</UiBadge>
        </template>
      </ScopeKpiTile>

      <ScopeKpiTile
        label="Active people"
        :value="String(k.activeUsers)"
        sub="spent on any provider"
        :delta-label="peopleDelta"
        :delta-basis="DELTA_BASIS"
        :delta-trend="trendOf(perPerson?.peopleMomDelta)"
        :delta-empty="deltaEmpty"
        :note="emittingNote"
        :spark="activeSpark"
        :spark-span="sparkSpan"
        :spark-partial="genuinePartial"
        data-testid="scope-kpi-active"
      />

      <ScopeKpiTile
        v-if="showMedian && perPerson"
        label="Median per person"
        :value="fmtUsd(perPerson.medianUsd)"
        :sub="medianSub"
        :delta-label="medianDelta"
        :delta-basis="DELTA_BASIS"
        :delta-trend="trendOf(perPerson.medianMomDeltaPct)"
        :delta-empty="deltaEmpty"
        :note="percentileNote"
        note-separated
        data-testid="scope-kpi-median"
      />
    </div>

    <!-- The coverage denominator, immediately under the tile row it qualifies. USAGE
         lens only: its four parts partition `kpis.genuineUsd`, so under a chargeable
         headline it would be qualifying a figure it was not computed from (C2).

         The "the whole company" wording travels on `budgetCoverage.scopeLabel`, set
         beside `wholeCompanyUsage` in server/reporting/across-regions.ts — one
         decision in one place, and the hero line above reads the same label. -->
    <BudgetCoverageNote v-if="!isChargeback" :coverage="report.budgetCoverage" />

    <!--
      THE ONE SENTENCE THAT SURVIVED. This was a three-sentence paragraph that
      re-stated the Chargeable tile's own subline ("the tile above says which
      applies here"), re-stated the lane definition the header disclosure carries,
      and pointed at cards further down the page. All of that was explaining the
      page to the reader rather than telling them about their money.

      What is left is the one fact a reader IS misled without: two of the four
      tiles do NOT re-lens. Under a chargeable headline, "Active people" and
      "Median per person" are still attributed usage — there is no per-person
      Copilot charge to re-lens them onto — and nothing else on the row says so.
    -->
    <p
      v-if="isChargeback"
      class="text-[11px] leading-snug text-carbon-3"
      data-testid="scope-chargeback-caveat"
    >
      Active people and Median per person are attributed usage in both lenses.
    </p>
  </section>
</template>
