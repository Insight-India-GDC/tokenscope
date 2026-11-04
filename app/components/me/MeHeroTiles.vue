<script setup lang="ts">
/*
 * MeHeroTiles — the /usage hero: four ScopeKpiTile's on the me grid
 * (developer-pages W2 D17; prototype :447-470). NOT ScopeHero: its prop is a
 * reports-shaped structural type, and forcing /me/usage into it would couple
 * the self page to the reports payload. The reuse target is one level down —
 * the tile itself, with its own delta/spark/deltaEmpty affordances.
 *
 * The spark's frame is the WHOLE MONTH and has no floor (F2/D7). This file used
 * to record the fork the other way — "incl. the component's SPARK_MIN_DAYS = 7
 * gate; the prototype's `< 3` spark gate is illustrative and deliberately not
 * forked" — and that knowing deviation is what blanked every hero here for the
 * first six days of every month. Both floors are retired; `spark_span` comes off
 * the server's own window echo, never a browser clock.
 *
 * Usage lane:      Attributed (lead) · Budgeted share · Quota pace · Active days
 * Chargeback lane: Chargeable (lead) · Attributed · Quota "—" (stated reason)
 *                  · Active days
 *
 * Copy lives HERE (operands arrive from the server): a money delta keeps the
 * percentage, a count delta is absolute (ScopeHero.vue:147-164 convention);
 * a withheld delta names its reason (`delta_empty_reason` — the two ScopeHero
 * reasons, never a silent gap). The quota tile consumes the SAME headline
 * operands the server built under the lane (ADR 0012 decision 4): its value,
 * sub and warning all derive from `runRate` + `quota`, so the tile can never
 * sit a lane ahead of the figures beside it.
 */
import { computed } from 'vue'
import ScopeKpiTile from '../reporting/ScopeKpiTile.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { RunRate } from '#shared/schemas/usage'
import type { SpendLens } from '#shared/usage/lens'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

/** One wire tile — the `/me/usage` `hero.tiles[]` shape (W2 D17). */
export interface MeHeroTileWire {
  key: 'attributed' | 'chargeable' | 'budgeted' | 'quota' | 'active_days'
  value_usd?: string
  count?: number
  delta_pct?: number | null
  delta_abs?: number | null
  delta_empty_reason?: string | null
  spark?: number[]
  budgeted_share_pct?: number | null
  no_budget_usd?: string
  untagged_usd?: string
  days_so_far?: number
  quota_basis?: 'window-month' | 'not-current-month' | 'custom-range'
}

/** The `/me/usage` `hero.window` echo (resolved month XOR custom range). */
export interface MeHeroWindowWire {
  from: string
  to: string
  is_month: boolean
  month: string | null
  days_elapsed: number | null
  days_in_month: number | null
  /**
   * Does the sparks' last point fall on a still-filling day? Server-stated: the
   * axis runs to `min(to, today)`, and nothing else on this echo can tell a
   * finished month from the current month's last day (external review r2).
   * Absent (an older payload) ⇒ no claim, and the spark draws no endpoint mark.
   */
  spark_partial?: boolean
}

export interface MeHeroQuota {
  total_usd: string
  base_allowance_usd: string
  allocation_usd: string
  projection:
    | { state: 'no-quota' }
    | { state: 'no-spend' }
    | { state: 'exhausted'; over_usd: string }
    | { state: 'projected'; date: string }
    | { state: 'not-at-this-pace' }
}

const props = defineProps<{
  tiles: MeHeroTileWire[]
  window: MeHeroWindowWire | null
  /** The RESOLVED lane (headline.lane) — never the URL ref mid-switch. */
  lane: SpendLens
  /** headline.quota — the quota tile's operands (null under chargeback). */
  quota: MeHeroQuota | null
  /** headline.run_rate — the quota-pace value's operand. */
  runRate: RunRate | null
  /** headline.mtd_usd — the "so far" fallback when no projection today. */
  mtdUsd: string | null
}>()

const DELTA_BASIS = 'vs last month'

function trendOf(v: number | null | undefined): 'up' | 'down' | 'flat' {
  if (v == null || v === 0) return 'flat'
  return v > 0 ? 'up' : 'down'
}

interface TileView {
  key: string
  label: string
  value: string
  sub?: string
  lead?: boolean
  noDelta?: boolean
  deltaLabel?: string
  deltaTrend?: 'up' | 'down' | 'flat'
  deltaEmpty?: string
  spark?: number[]
}

const chargebackSuffix = computed(() => (props.lane === 'chargeback' ? ' — attributed usage in both lenses' : ''))

/**
 * The spark's frame: the whole month, from the SERVER's window echo (F2/D7,
 * F1/D1). A custom range has no month ahead to draw, so it gets no dots.
 */
const sparkSpan = computed(() =>
  props.window?.is_month ? (props.window.days_in_month ?? undefined) : undefined,
)

/**
 * Whether the sparks' last point is still filling — the SERVER's statement, not
 * an inference from the frame. MonthSpark used to derive it from `span >
 * data.length`, which cannot distinguish a series that stopped at the settled
 * edge from one that runs to today; here the two are the SAME length for a past
 * month and the current month's last day. Absent ⇒ undefined ⇒ no endpoint mark
 * and no claim (external review r2).
 */
const sparkPartial = computed(() => props.window?.spark_partial)

/**
 * The quota tile's stated-reason copy per basis — a `deltaEmpty`-STYLE reason
 * in the tile's own affordance, never a silently empty tile (D17/T15). The
 * chargeback wording keeps the page's established `quota-not-in-lane` claim.
 */
