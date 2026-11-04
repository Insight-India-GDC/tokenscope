<script setup lang="ts">
/*
 * FinanceCouTable — "Chargeback by cost-owning unit": a ranked bar (magnitude) over
 * the precise per-CoU table (Anthropic / Copilot / Chargeable).
 *
 * The bar is a RANKING, so it wears a single magnitude hue (ChartRankedBar) with the
 * $ at the tip — never a categorical cycle, never a black/solid bar. It ranks the
 * Chargeable total (what we actually charge back). The table underneath carries the
 * exact per-provider split; a row drills into that CoU. The explicit "Unallocated"
 * bucket (no CoU mapped) is retained for sum-back honesty and carries no drill.
 *
 * SURFACE MIX (#142): each row also renders a per-CoU stacked lane bar — the
 * chargeable split by vendor lane (Claude Code, each non-Code Claude surface,
 * Copilot). Colours are FIXED per lane id (vendorLaneColor — a CoU missing a
 * lane never repaints the others); ONE legend for the page sits above the
 * table; identity is never colour-alone (legend + tooltips + the exact-figures
 * table are the relief channel). Segment Σ == the row's Chargeable column: in
 * pool-utilisation mode the copilot lane is held OUT of the bar, exactly like
 * the total.
 *
 * When Copilot chargeback is held back (pool-utilisation mode) the Copilot column
 * reads "(pending)" and never leaks into the Chargeable total — the header chip says
 * so. A month with no per-CoU chargeback shows a graceful empty state.
 *
 * REMEDIATION (requirement 6): the Unallocated row carries a quiet link to the
 * reconciliation admin surface, where an admin homes the org to a cost-owning
 * unit — the row's money stays in every total (estate + CSV) until then.
 */
import { computed } from 'vue'
import ChartRankedBar, { type RankedRow } from '../charts/ChartRankedBar.client.vue'
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import UnallocatedRemediationLink from '../UnallocatedRemediationLink.vue'
import { fmtUsd, fmtSharePct } from '../../../composables/useFormat'
import { allocateCents } from '#shared/usage/allocate-cents'
import { vendorLaneColor } from '../../../composables/useChartScale'
import { VENDOR_LANES, type Vendor } from '#shared/usage/vendor'
import { GITHUB_ALL_CHARGEBACK_LANES, COPILOT_UNCLASSIFIED_LANE } from '#shared/usage/github-surface'
import type { FinanceCouRow, FinanceCouLane } from '../finance-report-types'

// The §B Copilot chargeback lanes (registry-driven — never hand literals).
const COPILOT_CHARGEBACK_LANE_SET = new Set<string>(GITHUB_ALL_CHARGEBACK_LANES)

const props = withDefaults(
  defineProps<{
    cous: FinanceCouRow[]
    /** Copilot pooled chargeback not yet validated (pool-utilisation mode). */
    copilotPending: boolean
    /** Admin-only "Fix org homing →" (the container decides; fail-closed). */
    canFixHoming?: boolean
  }>(),
  { canFixHoming: false },
)

const emit = defineEmits<{ drill: [couId: string] }>()

const hasRows = computed(() => props.cous.length > 0)

// Ranked bar: magnitude over the Chargeable total, biggest first. The unallocated
// bucket keeps its label but carries a null meta so a click is a no-op.
const barRows = computed<RankedRow[]>(() =>
  [...props.cous]
    .sort((a, b) => b.chargeableUsd - a.chargeableUsd)
    .map((c) => ({ label: c.displayName, value: c.chargeableUsd, meta: c.couId })),
)

function onBarSelect(row: RankedRow) {
  if (typeof row.meta === 'string') emit('drill', row.meta)
}

// ── Surface mix (#142) ────────────────────────────────────────────────────────
interface LaneSeg extends FinanceCouLane {
  color: string
  /** Share of the row's own chargeable total (the bar's denominator). */
  share: number
}

/** The row's bar segments: its lanes minus the Copilot chargeback lanes while
 * pending, and minus copilot-unclassified ALWAYS (unclassified is never
 * chargeable — it is badged instead), mirroring the Chargeable column. Each
 * segment carries its FIXED lane colour + share of the row.
 * Displayed $ are largest-remainder cent-allocated over the segment total so
 * the tooltips/labels always sum to the row figure exactly (independent
 * per-lane rounding drifts by a cent — #142 review finding 3). */
