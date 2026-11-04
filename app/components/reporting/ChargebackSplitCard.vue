<script setup lang="ts">
/*
 * ChargebackSplitCard — the §B "Chargeback by provider" card that REPLACES the §A
 * provider-split (usage) card in chargeback mode. The bill-lane analogue of
 * ProviderSplitCard: Anthropic per-teammate chargeback (`v_finance_bill_chargeback`)
 * vs the Copilot per-org POOLED net (`v_finance_copilot_pool_chargeback`). NEVER the
 * §A usage spend — the two lanes are never summed.
 *
 * With the optional `donut` (lane-visuals V2, Across first) the card renders the
 * per-LANE composition: a ChartDonut capped at 5 slices + fold (r1-F3), centre =
 * the chargeable total. copilot-unclassified is NEVER a slice — it surfaces as
 * the amber "needs mapping" badge on the Copilot bucket (the shipped
 * FinanceCouTable convention) and never enters a chargeable sum. The donut
 * renders NO per-card legend: the page-level LaneLegend carries lane identity
 * (V1 item 5); slice tooltips carry label + $ + share. Without `donut` (the
 * Regional scope until its V2 commit) the card keeps the two-bucket layout.
 *
 * The Copilot bucket is `null` while its pooled chargeback is pending validation
 * or withheld for a partial-month range, so it renders those states rather than
 * a false $0. Shared by the Across + Regional chargeback lanes.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiBadge from '../ui/Badge.vue'
import ChartDonut from './charts/ChartDonut.client.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { ChargebackProviderSplit } from '#shared/reports/types'
import type { BuiltChargebackDonut } from './build-chargeback-trend'

const props = defineProps<{
  split: ChargebackProviderSplit
  /** Pre-built folded lane composition (lane-visuals V2) — built by the scope view
   *  from the SAME data that feeds the page legend, so the two never drift. */
  donut?: BuiltChargebackDonut | null
  /**
   * The ONE page-level lane-mode signal (r3-6) — computed by the scope view from
   * the SAME legend union both chargeback cards feed, so this card and the
   * sibling ChargebackTrendCard can never disagree about which mode the page is
   * in. Omitted (the pre-V2 scopes) ⇒ fall back to this card's own donut data.
   */
  laneMode?: boolean
}>()

// The Copilot bucket is absent for one of TWO distinct reasons, both leaving `copilotUsd`
// null: it is pending validation (flag off), OR the active window is a partial-month range
// (the pooled MONTHLY net has no daily grain, so it is withheld rather than sliced/faked).
const copilotPartial = computed(() => props.split.partialMonthUnavailable === true)
const copilotPending = computed(() => props.split.copilotUsd == null && !copilotPartial.value)
// Shares render only when the Copilot value is present (both reasons suppress it), so the
// two shown shares always sum to 1 and Anthropic never reads a misleading "100%".
const showShares = computed(() => !copilotPending.value && !copilotPartial.value)
// Denominator for shares — only the present buckets, so the two shown shares sum to 1.
const total = computed(() => props.split.anthropicUsd + (props.split.copilotUsd ?? 0))
const share = (v: number) => (total.value > 0 ? v / total.value : 0)

// ── Lane donut (V2) ───────────────────────────────────────────────────────────
// Gated by the SHARED page-level lane-mode signal (r3-6) so this card cannot
// render per-lane composition while the sibling trend card sits on its legacy
// path (or vice versa); an empty slice set still renders no donut (nothing to
// compose) — the two-bucket layout below always carries the provider truth.
const hasDonut = computed(() => (props.laneMode ?? true) && (props.donut?.slices.length ?? 0) > 0)
const donutSlices = computed(() =>
  (props.donut?.slices ?? []).map((s) => ({ name: s.label, key: s.lane, value: s.value })),
)
const unclassifiedUsd = computed(() => props.donut?.unclassifiedUsd ?? 0)
</script>

