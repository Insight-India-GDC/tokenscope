<script setup lang="ts">
/*
 * HomeOtherSurfacesPanel — "Other Claude surfaces" (#142, §B display-only).
 *
 * The developer's month-to-date spend on the NON-CODE Claude surfaces (Chat /
 * Cowork / Office agents / Chrome / Design / Slack / other) from the provider
 * bill (`actual_spend`; bill == usage on the pure-metered Anthropic lane).
 * These lanes have no OTel, no sessions, and are NEVER project-taggable — so
 * this panel is deliberately read-only and visually separate from the taggable
 * sessions/worklist area: no Tag button, no needs-tagging affordance, a muted
 * "informational chargeback" tone. Per-surface colours are the FIXED vendor
 * lane colours (useChartScale.vendorLaneColor — identity never colour-alone:
 * every row carries its label + exact $).
 *
 * The sparkline is a single-series magnitude mini-bar per surface (its own
 * scale), padded from the 1st of the month; each bar has a title tooltip.
 *
 * MULTI-LANE mode (lane-visuals V5, r1-F8): when the month is GENUINELY
 * multi-surface — ≥ 2 lanes each holding ≥ 5% of the period total — the
 * per-surface mini-bars give way to ONE compact stacked per-day bar (shared
 * scale, per-day tooltip itemisation) and each row shows its share-of-total.
 * Below the threshold the panel keeps the existing per-surface rows UNCHANGED
 * (a single dominant surface needs no stack). Read-only affordances unchanged
 * either way: no Tag button, nothing taggable.
 */
import { computed } from 'vue'
import { vendorLaneColor } from '../../composables/useChartScale'
import { fmtUsd, fmtSharePct } from '../../composables/useFormat'
import type { Vendor } from '#shared/usage/vendor'

export interface SurfaceRow {
  tool: string
  label: string
  mtd_usd: string
  days: { day: string; usd: string }[]
}

const props = defineProps<{
  surfaces: SurfaceRow[]
  /** 'YYYY-MM' from /me/usage — the month the day axis pads over. */
  monthToDate: string
}>()

const totalUsd = computed(() => props.surfaces.reduce((a, s) => a + Number(s.mtd_usd), 0))

// ── Multi-lane threshold (lane-visuals V5, r1-F8) ─────────────────────────────
// The stacked view earns its ink only when the period is GENUINELY
// multi-surface: at least MIN_LANES lanes each holding ≥ MIN_SHARE of the
// period total. One dominant surface + noise reads better as the plain rows —
// a stack whose second segment is a sliver is chartjunk. ACCEPTED RESIDUAL
// (r2-4, LOW, named): the threshold has NO hysteresis — the card's mode can
// differ across period navigation (a month at 5.1% stacks, its neighbour at
// 4.9% doesn't); it cannot flip live within a rendered period, because the
// operand is the period total of an already-fetched month.
const MULTI_LANE_MIN_LANES = 2
const MULTI_LANE_MIN_SHARE = 0.05

const shareOf = (s: SurfaceRow): number =>
  totalUsd.value > 0 ? Number(s.mtd_usd) / totalUsd.value : 0

const multiLane = computed(
  () => props.surfaces.filter((s) => shareOf(s) >= MULTI_LANE_MIN_SHARE).length >= MULTI_LANE_MIN_LANES,
)

/** The month's day keys, 1st → today (UTC); a past month pads to its end. */
const dayAxis = computed<string[]>(() => {
  const [yStr, mStr] = props.monthToDate.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  if (!y || !m) return []
  const now = new Date()
  const isCurrent = now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m
  const lastDay = isCurrent ? now.getUTCDate() : new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Array.from({ length: lastDay }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1, i + 1))
    return d.toISOString().slice(0, 10)
  })
})

interface Spark {
  day: string
  usd: number
  /** 0..1 of the surface's own max day. */
  h: number
}

// NOTE (#142 review finding 10): the "N days active" label counts API rows
// (days the surface actually billed), while the bars pad the full
// month-to-date axis — a billed-at-$0.00 day and a never-billed day both
// render as the 2px baseline, so "active" and "visibly lit" are deliberately
// NOT required to match; the per-bar tooltip carries the exact per-day $.
function sparkOf(s: SurfaceRow): Spark[] {
  const byDay = new Map(s.days.map((d) => [d.day, Number(d.usd)]))
  const max = Math.max(...s.days.map((d) => Number(d.usd)), 0)
  return dayAxis.value.map((day) => {
    const usd = byDay.get(day) ?? 0
    return { day, usd, h: max > 0 ? usd / max : 0 }
  })
}

function laneColor(tool: string): string {
  return vendorLaneColor(tool as Vendor)
}

// ── Stacked per-day bars (multi-lane mode) ────────────────────────────────────
// ONE compact stacked bar per day over the SAME padded month axis, every
// surface a segment (fixed lane colour), shared $ scale across days. Identity
// is never colour-alone: the per-day tooltip itemises each surface's $, and the
// rows below carry swatch + label + share + exact $.
interface StackedDay {
  day: string
  totalUsd: number
  /** 0..1 of the busiest day (shared scale). */
  h: number
  segments: { tool: string; label: string; usd: number }[]
}

