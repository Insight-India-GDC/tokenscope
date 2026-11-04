<script setup lang="ts">
/*
 * ScopeCostCentreView — the Cost-Centre reporting scope, rebuilt as a ranked
 * BUDGET TRACKER (reporting-redesign wave B). Answers "which cost-centres are
 * burning fastest, and which are at budget risk?" — replacing the old card-wall
 * of near-identical "$X of no allocation / on track within budget" tiles.
 *
 * PURE + prop-driven (fetches + URL state live in the ScopeCostCentre container),
 * so every render state is unit-testable without a Nuxt runtime. Matches the
 * Across flagship's design language: a persistent header (title + ONE settling
 * chip + DateRangeControl), hairline KPI tiles, section cards, the branded chart
 * kit (never hand SVG), and the fixed provider palette (Claude = magenta, Copilot
 * = blue — never purple).
 *
 * The body renders exactly ONE of skeleton / error / empty / data — independently
 * for the GRID (no `cc`) and the DRILL (`cc` set). The header (with the date
 * control) persists across states so the range stays adjustable mid-fetch.
 *
 * THE §A SPINE, and a §B lane beside it. The tracker's card burn and the drill
 * both read the project-CoU USAGE axis (`v_complete_usage WHERE cost_owning_unit_id`),
 * so drilling a row shows WHO/WHAT is burning that budget and reconciles to the
 * tracker figure. The CHARGEBACK lane re-lenses the headline to §B and adds
 * Behavioural exposure; the two are never summed (contract C2). The invoice-grade
 * chargeback REPORT still lives only in the Finance tab.
 *
 * TWO BANDS, TWO WINDOWS. Band 1 is the month (hero + four tiles + coverage);
 * band 2 is a ~60-day rolling frame ending at the SETTLED edge, fetched
 * separately and rendering its own states. They do not sum into each other and
 * each says so.
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import DateRangeControl from './DateRangeControl.vue'
import LaneToggle from './LaneToggle.vue'
import ScopeHero from './ScopeHero.vue'
import ReportBand from './ReportBand.vue'
import ActiveUsersTrendCard from './across/ActiveUsersTrendCard.vue'
import SpendTrendCard from './across/SpendTrendCard.vue'
import SpendPerDeveloperCard from './SpendPerDeveloperCard.vue'
import SurfaceHeroCard from './SurfaceHeroCard.vue'
import { buildRegionalTrend } from './regional/build-regional-trend'
import { buildSurfaceHero } from './build-surface-hero'
import CcHeaderNotes from './cost-centre/CcHeaderNotes.vue'
import CcScopeLine from './cost-centre/CcScopeLine.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import CcKpiTile from './cost-centre/CcKpiTile.vue'
import CcBudgetTable from './cost-centre/CcBudgetTable.vue'
import CcProjectTable from './cost-centre/CcProjectTable.vue'
import {
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from './drill-contract'

import CcDrill from './cost-centre/CcDrill.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { ReportLane } from '../../composables/useReportState'
import type { ProviderState } from '#shared/reports/types'
import type { CostCentreCard as PnlCostCentreCard } from '#shared/schemas/cost-centres'
import type { CostCentreReport, CostCentreDrill, CostCentreTrend } from './cost-centre/cost-centre-view-types'
import { BU_LABEL, BU_LABEL_LOWER, BU_LABEL_LOWER_PLURAL, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

const props = withDefaults(
  defineProps<{
    report: CostCentreReport | null
    /**
     * The cost centres the VIEWER OWNS, with their lead projects and budgets
     * (`GET /me/cost-centres`) — the scope's primary table. Null while loading;
     * empty for a viewer who owns nothing (ownership is a relationship, not a
     * role), in which case the section is simply absent.
     */
    owned?: PnlCostCentreCard[] | null
    /** Human label for the window the owner table's figures cover. */
    ownedWindowLabel?: string
    /** True while the owner payload is in flight (distinct from "owns nothing"). */
    ownedPending?: boolean
    /**
     * The owner fetch's failure, if any. Rendered as an ERROR — silently showing
     * no section would make a 500 or a lost authorisation indistinguishable from
     * a correct "you own no cost centres".
     */
    ownedError?: unknown
    drill: CostCentreDrill | null
    /*
     * BAND 2's payload, over its OWN rolling window — see CostCentreTrend. Null
     * while in flight or on failure; the band renders its own states rather than
     * borrowing the drill's, because the two fetches fail independently and a
     * dead trend must not blank a healthy month band.
     */
    trend?: CostCentreTrend | null
    trendPending?: boolean
    trendError?: unknown
    /** The rolling band's window, in words — the cards echo it in their subtitles. */
    trendWindowLabel?: string
    /** True while `?cc=` is set — the drill drives the four states, not the grid. */
    isDrill: boolean
    pending: boolean
    error?: unknown
    drillPending: boolean
    drillError?: unknown
    /** The active lens — grid re-lenses burn (§A) ⇄ chargeback (§B); the burn drill stays §A. */
    lane?: ReportLane
    /** Grid export params (report=cards). */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
    /** Over-the-soft-cap card export params (report=over-soft-cap). */
    overSoftCapExportParams?: Record<string, string | number | boolean | null | undefined>
    overSoftCapExportFilename?: string
    /** Drill export params — ONE PER HERO (report=drivers, axis=project|teammate). */
    budgetsExportParams: Record<string, string | number | boolean | null | undefined>
    budgetsExportFilename: string
    peopleExportParams: Record<string, string | number | boolean | null | undefined>
    peopleExportFilename: string
    /*
     * THE DRILL CONTRACT (D29/D30, fix 7) — supplied by the container. The scope
     * TOKEN is built per cost centre where the rows are: this scope renders
     * several centres at once, so one token for the whole surface would echo the
     * wrong centre on every section but one, and "back" would restore the wrong
     * report.
     */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
  }>(),
  {
    error: undefined,
    drillError: undefined,
    overSoftCapExportParams: undefined,
    overSoftCapExportFilename: undefined,
    lane: 'usage',
    owned: null,
    ownedWindowLabel: '',
    ownedPending: false,
    ownedError: undefined,
    trend: null,
    trendPending: false,
    trendError: undefined,
    trendWindowLabel: '',
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
  },
)

