<script setup lang="ts">
/*
 * FinanceBillCheck — the VISIBLE Σ chargeback = bill reconciliation headline.
 *
 * This is the trust anchor of the §B chargeback pack: the whole month's chargeback
 * MUST reconcile to the whole month's bill. The state is a real STATUS, so it is the
 * ONE place RAG is allowed (design language: reconciliation status = ragColor + icon
 * + label; a spend Δ elsewhere stays neutral). Matched → green "reconciles"; a delta
 * OR an unsettled provider month (usage but no read license SKU) → red — NEVER a
 * silent pass (build-design §7(1), risk 7). The amounts are always on screen.
 *
 * When Copilot chargeback is held back (pool-utilisation mode), the Σ=bill figure
 * stays whole-truth (it folds the Copilot pooled net) while the per-CoU Chargeable
 * column holds it back — the M1 caption states the exact held-back delta so the GREEN
 * headline still reconciles to the smaller column footing.
 */
import { computed } from 'vue'
import { fmtUsd } from '../../../composables/useFormat'
import { vendorLabel } from '#shared/reports/types'
import type { FinanceBillCheck } from '../finance-report-types'

const props = defineProps<{
  check: FinanceBillCheck
  /** Copilot pooled chargeback not yet validated (pool-utilisation mode). */
  copilotPending: boolean
}>()

const hasDelta = computed(() => Math.abs(props.check.deltaUsd) > 0.005)
// The reconciliation label: not-reconciling is either an UNSETTLED month (missing
// license SKU) or a genuine delta break — both read RED (status, reserved RAG use).
const breakLabel = computed(() => (props.check.unsettled ? 'unsettled' : 'does not reconcile'))
</script>

<template>
  <section
    class="bg-white rounded-xl border border-brand-harmony/[0.04] shadow-[var(--shadow-card)] overflow-hidden"
    data-testid="finance-bill-check"
    :data-matched="check.matched"
  >
    <!-- Status hairline rail (RAG = reconciliation status, the reserved use) -->
    <div
      class="h-1 w-full"
      :class="check.matched ? 'bg-rag-green' : 'bg-rag-red'"
      aria-hidden="true"
    />

    <div class="p-6">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="min-w-0">
          <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3">
            Chargeback total = bill
          </div>
          <div class="mt-1.5 flex items-baseline gap-2.5 flex-wrap">
            <span class="text-[34px] leading-none font-extrabold tracking-[-1px] text-carbon tabular-nums">
              {{ fmtUsd(check.chargebackUsd) }}
            </span>
            <span class="text-sm text-carbon-3">
              vs bill <span class="tabular-nums text-carbon-2 font-semibold">{{ fmtUsd(check.billUsd) }}</span>
            </span>
            <span
              class="text-[12px] tabular-nums"
              :class="hasDelta ? 'text-rag-red font-semibold' : 'text-carbon-3'"
            >
              (Δ {{ fmtUsd(check.deltaUsd) }})
            </span>
          </div>
        </div>

        <!-- Status pill: icon + label (never colour-alone) -->
        <div class="shrink-0">
          <span
            v-if="check.matched"
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rag-green/10 text-[#166534] text-[12px] font-bold"
            data-testid="finance-bill-check-matched"
          >
            <svg viewBox="0 0 20 20" fill="none" class="w-3.5 h-3.5" aria-hidden="true">
              <path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            reconciles to bill
          </span>
          <span
            v-else
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rag-red/10 text-[#991B1B] text-[12px] font-bold"
            data-testid="finance-bill-check-unsettled"
            :title="check.unsettled ? 'A provider month has usage but no read license SKU — the bill is not fully settled.' : 'The chargeback does not reconcile to the bill.'"
          >
            <svg viewBox="0 0 20 20" fill="none" class="w-3.5 h-3.5" aria-hidden="true">
              <path d="M10 3l7.5 13H2.5L10 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
              <path d="M10 8.5v3.2M10 14.2v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            {{ breakLabel }}
          </span>
        </div>
      </div>

      <!-- Per-provider bill provenance (each provider from exactly one surface) -->
      <div
        class="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[12px] text-carbon-2 pt-3 border-t border-calm-2/70"
        data-testid="finance-bill-providers"
      >
        <span v-for="p in check.providers" :key="p.provider" class="inline-flex items-center gap-1.5">
          <span
            class="w-2 h-2 rounded-sm shrink-0"
            :class="p.provider === 'github' ? 'bg-brand-vision' : 'bg-brand-hunger'"
            aria-hidden="true"
          />
          <span class="font-semibold">{{ vendorLabel(p.provider) }}</span>
          <span class="tabular-nums text-carbon-1">{{ fmtUsd(p.billUsd) }}</span>
          <span
            v-if="p.unsettled"
            class="ml-0.5 px-1.5 py-px rounded bg-rag-red/10 text-[#991B1B] text-[10px] font-bold uppercase tracking-wide"
          >unsettled</span>
        </span>
        <span v-if="!check.providers.length" class="text-carbon-3 italic">No provider bill for this period yet.</span>
      </div>

      <!-- M1: pool-utilisation foot-mismatch honesty — the held-back Copilot delta -->
      <p
        v-if="copilotPending"
        class="mt-2.5 text-[11px] text-carbon-3 italic leading-snug"
        data-testid="finance-bill-copilot-caption"
      >
        The total includes Copilot pooled net pending cutover ({{ fmtUsd(check.copilotChargebackUsd) }})
        not yet in the Chargeable column.
      </p>
    </div>
  </section>
</template>
