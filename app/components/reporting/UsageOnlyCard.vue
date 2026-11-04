<script setup lang="ts">
/*
 * UsageOnlyCard — the DELIBERATE "usage-only" placeholder shown in CHARGEBACK mode
 * wherever a card is inherently §A (daily trend, seasonality, provider/model split,
 * drivers, concentration): metrics that have NO §B analogue (the bill lane is
 * month-grained, has no tokens / models / per-day / per-user grain). Rather than
 * DROP the card (which would shift the layout), we swap it for this quiet, muted
 * placeholder so the page stays stable and the emptiness reads as INTENTIONAL, not
 * broken — a subtle diagonal hatch + carbon-3 ink + a "switch to Usage" line.
 *
 * A consistent treatment across every §A-only surface (the §A/§B re-lens contract).
 */
defineProps<{
  /** The name of the card this stands in for (echoed so the reader keeps their place). */
  title: string
  /** Optional minimum height so tall charts don't collapse the layout when swapped. */
  minHeight?: number
}>()
</script>

<template>
  <div
    class="usage-only relative rounded-xl border border-dashed border-calm-2 bg-white/60 px-5 py-6 flex flex-col items-center justify-center text-center gap-1.5"
    :style="minHeight ? { minHeight: `${minHeight}px` } : undefined"
    data-testid="usage-only-card"
    :data-usage-only-title="title"
  >
    <div class="text-[11px] font-bold uppercase tracking-[1.1px] text-carbon-3">{{ title }}</div>
    <p class="text-[12px] text-carbon-3 max-w-[24rem]">
      This view is usage-only — switch to <span class="font-semibold">Usage</span> to see it.
    </p>
    <p class="text-[11px] text-carbon-3">The chargeback lens has no daily, token or model breakdown.</p>
  </div>
</template>

<style scoped>
/* A quiet diagonal hatch so the placeholder reads as a deliberate "not applicable"
   surface (muted, low-contrast) rather than an empty/broken card. */
.usage-only {
  background-image: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--carbon-3, #8a7d76) 6%, transparent) 0,
    color-mix(in srgb, var(--carbon-3, #8a7d76) 6%, transparent) 1px,
    transparent 1px,
    transparent 9px
  );
}
</style>
