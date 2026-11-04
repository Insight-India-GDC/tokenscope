<script setup lang="ts">
/*
 * UiPbar — progress bar.
 *
 * Threshold colouring per the prototype's design notes
 * (docs/archive/ux-pilot/tokenscope-pilot-design/project/design-notes.md §Screen 2) hero progress bar:
 * green default (Vision → Harmony gradient), amber at ≥75 %, red at ≥90 %.
 * Threshold rules live in `useRagState.ts::ragOf()` so every consumer
 * shares one source of truth.
 */

import { ragOf } from '../../composables/useRagState'

const props = withDefaults(
  defineProps<{
    pct: number
    size?: 'sm' | 'lg' | 'xl'
  }>(),
  { size: 'sm' },
)

const sev = ragOf(props.pct)
const widthPct = Math.min(100, Math.max(0, props.pct * 100))
</script>

<template>
  <div
    class="relative bg-calm-2 rounded-full overflow-hidden"
    :class="[size === 'sm' && 'h-1.5', size === 'lg' && 'h-2.5', size === 'xl' && 'h-3.5']"
    role="progressbar"
    :aria-valuenow="Math.round(widthPct)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div
      class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-[400ms] ease-[ease]"
      :class="[
        sev === 'green' && 'bg-gradient-to-r from-brand-vision to-brand-harmony',
        sev === 'amber' && 'bg-gradient-to-r from-[#FBBF24] to-rag-amber',
        sev === 'red' && 'bg-gradient-to-r from-[#F87171] to-rag-red',
      ]"
      :style="{ width: widthPct + '%' }"
    />
  </div>
</template>
