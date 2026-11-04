<script setup lang="ts">
/*
 * ModelSplitPanel — the body of BOTH Top-models cards (region and whole-company).
 *
 * docs/design/reporting-consolidation/07-model-axis-subtraction-build.md D6
 * (owner ruling 2026-08-04): the Top models card RANKS MODELS ONLY, and
 * non-model money is a one-line coverage FOOTER, not a category row and not a
 * labelled group band.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 *
 * The previous shape kept the NULL-model rows out of the ranking (right) but
 * rendered them as two labelled group bands under it ('structural' /
 * 'not-carried', each with its own rows, dollars and shares). After mig 0124
 * the view fans those buckets out into NAMED models plus small reason-typed
 * remainders — so the bands would price crumbs under two headings and a badge.
 * The acceptance gate says neither "Not split by model" nor "Model not
 * captured for this surface" appears AS A CATEGORY ROW; the remainder money
 * moves to the footer, priced, with its reason's wording.
 *
 * ── THE CLASSIFICATION IS THE SHARED MODULE'S, AND IT IS DEFAULT-SAFE ────────
 *
 * `modelBucketKind` (shared/reports/model-attribution.ts) answers 'model' |
 * 'remainder' from the key alone; the footer WORDING keys off each row's
 * `gap_reason`. Any NULL-model row with an unrecognised or absent reason folds
 * into the generic remainder segment — a new reason value can never re-open a
 * category row here (D6, tests 20/21). The billed lane's BILLED_NO_MODEL_KEY
 * row carries no reason and gets the same generic-segment treatment.
 *
 * ── EVERY FIGURE HERE IS ONE LANE'S (prototype note `lane`) ──────────────────
 *
 * `denominatorUsd` is the RESPONSE's own `headlineUsd` for this axis, in the
 * lane the response declares. The bars and the footer's percentage divide by
 * that one number, so the panel cannot mix a numerator from one lane with a
 * denominator from the other. Sum-back is SERVER-SIDE and untouched: the
 * endpoint still returns the remainder rows; this panel renders them as the
 * footer instead of as categories.
 *
 * NOTHING HERE SUBTRACTS ONE LANE FROM THE OTHER. "Attributed minus billed" is
 * not the self-billed amount — the billed-lane note below states that the two
 * totals legitimately differ rather than naming a difference we cannot
 * decompose.
 */
import { computed } from 'vue'
import ChartRankedBar from './charts/ChartRankedBar.client.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import { modelBucketKind, modelBucketNote } from '#shared/reports/model-attribution'
import type { BilledLaneMeta, DriverRow, MeasureLane } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    /** The model-axis driver rows, or null while the request is in flight. */
    rows: DriverRow[] | null
    /**
     * The response's OWN `headlineUsd` for this axis — the denominator every
     * figure in this panel divides by. Never the page headline: on the billed
     * lane those are different lanes' totals.
     */
    denominatorUsd?: number | null
    /** The lane the rows were MEASURED on (`measureLanes.rows`), not `?lane=`. */
    lane?: MeasureLane
    /** Billed-lane completeness, so an empty panel can say WHY it is empty. */
    billedLane?: BilledLaneMeta
    /** Ranked-bar top-N before the tail folds into "Other". */
    topN?: number
  }>(),
  { denominatorUsd: null, lane: 'attributed', billedLane: undefined, topN: 10 },
)

const isBilled = computed(() => props.lane === 'billed')
const laneWord = computed(() => (isBilled.value ? 'billed' : 'attributed'))

/** One pass, two lists — a row is a model bar or a footer operand, by key. */
const split = computed(() => {
  const model: DriverRow[] = []
  const remainder: DriverRow[] = []
  for (const r of props.rows ?? []) {
    ;(modelBucketKind(r.key) === 'model' ? model : remainder).push(r)
  }
  return { model, remainder }
})

const known = computed(() => split.value.model)
const knownBars = computed(() => known.value.map((r) => ({ label: r.label, value: r.usd })))

/*
 * The coverage footer's segments (D6). Reason folding:
 *   'provider-day-grain'                                   → Copilot day-grain money
 *   'awaiting-provider-detail' | 'provider-revision-drift' → awaiting detail
 *   everything else (unknown / absent / billed no-model)   → generic remainder
 * Tooltips carry the full sentence from `modelBucketNote`, keyed off a
 * representative row of each segment so the sentence and the money can never
 * come from different buckets.
 */
