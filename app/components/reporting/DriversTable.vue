<script setup lang="ts">
/*
 * DriversTable — the ranked driver breakdown with a visible sum-back check.
 *
 * build-design §3/§5 + owner-decisions D-Q6:
 *  - `update:axis` re-pivots the breakdown (practice / teammate / model / …).
 *  - `drill` fires when a row is activated (accessible <button> per row).
 *  - A sum-back CHECK ROW compares Σ(rows) to `headlineUsd` and goes RED on any
 *    mismatch — drivers must reconcile to the headline in the same lane.
 *  - ANY `spendClass:'pooled-usage'` row FORCES the footer
 *    "per-seat share is informational — billing is pooled" (Copilot per-seat
 *    share is never a charge). `pooled-usage` and `estimated` rows render muted
 *    so they never read like a hard dollar — this is also the Overage-Drivers
 *    presentation (a proportional INDICATIVE share, never a charge; D-Q6
 *    layer 3). `indicative` is NOT muted per row; see "one caveat, once" below.
 *    `billed` rows are the EXCEPTION and render as a hard dollar, because they
 *    ARE one: the provider's own money off the billed lane
 *    (`provider_usage_fact`). Muting them would state the opposite of the truth.
 *  - BILLED LANE (`billedLane` prop): a billed axis answers a narrower question
 *    than the attributed axes beside it, so the table says how complete that lane
 *    is instead of letting a smaller headline pass unexplained, and an empty
 *    billed lane reads as "not derived yet" rather than "$0 spent". Its
 *    CONSUMPTION arms (Copilot) render in their OWN block, below the billed
 *    total and never inside it — `provider_usage_fact.cost_usd` is billed money
 *    on an Anthropic row and gross credits on a GitHub one (mig 0120), and the
 *    one thing this table must never do is add them.
 *  - SURFACE MIX (requirement 3): when a row carries `surfaceBreakdown` (the
 *    teammate axis today), an extra column renders a per-lane stacked
 *    indicator — same visual pattern as FinanceCouTable's "Surface mix"
 *    column: FIXED per-lane colours (`vendorLaneColor` — never invented),
 *    per-segment tooltips, and the page's usual `LaneLegend` above the table
 *    (identity is never colour-alone). A row without a breakdown (e.g. the
 *    project axis's folded "(all other — N projects)" tail) renders a muted
 *    placeholder. Segment
 *    Σ === the row's own Spend column exactly (server-guaranteed sum-back).
 *  - USAGE PROVENANCE (requirement 4): a row carrying `provenanceBreakdown`
 *    gets a native tooltip on its driver label naming its otel-emitted /
 *    api-reconciled / provider-usage mix — a "blended row" (e.g. a teammate
 *    with both OTel Claude Code AND ingest-only Claude Chat usage) states the
 *    split rather than silently averaging it away.
 *  - AGAINST BUDGET (04-prototype-delta.md §5b): a row carrying `budgetUsd`
 *    renders CONSUMPTION — "87% of $6,024" — instead of a bare share. A project
 *    owner cannot act on "3% of the company", and that figure only shrinks as
 *    the estate grows; consumption against their own budget is the question they
 *    hold. THREE states: a number is an allocation to consume; `budgetUsd: null`
 *    renders "no budget set" (a missing decision, never 0%); the field being
 *    ABSENT renders as not-applicable, because that row has nothing a budget
 *    could be set on (the untagged bucket, the folded multi-project remainder).
 *  - THE SECOND OPERAND (F5 D25): a row carrying `scopeShareUsd` states how
 *    much of its own total the READING SCOPE carries, as a sub-line under the
 *    value. The cost-centre project axis is the case: `usd` is the project's
 *    total across every centre whose people worked on it — the right operand
 *    against its budget, and the wrong one for "what did MY centre spend". Both
 *    questions are legitimate, so the row answers both instead of the axis
 *    picking one (03-snag-plan §8c). ABSENT means the two are the same number
 *    by construction; this component never synthesises one.
 *  - MODEL TIER (04-prototype-delta.md §5): a row carrying `tierBreakdown`
 *    renders a per-band stacked indicator — the SAME visual pattern as the
 *    surface mix above, with fixed per-band colours (`modelTierColor`). The
 *    BANDING is `fetchTierExposure`'s, never this component's; absence of the
 *    field means "not available", never "no frontier usage", so the column is
 *    absent entirely rather than rendering an empty bar.
 *
 * ── EVERY COLUMN IS NAMED (prototype `note('fix 4', …)`) ─────────────────────
 * "Two bars on one row read as two data series unless the columns are named.
 * They were not, and the second one was unreadable." So the header row names all
 * of them: the AXIS's own word (never a generic "Driver" when the table knows
 * which axis it is showing), each mix column, `share of spend` over the
 * magnitude bar, the caller's word for the value column, and one right-hand
 * column — `Against budget` where the rows carry one, `%` otherwise.
 *
 * The magnitude bar lives IN the row, scaled against the LARGEST row rather than
 * the headline, so a small row is still visible. Its ARIA label states the row's
 * true share of the denominator rather than its bar width — the scaling is a
 * legibility choice, and announcing it would be announcing the wrong number.
 *
 * A caller that renders it is a caller that no longer needs a separate ranked
 * chart above the table; the whole-company Top-drivers card dropped one on that
 * basis (two renderings of one ranking is the divergence `note('fix 4a', …)` is
 * about, one card smaller). Whether any OTHER caller still has one is that
 * caller's business, not a claim this component may make.
 *
 * ── ONE CAVEAT, ONCE (prototype `note('fix 4', …)`) ─────────────────────────
 * "If a figure needs a caveat on every row, the caveat belongs in the card,
 * once." `indicative` was on every row of every attributed table, so it is now a
 * single statement above the table and carries no per-row badge and no muting.
 * `pooled-usage` and `estimated` KEEP theirs: those appear BESIDE rows of a
 * different class in one table, so the marking is per-row information rather
 * than a repeated card-level fact.
 *
 * NO SELECTOR IS ALSO A SHAPE: `axisOptions` may be empty, and then no pivot
 * control renders. The cost-centre heroes use that — their owner has exactly two
 * questions and sees both at once instead of toggling.
 */
