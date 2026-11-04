<script setup lang="ts">
/*
 * FinanceBillCompare — the bill-vs-chargeback comparison, one paired bar per
 * provider (Anthropic magenta, GitHub Copilot blue).
 *
 * For each provider we draw two rounded bars on a shared scale: what the vendor
 * INVOICES (bill) and what we CHARGE BACK. In a reconciled month the two are equal
 * — the bars line up, which is the reassurance finance wants. When they diverge (an
 * unsettled month drops an unread license, or a genuine reconciliation break) the
 * gap is immediately legible and the delta chip goes RAG.
 *
 * Colour rules (locked): the provider IDENTITY carries the categorical hue
 * (Claude/Anthropic = brand-hunger, Copilot = brand-vision) — never purple, never a
 * ranking cycle. The bill vs chargeback within a provider are the SAME hue at two
 * weights (solid chargeback, light bill track) so the comparison reads as one
 * provider, not two categories. The delta is a status, so it (and only it) uses RAG.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import { fmtUsd } from '../../../composables/useFormat'
import { vendorLaneColor, VENDOR_LANE_COLORS } from '../../../composables/useChartScale'
import { foldLaneTotals, FOLDED_LANE_ID } from '../charts/fold-lanes'
import { COPILOT_UNCLASSIFIED_LANE } from '#shared/usage/github-surface'
import type { Vendor } from '#shared/usage/vendor'
import type { FinanceBillCheck, FinanceCouLane } from '../finance-report-types'

const props = defineProps<{
  check: FinanceBillCheck
  /** Copilot pooled chargeback held back (pool-utilisation mode) — a per-row note. */
  copilotPending: boolean
}>()

interface CompareRow {
  key: string
  label: string
  hue: 'hunger' | 'vision'
  billUsd: number
  chargebackUsd: number
  unsettled: boolean
  pending: boolean
}

const rows = computed<CompareRow[]>(() => {
  const c = props.check
  const billFor = (provider: string) =>
    c.providers.find((p) => p.provider === provider)?.billUsd ?? 0
  const unsettledFor = (provider: string) =>
    c.providers.find((p) => p.provider === provider)?.unsettled ?? false
  // Anthropic chargeback = whole chargeback − the Copilot portion (Σ of the three
  // §B chargeback lanes — copilot-license / copilot-usage / copilot-unclassified).
  const anthropicChargeback = c.chargebackUsd - c.copilotChargebackUsd
  return [
    {
      key: 'anthropic',
      label: 'Anthropic',
      hue: 'hunger' as const,
      billUsd: billFor('anthropic'),
      chargebackUsd: anthropicChargeback,
      unsettled: unsettledFor('anthropic'),
      pending: false,
    },
    {
      key: 'copilot',
      label: 'GitHub Copilot',
      hue: 'vision' as const,
      billUsd: billFor('github'),
      chargebackUsd: c.copilotChargebackUsd,
      unsettled: unsettledFor('github'),
      pending: props.copilotPending,
    },
    // A provider whose chargeback is HELD BACK (pooled Copilot pending cutover) is
    // kept even at $0.00 — the prototype's finance band lists it explicitly as
    // "GitHub Copilot · Pooled net — pending cutover". Dropping it made the whole
    // comparison card disappear on a period whose only Copilot state was "pending",
    // which reads as "this provider does not exist" rather than "not charged yet".
  ].filter((r) => hasMoney(r) || r.pending)
})

const max = computed(() =>
  rows.value.reduce((m, r) => Math.max(m, r.billUsd, r.chargebackUsd), 0),
)
/*
 * The card renders whenever there is a provider row to show — INCLUDING a pending
 * row whose bars are both $0.00. Gating on `max > 0` as well meant a period with a
 * pending-cutover Copilot and no Anthropic bill silently removed the entire
 * "Bill vs chargeback" band from the Finance report, with nothing in its place.
 * With no rows at all the card still stands down: FinanceBillCheck above already
 * carries "No provider bill for this period yet", and that fact keeps one home.
 */
const hasData = computed(() => rows.value.length > 0)

