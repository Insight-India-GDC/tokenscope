<script setup lang="ts">
/*
 * CcDrill — the per-cost-centre §A USAGE BURN drill (the SAME lane as the budget
 * tracker's card burn: `v_complete_usage_current WHERE cost_owning_unit_id`). Reached
 * by selecting a row in the tracker; it answers "WHO/WHAT is burning this budget?" and
 * reconciles to the tracker row.
 *
 * Built to the reporting design language: a burn headline (framed against the CC
 * allocation when set), a slim "Burn by vendor" bar over the §A vendor split
 * (Claude = magenta, Copilot = blue — but Copilot pooled rows carry a NULL
 * cost-owning unit and are excluded here, so the split is usually ~100% Claude),
 * and the two HEROES below.
 *
 * ── THIS IS A CONTROL SURFACE, NOT A READING SURFACE (UX pass, 2026-08-06) ────
 * A cost-centre owner arrives scanning for what needs them, and the page's verb
 * is the over-the-soft-cap card: it is the only thing here that names a person
 * and says what to do about them. Everything above it is context for it, so
 * nothing sits between it and the headline. Three things were removed to get
 * there, each on its own grounds, all recorded at their sites: the per-provider
 * freshness row (the header already states settlement, once), the vendor DONUT
 * (two segments is a sentence, not a graphic), and the §B TierExposureCard (a
 * billed-lane answer on a usage-lane page). Every explanatory sentence the two
 * heroes carried is TRUE and load-bearing — the clamp, the denominator, the lane
 * — so it moved behind an (i) rather than dying: the card body carries data, the
 * prose opens on demand.
 * §B ON THIS PAGE, corrected: the chargeback LANE renders the centre's charge in
 * the headline and Behavioural exposure beneath it. What still lives only in the
 * Finance tab is the invoice-grade chargeback REPORT — this page answers "am I on
 * track" in §B, not "what is on the invoice".
 *
 * ── TWO HEROES, NO PIVOT (04-prototype-delta.md §5b) ─────────────────────────
 * Region and whole-company scope offer an axis selector because at that width the
 * reader is exploring. A cost-centre owner is not: they own exactly two things —
 * the BUDGETS the money went to and the PEOPLE who spent it — and toggling
 * between the only two questions they hold is friction. So both render at once,
 * side by side on a wide screen and stacked on a narrow one, each reusing the
 * SAME DriversTable every other scope reads.
 *
 * NEITHER LIST TRUNCATES. At one cost centre the list IS the population: a
 * ranked top-N hides the budget or the person the owner opened the page to find,
 * and the folded "(all other — N)" row is not something they can act on. The
 * budget axis reads the seam's UNCAPPED population variant
 * (`completeProjectAxisPopulation`) rather than a raised cap, so the ranked seam
 * keeps its meaning on every exploratory surface; the people axis was never
 * capped. DriversTable renders every row it is given.
 *
 * TWO DENOMINATORS, AND THEY DIFFER BY CONSTRUCTION. `budgets` foots to Σ of
 * this centre's own projects; `people` foots to the centre's BURN. Each list is
 * rendered against its OWN headline — see the note each carries.
 */
