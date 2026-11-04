<script setup lang="ts">
/*
 * DrawerBodyVelocity — body content for a velocity-warning inbox item.
 *
 * Per design-notes §Screen 7: small spark chart + suggested action.
 * Spark is an inline-SVG sparkline from `body.weeklySeries` (array of
 * numbers — recent weekly spends; last entry is current week).
 *
 * Body payload fields read (all optional):
 *   - weeklySeries : number[]
 *   - meanUsd      : number    (rolling 4w mean)
 *   - currentUsd   : number    (this week's spend)
 *   - deltaPct     : number    (e.g. 0.38 for +38%)
 */

const props = defineProps<{
  body: Record<string, unknown>
}>()

function series(): number[] | null {
  const v = props.body.weeklySeries
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) {
    return v as number[]
  }
  return null
}

function num(k: string): number | null {
  const v = props.body[k]
  return typeof v === 'number' ? v : null
}

const points = series()
const maxV = points ? Math.max(...points, 1) : 1
const W = 200
const H = 60
const spark =
  points === null
    ? ''
    : points
        .map((p, i) => {
          const x = (i / Math.max(1, points.length - 1)) * W
          const y = H - (p / maxV) * (H - 4) - 2
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')

const currentUsd = num('currentUsd')
const deltaPct = num('deltaPct')
// Stroke colour follows severity — Hunger only when the trend actually
// crosses the velocity-worker's 25% threshold; Vision otherwise.
const strokeColor =
  deltaPct !== null && deltaPct >= 0.25 ? 'var(--brand-hunger)' : 'var(--brand-vision)'
</script>

<template>
  <section class="space-y-5">
    <div v-if="points">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Spend trend ({{ points.length }} weeks)
      </div>
      <svg :width="W" :height="H" viewBox="0 0 200 60" aria-hidden="true">
        <path
          :d="spark"
          fill="none"
          :stroke="strokeColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <div class="text-xs text-carbon-2 mt-2 flex justify-between">
        <span v-if="currentUsd !== null" style="font-variant-numeric: tabular-nums">
          ${{ currentUsd.toFixed(2) }} this week
        </span>
        <span
          v-if="deltaPct !== null"
          class="font-bold"
          :class="deltaPct >= 0.25 ? 'text-brand-hunger' : 'text-brand-vision-ink'"
        >
          {{ deltaPct >= 0 ? '+' : '' }}{{ Math.round(deltaPct * 100) }}% vs typical
        </span>
      </div>
    </div>
    <div v-else class="text-xs text-carbon-3 italic">
      Trend data not included in this alert; check the rollup view for the underlying series.
    </div>
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Suggested action
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed">
        Take a look at what changed this week. Often a new long-running task or a
        switch to a heavier model explains it; if it's expected, acknowledge to
        clear the bell.
      </p>
    </div>
  </section>
</template>
