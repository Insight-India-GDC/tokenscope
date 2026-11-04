<script setup lang="ts">
/*
 * My projects → "New project" (admins and Project Managers) or "Request a
 * project" (everyone else), and the caller's own requests with their status.
 * A pending request can be withdrawn here.
 */
import { computed, ref } from 'vue'
import UiButton from '../ui/Button.vue'
import UiBadge from '../ui/Badge.vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { useProjectCapabilities } from '../../composables/useProjectFormOptions'
import { mutationErrorDetail } from '../../composables/useApiError'

interface MyRequest {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  display_name: string
  region_code: string
  unit_name: string
  budget_usd: string
  created_at: string
  decided_at: string | null
  decision_note: string | null
  created_project_code: string | null
  created_project_name: string | null
}

const { isAdmin } = useAdminAccess()
const { capabilities } = useProjectCapabilities()
const canCreate = computed(() => isAdmin.value || capabilities.value?.can_create_projects === true)

const { data, refresh } = useFetch<{ requests: MyRequest[] }>('/api/v1/me/project-requests', {
  key: 'me-project-requests',
  default: () => ({ requests: [] }),
})
const requests = computed(() => data.value?.requests ?? [])

const STATUS: Record<MyRequest['status'], { label: string; kind: 'neutral' | 'rag-amber' | 'rag-green' | 'rag-red' }> = {
  pending: { label: 'Waiting for an admin', kind: 'rag-amber' },
  approved: { label: 'Approved', kind: 'rag-green' },
  rejected: { label: 'Not approved', kind: 'rag-red' },
  withdrawn: { label: 'Withdrawn', kind: 'neutral' },
}

const busyId = ref<string | null>(null)
const error = ref<string | null>(null)
async function withdraw(r: MyRequest) {
  busyId.value = r.id
  error.value = null
  try {
    await $fetch(`/api/v1/me/project-requests/${r.id}/withdraw`, { method: 'POST' })
    await refresh()
  } catch (e) {
    error.value = mutationErrorDetail(
      e,
      'Could not withdraw the request.',
      'We could not tell whether the request was withdrawn. Check its status below before trying again.',
    )
    await refresh()
  } finally {
    busyId.value = null
  }
}

const fmtUsd = (v: string) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
</script>

<template>
  <section class="mb-6" data-testid="project-requests-panel">
    <div class="flex items-center justify-end gap-2">
      <UiButton v-if="canCreate" to="/projects/new" kind="primary" size="sm" data-testid="projects-new">
        New project
      </UiButton>
      <UiButton v-else to="/projects/request" kind="primary" size="sm" data-testid="projects-request">
        Request a project
      </UiButton>
    </div>

    <div v-if="requests.length" class="mt-4 border border-calm-2 rounded-lg bg-white" data-testid="my-project-requests">
      <div class="px-4 py-2.5 border-b border-calm-2 text-sm font-bold text-carbon">Your project requests</div>
      <p v-if="error" class="px-4 pt-2 text-xs text-rag-red" role="alert">{{ error }}</p>
      <ul class="divide-y divide-calm-2">
        <li
          v-for="r in requests"
          :key="r.id"
          class="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1"
          :data-testid="`my-project-request-${r.id}`"
        >
          <div class="min-w-0 flex-1">
            <div class="text-sm text-carbon font-medium truncate">{{ r.display_name }}</div>
            <!-- What was ASKED for. An admin may change any of it on approval,
                 so the created project is named separately below. -->
            <div class="text-[11px] text-carbon-3" :data-testid="`my-project-request-asked-${r.id}`">
              Requested: {{ r.unit_name }} ({{ r.region_code }}), budget {{ fmtUsd(r.budget_usd) }}
              <template v-if="r.decision_note"> · “{{ r.decision_note }}”</template>
            </div>
            <div v-if="r.created_project_code" class="text-[12px] mt-0.5" :data-testid="`my-project-request-created-${r.id}`">
              Created as
              <NuxtLink
                :to="`/projects/${encodeURIComponent(r.created_project_code)}`"
                class="font-semibold text-brand-harmony hover:underline"
              >{{ r.created_project_name ?? r.created_project_code }} · <span class="font-mono">{{ r.created_project_code }}</span> →</NuxtLink>
            </div>
          </div>
          <UiBadge :kind="STATUS[r.status].kind">{{ STATUS[r.status].label }}</UiBadge>
          <UiButton
            v-if="r.status === 'pending'"
            kind="ghost"
            size="sm"
            :disabled="busyId === r.id"
            :data-testid="`withdraw-project-request-${r.id}`"
            @click="withdraw(r)"
          >
            {{ busyId === r.id ? 'Withdrawing…' : 'Withdraw' }}
          </UiButton>
        </li>
      </ul>
    </div>
  </section>
</template>
