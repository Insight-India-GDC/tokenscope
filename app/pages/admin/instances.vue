<script setup lang="ts">
/*
 * Admin → Instances (ADR-0005 decision 3 — "admin: region-wide" spot +
 * block). Region-scoped table of enrolled devices with per-device spend,
 * anomaly flags (revoked / silent), and an admin revoke per row.
 *
 * Revoke uses the EXISTING admin primitive — DELETE /api/v1/instances/{id}
 * (admin + region-scoped, sets ts_actual_end). We do NOT add a new admin
 * revoke endpoint.
 *
 * Region scope: region-scoped admins stay in their home region; org-wide
 * role (platform-admin) gets a region-view picker, mirroring
 * admin/users.vue. The server re-checks requireRegionScope on both the read
 * and the revoke, so the picker is a convenience, not the gate.
 *
 * RBAC: client-side guard via useSession() — server middleware still
 * 401/403s a non-admin's API calls; the page just hides itself.
 */

import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface InstanceRow extends Record<string, unknown> {
  instance_id: string
  tool: string
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  silent: boolean
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
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
// on data (docs/design/admin-nav-responsiveness.md D1/D2).
// The region picker's read keeps its `error`: a failed read collapsed into `[]`
// renders as "no other regions" — the false empty D2 forbids.
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
const instancesUrl = computed(() =>
  scopeRegion.value ? `/api/v1/admin/instances?region=${scopeRegion.value}` : '',
)

// Explicit key because the getter can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<{ instances: InstanceRow[]; region: string } | null>(
  () => instancesUrl.value,
  {
    key: 'admin-instances-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [instancesUrl],
  },
)
const skeleton = computed(() => !error.value && data.value == null)

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const revoking = ref<Set<string>>(new Set())
async function revokeInstance(row: InstanceRow) {
  if (!confirm(`Revoke ${row.teammate_email}'s device? It stops emitting immediately.`)) return
  revoking.value = new Set([...revoking.value, row.instance_id])
  try {
    await $fetch(`/api/v1/instances/${row.instance_id}`, { method: 'DELETE' })
    flashToast('ok', `Device revoked: ${row.teammate_email}`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Revoke refused.'))
    consola.warn('instance revoke failed', err)
  } finally {
    const next = new Set(revoking.value)
    next.delete(row.instance_id)
    revoking.value = next
  }
}

const columns = [
  { key: 'teammate', label: 'Teammate' },
  { key: 'instance', label: 'Device' },
  { key: 'tool', label: 'Tool' },
  { key: 'spend', label: 'Spend (MTD)' },
  { key: 'last', label: 'Last emission' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Actions' },
]

function asRow(row: Record<string, unknown>): InstanceRow {
  return row as unknown as InstanceRow
}
function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-instances" data-admin-page="/admin/instances">
    <UiPageHead
      eyebrow="Administration"
      title="Devices"
      sub="Enrolled devices in this region. Spot an emitter that's wrong — or went silent — and revoke it."
    />

    <div
      v-if="toast"
      :data-testid="`admin-instances-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <UiFetchErrorBanner v-if="error" :error="error" label="devices" @retry="refresh" />
    <AdminDataTable
      v-else
      :rows="data?.instances ?? []"
      :columns="columns"
      :loading="skeleton"
      empty-headline="No devices"
      empty-sub="No enrolled devices in this region yet."
    >
      <template #toolbar>
        <div class="flex-1" />
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-instances-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse devices in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-instances-regions-error"
            @retry="refreshRegions"
          />
        </div>
      </template>
      <template #row="{ row }">
        <tr
          :data-testid="`admin-instances-row-${asRow(row).instance_id}`"
          class="hover:bg-brand-harmony-sheer/30"
        >
          <td class="px-5 py-3 text-sm">
            <div class="text-carbon font-medium">{{ asRow(row).teammate_display_name ?? asRow(row).teammate_email }}</div>
            <div class="text-[11px] text-carbon-3">{{ asRow(row).teammate_email }}</div>
          </td>
          <td class="px-5 py-3 text-sm">
            <code class="text-[11px] bg-calm/40 px-1 rounded text-carbon">{{ asRow(row).instance_id.slice(0, 8) }}</code>
            <span v-if="asRow(row).project" class="text-[11px] text-carbon-3 ml-1">· {{ asRow(row).project }}</span>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ asRow(row).tool }}</td>
          <td class="px-5 py-3 text-sm text-carbon font-mono">${{ asRow(row).spend_usd_mtd }}</td>
          <td class="px-5 py-3 text-sm text-carbon-3">{{ fmtTs(asRow(row).last_emission) }}</td>
          <td class="px-5 py-3 text-sm">
            <UiBadge v-if="asRow(row).revoked" kind="hunger">Revoked</UiBadge>
            <UiBadge v-else-if="asRow(row).silent" kind="rag-amber">Silent</UiBadge>
            <UiBadge v-else kind="rag-green">Active</UiBadge>
          </td>
          <td class="px-5 py-3 text-sm">
            <UiButton
              v-if="!asRow(row).revoked"
              kind="ghost"
              size="sm"
              :disabled="revoking.has(asRow(row).instance_id)"
              :data-testid="`admin-instance-revoke-${asRow(row).instance_id}`"
              title="Force-revoke this device — stops emission immediately."
              @click="revokeInstance(asRow(row))"
            >
              <span v-if="revoking.has(asRow(row).instance_id)">…</span>
              <span v-else>Revoke</span>
            </UiButton>
            <span v-else class="text-[11px] text-carbon-3">—</span>
          </td>
        </tr>
      </template>
    </AdminDataTable>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/instances">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