import { computed } from 'vue'
import UiBadge from '../ui/Badge.vue'
import LaneLegend from './LaneLegend.vue'
import BudgetStateCell from './BudgetStateCell.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import { vendorLaneColor, modelTierColor } from '../../composables/useChartScale'
import { VENDOR_LANES, type Vendor } from '#shared/usage/vendor'
import {
  MODEL_TIER_BANDS,
  type BilledLaneMeta,
  type ChargebackCoverage,
  type DriverRow,
  type DriverSurfaceAmount,
  type DriverTierAmount,
  type ModelTierBand,
  type SpendClass,
} from '#shared/reports/types'
import { consumptionNote } from '#shared/reports/provider-measure'
import type { DrillTarget } from './drill-contract'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

export interface AxisOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    rows: DriverRow[]
    /** The lane headline the rows must sum back to. */
    headlineUsd: number
    /**
     * What `headlineUsd` IS, in the reader's words. Defaults to `'headline'`,
     * which is right wherever the rows sum back to the figure at the top of the
     * page — every scope's People/drivers list.
     *
     * It is WRONG on the cost-centre Budgets list, and visibly so: those rows
     * carry each project's OWN total across all cost centres (deliberately —
     * `cost-centres.ts` D25, "the wrong answer to what did my centre spend on
     * it"), so the footer read "reconciles to headline $1,726.20 / $1,726.20"
     * beside a page headline of $302.82, and the People list two columns over
     * read "reconciles to headline $302.82 / $302.82". Same sentence, two
     * referents, one screen. The sum-back is arithmetically right in both; only
     * the noun was borrowed.
     */
    sumbackLabel?: string
    /** Currently selected axis (v-model of `update:axis`). Unused with no options. */
    axis?: string
    /** EMPTY = this table does not pivot, and renders no selector at all. */
    axisOptions?: AxisOption[]
    /** e.g. "region usage" — rendered as "share of {denominatorLabel}". */
    denominatorLabel: string
    /**
     * The word over the VALUE column. Defaults to `'Spend'`; a caller that knows
     * the period its rows cover passes that word instead. A prop rather than a
     * constant because this table renders over four surfaces and several windows
     * (a month, a custom range, a rolling window) and only the caller knows which
     * — the prototype's "this month" copied down here would be a false claim over
     * every range that is not one.
     */
    valueColumnLabel?: string
    /**
     * The word over the LABEL column when there is no axis to name it — the
     * heroes, which show one fixed axis each. When `axisOptions` carries the
     * active `axis`, that option's own label wins, so the column and the chip a
     * reader just pressed always say the same word.
     */
    labelColumnLabel?: string
    /** Extra footer copy (a pooled-usage row overrides this with the forced copy). */
    pooledFooter?: string
    /**
     * Set when these rows come from the BILLED lane. Carries how complete that
     * lane is for this scope + window and the per-provider arms behind it.
     * Absent on every attributed axis — including the BUDGET axis in the
     * chargeback lane, which is attributed by construction.
     */
    billedLane?: BilledLaneMeta
    /**
     * WHOSE charge this table's figures are, in the chargeback lane. Its `gaps`
     * render as an explicit UNAVAILABLE-FOR-THIS-LANE state above the table.
     *
     * Absent in the usage lane, where the question does not arise. Present and
     * gap-free is a CLAIM — "every provider that bills this scope is in these
     * figures" — which is why the empty case is still passed rather than the prop
     * being dropped.
     */
    chargebackCoverage?: ChargebackCoverage
    /*
     * THE DRILL CONTRACT (developer pages build D29, fix 7). Returns the target
     * a row opens onto, or `null` for a row that opens onto nothing.
     *
     * The DEFAULT is `null` for every row, and that default is the fix. Every
     * row used to render a <button> emitting `drill`, on every axis of every
     * scope — while exactly ONE caller (the regional practice axis) acted on it.
     * Every other row was a live-looking dead button: hover underline, pointer
     * cursor, button semantics announced to a screen reader, and nothing behind
     * it. Now a row is a LINK, an ACTION, or PLAIN TEXT, and the caller says
     * which by GRANT — through `drill-contract.ts`, never per-view logic.
     *
     * A row that cannot name a target id (`__null_*` keys, the folded
     * remainder, the untagged bucket) is plain text BY CONSTRUCTION: the
     * decision function has no id to build a route from.
     */
    drillable?: (row: DriverRow) => DrillTarget | null
  }>(),
  {
    pooledFooter: undefined,
    sumbackLabel: 'headline',
    axis: '',
    axisOptions: () => [],
    valueColumnLabel: 'Spend',
    labelColumnLabel: 'Driver',
    billedLane: undefined,
    chargebackCoverage: undefined,
    drillable: undefined,
  },
)

