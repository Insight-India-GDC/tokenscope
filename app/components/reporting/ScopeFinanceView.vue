<script setup lang="ts">
/*
 * ScopeFinanceView — the PRESENTATIONAL Finance (§B chargeback / bill-reconciliation)
 * tree. Answers "does what we charge back reconcile to the vendor bill, and where's
 * the gap?".
 *
 * PURE + prop-driven: the fetches, the URL state, and the header (DateRangeControl +
 * the ONE settling chip) all live in the ScopeFinance container, so this view stays
 * bare-mountable and every render state is unit-testable without a Nuxt runtime. That
 * is a deliberate improvement over the Across flagship, which put the
 * useReportState-bound DateRangeControl inside its view and thereby broke the view's
 * bare unit mount. Visually the header/body split is identical.
 *
 * Exactly ONE of skeleton / error / empty / data renders for the INDEX (no `cc`) and,
 * independently, for the DRILL (`cc` set). The §A/§B firewall is intact — this is the
 * §B billing/chargeback view; §A usage lives in the other scopes.
 *
 *   index → Σ chargeback = bill reconciliation (the trust anchor, RAG status)
 *         → bill-vs-chargeback paired bars per provider
 *         → exempt / non-chargeable gap (hairline tiles)
 *         → chargeback by cost-owning unit (ranked bar + table)
 *   drill → per-CoU charges (Anthropic per-teammate · Copilot pooled · overage drivers)
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import FinanceBillCheck from './finance/FinanceBillCheck.vue'
import FinanceBillCompare from './finance/FinanceBillCompare.vue'
import FinanceExemptGap from './finance/FinanceExemptGap.vue'
import FinanceCouTable from './finance/FinanceCouTable.vue'
import FinanceDrill from './finance/FinanceDrill.vue'
import {
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from './drill-contract'
import type { FinanceReport, FinanceDrill as FinanceDrillData } from './finance-report-types'

const props = withDefaults(
  defineProps<{
    report: FinanceReport | null
    drill: FinanceDrillData | null
    /** True while `?cc=` is set — the drill drives the four states, not the index. */
    isDrill: boolean
    pending: boolean
    error?: unknown
    drillPending: boolean
    drillError?: unknown
    /** Ledger export params (report=ledger). */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
    /** The ledger CSV is month-grained (D-Q8); hide the export in a multi-month range. */
    ledgerMonthOnly?: boolean
    /** THE DRILL CONTRACT (D29/D30) — from the container; fail-closed defaults. */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
    /** Admin-only "Fix org homing →" — from the container's session; fail-closed. */
    canFixHoming?: boolean
  }>(),
  {
    error: undefined,
    drillError: undefined,
    ledgerMonthOnly: false,
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
    canFixHoming: false,
  },
)

const emit = defineEmits<{
  drill: [couId: string]
  clearDrill: []
}>()

/*
 * ── Index: exactly one of skeleton / error / empty / data ────────────────────
 *
 * EXHAUSTIVE, not merely mutually exclusive. The four states have to COVER every
 * prop combination; excluding each other is not enough, and this is where the
 * blank Finance page came from.
 *
 * `report === null` with `pending === false` and no error is a REAL state: it is
 * what Nuxt reports on the server pass for the container's
 * `useFetch(..., { lazy: true, server: false })` — the fetch is deliberately not run
 * during SSR, so nothing is in flight and no data has arrived. Keying the skeleton
 * on `pending` meant that state matched skeleton=false, error=false, empty=false
 * (the empty predicate returns false for a null report) and data=false — all four
 * branches missed and the body rendered NOTHING. The header sits in the container,
 * so the page painted its title, period control and "defaults to the last complete
 * month" line above an empty space, then hydration mismatched against the client's
 * skeleton.
 *
 * So the skeleton is keyed on the ABSENCE OF DATA, never on an in-flight flag:
 * "no error and no report" IS the loading state, whichever pass we are on.
 * `pending` stays the container's honest in-flight marker (and keeps already-loaded
 * data on screen across a refetch instead of flashing a skeleton), but it can no
 * longer be the difference between a body and a blank page.
 */
const indexError = computed(() => Boolean(props.error))
const indexSkeleton = computed(() => !indexError.value && !props.report)
const indexEmpty = computed(() => {
  const r = props.report
  if (!r) return false
  return (
    r.cous.length === 0 &&
    r.billCheck.chargebackUsd === 0 &&
    r.billCheck.billUsd === 0 &&
    r.exemptGap.indicativeUsageUsd === 0
  )
})
const indexData = computed(() => Boolean(props.report) && !indexError.value && !indexEmpty.value)

