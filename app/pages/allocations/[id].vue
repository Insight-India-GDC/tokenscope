<script setup lang="ts">
/*
 * Allocation editor (design-notes §Screen 4 / mvp-final-epic.md §Epic 12).
 *
 * Two-column layout: left form (mode toggle → budget+effective →
 * assigned devs → top-ups) + right context (consumption / project
 * metadata / audit trail).
 *
 * Row-vs-collection semantics: this page operates on ONE allocation
 * row (the focused baseline). Top-ups APPEND new rows via POST
 * /topups; they do NOT edit the focused baseline. The
 * ConsumptionCard sums all rows for the project (baseline + top-ups)
 * to render aggregate consumption.
 */
import { computed, ref, watch } from 'vue'
import AllocatorModeToggle, { type AllocatorMode } from '../../components/allocator/AllocatorModeToggle.vue'
import DevChipPicker, { type AssignedDev } from '../../components/allocator/DevChipPicker.vue'
import TopupLog, { type TopupRow } from '../../components/allocator/TopupLog.vue'
import ConsumptionCard from '../../components/allocator/ConsumptionCard.vue'
import type { Crumb } from '../../components/ui/Breadcrumb.vue'

interface FocusedAlloc {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  // Normalised ISO-8601 bounds (FE-1) — null for unbounded range ends. The
  // raw `effective` tstzrange text stays for display-agnostic consumers.
  effective_from?: string | null
  effective_to?: string | null
  allocation_kind: string
  allocation_mode: 'shared_pool' | 'per_dev_fixed'
  source: string
  is_pinned: boolean
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  region_code: string | null
  cou_code: string | null
  cou_display_name: string | null
}

interface PerDevCap {
  allocation_id: string
  teammate_id: string
  email: string
  display_name: string | null
  budget_usd: string
}

interface AllocDetail {
  focused: FocusedAlloc
  siblings: Array<{ id: string; budget_usd: string; effective: string; allocation_kind: string }>
  devs: AssignedDev[]
  topups: TopupRow[]
  per_dev_caps: PerDevCap[]
  audit: Array<{
    id: string
    event_type: string
    ts_recorded: string
    actor_display_name: string | null
    payload: Record<string, unknown> | null
  }>
}

// Map between the AllocatorMode hyphen vocabulary (UI) and the
// underscore server values.
function serverToUiMode(m: 'shared_pool' | 'per_dev_fixed'): AllocatorMode {
  return m === 'per_dev_fixed' ? 'per-dev-fixed' : 'shared-pool'
}
function uiToServerMode(m: AllocatorMode): 'shared_pool' | 'per_dev_fixed' {
  return m === 'per-dev-fixed' ? 'per_dev_fixed' : 'shared_pool'
}

const route = useRoute()
const id = computed(() => String(route.params.id))
// Interpolated into request URLs below, and Vue Router has already decoded it:
// a crafted `..%2F` link must not re-route a PATCH to another resource.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.value)) {
  throw createError({ statusCode: 404, statusMessage: 'Allocation not found', fatal: true })
}

const { data, refresh, pending } = await useFetch<AllocDetail>(
  () => `/api/v1/allocations/${encodeURIComponent(id.value)}`,
  { default: () => null as unknown as AllocDetail },
)

// Form state — initialised from the loaded focused row.
const mode = ref<AllocatorMode>('shared-pool')
const budgetUsd = ref('')
const fromIso = ref('')
const toIso = ref('')