const emit = defineEmits<{
  (e: 'update:axis', value: string): void
  /** Fired ONLY for a row whose `drillable` target is an in-page `action`. */
  (e: 'drill', row: DriverRow): void
}>()

/** The row's target, or null. Absent prop ⇒ nothing is a door (fail-closed). */
function targetFor(r: DriverRow): DrillTarget | null {
  return props.drillable ? props.drillable(r) : null
}

const POOLED_FOOTER = 'per-seat share is informational — billing is pooled'

const sum = computed(() => props.rows.reduce((a, r) => a + r.usd, 0))
// Sub-cent tolerance absorbs float noise; anything larger is a real mismatch.
const mismatch = computed(() => Math.abs(sum.value - props.headlineUsd) > 0.005)

const hasPooled = computed(() => props.rows.some((r) => r.spendClass === 'pooled-usage'))
const footer = computed(() => (hasPooled.value ? POOLED_FOOTER : (props.pooledFooter ?? '')))

/*
 * A $0 billed axis has two very different meanings and the empty state must not
 * merge them: `no-data-yet` means the hourly transform has not produced a row
 * for this window at all (a fresh environment's FIRST state), and rendering that
 * as an absence of spend asserts something the data cannot support.
 */
const emptyCopy = computed(() => {
  switch (props.billedLane?.availability) {
    case 'no-data-yet':
      return 'No billed data for this period yet — the provider figures have not been derived, which is not the same as no spend.'
    case 'none-in-scope':
      return 'No billed spend in this scope for this period.'
    default:
      return 'No drivers in this lane.'
  }
})

/*
 * The CONSUMPTION arms, rendered separately and never summed into the table
 * above. A Copilot arm's dollars are gross AI credits before the pooled
 * allowance — metered, not charged — so they get their own block with their own
 * total and the sentence saying why. Folding them into the billed ranking would
 * produce a single "billed" figure that is part invoice and part meter reading.
 */
