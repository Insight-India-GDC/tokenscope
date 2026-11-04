<script setup lang="ts">
/*
 * FinanceExemptGap — the exempt / non-chargeable gap, as clean hairline tiles.
 *
 * The gap is the §A indicative usage the §B bill does NOT charge: exempt orgs are
 * never written to bill surfaces (so their spend only ever appears in the usage
 * lane), plus any pooled-pending held-back Copilot. This is usage-lane indicative
 * MINUS chargeback — NOT showback − chargeback (build-design violation 4). It is a
 * MAGNITUDE, so the three tiles are neutral carbon hairline tiles (no RAG, no
 * coloured top-borders) — RAG is reserved for the reconciliation status above.
 */
import UiCard from '../../ui/Card.vue'
import { fmtUsd } from '../../../composables/useFormat'
import FinanceKpiTile from './FinanceKpiTile.vue'
import type { FinanceExemptGap } from '../finance-report-types'

defineProps<{
  gap: FinanceExemptGap
  /** Copilot pooled chargeback held back (pool-utilisation mode) — mode-consistency caption. */
  copilotPending: boolean
}>()
</script>

<template>
  <UiCard data-testid="finance-exempt-gap">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Exempt / non-chargeable gap</div>
      <div class="text-[11px] text-carbon-3">Indicative usage the bill does not charge · not showback</div>
    </div>
    <!-- The §A-lane mechanism went to the comment; what remains is what the Gap
         tile below IS, which a reader cannot deduce from the word "Gap". -->
    <p class="text-[11px] text-carbon-3 leading-snug mb-4 max-w-2xl">
      Indicative usage minus what actually charges back.
    </p>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <FinanceKpiTile label="Indicative usage" :value="fmtUsd(gap.indicativeUsageUsd)" sub="attributed usage" />
      <FinanceKpiTile label="Chargeable" :value="fmtUsd(gap.chargebackUsd)" sub="charged back" />
      <FinanceKpiTile label="Gap" :value="fmtUsd(gap.gapUsd)" sub="usage the bill does not charge" />
    </div>

    <!-- M1: mode-consistency — the held-back Copilot portion of this whole-truth chargeback -->
    <p
      v-if="copilotPending"
      class="mt-3 text-[11px] text-carbon-3 italic leading-snug"
      data-testid="finance-exempt-gap-copilot-caption"
    >
      Chargeable includes Copilot pooled net pending cutover ({{ fmtUsd(gap.copilotChargebackUsd) }}),
      held back from the per-Business Unit Chargeable column.
    </p>
  </UiCard>
</template>