// Server-normalised ISO bound → date-input value (YYYY-MM-DD). Defensive
// (FE-1): absent/null bound (unbounded range) or an unparseable value leaves
// the input blank instead of throwing RangeError inside the watcher.
function isoToDateInput(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

watch(
  () => data.value?.focused,
  (focused) => {
    if (!focused) return
    budgetUsd.value = Number(focused.budget_usd).toFixed(2)
    mode.value = serverToUiMode(focused.allocation_mode)
    fromIso.value = isoToDateInput(focused.effective_from)
    toIso.value = isoToDateInput(focused.effective_to)
  },
  { immediate: true },
)

const consumptionTotalUsd = computed(() => {
  // baseline + top-ups + bursts that overlap the focused row's
  // effective range. For Epic 12 we sum the focused row + siblings
  // and trust the editor user has the right window.
  if (!data.value?.focused) return 0
  let total = Number(data.value.focused.budget_usd)
  for (const s of data.value.siblings) {
    if (s.allocation_kind !== 'burst') total += Number(s.budget_usd)
  }
  return total
})

// Pull project-scoped consumption (works for managers viewing
// projects they aren't personally assigned to). Lazy-loaded only when
// the focused row has a project_id.
const projectIdForConsumption = computed(() => data.value?.focused?.project_id ?? null)
// ONE LANE: this endpoint now returns the SAME figure the project page shows
// (server/usage/complete-spend.ts). It used to be its own SUM over the raw
// ledger, so "Manage budget →" walked a PM from one number to a different one
// at the exact moment they decided whether to extend.
const { data: consumption } = await useFetch<{
  total_cost_usd: string
  reconciled_cost_usd: string
}>(
  () =>
    projectIdForConsumption.value
      ? `/api/v1/projects/${projectIdForConsumption.value}/consumption`
      : '',
  {
    default: () => ({ total_cost_usd: '0.00', reconciled_cost_usd: '0.00' }),
    immediate: !!projectIdForConsumption.value,
  },
)
const consumptionUsedUsd = computed(() => Number(consumption.value?.total_cost_usd ?? 0))
const consumptionReconciledUsd = computed(() =>
  Number(consumption.value?.reconciled_cost_usd ?? 0),
)

const crumbs = computed<Crumb[]>(() => {
  const focused = data.value?.focused
  const list: Crumb[] = [
    { label: 'Reporting', to: '/reporting?scope=region' },
    { label: 'Allocations', to: '/allocations' },
  ]
  if (focused?.project_display_name) {
    list.push({ label: focused.project_display_name })
  }
  return list
})

const savedFlash = ref(false)
const saveError = ref<string | null>(null)
const saving = ref(false)

const canSave = computed(() => {
  if (saving.value) return false
  if (!/^\d+(\.\d{1,2})?$/.test(budgetUsd.value)) return false
  if (Number(budgetUsd.value) <= 0) return false
  if (!fromIso.value || !toIso.value) return false
  return fromIso.value < toIso.value
})

async function save() {
  if (!data.value?.focused) return
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/v1/allocations/${encodeURIComponent(id.value)}`, {
      method: 'PATCH',
      body: {
        budget_usd: budgetUsd.value,
        // Pad the date to a full timestamp tstzrange — UTC midnight.
        effective: `[${fromIso.value}T00:00:00Z,${toIso.value}T00:00:00Z)`,
      },
    })
    await refresh()
    savedFlash.value = true
    setTimeout(() => {
      savedFlash.value = false
    }, 2200)
  } catch (err) {
    saveError.value = apiErrorDetail(err, 'Save failed.')
  } finally {
    saving.value = false
  }
}

/*
 * Top-up submit (FE-6): the parent owns the POST outcome. TopupLog keeps the
 * user's input until `submitting` flips back to false with no `submitError` —
 * a rejected POST (overlap 409, 403) no longer silently discards the
 * amount/dates/reason.
 */
const topupSubmitting = ref(false)
const topupError = ref<string | null>(null)

async function addTopup(payload: {
  budget_usd: string
  effective_from: string
  effective_to: string
  reason: string
}) {
  topupSubmitting.value = true
  topupError.value = null
  try {
    await $fetch(`/api/v1/allocations/${encodeURIComponent(id.value)}/topups`, {
      method: 'POST',
      body: {
        budget_usd: payload.budget_usd,
        effective: `[${payload.effective_from}T00:00:00Z,${payload.effective_to}T00:00:00Z)`,
        reason: payload.reason || undefined,
      },
    })
    await refresh()
  } catch (err) {
    topupError.value = apiErrorDetail(err, 'Top-up failed.')
  } finally {
    topupSubmitting.value = false
  }
}

/* ── Member management ────────────────────────────────────────────── */

/*
 * Existing teammates, from the scoped picker any signed-in user may call (spec
 * A13), so a developer-role PM can add members here too. Cross-region is fine:
 * project membership may span regions. Adding someone not yet in TokenScope is
 * an admin's directory pick (A2).
 */
interface TeammateResult {
  id: string
  email: string
  display_name: string | null
}

const addSearch = ref('')
const addResults = ref<TeammateResult[]>([])
const addError = ref<string | null>(null)

// FE-7: ~250 ms debounce + sequence-token stale guard — out-of-order
// responses for an earlier term can no longer overwrite the current results.
const teammateSearch = useDebouncedSearch<TeammateResult[]>({
  search: async (term) => {
    const res = await $fetch<{ teammates: TeammateResult[] }>('/api/v1/pickers/teammates', {
      query: { q: term },
    })
    return res.teammates.slice(0, 8)
  },
  apply: (results) => {
    addResults.value = results
  },
  onError: (err) => {
    addError.value = apiErrorDetail(err, 'Teammate search failed.')
  },
})

function onAddSearch() {
  addError.value = null
  const term = addSearch.value.trim()
  // GET /pickers/teammates refuses q shorter than 2 characters.
  if (term.length < 2) {
    teammateSearch.cancel()
    addResults.value = []
    return
  }
  teammateSearch.run(term)
}

async function addMember(teammateId: string) {
  const projectId = data.value?.focused?.project_id
  if (!projectId) return
  addError.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${projectId}/assignments`, {
      method: 'POST',
      body: { teammate_id: teammateId },
    })
    addSearch.value = ''
    teammateSearch.cancel()
    addResults.value = []
    await refresh()
  } catch (err) {
    addError.value = apiErrorDetail(err, 'Could not add the developer.')
  }
}

