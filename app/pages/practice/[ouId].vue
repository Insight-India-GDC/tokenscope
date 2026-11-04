<script setup lang="ts">
/*
 * Practice detail (AEUF "Practice · MPO"). The dual-lane single-practice view: the reconciled
 * bill alongside the usage signal, vendor split, per-surface bill lanes (#142 — chat / Cowork /
 * Office / … become visible here), 14-week trend, users + triggers, top models, and a sibling
 * comparison. Reached by drilling a practice card on /org-rollup. Authz + data:
 * server/api/v1/rollups/practice/[ouId].get.ts, docs/design/aeuf-region-practice-views.md.
 */
import type { Vendor } from '#shared/usage/vendor'
import { FOLDED_LANE_ID } from '~/components/reporting/charts/fold-lanes'
import {
  buildPracticeBillLanes,
  buildPracticeBillWeekly,
} from '~/components/reporting/build-practice-bill-lanes'
import { chargebackLegendLanes } from '~/components/reporting/build-chargeback-trend'
import LaneLegend from '~/components/reporting/LaneLegend.vue'

interface Resp {
  period: string
  practice: { id: string; code: string; displayName: string; regionId: string }
  header: { usageUsd: number; tokens: number; users: number; avgPerUser: number; pctOfRegion: number | null; vsRegionAvgPct: number | null }
  lanes: { usageSignalUsd: number; billUsd: number; billTokens: number }
  /*
   * Ordered per-lane split (#142). Non-Code Claude lanes are BILL-only (usageUsd
   * structurally 0 — they never emit OTel); all-zero lanes are elided server-side
   * except claude/copilot, which always appear.
   */
  vendorSplit: { lane: Vendor; label: string; usageUsd: number; billUsd: number }[]
  /*
   * Weekly per-lane §B bill series (lane-visuals V4): (weekStart, lane, usd)
   * cells over the trailing 14 weeks, registry lane ids, canonical order.
   * Σ lanes per week == that week's showback total (server-conserved).
   */
  billWeeklyLanes: { weekStart: string; lane: string; usd: number }[]
  topModels: { model: string; usageUsd: number }[]
  users: { teammateId: string; name: string; spendUsd: number; vendors: string[]; flagged: boolean }[]
  trend: { weekStart: string; claudeUsd: number; copilotUsd: number }[]
  comparison: { id: string; code: string; displayName: string; usageUsd: number; claudeUsd: number; copilotUsd: number; isSelf: boolean }[]
  planMix: null
}

const route = useRoute()
const ouId = computed(() => String(route.params.ouId))
// Interpolated into request URLs below, and Vue Router has already decoded it:
// a crafted `..%2F` link must not re-route a PATCH to another resource.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ouId.value)) {
  throw createError({ statusCode: 404, statusMessage: 'Practice not found', fatal: true })
}
const { data, pending, error } = await useFetch<Resp>(() => `/api/v1/rollups/practice/${encodeURIComponent(ouId.value)}`)

const crumbs = computed(() => [{ label: 'Home', to: '/' }, { label: 'Reporting', to: '/reporting?scope=region' }, { label: data.value?.practice.displayName ?? 'Practice' }])

const laneUsageUsd = (lane: Vendor) => data.value?.vendorSplit.find((l) => l.lane === lane)?.usageUsd ?? 0

// USAGE-signal donut — non-Code lanes carry no OTel (usageUsd 0), so this stays
// effectively claude/copilot/other. Colours are FIXED per lane id (useChartScale).
const vendorSlices = computed(() =>
  (data.value?.vendorSplit ?? [])
    .filter((l) => l.usageUsd > 0)
    .map((l) => ({ label: l.label, value: l.usageUsd, color: vendorLaneColor(l.lane) })),
)

const laneSwatch = (lane: string): string =>
  lane === FOLDED_LANE_ID ? 'var(--carbon-3)' : vendorLaneColor(lane as Vendor)