function laneSegments(c: FinanceCouRow): LaneSeg[] {
  const lanes = (c.lanes ?? []).filter((l) => {
    if (l.lane === COPILOT_UNCLASSIFIED_LANE) return false
    return !(c.copilotPending && COPILOT_CHARGEBACK_LANE_SET.has(l.lane))
  })
  const total = lanes.reduce((a, l) => a + l.usd, 0)
  const alloc = allocateCents(lanes.map((l) => l.usd))
  return lanes.map((l, i) => ({
    ...l,
    usd: alloc[i]!,
    color: vendorLaneColor(l.lane as Vendor),
    share: total > 0 ? l.usd / total : 0,
  }))
}

// Memoised per-row segments (laneSegments is pure but was recomputed 3× per
// row per render — v-if, v-for, and the legend all consult it).
const segmentsByRow = computed<Map<string, LaneSeg[]>>(
  () => new Map(props.cous.map((c) => [c.couId ?? 'unallocated', laneSegments(c)])),
)
const rowSegments = (c: FinanceCouRow): LaneSeg[] => segmentsByRow.value.get(c.couId ?? 'unallocated') ?? []

/** The row's copilot-unclassified $, if any — badged "needs mapping" on the
 * Copilot column (visible everywhere, chargeable nowhere). */
function unclassifiedUsd(c: FinanceCouRow): number {
  return (c.lanes ?? []).find((l) => l.lane === COPILOT_UNCLASSIFIED_LANE)?.usd ?? 0
}

// ONE legend for the whole table: every lane present in any row, in canonical
// VENDOR_LANES order (colour follows the lane id, never its position).
const legendLanes = computed<LaneSeg[]>(() => {
  const seen = new Map<string, FinanceCouLane>()
  for (const segs of segmentsByRow.value.values()) {
    for (const l of segs) if (!seen.has(l.lane)) seen.set(l.lane, l)
  }
  return (VENDOR_LANES as readonly string[])
    .filter((lane) => seen.has(lane))
    .map((lane) => ({ ...seen.get(lane)!, color: vendorLaneColor(lane as Vendor), share: 0 }))
})

</script>

