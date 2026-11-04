<script setup lang="ts">
/*
 * CcScopeLine — WHICH COST CENTRE THIS PAGE IS ABOUT (F5 D23).
 *
 * ── THE DEFECT IT CLOSES ─────────────────────────────────────────────────────
 * The Cost-centre tab shipped with no scope statement and no selector: its
 * title said "Cost centres", its KPI subtitle said "across 38 cost centres",
 * and a cost-centre owner had no way to tell what they were looking at — or to
 * reach their own centre, which was behind a click inside a table they had no
 * reason to read as a door.
 *
 *   `R:551-559`, note `scope` — *"The Cost-centre tab lands ON a cost centre.
 *   There is no unscoped state, and never was. The reader arrives already
 *   scoped — crumb above, centre named beside the window — because 'which cost
 *   centre am I looking at' must never be a question this page leaves open."*
 *
 * ── THREE RULES, ALL FROM THE DRAWING ────────────────────────────────────────
 * 1. THE LABEL IS THE SERVER's. `scopeLabel` comes from `report.scope`, which
 *    the endpoint derives from the very resolver that clamped the cards. A view
 *    that composed its own from a route param would name a scope the server may
 *    not have served (`ScopeHero.vue:102-108` records that failure for regions).
 * 2. ONE OPTION IS NOT A SELECTOR, IT IS A LABEL (`region-options.ts:63-65`,
 *    and `R:553-555` in these words exactly). A reader holding one centre gets
 *    the NAME, and no control.
 * 3. IT RENDERS IN BOTH STATES — scoped and unscoped — so the architecture
 *    switch is never silent. A scope line that appeared only once a centre was
 *    chosen would leave the pre-scope state looking exactly like the unlabelled
 *    page this fix is about.
 *
 * PURE + prop-driven: the URL write (`?cc=`, already a first-class key —
 * `useReportState.ts:72-82`) is the container's, through `select`.
 */
import { computed } from 'vue'
import type { CostCentreScope } from '#shared/reports/types'
import { BU_LABEL, BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const props = defineProps<{
  /** The server's scope block. Absent while the grid fetch is in flight. */
  scope?: CostCentreScope | null
  /** The centre currently in the URL (`?cc=`), or null before landing. */
  selectedCcId?: string | null
  /** The window every figure below covers, in the server's words. */
  windowLabel?: string
}>()

/*
 * SELECT ONLY. A `clear: []` sat here and was never emitted by this template nor
 * subscribed by any parent — a declared exit from a scope the ruling above says
 * has no exit. Deleted rather than wired up (external review): the one thing it
 * could have done is put the reader in the unscoped state.
 */
const emit = defineEmits<{ select: [ccId: string] }>()

const options = computed(() => props.scope?.options ?? [])
const selected = computed(() =>
  options.value.find((o) => o.id === props.selectedCcId) ?? null,
)
/*
 * WHAT THE PAGE SAYS IT IS SHOWING, in precedence order:
 *   the centre the reader is ON  →  the centre they will land on  →  nothing.
 *
 * The last case is a reader who can see no cost centre at all, and it says so
 * rather than printing an empty name. It is NOT "no cost centres exist":
 * `fetchVisibleCostCentres` filters by visibility before returning, so this
 * page can never tell those two apart and does not try.
 */
const label = computed(
  () => selected.value?.displayName ?? props.scope?.scopeLabel ?? null,
)
const regionCode = computed(() => selected.value?.regionCode ?? null)
// Counted off the options, never off a grant flag — one control, one rule.
const showSelector = computed(() => options.value.length > 1)
</script>

<template>
  <div class="flex items-baseline gap-x-3 gap-y-1.5 flex-wrap" data-testid="cc-scope-line">
    <span class="text-[10px] font-bold uppercase tracking-[0.9px] text-carbon-3">
      {{ BU_LABEL }}
    </span>

    <!-- A REAL CHOICE: a control. -->
    <select
      v-if="showSelector"
      class="text-[13px] font-semibold text-carbon-1 bg-white border border-calm-2 rounded-md px-2 py-1 hover:border-brand-harmony focus-visible:border-brand-harmony"
      :aria-label="BU_LABEL"
      data-testid="cc-scope-selector"
      :value="selected?.id ?? props.scope?.defaultCcId ?? ''"
      @change="emit('select', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="o in options" :key="o.id" :value="o.id">
        {{ o.displayName }}{{ o.owned ? ' (yours)' : '' }}
      </option>
    </select>

    <!-- ONE OPTION IS NOT A SELECTOR, IT IS A LABEL. -->
    <b v-else-if="label" class="text-[15px] text-carbon" data-testid="cc-scope-label">{{ label }}</b>

    <!-- No centre visible at all — stated, never blank. -->
    <span v-else class="text-[13px] text-carbon-3 italic" data-testid="cc-scope-none">
      No {{ BU_LABEL_LOWER }} in your scope
    </span>

    <span v-if="regionCode" class="text-[11px] uppercase tracking-[0.6px] text-carbon-3">
      {{ regionCode }}
    </span>
    <span v-if="windowLabel" class="text-[12px] text-carbon-2">{{ windowLabel }}</span>
  </div>
</template>