const consumptionArms = computed(() =>
  (props.billedLane?.arms ?? []).filter((a) => a.measure === 'consumption' && a.rows.length > 0),
)

/*
 * THE NOT-IN-THIS-FIGURE STATE. Each gap is one provider's charge that is absent
 * from the headline, in the SERVER's own words — this component renders the
 * sentence and never composes one, because the two reasons a charge can be
 * missing (the provider's billing model has no such grain; nothing has been
 * derived for this window yet) call for different reader actions and only the
 * query layer knows which applies.
 *
 * It renders ABOVE the table rather than in the footer on purpose: it qualifies
 * every figure below it, and a caveat under a ranking is read after the number
 * has already been taken as the answer.
 */
const chargebackGaps = computed(() => props.chargebackCoverage?.gaps ?? [])

// `estimated` is ALSO informational (shared/reports/types: "emitted, not the billed P&L
// figure") — an inference/run-rate $, never a hard charge. It must render muted + badged like
// `pooled-usage`, not identical to a real billed row.
//
// `indicative` is NOT here any more, and its absence is the fix. It was on EVERY
// row of every attributed table, so per-row marking told the reader nothing a
// single sentence above the table does not — see `indicativeNote` below and
// prototype `note('fix 4', …)`. Marking is reserved for a class that appears
// BESIDE a different one.
//
// `billed` is the ONE class that must NOT be here: it is the provider's own
// money off the billed lane, and muting it under "informational — not a charge"
// would state the exact opposite of what it is. That is why the class was added
// rather than the billed axes being repointed under 'indicative'.
function isInformational(sc: SpendClass): boolean {
  return sc === 'pooled-usage' || sc === 'estimated'
}
function badgeFor(sc: SpendClass): { kind: 'neutral' | 'vision'; label: string } | null {
  if (sc === 'pooled-usage') return { kind: 'neutral', label: 'pooled' }
  if (sc === 'estimated') return { kind: 'neutral', label: 'estimated' }
  // 'billed' and 'indicative' carry NO badge. For 'billed' because a badge beside
  // a figure is this table's marker for "read this with a caveat" and billed
  // money has none; for 'indicative' because the caveat is now the card's, once.
  return null
}

/**
 * The `indicative` caveat, stated ONCE for the whole table.
 *
 * It is a claim about the ROWS, so it is driven by the rows: present the moment
 * any row is indicative, absent on a table that has none. That is also what
 * keeps it honest on a MIXED table — the indicative rows are the unbadged ones,
 * and every row that is something else says so on its own face.
 */
const indicativeNote = computed(() => {
  const n = props.rows.filter((r) => r.spendClass === 'indicative').length
  if (n === 0) return ''
  // A table where EVERY row is indicative can say so of every figure; a mixed one
  // must not, because the badged rows beside them are a different kind of dollar.
  return n === props.rows.length
    ? 'Every figure here is attributed usage — indicative, not a billed charge.'
    : 'Rows carrying no badge are attributed usage — indicative, not a billed charge.'
})

// ── Usage provenance (requirement 4) ──────────────────────────────────────────
const PROVENANCE_LABELS: Record<string, string> = {
  'otel-emitted': 'OTel-emitted',
  'api-reconciled': 'API-reconciled',
  'provider-usage': 'provider usage — TokenScope does not carry a model for this surface',
}
/** A native tooltip naming the row's usage-provenance mix, or undefined for a
 *  row this requirement did not extend (region/practice/project axes). */
function provenanceTitle(r: DriverRow): string | undefined {
  const pb = r.provenanceBreakdown
  if (!pb?.length) return undefined
  if (pb.length === 1) return `Usage provenance: ${PROVENANCE_LABELS[pb[0]!.provenance] ?? pb[0]!.provenance}`
  const parts = pb.map((p) => `${PROVENANCE_LABELS[p.provenance] ?? p.provenance} ${fmtUsd(p.usd)}`)
  return `Usage provenance (blended) — ${parts.join(' · ')}`
}

function onAxis(value: string) {
  if (value !== props.axis) emit('update:axis', value)
}

/**
 * The LABEL column's heading — the active pivot's own word where there is one.
 * A chip row reading "Teammate" over a column headed "Driver" makes the reader
 * do the join; the two are one fact and read from one place.
 */
