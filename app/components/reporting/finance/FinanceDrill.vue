<script setup lang="ts">
/*
 * FinanceDrill — the per-CoU (`?cc=`) drill data view.
 *
 * Renders ONLY the data state (the skeleton / error / empty gating stays in
 * ScopeFinanceView). Restyled to the locked design language — hairline tiles for the
 * chargeable headline, UiCard section cards — while keeping the §B semantics intact:
 *   - Anthropic per-teammate charges (the bill names the person).
 *   - Copilot per-org pooled lines (chargeback mode) OR a pool-utilisation card
 *     (pool-utilisation mode; chargeback held back, "pending correct writer").
 *   - project overlay (chargeable split, Anthropic) via the shared DriversTable.
 *   - Overage Drivers — INFORMATIONAL proportional shares, NEVER a charge (D-Q6).
 *
 * An UNSETTLED CoU-month (a pooled line with usage but no read license SKU) drops the
 * unread license from Chargeable — the headline caveats it and shows amber, never a
 * silent green pass (M2).
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import type { DriverRow } from '#shared/reports/types'
import DriversTable, { type AxisOption } from '../DriversTable.vue'
import {
  projectDrillTarget,
  dimFact, teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
  type DrillTarget,
} from '../drill-contract'
import FinanceKpiTile from './FinanceKpiTile.vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import { vendorLaneColor, VENDOR_LANE_COLORS } from '../../../composables/useChartScale'
import { dominantLaneOf, type DominantLane } from './drill-lanes'
import { BUDGET_LABEL } from '#shared/reports/vocabulary'
import type { Vendor } from '#shared/usage/vendor'
import type { FinanceDrill } from '../finance-report-types'

const props = withDefaults(
  defineProps<{
    drill: FinanceDrill
    /** THE DRILL CONTRACT (D29/D30) — from the container; fail-closed defaults. */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
  }>(),
  { drillGrants: () => NO_DRILL_GRANTS, drillWindow: () => ({}) },
)

const emit = defineEmits<{ clearDrill: [] }>()

/*
 * THE DRILL CONTRACT (D29, fix 7). The finance pack is whole-company and
 * region-unbounded by design, so its frame token is `finance` — the grant that
 * admits this pack IS the frame a drill from it is computed under. The window
 * carried is the BILLING month the pack is on (useReportState owns it), so the
 * §A view a reader lands on covers the same period as the invoice they came
 * from.
 *
 * The overage rows are INFORMATIONAL shares of a pooled invoice, never a charge
 * — drilling one asks "who is this person, in §A terms", which is a different
 * question and lands on a page that says so.
 */
