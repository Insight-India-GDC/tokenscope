<script setup lang="ts">
/*
 * BudgetCoverageNote — the coverage denominator, rendered beside the §A total it
 * qualifies ("Four — make reports honest about coverage",
 * docs/design/reporting-stakeholder-visibility/00-decisions.md §5b).
 *
 * THE PROBLEM IT CLOSES. Under 5% of enterprise consumption is on a budgeted
 * project, so a reader who sees a total and assumes it is the whole is wrong by
 * more than an order of magnitude — and until this shipped, nothing on screen said
 * so. The all-consumption view is the honest artefact at this adoption level and
 * the budget view is the destination; neither may imply the other's coverage.
 *
 * IT IS A BAR, NOT A PARAGRAPH (prototype "who" note). It used to be three
 * sentences of prose stating four dollar figures and their relationship, which is
 * the "a chart that needs a paragraph is broken" defect with the paragraph as the
 * whole card: a partition of one total into four parts is a picture, and the
 * reader's question — "how much of this is governed?" — is answered by the width
 * of the first segment before any number is read. The four parts still carry
 * their own dollar amounts, because a segment nobody can price is decoration.
 *
 * THE FOUR PARTS FOOT TO THE TOTAL, by construction, not by rounding: they are
 * FILTER aggregates over the one scan that produced `totalUsd`
 * (server/reporting/engine/usage-coverage.ts). So the bar may be drawn as
 * shares of that total without a "other/remainder" fudge segment.
 *
 * NOT A BARE PERCENTAGE. The claim names the denominator in the words a reader
 * reads — whose consumption, over what period, from which lane — because a share
 * with an unnamed denominator is the thing this note exists to prevent.
 *
 * THE SCOPE NAME IS NOT THIS COMPONENT'S TO CHOOSE, and it deliberately has no prop
 * for one. It reads `coverage.scopeLabel`, which the server sets beside the predicate
 * it clamped with. The earlier version took a `denominatorLabel` from its parent, which
 * computed `drill ?? region` — correct for an admin, and wrong for a manager or a
 * developer, whose §A clamp is their `app.user_org_path` SUBTREE
 * (server/auth/org-subtree-scope.ts) even though both hold `regional: 'own-region'`.
 * They read the whole REGION's name above their own subtree's numbers. A component
 * cannot see a SQL predicate, so it cannot be the one to name it (contract C11).
 *
 * AND NOT A COMPLETENESS CLAIM. `totalUsd` is §A ATTRIBUTED usage: provider spend
 * that has never matched a teammate reaches no §A row (shared/reports/types.ts,
 * `UsageBudgetCoverage.totalUsd`), so it is in neither this denominator nor the
 * headline it qualifies. That is stated in one line under the bar rather than
 * left for the Finance tab to reveal — see the note in the template for why it is
 * NOT drawn as a fifth segment.
 *
 * §A ONLY. The four parts are a partition of the scope's ATTRIBUTED-USAGE total;
 * no bill-lane figure is an operand (contract C2). Callers render it in the usage
 * lens only — under a chargeable headline this sentence would be qualifying a
 * number it was not computed from.
 */
import { computed } from 'vue'
import { fmtUsd, fmtSharePct } from '../../composables/useFormat'
import type { UsageBudgetCoverage } from '#shared/reports/types'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const props = defineProps<{
  coverage: UsageBudgetCoverage
}>()

const c = computed(() => props.coverage)
/*
 * The scope these figures were computed for, as the SERVER resolved it. `null` means
 * the caller's clamp resolves to no org unit at all, so there is no scope to name —
 * a case with its own sentence below, because naming the region there (what the
 * component used to do) states a denominator the figures were never summed over.
 */
const scopeLabel = computed(() => c.value.scopeLabel)
/*
 * A share needs a denominator. With no usage in the window there is nothing to
 * take a share OF, and rendering "0%" would assert a coverage measurement that was
 * never made. An unresolved scope is the same story one step earlier — no rows could
 * have matched — so it takes the same branch and is distinguished by its own copy.
 */
const hasUsage = computed(() => c.value.totalUsd > 0 && scopeLabel.value !== null)
const coveredShare = computed(() => (hasUsage.value ? c.value.budgetedUsd / c.value.totalUsd : 0))

/*
 * The four segments, in order of how much governance each has: budgeted, then a
 * project with no budget behind it, then no project at all, then money that could
 * never carry one.
 *
 * COLOUR IS ORDINAL, and the last band is deliberately NEUTRAL rather than the
 * alarm hue the first three shade toward. Arm 3 has no project axis at all (mig
 * 0101); painting a structural absence red would tell a manager to go and close a
 * gap that cannot be closed — the same libel the wording has always avoided.
 */
const segments = computed(() => [
  { key: 'budgeted', label: 'on a budget', usd: c.value.budgetedUsd, colour: 'var(--brand-harmony)' },
  {
    key: 'tagged-no-budget',
    label: 'on a project with no budget',
    usd: c.value.taggedNoBudgetUsd,
    colour: 'var(--rag-amber)',
  },
  { key: 'untagged', label: 'not on a project', usd: c.value.untaggedUsd, colour: 'var(--brand-vision)' },
  {
    key: 'untaggable',
    label: 'cannot carry a project tag',
    usd: c.value.untaggableUsd,
    colour: 'var(--calm)',
  },
])

/*
 * Widths are shares of `totalUsd`, the same figure the claim above names — never
 * of Σsegments. The two are equal by construction today, and if a producer ever
 * broke that the bar must visibly fail to fill rather than quietly re-normalise
 * itself onto a denominator the card is not reporting.
 */