<template>
  <UiCard data-testid="chargeback-split-card">
    <!-- Retitled (iter-2 I2): the SURFACE composition is the headline; the
         provider framing (Anthropic per-teammate vs Copilot pooled) is the subtitle. -->
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Chargeback by surface</div>
      <div class="text-[11px] text-carbon-3">
        Cost-of-record split · Anthropic per-teammate vs Copilot pooled · this period
      </div>
    </div>

    <div class="mt-4 flex flex-col lg:flex-row lg:items-center gap-6">
      <!-- Per-lane composition donut (lane-visuals V2): capped + folded; identity
           lives in the page LaneLegend + slice tooltips, never colour alone. -->
      <div v-if="hasDonut" class="shrink-0" data-testid="chargeback-split-donut">
        <ChartDonut
          :slices="donutSlices"
          :center-value="fmtUsd(donut!.chargeableUsd)"
          center-label="chargeable"
          :legend="false"
          :value-format="(v) => fmtUsd(v)"
          :height="176"
        />
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-w-0">
        <!-- Anthropic (per-teammate chargeback) -->
        <div
          class="rounded-xl border border-calm-2/80 bg-calm-1/30 px-4 py-3 flex flex-col gap-1.5 min-w-0"
          data-testid="chargeback-split-anthropic"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0 bg-brand-hunger" aria-hidden="true" />
            <span class="text-[12px] font-semibold text-carbon-1 truncate">Anthropic</span>
            <!-- Suppress the share while Copilot is pending: with only Anthropic present it
                 would read "100%", implying Anthropic is all of chargeback when Copilot is
                 merely withheld. Mirror the Copilot bucket, which hides its % while pending. -->
            <span
              v-if="showShares"
              class="ml-auto text-[11px] text-carbon-3 tabular-nums shrink-0"
            >{{ fmtPct(share(split.anthropicUsd)) }}</span>
          </div>
          <div class="text-[22px] leading-none font-bold tabular-nums text-carbon">
            {{ fmtUsd(split.anthropicUsd) }}
          </div>
          <div class="text-[12px] text-carbon-2">per-teammate chargeback</div>
        </div>

        <!-- GitHub Copilot (pooled net; pending while unvalidated) -->
        <div
          class="rounded-xl border border-calm-2/80 bg-calm-1/30 px-4 py-3 flex flex-col gap-1.5 min-w-0"
          data-testid="chargeback-split-copilot"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0 bg-brand-vision" aria-hidden="true" />
            <span class="text-[12px] font-semibold text-carbon-1 truncate">GitHub Copilot</span>
            <span
              v-if="showShares"
              class="ml-auto text-[11px] text-carbon-3 tabular-nums shrink-0"
            >{{ fmtPct(share(split.copilotUsd ?? 0)) }}</span>
          </div>
          <div
            v-if="copilotPartial"
            class="text-[15px] leading-tight font-semibold text-carbon-3 italic"
            data-testid="chargeback-split-copilot-partial"
          >
            Not shown — partial-month range
          </div>
          <div v-else-if="copilotPending" class="text-[15px] leading-tight font-semibold text-carbon-3 italic">
            Pending validation
          </div>
          <div v-else class="text-[22px] leading-none font-bold tabular-nums text-carbon">
            {{ fmtUsd(split.copilotUsd ?? 0) }}
          </div>
          <div class="text-[12px] text-carbon-2">
            pooled per Business Unit
            <!-- copilot-unclassified: visible + badged, NEVER chargeable (the shipped
                 FinanceCouTable convention) — it is not a donut slice and never sums. -->
            <UiBadge
              v-if="unclassifiedUsd !== 0"
              kind="rag-amber"
              dot="amber"
              class="ml-1.5"
              data-testid="chargeback-split-unclassified"
              :title="`${fmtUsd(unclassifiedUsd)} of unclassified Copilot bill lines — excluded from the chargeable total until the SKU is classified and the month re-run.`"
            >needs mapping</UiBadge>
          </div>
        </div>
      </div>
    </div>

    <p class="mt-3 text-[11px] text-carbon-3 leading-snug" data-testid="chargeback-split-caveat">
      <template v-if="copilotPartial">
        Anthropic only — Copilot pooled chargeback is monthly, not shown for a partial-month range.
      </template>
      <template v-else>
        Anthropic per-teammate chargeback · Copilot is pooled per Business Unit.
      </template>
    </p>
  </UiCard>
</template>