import { computed } from 'vue'
import InfoDot from '../../ui/InfoDot.vue'
import DriversTable from '../DriversTable.vue'
import {
  projectDrillTarget,
  dimFact, teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
  type DrillTarget,
} from '../drill-contract'
import ExportCsvButton from '../ExportCsvButton.vue'
import CcOverSoftCap from './CcOverSoftCap.vue'
import TierExposureCard from '../TierExposureCard.vue'
import { fmtUsd } from '../../../composables/useFormat'
import { BUDGET_LABEL, BUDGET_LABEL_PLURAL, BU_LABEL_LOWER, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'
import type { DriverRow } from '#shared/reports/types'
import type { CostCentreDrill } from './cost-centre-view-types'

const props = withDefaults(
  defineProps<{
  drill: CostCentreDrill
  /** Params/filename for the over-the-soft-cap card's own CSV (report=over-soft-cap). */
  overSoftCapExportParams?: Record<string, string | number | boolean | null | undefined>
  overSoftCapExportFilename?: string
  /** Export params for the BUDGETS hero (`axis=project`). */
  budgetsExportParams: Record<string, string | number | boolean | null | undefined>
  budgetsExportFilename: string
  /** Export params for the PEOPLE hero (`axis=teammate`). */
  peopleExportParams: Record<string, string | number | boolean | null | undefined>
  peopleExportFilename: string
  /** THE DRILL CONTRACT (D29/D30) — from the container; fail-closed defaults. */
  drillGrants?: DrillGrants
  drillWindow?: Omit<DrillFrame, 'src'>
  /**
   * The reader's selected lane, PASSED IN rather than read from the store.
   * CcDrill is mounted by a view that already knows it, and reaching for
   * `useReportState()` here made the component un-mountable in every unit test
   * that does not stub Nuxt's auto-imports — 32 of them, none about lanes.
   * A prop keeps the component pure and the failure visible at the call site.
   */
  lane?: 'usage' | 'chargeback'
  }>(),
  {
    // These two were optional before this component gained defaults at all;
    // naming them keeps the shape explicit rather than implicitly undefined.
    overSoftCapExportParams: undefined,
    overSoftCapExportFilename: undefined,
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
    lane: 'usage',
  },
)

/*
 * THE DRILL CONTRACT (D29, fix 7). This drill's frame is the cost centre it is
 * open on — `cc:{id}` — so a name opened from here computes over exactly the
 * population these rows were ranked in (C14). The two heroes are fixed axes, so
 * each gets its own decision function rather than one switching on a pivot that
 * does not exist here.
 */
/*
 * THE DRILL IS §A BY CONSTRUCTION, AND MUST SAY SO WHEN THE READER IS NOT.
 * The lane toggle is back at this scope (owner 2026-08-06): the headline above
 * switches to the centre's `chargeUsd`, which every card already carries. These
 * two tables do NOT have a §B equivalent — they compute usage burn — so in the
 * chargeback lens they keep showing §A and declare it. Silently leaving them
 * unlabelled is what would let a reader foot §A drivers against a §B headline,
 * which is the mixing `Reporting.md` §1 forbids. Building §B drivers is a real
 * slice and is not this fix.
 */
const chargebackLens = computed(() => props.lane === 'chargeback')

const drillGrants = computed(() => props.drillGrants)
const drillFrame = computed<DrillFrame>(() => ({
  ...props.drillWindow,
  src: `cc:${props.drill.cc.id}`,
}))
function budgetsDrillable(row: DriverRow): DrillTarget | null {
  return projectDrillTarget(drillGrants.value, row.dims?.project_code ?? null, drillFrame.value)
}
function peopleDrillable(row: DriverRow): DrillTarget | null {
  if (row.key.startsWith('__null')) return null
  return teammateDrillTarget(
    drillGrants.value,
    {
      id: row.key,
      isActive: dimFact(row.dims, 'teammate_active'),
      // Server-carried (r4-H2): an unconfirmed shadow identity 403s at the
      // destination, so its row is a NAME, never a door.
      isProvisional: dimFact(row.dims, 'teammate_provisional'),
    },
    drillFrame.value,
  )
}
/*
 * The exposure card names the window it was GIVEN, and that is the DRILL's active
 * window (month or custom range) — not the rolling band below, which is a
 * different frame with its own label. Taken from `meta.range` when the caller set
 * one, else the month, so the card never claims a window nothing on it was
 * computed over. (This comment used to say "the cost-centre page has no rolling
 * band"; it has one now, which is exactly why the distinction matters.)
 */
const windowLabel = computed(() =>
  props.drill.meta.range
    ? `${props.drill.meta.range.from} → ${props.drill.meta.range.to}`
    : props.drill.meta.month,
)

// Provider-split slices — registry lane KEYS so colorForKey resolves the
// validated hues through the lane registry (Claude Code = brand-hunger magenta,
// GitHub Copilot = brand-vision blue, Other = carbon-3), not name-fuzzing.
// "Claude Code" (V6 honest labelling): this §A burn IS the claude-code tool —
// the non-Code Claude surfaces never carry a per-CC usage burn.
/*
 * Colour follows the VENDOR, never its position in the list — the same rule the
 * lane palette states, so a centre with no Copilot spend does not repaint Claude.
 * Keyed on this card's own slice ids rather than `Vendor`, because the slices are
 * a three-way roll-up (claude / copilot / everything else), not a lane id.
 */
const VENDOR_BAR_COLOR: Record<string, string> = {
  'claude-code': 'var(--lane-claude)',
  'copilot-cli': 'var(--lane-copilot)',
  'other': 'var(--lane-other)',
}
/** Share of the vendor total — its own denominator, not the burn. */
function vendorPct(value: number): number {
  const total = vendorSlices.value.reduce((a, s) => a + s.value, 0)
  return total > 0 ? (value / total) * 100 : 0
}

const vendorSlices = computed(() => {
  const v = props.drill.vendor
  return [
    // "Anthropic", not "Claude Code": the slice carries EVERY Anthropic surface
    // (CLAUDE_FAMILY_TOOLS — chat, Cowork, Office, Design …), so naming it after
    // one tool told a reader whose spend is chat that their money sat in a
    // product they have never opened. See server/reporting/vendor-split.ts.
    { name: 'Anthropic', key: 'claude-code', value: v.claudeUsd },
    { name: 'GitHub Copilot', key: 'copilot-cli', value: v.copilotUsd },
    { name: 'Other', key: 'other', value: v.otherUsd },
  ].filter((s) => s.value > 0)
})

/*
 * ── NO RANKED-BAR CHART ABOVE EITHER HERO, AND THAT IS THE TRUNCATION FIX ────
 * Both heroes used to render a `ChartRankedBar` with `top-n="10"` above a
 * `DriversTable` that already carries a share-of-spend bar in every row. Two
 * things were wrong with it and one fix removes both:
 *
 *   - IT TRUNCATED. `R:628-630` — *"Neither list is a 'top N'. At 14 people and
 *     9 projects the list IS the population — truncating it would hide the
 *     person the owner came to find."* The tables were already uncapped
 *     end-to-end (`completeProjectAxisPopulation` server-side); the chart above
 *     them quietly showed ten and nothing said so.
 *   - IT WAS A SECOND RENDERING OF ONE RANKING. `DriversTable`'s own header
 *     says it: *"A caller that renders it is a caller that no longer needs a
 *     separate ranked chart above the table"* — the whole-company Top-drivers
 *     card dropped one on that basis. `R:902-907`: two places rendering one
 *     fact will eventually diverge.
 *
 * The prototype's hero is exactly one bar list (`R:781-797`): label, share
 * track, this month, and one right-hand column. That is the table.
 */
const hasAllocation = computed(() => props.drill.allocationUsd > 0)

// Allocation set but zero burn — the $0 is "nothing tagged here", not "no data".
const zeroBurnTagged = computed(() => hasAllocation.value && props.drill.burnUsd === 0)
</script>

<template>
  <div data-testid="cc-drill-data" class="space-y-6">
    <!-- Breadcrumb — A TRAIL, NOT A DOOR OUT (external review B1).
         "Cost centres" used to be a button that set `?cc=` to null, which is the
         only way a reader could reach the unscoped multi-centre grid. The
         prototype ruling is absolute: *"The Cost-centre tab lands ON a cost
         centre. There is no unscoped state, and never was."* (`R:551-559`.) A
         control whose only outcome is a forbidden state is not a control, so the
         crumb is now what it always described: a label saying where you are.
         Switching centres is `CcScopeLine`'s selector, and only when there is
         more than one to switch between. -->
    <nav class="text-[12px] text-carbon-3" aria-label="Breadcrumb" data-testid="cc-drill-crumb">
      <span class="font-semibold">{{ BU_LABEL_PLURAL }}</span>
      <span class="mx-1.5">›</span>
      <span class="text-carbon-1 font-semibold">{{ drill.cc.displayName }}</span>
      <span class="text-carbon-3"> · {{ drill.cc.regionCode.toUpperCase() }}</span>
    </nav>

    <!-- The homing rule, stated the way the lane actually works: `cost_owning_unit_id`
         is the TAGGED PROJECT's cost centre on the emitted arm, and the SPENDER's
         CURRENT centre on the untaggable provider arm (the current-org lens). It is
         not "where usage was emitted" — a teammate placed in another centre who tags
         this centre's project lands here, and the same teammate's Claude-chat usage
         lands in their own centre no matter whose project they work on. -->
    <!-- The one fact a reader is misled without: the people below are ranked by
         what homed HERE, not by what they spent. The two mechanisms that put money
         here, the cross-charge comparison and the pointer to the Finance tab were
         all methodology and navigation; they live in the comment above. -->
    <p class="text-[11px] text-carbon-3 italic" data-testid="cc-drill-lane-note">
      Burn = usage <span class="font-semibold not-italic">homed to this {{ BU_LABEL_LOWER }}</span> —
      <span class="font-semibold not-italic">not</span> a person's total usage.
      <span v-if="chargebackLens" data-testid="cc-drill-lane-mismatch">
        The headline above is what this {{ BU_LABEL_LOWER }} is
        <span class="font-semibold not-italic">charged</span>; the two tables below
        stay on <span class="font-semibold not-italic">attributed usage</span>,
        because there is no chargeback breakdown of who drove a charge. They do not
        add up to it, and are not meant to.
      </span>
    </p>

    <!--
      THE HEADLINE FOLLOWS THE LANE (external review, 2026-08-06).
      In §A it is the usage BURN and matches the tracker row. In §B it is what
      the centre is CHARGED — the same figure its card in the list carries.

      It used to render `burnUsd` in BOTH lanes, so the restored toggle changed
      nothing here and the note below called the §A burn "the billed figure
      above". A control that cannot change anything teaches readers to ignore
      controls, and the note was simply false. One figure fixes both.

      The two are never summed and never shown side by side: different lanes
      over different bases (contract C2).
    -->
    <div
      class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
      data-testid="cc-burn-headline"
    >
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3">
        {{ chargebackLens ? 'Charged' : 'Burn' }}
      </span>
      <span
        class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums text-carbon"
        :data-testid="chargebackLens ? 'cc-charge-figure' : 'cc-burn-figure'"
      >
        {{ fmtUsd(chargebackLens ? drill.chargeUsd : drill.burnUsd) }}
      </span>
      <!--
        The pooled Copilot charge is MONTHLY, so a non-month-aligned window cannot
        slice it and omits it. Saying so is the difference between a smaller
        number and a wrong one.

        WORDED AS A PROPERTY OF THE WINDOW, NOT OF THIS CENTRE (external review,
        round 2). The flag means "chargeback is on AND the range is not
        month-aligned" — it does NOT know whether this centre has a Copilot pool
        row at all. "Any Copilot charge is excluded" is true either way; "the
        figure is missing Copilot money" would be false for a centre that has none.
      -->
      <span
        v-if="chargebackLens && drill.copilotChargebackPartialMonth"
        class="text-[12px] text-carbon-2"
        data-testid="cc-charge-partial-month"
      >
        Anthropic charge only — Copilot's pooled charge is monthly, so any share of
        it is excluded over a partial-month range.
      </span>
      <!-- DERIVED, and it says so: the budgeted unit of account is the project, so
           a cost-centre allocation is the roll-up of its projects' budgets, never a
           budget anyone set on the centre. -->
      <span v-if="hasAllocation" class="text-[12px] text-carbon-2">
        of <span class="font-semibold tabular-nums">{{ fmtUsd(drill.allocationUsd) }}</span>
        allocated — <span class="italic">derived</span>, the roll-up of this {{ BU_LABEL_LOWER }}'s
        {{ BUDGET_LABEL_PLURAL.toLowerCase() }}
      </span>
      <span v-else class="text-[12px] text-carbon-3">no budget set for this {{ BU_LABEL_LOWER }}</span>
      <span v-if="zeroBurnTagged" class="text-[11px] text-carbon-3 italic" data-testid="cc-drill-no-tagged">
        no tagged usage — burn counts only project-tagged usage
      </span>
    </div>

    <!--
      THE PROVIDER FRESHNESS BAR IS GONE FROM THIS PAGE (UX pass, owner
      2026-08-06). The header already states settlement once — the "Settling" and
      "Coverage unknown" chips beside the scope line — and this row repeated it
      per provider with raw ISO instants ("provisional until
      2026-08-31T00:00:00.000Z"), which is developer output, not operator
      information. Its only effect here was to sit between the headline and the
      one card on this page that names a person and hands the owner a verb.
      The component is untouched and still used where a per-provider clock is the
      point; this page is not that place.
    -->

    <!-- Above the breakdowns, because it is the part that is NOT accounted for.
         Everything below this card decomposes spend that already has a project on
         it; this is the spend that does not, and it is ROSTER-anchored (the people
         placed here) rather than burn-anchored — the card states that denominator
         itself, so it is never read as a slice of the burn above. -->
    <CcOverSoftCap
      :data="drill.overSoftCap"
      :export-params="overSoftCapExportParams"
      :export-filename="overSoftCapExportFilename"
      :drill-grants="props.drillGrants"
      :drill-frame="drillFrame"
    />

    <!-- Burn-by-vendor donut (Copilot pooled NULL-CoU is excluded — usually ~100% Claude) -->
    <section
      v-if="vendorSlices.length"
      class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5"
      data-testid="cc-drill-vendor-split"
    >
      <div class="flex items-baseline gap-2">
        <div class="text-sm font-semibold text-carbon-1">Burn by vendor</div>
        <!-- The Copilot exclusion is a real caveat and it stays — but it is an
             answer to "why is Copilot not here", which a reader only asks after
             noticing. Behind the (i), per the dashboard-prose rule. -->
        <InfoDot label="About burn by vendor">
          This is the attributed-usage burn, never the billed chargeback figure. Copilot
          pooled usage carries no {{ BU_LABEL_LOWER }}, so it is outside this burn — a
          reader can see that money elsewhere and cannot find it here.
        </InfoDot>
      </div>
      <!--
        A DONUT WAS THE WRONG MARK. This is typically two segments — one vendor at
        ~95% and an "Other" tail — and a two-segment donut is a sentence drawn as a
        graphic: it costs a full card to say something a single bar says in one
        line. A thin stacked bar carries the same shape, scales honestly if a third
        vendor ever appears, and gives the row back to the cards that need it.
      -->
      <div class="mt-3 flex h-[18px] w-full overflow-hidden rounded" data-testid="cc-drill-vendor-bar">
        <i
          v-for="s in vendorSlices"
          :key="s.key"
          class="block h-full"
          :style="{ width: vendorPct(s.value) + '%', background: VENDOR_BAR_COLOR[s.key] }"
          :title="`${s.name} ${fmtUsd(s.value)}`"
        />
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-carbon-2 tabular-nums">
        <span v-for="s in vendorSlices" :key="s.key" class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-[2px]" :style="{ background: VENDOR_BAR_COLOR[s.key] }" />
          {{ s.name }} {{ fmtUsd(s.value) }} · {{ Math.round(vendorPct(s.value)) }}%
        </span>
      </div>
    </section>

    <!-- ═══ THE TWO HEROES — side by side wide, stacked narrow ═══
         BUDGETS LEADS. The unit of account is the budgeted project (decisions
         D1); the person view is the second question, never the first. Ordering
         is what decides that here, now that there is no axis default to carry
         it. -->
    <div class="grid gap-5 lg:grid-cols-2 items-start" data-testid="cc-drill-heroes">
      <!-- ── Hero 1: BUDGETS ─────────────────────────────────────────────── -->
      <section
        class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5 space-y-4 min-w-0"
        data-testid="cc-hero-budgets"
      >
        <!--
          THE CARD BODY CARRIES DATA; THE PROSE OPENS ON DEMAND (owner ruling,
          restated 2026-08-06). This hero used to stack THREE explanatory lines
          plus DriversTable's own lane caveat before the reader reached a number.
          Every one of them is a true and load-bearing claim — the clamp, the
          denominator, the lane — which is why they move rather than die: a
          cost-centre owner scanning for what needs them should not have to read
          four sentences first, but the moment they try to add these totals to the
          burn above, the answer must be one hover away.
        -->
        <div class="flex items-baseline gap-2">
          <div class="text-sm font-semibold text-carbon-1">{{ BUDGET_LABEL_PLURAL }}</div>
          <InfoDot :label="`About ${BUDGET_LABEL_PLURAL.toLowerCase()}`">
            <span data-testid="cc-hero-budgets-note">
              Every {{ BUDGET_LABEL.toLowerCase() }} this {{ BU_LABEL_LOWER }} owns that carried spend,
              against its own allocation — each budget's spend, for the budgets
              <span class="font-semibold">this {{ BU_LABEL_LOWER }} owns</span>.
            </span>
            <!-- The denominator caveat belongs in the SAME popover as the clamp
                 that causes it: a reader who wants one wants the other, and it is
                 only asked at the moment someone tries to add these rows to the
                 burn. Leaving it on the face was the last of the three lines
                 standing between the title and the first number. -->
            <span class="mt-1.5 block" data-testid="cc-drill-project-axis-note">
              {{ BUDGET_LABEL_PLURAL }} total {{ fmtUsd(drill.budgets.headlineUsd) }} on their own
              denominator — the {{ fmtUsd(drill.burnUsd) }} burn above is not meant to match it.
            </span>
          </InfoDot>
        </div>
        <!-- The project axis has its OWN denominator and must say so, or the rows
             read as failing to add up to the burn above. -->
        <!-- ONE LINE, naming both figures. The four sentences that used to follow
             it explained WHY the two denominators differ (budget homing vs usage
             homing, reconciled usage, unconfirmed bindings) — that is the axis's
             mechanism and it lives in engine/budget-axis.ts. What a reader needs is
             that the two numbers are not meant to match. -->
        <!--
          WORDED SO IT SURVIVES THE TWO FIGURES COINCIDING. This used to read "a
          DIFFERENT figure from the $X burn above" — which, on any period where
          the two denominators happen to land on the same number, printed the same
          value twice and asserted they differed. Observed on the July demo data
          (both $15,667.21), where it reads as a broken sentence rather than a
          caveat. The claim that does real work is that they are not REQUIRED to
          match; whether they happen to is data, not a contract.
        -->
        <!-- NOT "headline": these rows are each project's own total across every
             cost centre, which is the right operand for "against budget" and is
             not this page's $X burn. Naming it stops the footer asserting a
             reconciliation to a figure it is not reconciling to. -->
        <DriversTable
          :rows="drill.budgets.rows"
          :headline-usd="drill.budgets.headlineUsd"
          sumback-label="these projects' own totals"
          :denominator-label="drill.budgets.denominatorLabel"
          :label-column-label="BUDGET_LABEL"
          :value-column-label="windowLabel"
          :drillable="budgetsDrillable"
        />
        <div class="flex justify-end">
          <ExportCsvButton
            endpoint="/api/v1/reports/export"
            :params="budgetsExportParams"
            :filename="budgetsExportFilename"
          />
        </div>
      </section>

      <!-- ── Hero 2: PEOPLE ──────────────────────────────────────────────── -->
      <section
        class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5 space-y-4 min-w-0"
        data-testid="cc-hero-people"
      >
        <!-- Same rule as the Budgets hero: the clamp is the claim, and it belongs
             one hover away rather than three lines above the first number. -->
        <div class="flex items-baseline gap-2">
          <div class="text-sm font-semibold text-carbon-1">People</div>
          <InfoDot label="About people">
            <span data-testid="cc-hero-people-note">
              Everyone whose spend homed to this {{ BU_LABEL_LOWER }} — each person's spend
              <span class="font-semibold">homed to this {{ BU_LABEL_LOWER }}</span>, not their total usage.
            </span>
          </InfoDot>
        </div>
        <!--
          MODEL TIER — REAL, and shipping (F5). The previous note here said this
          column needed a `model_catalog.tier` primitive "that does not exist".
          IT ALWAYS EXISTED: `model_catalog` is migration 0046, `tier` is
          CHECK-constrained (`0046:128`) and seeded (`0046:138-146`), and two
          engines already join it. What was missing was the DRILL's own server
          measure — `fetchCostCentreTeammateTierMix`, which now resolves each
          model through `resolveTier` (the same function the frontier-share
          detector uses, so the two can never publish different frontier shares)
          and lands an unknown model in `unclassified` as a band of its own.

          The BANDING is still never this component's, and never DriversTable's:
          absence of `tierBreakdown` on a row means "no banded spend for this
          person", which the table renders as "not available" — never as "no
          frontier usage".
        -->
        <!-- These rows sum to the §A burn, which IS the headline under the usage
             lens and is NOT under chargeback — where the caveat above already
             says the tables "do not add up to it, and are not meant to", while
             this footer claimed a reconciliation to it. Naming the base instead
             of the position is true in both lenses and needs no lane branch;
             it also echoes this table's own "share of cost-centre burn". -->
        <DriversTable
          :rows="drill.people.rows"
          :headline-usd="drill.people.headlineUsd"
          :sumback-label="drill.people.denominatorLabel"
          :denominator-label="drill.people.denominatorLabel"
          label-column-label="Person"
          :value-column-label="windowLabel"
          :drillable="peopleDrillable"
        />
        <div class="flex justify-end">
          <ExportCsvButton
            endpoint="/api/v1/reports/export"
            :params="peopleExportParams"
            :filename="peopleExportFilename"
          />
        </div>
      </section>
    </div>

    <!-- §B, and it is NOT part of the burn above. The burn is usage-basis
         (`v_complete_usage`); this is provider-billed (`provider_usage_fact`)
         banded by model tier. The two answer different questions and are never
         summed (consistency contract C2) — which is why the card carries its own
         heading rather than becoming another cut of the drill's drivers. -->
    <!--
      RESTORED, AND GATED TO THE LANE IT BELONGS TO.

      This card was removed from the cost-centre page by 1ac6a8fd (PR #238). The
      objection was real: a §B BILLED card ("Billed spend banded by the choice")
      on a page whose pill reads "§A · usage lane", and on the July capture it
      spent a full-width block printing "Not banded yet — no Anthropic rows in the
      normalised layer. This is not $0." twice.

      But DELETION was not the answer the objection called for, and it cost more
      than it fixed: the approved prototype draws this card on this scope
      (docs/design/reporting-consolidation/prototype.html, the unconditional tail
      after BAND 2), the removal was recorded only in a comment at its own site,
      and the artefact went on saying otherwise. The owner reasonably believed the
      product matched the drawing they signed off.

      The page HAS a lane toggle, and rule 11 is explicit that a cost-centre owner
      needs both halves of the job — "am I on track" is §B, "what is driving it"
      is §A. So the card renders under the CHARGEBACK lane, where a billed answer
      is the question being asked. That satisfies the lane objection exactly,
      without the artefact and the build disagreeing about what the page is.

      The empty-state complaint is a separate, smaller defect and belongs to the
      card (it should not fill a block to say nothing) — not a reason to delete a
      surface from one scope.
    -->
    <TierExposureCard
      v-if="chargebackLens"
      :exposure="drill.exposure"
      :window-label="windowLabel"
      data-testid="cc-tier-exposure"
    />
  </div>
</template>
