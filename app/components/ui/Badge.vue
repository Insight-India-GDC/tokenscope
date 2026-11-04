<script setup lang="ts">
/*
 * UiBadge — small label/chip.
 *
 * Kinds map to the tokenised badge styles in styles.css. RAG kinds
 * (rag-green / rag-amber / rag-red) carry their own non-brand palette
 * to keep status reading unambiguous.
 */

withDefaults(
  defineProps<{
    kind?:
      | 'neutral'
      | 'harmony'
      | 'vision'
      | 'zeal'
      | 'hunger'
      | 'rag-green'
      | 'rag-amber'
      | 'rag-red'
      | 'outline'
    dot?: 'green' | 'amber' | 'red' | 'vision' | 'zeal' | 'cloud'
  }>(),
  { kind: 'neutral', dot: undefined },
)
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-bold leading-4 tracking-[0.2px] whitespace-nowrap"
    :class="[
      kind === 'neutral' && 'bg-calm-2 text-carbon-2',
      kind === 'harmony' && 'bg-brand-harmony-lite text-brand-harmony',
      kind === 'vision' && 'bg-brand-vision-lite text-brand-vision-ink',
      kind === 'zeal' && 'bg-brand-zeal-lite text-brand-zeal-ink',
      kind === 'hunger' && 'bg-brand-hunger-lite text-brand-heart',
      kind === 'rag-green' && 'bg-[#DCFCE7] text-[#166534]',
      kind === 'rag-amber' && 'bg-[#FEF3C7] text-[#92400E]',
      kind === 'rag-red' && 'bg-[#FEE2E2] text-[#991B1B]',
      kind === 'outline' && 'bg-transparent border border-calm text-carbon-2',
    ]"
  >
    <span
      v-if="dot"
      class="inline-block w-2 h-2 rounded-full shrink-0"
      :class="[
        dot === 'green' && 'bg-rag-green',
        dot === 'amber' && 'bg-rag-amber',
        dot === 'red' && 'bg-rag-red',
        dot === 'vision' && 'bg-brand-vision',
        dot === 'zeal' && 'bg-brand-zeal',
        dot === 'cloud' && 'bg-cloud',
      ]"
      aria-hidden="true"
    />
    <slot />
  </span>
</template>
