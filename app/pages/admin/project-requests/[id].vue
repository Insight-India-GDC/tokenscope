<script setup lang="ts">
/*
 * Admin → Project requests → one request (spec §3, A11). The admin may edit
 * any proposed field, sets the final project code, and approves (creating the
 * project, its PM and its baseline budget) or rejects with a note. A region
 * admin can keep the project in their own region only; the server re-checks
 * the final region and Business Unit either way.
 */
import { computed, ref, watch } from 'vue'
import TeammatePicker, { type PickedTeammate } from '../../../components/projects/TeammatePicker.vue'
import { useAdminAccess } from '../../../composables/useAdminAccess'
import { useBusinessUnits, utcMidnight } from '../../../composables/useProjectFormOptions'
import { mutationErrorDetail } from '../../../composables/useApiError'
import { BU_LABEL } from '#shared/reports/vocabulary'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RequestDetail {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  requester_name: string | null
  requester_email: string
  suggested_code: string | null
  display_name: string
  type: 'billable' | 'pursuit' | 'internal'
  region_id: string
  region_name: string
  cost_owning_unit_id: string
  unit_name: string
  wbs_code: string | null
  end_date: string | null
  proposed_pm_teammate_id: string
  pm_name: string | null
  pm_email: string
  budget_usd: string
  budget_from: string
  budget_to: string
  justification: string
  created_at: string
  decided_by_name: string | null
  decided_at: string | null
  decision_note: string | null
  created_project_code: string | null
}
interface Similar { id: string; code: string; display_name: string; region_code: string }

const route = useRoute()
const id = computed(() => String(route.params.id))
const { isOrgWide, regionId: homeRegionId } = useAdminAccess()
const { units, regions } = useBusinessUnits()

const { data, error, refresh } = useLazyFetch<{ request: RequestDetail; similar_projects: Similar[] } | null>(
  () => `/api/v1/admin/project-requests/${id.value}`,
  { server: false, default: () => null },
)
const req = computed(() => data.value?.request ?? null)
const pending = computed(() => req.value?.status === 'pending')

const code = ref('')
const displayName = ref('')
const type = ref<RequestDetail['type']>('billable')
const regionId = ref('')
const couId = ref('')
const pm = ref<PickedTeammate | null>(null)
const endDate = ref('')
const wbsCode = ref('')
const budgetUsd = ref('')
const fromIso = ref('')
const toIso = ref('')
const note = ref('')

/*
 * The form is seeded from the request once per request AND status. A failed
 * decision refreshes the request (so a decision someone else made shows up),
 * and that refresh must not wipe the admin's edits: only a change of status,
 * i.e. a decision that actually landed, reseeds it.
 */
let seededFor: string | null = null
watch(
  req,
  (r) => {
    if (!r) return
    const key = `${r.id}:${r.status}`
    if (key === seededFor) return
    seededFor = key
    code.value = r.suggested_code ?? ''
    displayName.value = r.display_name
    type.value = r.type
    regionId.value = r.region_id
    couId.value = r.cost_owning_unit_id
    pm.value = { id: r.proposed_pm_teammate_id, display_name: r.pm_name, email: r.pm_email }
    endDate.value = r.end_date ? r.end_date.slice(0, 10) : ''
    wbsCode.value = r.wbs_code ?? ''
    budgetUsd.value = r.budget_usd
    fromIso.value = r.budget_from.slice(0, 10)
    toIso.value = r.budget_to.slice(0, 10)
  },
  { immediate: true },
)

const regionOptions = computed(() => (isOrgWide.value ? regions.value : regions.value.filter((r) => r.id === homeRegionId.value)))
const couOptions = computed(() => units.value.filter((u) => u.region_id === regionId.value))
watch(regionId, () => {
  if (units.value.length && !couOptions.value.some((u) => u.id === couId.value)) couId.value = ''
})

const busy = ref<'approve' | 'reject' | null>(null)
const actionError = ref<string | null>(null)

const canApprove = computed(() =>
  pending.value && !busy.value && !!code.value.trim() && !!displayName.value.trim() && !!couId.value && !!pm.value
  && /^\d+(\.\d{1,2})?$/.test(budgetUsd.value) && Number(budgetUsd.value) > 0
  && !!fromIso.value && !!toIso.value && fromIso.value < toIso.value,
)