const drawn = computed(() =>
  segments.value.map((s) => ({
    ...s,
    /* A hairline for a non-zero part rounding to nothing: a segment that exists and
       cannot be seen reads as a segment that does not exist. */
    widthPct: c.value.totalUsd > 0 ? Math.max((s.usd / c.value.totalUsd) * 100, s.usd > 0 ? 0.6 : 0) : 0,
  })),
)
</script>

<template>
  <section
    class="rounded-xl border border-calm-2 bg-white/60 px-4 py-3 space-y-2"
    data-testid="budget-coverage-note"
    :data-total-usd="c.totalUsd"
    :data-budgeted-usd="c.budgetedUsd"
    :data-tagged-no-budget-usd="c.taggedNoBudgetUsd"
    :data-untagged-usd="c.untaggedUsd"
    :data-untaggable-usd="c.untaggableUsd"
  >
    <!-- NO EYEBROW. "BUDGET COVERAGE" sat above a headline that already reads
         "46% of usage in the whole company is on a project with a budget" — a
         label for a sentence that labels itself. -->
    <template v-if="hasUsage">
      <!-- The claim, then the denominator it is a share OF, immediately under it —
           the share never appears without the money it was taken from. -->
      <!-- "…of usage in <scope>", not "…of <scope> usage": the scope name is the
           server's own words and some of them are noun phrases with an article
           ("the whole company"), which the possessive form mangles into "of the
           whole company usage". The name may not be rewritten to fit a sentence
           (contract C11), so the sentence is built to take it as it comes. -->
      <p class="text-[15px] font-bold leading-snug text-carbon" data-testid="budget-coverage-claim">
        {{ fmtSharePct(coveredShare) }} of usage in {{ scopeLabel }} is on a project with a budget
      </p>
      <!-- The denominator, and nothing else. The clause that used to follow it
           ("every dollar TokenScope attributed to a teammate in <scope>, across
           all providers, tagged or not. Not an invoice.") defined the §A lane in
           thirty words, on every scope, above every reader — a definition that
           belongs to the lane, not to this card. It lives in the header
           disclosure's lane caption, once, where the lens is chosen. -->
      <p class="text-[12px] text-carbon-3" data-testid="budget-coverage-denominator">
        of <span class="tabular-nums">{{ fmtUsd(c.totalUsd) }}</span> attributed usage this period
      </p>

      <div class="flex h-[26px] rounded-md overflow-hidden mt-1" data-testid="budget-coverage-bar">
        <i
          v-for="s in drawn"
          :key="s.key"
          class="block h-full"
          :style="{ width: `${s.widthPct}%`, background: s.colour }"
          :data-testid="`budget-coverage-seg-${s.key}`"
          :data-usd="s.usd"
        />
      </div>

      <!-- Every segment priced. A four-way split whose parts have no amounts is a
           shape, and the reader's next question is always "how much is that?". -->
      <div
        class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-carbon-2 tabular-nums"
        data-testid="budget-coverage-outside"
      >
        <span v-for="s in drawn" :key="s.key" class="inline-flex items-center gap-1.5">
          <span
            class="inline-block w-2 h-2 rounded-sm shrink-0"
            :style="{ background: s.colour }"
            aria-hidden="true"
          />
          {{ s.label }} <b class="text-carbon">{{ fmtUsd(s.usd) }}</b>
        </span>
      </div>

      <!--
        THE CONSEQUENCE, in one line. A reader who is not told this reads the bar as
        a partition of ALL provider spend, and it is not.

        NOT A FIFTH SEGMENT, and that is a data fact rather than a layout choice.
        Provider spend whose actor never matched a teammate is carried only on the
        BILLED lane (`provider_usage_fact.teammate_id IS NULL`, mig 0118) — every
        arm of the §A lane this bar partitions is per-teammate by construction
        (`v_complete_usage`, mig 0113). Drawing it as a segment of this total would
        sum §A and §B (contract C2) and would stop the four parts footing to the
        headline they sit under.

        NO DOLLAR FIGURE, deliberately. The prototype's line names one ("$1,191.07
        has no teammate…") because its fourth SEGMENT is that money. Ours is not:
        our fourth segment is `untaggableUsd` — usage that has a teammate and no
        project axis — and the unmatched money is not in this payload at all. It
        would take a §B read to price it. Naming a figure we have not measured, or
        borrowing the fourth segment's, is the false claim this file's own header
        comment exists to forbid. Task #57 tracks the gap.
      -->
      <p class="text-[11px] leading-snug text-carbon-3" data-testid="budget-coverage-unmatched">
        Provider spend never matched to a teammate is outside this total, so it reaches no {{ BU_LABEL_LOWER }}.
      </p>
    </template>

    <p
      v-else-if="scopeLabel !== null"
      class="text-[12px] leading-snug text-carbon-3"
      data-testid="budget-coverage-empty"
    >
      No attributed usage recorded in {{ scopeLabel }} this period, so there is no
      coverage to report.
    </p>

    <!-- No scope resolved. The clamp matched no org unit (the caller's own placement is
         their region's root or a holding node), so these zeros were never a measurement
         of anywhere. Saying "no usage in <Region>" here would be false about a region
         that has plenty — the exact over-wide claim this note exists to prevent. -->
    <p v-else class="text-[12px] leading-snug text-carbon-3" data-testid="budget-coverage-no-scope">
      You are not placed in an org unit below your region's root, so no usage falls inside
      your reporting scope and there is no coverage to report. Ask an Admin to
      place you.
    </p>
  </section>
</template>