// RECONCILED-bill lanes (#142) — where chat / Cowork / Office / … become visible.
// FOLDED to the SAME shared cap as the weekly stack beside it (MAX_CHART_LANES,
// r3-4): both cards feed the one page legend, so their kept-lane sets must be
// identical — an unfolded MTD bar could render 8+ slivers the weekly stack
// never shows as distinct colours. The remainder segment's tooltip itemises.
const billLanes = computed(() => {
  const built = buildPracticeBillLanes(data.value?.vendorSplit ?? [], data.value?.lanes.billUsd ?? 0)
  const foldedTitle = built.folded.map((f) => `${f.label} ${fmtUsd(f.total)}`).join(' · ')
  return built.lanes.map((l) => ({
    ...l,
    color: laneSwatch(l.lane),
    foldedTitle: l.lane === FOLDED_LANE_ID ? foldedTitle : undefined,
  }))
})
// ── Weekly §B bill-by-surface stacked bars (lane-visuals V4) ─────────────────
// FOLDED per V1 (rank-once over the whole 14-week window, ≤ MAX_CHART_LANES
// series — the shared page cap, conservation-preserving); §B ONLY
// (v_finance_bill_showback) — never summed with the usage-signal trend beside
// it. Rendered in the page's hand-rolled stacked-bar idiom (the 14-week trend
// card), colours from the lane registry.
const billWeekly = computed(() => {
  const built = buildPracticeBillWeekly(data.value?.billWeeklyLanes ?? [])
  return {
    bars: built.bars.map((b) => ({
      ...b,
      segments: b.segments.map((s) => ({ ...s, color: laneSwatch(s.lane) })),
    })),
    laneIds: built.laneIds,
  }
})
const billWeeklyMax = computed(() => Math.max(1e-9, ...billWeekly.value.bars.map((b) => b.totalUsd)))

// ONE page-level lane legend for the §B bill-lane cards (V1 item 5, r2-3 —
// standalone pages compute it from their own single fetch): the UNION of lanes
// the bill-by-surface bar + the weekly stacked bars actually render, canonical
// order, the folded remainder as its single entry. Cards render no legends.
const billLaneLegend = computed(() =>
  chargebackLegendLanes([billLanes.value.map((l) => l.lane), billWeekly.value.laneIds]),
)

