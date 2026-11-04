<script setup lang="ts">
/*
 * /reporting/teammate/{id} — the E3 CONTRIBUTION view of one named individual
 * (developer pages build D31; prototype `#p=teammate`).
 *
 * REPORTS DEPTH ONLY. It sits under `/reporting` because that is where
 * "who may see a named person" is answered and enforcement-tested
 * (00-brief.md:39-49). Three states, and each is a real page rather than an
 * error banner:
 *
 *   SELF     → a redirect card to `/usage`. Nothing on this page is addressed
 *              to the subject; their own depth has the models, the insights,
 *              the quota and the worklist this one deliberately lacks.
 *   NO GRANT → the 403 card, which also explains WHY they never saw a link to
 *              it: on their surfaces teammate names render as plain text.
 *   STALE    → the refusal card. Past the threshold this page withholds rather
 *              than caveats — on a governance surface about a named individual
 *              that is the difference between a finding and a defamation.
 *
 * ABSENT, not `.gap`-ed (prototype `:848`): model donut, cache economics,
 * insights, quota, peer stats. They are unpopulatable for arms-2/3 subjects and
 * behavioural rather than contributional — the manager-facing question is
 * contribution against budgets, and nothing else.
 */
import { computed } from 'vue'
import { provideReportStateKeys, WINDOW_STATE_KEYS } from '../../../composables/useReportState'
import ReportSkeleton from '../../../components/reporting/ReportSkeleton.vue'
import InfoDot from '../../../components/ui/InfoDot.vue'
import DateRangeControl from '../../../components/reporting/DateRangeControl.vue'
import CcHeaderNotes from '../../../components/reporting/cost-centre/CcHeaderNotes.vue'
import BudgetStateCell from '../../../components/reporting/BudgetStateCell.vue'
import ExportCsvButton from '../../../components/reporting/ExportCsvButton.vue'
import DrillName from '../../../components/reporting/DrillName.vue'
import { entryReportRoute, projectDrillTarget } from '../../../components/reporting/drill-contract'
import { useDrillGrants } from '../../../composables/useDrillContract'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import { apiErrorDetail, isConfirmedRejection } from '../../../composables/useApiError'
import type { ProviderState, ReportCoverageMeta } from '#shared/reports/types'

interface MixSlice {
  key: string
  label: string
  usd: number
  sharePct: number
}
interface TeammateReport {
  subject: {
    id: string
    display_name: string
    practice: string | null
    region: string | null
    cost_owning_unit: string | null
  }
  scope: { src: string; label: string }
  window: { from: string; to: string; is_month: boolean; month: string }
  headlineUsd?: number
  activeDays?: number
  tokensheet?: {
    project_id: string
    project_code: string
    project_name: string
    contribution_usd: string
    project_window_usd: string
    allocation_usd: string | null
    share_pct: number | null
  }[]
  surfaceMix?: MixSlice[]
  provenanceMix?: MixSlice[]
  worklistPressure?: {
    untagged_usd: string
    untagged_days: number
    activity_tagged_usd: string
    untaggable_usd: string
  }
  meta?: { providerStates: ProviderState[]; coverage: ReportCoverageMeta | null }
  refusal?: {
    reason: 'coverage-stale'
    provider: string
    ageHours: number | null
    threshold: number
  }
}

// The page owns the WINDOW keys and the drill FRAME — never `?scope=`, which is
// the reporting shell's tab selector and means nothing here.
provideReportStateKeys(WINDOW_STATE_KEYS)
const rs = useReportState()
const route = useRoute()
const subjectId = computed(() => String(route.params.id ?? ''))

const { session, ensure } = useSession()
await ensure()

const isSelf = computed(() => session.value?.teammateId === subjectId.value)

/*
 * `?src=` is REQUIRED (D33). Without it the request would be a bare
 * `teammate_id` — the thing C14 forbids — so the page does not fetch at all and
 * says why. Landing here from a pasted URL with no frame is a real situation and
 * it gets a real answer, not a 400 banner.
 */
const src = computed(() => rs.src.value)

const query = computed(() => ({
  src: src.value ?? '',
  month: rs.month.value ?? undefined,
  from: rs.from.value ?? undefined,
  to: rs.to.value ?? undefined,
}))

