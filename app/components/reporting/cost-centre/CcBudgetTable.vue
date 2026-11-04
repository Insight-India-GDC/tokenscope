<script setup lang="ts">
/*
 * CcBudgetTable — the ranked BUDGET RISK LIST (the Cost-Centre scope's answer to
 * "which cost-centres are burning fastest, and which are at budget risk?").
 *
 * Replaces the old card-wall of near-identical "$X of no allocation / on track
 * within budget" tiles with a dense, scannable ranked list: one row per cost
 * centre (server-sorted by burn desc), each showing name + region, burn $, a RAG
 * utilisation bar with allocation context, the run-rate "on track for $X", and the
 * projected budget-exhaustion date when applicable. Rows are one accessible
 * <button> each — a click drills into that cost-centre's finance view.
 *
 * COLOUR DISCIPLINE: the utilisation bar + status chip are RAG (ragColor via the
 * shared classifier) — a BUDGET STATUS, the one place RAG is legitimate. The
 * run-rate is NEUTRAL carbon (a projection, not a status). A cost centre with no
 * allocation renders a CLEAN "No budget set" state (muted, with a hint) — never a
 * fake "on track within budget".
 */
import { computed } from 'vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import { costCentreBudgetState, type CostCentreBudgetState } from '#shared/reports/types'
import type { ReportLane } from '../../../composables/useReportState'
import type { CostCentreCard } from './cost-centre-view-types'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const props = withDefaults(
  defineProps<{
    cards: CostCentreCard[]
    /** Active lens: usage shows §A burn as the primary figure, chargeback shows §B chargeUsd. */
    lane?: ReportLane
  }>(),
  { lane: 'usage' },
)
const emit = defineEmits<{ select: [ccId: string] }>()

const isChargeback = computed(() => props.lane === 'chargeback')
const primaryLabel = computed(() => (isChargeback.value ? 'Chargeback' : 'Burn'))

/*
 * The shared classifier's own union (D26 added `not-started`), aliased rather
 * than re-declared: a local copy is a second definition that drifts, and every
 * `Record<BudgetState, …>` below is the compiler gate that makes a new member
 * impossible to ignore.
 */
type BudgetState = CostCentreBudgetState

interface RowVm {
  card: CostCentreCard
  state: BudgetState
  statusLabel: string
  hasAlloc: boolean
  fillPct: number
  utilLabel: string
  runRate: string | null
  exhaustion: string | null
  /** Allocation set but zero burn — the $0 is "nothing tagged", not "no data". */
  zeroBurnTagged: boolean
}

const STATUS_LABEL: Record<BudgetState, string> = {
  over: 'Over budget',
  warn: 'Near budget',
  ok: 'On track',
  // The word `useRagState.ts:183` and both prototypes already use — never
  // a second name (`idle`) for one fact.
  'not-started': 'Not started',
  none: 'No budget set',
}
// Literal class strings (a map, so Tailwind sees them) — the bar fill + status text.
const BAR_CLASS: Record<BudgetState, string> = {
  over: 'bg-rag-red',
  warn: 'bg-rag-amber',
  ok: 'bg-rag-green',
  'not-started': '',
  none: '',
}
const DOT_CLASS: Record<BudgetState, string> = {
  over: 'bg-rag-red',
  warn: 'bg-rag-amber',
  ok: 'bg-rag-green',
  'not-started': 'bg-carbon-3/50',
  none: 'bg-carbon-3/50',
}
const TEXT_CLASS: Record<BudgetState, string> = {
  over: 'text-rag-red',
  warn: 'text-rag-amber',
  ok: 'text-rag-green',
  'not-started': 'text-carbon-3',
  none: 'text-carbon-3',
}
// A thin left accent makes at-risk rows pop in the scan; healthy/no-budget rows
// keep a transparent accent so the left edge still aligns.
const ACCENT_CLASS: Record<BudgetState, string> = {
  over: 'border-l-rag-red',
  warn: 'border-l-rag-amber',
  ok: 'border-l-transparent',
  'not-started': 'border-l-transparent',
  none: 'border-l-transparent',
}

