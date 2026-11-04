<script setup lang="ts">
/*
 * Admin → Projects (top-level). Promotes the per-region Projects tab to a
 * first-class admin page with edit / retire / member management.
 *
 * Region scope mirrors Admin → Users: the org-wide role (
 * platform-admin) get a region-view picker (defaults to their own region);
 * region admins are pinned to their own region.
 */

import { computed, ref } from 'vue'
import { consola } from 'consola'
import EntityTable from '../../../components/admin/EntityTable.vue'
import AdminPageSkeleton from '../../../components/admin/AdminPageSkeleton.vue'
import ProjectMembersModal from '../../../components/admin/ProjectMembersModal.vue'
import ProjectEditDialog, { type ProjectEditTarget } from '../../../components/admin/ProjectEditDialog.vue'
import SetBudgetDialog, { type SetBudgetTarget } from '../../../components/admin/SetBudgetDialog.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface ProjectRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  client_facing_name?: string | null
  wbs_code?: string | null
  type: string
  cou_display_name: string | null
  cost_owning_unit_id: string | null
  is_onboarded: boolean
  repo_count: number
  is_authorised: boolean
  end_date: string | null
  ended: boolean
  deletable: boolean
  has_spend: boolean
  member_count: number
  has_budget: boolean
  /** Current shared-pool baseline allocation id; null = no budget yet. Drives the Budget link. */
  allocation_id: string | null
}

interface OrgUnit {
  id: string
  display_name: string
  is_cost_owning_unit: boolean
}

const { session } = useSession()

const regionId = computed(() => session.value?.regionId ?? '')

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})

// All three reads are declared lazily and never awaited: navigation is never
// gated on data, and the skeleton keys on ABSENT data, not `pending`
// (docs/design/admin-nav-responsiveness.md D1/D2). The two auxiliary reads keep
// their `error` as well — a picker that collapses failure into `[]` is the false
// empty D2 forbids.
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

const effectiveRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)

const projectsUrl = computed(() =>
  effectiveRegion.value ? `/api/v1/admin/projects?region=${effectiveRegion.value}&limit=50` : '',
)

// Explicit keys below because these getters can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<{ projects: ProjectRow[]; total: number } | null>(
  () => projectsUrl.value,
  {
    key: 'admin-projects-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [projectsUrl],
  },
)
const skeleton = computed(() => !error.value && data.value == null)

const {
  data: orgUnitsData,
  error: orgUnitsError,
  refresh: refreshOrgUnits,
} = useLazyFetch<{ nodes: OrgUnit[] } | null>(
  () => (effectiveRegion.value ? `/api/v1/admin/org-units?region=${effectiveRegion.value}` : ''),
  {
    key: 'admin-projects-org-units',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [effectiveRegion],
  },
)

// Prefer cost-owning units for the project COU select; fall back to all nodes
// if none are flagged (older regions may pre-date the attribute).
const couOptions = computed<{ id: string; display_name: string }[]>(() => {
  const nodes = orgUnitsData.value?.nodes ?? []
  const owning = nodes.filter((n) => n.is_cost_owning_unit)
  return (owning.length > 0 ? owning : nodes).map((n) => ({ id: n.id, display_name: n.display_name }))
})

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const columns = [
  { key: 'code', label: 'Code' },
  { key: 'display_name', label: 'Display name' },
  { key: 'wbs_code', label: 'WBS' },
  { key: 'cou_display_name', label: 'Business Unit' },
  { key: 'type', label: 'Type' },
  {
    key: 'is_onboarded',
    label: 'Onboarded',
    render: (r: Record<string, unknown>) => (r.is_onboarded ? 'Yes' : 'Catalogue'),
  },
  { key: 'repo_count', label: 'Repos' },
]

function asProjectRow(row: Record<string, unknown>): ProjectRow {
  return row as unknown as ProjectRow
}

// Edit dialog.
const editTarget = ref<ProjectEditTarget | null>(null)
function openEdit(row: ProjectRow) {
  editTarget.value = {
    id: row.id,
    code: row.code,
    display_name: row.display_name,
    client_facing_name: row.client_facing_name ?? null,
    wbs_code: row.wbs_code ?? null,
    type: row.type,
    cost_owning_unit_id: row.cost_owning_unit_id,
    is_authorised: row.is_authorised,
  }
}
async function onEdited() {
  editTarget.value = null
  flashToast('ok', 'Project updated.')
  await refresh()
}

// Set-first-baseline-budget dialog (recovery for budget-less projects).
const budgetProject = ref<SetBudgetTarget | null>(null)
async function onBudgetSet() {
  budgetProject.value = null
  flashToast('ok', 'Baseline budget created.')
  await refresh()
}

// Members modal (reused as-is).
const membersProject = ref<{ id: string; code: string; display_name: string } | null>(null)