function pct(v: number): string {
  const p = max.value > 0 ? Math.min(100, (v / max.value) * 100) : 0
  return `${p.toFixed(2)}%`
}
/**
 * Does this row carry any money at all? A row at $0.00 on BOTH bars is kept only
 * because it is pending, and it must make no reconciliation claim: "✓ matched" over
 * $0.00 vs $0.00 is arithmetically true and completely vacuous — a green tick on a
 * provider that has not been charged yet reads as a settled month.
 */
function hasMoney(r: { billUsd: number; chargebackUsd: number }): boolean {
  return r.billUsd > 0.005 || r.chargebackUsd > 0.005
}
function delta(r: CompareRow): number {
  return r.chargebackUsd - r.billUsd
}
function matched(r: CompareRow): boolean {
  return Math.abs(delta(r)) < 0.005 && !r.unsettled
}

// ── Per-lane structure within each provider group (lane-visuals V3, folded) ──
// A rendered lane chip row (folded per r1-F3): the kept lanes + (when folding
// occurred) ONE "Other surfaces" remainder whose tooltip itemises the fold.
interface RenderedLane extends FinanceCouLane {
  /** Tooltip itemisation for the folded remainder; undefined on real lanes. */
  foldedTitle?: string
}

/** Fold a provider group's lanes to ≤ 5 rows (r1-F3 — donut/composition cap). */
function foldGroup(rows: FinanceCouLane[]): RenderedLane[] {
  const live = rows.filter((l) => l.usd !== 0)
  const folded = foldLaneTotals(
    live.map((l) => ({ lane: l.lane, label: l.label, value: l.usd })),
    { max: 5 },
  )
  const foldedTitle = folded.folded.map((f) => `${f.label} ${fmtUsd(f.total)}`).join(' · ')
  return folded.totals.map((t) => ({
    lane: t.lane,
    label: t.label,
    usd: t.value,
    ...(t.lane === FOLDED_LANE_ID ? { foldedTitle } : {}),
  }))
}

// The GitHub chargeback split by §B lane (registry order, zero lanes elided —
// the wire carries all three; 3 ≤ 5 so the fold is an identity today).
// copilot-unclassified is badged "needs mapping": it is in the Σ=bill footing
// (whole-truth) but never in a chargeable total.
const copilotLanes = computed<RenderedLane[]>(() => foldGroup(props.check.copilotLanes ?? []))
// The Anthropic chargeback split by surface lane (V3) — up to 8 registry lanes,
// so this group genuinely folds. Σ (pre-fold == post-fold, conservation by
// construction) == the Anthropic chargeback bar above it.
const anthropicLanes = computed<RenderedLane[]>(() => foldGroup(props.check.anthropicLanes ?? []))
const lanesFor = (key: string): RenderedLane[] =>
  key === 'copilot' ? copilotLanes.value : anthropicLanes.value
const isUnclassified = (l: FinanceCouLane) => l.lane === COPILOT_UNCLASSIFIED_LANE

function laneSwatch(lane: string): string {
  if (lane === FOLDED_LANE_ID) return 'var(--carbon-3)'
  return lane in VENDOR_LANE_COLORS ? vendorLaneColor(lane as Vendor) : 'var(--carbon-3)'
}

const SOLID: Record<'hunger' | 'vision', string> = {
  hunger: 'bg-brand-hunger',
  vision: 'bg-brand-vision',
}
const DOT = SOLID
const TRACK: Record<'hunger' | 'vision', string> = {
  hunger: 'bg-brand-hunger/20',
  vision: 'bg-brand-vision/20',
}
</script>