const drillGrants = computed(() => props.drillGrants)
const drillFrame = computed<DrillFrame>(() => ({ ...props.drillWindow, src: 'finance' }))
function projectDrillable(row: DriverRow): DrillTarget | null {
  return projectDrillTarget(drillGrants.value, row.dims?.project_code ?? null, drillFrame.value)
}
function teammateDrillable(row: DriverRow): DrillTarget | null {
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

// The KEY stays `'project'` (the wire, the export column and every saved
// `?axis=` URL); only the WORD is the product's own — shared/reports/vocabulary.ts.
const PROJECT_AXIS: AxisOption[] = [{ value: 'project', label: BUDGET_LABEL }]
const OVERAGE_AXIS: AxisOption[] = [{ value: 'teammate', label: 'Teammate' }]

// ── Dominant-lane badge per teammate row (lane-visuals V3, r1-F7/r2-5) ────────
// Row resolution, NOT a mini-stack: badge = the largest lane + its share of the
// row's charge; the rest itemise in the "+N surfaces" tooltip. ONE memoised
// map (r3-7): the template binds the badge several times per row, so the
// pick/sort runs once per teammate per data change, never once per binding.
const laneBadges = computed<ReadonlyMap<string, DominantLane | null>>(
  () =>
    new Map(
      props.drill.anthropicCharges.map((c) => [c.teammateId, dominantLaneOf(c.lanes ?? [], c.chargeUsd)]),
    ),
)

function laneSwatch(lane: string): string {
  return lane in VENDOR_LANE_COLORS ? vendorLaneColor(lane as Vendor) : 'var(--carbon-3)'
}

/** "+N surfaces" tooltip — the other lanes itemised largest-first. */
function othersTitle(b: DominantLane): string {
  return b.others.map((l) => `${l.label} ${fmtUsd(l.usd)}`).join(' · ')
}
</script>

<template>
  <div data-testid="finance-drill-data" class="space-y-6">
    <!-- Breadcrumb + back -->
    <nav class="text-[12px] text-carbon-3" aria-label="Breadcrumb" data-testid="finance-drill-crumb">
      <button
        type="button"
        class="hover:text-brand-harmony hover:underline"
        @click="emit('clearDrill')"
      >Finance</button>
      <span class="mx-1.5">›</span>
      <span class="text-carbon-1 font-semibold">{{ drill.cou.displayName }}</span>
      <span v-if="drill.cou.regionCode" class="text-carbon-3"> · {{ drill.cou.regionCode.toUpperCase() }}</span>
    </nav>

    <span class="block text-[11px] text-carbon-3 italic" data-testid="finance-drill-homing">
      {{ drill.homingNote }}
    </span>

    <!-- Chargeable headline — hairline tiles -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div
        class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
        data-testid="finance-drill-chargeable"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3">Chargeable</span>
          <UiBadge
            v-if="drill.copilot.pending"
            kind="rag-amber"
            dot="amber"
            data-testid="finance-copilot-pending-chip"
            title="Copilot pooled chargeback is not yet validated against the bill, so this is Anthropic chargeable only until then."
          >Copilot chargeback pending</UiBadge>
          <UiBadge
            v-else-if="drill.copilot.unsettled"
            kind="rag-amber"
            dot="amber"
            data-testid="finance-copilot-unsettled-chip"
            title="A pooled line has usage but no read license SKU — the Chargeable figure excludes the unread license until the month settles."
          >Copilot unsettled — excludes license</UiBadge>
          <UiBadge v-else kind="vision" dot="vision" data-testid="finance-copilot-chargeback-chip">Copilot pooled net included</UiBadge>
        </div>
        <div class="text-[30px] leading-none font-extrabold tracking-[-1px] text-carbon tabular-nums">
          {{ fmtUsd(drill.chargeableUsd) }}
        </div>
        <div class="text-[12px] text-carbon-2">Anthropic per-teammate + Copilot pooled net</div>
        <!-- M2: unsettled CoU-month drops the unread license — caveat, never a silent pass -->
        <div
          v-if="drill.copilot.unsettled"
          class="mt-0.5 text-[11px] text-rag-amber font-semibold leading-snug"
          data-testid="finance-drill-chargeable-caveat"
        >
          Excludes unread license — unsettled (a pooled line has usage but no read license SKU).
        </div>
      </div>

      <FinanceKpiTile
        label="Anthropic chargeable"
        :value="fmtUsd(drill.anthropicChargeableUsd)"
        sub="per-teammate (exempt-excluded)"
      />
      <FinanceKpiTile
        label="Copilot pooled"
        :value="drill.copilot.chargeableUsd != null ? fmtUsd(drill.copilot.chargeableUsd) : 'pending'"
        :sub="drill.copilot.unclassifiedNetUsd > 0
          ? `pooled net (org → Business Unit) · + ${fmtUsd(drill.copilot.unclassifiedNetUsd)} unclassified (needs mapping, never charged)`
          : 'pooled net (org → Business Unit)'"
      />
    </div>

    <!-- Anthropic per-teammate charges -->
    <UiCard data-testid="finance-anthropic-charges">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Anthropic — per-teammate charges</div>
      <div class="text-[11px] text-carbon-3 mb-3">Homed to the current Business Unit structure.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Teammate</th>
              <th class="text-left font-semibold py-2">Surface</th>
              <th class="text-right font-semibold py-2">Charge</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in drill.anthropicCharges" :key="c.teammateId" class="border-b border-calm-1 last:border-0">
              <td class="py-2.5 text-carbon-1">{{ c.label }}</td>
              <!-- Dominant-lane badge (V3, r1-F7): lane chip + label + its share of THIS
                   row's charge; near-tied splits read via the share % + the "+N surfaces"
                   tooltip (r2-5) — deliberately NOT a per-row mini-stack. With a negative
                   (credit) lane in the row the share is suppressed (r3-5: it would read
                   >100%) — the badge shows the lane's $ instead; the tooltip still itemises. -->
              <td class="py-2.5">
                <template v-if="laneBadges.get(c.teammateId)">
                  <span
                    class="inline-flex items-center gap-1.5 text-[12px] text-carbon-2"
                    data-testid="finance-drill-lane-badge"
                    :data-lane="laneBadges.get(c.teammateId)!.lane"
                  >
                    <span
                      class="inline-block w-2 h-2 rounded-sm shrink-0"
                      :style="{ background: laneSwatch(laneBadges.get(c.teammateId)!.lane) }"
                      aria-hidden="true"
                    />
                    {{ laneBadges.get(c.teammateId)!.label }}
                    <span class="text-carbon-3 tabular-nums">{{
                      laneBadges.get(c.teammateId)!.sharePct != null
                        ? fmtPct(laneBadges.get(c.teammateId)!.sharePct!)
                        : fmtUsd(laneBadges.get(c.teammateId)!.usd)
                    }}</span>
                    <span
                      v-if="laneBadges.get(c.teammateId)!.othersCount > 0"
                      class="text-[11px] text-carbon-3 underline decoration-dotted cursor-help"
                      data-testid="finance-drill-lane-others"
                      :title="othersTitle(laneBadges.get(c.teammateId)!)"
                    >+{{ laneBadges.get(c.teammateId)!.othersCount }} {{ laneBadges.get(c.teammateId)!.othersCount === 1 ? 'surface' : 'surfaces' }}</span>
                  </span>
                </template>
                <span v-else class="text-carbon-3">—</span>
              </td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(c.chargeUsd) }}</td>
            </tr>
            <tr v-if="!drill.anthropicCharges.length">
              <td colspan="3" class="py-6 text-center text-carbon-3 text-sm">No Anthropic charges for this month.</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t-2 border-calm-2 text-carbon-2">
              <td colspan="2" class="py-2.5 font-semibold">Total Anthropic chargeable</td>
              <td class="py-2.5 text-right tabular-nums font-semibold">{{ fmtUsd(drill.anthropicChargeableUsd) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </UiCard>

    <!-- Copilot: per-org pooled lines (chargeback mode) OR pool-utilisation card -->
    <UiCard v-if="drill.copilot.pooledLines" data-testid="finance-copilot-pooled-lines">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Copilot — per-org pooled lines</div>
      <!-- Both kept facts name money the reader can see in this table and would
           otherwise misread: the lines are pooled (so no per-user charge exists),
           and the Unclassified column is shown but never charged. Where the
           figures are read from went to the comment. -->
      <div class="text-[11px] text-carbon-3 mb-3">Pooled — never a per-user charge. Unclassified lines are shown but never chargeable.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm min-w-[560px]">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Org</th>
              <th class="text-right font-semibold py-2">License net</th>
              <th class="text-right font-semibold py-2">Overage net</th>
              <th class="text-right font-semibold py-2">Unclassified</th>
              <th class="text-right font-semibold py-2">Net</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in drill.copilot.pooledLines" :key="l.orgId ?? 'residual'" class="border-b border-calm-1 last:border-0">
              <td class="py-2.5 text-carbon-1">
                {{ l.label }}
                <UiBadge v-if="l.unsettled" kind="rag-red" dot="red" class="ml-1.5">unsettled</UiBadge>
              </td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(l.licenseUsd) }}</td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(l.overageUsd) }}</td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">
                <template v-if="l.unclassifiedUsd !== 0">
                  {{ fmtUsd(l.unclassifiedUsd) }}
                  <UiBadge
                    kind="rag-amber"
                    dot="amber"
                    class="ml-1.5"
                    data-testid="finance-copilot-unclassified-badge"
                    title="Copilot bill lines matching no SKU classifier — excluded from every chargeable figure until classified (extend the SKU maps + re-run the month)."
                  >needs mapping</UiBadge>
                </template>
                <span v-else class="text-carbon-3">—</span>
              </td>
              <td class="py-2.5 text-right tabular-nums font-semibold text-carbon-1">{{ fmtUsd(l.netUsd) }}</td>
            </tr>
            <tr v-if="!drill.copilot.pooledLines.length">
              <td colspan="5" class="py-6 text-center text-carbon-3 text-sm">No Copilot pooled bill homed to this unit this month.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard v-else-if="drill.copilot.poolUtilisation" data-testid="finance-copilot-pool-card">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Copilot — pool utilisation</div>
      <div class="text-[11px] text-carbon-3 mb-3" data-testid="finance-copilot-pending-note">
        Chargeback is held back until validated; usage against the pool allowance is an estimate.
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FinanceKpiTile label="Gross usage" :value="fmtUsd(drill.copilot.poolUtilisation.usageGrossUsd)" sub="ai-credit gross (estimate)" />
        <FinanceKpiTile label="Pool allowance" :value="fmtUsd(drill.copilot.poolUtilisation.poolUsd)" sub="included discount line" />
        <FinanceKpiTile
          label="Utilisation"
          :value="drill.copilot.poolUtilisation.utilisation != null ? fmtPct(drill.copilot.poolUtilisation.utilisation) : 'n/a'"
          sub="gross ÷ pool"
        />
      </div>
      <!-- Unclassified is visible in EVERY mode (chargeable in none) — badged, never silent. -->
      <div
        v-if="drill.copilot.poolUtilisation.unclassifiedNetUsd > 0"
        class="mt-3 flex items-center gap-2 text-[12px] text-carbon-2"
        data-testid="finance-copilot-pool-unclassified"
      >
        <UiBadge
          kind="rag-amber"
          dot="amber"
          title="Copilot bill lines matching no SKU classifier — excluded from every chargeable figure until classified (extend the SKU maps + re-run the month)."
        >needs mapping</UiBadge>
        <span class="tabular-nums font-semibold">{{ fmtUsd(drill.copilot.poolUtilisation.unclassifiedNetUsd) }}</span>
        <span>unclassified Copilot bill lines this period — never charged.</span>
      </div>
    </UiCard>

    <!-- Project overlay (chargeable split, Anthropic) -->
    <UiCard data-testid="finance-project-overlay">
      <div class="text-sm font-semibold text-carbon-1 mb-3">Project overlay (Anthropic chargeable split)</div>
      <DriversTable
        :rows="drill.projectOverlay"
        :headline-usd="drill.projectHeadlineUsd"
        axis="project"
        :axis-options="PROJECT_AXIS"
        denominator-label="Anthropic chargeable"
        :drillable="projectDrillable"
      />
    </UiCard>

    <!-- Overage Drivers (INFORMATIONAL — never a charge; D-Q6) -->
    <UiCard v-if="drill.overageDrivers" data-testid="finance-overage-drivers">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Overage drivers</div>
      <div class="text-[11px] text-carbon-3 mb-3" data-testid="finance-overage-note">
        Indicative share of the {{ fmtUsd(drill.overageDrivers.overageNetUsd) }} pooled overage —
        never a charge.
      </div>
      <DriversTable
        :rows="drill.overageDrivers.rows"
        :headline-usd="drill.overageDrivers.overageNetUsd"
        axis="teammate"
        :axis-options="OVERAGE_AXIS"
        denominator-label="paid overage (informational)"
        :drillable="teammateDrillable"
      />
    </UiCard>
  </div>
</template>
