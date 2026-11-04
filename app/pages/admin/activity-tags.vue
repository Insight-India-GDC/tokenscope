<script setup lang="ts">
/*
 * Admin → Activity tags. Manage the region-scoped activity-tag vocabulary
 * (the activity_type table). Lists the GLOBAL standard set (read-only for a
 * region admin) plus this region's own additions — add, rename, reorder
 * (sort_order) and deactivate/reactivate (soft delete).
 *
 * Deactivation is the removal primitive: getActivityTypes filters
 * is_active = TRUE, so deactivating hides a tag from the developer's picker.
 * There is intentionally no hard delete (a free-form historical label has no
 * FK and could still be aggregating past tagged spend — soft-delete is safe).
 *
 * Region scope mirrors Admin → Instances / Projects: org-wide roles
 * (platform-admin) gets a region-view picker (defaults to their
 * own region) and may edit the global set; region admins are pinned to their
 * region and see the global rows read-only. The server re-checks scope on every
 * write (requireRole + requireActivityScope), so the UI guards are convenience.
 *
 * RBAC: client-side guard via useSession() — server still 401/403s a non-admin's
 * API calls; the page just hides itself.
 */

import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface TagRow extends Record<string, unknown> {
  id: string
  region_id: string | null
  label: string
  is_standard: boolean
  sort_order: number
  is_active: boolean
  scope: 'global' | 'region'
}

const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})
const regionId = computed(() => session.value?.regionId ?? '')

// Both reads are declared lazily and never awaited: navigation is never gated
// on data (docs/design/admin-nav-responsiveness.md D1/D2). The auxiliary read
// keeps its `error`: a region picker that collapses failure into `[]` is the
// false empty D2 forbids.
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{ regions: { id: string; code: string; display_name: string }[] } | null>(
  '/api/v1/admin/regions',
  { server: false, default: () => null },
)
const viewRegionId = ref('')
watch(regionId, (r) => { if (!viewRegionId.value && r) viewRegionId.value = r }, { immediate: true })

const scopeRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)
const listUrl = computed(() =>
  scopeRegion.value ? `/api/v1/admin/activity-types?region_id=${scopeRegion.value}` : '',
)

// Explicit key because the getter can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<{ region_id: string; activity_types: TagRow[] } | null>(
  () => listUrl.value,
  {
    key: 'admin-activity-tags-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [listUrl],
  },
)
const skeleton = computed(() => !error.value && data.value == null)

// A region admin may only edit region-scoped rows; org-wide roles may edit any
// row (including the global set). Mirrors the server's requireActivityScope.
function canEdit(row: TagRow): boolean {
  return isOrgWide.value || row.scope === 'region'
}

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

// ── add a region tag ────────────────────────────────────────────────────────
const newLabel = ref('')
const newSort = ref<number | null>(null)
const adding = ref(false)
async function addTag() {
  const label = newLabel.value.trim()
  if (!label || !scopeRegion.value) return
  adding.value = true
  try {
    await $fetch('/api/v1/admin/activity-types', {
      method: 'POST',
      body: {
        region_id: scopeRegion.value,
        label,
        ...(newSort.value !== null && newSort.value !== undefined ? { sort_order: newSort.value } : {}),
      },
    })
    newLabel.value = ''
    newSort.value = null
    flashToast('ok', `Added activity tag '${label}'.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Add refused.'))
    consola.warn('activity-tag add failed', err)
  } finally {
    adding.value = false
  }
}

// ── inline rename ───────────────────────────────────────────────────────────
const editingId = ref<string | null>(null)
const editLabel = ref('')
function startEdit(row: TagRow) {
  editingId.value = row.id
  editLabel.value = row.label
}
function cancelEdit() {
  editingId.value = null
  editLabel.value = ''
}
const mutating = ref<Set<string>>(new Set())
function markBusy(id: string, busy: boolean) {
  const next = new Set(mutating.value)
  if (busy) next.add(id)
  else next.delete(id)
  mutating.value = next
}
async function saveEdit(row: TagRow) {
  const label = editLabel.value.trim()
  if (!label || label === row.label) {
    cancelEdit()
    return
  }
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/activity-types/${row.id}`, { method: 'PATCH', body: { label } })
    flashToast('ok', `Renamed to '${label}'.`)
    cancelEdit()
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Rename refused.'))
    consola.warn('activity-tag rename failed', err)
  } finally {
    markBusy(row.id, false)
  }
}

// ── toggle active (soft delete / restore) ───────────────────────────────────
async function toggleActive(row: TagRow) {
  const next = !row.is_active
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/activity-types/${row.id}`, { method: 'PATCH', body: { is_active: next } })
    flashToast('ok', next ? `Reactivated '${row.label}'.` : `Deactivated '${row.label}' — hidden from the picker.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Toggle refused.'))
    consola.warn('activity-tag toggle failed', err)
  } finally {
    markBusy(row.id, false)
  }
}

// ── reorder via sort_order ──────────────────────────────────────────────────
async function setSort(row: TagRow, value: string) {
  const sort = Number(value)
  if (!Number.isInteger(sort) || sort < 0 || sort === row.sort_order) return
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/activity-types/${row.id}`, { method: 'PATCH', body: { sort_order: sort } })
    flashToast('ok', `Reordered '${row.label}'.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Reorder refused.'))
    consola.warn('activity-tag reorder failed', err)
  } finally {
    markBusy(row.id, false)
  }
}

const columns = [
  { key: 'label', label: 'Label' },
  { key: 'scope', label: 'Scope' },
  { key: 'is_standard', label: 'Standard' },
  { key: 'is_active', label: 'Active' },
  { key: 'sort_order', label: 'Sort' },
  { key: 'actions', label: 'Actions' },
]

