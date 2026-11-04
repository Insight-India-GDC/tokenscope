<script setup lang="ts">
/*
 * ChargebackTrendCard — the §B chargeback trend that REPLACES the §A spend-trend
 * (usage) card in chargeback mode. Anthropic per-teammate daily bill lane
 * (`v_finance_bill_chargeback`); Copilot is ABSENT (its chargeback is pooled per
 * cost-centre, MONTH-grained) and the caveat explains why.
 *
 * GRAIN (lane-visuals iter-2 I2/I4): defaults to WEEKLY — the weekly Σ absorbs
 * single-day outliers arithmetically at TRUE scale (nothing clipped or clamped)
 * — with a '$' ⇄ 'share %' switch (two renderings of ONE folded weekly series;
 * switch state not persisted). The partial current week renders lighter +
 * dashed and is excluded from fold ranking and the delta. A composition delta
 * line (UNFOLDED basis, last complete 4 weeks vs prior 4) sits under the title.
 * DAILY grain remains available at true linear scale with a "peak day" chip
 * computed FROM THE CHART'S OWN rendered day series (r2-3), so the chip and the
 * chart cannot disagree.
 *
 * Both grains obey the SHARED page-level `laneMode` signal (r3-6 — the same
 * signal gates the sibling split card, so the two cards never split modes on
 * one page). The card renders NO legend: the page-level LaneLegend carries lane
 * identity (V1 item 5). The legacy single-series path remains for pre-V2 pages.
 */
import { computed, ref } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartTrend from './charts/ChartTrend.client.vue'
import ChartWeeklyLanes from './charts/ChartWeeklyLanes.client.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import { computePeakDay } from './charts/weekly-lanes'
import { shortDay } from './charts/chart-utils'
import type { ChargeDailyPoint } from '#shared/reports/types'
import type { BuiltChargebackTrend } from './build-chargeback-trend'
import type { BuiltWeeklyLanes } from './charts/weekly-lanes'

const props = defineProps<{
  /** The zero-filled §B TOTAL series (single-series mode; also the empty-state probe). */
  series: ChargeDailyPoint[]
  /** Pre-built folded per-lane DAILY stack (lane-visuals V2) — built by the scope
   *  view from the SAME data that feeds the page legend, so the two never drift. */
  built?: BuiltChargebackTrend | null
  /** Pre-built folded per-lane WEEKLY stack (iter-2 I2) — the default grain. */
  builtWeekly?: BuiltWeeklyLanes | null
  /**
   * The ONE page-level lane-mode signal (r3-6) — computed by the scope view from
   * the SAME legend union both chargeback cards feed, so the trend and the split
   * card can never disagree about which mode the page is in. Omitted (the pre-V2
   * scopes) ⇒ fall back to this card's own lane data.
   */
  laneMode?: boolean
  /** Inclusive window label, e.g. "Last 60 days" / "2026-07-01 → 2026-07-31". */
  windowLabel?: string
}>()

const laneMode = computed(() => props.laneMode ?? (props.built?.series.length ?? 0) > 0)
const laneSeries = computed(() => props.built?.series ?? [])

// Weekly is the DEFAULT grain (I4 — outlier readability without clipping);
// daily remains available at true linear scale. Local, not persisted.
const grain = ref<'weekly' | 'daily'>('weekly')
// The '$' ⇄ 'share %' switch — two renderings of one folded weekly series (I2).
const unit = ref<'usd' | 'share'>('usd')

const weekly = computed(() => props.builtWeekly ?? null)
const hasWeekly = computed(() =>
  Boolean(weekly.value && weekly.value.series.some((s) => s.data.some((p) => p.y !== 0))),
)
const showWeekly = computed(() => laneMode.value && grain.value === 'weekly' && hasWeekly.value)
const showDaily = computed(
  () => laneMode.value && (grain.value === 'daily' || !hasWeekly.value) && laneSeries.value.length > 0,
)

// Peak-day chip (I4, daily grain): computed FROM THE CHART'S OWN rendered day
// series — the same points ChartTrend stacks, projected tail excluded (r2-3).
const peakDay = computed(() =>
  computePeakDay(laneSeries.value, { excludeFrom: props.built?.forecastFrom }),
)

// Composition delta (I2): UNFOLDED weekly basis, last complete 4 wks vs prior 4.
const deltaText = computed(() => {
  const d = weekly.value?.delta
  if (!d) return null
  const dir = (v: number) => (v >= 0 ? 'up' : 'down')
  const mom =
    d.nonCodeMomPct == null
      ? ''
      : `, ${dir(d.nonCodeMomPct)} ${fmtPct(Math.abs(d.nonCodeMomPct))} MoM`
  const pts =
    d.nonCodeShareDeltaPts == null
      ? ''
      : `, ${dir(d.nonCodeShareDeltaPts)} ${(Math.abs(d.nonCodeShareDeltaPts) * 100).toFixed(1)} pts`
  return (
    `Non-Code surfaces ${fmtUsd(d.nonCodeAvgWeekUsd)}/wk${mom}` +
    ` · share ${fmtPct(d.nonCodeSharePct)}${pts}`
  )
})

