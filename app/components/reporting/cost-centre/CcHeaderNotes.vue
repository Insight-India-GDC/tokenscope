<script setup lang="ts">
/*
 * CcHeaderNotes — the Cost-centres top layer's caveat chips (D8b,
 * 07-model-axis-subtraction-build.md: "the top layer stops explaining itself").
 *
 * WHAT IT REPLACES. The header stacked THREE separate settlement chip+text
 * pairs (Anthropic / GitHub Copilot / Usage — one fact, said up to three
 * times), the coverage marker WITH its explanatory sentence, and the
 * placement note: a wall of commentary before the first figure. The same
 * disease #230 cured on the Region width (ReportHeaderNotes); the same cure,
 * with the two rules D8b sets for THIS width:
 *
 *  - ONE settlement chip, on the LEAST-SETTLED state across providers
 *    (r1-M5): any `estimated` → "Estimated"; else any `settling` →
 *    "Settling"; and when every clock is past its settling horizon — NO chip
 *    at all. Its popover lists each provider's own clock exactly as the three
 *    chips rendered it (SettlingStateChip — the same component, from the same
 *    server fields), so the information is kept while the triple repeat goes.
 *    The words are SettlingStateChip's own; the copy bank bans "finalised",
 *    and the chip must never state the page's settlement more confidently
 *    than the weakest clock behind it.
 *  - Coverage stays a chip of its OWN (a real §B caveat, not narration),
 *    compact: the pill alone, its sentence riding the tooltip
 *    (CoverageMarker `compact`). It renders independently of the settlement
 *    chip, so an unclaimed denominator can never go unsignalled just because
 *    the clocks all settled.
 *
 * The placement note and the lane explainer are CONTEXT, not caveats:
 * they ride inside the popover (the same relocation ReportHeaderNotes made —
 * relocated, not reworded) and never summon a chip on their own.
 *
 * `<details>`/`<summary>` rather than a bespoke popover, for ReportHeaderNotes'
 * reasons: keyboard-reachable and toggleable natively, open state exposed to
 * assistive tech without ARIA of our own, and the content is real text in the
 * accessibility tree.
 */
import { computed } from 'vue'
import UiBadge from '../../ui/Badge.vue'
import SettlingStateChip from '../SettlingStateChip.vue'
import CoverageMarker from '../CoverageMarker.vue'
import { PLACEMENT_NOTE, REPORT_LANE_CAPTIONS } from '../lane-captions'
import type { ReportLane } from '../../../composables/useReportState'
import type { ProviderState, ReportCoverageMeta } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    /** Every vendor clock the page's figures sit on — one chip each, inside the popover. */
    providerStates?: ProviderState[]
    coverage?: ReportCoverageMeta | null
    /** Carry the placement note (PLACEMENT_NOTE) — on every page that groups usage by placement. */
    placementNote?: boolean
    /** The active lens, selecting which explainer sentence rides the popover. */
    lane?: ReportLane
  }>(),
  { providerStates: () => [], coverage: null, placementNote: false, lane: 'usage' },
)

/*
 * THE AGGREGATE RULE (D8b, r1-M5). Walk the ladder from the least-settled state
 * down; a single disagreeing provider keeps the chip on the weaker word rather
 * than the majority one. All-settled yields NO chip — past every settling
 * horizon there is nothing left to caveat on this axis, and an amber chip over
 * it would be exactly the over-statement this component exists to remove.
 */
const settlingWord = computed<string | null>(() => {
  const states = props.providerStates.map((p) => p.state)
  if (states.includes('estimated')) return 'Estimated'
  if (states.includes('settling')) return 'Settling'
  return null
})

const laneCaption = computed(() => REPORT_LANE_CAPTIONS[props.lane])
</script>

<template>
  <details v-if="settlingWord" class="group" data-testid="cc-header-notes">
    <summary
      class="inline-flex items-center cursor-pointer list-none rounded
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-harmony"
      data-testid="cc-header-notes-trigger"
    >
      <!-- The chip IS the affordance: it carries the state AND opens the detail.
           `group-open` swaps only the underline, so the word never changes out
           from under a reader who is looking at it. -->
      <UiBadge
        kind="rag-amber"
        dot="amber"
        class="underline decoration-dotted underline-offset-2 group-open:decoration-solid"
      >{{ settlingWord }}</UiBadge>
    </summary>

    <div
      class="mt-2 max-w-[46rem] rounded-lg border border-calm-2 bg-paper px-3 py-2.5 space-y-2"
      data-testid="cc-header-notes-panel"
    >
      <!-- Per-provider settling detail: WHICH clock, and when it settles. The
           collapsed word above cannot carry that, which is why it is here. -->
      <div class="flex flex-col gap-1">
        <SettlingStateChip
          v-for="p in providerStates"
          :key="p.vendor"
          :state="p.state"
          :horizon-date="p.settlesAt"
          :vendor="p.vendor"
          :data-testid="`cc-notes-settling-${p.vendor}`"
        />
      </div>

      <p v-if="placementNote" class="text-[11px] leading-snug text-carbon-3" data-testid="cc-notes-placement">
        {{ PLACEMENT_NOTE }}
      </p>

      <p
        v-if="laneCaption"
        class="text-[11px] leading-snug text-carbon-3"
        data-testid="cc-notes-lane-caption"
      >
        {{ laneCaption }}
      </p>
    </div>
  </details>

  <!-- The §B coverage caveat, compact — its own chip, never folded into the
       settlement word, never accompanied by its sentence (that is the tooltip's). -->
  <CoverageMarker :coverage="coverage" compact />
</template>

<style scoped>
/* Safari renders a default disclosure triangle that `list-style:none` alone
   does not remove. */
summary::-webkit-details-marker {
  display: none;
}
</style>