async function approve() {
  if (!canApprove.value || !pm.value) return
  busy.value = 'approve'
  actionError.value = null
  try {
    await $fetch(`/api/v1/admin/project-requests/${id.value}/approve`, {
      method: 'POST',
      body: {
        code: code.value.trim(),
        display_name: displayName.value.trim(),
        type: type.value,
        region_id: regionId.value,
        cost_owning_unit_id: couId.value,
        pm_teammate_id: pm.value.id,
        wbs_code: wbsCode.value.trim(),
        end_date: endDate.value ? utcMidnight(endDate.value) : null,
        budget: { amount_usd: budgetUsd.value, from: utcMidnight(fromIso.value), to: utcMidnight(toIso.value) },
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      },
    })
    await refresh()
  } catch (e) {
    actionError.value = mutationErrorDetail(
      e,
      'Approval failed. Nothing was created.',
      'We could not tell whether the approval went through. The request has been reloaded: check its status before approving again.',
    )
    await refresh()
  } finally {
    busy.value = null
  }
}

async function reject() {
  if (!pending.value || !note.value.trim()) return
  busy.value = 'reject'
  actionError.value = null
  try {
    await $fetch(`/api/v1/admin/project-requests/${id.value}/reject`, { method: 'POST', body: { note: note.value.trim() } })
    await refresh()
  } catch (e) {
    actionError.value = mutationErrorDetail(
      e,
      'Could not reject the request.',
      'We could not tell whether the rejection went through. The request has been reloaded: check its status before trying again.',
    )
    await refresh()
  } finally {
    busy.value = null
  }
}

const inputClass = 'w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony disabled:bg-calm/40'
const labelClass = 'block text-carbon-3 font-bold uppercase tracking-[1px] mb-1'
</script>