const labelHeading = computed(
  () => props.axisOptions.find((o) => o.value === props.axis)?.label ?? props.labelColumnLabel,
)

// ── Share-of-spend bar (prototype's `btrack`) ────────────────────────────────
// Scaled against the LARGEST row, not the headline: at 20 rows a share-of-total
// scale renders every row after the second as an invisible sliver. Negative
// amounts (billed-lane credits) are floored at 0 — a bar cannot be shorter than
// nothing, and the SIGNED figure is right beside it in the value column.
const barMax = computed(() => Math.max(0, ...props.rows.map((r) => r.usd)))
function barWidth(r: DriverRow): string {
  if (barMax.value <= 0) return '0%'
  return `${Math.max(0, Math.min(100, (r.usd / barMax.value) * 100)).toFixed(1)}%`
}

// ── Surface mix (requirement 3) ───────────────────────────────────────────────
const hasSurfaceMix = computed(() => props.rows.some((r) => (r.surfaceBreakdown?.length ?? 0) > 0))

interface Seg extends DriverSurfaceAmount {
  color: string
  /** Share of the ROW's own total (this segment's bar width). */
  share: number
}
function rowSegments(r: DriverRow): Seg[] {
  const segs = r.surfaceBreakdown ?? []
  const total = segs.reduce((a, s) => a + s.usd, 0)
  return segs
    .filter((s) => s.usd !== 0)
    .map((s) => ({ ...s, color: vendorLaneColor(s.lane as Vendor), share: total > 0 ? s.usd / total : 0 }))
}

// ONE legend for the table: every lane present in any row, canonical registry order.
const legendLanes = computed(() => {
  const seen = new Map<string, string>()
  for (const r of props.rows) {
    for (const s of r.surfaceBreakdown ?? []) if (!seen.has(s.lane)) seen.set(s.lane, s.label)
  }
  return (VENDOR_LANES as readonly string[])
    .filter((lane) => seen.has(lane))
    .map((lane) => ({ lane, label: seen.get(lane)! }))
})

// ── Model tier mix (04-prototype-delta.md §5 — Track D's banding, rendered) ───
// Presence-driven exactly like the surface mix: absent field ⇒ absent COLUMN, so
// an unwired banding can never render as "no frontier usage".
const hasTierMix = computed(() => props.rows.some((r) => (r.tierBreakdown?.length ?? 0) > 0))

interface TierSeg extends DriverTierAmount {
  color: string
  /** Share of the ROW's own total (this segment's bar width). */
  share: number
}
function rowTiers(r: DriverRow): TierSeg[] {
  const segs = r.tierBreakdown ?? []
  const total = segs.reduce((a, s) => a + s.usd, 0)
  return segs
    .filter((s) => s.usd !== 0)
    .map((s) => ({ ...s, color: modelTierColor(s.band), share: total > 0 ? s.usd / total : 0 }))
}

// ONE legend for the table: every band present in any row, in the shared
// hottest-to-coolest band order (never the order the data happened to arrive in).
const tierLegend = computed(() => {
  const seen = new Map<ModelTierBand, string>()
  for (const r of props.rows) {
    for (const s of r.tierBreakdown ?? []) if (!seen.has(s.band)) seen.set(s.band, s.label)
  }
  return MODEL_TIER_BANDS.filter((b) => seen.has(b)).map((band) => ({
    band,
    label: seen.get(band)!,
    color: modelTierColor(band),
  }))
})

// ── Against budget (04-prototype-delta.md §5b) ───────────────────────────────
// The COLUMN exists when the axis has a budget concept at all — i.e. any row
// carries the field, INCLUDING as an explicit null. Testing truthiness instead
// would make a cost centre whose every project is unbudgeted look like an axis
// with no budgets, which is the opposite of what such an owner needs to see.
const hasBudget = computed(() => props.rows.some((r) => r.budgetUsd !== undefined))

/*
 * Label + share-of-spend bar + value + ONE right-hand column, plus each optional
 * mix column.
 *
 * "Against budget" REPLACES "Share" rather than sitting beside it. Two competing
 * right-hand numbers is what the budget column exists to remove: a project owner
 * reading "3% · 87% of $6,024" has to work out which one is theirs, and the
 * share is the one that shrinks toward meaninglessness as the estate grows.
 */