const coverage = computed(() => {
  const rows = props.rows ?? []
  if (rows.length === 0) return null
  const namedUsd = known.value.reduce((a, r) => a + r.usd, 0)
  let dayGrainUsd = 0
  let awaitingUsd = 0
  let remainderUsd = 0
  let dayGrainKey: string | null = null
  let awaitingKey: string | null = null
  let remainderKey: string | null = null
  for (const r of split.value.remainder) {
    if (r.gap_reason === 'provider-day-grain') {
      dayGrainUsd += r.usd
      dayGrainKey ??= r.key
    } else if (r.gap_reason === 'awaiting-provider-detail' || r.gap_reason === 'provider-revision-drift') {
      awaitingUsd += r.usd
      // Prefer the plain awaiting key for the tooltip — drift FOLDS into its wording.
      if (awaitingKey === null || r.gap_reason === 'awaiting-provider-detail') awaitingKey = r.key
    } else {
      remainderUsd += r.usd
      remainderKey ??= r.key
    }
  }
  const denom = props.denominatorUsd ?? 0
  return {
    namedUsd,
    namedShare: denom > 0 ? namedUsd / denom : 0,
    dayGrainUsd,
    awaitingUsd,
    remainderUsd,
    dayGrainNote: dayGrainKey ? modelBucketNote(dayGrainKey) : null,
    awaitingNote: awaitingKey ? modelBucketNote(awaitingKey) : null,
    remainderNote: remainderKey ? modelBucketNote(remainderKey) : null,
  }
})

/*
 * A $0 model axis has three meanings and merging them is a defect in itself:
 * the billed transform has not run for this window (`no-data-yet`), it ran and
 * this scope has none of it (`none-in-scope`), or the rows exist but none of
 * them carries a model. Only the last one is about models.
 */
const emptyCopy = computed(() => {
  if (props.rows?.length) return 'No spend in this period carries a model name — the coverage line below prices it.'
  switch (props.billedLane?.availability) {
    case 'no-data-yet':
      return 'No billed model breakdown derived for this period yet.'
    case 'none-in-scope':
      return 'No billed spend in this scope for this period.'
    default:
      return `No ${laneWord.value} spend in this period.`
  }
})
</script>

<template>
  <div data-testid="model-split">
    <p v-if="rows === null" class="text-xs text-carbon-3 italic py-8 text-center">Loading models…</p>

    <template v-else-if="known.length">
      <ChartRankedBar :rows="knownBars" :top-n="topN" :value-format="(v: number) => fmtUsd(v)" />
    </template>

    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="model-split-empty">
      {{ emptyCopy }}
    </p>

    <!--
      THE COVERAGE FOOTER (D6) — one line, derived from the reason-typed rows.
      "Models named for $X · N%" plus a priced segment per remainder kind. The
      segments ARE the remainder rows the response still returns (sum-back is
      server-side and untouched); no category rows, no group bands, ever.
    -->
    <p
      v-if="coverage"
      class="mt-4 pt-3 border-t border-calm-2 text-[11px] leading-snug text-carbon-3"
      data-testid="model-split-footer"
    >
      <span data-testid="model-split-footer-named">
        Models named for <b class="text-carbon-2">{{ fmtUsd(coverage.namedUsd) }}</b>
        · {{ fmtPct(coverage.namedShare) }} of {{ laneWord }} spend</span
      ><span
        v-if="coverage.dayGrainUsd > 0"
        data-testid="model-split-footer-day-grain"
        :title="coverage.dayGrainNote ?? undefined"
      >
        · {{ fmtUsd(coverage.dayGrainUsd) }} Copilot money is day-grain (provider reports no
        per-model dollars)</span
      ><span
        v-if="coverage.awaitingUsd > 0"
        data-testid="model-split-footer-awaiting"
        :title="coverage.awaitingNote ?? undefined"
      >
        · {{ fmtUsd(coverage.awaitingUsd) }} awaiting provider detail</span
      ><span
        v-if="coverage.remainderUsd > 0"
        data-testid="model-split-footer-remainder"
        :title="coverage.remainderNote ?? undefined"
      >
        · {{ fmtUsd(coverage.remainderUsd) }} not split by model</span
      >
    </p>

    <!--
      BILLED LANE ONLY, and one line. A reader comparing this card's Σ (the
      provider's bill) with the attributed headline above it reads an error
      without it. GATED ON ROWS, not just on a non-null total: with nothing
      measured, "Σ billed $0.00" reads as a measured zero, which is the reading
      `emptyCopy` exists to deny.
    -->
    <p
      v-if="isBilled && rows?.length && denominatorUsd != null"
      class="mt-2 text-[11px] leading-snug text-carbon-3"
      data-testid="model-split-lane-note"
    >
      Total billed <b class="text-carbon-2">{{ fmtUsd(denominatorUsd) }}</b> — the provider's bill,
      so it need not match the attributed headline above.
    </p>
  </div>
</template>
