<script setup lang="ts">
/*
 * ReportAccessSection — per-teammate report-access grants (mig 0129),
 * backed by GET/POST /api/v1/admin/report-access, DELETE
 * /api/v1/admin/report-access/{id} and GET
 * /api/v1/admin/report-access/teammate-search (task #19).
 *
 * Replaces the retired three-mode ReportVisibilitySection dial: instead of
 * ONE org-wide knob, an admin writes ONE grant (REPORT_ACCESS_PERMISSIONS,
 * shared/auth/report-visibility.ts — the two positive permissions that WIDEN)
 * against a NAMED teammate, optionally time-boxed.
 * The vocabulary (labels + descriptions) comes ONLY from that shared module so
 * this pane and the enforcement layer can never say something different about
 * the same value.
 *
 * ORG-WIDE ONLY, END TO END (post external design review, amendment B1): the
 * page (report-access.vue) mounts this component only when isOrgWide, and
 * every endpoint it calls is requireRole(event, 'platform-admin') with no
 * re-narrow step. So unlike the retired section, there is NO read-only mode
 * to render here — if this component is on screen at all, every action on it
 * is available. No `orgWide` prop, no disabled-controls branch.
 *
 * Grant flow mechanics (search → pick → permission → optional expiry →
 * confirm) model CouOwnersModal.vue's list/search/assign/revoke shape; the
 * teammate search is org-wide (B2) so it hits its own endpoint rather than
 * the region-scoped /admin/users list.
 */
import { ref, computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiEyebrow from '../ui/Eyebrow.vue'
import UiBadge from '../ui/Badge.vue'
import UiButton from '../ui/Button.vue'
import AdminDataTable, { type AdminColumn } from './AdminDataTable.vue'
import { useDebouncedSearch } from '../../composables/useDebouncedSearch'
import { apiErrorDetail } from '../../composables/useApiError'
import { roleLabel } from '#shared/auth/roles'
import {
  REPORT_ACCESS_PERMISSIONS,
  REPORT_ACCESS_PERMISSION_LABELS,
  REPORT_ACCESS_PERMISSION_DESCRIPTIONS,
  type ReportAccessPermission,
} from '#shared/auth/report-visibility'

export interface ReportAccessGrantRow extends Record<string, unknown> {
  id: string
  teammate_id: string
  display_name: string | null
  email: string
  role: string
  permission: ReportAccessPermission
  granted_by: string | null
  granted_by_name: string | null
  granted_at: string
  expires_at: string | null
  status: 'active' | 'expired'
}
export interface ReportAccessData {
  grants: ReportAccessGrantRow[]
}
interface TeammateHit {
  id: string
  display_name: string | null
  email: string
  role: string
  region_id: string
}

const props = defineProps<{ data: ReportAccessData | null }>()
const emit = defineEmits<{ changed: [] }>()

const grants = computed(() => props.data?.grants ?? [])

/*
 * AdminDataTable's row slot is typed Record<string, unknown> by design (see
 * the component's own comment) — narrow back to the concrete row shape here,
 * once, the same way activity-tags.vue / instances.vue do.
 */
function asRow(row: Record<string, unknown>): ReportAccessGrantRow {
  return row as unknown as ReportAccessGrantRow
}

const columns: AdminColumn[] = [
  { key: 'teammate', label: 'Teammate' },
  { key: 'role', label: 'Role' },
  { key: 'permission', label: 'Permission' },
  { key: 'granted_by', label: 'Granted by' },
  { key: 'granted_at', label: 'Granted' },
  { key: 'expires_at', label: 'Expires' },
  { key: 'actions', label: '' },
]

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString()
}
/** `asRow(row).expires_at` calls `asRow` fresh each read, so TS can't narrow
 *  the nullable across a ternary's condition and its true-branch — narrow
 *  once, on a plain parameter, instead. */
function fmtExpiry(v: string | null): string {
  return v ? fmtTs(v) : '—'
}

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 3500)
}

// ── Grant flow: search → pick → permission → optional expiry → confirm ──────
const query = ref('')
const results = ref<TeammateHit[]>([])
const searchError = ref<string | null>(null)
const picked = ref<TeammateHit | null>(null)
const permission = ref<ReportAccessPermission | null>(null)
const expiresAt = ref('')
const granting = ref(false)

const { run: runSearch, cancel: cancelSearch, pending: searching } = useDebouncedSearch<{
  results: TeammateHit[]
}>({
  search: (term) =>
    $fetch<{ results: TeammateHit[] }>('/api/v1/admin/report-access/teammate-search', {
      query: { q: term, limit: 10 },
    }),
  apply: (r) => {
    results.value = r.results ?? []
    searchError.value = null
  },
  onError: (e: unknown) => {
    searchError.value = apiErrorDetail(e, 'Search failed')
    results.value = []
  },
})