<template>
  <div class="max-w-[1100px] mx-auto px-10 py-8 pb-20" data-testid="admin-project-request" data-admin-page="/admin/project-requests">
    <!-- No :crumbs here: the admin layout already renders the linked trail
         (Admin › Organisation › Project requests), so a second one doubled it. -->
    <UiPageHead eyebrow="Project requests" :title="req?.display_name ?? 'Project request'" />
    <NuxtLink to="/admin/project-requests" class="text-xs text-brand-harmony hover:underline">← All requests</NuxtLink>

    <UiFetchErrorBanner v-if="error" :error="error" label="project request" class="mt-4" @retry="refresh" />
    <AdminPageSkeleton v-else-if="!req" :rows="6" />
    <div v-else class="mt-4 space-y-5">
      <UiCard>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="text-sm text-carbon-2 leading-relaxed">
            <strong class="text-carbon">{{ req.requester_name ?? req.requester_email }}</strong> asked on
            {{ new Date(req.created_at).toLocaleString() }}:
            <p class="mt-1 whitespace-pre-line text-carbon" data-testid="project-request-justification">{{ req.justification }}</p>
          </div>
          <UiBadge :kind="pending ? 'rag-amber' : req.status === 'approved' ? 'rag-green' : 'neutral'" data-testid="project-request-status">
            {{ req.status }}
          </UiBadge>
        </div>
        <p v-if="!pending" class="mt-3 text-xs text-carbon-3" data-testid="project-request-decided">
          <template v-if="req.status === 'withdrawn'">Withdrawn by the requester</template>
          <template v-else>Decided by {{ req.decided_by_name ?? 'an admin' }}</template>
          <template v-if="req.decided_at"> on {{ new Date(req.decided_at).toLocaleString() }}</template>.
          <template v-if="req.decision_note"> “{{ req.decision_note }}”</template>
          <NuxtLink v-if="req.created_project_code" :to="`/projects/${encodeURIComponent(req.created_project_code)}`" class="ml-1 text-brand-harmony hover:underline">
            Open {{ req.created_project_code }} →
          </NuxtLink>
        </p>
      </UiCard>

      <div
        v-if="data?.similar_projects?.length"
        class="p-3 rounded-md border border-rag-amber/40 bg-rag-amber/5 text-xs text-carbon-2"
        data-testid="project-request-similar"
      >
        <div class="font-semibold text-carbon mb-1">Existing projects with similar names</div>
        <ul>
          <li v-for="p in data.similar_projects" :key="p.id">
            <span class="font-mono">{{ p.code }}</span> · {{ p.display_name }} <span class="text-carbon-3">({{ p.region_code }})</span>
          </li>
        </ul>
      </div>

      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">{{ pending ? 'Review and edit' : 'What was asked for' }}</div>
        <fieldset :disabled="!pending" class="grid grid-cols-2 gap-4">
          <label class="text-xs">
            <span :class="labelClass">Project code (final)</span>
            <input v-model="code" type="text" :class="inputClass" class="font-mono" :placeholder="req.suggested_code ?? 'e.g. ACME-2026'" data-testid="approve-code">
          </label>
          <label class="text-xs">
            <span :class="labelClass">Name</span>
            <input v-model="displayName" type="text" :class="inputClass" data-testid="approve-name">
          </label>
          <label class="text-xs">
            <span :class="labelClass">Type</span>
            <select v-model="type" :class="inputClass" class="bg-white">
              <option value="billable">Billable</option>
              <option value="pursuit">Pursuit</option>
              <option value="internal">Internal</option>
            </select>
          </label>
          <label class="text-xs">
            <span :class="labelClass">Region</span>
            <select v-model="regionId" :class="inputClass" class="bg-white" data-testid="approve-region">
              <option v-for="r in regionOptions" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </label>
          <label class="text-xs">
            <span :class="labelClass">{{ BU_LABEL }}</span>
            <select v-model="couId" :class="inputClass" class="bg-white" data-testid="approve-cou">
              <option value="" disabled>Select a {{ BU_LABEL.toLowerCase() }}…</option>
              <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
            </select>
          </label>
          <div class="text-xs">
            <span :class="labelClass">Project manager</span>
            <TeammatePicker v-model="pm" testid="approve-pm" :disabled="!pending" />
          </div>
          <label class="text-xs">
            <span :class="labelClass">Budget (USD)</span>
            <input v-model="budgetUsd" type="text" inputmode="decimal" :class="inputClass" class="font-mono" data-testid="approve-budget">
          </label>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <label>
              <span :class="labelClass">From (UTC)</span>
              <input v-model="fromIso" type="date" :class="inputClass">
            </label>
            <label>
              <span :class="labelClass">Until (not incl.)</span>
              <input v-model="toIso" type="date" :class="inputClass">
            </label>
          </div>
          <label class="text-xs">
            <span :class="labelClass">End date (optional)</span>
            <input v-model="endDate" type="date" :class="inputClass">
          </label>
          <label class="text-xs">
            <span :class="labelClass">WBS code (optional)</span>
            <input v-model="wbsCode" type="text" maxlength="64" :class="inputClass" class="font-mono">
          </label>
        </fieldset>
      </UiCard>

      <UiCard v-if="pending">
        <label class="text-xs block">
          <span :class="labelClass">Note to the requester (required to reject)</span>
          <textarea v-model="note" rows="2" maxlength="2000" :class="inputClass" data-testid="decision-note" />
        </label>
        <p v-if="actionError" class="mt-2 text-sm text-rag-red" role="alert" data-testid="decision-error">{{ actionError }}</p>
        <div class="flex justify-end gap-2 mt-3">
          <UiButton kind="secondary" size="sm" :disabled="!!busy || !note.trim()" data-testid="reject-request" @click="reject">
            {{ busy === 'reject' ? 'Rejecting…' : 'Reject' }}
          </UiButton>
          <UiButton kind="primary" size="sm" :disabled="!canApprove" data-testid="approve-request" @click="approve">
            {{ busy === 'approve' ? 'Creating…' : 'Approve and create project' }}
          </UiButton>
        </div>
        <p class="mt-2 text-[11px] text-carbon-3">
          Approving makes the project manager above the project's PM and the requester a member, with the budget above as its baseline.
        </p>
      </UiCard>
    </div>
  </div>
</template>