const colCount = computed(() => 4 + (hasSurfaceMix.value ? 1 : 0) + (hasTierMix.value ? 1 : 0))
/** The sum-back row spans the label column and every non-numeric column. */
const sumbackSpan = computed(
  () => 2 + (hasSurfaceMix.value ? 1 : 0) + (hasTierMix.value ? 1 : 0),
)
</script>

<template>
  <div data-testid="drivers-table">
    <div class="flex items-center justify-between gap-4 mb-3 flex-wrap">
      <div class="text-[11px] text-carbon-3">share of {{ denominatorLabel }}</div>
      <!-- PIVOT CHIPS, not a dropdown: every axis a reader may ask for is on
           screen, so choosing one is a click rather than open-read-choose-close.
           `aria-pressed` carries the selection (a toggle group, not navigation). -->
      <div
        v-if="axisOptions.length"
        class="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Break down drivers by"
        data-testid="drivers-axis"
      >
        <button
          v-for="o in axisOptions"
          :key="o.value"
          type="button"
          class="text-[12px] rounded-full px-3 py-1 border transition-colors"
          :class="
            o.value === axis
              ? 'border-brand-harmony bg-brand-harmony text-white font-semibold'
              : 'border-calm-2 bg-white text-carbon-2 hover:border-brand-harmony hover:text-carbon-1'
          "
          :aria-pressed="o.value === axis"
          :data-testid="`drivers-axis-${o.value}`"
          @click="onAxis(o.value)"
        >{{ o.label }}</button>
      </div>
    </div>

    <!-- The `indicative` caveat, once for the card instead of once per row. -->
    <p
      v-if="indicativeNote"
      class="text-[11px] text-carbon-3 italic mb-3"
      data-testid="drivers-indicative-note"
    >{{ indicativeNote }}</p>

    <!-- What this lane cannot answer HERE, and why — above the figures it
         qualifies, never below them. -->
    <div
      v-if="chargebackGaps.length"
      class="mb-3 rounded-md border border-calm-2 bg-calm-1/50 px-3 py-2"
      data-testid="drivers-chargeback-gaps"
      role="note"
    >
      <p
        v-for="(g, i) in chargebackGaps"
        :key="i"
        class="text-[11px] leading-snug text-carbon-2"
        :data-testid="`drivers-chargeback-gap-${g.provider ?? 'all'}`"
      >
        {{ g.reason }}
      </p>
    </div>

    <LaneLegend v-if="hasSurfaceMix" :lanes="legendLanes" class="mb-2" />

    <!-- Model-tier legend — identity is never colour-alone, so the swatch always
         travels with its word (the same rule LaneLegend follows). -->
    <div
      v-if="hasTierMix"
      class="flex flex-wrap gap-x-4 gap-y-1.5 mb-2"
      data-testid="drivers-tier-legend"
      role="list"
      aria-label="Model tier colour legend"
    >
      <span
        v-for="t in tierLegend"
        :key="t.band"
        role="listitem"
        class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
        :data-testid="`drivers-tier-legend-${t.band}`"
      >
        <span class="inline-block w-2 h-2 rounded-sm shrink-0" :style="{ background: t.color }" aria-hidden="true" />
        {{ t.label }}
      </span>
    </div>

    <table class="w-full text-sm">
      <thead>
        <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
          <th class="text-left font-semibold py-2" data-testid="drivers-col-label">{{ labelHeading }}</th>
          <th v-if="hasSurfaceMix" class="text-left font-semibold py-2 pl-4 min-w-[140px]">Surface mix</th>
          <th v-if="hasTierMix" class="text-left font-semibold py-2 pl-4 min-w-[140px]">Model tier</th>
          <th class="text-left font-semibold py-2 pl-4 min-w-[120px]" data-testid="drivers-col-bar">Share of spend</th>
          <th class="text-right font-semibold py-2" data-testid="drivers-col-value">{{ valueColumnLabel }}</th>
          <th v-if="hasBudget" class="text-right font-semibold py-2 w-[150px]">Against budget</th>
          <th v-else class="text-right font-semibold py-2 w-[80px]">%</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" class="border-b border-calm-1 last:border-0 hover:bg-calm-1/40">
          <td class="py-2.5">
            <!-- LINK · ACTION · PLAIN TEXT — the drill contract (fix 7). The
                 same cell in all three states, so the row does not jump; only
                 the affordance differs, and it differs because the grant does. -->
            <NuxtLink
              v-if="targetFor(r)?.kind === 'link'"
              :to="(targetFor(r) as { kind: 'link'; to: never }).to"
              class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
              data-testid="drivers-drill-link"
              :title="provenanceTitle(r)"
            >{{ r.label }}</NuxtLink>
            <button
              v-else-if="targetFor(r)?.kind === 'action'"
              type="button"
              class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
              data-testid="drivers-drill"
              :title="provenanceTitle(r)"
              @click="emit('drill', r)"
            >{{ r.label }}</button>
            <span
              v-else
              class="font-medium text-carbon-1"
              data-testid="drivers-plain"
              :title="provenanceTitle(r)"
            >{{ r.label }}</span>
            <UiBadge
              v-if="badgeFor(r.spendClass)"
              :kind="badgeFor(r.spendClass)!.kind"
              class="ml-2 align-middle"
            >{{ badgeFor(r.spendClass)!.label }}</UiBadge>
          </td>
          <td v-if="hasSurfaceMix" class="py-2.5 pl-4">
            <div
              v-if="rowSegments(r).length"
              class="flex gap-[2px] h-3 items-stretch"
              role="img"
              :aria-label="`${r.label} spend by surface: ${rowSegments(r).map((s) => `${s.label} ${fmtUsd(s.usd)}`).join(', ')}`"
              :data-testid="`drivers-surface-mix-${r.key}`"
            >
              <div
                v-for="seg in rowSegments(r)"
                :key="seg.lane"
                class="h-full min-w-[3px] first:rounded-l-full last:rounded-r-full"
                :style="{ width: `${seg.share * 100}%`, background: seg.color }"
                :title="`${seg.label} — ${fmtUsd(seg.usd)} · ${fmtPct(seg.share)} of ${r.label}`"
              />
            </div>
            <span v-else class="text-[11px] text-carbon-3 italic">—</span>
          </td>
          <td v-if="hasTierMix" class="py-2.5 pl-4">
            <div
              v-if="rowTiers(r).length"
              class="flex gap-[2px] h-3 items-stretch"
              role="img"
              :aria-label="`${r.label} spend by model tier: ${rowTiers(r).map((s) => `${s.label} ${fmtUsd(s.usd)}`).join(', ')}`"
              :data-testid="`drivers-tier-mix-${r.key}`"
            >
              <div
                v-for="seg in rowTiers(r)"
                :key="seg.band"
                class="h-full min-w-[3px] first:rounded-l-full last:rounded-r-full"
                :style="{ width: `${seg.share * 100}%`, background: seg.color }"
                :title="`${seg.label} — ${fmtUsd(seg.usd)} · ${fmtPct(seg.share)} of ${r.label}`"
              />
            </div>
            <span v-else class="text-[11px] text-carbon-3 italic">—</span>
          </td>
          <!-- Magnitude, named by its column header — the ranking read that used
               to be a second chart above this table. -->
          <td class="py-2.5 pl-4">
            <span
              class="block h-2 rounded-full bg-calm-1 overflow-hidden"
              role="img"
              :aria-label="`${r.label}: ${fmtPct(r.sharePct)} of ${denominatorLabel}`"
              :data-testid="`drivers-bar-${r.key}`"
            >
              <span
                class="block h-full rounded-full bg-brand-harmony"
                :style="{ width: barWidth(r) }"
              />
            </span>
          </td>
          <td
            class="py-2.5 text-right tabular-nums"
            :class="isInformational(r.spendClass) ? 'text-carbon-3 italic' : 'text-carbon-1'"
            :title="isInformational(r.spendClass) ? 'informational — not a charge' : undefined"
          >
            {{ fmtUsd(r.usd) }}
            <!-- THE SECOND OPERAND (F5 D25). Present only where the row's own
                 total is measured on a wider population than the reading scope
                 — the cost-centre project axis, whose rows are the PROJECT's
                 total across every centre that worked on it. Rendered UNDER
                 that figure rather than in a column of its own, because it is
                 a part of it and a column invites the reader to add them. -->
            <span
              v-if="r.scopeShareUsd !== undefined"
              class="block text-[11px] font-normal text-carbon-3"
              :data-testid="`drivers-scope-share-${r.key}`"
            >{{ fmtUsd(r.scopeShareUsd) }} from {{ r.scopeShareLabel || 'this scope' }}</span>
            <!--
              A ZERO HERE IS NOT A ZERO PROJECT — it is a project none of whose
              recorded usage is stamped with THIS Business Unit. Unexplained it
              reads as a contradiction: a $3,966.41 project annotated "$0.00
              from this Business Unit". A BU owner hit exactly that on
              2026-08-10, having just corrected the homing themselves.

              IT DOES NOT PROMISE A MIGRATE. An earlier draft said "an admin can
              migrate it", and that is not knowable from a zero: the project's
              total deliberately includes reconciliation-arm rows that carry a
              NULL cost-owning unit, which Migrate does not touch. A project made
              only of those would have been told a fix exists that previews zero
              rows — the same over-claiming this whole page is about. So it
              states the FACT and points at where the answer lives.
            -->
            <span
              v-if="r.scopeShareUsd === 0"
              class="block text-[11px] font-normal text-carbon-3 italic"
              :data-testid="`drivers-scope-share-none-${r.key}`"
            >none of it counts toward this {{ BU_LABEL_LOWER }} — usage tagged to a project counts toward that project's {{ BU_LABEL_LOWER }}</span>
          </td>
          <!-- Consumption against this row's OWN budget, not a share of the scope.
               The three-state truth table (number / "no budget set" / n/a) lives
               in BudgetStateCell — ONE implementation for this table and the me
               pages (developer pages build D15.2). -->
          <td
            v-if="hasBudget"
            class="py-2.5 text-right"
            :data-testid="`drivers-budget-${r.key}`"
          >
            <BudgetStateCell :usd="r.usd" :budget-usd="r.budgetUsd" />
          </td>
          <td v-else class="py-2.5 text-right tabular-nums text-carbon-2">{{ fmtPct(r.sharePct) }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td
            :colspan="colCount"
            class="py-8 text-center text-carbon-3 text-sm"
            data-testid="drivers-empty"
          >{{ emptyCopy }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr
          class="border-t-2"
          :class="mismatch ? 'border-rag-red text-rag-red' : 'border-calm-2 text-carbon-2'"
          data-testid="drivers-sumback"
          :data-mismatch="mismatch"
        >
          <td :colspan="sumbackSpan" class="py-2.5 font-semibold">
            Sum of drivers
            <span v-if="mismatch" class="ml-1 text-[11px] font-bold">
              ≠ {{ sumbackLabel }} — does not reconcile
            </span>
            <span v-else class="ml-1 text-[11px] text-carbon-3">
              reconciles to {{ sumbackLabel }}
            </span>
          </td>
          <td class="py-2.5 text-right tabular-nums font-semibold">{{ fmtUsd(sum) }}</td>
          <td class="py-2.5 text-right tabular-nums text-[11px]">/ {{ fmtUsd(headlineUsd) }}</td>
        </tr>
      </tfoot>
    </table>

    <p v-if="footer" class="mt-2 text-[11px] text-carbon-3 italic" data-testid="drivers-pooled-footer">
      {{ footer }}
    </p>

    <!-- CONSUMPTION arms — beside the billed total, never inside it. Each arm
         carries its own total and its own sentence, so a reader can never take
         the two numbers as parts of one. -->
    <section
      v-for="arm in consumptionArms"
      :key="arm.provider"
      class="mt-5 pt-3 border-t border-calm-2"
      :data-testid="`drivers-consumption-${arm.provider}`"
    >
      <div class="flex items-baseline justify-between gap-3 flex-wrap">
        <span class="text-[12px] font-semibold text-carbon-1">
          {{ arm.provider }} consumption — not part of the billed total above
        </span>
        <span
          class="text-[12px] tabular-nums text-carbon-3 italic"
          :data-testid="`drivers-consumption-total-${arm.provider}`"
        >{{ fmtUsd(arm.totalUsd) }}</span>
      </div>
      <p class="mt-1 text-[11px] text-carbon-3 italic">{{ consumptionNote(arm.provider) }}</p>
      <ul class="mt-2">
        <li
          v-for="r in arm.rows"
          :key="r.key"
          class="flex items-baseline justify-between gap-3 py-1 text-[12px] text-carbon-3"
        >
          <span class="italic">{{ r.label }}</span>
          <span class="tabular-nums italic">{{ fmtUsd(r.usd) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