function onSearchInput() {
  const q = query.value.trim()
  if (q.length < 2) {
    cancelSearch()
    results.value = []
    searchError.value = null
    return
  }
  runSearch(q)
}

function pick(hit: TeammateHit) {
  picked.value = hit
  permission.value = null
  expiresAt.value = ''
  query.value = ''
  results.value = []
}

function backToSearch() {
  picked.value = null
  permission.value = null
  expiresAt.value = ''
}

const confirmName = computed(() => (picked.value ? picked.value.display_name ?? picked.value.email : ''))

async function submitGrant() {
  if (!picked.value || !permission.value) return
  granting.value = true
  try {
    await $fetch('/api/v1/admin/report-access', {
      method: 'POST',
      body: {
        teammate_id: picked.value.id,
        permission: permission.value,
        ...(expiresAt.value ? { expires_at: new Date(expiresAt.value).toISOString() } : {}),
      },
    })
    flashToast('ok', `${confirmName.value} now holds ${REPORT_ACCESS_PERMISSION_LABELS[permission.value]}.`)
    backToSearch()
    emit('changed')
  } catch (e: unknown) {
    flashToast('err', apiErrorDetail(e, 'Grant failed'))
  } finally {
    granting.value = false
  }
}

// ── Row action: one button, two clicks (arm, then fire) — busyId-guarded exactly
// like CouOwnersModal's assign/revoke, so an accidental click can't change a
// row that took an admin action (and possibly a live workflow) to create.
const confirmingRevokeId = ref<string | null>(null)
const busyId = ref<string | null>(null)

/** The row-action button's label across its three states (idle / armed / busy). */
function rowActionLabel(row: ReportAccessGrantRow): string {
  if (busyId.value === row.id) return 'Revoking…'
  if (confirmingRevokeId.value === row.id) return 'Confirm revoke?'
  return 'Revoke'
}

async function onRevokeClick(row: ReportAccessGrantRow) {
  if (confirmingRevokeId.value !== row.id) {
    confirmingRevokeId.value = row.id
    return
  }
  busyId.value = row.id
  const who = row.display_name ?? row.email
  try {
    await $fetch(`/api/v1/admin/report-access/${row.id}`, { method: 'DELETE' })
    flashToast('ok', `Revoked ${REPORT_ACCESS_PERMISSION_LABELS[row.permission]} for ${who}.`)
    confirmingRevokeId.value = null
    emit('changed')
  } catch (e: unknown) {
    flashToast('err', apiErrorDetail(e, 'Revoke failed'))
  } finally {
    busyId.value = null
  }
}
function cancelRevoke() {
  confirmingRevokeId.value = null
}
</script>

