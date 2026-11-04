<script setup lang="ts">
/*
 * ReportHeaderNotes — ONE chip holding every caveat that used to stack above the
 * first number on a /reporting scope.
 *
 * WHAT IT REPLACES. The Region header printed, in order: three settling chips
 * (Anthropic / GitHub Copilot / Usage, each reading "Estimated · month in
 * progress" — one fact, said three times), a coverage marker with its
 * descriptor, a note on how usage was placed, and the lane
 * explainer. Six lines of commentary before the reader reached the figure they
 * came for.
 *
 * THEN IT REPLACED ITSELF. The first pass collapsed those six lines into a
 * disclosure, but left THREE elements in the header: a settling chip, a coverage
 * chip and a "What these figures are" link. Three affordances where one will do
 * is the same disease in smaller type — a wall of chips telling the reader three
 * times that a figure is provisional. There is now exactly ONE chip: it STATES
 * the weakest current state and it IS the control that opens the detail.
 *
 * NOTHING IS DELETED — IT IS RELOCATED. Every sentence below is the same string
 * its original component rendered, produced by the same component
 * (SettlingStateChip / CoverageMarker) from the same server fields. A finance
 * reader still needs all of it; they do not need it before the headline. If you
 * are tempted to reword something while it is in here, don't: the caveats were
 * argued for where they were written.
 *
 * A PAGE WITH NOTHING TO CAVEAT SAYS NOTHING. The chip renders only when there is
 * a real caveat — a settling clock, or coverage the server could not claim. The
 * lane explainer and the placement note are CONTEXT, not caveats: they ride
 * inside the panel when it opens but they never summon the chip on their own,
 * because an amber chip over a page with nothing provisional on it is exactly the
 * over-statement this component exists to remove.
 *
 * `<details>`/`<summary>` rather than a bespoke popover: it is keyboard-reachable
 * and toggleable natively, its open state is exposed to assistive tech without
 * ARIA of our own, and its content is real text in the accessibility tree —
 * never a `title=` tooltip, which a screen reader and a touch device both lose.
 */
import { computed } from 'vue'
import UiBadge from '../ui/Badge.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import CoverageMarker from './CoverageMarker.vue'
import { PLACEMENT_NOTE, REPORT_LANE_CAPTIONS } from './lane-captions'
import type { ReportLane } from '../../composables/useReportState'
import type { ProviderState, ReportCoverageMeta } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    /** Every vendor clock the page's figures sit on — one chip each, inside. */
    providerStates?: ProviderState[]
    coverage?: ReportCoverageMeta | null
    /** Carry the placement note (PLACEMENT_NOTE) — on every page that groups usage by placement. */
    placementNote?: boolean
    /** The active lens, selecting which explainer sentence to carry. */
    lane?: ReportLane
  }>(),
  { providerStates: () => [], coverage: null, placementNote: false, lane: 'usage' },
)

/*
 * THE COLLAPSED SETTLING WORD. The three chips are one fact repeated, so the
 * trigger states it once — but it must not state it more confidently than the
 * weakest clock behind it. `estimated` is the least settled state, so a single
 * disagreeing provider keeps the summary on the weaker word rather than the
 * majority one. Every state here is pre-close, so the chip is amber in all of
 * them; there is no state in which this reads as final.
 *
 * The words are SettlingStateChip's own ('Estimated' / 'Settling' /
 * 'Provisional') — the copy bank bans "finalised" and this must not invent a
 * fourth vocabulary for the same axis.
 */
const settlingWord = computed<string | null>(() => {
  const states = props.providerStates.map((p) => p.state)
  if (states.length === 0) return null
  if (states.includes('estimated')) return 'Estimated'
  if (states.includes('settling')) return 'Settling'
  return 'Provisional'
})

/** Coverage is a caveat only when it is NOT known — an unclaimed denominator. A
 *  claimed one is a fact for the panel, not a warning for the header. */
const coverageWord = computed<string | null>(() => {
  const c = props.coverage
  if (!c || c.applicable !== true || c.denominator != null) return null
  return c.stale ? 'Coverage stale' : 'Coverage unknown'
})

/*
 * THE ONE WORD ON THE CHIP. Settling leads when both are present: "is this figure
 * final?" is the question every number on the page raises, and coverage qualifies
 * a denominator inside one of them. Coverage still gets the chip to itself when
 * there is no settling clock, so an unclaimed denominator can never go unsignalled.
 */
const chipWord = computed(() => settlingWord.value ?? coverageWord.value)

const laneCaption = computed(() => REPORT_LANE_CAPTIONS[props.lane])
</script>

<template>
  <details v-if="chipWord" class="group" data-testid="report-header-notes">
    <summary
      class="inline-flex items-center cursor-pointer list-none rounded
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-harmony"
      data-testid="report-header-notes-trigger"
    >
      <!-- The chip IS the affordance: it carries the state AND opens the detail.
           `group-open` swaps only the underline, so the word never changes out
           from under a reader who is looking at it. -->
      <UiBadge
        kind="rag-amber"
        dot="amber"
        class="underline decoration-dotted underline-offset-2 group-open:decoration-solid"
      >{{ chipWord }}</UiBadge>
    </summary>

    <div
      class="mt-2 max-w-[46rem] rounded-lg border border-calm-2 bg-paper px-3 py-2.5 space-y-2"
      data-testid="report-header-notes-panel"
    >
      <!-- Per-provider settling detail: WHICH clock, and when it settles. The
           collapsed word above cannot carry that, which is why it is here. -->
      <div v-if="providerStates.length" class="flex flex-col gap-1">
        <SettlingStateChip
          v-for="p in providerStates"
          :key="p.vendor"
          :state="p.state"
          :horizon-date="p.settlesAt"
          :vendor="p.vendor"
          :data-testid="`notes-settling-${p.vendor}`"
        />
      </div>

      <CoverageMarker :coverage="coverage" />

      <p v-if="placementNote" class="text-[11px] leading-snug text-carbon-3" data-testid="notes-placement">
        {{ PLACEMENT_NOTE }}
      </p>

      <p v-if="laneCaption" class="text-[11px] leading-snug text-carbon-3" data-testid="notes-lane-caption">
        {{ laneCaption }}
      </p>
    </div>
  </details>
</template>

<style scoped>
/* Safari renders a default disclosure triangle that `list-style:none` alone
   does not remove. */
summary::-webkit-details-marker {
  display: none;
}
</style>