const isChargeback = computed(() => props.lane === 'chargeback')

/*
 * ── BAND 2's two derived inputs ──────────────────────────────────────────────
 *
 * The spend trend is built with forecast NULL and month NULL, and that is the
 * prototype's own rule rather than an omission: "Run-rate to month end is a
 * month statement — it sits on the Attributed usage tile above, not in a rolling
 * frame." A dashed projection tail on a 60-day rolling window would be pacing a
 * frame that has no month end to pace to.
 *
 * Both guard on `trend.window`: a null trend (in flight, or a failed fetch) must
 * yield null rather than feed an empty date into the builders, which is how the
 * sibling scope threw a RangeError.
 */
const ccTrendSeries = computed(() =>
  props.trend ? buildRegionalTrend(props.trend.series, null, null).series : [],
)
const surfaceHero = computed(() =>
  props.trend?.window
    ? buildSurfaceHero(props.trend.usageWeeklyLanes ?? [], {
        from: props.trend.window.from,
        to: props.trend.window.to,
        today: props.trend.window.to,
      })
    : null,
)

/*
 * The owner's project table leads the grid — the unit of account is the budgeted
 * project (decisions D1), so a cost-centre owner opens on "which project is
 * burning my budget", not on a list of the people who spent.
 *
 * Suppressed in chargeback mode: every figure on it is §A burn against a §A
 * allocation, and re-lensing the page to the bill lane does not re-lens them.
 * Showing budget positions beside a chargeback total would read as if the two
 * were the same money.
 */
const ownedCentres = computed<PnlCostCentreCard[]>(() => props.owned ?? [])
/*
 * THREE outcomes, told apart. "Owns nothing" is silence; a FAILED fetch is an
 * error banner; an in-flight fetch is a skeleton. Collapsing the first two — the
 * shape this shipped in — makes a 500, an expired session or a revoked ownership
 * grant read as the correct answer "you own no cost centres", which is the one
 * reading an owner has no way to challenge.
 */
const ownedErr = computed(() => !isChargeback.value && Boolean(props.ownedError))
const ownedLoading = computed(
  () => !isChargeback.value && props.ownedPending && props.owned == null && !props.ownedError,
)
const showOwnedProjects = computed(
  () => !isChargeback.value && !ownedErr.value && ownedCentres.value.length > 0,
)

const emit = defineEmits<{
  drill: [ccId: string]
}>()