<template>
  <UiCard
    v-if="hasData"
    data-testid="finance-bill-compare"
  >
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Bill vs chargeback by provider</div>
      <div class="text-[11px] text-carbon-3">What the vendor invoices vs what we charge back · this period</div>
    </div>

    <div class="mt-5 space-y-6">
      <div v-for="r in rows" :key="r.key" data-testid="finance-compare-row" :data-provider="r.key">
        <!-- Provider header + reconciliation status -->
        <div class="flex items-center justify-between gap-3 mb-2.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :class="DOT[r.hue]" aria-hidden="true" />
            <span class="text-[13px] font-semibold text-carbon-1 truncate">{{ r.label }}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span
              v-if="r.pending"
              class="px-1.5 py-px rounded bg-rag-amber/12 text-[#92400E] text-[10px] font-bold uppercase tracking-wide"
              title="Copilot pooled chargeback is held back from the per-Business Unit column until it is validated against the bill."
            >pending cutover</span>
            <!-- The reconciliation verdict is withheld on a row with no money on
                 either bar (kept only because it is pending). "matched" there would
                 be $0.00 against $0.00 — true, vacuous, and read as a settled month. -->
            <template v-if="hasMoney(r)">
              <span
                v-if="matched(r)"
                class="inline-flex items-center gap-1 text-[11px] text-carbon-3 font-semibold tabular-nums"
              >
                <svg viewBox="0 0 20 20" fill="none" class="w-3 h-3" aria-hidden="true">
                  <path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                matched
              </span>
              <span
                v-else-if="r.unsettled"
                class="text-[11px] text-rag-amber font-bold"
              >unsettled</span>
              <span
                v-else
                class="text-[11px] text-rag-red font-bold tabular-nums"
              >Δ {{ fmtUsd(delta(r)) }}</span>
            </template>
          </div>
        </div>

        <!-- Paired bars: chargeback (solid) over bill (light), shared scale -->
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <span class="w-[86px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-carbon-3">Chargeback</span>
            <div class="flex-1 h-2.5 rounded-full bg-calm-2/60 overflow-hidden">
              <div class="h-full rounded-full" :class="SOLID[r.hue]" :style="{ width: pct(r.chargebackUsd) }" />
            </div>
            <span class="w-[68px] shrink-0 text-right text-[12px] font-semibold text-carbon tabular-nums">{{ fmtUsd(r.chargebackUsd) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-[86px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-carbon-3">Bill</span>
            <div class="flex-1 h-2.5 rounded-full bg-calm-2/60 overflow-hidden">
              <div class="h-full rounded-full" :class="TRACK[r.hue]" :style="{ width: pct(r.billUsd) }" />
            </div>
            <span class="w-[68px] shrink-0 text-right text-[12px] text-carbon-2 tabular-nums">{{ fmtUsd(r.billUsd) }}</span>
          </div>
        </div>

        <!-- Per-lane structure within the provider group (lane-visuals V3, folded per
             r1-F3): Anthropic by surface lane, GitHub by §B chargeback lane. FIXED
             lane colours, zero lanes elided, ≤ 5 chips + one "Other surfaces"
             remainder (tooltip itemises the fold). Unclassified is badged — in the
             Σ=bill footing, never in a chargeable total. Not a legend: each chip
             carries its label + exact $ (identity never colour-alone). -->
        <div
          v-if="lanesFor(r.key).length"
          class="mt-2.5 ml-[86px] flex flex-wrap gap-x-4 gap-y-1.5"
          :data-testid="`finance-compare-${r.key}-lanes`"
        >
          <span
            v-for="l in lanesFor(r.key)"
            :key="l.lane"
            class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2 tabular-nums"
            :class="{ 'cursor-help': l.foldedTitle }"
            :data-testid="`finance-compare-lane-${l.lane}`"
            :title="l.foldedTitle"
          >
            <span
              class="inline-block w-2 h-2 rounded-sm shrink-0"
              :style="{ background: laneSwatch(l.lane) }"
              aria-hidden="true"
            />
            {{ l.label }} · {{ fmtUsd(l.usd) }}
            <UiBadge
              v-if="isUnclassified(l)"
              kind="rag-amber"
              dot="amber"
              data-testid="finance-compare-unclassified-badge"
              title="Copilot bill lines matching no SKU classifier — in the bill total but excluded from every chargeable total until classified."
            >needs mapping</UiBadge>
          </span>
        </div>
      </div>
    </div>
  </UiCard>
</template>
