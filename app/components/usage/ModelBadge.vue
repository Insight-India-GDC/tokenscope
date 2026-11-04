<script setup lang="ts">
/*
 * UsageModelBadge — the dominant-model chip (sprint design §4): ONE subtle
 * badge showing the top model by cost share, with the full model mix in the
 * native tooltip. The rich mix visualisation belongs to My Consumption
 * (next sprint); this chip is deliberately the ceiling for list views.
 *
 * Renders nothing when the breakdown is empty (legacy rows) — never a
 * placeholder chip.
 */
import { computed } from 'vue'
import {
  dominantModel,
  modelDisplay,
  modelMixTitle,
  type ModelSlice,
} from '../../composables/useModelDisplay'

const props = defineProps<{ byModel: ModelSlice[] | undefined }>()

const slices = computed(() => props.byModel ?? [])
const dominant = computed(() => dominantModel(slices.value))
const display = computed(() => (dominant.value ? modelDisplay(dominant.value.model) : null))
const others = computed(() => Math.max(0, slices.value.length - 1))
const title = computed(() => modelMixTitle(slices.value))

// Family tints reuse the UiBadge brand palette (styles.css tokens).
const FAMILY_CLASS: Record<string, string> = {
  fable: 'bg-brand-harmony-lite text-brand-harmony',
  opus: 'bg-brand-hunger-lite text-brand-heart',
  sonnet: 'bg-brand-vision-lite text-brand-vision-ink',
  haiku: 'bg-brand-zeal-lite text-brand-zeal-ink',
  gpt: 'bg-[#DCFCE7] text-[#166534]',
  other: 'bg-calm-2 text-carbon-2',
}
</script>

<template>
  <span
    v-if="display"
    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold leading-4 whitespace-nowrap max-w-[9rem]"
    :class="FAMILY_CLASS[display.family]"
    :title="title"
    data-testid="model-badge"
  >
    <span class="truncate">{{ display.label }}</span>
    <span v-if="others > 0" class="font-medium opacity-70">+{{ others }}</span>
  </span>
</template>