/*
 * ── THE SCOPE LINE (F5 D23) ──────────────────────────────────────────────────
 * Rendered in the header, in BOTH states. The label is the SERVER's
 * (`report.scope`, derived from the resolver that clamped the cards) — never
 * composed here from `?cc=`, which would let the page name a scope the server
 * did not serve.
 */
const scope = computed(() => props.report?.scope ?? null)
const selectedCcId = computed(() => props.drill?.cc.id ?? null)

/*
 * ── Grid: exactly one of skeleton / error / empty / data ─────────────────────
 *
 * EXHAUSTIVE, not merely mutually exclusive — the four states must COVER every
 * prop combination. `report === null` with `pending === false` and no error is a
 * REAL state: it is what Nuxt reports on the server pass for the container's
 * `useFetch(..., { lazy: true, server: false })`, where the fetch is deliberately
 * not run during SSR. Keying the skeleton on `pending` made all four branches miss
 * in that state and the body rendered NOTHING — the header (which lives in this
 * view) painted its title, lane toggle and date control above an empty page, and
 * hydration then mismatched against the client's skeleton.
 *
 * So the skeleton is keyed on the ABSENCE OF DATA, never on an in-flight flag.
 * `pending` stays the container's honest in-flight marker (and keeps already-loaded
 * cards on screen across a refetch), but it can no longer be the difference between
 * a body and a blank page.
 */
const gridError = computed(() => Boolean(props.error))
const gridSkeleton = computed(() => !gridError.value && !props.report)
const gridEmpty = computed(() => Boolean(props.report) && props.report!.cards.length === 0)
const gridData = computed(() => Boolean(props.report) && !gridError.value && !gridEmpty.value)

// ── Drill: exactly one of skeleton / error / empty / data ────────────────────
// Same exhaustiveness rule as the grid above — a null drill with nothing in
// flight is the loading state, not a fifth (blank) branch.
const drillErr = computed(() => Boolean(props.drillError))
const drillSkeleton = computed(() => !drillErr.value && !props.drill)
/*
 * "Empty" must be empty of EVERY answer the drill carries — and this predicate was
 * independently tightened twice, by two tracks that could not see each other. Both
 * reasons are real and BOTH conjuncts are load-bearing:
 *
 *  - The over-the-soft-cap card is ROSTER-anchored, so it has an answer in exactly
 *    the case the burn does not: a cost centre whose people spend but tag nothing
 *    carries $0 burn (`cost_owning_unit_id` is the TAGGED project's cost centre, and
 *    the reconciled arm is NULL there by construction) while its roster is over the
 *    cap. Gating on burn alone rendered "No burn for this cost centre yet" — hiding
 *    the unallocated money on the grounds that it was unallocated.
 *  - The BUDGETS hero can carry rows the burn axis cannot: arm-2 money has a real
 *    `project_id` with a NULL `cost_owning_unit_id`, so a centre with budget rows and
 *    no burn still has something to show.
 *
 * `rosterUsd === 0` rather than `over.length === 0`: a roster that genuinely consumed
 * nothing IS an empty period, and "all within allowance" would be true but pointless
 * to render over it.
 */
/*
 * DOES THE ROLLING BAND BELOW ACTUALLY HAVE MONEY IN IT?
 *
 * Band 2 fetches its own ~60-day window and renders independently of Band 1, so
 * a quiet month cannot hide a healthy trend. Correct — but only half the
 * problem, and shipping the half made the page worse than before Band 2 existed:
 * on Dev it announced "No usage recorded for CTO in this period" with sixty days
 * of spend charts drawn directly underneath.
 *
 * The first fix SUPPRESSED the empty state whenever the band had money. An
 * external review pointed out that trades one lie for another: a genuinely
 * empty July, viewed while the rolling window holds June and August, would
 * render a full zero-valued drill instead of saying so. Both readings are then
 * wrong, in opposite directions.
 *
 * So the empty state STAYS — it is true about the period — and instead it
 * ACKNOWLEDGES the band. The contradiction was never the zero; it was the zero
 * pretending nothing else was on the page.
 *
 * The test is MONEY, not the payload's existence: a loaded-but-flat trend has
 * nothing to acknowledge.
 */
const trendHasSpend = computed(() => (props.trend?.series ?? []).some((p) => Number(p.value) > 0))