const rows = computed<RowVm[]>(() => {
  const mapped = props.cards.map((card) => {
    const state = costCentreBudgetState(card.utilisation)
    const hasAlloc = card.allocationUsd > 0 && card.utilisation != null
    return {
      card,
      state,
      statusLabel: STATUS_LABEL[state],
      hasAlloc,
      // Clamp the visible fill at 100% — an over-budget bar reads full-red, the
      // exact % is spelled out beside it.
      fillPct: hasAlloc ? Math.min((card.utilisation ?? 0) * 100, 100) : 0,
      utilLabel: hasAlloc ? fmtPct(card.utilisation) : '',
      runRate: card.forecast ? fmtUsd(card.forecast.projectedUsd) : null,
      exhaustion: card.exhaustionDate,
      zeroBurnTagged: card.allocationUsd > 0 && card.burnUsd === 0,
    }
  })
  // The server sorts cards by §A burn. In chargeback mode the shown figure is §B
  // chargeUsd, so re-rank by it — otherwise the rank numerals descend by a burn key
  // the user can no longer see and the §B figures look non-monotonic (round-2 #1).
  return isChargeback.value ? [...mapped].sort((a, b) => b.card.chargeUsd - a.card.chargeUsd) : mapped
})

// Compact RAG legend (colour + label, never colour alone) for the header.
const LEGEND: { state: BudgetState; label: string }[] = [
  { state: 'over', label: 'Over' },
  { state: 'warn', label: 'Near' },
  { state: 'ok', label: 'On track' },
  { state: 'none', label: 'No budget' },
]
</script>