<template>
  <UiCard data-testid="finance-cou-table">
    <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
      <div class="text-sm font-semibold text-carbon-1">Chargeback by Business Unit</div>
      <UiBadge
        v-if="copilotPending"
        kind="rag-amber"
        dot="amber"
        data-testid="finance-copilot-pending-chip"
        title="Copilot pooled chargeback is not yet validated against the bill, so it is held back from the chargeable total."
      >Copilot chargeback pending</UiBadge>
      <UiBadge v-else kind="vision" dot="vision" data-testid="finance-copilot-chargeback-chip">Copilot pooled net included</UiBadge>
    </div>
    <div class="text-[11px] text-carbon-3 mb-4">Ranked by chargeable · select a unit to drill into its charges.</div>

    <template v-if="hasRows">
      <ChartRankedBar
        :rows="barRows"
        :value-format="(v) => fmtUsd(v)"
        clickable
        @select="onBarSelect"
      />

      <!-- ONE legend for the page's lane colours (#142) — identity is never
           colour-alone: each segment also carries a tooltip and the table the
           exact figures. -->
      <div
        v-if="legendLanes.length"
        class="mt-5 flex flex-wrap gap-x-4 gap-y-1.5"
        data-testid="finance-lane-legend"
      >
        <span
          v-for="l in legendLanes"
          :key="l.lane"
          class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
        >
          <span class="inline-block w-2 h-2 rounded-sm shrink-0" :style="{ background: l.color }" aria-hidden="true" />
          {{ l.label }}
        </span>
      </div>

      <div class="mt-3 overflow-x-auto">
        <table class="w-full text-sm min-w-[680px]">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Business Unit</th>
              <th class="text-left font-semibold py-2 pl-4 min-w-[180px]">Surface mix</th>
              <th class="text-right font-semibold py-2">Anthropic</th>
              <th class="text-right font-semibold py-2">Copilot</th>
              <th class="text-right font-semibold py-2">Chargeable</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in cous"
              :key="c.couId ?? 'unallocated'"
              class="border-b border-calm-1 last:border-0 hover:bg-calm-1/40"
              :data-testid="`finance-cou-row-${c.code ?? 'unallocated'}`"
            >
              <td class="py-2.5">
                <button
                  v-if="c.couId"
                  type="button"
                  class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
                  :data-testid="`finance-cou-drill-${c.code ?? 'x'}`"
                  @click="emit('drill', c.couId!)"
                >{{ c.displayName }}</button>
                <span
                  v-else
                  class="font-medium text-carbon-2 italic"
                  title="No Business Unit mapped — a visible unallocated bucket, never dropped."
                >{{ c.displayName }}</span>
                <UnallocatedRemediationLink v-if="!c.couId" class="ml-2 align-middle" :can-fix="props.canFixHoming" />
                <span v-if="c.regionCode" class="text-carbon-3 text-[11px]"> · {{ c.regionCode.toUpperCase() }}</span>
              </td>
              <!-- Per-CoU surface-mix bar (#142): stacked lanes, 2px gaps, rounded
                   data-ends, FIXED per-lane colours, tooltip per segment (label +
                   $ + % of the CoU), direct $ labels only where a segment is wide
                   enough. Σ segments == the Chargeable column. -->
              <td class="py-2.5 pl-4">
                <div
                  v-if="rowSegments(c).length"
                  class="flex gap-[2px] h-3.5 items-stretch"
                  role="img"
                  :aria-label="`${c.displayName} chargeback by surface`"
                  :data-testid="`finance-lane-bar-${c.code ?? 'unallocated'}`"
                >
                  <div
                    v-for="seg in rowSegments(c)"
                    :key="seg.lane"
                    class="h-full min-w-[3px] first:rounded-l-full last:rounded-r-full flex items-center justify-center overflow-hidden"
                    :style="{ width: `${seg.share * 100}%`, background: seg.color }"
                    :title="`${seg.label} — ${fmtUsd(seg.usd)} · ${fmtSharePct(seg.share)} of ${c.displayName}`"
                  >
                    <span
                      v-if="seg.share >= 0.3"
                      class="text-[9px] font-semibold leading-none text-white whitespace-nowrap"
                      style="text-shadow: 0 0 2px rgba(0, 0, 0, 0.45)"
                    >{{ fmtUsd(seg.usd) }}</span>
                  </div>
                </div>
                <span v-else class="text-[11px] text-carbon-3 italic">—</span>
              </td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(c.anthropicUsd) }}</td>
              <td
                class="py-2.5 text-right tabular-nums"
                :class="c.copilotPending ? 'text-carbon-3 italic' : 'text-carbon-1'"
                :title="c.copilotPending ? 'Pooled Copilot net, held back until it is validated against the bill' : undefined"
              >
                {{ c.copilotPending ? `${fmtUsd(c.copilotUsd)} (pending)` : fmtUsd(c.copilotUsd) }}
                <UiBadge
                  v-if="unclassifiedUsd(c) !== 0"
                  kind="rag-amber"
                  dot="amber"
                  class="ml-1.5"
                  :data-testid="`finance-cou-unclassified-${c.code ?? 'unallocated'}`"
                  :title="`${fmtUsd(unclassifiedUsd(c))} of unclassified Copilot bill lines — excluded from Chargeable until the SKU is classified and the month re-run.`"
                >needs mapping</UiBadge>
              </td>
              <td class="py-2.5 text-right tabular-nums font-semibold text-carbon-1">{{ fmtUsd(c.chargeableUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Graceful empty: a month with a bill/gap but no per-CoU chargeback rows -->
    <div
      v-else
      class="py-10 text-center"
      data-testid="finance-cou-empty"
    >
      <div class="text-sm font-semibold text-carbon-2">No chargeback for this month</div>
      <div class="mt-1 text-[12px] text-carbon-3">As the month's bills land and home to Business Units, they appear here.</div>
    </div>
  </UiCard>
</template>