const drillEmpty = computed(
  () =>
    Boolean(props.drill) &&
    props.drill!.burnUsd === 0 &&
    /*
     * §B IS A FIFTH CONJUNCT, added with `chargeUsd` itself. The drill now
     * renders a CHARGE in the chargeback lane, so a centre that is billed but
     * has no §A burn — Copilot-pooled money homed here with nothing attributed,
     * the exact shape §A and §B are separate to express — would otherwise hit
     * "No usage recorded for X" while X is charged real money.
     *
     * This is the same mistake the burn-only gate made before the roster arm was
     * added: gating an empty state on ONE lane and calling it empty overall.
     */
    props.drill!.chargeUsd === 0 &&
    props.drill!.budgets.rows.length === 0 &&
    props.drill!.people.rows.length === 0 &&
    props.drill!.overSoftCap.rosterUsd === 0,
)
const drillData = computed(() => Boolean(props.drill) && !drillErr.value && !drillEmpty.value)

/*
 * THE EMPTY STATE NAMES THE BU AND REPORTS WHAT IT MEASURED. IT NEVER STATES A
 * CAUSE.
 *
 * The header's `CcScopeLine` names the BU, but this is the ONE state with no
 * figure, table or chart to orient on, so the name is load-bearing here.
 *
 * ── WHY THE CAUSAL CLAIM CAME OUT (owner, Dev, 2026-08-10) ───────────────────
 * This used to branch on `rosterCount` and, when it was 0, assert: "No active
 * teammates are placed in this cost centre, SO there is no usage to report."
 * The owner of a BU hit that sentence while looking at the BU they own, having
 * spent $4,666.97 that month. Both halves failed at once:
 *
 *   · THE FACT was about placement, not about them. They were homed on the
 *     REGION DEFAULT BU — the dumping ground admin flags as "N of M do not
 *     belong here" — so the roster was genuinely empty while the person reading
 *     the page was, in every sense that matters, in the BU.
 *   · THE CAUSATION was false regardless. Burn is project-homed: a BU with a
 *     zero roster still has usage if a tagged project homes to it, and a fully
 *     staffed BU shows nothing if its people's projects home elsewhere. Roster
 *     size does not cause the total. (`00-epic-design.md` S1 says exactly this;
 *     it was written two days before this shipped and I did not read it.)
 *
 * So the rule now: STATE WHAT WAS MEASURED, OFFER THE ROUTES, ASSERT NO CAUSE.
 * `rosterCount` still distinguishes the two empties, because they lead to
 * genuinely different next actions — but it is reported as an observation
 * ("no-one is homed here") beside the other, never as the reason for it.
 * Correct under BOTH homing modes (OD1), which is the AC S1 sets.
 */
const drillEmptyCopy = computed(() => {
  const name = props.drill?.cc.displayName ?? 'this Business Unit'
  const staffed = (props.drill?.overSoftCap.rosterCount ?? 0) > 0
  return {
    headline: `No usage recorded for ${name} in this period.`,
    // "period", not "month": the page also serves custom ranges (`meta.range`).
    sub:
      (staffed
        ? `Nobody homed to ${name} recorded usage in this period, across both the tagged and untagged lanes. Usage follows the project it is tagged to, so a person's spend can land on a different ${BU_LABEL} from the one they sit in.`
        : `No-one is currently homed to ${name}, and no project tagged to it recorded usage in this period. Usage follows the project it is tagged to, so spend by people who belong here can be landing elsewhere — check placements in admin, or pick another ${BU_LABEL} above.`) +
      // Said HERE rather than by hiding the state: the rolling band is a
      // different window, and a reader who can see charts below a "no usage"
      // card needs the two reconciled, not one of them removed.
      (trendHasSpend.value
        ? ' The rolling window below covers a different range and does carry spend.'
        : ''),
  }
})

// ── Header: the collapsed caveat chips (requirement 5, one popover deeper) ───
// Every vendor clock still reaches the reader — the grid re-lenses to §B
// `chargeUsd` in chargeback mode adjacent to the §A burn drill, so usage's
// clock matters alongside anthropic's/github's — but they render INSIDE
// CcHeaderNotes' popover (D8b), behind ONE least-settled settlement chip,
// with coverage as its own compact chip. The top layer states; it no longer
// explains.
const activeMeta = computed(() => (props.isDrill ? props.drill?.meta : props.report?.meta) ?? null)
const providerStates = computed<ProviderState[]>(() => activeMeta.value?.providerStates ?? [])
const coverage = computed(() => activeMeta.value?.coverage ?? null)