<template>
  <UiCard accent="vision" data-testid="report-access-section">
    <UiEyebrow>Reporting</UiEyebrow>
    <h2 class="text-lg font-bold text-carbon mt-1 mb-1">Report access</h2>
    <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
      Everyone already sees reports by their role: Admin sees the whole company; everyone else sees
      their own region plus whichever Business Units their own position covers. Here you can WIDEN
      one teammate whose role does not already reach that far to company-wide reporting. Every
      grant is scoped to that one person and, optionally, an expiry; it is never a whole-org policy
      change and never touches their platform role.
    </p>

    <div
      v-if="toast"
      :data-testid="`report-access-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- ── Grant flow ─────────────────────────────────────────────────────── -->
    <div class="mb-6 p-4 rounded-lg border border-calm-2">
      <h3 class="text-sm font-bold text-carbon">Grant access</h3>

      <template v-if="!picked">
        <label for="report-access-search-input" class="sr-only">Search teammates</label>
        <input
          id="report-access-search-input"
          v-model="query"
          type="search"
          placeholder="Search teammates by name or email…"
          class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="report-access-search"
          @input="onSearchInput"
        >
        <p v-if="searchError" class="text-xs text-rag-red mt-1" data-testid="report-access-search-error">
          {{ searchError }}
        </p>
        <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
          <li v-for="hit in results" :key="hit.id" class="flex items-center justify-between gap-3 px-3 py-2">
            <div class="min-w-0">
              <div class="text-sm text-carbon truncate">{{ hit.display_name ?? hit.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">{{ hit.email }} · {{ roleLabel(hit.role) }}</div>
            </div>
            <UiButton kind="primary" size="sm" :data-testid="`report-access-hit-${hit.id}`" @click="pick(hit)">
              Pick
            </UiButton>
          </li>
        </ul>
        <p v-else-if="query.trim().length >= 2 && !searching" class="text-[12px] text-carbon-3 mt-2">
          No matching teammates.
        </p>
      </template>

      <template v-else>
        <div class="flex items-center justify-between gap-2 mt-2">
          <p class="text-sm text-carbon">
            <strong>{{ picked.display_name ?? picked.email }}</strong>
            <span class="text-carbon-3"> · {{ picked.email }} · {{ roleLabel(picked.role) }}</span>
          </p>
          <UiButton kind="ghost" size="sm" data-testid="report-access-change-teammate" @click="backToSearch">
            Change
          </UiButton>
        </div>

        <div class="flex flex-col gap-2 mt-3">
          <label
            v-for="p in REPORT_ACCESS_PERMISSIONS"
            :key="p"
            class="block rounded-md border p-3 cursor-pointer transition-colors"
            :class="permission === p ? 'border-brand-vision bg-brand-vision/5' : 'border-calm-2 hover:border-cloud'"
          >
            <div class="flex items-start gap-2.5">
              <input
                type="radio"
                name="report-access-permission"
                class="mt-1"
                :value="p"
                :checked="permission === p"
                :data-testid="`report-access-permission-${p}`"
                @change="permission = p"
              >
              <div class="min-w-0">
                <span class="text-sm font-semibold text-carbon">{{ REPORT_ACCESS_PERMISSION_LABELS[p] }}</span>
                <span class="block text-xs text-carbon-3 mt-0.5 leading-relaxed">
                  {{ REPORT_ACCESS_PERMISSION_DESCRIPTIONS[p] }}
                </span>
              </div>
            </div>
          </label>
        </div>

        <template v-if="permission">
          <label for="report-access-expiry-input" class="block text-[12px] font-semibold text-carbon mt-3">
            Expires (optional)
          </label>
          <input
            id="report-access-expiry-input"
            v-model="expiresAt"
            type="datetime-local"
            class="mt-1 px-3 py-2 text-sm border border-calm-2 rounded-md"
            data-testid="report-access-expiry"
          >
          <p class="text-[11px] text-carbon-3 mt-0.5">Leave blank for open-ended, until revoked.</p>

          <div
            class="mt-3 p-3 rounded-md border border-brand-vision/30 bg-brand-vision/5"
            data-testid="report-access-confirm"
          >
            <p class="text-[12px] text-carbon leading-relaxed">
              <strong>{{ confirmName }}</strong> will see
              {{ REPORT_ACCESS_PERMISSION_DESCRIPTIONS[permission] }} — company-wide. This does
              <strong>not</strong> change their platform role.
            </p>
          </div>

          <div class="flex justify-end mt-3">
            <UiButton
              kind="primary"
              size="sm"
              :disabled="granting"
              data-testid="report-access-grant-submit"
              @click="submitGrant"
            >
              {{ granting ? 'Granting…' : 'Grant access' }}
            </UiButton>
          </div>
        </template>
      </template>
    </div>

    <!-- ── Active + expired grants ────────────────────────────────────────── -->
    <AdminDataTable
      :rows="grants"
      :columns="columns"
      empty-headline="No grants yet"
      empty-sub="No explicit grants yet — every teammate still sees whatever their role and Business Unit ownership already give them."
      data-testid="report-access-table"
    >
      <template #row="{ row }">
        <tr
          class="hover:bg-brand-harmony-sheer/30"
          :class="{ 'opacity-60': asRow(row).status === 'expired' }"
        >
          <td class="px-5 py-3">
            <div class="text-sm text-carbon font-medium">{{ asRow(row).display_name ?? asRow(row).email }}</div>
            <div class="text-[11px] text-carbon-3">{{ asRow(row).email }}</div>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">
            <UiBadge kind="outline">{{ roleLabel(asRow(row).role) }}</UiBadge>
          </td>
          <td class="px-5 py-3 text-sm text-carbon">
            {{ REPORT_ACCESS_PERMISSION_LABELS[asRow(row).permission] }}
            <UiBadge
              v-if="asRow(row).status === 'expired'"
              kind="neutral"
              class="ml-1.5"
              :data-testid="`report-access-status-${asRow(row).id}`"
            >
              Expired
            </UiBadge>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ asRow(row).granted_by_name ?? 'System (migration)' }}</td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ fmtTs(asRow(row).granted_at) }}</td>
          <td class="px-5 py-3 text-sm text-carbon-2">
            {{ fmtExpiry(asRow(row).expires_at) }}
          </td>
          <td class="px-5 py-3 text-right">
            <UiButton
              kind="ghost"
              size="sm"
              :disabled="busyId === asRow(row).id"
              :data-testid="`report-access-revoke-${asRow(row).id}`"
              @click="onRevokeClick(asRow(row))"
            >
              {{ rowActionLabel(asRow(row)) }}
            </UiButton>
            <UiButton
              v-if="confirmingRevokeId === asRow(row).id && busyId !== asRow(row).id"
              kind="ghost"
              size="sm"
              class="ml-1"
              @click="cancelRevoke"
            >
              Cancel
            </UiButton>
          </td>
        </tr>
      </template>
    </AdminDataTable>
    <p class="text-[11px] text-carbon-3 mt-2">
      An expired grant elevates nothing, and is superseded automatically the next time this teammate
      is granted the same permission.
    </p>
  </UiCard>
</template>
