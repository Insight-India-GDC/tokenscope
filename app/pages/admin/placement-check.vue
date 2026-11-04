<script setup lang="ts">
/*
 * Admin → Placement check (docs/design/placement-check/00-spec.md P6).
 * Platform admin only, like its API. Compares each teammate's current region
 * and Business Unit with what the directory derives NOW from stored evidence,
 * and applies the selected moves.
 *
 * Verdicts are computed by the server at read time against the live rules,
 * owners and leaders; this page only filters, explains and submits them.
 */
import { computed, ref, watch } from 'vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { apiErrorDetail } from '../../composables/useApiError'
import { usePlacementRead } from '../../composables/usePlacementRead'
import { fmtTimeAgo, fmtUsd } from '../../composables/useFormat'
import AdminDataTable, { type AdminColumn } from '../../components/admin/AdminDataTable.vue'
import PlacementWhy from '../../components/admin/PlacementWhy.vue'
import PlacementApplyDialog from '../../components/admin/PlacementApplyDialog.vue'
import {
  PLACEMENT_VERDICTS,
  type PlacementCheckResponse,
  type PlacementCheckRow,
  type PlacementVerdict,
} from '#shared/placement/placement-check'
import { BU_LABEL } from '#shared/reports/vocabulary'
import {
  PLACEMENT_VERDICT_TEXT,
  bulkSelectablePlacementIds,
  filterPlacementRows,
  placementFiltersFromQuery,
  groupNeedsOwnerByManager,
  isPlacementApplicable,
  placementAmbiguousWarning,
  placementHomeText,
  placementProvenanceText,
  placementRegionOptions,
  placementUnitOptions,
  unknownHomeFilters,
  type HomeFilterKey,
  type PlacementFilters,
} from '../../utils/placement-check-view'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isPlatform } = useAdminAccess()

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const { data, error: fetchError, refresh } = useLazyFetch<PlacementCheckResponse | null>(
  '/api/v1/admin/placement-check',
  { server: false, default: () => null, immediate: isPlatform.value },
)
const rows = computed<PlacementCheckRow[]>(() => data.value?.rows ?? [])

// ── Check controls ──────────────────────────────────────────────────────────
const starting = ref(false)
const startError = ref<string | null>(null)
const read = usePlacementRead({ refresh, remaining: () => data.value?.remaining ?? 0 })
const { stopRequested, runStartRemaining, retryResult, runPass } = read
const busy = computed<'start' | 'pass' | 'retry' | null>(() => (starting.value ? 'start' : read.busy.value))
const actionError = computed(() => startError.value ?? read.error.value)

async function startCheck() {
  starting.value = true
  startError.value = null
  read.error.value = null
  runStartRemaining.value = null
  try {
    await $fetch('/api/v1/admin/placement-check/cycle', { method: 'POST' })
    await refresh()
  } catch (e: unknown) {
    startError.value = apiErrorDetail(e, 'Could not start a check.')
  } finally {
    starting.value = false
  }
}

const remaining = computed(() => data.value?.remaining ?? 0)
const failedThisCycle = computed(() => data.value?.failedThisCycle ?? 0)
const readNext = computed(() => data.value?.cycle != null && remaining.value > 0)

// ── Summary ─────────────────────────────────────────────────────────────────
const summary = computed(() => {
  const byVerdict = new Map((data.value?.summary ?? []).map((s) => [s.verdict, s]))
  return PLACEMENT_VERDICTS.map((v) => ({ verdict: v, count: byVerdict.get(v)?.count ?? 0, spend30d: byVerdict.get(v)?.spend30d ?? 0 })).filter(
    (s) => s.count > 0,
  )
})