// ── Summary strip (whole-scope rollup, computed server-side from the cards) ──
const summary = computed(() => props.report?.summary ?? null)
const ccCount = computed(() => props.report?.cards.length ?? 0)
const overallUtil = computed(() => {
  const s = summary.value
  if (!s || s.totalAllocationUsd <= 0) return null
  return s.totalBurnUsd / s.totalAllocationUsd
})
// §B total chargeback for the visible cards (chargeback-mode primary figure) —
// summed client-side from the per-card §B `chargeUsd`, NEVER mixed with the §A burn.
const totalChargeUsd = computed(() =>
  (props.report?.cards ?? []).reduce((a, c) => a + c.chargeUsd, 0),
)
// §B — copilot chargeback ON over a partial-month range → the pooled (monthly) Copilot net
// is withheld from every card's chargeUsd (never a partial slice). Caveat the omission
// rather than let the total silently read as if Copilot were folded in.
const copilotPartialMonth = computed(() => props.report?.copilotChargebackPartialMonth === true)

/*
 * ── THE COST-CENTRE RANKING CARD IS GONE, AND ITS ABSENCE IS THE FIX (D22) ───
 *
 * It mapped `report.cards`, and the cards ARE the cost centres — so it ranked
 * the very dimension this page is about, across every centre in every region
 * the viewer could see. That is not a caption bug; it is a category error, and
 * the prototype rules it out three times over:
 *
 *   `R:554-555` — *"A cost centre has no child org node. Its children are its
 *   PROJECTS, and those are a hero list below, not a subordinate table."*
 *   `R:623-630` — a cost-centre owner owns projects and people, and sees both.
 *   `R:902-907` — the list of cost centres already has ONE home, the Region
 *   tab's children table, and *"two places rendering one fact will eventually
 *   diverge"*.
 *
 * The prototype's ladder is company → REGIONS → cost centres → projects: the
 * whole-company rung ranks regions (`ScopeAcrossRegionsView`'s RegionRankCard,
 * "the ONLY place this page answers which region"), and cost centres are the
 * children of a REGION. There is no parent-cost-centre rung anywhere on it.
 *
 * The ranked read a cost-centre owner needs is one level down and already
 * built: `CcDrill`'s two heroes, ranked on the project axis and the people
 * axis of the centre they are ON.
 *
 * `CcBudgetTable` below is NOT that card and stays: it is a budget-STATUS list
 * (burn · allocation · RAG state), the shape `R:556-568` gives a children
 * table, and it is the surface a reader crosses between centres on.
 */
</script>