function asRow(row: Record<string, unknown>): TagRow {
  return row as unknown as TagRow
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-activity-tags" data-admin-page="/admin/activity-tags">
    <UiPageHead
      eyebrow="Administration"
      title="Activity tags"
      sub="The activity vocabulary the picker suggests. Add your region's own tags, rename, reorder, or deactivate to hide one."
    >
      <template v-if="isOrgWide" #actions>
        <div>
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-activity-tags-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse activity tags in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-activity-tags-regions-error"
            @retry="refreshRegions"
          />
        </div>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`admin-activity-tags-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- Add a region tag -->
    <UiCard class="mb-5">
      <form class="flex flex-wrap items-end gap-3" data-testid="activity-tag-add-form" @submit.prevent="addTag">
        <div>
          <label class="block text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1.5">New tag label</label>
          <input
            v-model="newLabel"
            type="text"
            maxlength="64"
            placeholder="e.g. spike"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony min-w-[220px]"
            data-testid="activity-tag-new-label"
          >
        </div>
        <div>
          <label class="block text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1.5">Sort</label>
          <input
            v-model.number="newSort"
            type="number"
            min="0"
            placeholder="0"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony w-24"
            data-testid="activity-tag-new-sort"
          >
        </div>
        <UiButton
          kind="primary"
          size="sm"
          type="submit"
          :disabled="adding || !newLabel.trim()"
          data-testid="activity-tag-add"
        >
          {{ adding ? 'Adding…' : '+ Add region tag' }}
        </UiButton>
        <span class="text-[11px] text-carbon-3">
          Added to {{ regionsData?.regions.find((r) => r.id === scopeRegion)?.display_name ?? 'this region' }} as a non-standard tag.
        </span>
      </form>
    </UiCard>

    <UiFetchErrorBanner v-if="error" :error="error" label="activity tags" @retry="refresh" />
    <AdminDataTable
      v-else
      :rows="data?.activity_types ?? []"
      :columns="columns"
      :loading="skeleton"
      empty-headline="No activity tags"
      empty-sub="No global or region activity tags on file."
    >
      <template #row="{ row }">
        <tr
          :data-testid="`activity-tag-row-${asRow(row).id}`"
          class="hover:bg-brand-harmony-sheer/30"
          :class="{ 'opacity-60': !asRow(row).is_active }"
        >
          <td class="px-5 py-3 text-sm">
            <div v-if="editingId === asRow(row).id" class="flex items-center gap-2">
              <input
                v-model="editLabel"
                type="text"
                maxlength="64"
                class="px-2 py-1 text-sm border border-brand-harmony rounded-md"
                :data-testid="`activity-tag-edit-input-${asRow(row).id}`"
                @keyup.enter="saveEdit(asRow(row))"
                @keyup.esc="cancelEdit()"
              >
              <UiButton
                kind="primary"
                size="sm"
                :disabled="mutating.has(asRow(row).id)"
                :data-testid="`activity-tag-edit-save-${asRow(row).id}`"
                @click="saveEdit(asRow(row))"
              >
                Save
              </UiButton>
              <UiButton kind="ghost" size="sm" :data-testid="`activity-tag-edit-cancel-${asRow(row).id}`" @click="cancelEdit()">
                Cancel
              </UiButton>
            </div>
            <span v-else class="text-carbon font-medium">{{ asRow(row).label }}</span>
          </td>
          <td class="px-5 py-3 text-sm">
            <UiBadge :kind="asRow(row).scope === 'global' ? 'vision' : 'harmony'">
              {{ asRow(row).scope === 'global' ? 'Global' : 'Region' }}
            </UiBadge>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ asRow(row).is_standard ? 'Yes' : '—' }}</td>
          <td class="px-5 py-3 text-sm">
            <UiBadge v-if="asRow(row).is_active" kind="rag-green">Active</UiBadge>
            <UiBadge v-else kind="neutral">Inactive</UiBadge>
          </td>
          <td class="px-5 py-3 text-sm">
            <input
              v-if="canEdit(asRow(row))"
              type="number"
              min="0"
              :value="asRow(row).sort_order"
              :disabled="mutating.has(asRow(row).id)"
              class="w-20 px-2 py-1 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
              :data-testid="`activity-tag-sort-${asRow(row).id}`"
              @change="setSort(asRow(row), ($event.target as HTMLInputElement).value)"
            >
            <span v-else class="text-carbon-3 font-mono">{{ asRow(row).sort_order }}</span>
          </td>
          <td class="px-5 py-3 text-sm whitespace-nowrap">
            <div v-if="canEdit(asRow(row))" class="flex items-center justify-end gap-2">
              <UiButton
                v-if="editingId !== asRow(row).id"
                kind="ghost"
                size="sm"
                :disabled="mutating.has(asRow(row).id)"
                :data-testid="`activity-tag-rename-${asRow(row).id}`"
                @click="startEdit(asRow(row))"
              >
                Rename
              </UiButton>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="mutating.has(asRow(row).id)"
                :data-testid="`activity-tag-toggle-${asRow(row).id}`"
                :title="asRow(row).is_active ? 'Deactivate — hides this tag from the picker' : 'Reactivate'"
                @click="toggleActive(asRow(row))"
              >
                {{ mutating.has(asRow(row).id) ? '…' : (asRow(row).is_active ? 'Deactivate' : 'Reactivate') }}
              </UiButton>
            </div>
            <span
              v-else
              class="text-[11px] text-carbon-3 italic cursor-help"
              title="Global standard tags can only be managed by an Admin."
              :data-testid="`activity-tag-readonly-${asRow(row).id}`"
            >
              read-only
            </span>
          </td>
        </tr>
      </template>
    </AdminDataTable>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/activity-tags">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
