<script setup lang="ts">
/*
 * UiFreshness — "updated N min ago" indicator.
 *
 * Copy is intentionally tone-matched (per the prototype's design notes,
 * docs/archive/ux-pilot/tokenscope-pilot-design/project/design-notes.md §Microcopy posture):
 * action over alarm.
 *
 * It used to carry "· Anthropic actuals lag ~1 hr" on every render. That is a
 * fact about OUR ingestion mechanism, not about the reader's data — the fact
 * they need is how old this figure is, which the minutes already say. The place
 * to explain a lag is where the data IS stale, not beside a figure that is one
 * minute old.
 *
 * Constraints (ops-alerting §A6.1):
 *  - the dot colour comes from the ONE shared thresholds module
 *    (shared/observability/freshness.ts) — no bounds live here;
 *  - `minutes` has NO default. Absent/null renders a neutral dot and
 *    "freshness unknown" — never green. (The old `minutes: 12` default is the
 *    fabricated value §A6.1 kills.)
 */
import { computed } from 'vue'
import { freshnessTier, type FreshnessTier } from '#shared/observability/freshness'

const props = defineProps<{
  minutes?: number | null
}>()

const tier = computed<FreshnessTier>(() => freshnessTier(props.minutes))

const DOT_CLASS: Record<FreshnessTier, string> = {
  fresh: 'bg-rag-green',
  aging: 'bg-rag-amber',
  stale: 'bg-rag-red',
  unknown: 'bg-cloud',
}
</script>

<template>
  <div
    class="text-[11px] text-carbon-3 inline-flex items-center gap-1.5"
    data-testid="freshness"
    :data-tier="tier"
  >
    <span
      class="inline-block w-2 h-2 rounded-full"
      :class="DOT_CLASS[tier]"
      data-testid="freshness-dot"
      aria-hidden="true"
    />
    <template v-if="tier === 'unknown'">freshness unknown</template>
    <template v-else>Updated {{ minutes }} min ago</template>
  </div>
</template>