async function removeMember(teammateId: string) {
  const projectId = data.value?.focused?.project_id
  if (!projectId) return
  addError.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${projectId}/assignments/${teammateId}`, {
      method: 'DELETE',
    })
    await refresh()
  } catch (err) {
    addError.value = apiErrorDetail(err, 'Could not remove the developer.')
  }
}

/* ── Per-developer split ──────────────────────────────────────────── */

// teammate_id → cap input string. Re-seeded from per_dev_caps whenever
// the loaded data changes (matches the budget-input init pattern).
const capInputs = ref<Record<string, string>>({})

watch(
  () => data.value,
  (next) => {
    if (!next) return
    const caps: Record<string, string> = {}
    for (const dev of next.devs) {
      const existing = next.per_dev_caps.find((c) => c.teammate_id === dev.teammate_id)
      caps[dev.teammate_id] = existing ? Number(existing.budget_usd).toFixed(2) : ''
    }
    capInputs.value = caps
  },
  { immediate: true },
)

function splitEvenly() {
  const devs = data.value?.devs ?? []
  if (devs.length === 0) return
  const each = (Number(budgetUsd.value || 0) / devs.length).toFixed(2)
  const next: Record<string, string> = {}
  for (const dev of devs) next[dev.teammate_id] = each
  capInputs.value = next
}

const splitSaved = ref(false)
const splitError = ref<string | null>(null)
const splitting = ref(false)

async function saveSplit() {
  splitting.value = true
  splitError.value = null
  try {
    const serverMode = uiToServerMode(mode.value)
    const body =
      serverMode === 'per_dev_fixed'
        ? {
            mode: 'per_dev_fixed' as const,
            caps: (data.value?.devs ?? []).map((d) => ({
              teammate_id: d.teammate_id,
              budget_usd: Number(capInputs.value[d.teammate_id] || 0).toFixed(2),
            })),
          }
        : { mode: 'shared_pool' as const }
    await $fetch(`/api/v1/allocations/${encodeURIComponent(id.value)}/split`, {
      method: 'POST',
      body,
    })
    await refresh()
    splitSaved.value = true
    setTimeout(() => {
      splitSaved.value = false
    }, 2200)
  } catch (err) {
    splitError.value = apiErrorDetail(err, 'Split save failed.')
  } finally {
    splitting.value = false
  }
}

function humaniseEventType(eventType: string): string {
  switch (eventType) {
    case 'allocation-created':
      return 'Allocation created'
    case 'allocation-updated':
      return 'Budget updated'
    case 'allocation-topup-added':
      return 'Top-up added'
    default:
      return eventType
  }
}
</script>

<template>
  <div v-if="!pending && data" class="max-w-[1440px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Allocation editor"
      :title="data.focused.project_display_name ?? data.focused.project_code ?? 'Allocation'"
      :sub="`${data.focused.region_code ?? '—'} · ${data.focused.cou_display_name ?? data.focused.cou_code ?? '—'}`"
    >
      <template #actions>
        <UiBadge kind="rag-green">Onboarded</UiBadge>
        <NuxtLink to="/allocations">
          <UiButton kind="secondary" size="sm">Cancel</UiButton>
        </NuxtLink>
        <UiButton
          kind="primary"
          size="sm"
          :disabled="!canSave"
          :title="!canSave && !saving ? 'Fix the form first — budget must be positive and From must precede To.' : undefined"
          data-testid="alloc-save"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save changes' }}
        </UiButton>
      </template>
    </UiPageHead>
    <UiBreadcrumb :crumbs="crumbs" class="-mt-6 mb-6" />

    <div
      v-if="savedFlash"
      class="mb-5 px-4 py-3 rounded-md bg-rag-green/10 border border-rag-green/30 text-sm text-[#166534]"
      data-testid="save-flash"
    >
      ✓ Saved · audit logged
    </div>
    <div
      v-if="saveError"
      class="mb-5 px-4 py-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-sm text-brand-heart"
      data-testid="save-error"
    >
      Save failed — {{ saveError }}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
      <!-- LEFT: form column -->
      <div class="space-y-5">
        <UiCard>
          <div class="text-sm font-bold text-carbon mb-3">Allocation mode</div>
          <AllocatorModeToggle v-model="mode" />
        </UiCard>

        <UiCard>
          <div class="text-sm font-bold text-carbon mb-3">Budget and effective period</div>
          <div class="grid grid-cols-3 gap-4">
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">
                Total project budget (USD)
              </span>
              <input
                v-model="budgetUsd"
                type="text"
                inputmode="decimal"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="alloc-budget"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">From</span>
              <input
                v-model="fromIso"
                type="date"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="alloc-from"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">To</span>
              <input
                v-model="toIso"
                type="date"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="alloc-to"
              >
            </label>
          </div>
        </UiCard>

        <UiCard>
          <div class="text-sm font-bold text-carbon mb-3">Members</div>
          <DevChipPicker :devs="data.devs" @remove="removeMember" />

          <div class="mt-4 pt-4 border-t border-calm-2">
            <div class="text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-2">
              Add a developer
            </div>
            <input
              v-model="addSearch"
              type="text"
              placeholder="Search teammates by name or email…"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
              data-testid="dev-add-search"
              @input="onAddSearch"
            >
            <div
              v-if="addError"
              class="mt-2 px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart"
              data-testid="dev-add-error"
            >
              {{ addError }}
            </div>
            <ul v-if="addResults.length" class="mt-2 space-y-1">
              <li
                v-for="t in addResults"
                :key="t.id"
                class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-calm-2 hover:bg-brand-harmony-sheer/40"
              >
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-carbon truncate">
                    {{ t.display_name ?? t.email.split('@')[0] }}
                  </div>
                  <div class="text-[11px] text-carbon-3 truncate">{{ t.email }}</div>
                </div>
                <UiButton
                  kind="secondary"
                  size="sm"
                  :data-testid="`dev-add-${t.id}`"
                  @click="addMember(t.id)"
                >
                  + Add
                </UiButton>
              </li>
            </ul>
          </div>
        </UiCard>

        <UiCard v-if="mode === 'per-dev-fixed'" data-testid="per-dev-split-card">
          <div class="flex items-center justify-between mb-3">
            <div class="text-sm font-bold text-carbon">Per-developer budgets</div>
            <UiButton kind="ghost" size="sm" data-testid="split-evenly" @click="splitEvenly">
              Split evenly
            </UiButton>
          </div>
          <div
            v-if="splitSaved"
            class="mb-3 px-3 py-2 rounded-md bg-rag-green/10 border border-rag-green/30 text-xs text-[#166534]"
            data-testid="split-saved"
          >
            ✓ Split saved
          </div>
          <div
            v-if="splitError"
            class="mb-3 px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart"
            data-testid="split-error"
          >
            {{ splitError }}
          </div>
          <div v-if="data.devs.length === 0" class="text-xs text-carbon-3 italic">
            No developers assigned yet — add some above to set per-developer caps.
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="d in data.devs"
              :key="d.teammate_id"
              class="grid grid-cols-[1fr_140px] items-center gap-3"
            >
              <span class="text-sm text-carbon">{{ d.display_name ?? d.email }}</span>
              <input
                v-model="capInputs[d.teammate_id]"
                type="number"
                step="0.01"
                min="0"
                inputmode="decimal"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono text-right focus:border-brand-harmony"
                :data-testid="`cap-${d.teammate_id}`"
              >
            </div>
          </div>
          <div class="mt-4 flex justify-end">
            <UiButton
              kind="primary"
              size="sm"
              :disabled="splitting"
              data-testid="save-split"
              @click="saveSplit"
            >
              {{ splitting ? 'Saving…' : 'Save split' }}
            </UiButton>
          </div>
        </UiCard>

        <UiCard v-else data-testid="shared-pool-split-card">
          <div class="text-sm font-bold text-carbon mb-2">Shared pool</div>
          <p class="text-xs text-carbon-2 leading-relaxed mb-3">
            All assigned developers draw from the single project budget above.
            Save to confirm shared-pool mode (use this to switch back from
            per-developer caps).
          </p>
          <div
            v-if="splitSaved"
            class="mb-3 px-3 py-2 rounded-md bg-rag-green/10 border border-rag-green/30 text-xs text-[#166534]"
            data-testid="split-saved"
          >
            ✓ Split saved
          </div>
          <div
            v-if="splitError"
            class="mb-3 px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart"
            data-testid="split-error"
          >
            {{ splitError }}
          </div>
          <div class="flex justify-end">
            <UiButton
              kind="primary"
              size="sm"
              :disabled="splitting"
              data-testid="save-split"
              @click="saveSplit"
            >
              {{ splitting ? 'Saving…' : 'Save split' }}
            </UiButton>
          </div>
        </UiCard>

        <UiCard>
          <!--
            initially-expanded comes from ?focus=topup, set when an
            over-budget inbox alert deep-links here. The TopupLog
            handles scroll-into-view + amount-input focus on mount.
          -->
          <TopupLog
            :topups="data.topups"
            :initially-expanded="route.query.focus === 'topup'"
            :submitting="topupSubmitting"
            :submit-error="topupError"
            @add="addTopup"
          />
        </UiCard>
      </div>

      <!-- RIGHT: context column (sticky) -->
      <div class="space-y-5 lg:sticky lg:top-6 self-start">
        <ConsumptionCard
          :used-usd="consumptionUsedUsd"
          :total-usd="consumptionTotalUsd"
          :reconciled-usd="consumptionReconciledUsd"
        />

        <UiCard data-testid="project-metadata">
          <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-3">
            Project metadata
          </div>
          <dl class="text-xs space-y-2">
            <div class="flex justify-between">
              <dt class="text-carbon-3">Project code</dt>
              <dd class="text-carbon font-mono">{{ data.focused.project_code ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-carbon-3">Region</dt>
              <dd class="text-carbon">{{ data.focused.region_code ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-carbon-3">Business Unit</dt>
              <dd class="text-carbon">{{ data.focused.cou_display_name ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-carbon-3">Onboarded</dt>
              <dd><UiBadge kind="rag-green">Onboarded</UiBadge></dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-carbon-3">Assigned devs</dt>
              <dd class="text-carbon">{{ data.devs.length }}</dd>
            </div>
          </dl>
        </UiCard>

        <UiCard data-testid="audit-trail-card">
          <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-3">
            Recent changes
          </div>
          <div v-if="data.audit.length === 0" class="text-xs text-carbon-3 italic">
            No audit-trail entries yet.
          </div>
          <ul v-else class="space-y-3 text-xs">
            <li v-for="e in data.audit" :key="e.id" class="grid grid-cols-[90px_1fr] gap-3">
              <span class="text-carbon-3 font-mono">
                {{ new Date(e.ts_recorded).toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) }}
              </span>
              <div>
                <div class="text-carbon font-semibold">{{ humaniseEventType(e.event_type) }}</div>
                <div class="text-carbon-3 mt-0.5">{{ e.actor_display_name ?? 'system' }}</div>
              </div>
            </li>
          </ul>
        </UiCard>
      </div>
    </div>
  </div>
  <div v-else-if="pending" class="max-w-[1440px] mx-auto px-10 py-16 text-center text-carbon-3 text-sm">
    Loading allocation…
  </div>
  <div v-else class="max-w-[1440px] mx-auto px-10 py-16 text-center" data-testid="alloc-not-found">
    <div class="text-lg font-bold text-carbon">Allocation not found.</div>
    <p class="text-sm text-carbon-2 mt-2">
      It may have been removed or you don't have permission to view it.
    </p>
    <NuxtLink to="/allocations" class="inline-block mt-4 text-sm font-bold text-brand-harmony hover:underline">
      ← Back to allocations
    </NuxtLink>
  </div>
</template>
