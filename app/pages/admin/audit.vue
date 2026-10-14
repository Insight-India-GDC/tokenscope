<script setup lang="ts">
/*
 * Admin → Audit (Wave VI). Reader for audit_event.
 *
 * Filters: event type / actor / date range. Click-to-expand row reveals
 * the full payload (JSON-formatted). Pagination via limit + offset.
 *
 * Region scoping is enforced server-side in the endpoint — admin only
 * sees their region's actor / subject footprint; platform-admin sees
 * everything.
 */

import { computed, ref } from 'vue'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface AuditEvent extends Record<string, unknown> {
  id: string
  eventType: string
  actorTeammateId: string | null
  actorEmail: string | null
  actorSystem: string | null
  /** Entra OID of the admin acting through persona override, when one was. */
  impersonatorOid: string | null
  subjectKind: string | null
  subjectId: string | null
  payload: unknown
  tsRecorded: string
}

interface AuditResp {
  events: AuditEvent[]
  total: number
  limit: number
  offset: number
}

const { session } = useSession()

const eventTypeFilter = ref('')
const sinceFilter = ref('')
const untilFilter = ref('')
const offset = ref(0)
const expandedId = ref<string | null>(null)
const LIMIT = 50

const auditUrl = computed(() => {
  const parts = [`limit=${LIMIT}`, `offset=${offset.value}`]
  if (eventTypeFilter.value) parts.push(`eventType=${encodeURIComponent(eventTypeFilter.value)}`)
  if (sinceFilter.value) {
    // datetime-local → ISO with Z
    const d = new Date(sinceFilter.value)
    if (!Number.isNaN(d.getTime())) parts.push(`since=${encodeURIComponent(d.toISOString())}`)
  }
  if (untilFilter.value) {
    const d = new Date(untilFilter.value)
    if (!Number.isNaN(d.getTime())) parts.push(`until=${encodeURIComponent(d.toISOString())}`)
  }
  return `/api/v1/admin/audit?${parts.join('&')}`
})

// Declared lazily, never awaited: navigation is never gated on data, and the
// skeleton keys on ABSENT data, not `pending` (docs/design/admin-nav-responsiveness.md D1/D2).
const { data, error, refresh } = useLazyFetch<AuditResp | null>(() => auditUrl.value, {
  server: false,
  default: () => null,
  watch: [auditUrl],
})
const skeleton = computed(() => !error.value && data.value == null)

// Distinct event types in the current page — fast UX win, not a full
// distinct-server query. Acceptable: filter dropdown is a quick-pick,
// not a definitive enum.
const seenEventTypes = computed(() => {
  const set = new Set<string>()
  for (const e of data.value?.events ?? []) set.add(e.eventType)
  return [...set].sort()
})

const columns = [
  { key: 'tsRecorded', label: 'Time' },
  { key: 'eventType', label: 'Event' },
  { key: 'actorEmail', label: 'Actor' },
  { key: 'subjectKind', label: 'Subject' },
  { key: 'payload', label: 'Payload' },
]

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString()
}

// Typed cast for the slot binding — AdminDataTable's row slot is typed
// Record<string, unknown> by design (see the component comment); the
// page narrows back to AuditEvent here so every cell expression
// type-checks against the known shape rather than `unknown`.
function asAuditEvent(row: Record<string, unknown>): AuditEvent {
  return row as unknown as AuditEvent
}

