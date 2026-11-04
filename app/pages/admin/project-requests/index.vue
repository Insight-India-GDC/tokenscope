<script setup lang="ts">
/*
 * Admin → Project requests: the work queue (spec §3, A10). Pending requests
 * are listed here whatever happened to the inbox notification. A region admin
 * sees their region's requests; a platform admin sees every region's.
 */
import { computed, ref, watch } from 'vue'
import { BU_LABEL } from '#shared/reports/vocabulary'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Row {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  display_name: string
  requester_name: string | null
  requester_email: string
  region_code: string
  unit_name: string
  budget_usd: string
  created_at: string
  created_project_code: string | null
}

const PAGE_SIZE = 50
const status = ref<'pending' | 'decided'>('pending')
const offset = ref(0)
watch(status, () => {
  offset.value = 0
})
const { data, error, refresh } = useLazyFetch<
  { requests: Row[]; total: number; offset: number; has_more: boolean } | null
>('/api/v1/admin/project-requests', {
  server: false,
  default: () => null,
  query: { status, offset, limit: PAGE_SIZE },
})
const showingFrom = computed(() => (data.value?.requests.length ? data.value.offset + 1 : 0))
const showingTo = computed(() => (data.value ? data.value.offset + data.value.requests.length : 0))
const paged = computed(() => !!data.value && (data.value.offset > 0 || data.value.has_more))
function prevPage() {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
}
function nextPage() {
  if (data.value?.has_more) offset.value = data.value.offset + PAGE_SIZE
}
// Deciding requests shrinks the queue, so a later page can come back empty
// while earlier ones still hold requests: step back to the last page that has any.
watch(data, (d) => {
  if (d && !d.requests.length && d.offset > 0) offset.value = d.total > 0 ? Math.floor((d.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0
})

const STATUS_LABEL: Record<Row['status'], string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}
const fmtUsd = (v: string) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
</script>

<template>
  <div class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="admin-project-requests" data-admin-page="/admin/project-requests">
    <UiPageHead
      eyebrow="Organisation"
      title="Project requests"
      sub="Requests for new projects. Open one to edit the details, set the project code, and approve or reject it."
    />

    <div class="flex gap-2 mb-4">
      <UiButton :kind="status === 'pending' ? 'primary' : 'secondary'" size="sm" data-testid="project-requests-tab-pending" @click="status = 'pending'">
        Pending
      </UiButton>
      <UiButton :kind="status === 'decided' ? 'primary' : 'secondary'" size="sm" data-testid="project-requests-tab-decided" @click="status = 'decided'">
        Decided
      </UiButton>
    </div>

    <UiFetchErrorBanner v-if="error" :error="error" label="project requests" @retry="refresh" />
    <AdminPageSkeleton v-else-if="data == null || (!data.requests.length && data.offset > 0)" :rows="5" />
    <UiEmptyState
      v-else-if="!data.requests.length"
      :headline="status === 'pending' ? 'No requests are waiting' : 'No decided requests yet'"
    />
    <UiCard v-else>
      <div v-if="paged" class="flex items-center gap-3 mb-3" data-testid="project-requests-pager">
        <p class="text-[12px] text-carbon-3" data-testid="project-requests-range">
          Showing {{ showingFrom }}–{{ showingTo }} of {{ data.total }}<template v-if="status === 'pending'">, oldest first</template>.
        </p>
        <UiButton kind="secondary" size="sm" :disabled="data.offset === 0" data-testid="project-requests-prev" @click="prevPage">
          Previous
        </UiButton>
        <UiButton kind="secondary" size="sm" :disabled="!data.has_more" data-testid="project-requests-next" @click="nextPage">
          Next
        </UiButton>
      </div>
      <table class="w-full text-sm" data-testid="project-requests-table">
        <thead>
          <tr class="text-left text-[11px] uppercase tracking-[1px] text-carbon-3">
            <th class="py-2 pr-4">Project</th>
            <th class="py-2 pr-4">Requested by</th>
            <th class="py-2 pr-4">{{ BU_LABEL }}</th>
            <th class="py-2 pr-4 text-right">Budget</th>
            <th class="py-2 pr-4">Sent</th>
            <th class="py-2">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr v-for="r in data.requests" :key="r.id" :data-testid="`project-request-row-${r.id}`">
            <td class="py-2.5 pr-4">
              <NuxtLink :to="`/admin/project-requests/${r.id}`" class="font-medium text-brand-harmony hover:underline">
                {{ r.display_name }}
              </NuxtLink>
            </td>
            <td class="py-2.5 pr-4 text-carbon-2">{{ r.requester_name ?? r.requester_email }}</td>
            <td class="py-2.5 pr-4 text-carbon-2">{{ r.unit_name }} ({{ r.region_code }})</td>
            <td class="py-2.5 pr-4 text-right font-mono">{{ fmtUsd(r.budget_usd) }}</td>
            <td class="py-2.5 pr-4 text-carbon-2">{{ new Date(r.created_at).toLocaleDateString() }}</td>
            <td class="py-2.5">
              <UiBadge :kind="r.status === 'pending' ? 'rag-amber' : r.status === 'approved' ? 'rag-green' : 'neutral'">
                {{ STATUS_LABEL[r.status] }}
              </UiBadge>
              <span v-if="r.created_project_code" class="ml-2 font-mono text-[11px] text-carbon-3">{{ r.created_project_code }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </UiCard>
  </div>
</template>