const stackedDays = computed<StackedDay[]>(() => {
  const bySurface = props.surfaces.map((s) => ({
    tool: s.tool,
    label: s.label,
    byDay: new Map(s.days.map((d) => [d.day, Number(d.usd)])),
  }))
  const days = dayAxis.value.map((day) => {
    const segments = bySurface
      .map((s) => ({ tool: s.tool, label: s.label, usd: s.byDay.get(day) ?? 0 }))
      .filter((seg) => seg.usd > 0)
    return { day, totalUsd: segments.reduce((a, seg) => a + seg.usd, 0), segments }
  })
  const max = Math.max(...days.map((d) => d.totalUsd), 0)
  return days.map((d) => ({ ...d, h: max > 0 ? d.totalUsd / max : 0 }))
})

function stackTitle(d: StackedDay): string {
  if (d.totalUsd <= 0) return `${d.day} — ${fmtUsd(0)}`
  return `${d.day} — ${fmtUsd(d.totalUsd)} · ${d.segments.map((s) => `${s.label} ${fmtUsd(s.usd)}`).join(' · ')}`
}
</script>

<template>
  <UiCard v-if="surfaces.length" flush data-testid="other-surfaces-panel" class="mt-6">
    <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-end justify-between gap-4">
      <div>
        <div class="text-lg font-bold text-carbon">Other Claude surfaces</div>
        <div class="text-xs text-carbon-3 mt-1">
          Billed to your Business Unit · not project-taggable
        </div>
      </div>
      <span
        class="text-lg font-bold text-carbon shrink-0"
        style="font-variant-numeric: tabular-nums"
        data-testid="other-surfaces-total"
      >{{ fmtUsd(totalUsd) }}</span>
    </div>

    <!-- Multi-lane mode (V5, r1-F8): ONE compact stacked per-day bar for the whole
         panel — every surface a segment on a SHARED $ scale (the per-surface
         mini-bars each ride their own scale, so they cannot be compared; the
         stack can). The per-day tooltip itemises each surface's $. -->
    <div
      v-if="multiLane"
      class="px-6 pt-5 pb-1"
      data-testid="other-surfaces-stack"
    >
      <div
        class="flex items-end gap-[2px] h-16"
        role="img"
        aria-label="Daily spend across Claude surfaces this month, stacked by surface"
      >
        <div
          v-for="d in stackedDays"
          :key="d.day"
          class="flex-1 min-w-[2px] max-w-[12px] h-full flex flex-col justify-end"
          :title="stackTitle(d)"
        >
          <div
            v-if="d.totalUsd > 0"
            class="w-full flex flex-col justify-end rounded-t-[2px] overflow-hidden"
            :style="{ height: `${Math.max(8, d.h * 100)}%` }"
          >
            <div
              v-for="seg in d.segments"
              :key="seg.tool"
              class="w-full"
              :style="{ height: `${(seg.usd / d.totalUsd) * 100}%`, background: laneColor(seg.tool) }"
            />
          </div>
          <div v-else class="w-full rounded-t-[2px]" style="height: 2px; background: var(--calm)" />
        </div>
      </div>
    </div>

    <ul class="divide-y divide-calm-2">
      <li
        v-for="s in surfaces"
        :key="s.tool"
        class="px-6 py-3.5 flex items-center gap-4"
        :data-testid="`surface-${s.tool}`"
      >
        <span
          class="inline-block w-2 h-2 rounded-sm shrink-0"
          :style="{ background: laneColor(s.tool) }"
          aria-hidden="true"
        />
        <div class="min-w-0 w-44 shrink-0">
          <div class="text-sm font-semibold text-carbon truncate">{{ s.label }}</div>
          <div class="text-[11px] text-carbon-3 mt-0.5">
            {{ s.days.length }} {{ s.days.length === 1 ? 'day' : 'days' }} active
          </div>
        </div>
        <!-- Multi-lane mode: the stack above carries the temporal shape, so the row
             shows its share of the period total instead of a second (own-scale) spark. -->
        <div
          v-if="multiLane"
          class="flex-1 min-w-0 text-right text-[12px] text-carbon-3 tabular-nums"
          :data-testid="`surface-${s.tool}-share`"
        >{{ fmtSharePct(shareOf(s)) }} of surfaces</div>
        <!-- Single-dominant mode (below the r1-F8 threshold): the existing per-day
             mini-bars, UNCHANGED (single-series magnitude, the surface's own scale). -->
        <div
          v-else
          class="flex-1 flex items-end gap-[2px] h-6 min-w-0"
          role="img"
          :aria-label="`${s.label} daily spend this month`"
        >
          <div
            v-for="b in sparkOf(s)"
            :key="b.day"
            class="flex-1 min-w-[2px] max-w-[10px] rounded-t-[2px]"
            :style="{
              height: b.usd > 0 ? `${Math.max(8, b.h * 100)}%` : '2px',
              background: b.usd > 0 ? laneColor(s.tool) : 'var(--calm)',
            }"
            :title="`${b.day} — ${fmtUsd(b.usd)}`"
          />
        </div>
        <span
          class="text-sm font-bold text-carbon shrink-0"
          style="font-variant-numeric: tabular-nums"
          :data-testid="`surface-${s.tool}-mtd`"
        >{{ fmtUsd(s.mtd_usd) }}</span>
      </li>
    </ul>

    <div class="px-6 py-3 border-t border-calm-2 text-[11px] text-carbon-3 italic">
      Informational — these surfaces don't emit sessions, so there's nothing to tag. Spend is
      charged back to your Business Unit from the provider bill.
    </div>
  </UiCard>
</template>