const { data, error, pending, refresh } = await useFetch<TeammateReport>(
  () => `/api/v1/reports/teammate/${encodeURIComponent(subjectId.value)}`,
  {
    query,
    lazy: true,
    // Never fetch for the subject themselves (they get the redirect card) and
    // never without a frame.
    immediate: !isSelf.value && Boolean(src.value),
  },
)

const forbidden = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 403)
/*
 * Every OTHER error used to leave a blank body. Refused (a 4xx with a reason,
 * e.g. a malformed window) says the server's reason; anything else (no answer,
 * a 5xx) says the view failed and nothing is known about this person's figures.
 */
const loadError = computed<'refused' | 'failed' | null>(() => {
  if (!error.value || forbidden.value) return null
  return isConfirmedRejection(error.value) ? 'refused' : 'failed'
})
const refusedDetail = computed(() => apiErrorDetail(error.value, 'none').replace(/\.$/, ''))

const frame = computed(() => ({
  src: src.value,
  month: rs.month.value,
  from: rs.from.value,
  to: rs.to.value,
}))
const backRoute = computed(() => entryReportRoute(frame.value))
const drillGrants = useDrillGrants()

/** A TokenSheet project name is a link by the SAME rule as everywhere else. */
function projectTarget(code: string) {
  return projectDrillTarget(drillGrants.value, code, frame.value)
}

const windowWord = computed(() => {
  const w = data.value?.window
  if (!w) return ''
  if (!w.is_month) return `${w.from} → ${w.to}`
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.parse(`${w.month}-01T00:00:00Z`)),
  )
})