// Lifecycle actions. "End now" sets end_date = now (the old "retire"); spend
// after the grace window spills to unallocated until re-tagged (D2). "Delete"
// is a hard removal, offered only for provably-empty projects (D4 `deletable`).
const mutating = ref<Set<string>>(new Set())
function markBusy(id: string, busy: boolean) {
  const next = new Set(mutating.value)
  if (busy) next.add(id)
  else next.delete(id)
  mutating.value = next
}
async function endNow(row: ProjectRow) {
  if (
    !confirm(
      `End ${row.display_name} (${row.code}) now? It stops accepting new spend; in-flight work past the grace window spills to unallocated until re-tagged.`,
    )
  )
    return
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, {
      method: 'PATCH',
      body: { end_date: new Date().toISOString() },
    })
    flashToast('ok', `Ended ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'End refused.'))
    consola.warn('project end failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
async function reopen(row: ProjectRow) {
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, { method: 'PATCH', body: { end_date: null } })
    flashToast('ok', `Re-opened ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Re-open refused.'))
    consola.warn('project reopen failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
// Why a $0-spend project can't be deleted (spend / tagged repos are the only
// hard blockers; budget + members cascade). Shown on the disabled control.
function deleteBlockedReason(row: ProjectRow): string {
  const parts: string[] = []
  if (row.has_spend) parts.push('attributed spend')
  if (row.repo_count > 0) parts.push(`${row.repo_count} tagged repo${row.repo_count === 1 ? '' : 's'}`)
  return `Can't delete — has ${parts.join(' and ')}. End it instead.`
}
async function remove(row: ProjectRow) {
  const extras: string[] = []
  if (row.has_budget) extras.push('its budget')
  if (row.member_count > 0) extras.push(`${row.member_count} member${row.member_count === 1 ? '' : 's'}`)
  const tail = extras.length ? ` This also removes ${extras.join(' and ')}.` : ''
  if (!confirm(`Permanently DELETE ${row.display_name} (${row.code})?${tail} This cannot be undone.`)) return
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, { method: 'DELETE' })
    flashToast('ok', `Deleted ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Delete refused.'))
    consola.warn('project delete failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-projects" data-admin-page="/admin/projects">
    <UiPageHead
      eyebrow="Administration"
      title="Projects"
      sub="Projects in this region. Create projects, edit budgets and owners, manage members."
    >
      <template v-if="isOrgWide" #actions>
        <div>
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-projects-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse projects in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-projects-regions-error"
            @retry="refreshRegions"
          />
        </div>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`admin-projects-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <UiFetchErrorBanner v-if="error" :error="error" label="projects" @retry="refresh" />
    <AdminPageSkeleton v-else-if="skeleton" :rows="6" />
    <EntityTable
      v-else
      entity-label="Projects"
      :rows="data?.projects ?? []"
      :columns="columns"
      :total="data?.total"
      add-to="/projects/new"
    >
      <template #rowActions="{ row }">
        <div class="flex items-center justify-end gap-2">
          <UiButton
            kind="ghost"
            size="sm"
            :data-testid="`project-edit-${asProjectRow(row).id}`"
            @click="openEdit(asProjectRow(row))"
          >
            Edit
          </UiButton>
          <UiButton
            v-if="asProjectRow(row).allocation_id"
            kind="ghost"
            size="sm"
            :to="`/allocations/${asProjectRow(row).allocation_id}?focus=topup`"
            :data-testid="`project-budget-${asProjectRow(row).id}`"
            title="Edit this project's budget — add a top-up"
          >
            Budget
          </UiButton>
          <UiButton
            v-else
            kind="ghost"
            size="sm"
            :data-testid="`project-budget-${asProjectRow(row).id}`"
            title="No budget yet — set the baseline budget"
            @click="budgetProject = { id: asProjectRow(row).id, code: asProjectRow(row).code, display_name: asProjectRow(row).display_name }"
          >
            Set budget
          </UiButton>
          <UiButton
            kind="ghost"
            size="sm"
            :data-testid="`project-members-${asProjectRow(row).id}`"
            @click="membersProject = { id: asProjectRow(row).id, code: asProjectRow(row).code, display_name: asProjectRow(row).display_name }"
          >
            Members
          </UiButton>
          <UiBadge
            v-if="asProjectRow(row).ended"
            kind="neutral"
            :data-testid="`project-ended-${asProjectRow(row).id}`"
            title="This project has ended. New spend spills to unallocated."
          >
            Ended
          </UiBadge>
          <UiButton
            v-if="!asProjectRow(row).ended"
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-end-${asProjectRow(row).id}`"
            @click="endNow(asProjectRow(row))"
          >
            {{ mutating.has(asProjectRow(row).id) ? '…' : 'End' }}
          </UiButton>
          <UiButton
            v-else
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-reopen-${asProjectRow(row).id}`"
            @click="reopen(asProjectRow(row))"
          >
            {{ mutating.has(asProjectRow(row).id) ? '…' : 'Re-open' }}
          </UiButton>
          <UiButton
            v-if="asProjectRow(row).deletable"
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-delete-${asProjectRow(row).id}`"
            title="Permanently delete. Its budget and members are removed too (no spend)."
            @click="remove(asProjectRow(row))"
          >
            Delete
          </UiButton>
          <span
            v-else
            class="text-[11px] text-carbon-3 italic cursor-help"
            :title="deleteBlockedReason(asProjectRow(row))"
            :data-testid="`project-delete-blocked-${asProjectRow(row).id}`"
          >
            can't delete
          </span>
        </div>
      </template>
    </EntityTable>

    <ProjectEditDialog
      :project="editTarget"
      :cou-options="couOptions"
      :cou-options-error="orgUnitsError"
      @close="editTarget = null"
      @saved="onEdited"
      @retry-cou-options="refreshOrgUnits"
    />

    <ProjectMembersModal
      :project="membersProject"
      @close="membersProject = null"
      @changed="refresh()"
    />

    <SetBudgetDialog
      :project="budgetProject"
      @close="budgetProject = null"
      @saved="onBudgetSet"
    />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/projects">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