<template>
  <div data-testid="scope-cost-centre">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · {{ BU_LABEL_PLURAL }}
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">{{ BU_LABEL_PLURAL }}</h2>
        <!-- WHICH cost centre this page is about (D23) — in BOTH states, so
             the architecture switch between "landed on your centre" and "not
             scoped yet" is never silent. -->
        <CcScopeLine
          class="mt-1.5"
          :scope="scope"
          :selected-cc-id="selectedCcId"
          :window-label="ownedWindowLabel"
          @select="emit('drill', $event)"
        />
        <!-- CONTROLS stay above the fold; COMMENTARY goes one popover deeper.
             The three per-provider "Estimated · month in progress" chip+text
             pairs, the coverage sentence and the placement note used to
             stack here before the first figure. Now: ONE settlement chip on the
             least-settled clock (popover carrying each provider's own — D8b,
             r1-M5) + the compact coverage chip (sentence in its tooltip). -->
        <div class="mt-2 flex items-center gap-3 flex-wrap" data-testid="cc-settling">
          <CcHeaderNotes
            :provider-states="providerStates"
            :coverage="coverage"
            placement-note
            :lane="lane"
          />
        </div>
      </div>

      <div class="flex items-start gap-4 flex-wrap shrink-0">
        <!-- ── THE LANE TOGGLE IS HIDDEN WHILE SCOPED, NOT DISABLED (D24) ───
             The drill's BURN is usage-only by construction (CcDrill.vue:3-14):
             the headline, the vendor donut and both driver heroes read
             `v_complete_usage`, so selecting "Chargeback" changed nothing. Two
             rules meet here and agree — *"Never a dead toggle — a control that
             cannot change anything teaches readers to ignore controls"*
             (prototype note `fix 6`), and re-labelling §A content with a §B word
             is the lane conflation `Reporting.md` §1 forbids. HIDDEN rather than
             disabled, with the lane stated as a fact instead, because a disabled
             control still claims the figures have two lanes.

             THE PILL NAMES THE BURN, NOT THE WHOLE PAGE (external review).
             It used to read "This drill has no billed lane", which the page
             contradicts one card lower: `TierExposureCard` renders §B
             (`provider_usage_fact`, banded by model tier) under its own "Billed
             spend" headings. That card is not a lane the toggle switches — it is
             a SEPARATE, self-labelled §B answer that consistency contract C2
             forbids summing with the burn — so the fix is the claim, not the
             card. `Reporting.md` §1 forbids MIXING the lanes; it does not forbid
             a page carrying both where each says which it is. -->
        <!--
          THE TOGGLE IS BACK AT COST-CENTRE SCOPE (reverses D24, owner 2026-08-06).
          It was replaced with a static "§A · usage lane" pill on the argument
          that the drill is usage-only "by construction" and switching lanes
          "would change nothing here". Both halves were wrong:

            - The drawing has it. `controls(d)` renders BOTH lanes and is called
              UNCONDITIONALLY (`R:561`), before any scope branch; the Region tab
              ships it today. D24 justified removal by quoting the `scope` note
              "a cost-centre owner does not pivot" (`R:772`) — which is about the
              PIVOT control, not the LANE control. One sentence, two controls.
            - Switching DOES change something: every card already carries
              `chargeUsd`, the §B figure for that centre. Removing the control
              left the figure orphaned, not absent.

          A cost-centre owner is accountable for a budget: "am I on track" is
          answered by what the centre is CHARGED, "what is driving it" by what
          their people CONSUMED. Denying either half does not simplify the page,
          it makes half the job impossible on it.
        -->
        <LaneToggle :show-caption="false" />
        <DateRangeControl />
      </div>
    </header>

    <!-- ═══════════════════ DRILL (`?cc=`) ═══════════════════ -->
    <template v-if="isDrill">
      <ReportSkeleton v-if="drillSkeleton" />
      <UiFetchErrorBanner v-else-if="drillErr" :error="drillError" />
      <ReportEmpty
        v-else-if="drillEmpty"
        :headline="drillEmptyCopy.headline"
        :sub="drillEmptyCopy.sub"
      />
      <!--
        BAND 1 · the month, and the four tiles the approved prototype has always
        put on this page. They sit in the unconditional tail of the prototype's
        `across()`, which `cc(d)` runs, so they were never cost-centre-specific
        code anyone could find by searching for `SK==='cc'` — which is exactly
        why they went unbuilt while the three cards inside those blocks did not.
        `docs/design/reporting-consolidation/inventory.json` records them;
        `tests/unit/reporting/prototype-parity.test.ts` now asserts them.

        ScopeHero is the SAME component both Region widths render, reading the
        same structural contract, so a third KPI row cannot drift from the other
        two — the drift that produced two disagreeing Region heroes before they
        were merged onto it.
      -->
      <template v-else-if="drillData && drill">
      <ReportBand data-testid="cc-band-period">
        <ScopeHero :report="drill" :lane="lane" />
      </ReportBand>
      <CcDrill
        :drill="drill"
        :lane="lane"
        :over-soft-cap-export-params="overSoftCapExportParams"
        :over-soft-cap-export-filename="overSoftCapExportFilename"
        :budgets-export-params="budgetsExportParams"
        :budgets-export-filename="budgetsExportFilename"
        :people-export-params="peopleExportParams"
        :people-export-filename="peopleExportFilename"
        :drill-grants="props.drillGrants"
        :drill-window="props.drillWindow"
      />

      </template>

      <!--
        BAND 2 · the rolling window. Four surfaces the approved prototype has
        always drawn on this page and none of which were built — they sit in the
        unconditional tail of the prototype's `across()`, so no search for
        cost-centre code ever reached them.

        ITS WINDOW IS NOT THE MONTH ABOVE IT. ~60 days to the SETTLED edge, from
        the same `rollingTrendWindow` the Region scope uses. `ReportBand` prints
        the window and the "does not sum into" note, so the two frames can never
        be mistaken for each other — and the run-rate stays on the month tile
        above rather than hanging off a rolling frame.

        THE BASIS SAYS "THROUGH THE LAST SETTLED DAY", NOT "ends today". An
        earlier draft copied the Region band's wording, which is wrong for both:
        `rollingTrendWindow` ends at `clock.settledThrough` and its own header
        says "Not at `clock.today`". A caption that claims a still-filling edge
        over settled data is the overstatement this scope's whole parity effort
        exists to stop.

        IT SITS OUTSIDE THE MONTH DRILL'S BRANCH, and that is the point. Nested
        inside `drillData && drill` it was hidden whenever the MONTH came back
        empty — so a centre with no current-month usage but sixty days of history
        showed the month's empty state and silently dropped a rolling band that
        had loaded successfully. The two fetches answer different windows and
        fail independently, so each renders its own states: a dead trend must not
        blank a healthy month, and an empty month must not hide a healthy trend.
      -->
      <ReportBand
        v-if="isDrill && (trend || trendPending || trendError)"
        :window-label="trendWindowLabel"
        basis="rolling · daily · through the last settled day"
        note="Does not sum into the month above — a rolling frame and a calendar month are different windows."
        data-testid="cc-band-rolling"
      >
        <UiFetchErrorBanner v-if="trendError" :error="trendError" />
        <ReportSkeleton v-else-if="trendPending && !trend" />
        <template v-else-if="trend">
          <ActiveUsersTrendCard :active="trend.activeTrend" :window-label="trendWindowLabel" />
          <SpendTrendCard
            class="mt-4"
            :series="ccTrendSeries"
            :window-label="trendWindowLabel"
          />
          <SpendPerDeveloperCard
            class="mt-4"
            :series="trend.perDeveloper"
            :window-label="trendWindowLabel"
          />
          <SurfaceHeroCard class="mt-4" :built="surfaceHero" :window-label="trendWindowLabel" />
        </template>
      </ReportBand>
    </template>

    <!-- ═══════════════════ GRID (budget tracker) ═══════════════════ -->
    <template v-else>
      <ReportSkeleton v-if="gridSkeleton" :kpis="6" />
      <UiFetchErrorBanner v-else-if="gridError" :error="error" />
      <ReportEmpty
        v-else-if="gridEmpty"
        :headline="`No ${BU_LABEL_LOWER_PLURAL} in your scope for this period.`"
        :sub="`When you own a ${BU_LABEL_LOWER} — or one sits in your org — its burn and budget risk appear here.`"
      />
      <div v-else-if="gridData && report" data-testid="cc-grid-data" class="space-y-6">
        <!-- NO AXIS PARAGRAPH. `report.laneNote` ("Per-cost-centre burn is the
             project cost-owning-unit usage axis…") is deliberately unrendered
             (D8b): rationale is not UI copy. The one consequence a reader is
             misled without — money that reaches no cost centre keeps these
             totals below the whole-company figure — is the unattributed-gap
             note under the strip, which stays. -->

        <!-- Summary KPI strip (hairline tiles + RAG count rollup) -->
        <!-- auto-fit, so adding the Not-started tile (D26) cannot introduce a
             width at which the strip silently becomes a different layout —
             prototype note `grid` (R:627-632). -->
        <div
          v-if="summary"
          class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(168px,1fr))]"
          data-testid="cc-summary-strip"
        >
          <CcKpiTile
            v-if="isChargeback"
            label="Total chargeback"
            :value="fmtUsd(totalChargeUsd)"
            :sub="`across ${ccCount} ${ccCount === 1 ? BU_LABEL_LOWER : BU_LABEL_LOWER_PLURAL}`"
            :hint="`Cost-of-record cross-charged to these ${BU_LABEL_LOWER_PLURAL}`"
            data-testid="cc-summary-primary"
          />
          <CcKpiTile
            v-else
            label="Total burn"
            :value="fmtUsd(summary.totalBurnUsd)"
            :sub="`across ${ccCount} ${ccCount === 1 ? BU_LABEL_LOWER : BU_LABEL_LOWER_PLURAL}`"
            :hint="`Usage tagged to a ${BU_LABEL_LOWER}'s budgets`"
            data-testid="cc-summary-primary"
          />
          <CcKpiTile
            label="Total allocation"
            :value="fmtUsd(summary.totalAllocationUsd)"
            :sub="isChargeback ? 'current effective budget' : (overallUtil != null ? `${fmtPct(overallUtil)} utilised overall` : 'no budgets set yet')"
          />
          <!-- The RAG count rollup is BURN-vs-allocation (§A usage-based) — it does not
               describe the §B chargeback figures, so it is suppressed in chargeback mode
               (a note below explains). Usage mode shows the full over/near/on-track/no-budget split. -->
          <template v-if="!isChargeback">
            <CcKpiTile
              label="Over budget"
              :value="String(summary.countOverBudget)"
              rag="over"
              sub="at or over allocation"
            />
            <CcKpiTile
              label="Near budget"
              :value="String(summary.countNearBudget)"
              rag="warn"
              sub="≥ 80% of allocation"
            />
            <CcKpiTile
              label="On track"
              :value="String(summary.countOnTrack)"
              rag="ok"
              sub="under 80% of budget"
            />
            <!-- An allocation with nothing spent against it (D26). Its own
                 tile, because "$0.00 of $500.00 · On track" is the reading a
                 cost-centre owner has no way to challenge. NEUTRAL, not green:
                 nothing has happened yet, which is not the same as healthy. -->
            <CcKpiTile
              label="Not started"
              :value="String(summary.countNotStarted)"
              rag="none"
              muted
              sub="budgeted, nothing spent yet"
            />
            <CcKpiTile
              label="No budget set"
              :value="String(summary.countNoAllocation)"
              rag="none"
              muted
              sub="no allocation yet"
            />
          </template>
        </div>
        <!-- The prototype's `who` note, stated HERE rather than left to be discovered
             on the Finance tab. A cost centre is reached through a teammate, so spend
             whose record carries no teammate reaches no cost centre and sits in none of
             the cards above. The consequence is structural, not a rounding error, and a
             reader comparing this strip against the whole-company figure has no way to
             know it unless the page says so. No figure is claimed for the gap — the
             cost-centre endpoint does not compute one. -->
        <p class="text-[11px] text-carbon-3 italic" data-testid="cc-unattributed-gap-note">
          Spend with no teammate reaches no {{ BU_LABEL_LOWER }}, so these totals do not sum to the
          whole-company figure.
        </p>
        <p
          v-if="isChargeback"
          class="text-[11px] text-carbon-3 italic"
          data-testid="cc-summary-scope-note"
        >Over / near / on-track budget health is burn (usage) based — switch to Usage to see it.</p>
        <p
          v-if="isChargeback && copilotPartialMonth"
          class="text-[11px] text-carbon-3 italic"
          data-testid="cc-copilot-partial-month-note"
        >Copilot pooled chargeback is monthly — not shown for a partial-month range (Anthropic is day-accurate).</p>

        <!-- ── PRIMARY: the owner's projects, with their budgets ─────────────
             What the cost-centre owner came to decide: which project is burning
             the budget, and should it be extended. -->
        <div v-if="ownedErr" class="space-y-2" data-testid="cc-owned-projects-error">
          <h3 class="text-sm font-semibold text-carbon-1">Projects in my {{ BU_LABEL_LOWER_PLURAL }}</h3>
          <UiFetchErrorBanner :error="ownedError" />
        </div>
        <div v-else-if="ownedLoading" class="space-y-2" data-testid="cc-owned-projects-pending">
          <h3 class="text-sm font-semibold text-carbon-1">Projects in my {{ BU_LABEL_LOWER_PLURAL }}</h3>
          <ReportSkeleton :kpis="0" :rows="3" />
        </div>
        <div v-else-if="showOwnedProjects" class="space-y-2" data-testid="cc-owned-projects">
          <div class="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 class="text-sm font-semibold text-carbon-1">Projects in my {{ BU_LABEL_LOWER_PLURAL }}</h3>
            <p class="text-[11px] text-carbon-3">Budget vs burn · select a project for its team</p>
          </div>
          <CcProjectTable
            :cards="ownedCentres"
            :window-label="ownedWindowLabel"
            :drill-grants="props.drillGrants"
            :drill-window="props.drillWindow"
          />
        </div>

        <!-- NO cost-centre RANKING card here. It ranked cost centres on the
             cost-centre page — see the argument in the script block. -->

        <!-- Budget-STATUS list: the shape R:556-568 gives a children table -->

        <CcBudgetTable :cards="report.cards" :lane="lane" @select="emit('drill', $event)" />

        <div class="flex justify-end pt-2">
          <ExportCsvButton
            endpoint="/api/v1/reports/export"
            :params="exportParams"
            :filename="exportFilename"
          />
        </div>
      </div>
    </template>
  </div>
</template>