// ── Drill: exactly one of skeleton / error / empty / data ────────────────────
// Same exhaustiveness rule as the index above — a null drill with nothing in
// flight is the loading state, not a fifth (blank) branch.
const drillErr = computed(() => Boolean(props.drillError))
const drillSkeleton = computed(() => !drillErr.value && !props.drill)
const drillEmpty = computed(
  () =>
    Boolean(props.drill) &&
    props.drill!.anthropicChargeableUsd === 0 &&
    props.drill!.chargeableUsd === 0 &&
    props.drill!.anthropicCharges.length === 0 &&
    (props.drill!.copilot.pooledLines?.length ?? 0) === 0 &&
    (props.drill!.copilot.poolUtilisation?.usageGrossUsd ?? 0) === 0,
)
const drillData = computed(() => Boolean(props.drill) && !drillErr.value && !drillEmpty.value)

const copilotPending = computed(() => props.report?.copilot.pending ?? false)
// ADVISORY page-level amber banner (r1 finding 10): chargeback mode is live while the
// window carries unclassified Copilot spend. Never blocks the data — unclassified is
// already excluded from every chargeable figure; this surfaces the runbook state.
const unclassifiedWarning = computed(() => props.report?.copilot.unclassifiedWarning ?? false)
</script>

<template>
  <div data-testid="scope-finance">
    <!-- ═══════════════════ DRILL (`?cc=`) ═══════════════════ -->
    <template v-if="isDrill">
      <ReportSkeleton v-if="drillSkeleton" />
      <UiFetchErrorBanner v-else-if="drillErr" :error="drillError" />
      <ReportEmpty
        v-else-if="drillEmpty"
        headline="No chargeback rows for this Business Unit and month yet."
        sub="As the month's bills land and reconcile, the per-teammate and pooled charges fill in."
      />
      <FinanceDrill
        v-else-if="drillData && drill"
        :drill="drill"
        :drill-grants="drillGrants"
        :drill-window="drillWindow"
        @clear-drill="emit('clearDrill')"
      />
    </template>

    <!-- ═══════════════════ INDEX (no `cc`) ═══════════════════ -->
    <template v-else>
      <ReportSkeleton v-if="indexSkeleton" :kpis="3" />
      <UiFetchErrorBanner v-else-if="indexError" :error="error" />
      <ReportEmpty
        v-else-if="indexEmpty"
        headline="No finance data for this period yet."
        sub="Pick a settled month — as the provider bills land and reconcile, the chargeback pack fills in."
      />
      <div v-else-if="indexData && report" data-testid="finance-index-data" class="space-y-6">
        <span class="block text-[11px] text-carbon-3 italic" data-testid="finance-homing">{{ report.homingNote }}</span>

        <!-- ADVISORY amber banner: chargeback mode is enabled while the period carries
             unclassified Copilot spend (r1 finding 10). Data is never blocked —
             unclassified is excluded from every chargeable figure regardless. -->
        <div
          v-if="unclassifiedWarning"
          role="status"
          class="rounded-md border border-rag-amber/40 bg-rag-amber/10 px-3 py-2 text-[12px] text-[#92400E]"
          data-testid="finance-unclassified-warning"
        >
          <span class="font-semibold">Copilot chargeback is enabled with unclassified Copilot spend in this period.</span>
          Unclassified lines stay excluded from every chargeable figure — classify the SKU and re-run the month.
        </div>

        <!-- The trust anchor: Σ chargeback = bill (RAG reconciliation status) -->
        <FinanceBillCheck :check="report.billCheck" :copilot-pending="copilotPending" />

        <!-- Bill vs chargeback, paired bars per provider -->
        <FinanceBillCompare :check="report.billCheck" :copilot-pending="copilotPending" />

        <!-- Exempt / non-chargeable gap (hairline tiles) -->
        <FinanceExemptGap :gap="report.exemptGap" :copilot-pending="copilotPending" />

        <!-- Chargeback by cost-owning unit (ranked bar + table) -->
        <FinanceCouTable
          :cous="report.cous"
          :copilot-pending="copilotPending"
          :can-fix-homing="props.canFixHoming"
          @drill="emit('drill', $event)"
        />

        <div class="flex justify-end pt-2">
          <span
            v-if="ledgerMonthOnly"
            class="text-[11px] text-carbon-3 italic"
            data-testid="finance-ledger-month-only"
          >The ledger export is month-grained — select a single month to export it.</span>
          <ExportCsvButton
            v-else
            endpoint="/api/v1/reports/export"
            :params="exportParams"
            :filename="exportFilename"
          />
        </div>
      </div>
    </template>
  </div>
</template>
