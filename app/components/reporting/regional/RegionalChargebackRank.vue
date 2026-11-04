<script setup lang="ts">
/*
 * RegionalChargebackRank — the §B "Chargeback by cost-centre" ranking that REPLACES
 * the §A "Usage by practice" card in chargeback mode. Ranks the region's real
 * cross-charge per cost-owning unit (`chargebackByCostCentre`, sourced from
 * `v_finance_chargeback_month` — the bill lane, NEVER usage). The §B analogue of
 * RegionalPracticeRank: same magnitude ranked-bar treatment, but no drill target
 * (a cost-centre's per-teammate chargeback lives in the Finance scope, not here) and
 * the explicit "Unallocated" NULL-CoU bucket kept for sum-back honesty — with a
 * quiet remediation link to the reconciliation admin surface (requirement 6).
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import UnallocatedRemediationLink from '../UnallocatedRemediationLink.vue'
import { fmtUsd } from '../../../composables/useFormat'
import { UNALLOCATED_KEY } from '#shared/reports/unallocated'

const props = withDefaults(
  defineProps<{
    rows: { key: string; label: string; value: number }[]
    /** Admin-only "Fix org homing →" (the container decides; fail-closed). */
    canFixHoming?: boolean
  }>(),
  { canFixHoming: false },
)

const barRows = computed(() =>
  props.rows.map((r) => ({ label: r.label, value: r.value, meta: r.key })),
)
const hasUnallocated = computed(() => props.rows.some((r) => r.key === UNALLOCATED_KEY && r.value !== 0))
</script>

<template>
  <UiCard data-testid="regional-chargeback-rank">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Chargeback by Business Unit</div>
      <div class="text-[11px] text-carbon-3">Ranked by chargeback · sums to chargeable</div>
    </div>
    <div class="text-[11px] text-carbon-3 mb-3 flex items-center gap-2 flex-wrap">
      <span>The real cross-charge homed to each Business Unit (bill lane). Per-teammate detail lives in Finance.</span>
      <UnallocatedRemediationLink v-if="hasUnallocated" :can-fix="props.canFixHoming" />
    </div>

    <ChartRankedBar
      v-if="barRows.length"
      :rows="barRows"
      :value-format="(v) => fmtUsd(v)"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="regional-chargeback-empty">
      No chargeback recorded for this region and period yet.
    </p>
  </UiCard>
</template>