const quotaView = computed<TileView & { warn?: { kind: 'exhausted' | 'projected'; text: string } }>(() => {
  const base: TileView = { key: 'quota', label: 'Quota pace', value: '—' }
  const wire = props.tiles.find((t) => t.key === 'quota')
  if (props.lane === 'chargeback') {
    return {
      ...base,
      label: 'Quota',
      deltaEmpty:
        'your quota — allowance + allocations — measures attributed usage, so it is not shown in the chargeback lens. Switch to Usage to see it.',
    }
  }
  if (wire?.quota_basis === 'custom-range') {
    return {
      ...base,
      deltaEmpty: 'your quota is a calendar-month measure — shown under a month window, not a custom range',
    }
  }
  if (wire?.quota_basis === 'not-current-month') {
    return {
      ...base,
      deltaEmpty: 'your quota measures the current month — switch to This month to see it',
    }
  }
  const q = props.quota
  const rr = props.runRate
  if (!q || !rr) return { ...base, deltaEmpty: 'no quota to measure against' }
  const value = rr.is_projection
    ? `~${fmtUsd(rr.projected_month_end_usd)}`
    : `${fmtUsd(props.mtdUsd ?? '0')}`
  const sub = rr.is_projection
    ? `of your ${fmtUsd(q.total_usd)} quota — ${fmtUsd(q.base_allowance_usd)} allowance + ${fmtUsd(q.allocation_usd)} project allocations · linear run-rate, day ${rr.days_elapsed} of ${rr.days_in_month}`
    : `so far, of your ${fmtUsd(q.total_usd)} quota — ${fmtUsd(q.base_allowance_usd)} allowance + ${fmtUsd(q.allocation_usd)} project allocations · day ${rr.days_elapsed} of ${rr.days_in_month}`
  const p = q.projection
  const warn =
    p.state === 'exhausted'
      ? {
          kind: 'exhausted' as const,
          text: `⚠ your quota is exhausted — ${fmtUsd(p.over_usd)} over ${fmtUsd(q.total_usd)}.`,
        }
      : p.state === 'projected'
        ? { kind: 'projected' as const, text: `⚠ on pace to exhaust your quota ~${p.date}` }
        : undefined
  return { ...base, value, sub, warn, noDelta: true }
})

const views = computed<Array<TileView & { warn?: { kind: string; text: string } }>>(() =>
  props.tiles.map((t) => {
    const moneyDelta = (): Pick<TileView, 'deltaLabel' | 'deltaTrend' | 'deltaEmpty'> =>
      t.delta_pct != null
        ? { deltaLabel: fmtPct(Math.abs(t.delta_pct)), deltaTrend: trendOf(t.delta_pct) }
        : { deltaEmpty: t.delta_empty_reason ?? undefined }
    switch (t.key) {
      case 'attributed':
        return {
          key: t.key,
          label: 'Attributed usage',
          value: fmtUsd(t.value_usd ?? '0'),
          sub: `every provider, tagged or not${chargebackSuffix.value}`,
          lead: props.lane === 'usage',
          spark: t.spark,
          ...moneyDelta(),
        }
      case 'chargeable':
        return {
          key: t.key,
          label: 'Chargeable',
          value: fmtUsd(t.value_usd ?? '0'),
          sub: `reaches a ${BU_LABEL_LOWER} · not an invoice`,
          lead: true,
          spark: t.spark,
          ...moneyDelta(),
        }
      case 'budgeted': {
        const share = t.budgeted_share_pct != null ? `${fmtPct(t.budgeted_share_pct)} on budgeted projects` : 'no attributed spend yet'
        return {
          key: t.key,
          label: 'Budgeted share',
          value: fmtUsd(t.value_usd ?? '0'),
          sub: `${share} · ${fmtUsd(t.no_budget_usd ?? '0')} no budget · ${fmtUsd(t.untagged_usd ?? '0')} untagged`,
          spark: t.spark,
          ...moneyDelta(),
        }
      }
      case 'active_days': {
        // A COUNT delta is absolute; a flat month says so in words (fix 2).
        const delta =
          t.delta_abs != null
            ? {
                deltaLabel: t.delta_abs === 0 ? 'no change' : String(Math.abs(t.delta_abs)),
                deltaTrend: trendOf(t.delta_abs),
              }
            : { deltaEmpty: t.delta_empty_reason ?? undefined }
        return {
          key: t.key,
          label: 'Active days',
          value: String(t.count ?? 0),
          sub: `of ${t.days_so_far ?? 0} so far${chargebackSuffix.value}`,
          spark: t.spark,
          ...delta,
        }
      }
      case 'quota':
        return quotaView.value
      default:
        return { key: t.key, label: t.key, value: '—', noDelta: true }
    }
  }),
)
</script>

<template>
  <div class="kpi-row" data-testid="me-hero-tiles">
    <div v-for="v in views" :key="v.key" :data-testid="`me-tile-${v.key}`" class="min-w-0">
      <ScopeKpiTile
        :label="v.label"
        :value="v.value"
        :sub="v.sub"
        :spark="v.spark"
        :spark-span="sparkSpan"
        :spark-partial="sparkPartial"
        :delta-label="v.noDelta ? undefined : v.deltaLabel"
        :delta-basis="v.deltaLabel ? DELTA_BASIS : undefined"
        :delta-trend="v.deltaTrend"
        :delta-empty="v.noDelta ? undefined : v.deltaEmpty"
        :emphasis="v.lead"
        class="h-full"
      >
        <template v-if="v.warn" #footer>
          <p
            v-if="v.warn.kind === 'exhausted'"
            class="text-[11px] text-rag-red font-semibold"
            data-testid="quota-exhausted"
          >{{ v.warn.text }}</p>
          <p
            v-else
            class="text-[11px] text-rag-amber font-semibold"
            data-testid="quota-exhaustion"
          >{{ v.warn.text }}</p>
        </template>
      </ScopeKpiTile>
    </div>
  </div>
</template>
