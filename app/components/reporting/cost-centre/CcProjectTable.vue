<script setup lang="ts">
/*
 * CcProjectTable — the P&L owner's PROJECT table: one section per cost centre the
 * viewer owns, one row per project it leads.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The paradigm is that tokens are a timesheet assigned to a PROJECT, the project
 * has a BUDGET, and a manager watches burn and decides whether to extend. The
 * cost-centre scope used to open on a list of PEOPLE, which is not the question
 * its owner holds. `GET /api/v1/me/cost-centres` has always been able to answer
 * it — burn vs allocation, run-rate, exhaustion date and the PM, per project —
 * but its page was deleted at the reporting cutover and nothing asked for the
 * payload any more. This is that view, restored as the scope's primary table.
 *
 * PURE + prop-driven (the fetch lives in the ScopeCostCentre container).
 *
 * ── TWO FIGURES, AND THE CARD SHOWS WHY THEY DIFFER ──────────────────────────
 * A centre's project roll-up is NOT its §A burn: money on this centre's projects
 * can be homed elsewhere or nowhere (a reconciled row carries no cost-owning unit
 * at all; a cross-centre emit carries someone else's), ingest-only usage carries
 * a home but can never carry a project, and people spend on other centres'
 * projects. The response publishes the burn AND every term between the two, so
 * the footer reconciles on the card's own face instead of leaving the owner to
 * find an unnamed gap against the burn tracker below.
 *
 * ── THE ROWS ARE A RANKED PAGE, NOT THE WHOLE LIST ───────────────────────────
 * The roll-up counts every project the centre leads; the rows are the ones that
 * answer "what is burning my budget". `omitted_projects` names the difference —
 * with its Σ — so the two still add up in front of the reader.
 */
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import { costCentreBudgetState, type CostCentreBudgetState } from '#shared/reports/types'
import type {
  CostCentreCard as PnlCostCentreCard,
  CostCentreProject,
} from '#shared/schemas/cost-centres'
import {
  projectDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from '../drill-contract'
import { BU_LABEL_LOWER, BU_LABEL_LOWER_PLURAL } from '#shared/reports/vocabulary'

const props = withDefaults(
  defineProps<{
    /** The cost centres the VIEWER OWNS, with their lead projects. */
    cards: PnlCostCentreCard[]
    /**
     * Human label for the window every burn figure below covers (e.g. "July 2026").
     * Rendered on the section so a period-switched table can never read as "now".
     */
    windowLabel: string
    /*
     * THE DRILL CONTRACT (D29/D30, fix 7). This table already linked every row to
     * `/projects/{code}` unconditionally, which was right for its own audience
     * (a P&L owner holds the cost-centre grant) and wrong as a contract: the row
     * carried NO scope or window, so the target opened on its own defaults and
     * "back" could not restore the report. Now the link is grant-decided and
     * carries the entry frame.
     */
    drillGrants?: DrillGrants
    /**
     * The WINDOW the drill carries. The `src` token is NOT passed in: this table
     * renders several cost centres at once, so the frame a row belongs to is the
     * centre its section is under — built per row below, never one token for the
     * whole table (which would echo the wrong centre on every section but one).
     */
    drillWindow?: Omit<DrillFrame, 'src'>
  }>(),
  { drillGrants: () => NO_DRILL_GRANTS, drillWindow: () => ({}) },
)

/**
 * The row's target ROUTE, or null — a null row renders as a plain, unlinked row.
 *
 * A project target is always a `link` (there is no in-page project pivot), so
 * the route is unwrapped here and the template binds a plain value rather than
 * narrowing a union in markup.
 */
function targetFor(ccId: string, row: { project: { code: string } }): RouteLocationRaw | null {
  const t = projectDrillTarget(props.drillGrants, row.project.code, {
    ...props.drillWindow,
    src: `cc:${ccId}`,
  })
  return t?.kind === 'link' ? t.to : null
}

/*
 * The shared classifier's own union (D26 added `not-started`), aliased rather
 * than re-declared: a local copy is a second definition that drifts, and every
 * `Record<BudgetState, …>` below is the compiler gate that makes a new member
 * impossible to ignore.
 */
type BudgetState = CostCentreBudgetState

const STATUS_LABEL: Record<BudgetState, string> = {
  over: 'Over budget',
  warn: 'Near budget',
  ok: 'On track',
  // The word `useRagState.ts:183` and both prototypes already use — never
  // a second name (`idle`) for one fact.
  'not-started': 'Not started',
  none: 'No budget set',
}
// Literal class strings (a map, so Tailwind sees them) — matches CcBudgetTable so
// the two tables read as one language.
const BAR_CLASS: Record<BudgetState, string> = {
  over: 'bg-rag-red',
  warn: 'bg-rag-amber',
  ok: 'bg-rag-green',
  'not-started': '',
  none: '',
}
const DOT_CLASS: Record<BudgetState, string> = {
  over: 'bg-rag-red',
  warn: 'bg-rag-amber',
  ok: 'bg-rag-green',
  'not-started': 'bg-carbon-3/50',
  none: 'bg-carbon-3/50',
}
const TEXT_CLASS: Record<BudgetState, string> = {
  over: 'text-rag-red',
  warn: 'text-rag-amber',
  ok: 'text-rag-green',
  'not-started': 'text-carbon-3',
  none: 'text-carbon-3',
}
const ACCENT_CLASS: Record<BudgetState, string> = {
  over: 'border-l-rag-red',
  warn: 'border-l-rag-amber',
  ok: 'border-l-transparent',
  'not-started': 'border-l-transparent',
  none: 'border-l-transparent',
}

interface ProjectVm {
  project: CostCentreProject
  burnUsd: number
  allocationUsd: number
  state: BudgetState
  statusLabel: string
  hasAlloc: boolean
  fillPct: number
  utilLabel: string
  /**
   * Velocity — this week against the trailing 4-week mean (a rate, not a total).
   * null when the server withheld it: outside a window that still runs to now, a
   * live weekly rate does not describe the period the rest of the row covers.
   */
  runRate: string | null
  velocityFlagged: boolean
  exhaustion: string | null
  managers: string
  endState: string | null
}

interface CentreVm {
  card: PnlCostCentreCard
  burnUsd: number
  allocationUsd: number
  utilisation: number | null
  state: BudgetState
  hasAlloc: boolean
  fillPct: number
  projects: ProjectVm[]
  /** The reconciliation terms, pre-formatted, only when any of them is non-zero. */
  residualTerms: { label: string; usd: number; sign: '+' | '−' }[]
  ccBurnUsd: number
  memberUntaggedUsd: number
  /** The projects the server ranked out / held back, and what they carry. */
  omitted: { count: number; usd: number; dormant: number }
  /** One sentence naming them, or null when the rows are the whole list. */
  omittedNote: string | null
}

function endStateOf(p: CostCentreProject): string | null {
  if (p.ended) return 'ended'
  if (p.end_date) return `ends ${p.end_date.slice(0, 10)}`
  return null
}

function omittedOf(card: PnlCostCentreCard): { count: number; usd: number; dormant: number } {
  return {
    count: card.omitted_projects.count,
    usd: Number(card.omitted_projects.cost_usd),
    dormant: card.omitted_projects.dormant_count,
  }
}

/**
 * The rows are a ranked PAGE of the centre's projects, so what is missing has to
 * be named — with its Σ, because the header roll-up above counts it. A silent
 * truncation would leave an owner adding the visible rows and finding a gap.
 */
function omittedNoteOf(o: { count: number; usd: number; dormant: number }): string | null {
  if (o.count === 0) return null
  const ranked = o.count - o.dormant
  const dormantPhrase = `${o.dormant} ended project${o.dormant === 1 ? '' : 's'} with no spend in this window`
  if (ranked <= 0) return `Not listed: ${dormantPhrase} (nothing to add to the total above).`
  const rankedPhrase = `${ranked} lower-ranked project${ranked === 1 ? '' : 's'} totalling ${fmtUsd(o.usd)}`
  return o.dormant > 0
    ? `Not listed: ${rankedPhrase}, and ${dormantPhrase}. Both are counted in the total above.`
    : `Not listed: ${rankedPhrase} — counted in the total above.`
}

const centres = computed<CentreVm[]>(() =>
  props.cards.map((card) => {
    const burnUsd = Number(card.mtd_cost_usd)
    const allocationUsd = Number(card.allocation_usd)
    const state = costCentreBudgetState(card.utilisation)
    const hasAlloc = allocationUsd > 0 && card.utilisation != null
    const r = card.reconciliation
    // Signed exactly as the identity is stated (complete-spend.ts): Σ projects
    // + ingest-only + untagged + foreign-project − off-centre = burn. A term at
    // zero is elided — an owner should read the terms that MOVE the number, and
    // a wall of $0.00 rows teaches nothing.
    const residualTerms = (
      [
        // 'ingest-only (untaggable)' was pipeline vocabulary on a cost-centre owner's
        // page: it names the ARM the row came from, which they cannot act on and do
        // not know. What they can act on is that there is no session behind it, so
        // nobody failed to tag it and no nudge would help.
        { label: 'provider usage with no session to tag', usd: Number(r.ingest_only_usd), sign: '+' },
        { label: 'homed here, no project claim', usd: Number(r.untagged_usd), sign: '+' },
        { label: `on another ${BU_LABEL_LOWER}'s projects`, usd: Number(r.foreign_project_usd), sign: '+' },
        // NOT "on this centre's projects, homed elsewhere": the term is every dollar on
        // this centre's projects whose usage row is homed anywhere else —
        // reconciled rows (no home at all) AND rows emitted under a DIFFERENT
        // cost centre. Naming only the first half would have an owner hunting
        // reconciliation for money that a cross-centre emit put there.
        { label: `on this ${BU_LABEL_LOWER}'s projects, homed elsewhere`, usd: Number(r.off_centre_usd), sign: '−' },
      ] as { label: string; usd: number; sign: '+' | '−' }[]
    ).filter((t) => t.usd !== 0)

    return {
      card,
      burnUsd,
      allocationUsd,
      utilisation: card.utilisation,
      state,
      hasAlloc,
      fillPct: hasAlloc ? Math.min((card.utilisation ?? 0) * 100, 100) : 0,
      ccBurnUsd: Number(r.burn_usd),
      memberUntaggedUsd: Number(r.member_untagged_usd),
      residualTerms,
      omitted: omittedOf(card),
      omittedNote: omittedNoteOf(omittedOf(card)),
      projects: card.projects
        .map((project) => {
          const pBurn = Number(project.mtd_cost_usd)
          const pAlloc = Number(project.allocation_usd)
          const pState = costCentreBudgetState(project.utilisation)
          const pHasAlloc = pAlloc > 0 && project.utilisation != null
          const velocity = project.velocity
          const delta = velocity?.delta_pct ?? null
          return {
            project,
            burnUsd: pBurn,
            allocationUsd: pAlloc,
            state: pState,
            statusLabel: STATUS_LABEL[pState],
            hasAlloc: pHasAlloc,
            fillPct: pHasAlloc ? Math.min((project.utilisation ?? 0) * 100, 100) : 0,
            utilLabel: pHasAlloc ? fmtPct(project.utilisation) : '',
            runRate:
              velocity && (Number(velocity.current_week_usd) > 0 || delta != null)
                ? fmtUsd(Number(velocity.current_week_usd))
                : null,
            velocityFlagged: velocity?.is_flagged ?? false,
            exhaustion: project.projected_exhaustion_date,
            managers: project.managers.join(', '),
            endState: endStateOf(project),
          }
        })
        // Burn desc so the project consuming the budget leads; the server orders
        // by code, which is an arbitrary rank for a "what is burning me" read.
        .sort((a, b) => b.burnUsd - a.burnUsd),
    }
  }),
)
</script>

<template>
  <section class="space-y-6" data-testid="cc-project-table">
    <section
      v-for="cc in centres"
      :key="cc.card.id"
      class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] overflow-hidden"
      :data-testid="`cc-projects-${cc.card.code}`"
    >
      <!-- Header: the cost-centre ROLL-UP as the KPI -->
      <header class="px-4 sm:px-5 py-4 border-b border-calm-1 flex items-start justify-between gap-5 flex-wrap">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-carbon-1">
            {{ cc.card.display_name }}
            <span class="text-[11px] font-normal uppercase tracking-[0.6px] text-carbon-3 ml-1">
              {{ cc.card.region_code.toUpperCase() }}
            </span>
          </h3>
          <p class="text-[11px] text-carbon-3 mt-0.5">
            {{ cc.card.project_count }} project{{ cc.card.project_count === 1 ? '' : 's' }} ·
            {{ cc.card.member_count }} member{{ cc.card.member_count === 1 ? '' : 's' }}<template
              v-if="cc.card.cross_cou_member_count > 0"
            >
              ({{ cc.card.cross_cou_member_count }} from other {{ BU_LABEL_LOWER_PLURAL }})</template>
            · {{ windowLabel }}
          </p>
        </div>
        <div class="min-w-[15rem] flex-1 max-w-sm">
          <div class="flex items-baseline justify-between gap-2 mb-1">
            <span
              class="text-[18px] font-bold tabular-nums text-carbon leading-none"
              :data-testid="`cc-projects-rollup-${cc.card.code}`"
            >{{ fmtUsd(cc.burnUsd) }}</span>
            <span
              v-if="cc.hasAlloc"
              class="text-[11px] font-semibold tabular-nums"
              :class="TEXT_CLASS[cc.state]"
            >{{ fmtPct(cc.utilisation) }}</span>
          </div>
          <div v-if="cc.hasAlloc" class="h-2 rounded-full bg-calm-1 overflow-hidden" role="presentation">
            <div class="h-full rounded-full" :class="BAR_CLASS[cc.state]" :style="{ width: `${cc.fillPct}%` }" />
          </div>
          <div v-else class="h-2 rounded-full border border-dashed border-calm" />
          <div class="mt-1 text-[11px] text-carbon-3">
            <template v-if="cc.hasAlloc">of {{ fmtUsd(cc.allocationUsd) }} allocated across its projects</template>
            <template v-else>No project budgets set in this {{ BU_LABEL_LOWER }} yet</template>
          </div>
        </div>
      </header>

      <!-- Project rows -->
      <ul v-if="cc.projects.length" class="divide-y divide-calm-1">
        <li v-for="row in cc.projects" :key="row.project.id">
          <component
            :is="targetFor(cc.card.id, row) ? 'NuxtLink' : 'div'"
            v-bind="targetFor(cc.card.id, row) ? { to: targetFor(cc.card.id, row) } : {}"
            class="group border-l-2 px-4 sm:px-5 py-3.5 flex flex-col gap-3 transition-colors hover:bg-brand-harmony-sheer/60 focus-visible:-outline-offset-2 focus-visible:bg-brand-harmony-sheer md:grid md:items-center md:gap-x-5 md:gap-y-0 md:grid-cols-[minmax(9rem,1.4fr)_6.5rem_minmax(9.5rem,1.8fr)_minmax(8.5rem,auto)_0.6rem]"
            :class="ACCENT_CLASS[row.state]"
            :data-testid="`cc-project-${row.project.code}`"
            :data-state="row.state"
          >
            <!-- Project + PM -->
            <div class="min-w-0">
              <div class="text-[14px] font-semibold text-carbon truncate group-hover:text-brand-harmony transition-colors">
                {{ row.project.display_name }}
              </div>
              <div class="text-[11px] text-carbon-3 truncate">
                {{ row.project.code }} · {{ row.project.type }}
                <template v-if="row.endState"> · {{ row.endState }}</template>
              </div>
              <div
                v-if="row.managers"
                class="text-[11px] text-carbon-2 truncate"
                :data-testid="`cc-project-pm-${row.project.code}`"
              >PM: {{ row.managers }}</div>
              <div v-else class="text-[11px] text-carbon-3 italic truncate">no project manager assigned</div>
            </div>

            <!-- Burn -->
            <div class="md:text-right">
              <div class="md:hidden text-[10px] font-bold uppercase tracking-[1px] text-carbon-3 mb-0.5">Burn</div>
              <div class="text-[16px] font-bold tabular-nums text-carbon leading-none">
                {{ fmtUsd(row.burnUsd) }}
              </div>
            </div>

            <!-- Utilisation RAG + allocation -->
            <div class="min-w-0">
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold" :class="TEXT_CLASS[row.state]">
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="DOT_CLASS[row.state]" aria-hidden="true" />
                  {{ row.statusLabel }}
                </span>
                <span v-if="row.hasAlloc" class="text-[11px] font-semibold tabular-nums" :class="TEXT_CLASS[row.state]">
                  {{ row.utilLabel }}
                </span>
              </div>
              <div v-if="row.hasAlloc" class="h-2 rounded-full bg-calm-1 overflow-hidden" role="presentation">
                <div class="h-full rounded-full" :class="BAR_CLASS[row.state]" :style="{ width: `${row.fillPct}%` }" />
              </div>
              <div v-else class="h-2 rounded-full border border-dashed border-calm" />
              <div class="mt-1 text-[11px] text-carbon-3 truncate">
                <template v-if="row.hasAlloc">of {{ fmtUsd(row.allocationUsd) }} allocated</template>
                <template v-else>Set an allocation to track burn against budget</template>
              </div>
            </div>

            <!-- Run-rate + exhaustion date -->
            <div class="md:text-right space-y-1">
              <div v-if="row.runRate" class="tabular-nums">
                <span class="md:hidden text-[10px] font-bold uppercase tracking-[1px] text-carbon-3 mr-1">Run-rate</span>
                <span class="text-[13px] text-carbon-2">this week </span>
                <span class="text-[13px] font-semibold text-carbon">{{ row.runRate }}</span>
                <span
                  v-if="row.velocityFlagged"
                  class="ml-1 text-[11px] font-semibold text-rag-amber"
                  :data-testid="`cc-project-velocity-${row.project.code}`"
                >↑</span>
              </div>
              <div
                v-if="row.exhaustion"
                class="inline-flex items-center gap-1 text-[11px] font-semibold text-rag-amber"
                :data-testid="`cc-project-exhaustion-${row.project.code}`"
              >
                <span aria-hidden="true">⚠</span> budget runs out ~{{ row.exhaustion }}
              </div>
            </div>

            <span class="hidden md:flex items-center justify-center text-carbon-3 group-hover:text-brand-harmony transition-colors" aria-hidden="true">
              ›
            </span>
          </component>
        </li>
      </ul>
      <!-- A centre whose every project is held back HAS projects — saying "none
           yet" there would be a different, and false, statement. -->
      <p
        v-else-if="cc.omitted.count > 0"
        class="px-4 sm:px-5 py-4 text-[12px] text-carbon-3"
        :data-testid="`cc-projects-none-active-${cc.card.code}`"
      >
        {{ cc.omittedNote }}
      </p>
      <p
        v-else
        class="px-4 sm:px-5 py-4 text-[12px] text-carbon-3"
        :data-testid="`cc-projects-empty-${cc.card.code}`"
      >
        No projects have this {{ BU_LABEL_LOWER }} as their lead yet — until one does, its spend has no budget to sit against.
      </p>

      <!-- The ranked page is not the whole list, and says so with the Σ. -->
      <p
        v-if="cc.projects.length && cc.omittedNote"
        class="px-4 sm:px-5 py-2.5 text-[11px] text-carbon-3 italic border-t border-calm-1"
        :data-testid="`cc-projects-omitted-${cc.card.code}`"
      >
        {{ cc.omittedNote }}
      </p>

      <!-- Reconciliation to the centre's own burn -->
      <footer
        class="px-4 sm:px-5 py-3 border-t border-calm-1 bg-calm-1/25 text-[11px] text-carbon-3 space-y-0.5"
        :data-testid="`cc-projects-reconciliation-${cc.card.code}`"
      >
        <div>
          Projects {{ fmtUsd(cc.burnUsd) }}<template v-for="t in cc.residualTerms" :key="t.label">
            {{ ' ' }}{{ t.sign }} {{ fmtUsd(t.usd) }} <span class="italic">{{ t.label }}</span>
          </template>
          = {{ fmtUsd(cc.ccBurnUsd) }} {{ BU_LABEL_LOWER }} burn.
        </div>
        <div v-if="cc.memberUntaggedUsd !== 0">
          {{ fmtUsd(cc.memberUntaggedUsd) }} spent by this {{ BU_LABEL_LOWER }}'s people has no project and no cost
          home — never added to the burn.
        </div>
      </footer>
    </section>
  </section>
</template>