const trendMax = computed(() => Math.max(1, ...(data.value?.trend ?? []).map((w) => w.claudeUsd + w.copilotUsd)))
const modelMax = computed(() => Math.max(1, ...(data.value?.topModels ?? []).map((m) => m.usageUsd)))
const compMax = computed(() => Math.max(1, ...(data.value?.comparison ?? []).map((c) => c.usageUsd)))
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
const signedPct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`)
const fmtWeek = (d: string) => d.slice(5) // MM-DD
</script>

<template>
  <div class="max-w-[1400px] mx-auto px-10 py-8 pb-20">
    <UiBreadcrumb :crumbs="crumbs" class="mb-2" />
    <UiFetchErrorBanner v-if="error" :error="error" class="mb-4" />
    <div v-if="pending" class="p-10 text-center text-carbon-3 text-sm">Loading…</div>

    <template v-else-if="data">
      <UiPageHead
:eyebrow="`Practice · ${data.practice.code}`" :title="data.practice.displayName"
        sub="Reconciled bill alongside the usage signal — estimated/emitted usage, MTD." />

      <!-- Header stat strip -->
      <div class="flex flex-wrap gap-x-10 gap-y-3 mt-4 mb-6">
        <div><div class="text-xl font-bold tabular-nums">{{ fmtUsd(data.header.usageUsd) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Inference cost</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ pct(data.header.pctOfRegion) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Of region usage</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ data.header.users }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Users</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ fmtUsd(data.header.avgPerUser) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Avg / user</div></div>
        <div><div class="text-xl font-bold tabular-nums" :class="(data.header.vsRegionAvgPct ?? 0) < 0 ? 'text-rag-green' : 'text-carbon-1'">{{ signedPct(data.header.vsRegionAvgPct) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Vs region avg</div></div>
      </div>

      <!-- Dual-lane KPI cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <UiKpi label="Users" :value="String(data.header.users)" accent="vision" sub="Copilot + Claude Code" />
        <UiKpi label="Share of current bill" :value="fmtUsd(data.lanes.billUsd)" accent="hunger" sub="reconciled — homed to this practice" />
        <UiKpi
label="Inference cost (usage signal)" :value="fmtUsd(data.lanes.usageSignalUsd)" accent="harmony"
          :sub="`Copilot ${fmtUsd(laneUsageUsd('copilot'))} · Claude Code ${fmtUsd(laneUsageUsd('claude'))}`" />
        <UiKpi label="Tokens (usage)" :value="data.header.tokens >= 1000 ? `${(data.header.tokens / 1000).toFixed(0)}k` : String(data.header.tokens)" accent="zeal" sub="all token types" />
      </div>

      <!-- §B bill-lane cards (#142 + lane-visuals V4). ONE page-level lane legend
           (computed from this page's own fetch, r2-3); the cards render no legends —
           identity = this legend + per-segment tooltips + the MTD card's value rows. -->
      <LaneLegend :lanes="billLaneLegend" class="mb-3" />
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <!-- Reconciled bill by surface (#142) — the per-surface chargeback split. This is the
             BILL lane: non-Code Claude surfaces (chat, Cowork, Office, …) show up here even
             though they never emit usage telemetry. -->
        <UiCard>
          <div class="flex items-baseline justify-between gap-4">
            <div>
              <div class="text-sm font-semibold mb-1">Reconciled bill by surface</div>
              <div class="text-[11px] text-carbon-3">Every Claude surface + Copilot, homed to this practice · reconciled, MTD</div>
            </div>
            <div class="text-sm font-bold tabular-nums">{{ fmtUsd(data.lanes.billUsd) }}</div>
          </div>
          <template v-if="billLanes.length">
            <div class="flex gap-[2px] h-3.5 mt-3 mb-3" role="img" aria-label="Reconciled bill by surface">
              <div
v-for="seg in billLanes" :key="seg.lane"
                class="h-full min-w-[3px] first:rounded-l-full last:rounded-r-full"
                :style="{ width: `${seg.shareOfBill * 100}%`, background: seg.color }"
                :title="`${seg.label} — ${fmtUsd(seg.billUsd)} · ${fmtSharePct(seg.shareOfBill)} of bill${seg.foldedTitle ? ` · ${seg.foldedTitle}` : ''}`" />
            </div>
            <div class="flex flex-wrap gap-x-6 gap-y-1.5">
              <div
v-for="seg in billLanes" :key="seg.lane" class="flex items-center gap-1.5 text-[11px]"
                :title="`${fmtSharePct(seg.shareOfBill)} of bill${seg.foldedTitle ? ` · ${seg.foldedTitle}` : ''}`">
                <span class="inline-block w-2 h-2 rounded-sm shrink-0" :style="{ background: seg.color }" aria-hidden="true" />
                <span class="text-carbon-2">{{ seg.label }}</span>
                <span class="tabular-nums font-medium text-carbon-1">{{ fmtUsd(seg.billUsd) }}</span>
                <span class="text-carbon-3 tabular-nums">{{ fmtSharePct(seg.shareOfBill) }}</span>
              </div>
            </div>
          </template>
          <div v-else class="p-6 text-center text-carbon-3 text-sm">No reconciled bill homed to this practice yet.</div>
        </UiCard>

        <!-- Bill by surface, WEEKLY (lane-visuals V4) — the same §B showback lane as
             the MTD card beside it, per week over 14 weeks, folded stacked bars
             (rank-once fold, ≤ 6 lanes + one "Other surfaces" remainder). Never
             summed with the §A usage-signal trend below. -->
        <UiCard data-testid="practice-bill-weekly">
          <div class="text-sm font-semibold mb-1">Bill by surface · weekly</div>
          <div class="text-[11px] text-carbon-3 mb-3">Reconciled bill per week, by surface · 14-week rolling · billed, not the usage signal</div>
          <div v-if="billWeekly.bars.length" class="flex items-end gap-1 h-[140px]">
            <div
              v-for="b in billWeekly.bars" :key="b.weekStart"
              class="flex-1 flex flex-col justify-end items-center gap-0.5"
              :title="`${b.weekStart}: ${b.segments.map((s) => `${s.label} ${fmtUsd(s.usd)}`).join(' · ') || fmtUsd(0)}`"
            >
              <div class="w-full flex flex-col justify-end" :style="{ height: `${(b.totalUsd / billWeeklyMax) * 110}px` }">
                <div
                  v-for="seg in b.segments" :key="seg.lane"
                  class="w-full first:rounded-t"
                  :style="{ height: `${(seg.usd / Math.max(b.totalUsd, 1e-9)) * 100}%`, background: seg.color }"
                  :title="`${seg.label} — ${fmtUsd(seg.usd)}`"
                />
              </div>
              <div class="text-[8px] text-carbon-3">{{ fmtWeek(b.weekStart) }}</div>
            </div>
          </div>
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No reconciled bill in the last 14 weeks.</div>
        </UiCard>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <!-- Vendor donut -->
        <UiCard>
          <div class="text-sm font-semibold mb-1">Spend by vendor</div>
          <div class="text-[11px] text-carbon-3 mb-3">Usage signal, native cost</div>
          <ChartsDonutChart
v-if="vendorSlices.length" :slices="vendorSlices" aria-label="Spend by vendor"
            :center-label="fmtUsd(data.lanes.usageSignalUsd)" center-sub="usage" />
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No usage yet.</div>
        </UiCard>

        <!-- 14-week trend (vendor-coloured stacked bars) -->
        <UiCard>
          <div class="text-sm font-semibold mb-1">Spend trend</div>
          <!-- §A/§B honesty (V6): this is the ATTRIBUTED-USAGE lane (LaneToggle
               vocabulary), distinct from the billed §B cards above. -->
          <div class="text-[11px] text-carbon-3 mb-3 flex items-center gap-3">
            <span>14-week rolling · attributed usage, not the billed figure</span>
            <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-brand-hunger" aria-hidden="true" />Claude Code</span>
            <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-brand-vision" aria-hidden="true" />Copilot</span>
          </div>
          <div v-if="data.trend.length" class="flex items-end gap-1 h-[140px]">
            <div
v-for="w in data.trend" :key="w.weekStart" class="flex-1 flex flex-col justify-end items-center gap-0.5"
              :title="`${w.weekStart}: Copilot ${fmtUsd(w.copilotUsd)} · Claude Code ${fmtUsd(w.claudeUsd)}`">
              <!-- DATAVIZ-validated provider split (useChartTheme): Claude = hunger, Copilot = vision. -->
              <div class="w-full flex flex-col justify-end" :style="{ height: `${((w.claudeUsd + w.copilotUsd) / trendMax) * 110}px` }">
                <div class="w-full bg-brand-hunger rounded-t" :style="{ height: `${((w.claudeUsd) / Math.max(w.claudeUsd + w.copilotUsd, 0.0001)) * 100}%` }" />
                <div class="w-full bg-brand-vision" :style="{ height: `${((w.copilotUsd) / Math.max(w.claudeUsd + w.copilotUsd, 0.0001)) * 100}%` }" />
              </div>
              <div class="text-[8px] text-carbon-3">{{ fmtWeek(w.weekStart) }}</div>
            </div>
          </div>
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No trend data.</div>
        </UiCard>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <!-- Users -->
        <UiCard flush>
          <div class="px-5 py-3 border-b border-calm-2 text-sm font-semibold">Users in this practice <span class="text-[11px] text-carbon-3 font-normal">· top 25 by spend</span></div>
          <table class="w-full text-sm">
            <tbody>
              <tr v-for="u in data.users" :key="u.teammateId" class="border-b border-calm-1 last:border-0">
                <td class="px-5 py-2.5 font-medium">{{ u.name }}</td>
                <td class="py-2.5 text-[11px] text-carbon-3">{{ u.vendors.join(' · ') || '—' }}</td>
                <td class="py-2.5 text-right tabular-nums">{{ fmtUsd(u.spendUsd) }}</td>
                <td class="px-5 py-2.5 text-right">
                  <span v-if="u.flagged" class="text-[10px] px-1.5 py-0.5 rounded bg-rag-amber/15 text-rag-amber font-semibold">↗ spike</span>
                  <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-rag-green/15 text-rag-green font-semibold">clean</span>
                </td>
              </tr>
              <tr v-if="!data.users.length"><td colspan="4" class="p-8 text-center text-carbon-3 text-sm">No users yet.</td></tr>
            </tbody>
          </table>
        </UiCard>

        <!-- Top models -->
        <UiCard>
          <div class="text-sm font-semibold mb-3">Top models <span class="text-[11px] text-carbon-3 font-normal">· scaled to this practice</span></div>
          <div v-if="data.topModels.length" class="space-y-2">
            <div v-for="m in data.topModels" :key="m.model" class="flex items-center gap-3">
              <div class="w-[140px] text-[12px] truncate text-carbon-2">{{ m.model }}</div>
              <div class="flex-1 h-3 rounded bg-calm-1 overflow-hidden"><div class="h-full bg-brand-harmony" :style="{ width: `${(m.usageUsd / modelMax) * 100}%` }" /></div>
              <div class="w-[64px] text-right text-[12px] tabular-nums">{{ fmtUsd(m.usageUsd) }}</div>
            </div>
          </div>
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No model data.</div>
        </UiCard>
      </div>

      <!-- Comparison -->
      <UiCard>
        <div class="text-sm font-semibold mb-1">How does this compare?</div>
        <div class="text-[11px] text-carbon-3 mb-3 flex items-center gap-3">
          <span>Sibling practices in your scope · attributed usage</span>
          <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-brand-vision" aria-hidden="true" />Copilot</span>
          <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm bg-brand-hunger" aria-hidden="true" />Claude Code</span>
        </div>
        <div class="space-y-2">
          <component
:is="c.isSelf ? 'div' : 'NuxtLink'" v-for="c in data.comparison" :key="c.id" :to="c.isSelf ? undefined : `/practice/${c.id}`"
            class="flex items-center gap-3" :class="c.isSelf ? '' : 'hover:opacity-80'">
            <div class="w-[180px] text-[12px] truncate" :class="c.isSelf ? 'font-semibold text-brand-harmony' : 'text-carbon-2'">{{ c.displayName }}<span v-if="c.isSelf" class="text-[10px] text-carbon-3 ml-1">selected</span></div>
            <!-- Same provider split as the trend: Claude = hunger, Copilot = vision. -->
            <div class="flex-1 h-3.5 rounded bg-calm-1 overflow-hidden flex">
              <div class="h-full bg-brand-vision" :style="{ width: `${(c.copilotUsd / compMax) * 100}%` }" title="Copilot" />
              <div class="h-full bg-brand-hunger" :style="{ width: `${(c.claudeUsd / compMax) * 100}%` }" title="Claude Code" />
            </div>
            <div class="w-[72px] text-right text-[12px] tabular-nums">{{ fmtUsd(c.usageUsd) }}</div>
          </component>
        </div>
      </UiCard>
    </template>
  </div>
</template>