/** Whole days elapsed in the window — the "active N of M" denominator. */
const windowDays = computed(() => {
  const w = data.value?.window
  if (!w) return 0
  return Math.round((Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000) + 1
})

const MIX_COLORS = ['var(--brand-hunger)', 'var(--brand-harmony)', 'var(--brand-vision)', 'var(--brand-zeal)', 'var(--carbon-3)']
function mixColor(i: number): string {
  return MIX_COLORS[i % MIX_COLORS.length]!
}

const exportParams = computed(() => ({
  src: src.value ?? '',
  month: rs.month.value ?? undefined,
  from: rs.from.value ?? undefined,
  to: rs.to.value ?? undefined,
}))
</script>

<template>
  <div class="max-w-[1100px] mx-auto px-10 py-8 pb-20">
    <!-- SELF — the subject's own depth is /usage, and it is a better page for
         them than this one could be (prototype `:773-778`). -->
    <template v-if="isSelf">
      <UiCard data-testid="teammate-self-redirect">
        <div class="text-sm font-semibold text-carbon-1">You are the subject here</div>
        <p class="text-[13px] text-carbon-2 mt-1">
          Your own depth is My usage.
          <InfoDot
            label="Why this page redirects you"
          >Models, insights, quota and the worklist live on My usage. This view exists for reports viewers and is about contribution — nothing on it is addressed to you.</InfoDot>
        </p>
        <NuxtLink
          to="/usage"
          class="inline-block mt-3 text-sm font-semibold text-brand-harmony hover:underline"
          data-testid="teammate-self-usage-link"
        >Open My usage →</NuxtLink>
      </UiCard>
    </template>

    <!-- NO FRAME — a drill with no entry scope is a bare id (C14). Say so. -->
    <UiCard v-else-if="!src" data-testid="teammate-no-frame">
      <div class="text-sm font-semibold text-carbon-1">Open this view from a report</div>
      <p class="text-[13px] text-carbon-2 mt-1">
        This page always answers within the scope you opened it from — a contribution figure with no
        scope is not a smaller answer, it is a different one.
        <InfoDot
          label="Why a scope is required"
        >The same person's month can be $100 inside one Business Unit and $350 across the company. Without the entry scope this page could not tell you which question it was answering.</InfoDot>
      </p>
      <NuxtLink to="/reporting" class="inline-block mt-3 text-sm font-semibold text-brand-harmony hover:underline">
        Go to Reporting →
      </NuxtLink>
    </UiCard>

    <!-- NO GRANT — and an explanation of why no link to here was ever shown. -->
    <UiCard v-else-if="forbidden" data-testid="teammate-forbidden">
      <div class="text-sm font-semibold text-rag-red">You don't have access to this view</div>
      <p class="text-[13px] text-carbon-2 mt-1">
        This teammate is not visible in the scope you opened this view from, or your role does not
        grant the per-teammate reports depth.
        <InfoDot
          label="Why you never saw a link here"
        >On your own surfaces teammate names render as plain text, not links — the drill contract never shows a door you cannot open.</InfoDot>
      </p>
    </UiCard>

    <!-- REFUSED for another reason — say the server's reason, never a blank body. -->
    <UiCard v-else-if="loadError === 'refused'" data-testid="teammate-refused">
      <div class="text-sm font-semibold text-rag-red">The server refused this view</div>
      <p class="text-[13px] text-carbon-2 mt-1">Reason given: {{ refusedDetail }}.</p>
      <NuxtLink :to="backRoute" class="inline-block mt-3 text-sm font-semibold text-brand-harmony hover:underline">
        Back to the report →
      </NuxtLink>
    </UiCard>

    <!-- FAILED — no answer, or a server error. Nothing is known, so nothing is shown. -->
    <UiCard v-else-if="loadError === 'failed'" data-testid="teammate-failed">
      <div class="text-sm font-semibold text-rag-red">This view didn't load</div>
      <p class="text-[13px] text-carbon-2 mt-1">
        We couldn't get an answer from the server, so no figures are shown for this teammate.
      </p>
      <UiButton class="mt-3" kind="secondary" size="sm" data-testid="teammate-retry" @click="refresh()">
        Try again
      </UiButton>
    </UiCard>

    <template v-else>
      <!-- BREADCRUMB — reconstructed from the carried state, never history.back() -->
      <nav class="text-[12px] text-carbon-3 mb-2 flex items-center gap-1.5" data-testid="teammate-crumb">
        <NuxtLink :to="backRoute" class="hover:text-brand-harmony hover:underline">Reports</NuxtLink>
        <span aria-hidden="true">›</span>
        <span>{{ data?.scope.label ?? '…' }}</span>
        <span aria-hidden="true">›</span>
        <span class="text-carbon-1 font-semibold">{{ data?.subject.display_name ?? '…' }}</span>
      </nav>

      <p class="text-[12px] text-carbon-3 mb-4" data-testid="teammate-provenance">
        from Reports · {{ data?.scope.src }} · {{ windowWord }}
        <InfoDot
          label="What the drill carried"
        >The entry scope and window ride the link, and this page echoes them — so going back restores the report you came from exactly, even after a refresh or on a shared link.</InfoDot>
      </p>

      <div class="mb-4">
        <DateRangeControl />
      </div>

      <ReportSkeleton v-if="pending && !data" :kpis="0" :rows="6" />

      <template v-else-if="data">
        <!-- IDENTITY + the disclosure pill (D35.3) -->
        <UiCard data-testid="teammate-identity">
          <div class="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <div class="text-[19px] font-semibold text-carbon-1">{{ data.subject.display_name }}</div>
              <p class="text-[12px] text-carbon-3 mt-0.5">
                <template v-if="data.subject.practice">{{ data.subject.practice }} · </template>
                <template v-if="data.subject.region">{{ data.subject.region }} · </template>
                <template v-if="data.subject.cost_owning_unit">{{ data.subject.cost_owning_unit }}</template>
                <template v-if="data.activeDays != null">
                  · active {{ data.activeDays }} of {{ windowDays }} day{{ windowDays === 1 ? '' : 's' }}
                </template>
              </p>
            </div>
            <span
              class="text-[11px] font-medium text-carbon-2 border border-calm-2 rounded-full px-2.5 py-1"
              data-testid="teammate-audit-pill"
            >
              this view is recorded
              <InfoDot
                label="What is recorded"
              >Opening this page writes an audit row: who viewed it, when, and under which scope. Ids and counts only — never the figures themselves. Exporting the table records a separate event.</InfoDot>
            </span>
          </div>
        </UiCard>

        <!-- REFUSAL — figures withheld, not caveated (D36) -->
        <UiCard v-if="data.refusal" class="mt-4 border-rag-red/40" data-testid="teammate-refusal">
          <div class="text-sm font-semibold text-rag-red">Headline withheld — coverage is stale</div>
          <p class="text-[13px] text-carbon-2 mt-1">
            <template v-if="data.refusal.ageHours != null">
              {{ data.refusal.provider }} coverage is {{ Math.round(data.refusal.ageHours) }} h old against a
              {{ data.refusal.threshold }} h threshold.
            </template>
            <template v-else>
              We have no {{ data.refusal.provider }} observation to date this against.
            </template>
            Figures return when it catches up.
            <InfoDot
              label="Why this refuses instead of caveating"
            >A stale figure about a named individual is a finding-shaped risk, not a caveat. The stalest relevant provider decides — a fresh clock on one provider must not mask a stale one on another.</InfoDot>
          </p>
        </UiCard>

        <template v-else>
          <!-- The chip row — the SAME component and operands the me pages use -->
          <CcHeaderNotes
            v-if="data.meta"
            class="mt-4"
            :provider-states="data.meta.providerStates"
            :coverage="data.meta.coverage ?? undefined"
            placement-note
            lane="usage"
          />

          <!-- The SCOPE LINE — what this view is, and what it honestly is not -->
          <p class="mt-4 text-[12px] text-carbon-2 bg-calm-1/60 rounded-md px-3 py-2" data-testid="teammate-scope-line">
            <b>Scope:</b> rows homed to {{ data.scope.label }} · {{ windowWord }} — not necessarily this
            person's whole window: rows homed elsewhere before a move are outside this view.
          </p>

          <section class="mt-4 flex items-baseline gap-4 flex-wrap" data-testid="teammate-band">
            <span class="text-[13px] font-semibold text-carbon-2">{{ windowWord }}</span>
            <span class="text-[26px] font-bold text-carbon-1 tabular-nums">{{ fmtUsd(data.headlineUsd ?? 0) }}</span>
            <span class="text-[12px] text-carbon-3">attributed usage · in your scope</span>
          </section>

          <!-- TOKENSHEET — two operands per row (r1-H3) -->
          <UiCard class="mt-4" data-testid="teammate-tokensheet">
            <div class="flex items-baseline justify-between gap-3 flex-wrap">
              <div class="text-sm font-semibold text-carbon-1">TokenSheet by project</div>
              <ExportCsvButton
                :endpoint="`/api/v1/reports/teammate/${encodeURIComponent(subjectId)}/export`"
                :params="exportParams"
                :filename="`teammate-${data.subject.display_name}.csv`"
              />
            </div>
            <p class="text-[11px] text-carbon-3 mt-0.5">
              Contribution against each project's budget
              <InfoDot
                label="What these rows are"
              >Projects this teammate contributed to inside your scope window. Their contribution is scope-filtered; the share and the budget state are the WHOLE project over all members, because the budget belongs to the project. Never a behaviour norm, never a peer comparison.</InfoDot>
            </p>
            <table class="w-full text-sm mt-3">
              <thead>
                <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
                  <th class="text-left font-semibold py-2">Project</th>
                  <th class="text-right font-semibold py-2">Their contribution</th>
                  <th class="text-right font-semibold py-2">Share of project</th>
                  <th class="text-right font-semibold py-2 w-[160px]">Project budget state</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in data.tokensheet ?? []"
                  :key="r.project_id"
                  class="border-b border-calm-1 last:border-0"
                  data-testid="teammate-tokensheet-row"
                >
                  <td class="py-2.5">
                    <DrillName :target="projectTarget(r.project_code)" :label="r.project_name" />
                  </td>
                  <td class="py-2.5 text-right tabular-nums">{{ fmtUsd(Number(r.contribution_usd)) }}</td>
                  <td class="py-2.5 text-right tabular-nums text-carbon-2">
                    {{ r.share_pct == null ? '—' : fmtPct(r.share_pct) }}
                  </td>
                  <!-- The PROJECT's state, on the WHOLE-project window total —
                       the same figure its PM and the reports project axis see. -->
                  <td class="py-2.5 text-right">
                    <BudgetStateCell
                      :usd="Number(r.project_window_usd)"
                      :budget-usd="r.allocation_usd == null ? null : Number(r.allocation_usd)"
                    />
                  </td>
                </tr>
                <tr v-if="!(data.tokensheet ?? []).length">
                  <td colspan="4" class="py-8 text-center text-carbon-3 text-sm" data-testid="teammate-tokensheet-empty">
                    No project contribution in your scope for this window.
                  </td>
                </tr>
              </tbody>
            </table>
          </UiCard>

          <!-- THE TWO DIMENSIONS EVERY ARM CARRIES (annex :910-916) -->
          <UiCard class="mt-4" data-testid="teammate-mixes">
            <div class="text-sm font-semibold text-carbon-1">How it reached us</div>
            <p class="text-[11px] text-carbon-3 mt-0.5">The two dimensions every arm of the usage lane carries</p>
            <div
v-for="mix in [
              { key: 'surface', label: 'Surface', rows: data.surfaceMix ?? [] },
              { key: 'provenance', label: 'Provenance', rows: data.provenanceMix ?? [] },
            ]" :key="mix.key" class="mt-3" :data-testid="`teammate-mix-${mix.key}`">
              <div class="text-[11px] uppercase tracking-wide text-carbon-3 mb-1">{{ mix.label }}</div>
              <div class="flex h-3 rounded-full overflow-hidden bg-calm-1" role="img" :aria-label="`${mix.label} mix`">
                <span
                  v-for="(s, i) in mix.rows"
                  :key="s.key"
                  class="h-full"
                  :style="{ width: `${(s.sharePct * 100).toFixed(1)}%`, background: mixColor(i) }"
                  :title="`${s.label} — ${fmtUsd(s.usd)} · ${fmtPct(s.sharePct)}`"
                />
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                <span
                  v-for="(s, i) in mix.rows"
                  :key="s.key"
                  class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
                >
                  <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: mixColor(i) }" aria-hidden="true" />
                  {{ s.label }} {{ fmtPct(s.sharePct) }}
                </span>
              </div>
            </div>
          </UiCard>

          <!-- WORKLIST PRESSURE — informational here, actionable only by them -->
          <UiCard v-if="data.worklistPressure" class="mt-4" data-testid="teammate-worklist">
            <div class="text-sm font-semibold text-carbon-1">
              Spend with no project
              <InfoDot
                label="Whose action this is"
              >Unallocated spend inside your scope, split by the state it is in. Only "no project claim" can reach anyone's needs-tagging queue — activity-tagged spend is a decision already made, and untaggable spend is provider-reported usage with nothing to attach a project to. Everyone re-tags their own from their own worklist; this is informational here. Nudge, don't chase.</InfoDot>
            </div>
            <p class="text-[14px] text-carbon-1 mt-1">
              <b data-testid="teammate-worklist-untagged">{{ fmtUsd(Number(data.worklistPressure.untagged_usd)) }}</b>
              no project claim ·
              <b>{{ data.worklistPressure.untagged_days }}</b>
              day{{ data.worklistPressure.untagged_days === 1 ? '' : 's' }} in your scope
            </p>
            <!-- The OTHER no-project states, each on its own line and never
                 folded into the figure above (r3-M5). Zero states are elided:
                 a $0 row is a state the subject is not in. -->
            <p
              v-if="Number(data.worklistPressure.activity_tagged_usd) > 0 || Number(data.worklistPressure.untaggable_usd) > 0"
              class="text-[12px] text-carbon-2 mt-1 flex items-center gap-3 flex-wrap"
            >
              <span
                v-if="Number(data.worklistPressure.activity_tagged_usd) > 0"
                data-testid="teammate-worklist-activity-tagged"
              >
                <b>{{ fmtUsd(Number(data.worklistPressure.activity_tagged_usd)) }}</b> activity-tagged
              </span>
              <span
                v-if="Number(data.worklistPressure.untaggable_usd) > 0"
                data-testid="teammate-worklist-untaggable"
              >
                <b>{{ fmtUsd(Number(data.worklistPressure.untaggable_usd)) }}</b> untaggable
              </span>
            </p>
          </UiCard>
        </template>
      </template>
    </template>
  </div>
</template>