// ── Filters + table ─────────────────────────────────────────────────────────
// A link from Org setup ("See who", "Review one by one") arrives filtered to its
// group. A region or unit id no row has stays applied (an empty table, named as
// such in its select), never dropped: dropping it would show other groups' people.
const filters = ref<PlacementFilters>(placementFiltersFromQuery(useRoute().query))
const unknownFilters = computed<HomeFilterKey[]>(() => (rows.value.length ? unknownHomeFilters(filters.value, rows.value) : []))
const isUnknown = (k: HomeFilterKey) => unknownFilters.value.includes(k)
const UNKNOWN_FILTER_TEXT: Record<HomeFilterKey, string> = {
  currentRegion: 'No region matches this filter',
  derivedRegion: 'No region matches this filter',
  currentUnit: `No ${BU_LABEL} matches this filter`,
  derivedUnit: `No ${BU_LABEL} matches this filter`,
}
const emptySub = computed(() => {
  if (!rows.value.length) return data.value?.cycle ? 'Nobody read yet. Press Read directory.' : 'No evidence yet. Start a check.'
  if (unknownFilters.value.length) return `Nobody has the ${unknownFilters.value.some((k) => k.endsWith('Unit')) ? BU_LABEL : 'region'} this link names. Pick Any to widen the view.`
  return 'No teammate matches these filters.'
})
const view = ref<'people' | 'managers'>('people')
function showVerdict(v: PlacementVerdict) {
  view.value = 'people'
  filters.value = { ...filters.value, verdict: v }
}
const shown = computed(() => filterPlacementRows(rows.value, filters.value))
const currentRegions = computed(() => placementRegionOptions(rows.value, 'current'))
const derivedRegions = computed(() => placementRegionOptions(rows.value, 'derived'))
const currentUnits = computed(() => placementUnitOptions(rows.value, 'current'))
const derivedUnits = computed(() => placementUnitOptions(rows.value, 'derived'))

// Selection is scoped to what is on screen; a filter change drops it.
const selected = ref<string[]>([])
watch(filters, () => (selected.value = []), { deep: true })
const selectedSet = computed(() => new Set(selected.value))
function toggle(id: string) {
  selected.value = selectedSet.value.has(id) ? selected.value.filter((k) => k !== id) : [...selected.value, id]
}
const bulkIds = computed(() => bulkSelectablePlacementIds(shown.value))
function selectAllMovable() {
  selected.value = [...new Set([...selected.value, ...bulkIds.value])]
}