// Legacy single-series path: one Anthropic series; `key: 'claude-code'` resolves
// to the Anthropic lane hue through the registry.
const totalSeries = computed(() => [
  {
    name: 'Anthropic',
    key: 'claude-code',
    data: props.series.map((d) => ({ x: d.day, y: d.chargeUsd })),
  },
])

/** Compact $ for axis/tooltip — bill sums run to thousands. */
function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="chargeback-trend-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">Chargeback trend</div>
        <div class="text-[11px] text-carbon-3 truncate">
          <template v-if="showWeekly">Weekly Anthropic chargeback by surface · billed</template>
          <template v-else-if="laneMode">Daily Anthropic chargeback by surface · billed</template>
          <template v-else>Daily Anthropic chargeback</template>
          <template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
        <p
          v-if="laneMode && deltaText"
          class="mt-1 text-[12px] text-carbon-2"
          data-testid="chargeback-trend-delta"
        >
          {{ deltaText }} <span class="text-carbon-3">(last complete 4 weeks vs prior 4)</span>
        </p>
      </div>

      <div v-if="laneMode && hasWeekly" class="flex items-center gap-2 shrink-0">
        <!-- Grain: weekly (default — absorbs single-day outliers at true scale) ⇄ daily. -->
        <div class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5" role="group" aria-label="Trend grain">
          <button
            type="button"
            class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
            :class="grain === 'weekly' ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
            :aria-pressed="grain === 'weekly'"
            data-testid="chargeback-trend-grain-weekly"
            @click="grain = 'weekly'"
          >Weekly</button>
          <button
            type="button"
            class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
            :class="grain === 'daily' ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
            :aria-pressed="grain === 'daily'"
            data-testid="chargeback-trend-grain-daily"
            @click="grain = 'daily'"
          >Daily</button>
        </div>
        <!-- '$' ⇄ 'share %' — two renderings of ONE folded weekly series (I2). -->
        <div
          v-if="grain === 'weekly'"
          class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5"
          role="group"
          aria-label="Weekly value mode"
        >
          <button
            type="button"
            class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
            :class="unit === 'usd' ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
            :aria-pressed="unit === 'usd'"
            data-testid="chargeback-trend-unit-usd"
            @click="unit = 'usd'"
          >$</button>
          <button
            type="button"
            class="px-3 py-1 text-[11px] font-semibold rounded-md transition-colors"
            :class="unit === 'share' ? 'bg-white text-brand-harmony shadow-sm' : 'text-carbon-2 hover:text-brand-harmony'"
            :aria-pressed="unit === 'share'"
            data-testid="chargeback-trend-unit-share"
            @click="unit = 'share'"
          >share %</button>
        </div>
      </div>
    </div>

    <!-- Peak-day chip (I4, daily grain only): bound to the chart's OWN day series. -->
    <p
      v-if="showDaily && peakDay"
      class="mb-2 text-[11px] text-carbon-2"
      data-testid="chargeback-trend-peak-day"
    >
      Peak day: <b>{{ shortDay(peakDay.day) }}</b> · {{ fmtUsd(peakDay.totalUsd) }}
    </p>

    <ChartWeeklyLanes
      v-if="showWeekly"
      :weeks="weekly!.weeks"
      :series="weekly!.series"
      :share-series="weekly!.shareSeries"
      :mode="unit"
      :in-progress-week="weekly!.inProgressWeek"
      :remainder-items="weekly!.remainderByWeek"
      :value-format="compactUsd"
      data-testid="chargeback-trend-weekly"
    />
    <ChartTrend
      v-else-if="showDaily"
      :series="laneSeries"
      :forecast-from="built?.forecastFrom"
      :total-tail="built?.totalTail"
      stacked
      :legend="false"
      :value-format="compactUsd"
      :height="300"
      data-testid="chargeback-trend-lanes"
    />
    <p
      v-else-if="laneMode"
      class="text-xs text-carbon-3 italic py-8 text-center"
      data-testid="chargeback-trend-lane-empty"
    >
      No Anthropic per-teammate chargeback this period — the period's chargeback is Copilot's
      pooled lane.
    </p>
    <ChartTrend v-else :series="totalSeries" :value-format="compactUsd" :height="300" />

    <!-- NO "rendered lighter and excluded…" NOTE: it described its own encoding
         rather than naming a series. See SurfaceHeroCard for the full argument. -->
    <p
      v-if="showDaily && built?.forecastFrom"
      class="mt-2 text-[11px] text-carbon-3 italic"
      data-testid="chargeback-trend-projected-note"
    >
      dashed = run-rate projection to month-end
    </p>
    <p class="mt-2 text-[11px] text-carbon-3 leading-snug" data-testid="chargeback-trend-caveat">
      Anthropic per-teammate chargeback · Copilot is pooled per Business Unit.
    </p>
  </UiCard>
</template>
