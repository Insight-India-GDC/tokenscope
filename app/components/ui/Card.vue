<script setup lang="ts">
/*
 * UiCard — base card primitive.
 *
 * Ported from docs/archive/ux-pilot/tokenscope-pilot-design/project/src/chrome.jsx::Card. Accent variant
 * adds a 3px brand-coloured top border per the prototype's design-notes.md
 * (same folder). Hover variant
 * lifts the card 1px on hover.
 */

defineProps<{
  accent?: 'harmony' | 'hunger' | 'vision' | 'zeal'
  hover?: boolean
  flush?: boolean
}>()
</script>

<template>
  <div
    class="bg-white rounded-xl shadow-[var(--shadow-card)] border border-brand-harmony/[0.04]"
    :class="[
      flush ? 'p-0' : 'p-6',
      hover &&
        'transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[var(--shadow-card-h)]',
      accent === 'harmony' && 'border-t-[3px] border-t-brand-harmony',
      accent === 'hunger' && 'border-t-[3px] border-t-brand-hunger',
      accent === 'vision' && 'border-t-[3px] border-t-brand-vision',
      accent === 'zeal' && 'border-t-[3px] border-t-brand-zeal',
    ]"
  >
    <slot />
  </div>
</template>