<template>
  <section
    class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] overflow-hidden"
    data-testid="cc-budget-table"
  >
    <!-- Header -->
    <header class="px-4 sm:px-5 py-4 border-b border-calm-1 flex items-baseline justify-between gap-4 flex-wrap">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-carbon-1">Budget tracker</h3>
        <p class="text-[11px] text-carbon-3 mt-0.5">
          <template v-if="isChargeback">Chargeback per {{ BU_LABEL_LOWER }} — select one to drill in.</template>
          <template v-else>Ranked by burn · select a {{ BU_LABEL_LOWER }} to drill in.</template>
        </p>
        <p
          v-if="isChargeback"
          class="text-[11px] text-carbon-3 italic mt-0.5"
          data-testid="cc-budget-scope-note"
        >Budget health (burn vs allocation) is usage-based — switch to Usage.</p>
      </div>
      <ul v-if="!isChargeback" class="flex items-center gap-x-3 gap-y-1 flex-wrap" aria-label="Budget status legend">
        <li
          v-for="l in LEGEND"
          :key="l.state"
          class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
        >
          <span class="w-2 h-2 rounded-full shrink-0" :class="DOT_CLASS[l.state]" aria-hidden="true" />
          {{ l.label }}
        </li>
      </ul>
    </header>

    <!-- Rows -->
    <ul class="divide-y divide-calm-1">
      <li v-for="(row, i) in rows" :key="row.card.id">
        <button
          type="button"
          class="group w-full text-left border-l-2 px-4 sm:px-5 py-3.5 flex flex-col gap-3 transition-colors hover:bg-brand-harmony-sheer/60 focus-visible:-outline-offset-2 focus-visible:bg-brand-harmony-sheer md:grid md:items-center md:gap-x-5 md:gap-y-0 md:grid-cols-[1.5rem_minmax(8rem,1.25fr)_6.5rem_minmax(9.5rem,1.9fr)_minmax(8rem,auto)_0.6rem]"
          :class="isChargeback ? 'border-l-transparent' : ACCENT_CLASS[row.state]"
          :data-testid="`cc-row-${row.card.code}`"
          :data-state="row.state"
          @click="emit('select', row.card.id)"
        >
          <!-- Rank -->
          <span class="hidden md:flex items-center justify-center text-[12px] font-semibold text-carbon-3 tabular-nums">
            {{ i + 1 }}
          </span>

          <!-- Name + region -->
          <div class="min-w-0">
            <div class="text-[14px] font-semibold text-carbon truncate group-hover:text-brand-harmony transition-colors">
              {{ row.card.displayName }}
            </div>
            <div class="text-[11px] uppercase tracking-[0.6px] text-carbon-3">
              {{ row.card.regionCode.toUpperCase() }}
            </div>
          </div>

          <!-- Primary figure — §A burn (usage lane) ⇄ §B chargeback (bill lane) -->
          <div class="md:text-right">
            <div class="md:hidden text-[10px] font-bold uppercase tracking-[1px] text-carbon-3 mb-0.5">{{ primaryLabel }}</div>
            <div class="text-[16px] font-bold tabular-nums text-carbon leading-none">
              {{ fmtUsd(isChargeback ? row.card.chargeUsd : row.card.burnUsd) }}
            </div>
            <div
              v-if="isChargeback"
              class="mt-1 text-[10px] text-carbon-3 uppercase tracking-[0.6px]"
            >chargeback</div>
            <div
              v-else-if="row.zeroBurnTagged"
              class="mt-1 text-[10px] text-carbon-3 italic"
              :data-testid="`cc-row-no-tagged-${row.card.code}`"
            >no tagged usage</div>
          </div>

          <!-- Utilisation bar + allocation context (RAG budget status). The RAG chip,
               util% and bar are §A burn-vs-allocation — they describe the BURN, not the
               §B chargeback figure — so they are SUPPRESSED in chargeback mode; only the
               allocation context stays (the finance user gets the figure + its budget). -->
          <div class="min-w-0">
            <template v-if="!isChargeback">
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold" :class="TEXT_CLASS[row.state]">
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="DOT_CLASS[row.state]" aria-hidden="true" />
                  {{ row.statusLabel }}
                </span>
                <span v-if="row.hasAlloc" class="text-[11px] font-semibold tabular-nums" :class="TEXT_CLASS[row.state]">
                  {{ row.utilLabel }}
                </span>
              </div>

              <div v-if="row.hasAlloc" class="h-2 rounded-full bg-calm-1 overflow-hidden" role="presentation">
                <div class="h-full rounded-full" :class="BAR_CLASS[row.state]" :style="{ width: `${row.fillPct}%` }" />
              </div>
              <div v-else class="h-2 rounded-full border border-dashed border-calm" />

              <div class="mt-1 text-[11px] text-carbon-3 truncate">
                <template v-if="row.hasAlloc">of {{ fmtUsd(row.card.allocationUsd) }} allocated</template>
                <template v-else>Set an allocation to track burn against budget</template>
              </div>
            </template>
            <div
              v-else
              class="text-[11px] text-carbon-3 truncate"
              :data-testid="`cc-row-alloc-${row.card.code}`"
            >
              <template v-if="row.hasAlloc">of {{ fmtUsd(row.card.allocationUsd) }} allocated</template>
              <template v-else>No budget set</template>
            </div>
          </div>

          <!-- Run-rate (neutral) + projected exhaustion (amber) — both are §A burn
               projections ("on track for $X" / budget-exhaustion date), so they do NOT
               describe the §B chargeback figure and are SUPPRESSED in chargeback mode. -->
          <div class="md:text-right space-y-1">
            <template v-if="!isChargeback">
              <div v-if="row.runRate" class="tabular-nums">
                <span class="md:hidden text-[10px] font-bold uppercase tracking-[1px] text-carbon-3 mr-1">Run-rate</span>
                <span class="text-[13px] text-carbon-2">on track for </span>
                <span class="text-[13px] font-semibold text-carbon">{{ row.runRate }}</span>
              </div>
              <div
                v-if="row.exhaustion"
                class="inline-flex items-center gap-1 text-[11px] font-semibold text-rag-amber"
                :data-testid="`cc-row-exhaustion-${row.card.code}`"
              >
                <span aria-hidden="true">⚠</span> budget runs out ~{{ row.exhaustion }}
              </div>
              <div v-else-if="!row.runRate" class="text-[11px] text-carbon-3 italic">actual for the month</div>
            </template>
          </div>

          <!-- Drill chevron -->
          <span class="hidden md:flex items-center justify-center text-carbon-3 group-hover:text-brand-harmony transition-colors" aria-hidden="true">
            ›
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
