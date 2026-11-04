<script setup lang="ts">
/*
 * UiKpi — KPI tile.
 *
 * 32px tabular-num value + 11px eyebrow label + optional delta + sub.
 * Accent adds a 3px brand-coloured top border. Sparkline + spark colour
 * come later (Epic 8) — leaving the slot in place keeps the API stable.
 */

defineProps<{
  label: string
  value: string
  sub?: string
  delta?: string
  deltaDir?: 'up' | 'down'
  accent?: 'harmony' | 'hunger' | 'vision' | 'zeal'
}>()
</script>

<template>
  <div
    class="bg-white rounded-xl shadow-[var(--shadow-card)] border border-brand-harmony/[0.04] px-6 pt-5 pb-5 flex flex-col gap-2 relative overflow-hidden"
    :class="[
      accent === 'harmony' && 'border-t-[3px] border-t-brand-harmony',
      accent === 'hunger' && 'border-t-[3px] border-t-brand-hunger',
      accent === 'vision' && 'border-t-[3px] border-t-brand-vision',
      accent === 'zeal' && 'border-t-[3px] border-t-brand-zeal',
    ]"
  >
    <div
      class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3"
    >
      {{ label }}
    </div>
    <div
      class="text-[32px] font-bold tracking-[-1px] text-carbon"
      style="font-variant-numeric: tabular-nums"
    >
      {{ value }}
    </div>
    <div v-if="delta || sub" class="text-xs text-carbon-2 flex gap-1.5 items-center">
      <span
        v-if="delta"
        class="font-bold"
        :class="[deltaDir === 'up' ? 'text-brand-hunger' : 'text-rag-green']"
      >
        {{ delta }}
      </span>
      <span v-if="sub">{{ sub }}</span>
    </div>
  </div>
</template>