const expanded = ref<Set<string>>(new Set())
function toggleWhy(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const columns: AdminColumn[] = [
  { key: 'select', label: '' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'move', label: 'Current → derived' },
  { key: 'verdict', label: 'Verdict' },
  { key: 'provenance', label: 'Placed by' },
  { key: 'spend', label: 'Spend 30d' },
  { key: 'why', label: '' },
]
const asRow = (r: Record<string, unknown>) => r as unknown as PlacementCheckRow
const tableRows = computed(() => shown.value as unknown as Record<string, unknown>[])

// ── Group by manager (needs-owner) ──────────────────────────────────────────
const managerGroups = computed(() => groupNeedsOwnerByManager(rows.value))
const needsOwnerCount = computed(() => managerGroups.value.reduce((n, g) => n + g.count, 0))

// ── Apply ───────────────────────────────────────────────────────────────────
// Snapshot at open: the refetch after apply must not change what the dialog reports on.
const applyRows = ref<PlacementCheckRow[]>([])
const applyOpen = ref(false)
function openApply() {
  const ids = selectedSet.value
  applyRows.value = rows.value.filter((r) => ids.has(r.teammateId) && isPlacementApplicable(r))
  applyOpen.value = true
}
async function onApplied() {
  selected.value = []
  runStartRemaining.value = null
  await refresh()
}
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-placement-check" data-admin-page="/admin/placement-check">
    <UiPageHead
      eyebrow="Organisation"
      title="Placement check"
      :sub="`Compare each teammate's region and ${BU_LABEL} with what the directory derives now.`"
    />
    <p v-if="!isPlatform" class="text-sm text-carbon-2">Only an Admin can run the placement check.</p>
    <template v-else>
      <UiFetchErrorBanner v-if="fetchError" :error="fetchError" label="the placement check" @retry="refresh" />
      <AdminPageSkeleton v-else-if="data == null" :tiles="4" :rows="8" />
      <template v-else>
        <UiCard class="mb-6" data-testid="placement-check-controls">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="text-sm text-carbon-2 space-y-1">
              <p v-if="!data.cycle" data-testid="placement-check-no-cycle">No check has run yet. Start one to read everyone's directory record and manager chain.</p>
              <template v-else>
                <p data-testid="placement-check-evidence-age">
                  Check started {{ fmtTimeAgo(data.cycle.startedAt) }}.
                  <template v-if="data.evidenceAge.oldest && data.evidenceAge.newest">
                    Directory read between {{ fmtTimeAgo(data.evidenceAge.oldest) }} and {{ fmtTimeAgo(data.evidenceAge.newest) }}.
                  </template>
                </p>
                <p v-if="remaining > 0" data-testid="placement-check-remaining">
                  {{ remaining }} {{ remaining === 1 ? 'teammate' : 'teammates' }} not yet read in this check. Their rows show older evidence, or none.
                  <template v-if="busy === null">Press Read directory to read them.</template>
                </p>
              </template>
              <p v-if="retryResult" class="text-[12px] text-carbon-3" data-testid="placement-check-retry-result">
                Retried {{ retryResult.checked }}: {{ retryResult.checked - retryResult.errors }} read, {{ retryResult.errors }} still failing.
              </p>
              <p v-if="runStartRemaining != null" class="text-[12px] text-carbon-3" data-testid="placement-check-last-pass">
                {{ busy === 'pass' ? 'Reading:' : 'Read' }} {{ Math.max(0, runStartRemaining - remaining) }} so far, {{ remaining }} remaining.
                <template v-if="failedThisCycle > 0">{{ failedThisCycle }} lookups failed in this check.</template>
              </p>
              <p v-if="actionError" class="text-xs text-rag-red" role="alert" data-testid="placement-check-action-error">{{ actionError }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UiButton
                :kind="readNext ? 'secondary' : 'primary'"
                size="sm"
                :disabled="busy !== null"
                data-testid="placement-check-start"
                @click="startCheck"
              >
                {{ busy === 'start' ? 'Starting…' : 'Start check' }}
              </UiButton>
              <UiButton
                v-if="readNext"
                kind="primary"
                size="sm"
                :disabled="busy !== null"
                data-testid="placement-check-pass"
                @click="runPass(false)"
              >
                {{ busy === 'pass' ? 'Reading…' : `Read directory (${remaining} left)` }}
              </UiButton>
              <UiButton
                v-if="busy === 'pass'"
                size="sm"
                :disabled="stopRequested"
                data-testid="placement-check-stop"
                @click="stopRequested = true"
              >
                {{ stopRequested ? 'Stopping after this pass…' : 'Stop' }}
              </UiButton>
              <UiButton
                v-if="data.cycle && failedThisCycle > 0"
                size="sm"
                :disabled="busy !== null"
                data-testid="placement-check-retry"
                @click="runPass(true)"
              >
                {{ busy === 'retry' ? 'Retrying…' : 'Retry failed' }}
              </UiButton>
            </div>
          </div>
        </UiCard>

        <div v-if="summary.length" class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-6" data-testid="placement-check-summary">
          <button
            v-for="s in summary"
            :key="s.verdict"
            type="button"
            class="text-left p-3 rounded-lg border border-calm-2 hover:border-brand-harmony bg-white"
            :class="filters.verdict === s.verdict ? 'border-brand-harmony' : ''"
            :title="PLACEMENT_VERDICT_TEXT[s.verdict].hint"
            :data-testid="`placement-summary-${s.verdict}`"
            @click="showVerdict(s.verdict)"
          >
            <UiBadge :kind="PLACEMENT_VERDICT_TEXT[s.verdict].badge">{{ PLACEMENT_VERDICT_TEXT[s.verdict].label }}</UiBadge>
            <div class="text-xl font-bold text-carbon mt-1.5 tabular-nums">{{ s.count }}</div>
            <div class="text-[11px] text-carbon-3 tabular-nums">{{ fmtUsd(s.spend30d) }} in 30 days</div>
          </button>
        </div>

        <div v-if="needsOwnerCount" class="flex gap-2 mb-3" role="tablist">
          <UiButton :kind="view === 'people' ? 'primary' : 'ghost'" size="sm" role="tab" :aria-selected="view === 'people'" data-testid="placement-view-people" @click="view = 'people'">
            People
          </UiButton>
          <UiButton :kind="view === 'managers' ? 'primary' : 'ghost'" size="sm" role="tab" :aria-selected="view === 'managers'" data-testid="placement-view-managers" @click="view = 'managers'">
            Needs an owner, by manager
          </UiButton>
        </div>

        <UiCard v-if="view === 'managers'" data-testid="placement-check-managers">
          <p class="text-sm text-carbon-2 mb-3">
            {{ needsOwnerCount }} {{ needsOwnerCount === 1 ? 'person reaches' : 'people reach' }} the top of the reporting line with no {{ BU_LABEL }} owner above them.
            A manager who owns exactly one {{ BU_LABEL }} places the people below them who have no closer owner.
            Owners are set on each region's page.
          </p>
          <ul class="divide-y divide-calm-2 border border-calm-2 rounded-md">
            <li v-for="g in managerGroups" :key="g.oid ?? 'none'" class="px-4 py-2.5" :data-testid="`placement-manager-${g.oid ?? 'none'}`">
              <details>
                <summary class="cursor-pointer flex flex-wrap items-baseline gap-x-3">
                  <span class="font-semibold text-carbon">{{ g.name }}</span>
                  <span class="text-sm text-carbon-2 tabular-nums">{{ g.count }} {{ g.count === 1 ? 'person' : 'people' }}</span>
                  <span class="text-[11px] text-carbon-3 tabular-nums">{{ fmtUsd(g.spend30d) }} in 30 days</span>
                  <span v-if="g.above" class="text-[11px] text-carbon-3">reports to {{ g.above }}</span>
                </summary>
                <ul class="mt-2 pl-4 text-[12px] text-carbon-2 space-y-0.5">
                  <li v-for="p in g.people" :key="p.teammateId">{{ p.name ?? p.email }} · {{ placementHomeText(p.current) }}</li>
                </ul>
              </details>
            </li>
          </ul>
        </UiCard>

        <AdminDataTable
          v-else
          :rows="tableRows"
          :columns="columns"
          empty-headline="Nothing to show"
          :empty-sub="emptySub"
          data-testid="placement-check-table"
        >
          <template #toolbar>
            <label class="text-[12px] font-semibold text-carbon">
              Verdict
              <select v-model="filters.verdict" class="ml-1 px-2 py-1.5 text-sm border border-calm-2 rounded-md bg-white" data-testid="placement-filter-verdict">
                <option value="not-ok">Everything not matching</option>
                <option value="all">All</option>
                <option v-for="v in PLACEMENT_VERDICTS" :key="v" :value="v">{{ PLACEMENT_VERDICT_TEXT[v].label }}</option>
              </select>
            </label>
            <label class="text-[12px] font-semibold text-carbon">
              Current region
              <select v-model="filters.currentRegion" class="ml-1 px-2 py-1.5 text-sm border border-calm-2 rounded-md bg-white" data-testid="placement-filter-current-region">
                <option value="">Any</option>
                <option v-if="isUnknown('currentRegion')" :value="filters.currentRegion" disabled>{{ UNKNOWN_FILTER_TEXT.currentRegion }}</option>
                <option v-for="r in currentRegions" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
            <label class="text-[12px] font-semibold text-carbon">
              Derived region
              <select v-model="filters.derivedRegion" class="ml-1 px-2 py-1.5 text-sm border border-calm-2 rounded-md bg-white" data-testid="placement-filter-derived-region">
                <option value="">Any</option>
                <option v-if="isUnknown('derivedRegion')" :value="filters.derivedRegion" disabled>{{ UNKNOWN_FILTER_TEXT.derivedRegion }}</option>
                <option v-for="r in derivedRegions" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
            <label class="text-[12px] font-semibold text-carbon">
              Current {{ BU_LABEL }}
              <select v-model="filters.currentUnit" class="ml-1 px-2 py-1.5 text-sm border border-calm-2 rounded-md bg-white" data-testid="placement-filter-current-unit">
                <option value="">Any</option>
                <option v-if="isUnknown('currentUnit')" :value="filters.currentUnit" disabled>{{ UNKNOWN_FILTER_TEXT.currentUnit }}</option>
                <option v-for="u in currentUnits" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
            <label class="text-[12px] font-semibold text-carbon">
              Derived {{ BU_LABEL }}
              <select v-model="filters.derivedUnit" class="ml-1 px-2 py-1.5 text-sm border border-calm-2 rounded-md bg-white" data-testid="placement-filter-derived-unit">
                <option value="">Any</option>
                <option v-if="isUnknown('derivedUnit')" :value="filters.derivedUnit" disabled>{{ UNKNOWN_FILTER_TEXT.derivedUnit }}</option>
                <option v-for="u in derivedUnits" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
            <span class="flex-1" />
            <UiButton size="sm" :disabled="!bulkIds.length" data-testid="placement-select-all" @click="selectAllMovable">
              Select all movable ({{ bulkIds.length }})
            </UiButton>
            <UiButton kind="primary" size="sm" :disabled="!selected.length" data-testid="placement-apply-open" @click="openApply">
              Apply {{ selected.length }}
            </UiButton>
          </template>
          <template #row="{ row: raw }">
            <tr class="hover:bg-brand-harmony-sheer/30" :data-testid="`placement-row-${asRow(raw).teammateId}`">
              <td class="px-5 py-3 w-10">
                <input
                  v-if="isPlacementApplicable(asRow(raw))"
                  type="checkbox"
                  class="w-4 h-4 accent-brand-harmony align-middle"
                  :checked="selectedSet.has(asRow(raw).teammateId)"
                  :aria-label="`Select ${asRow(raw).name ?? asRow(raw).email}`"
                  :data-testid="`placement-select-${asRow(raw).teammateId}`"
                  @change="toggle(asRow(raw).teammateId)"
                >
              </td>
              <td class="px-5 py-3 text-sm text-carbon">{{ asRow(raw).name ?? '—' }}</td>
              <td class="px-5 py-3 text-sm text-carbon-2">{{ asRow(raw).email }}</td>
              <td class="px-5 py-3 text-sm text-carbon">
                {{ placementHomeText(asRow(raw).current) }}
                <span class="text-carbon-3">→</span>
                {{ placementHomeText(asRow(raw).derived) }}
              </td>
              <td class="px-5 py-3">
                <UiBadge :kind="PLACEMENT_VERDICT_TEXT[asRow(raw).verdict].badge" :title="PLACEMENT_VERDICT_TEXT[asRow(raw).verdict].hint">
                  {{ PLACEMENT_VERDICT_TEXT[asRow(raw).verdict].label }}
                </UiBadge>
                <span
                  v-if="placementAmbiguousWarning(asRow(raw))"
                  class="block mt-1 text-[11px] text-carbon-2"
                  :data-testid="`placement-ambiguous-warning-${asRow(raw).teammateId}`"
                >{{ placementAmbiguousWarning(asRow(raw)) }}</span>
              </td>
              <td class="px-5 py-3 text-sm text-carbon-2">{{ placementProvenanceText(asRow(raw)) }}</td>
              <td class="px-5 py-3 text-sm text-carbon text-right tabular-nums">{{ fmtUsd(asRow(raw).spend30d) }}</td>
              <td class="px-5 py-3 text-right">
                <button
                  type="button"
                  class="text-xs font-semibold text-brand-harmony hover:underline"
                  :aria-expanded="expanded.has(asRow(raw).teammateId)"
                  :data-testid="`placement-why-toggle-${asRow(raw).teammateId}`"
                  @click="toggleWhy(asRow(raw).teammateId)"
                >
                  Why
                </button>
              </td>
            </tr>
            <tr v-if="expanded.has(asRow(raw).teammateId)" class="bg-calm/20">
              <td />
              <td :colspan="columns.length - 1" class="px-5 py-3">
                <PlacementWhy :row="asRow(raw)" />
              </td>
            </tr>
          </template>
        </AdminDataTable>
      </template>
    </template>

    <PlacementApplyDialog :open="applyOpen" :rows="applyRows" @close="applyOpen = false" @applied="onApplied" />
  </div>
</template>