function payloadSummary(p: unknown): string {
  if (p == null) return '—'
  if (typeof p !== 'object') return String(p)
  const entries = Object.entries(p as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  const shown = entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
  return entries.length > 3 ? `${shown}, …` : shown
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function nextPage() {
  if (offset.value + LIMIT < (data.value?.total ?? 0)) offset.value += LIMIT
}
function prevPage() {
  offset.value = Math.max(0, offset.value - LIMIT)
}

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-audit" data-admin-page="/admin/audit">
    <UiPageHead
      eyebrow="Administration"
      title="Audit"
      sub="Append-only mutation trail. Click a row to inspect the payload."
    />

    <UiFetchErrorBanner v-if="error" :error="error" label="the audit log" @retry="refresh" />
    <AdminDataTable
      v-else
      :rows="data?.events ?? []"
      :columns="columns"
      :total="data?.total"
      :loading="skeleton"
      empty-headline="No events"
      empty-sub="No audit events match the current filters."
    >
      <template #toolbar>
        <select
          v-model="eventTypeFilter"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-audit-event-filter"
        >
          <option value="">All event types</option>
          <option v-for="t in seenEventTypes" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="flex items-center gap-2">
          <label class="text-[11px] uppercase tracking-[1.2px] text-carbon-3 font-bold">Since</label>
          <input
            v-model="sinceFilter"
            type="datetime-local"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
            data-testid="admin-audit-since"
          >
        </div>
        <div class="flex items-center gap-2">
          <label class="text-[11px] uppercase tracking-[1.2px] text-carbon-3 font-bold">Until</label>
          <input
            v-model="untilFilter"
            type="datetime-local"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
            data-testid="admin-audit-until"
          >
        </div>
      </template>

      <template #row="{ row }">
        <template v-if="asAuditEvent(row)">
          <tr
            :data-testid="`admin-audit-row-${asAuditEvent(row).id}`"
            class="hover:bg-brand-harmony-sheer/30 cursor-pointer"
            @click="toggleExpand(asAuditEvent(row).id)"
          >
            <td class="px-5 py-3 text-sm text-carbon-2 font-mono whitespace-nowrap">{{ fmtTs(asAuditEvent(row).tsRecorded) }}</td>
            <td class="px-5 py-3 text-sm">
              <UiBadge kind="vision">{{ asAuditEvent(row).eventType }}</UiBadge>
            </td>
            <td class="px-5 py-3 text-sm text-carbon">
              {{ asAuditEvent(row).actorEmail ?? asAuditEvent(row).actorSystem ?? '—' }}
              <span
                v-if="asAuditEvent(row).impersonatorOid"
                class="ml-1 text-[11px] font-semibold text-brand-hunger"
                :title="`Done by admin ${asAuditEvent(row).impersonatorOid} acting as this persona`"
                :data-testid="`admin-audit-impersonated-${asAuditEvent(row).id}`"
              >(via persona override)</span>
            </td>
            <td class="px-5 py-3 text-sm text-carbon-2">
              {{ asAuditEvent(row).subjectKind ?? '—' }}<span v-if="asAuditEvent(row).subjectId" class="text-carbon-3 font-mono"> · {{ (asAuditEvent(row).subjectId ?? '').slice(0, 8) }}</span>
            </td>
            <td class="px-5 py-3 text-sm text-carbon-2 truncate max-w-[480px]">{{ payloadSummary(asAuditEvent(row).payload) }}</td>
          </tr>
          <tr v-if="expandedId === asAuditEvent(row).id" :data-testid="`admin-audit-payload-${asAuditEvent(row).id}`" class="bg-calm/30">
            <td colspan="5" class="px-5 py-4">
              <p v-if="asAuditEvent(row).impersonatorOid" class="text-xs text-carbon mb-2" :data-testid="`admin-audit-impersonator-${asAuditEvent(row).id}`">
                Acting admin (persona override): <span class="font-mono">{{ asAuditEvent(row).impersonatorOid }}</span>
              </p>
              <pre class="text-xs text-carbon font-mono whitespace-pre-wrap break-all bg-white border border-calm-2 rounded p-3 overflow-auto max-h-96">{{ JSON.stringify(asAuditEvent(row).payload, null, 2) }}</pre>
            </td>
          </tr>
        </template>
      </template>
    </AdminDataTable>

    <div v-if="(data?.total ?? 0) > LIMIT" class="mt-4 flex items-center justify-end gap-3">
      <UiButton kind="ghost" size="sm" :disabled="offset === 0" @click="prevPage">← Prev</UiButton>
      <span class="text-xs text-carbon-3">
        {{ offset + 1 }}–{{ Math.min(offset + LIMIT, data?.total ?? 0) }} of {{ data?.total }}
      </span>
      <UiButton kind="ghost" size="sm" :disabled="offset + LIMIT >= (data?.total ?? 0)" @click="nextPage">Next →</UiButton>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/audit">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
