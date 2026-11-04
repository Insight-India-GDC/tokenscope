<script setup lang="ts">
/*
 * Admin → Grants (design doc §Grant lifecycle, F3.3). Region-scoped view of a
 * single teammate's authorized connections (oauth_token grants) with an admin
 * revoke per row.
 *
 * `oauth_token` has no region of its own, so the surface is teammate-first: pick
 * a teammate (region-scoped search), then list THEIR grants. The server resolves
 * the teammate's region and re-checks requireRegionScope on both the read and the
 * revoke, so a region admin can never see or revoke a peer-region teammate's
 * grants (the picker only offers same-region teammates anyway).
 *
 * Revoke uses the new admin primitive — POST /api/v1/admin/grants/{id}/revoke
 * (region-scoped, sets revoked_at, cascades ts_actual_end for emit grants).
 *
 * RBAC: client-side guard via useSession() — the server still 401/403s a
 * non-admin's API calls; the page just hides itself.
 */

import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminPageSkeleton from '../../components/admin/AdminPageSkeleton.vue'
// Render-boundary sanitizer for a self-registered client_name — see S6: names
// registered before the bounds fix shipped may still carry control/bidi
// characters, so this strips them defensively wherever the name is displayed.
import { sanitizeClientNameForDisplay } from '#shared/schemas/oauth'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Teammate extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
}
interface GrantRow extends Record<string, unknown> {
  id: string
  client_id: string
  client_name: string
  client_registered_at: string
  scopes: string[]
  scope_labels: string[]
  state: 'active' | 'inactive' | 'revoked' | 'expired'
  created_at: string
  last_used_at: string | null
  is_emit: boolean
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

// All three reads are declared lazily and never awaited: navigation is never
// gated on data, and each skeleton keys on ABSENT data, not `pending`
// (docs/design/admin-nav-responsiveness.md D1/D2).
// The region picker's read keeps its `error` too: collapsing failure into `[]`
// would render as "no other regions" — the false empty D2 forbids.
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

// Teammate search (region-scoped). Pick one → load their grants.
const search = ref('')
const teammatesUrl = computed(() => {
  if (!scopeRegion.value) return ''
  const q = search.value.trim()
  return `/api/v1/admin/teammates?region=${scopeRegion.value}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`
})
// Explicit keys below because these getters can be '' (D1); the watch carries the refetch.
const { data: tmData, error: tmError, refresh: refreshTeammates } = useLazyFetch<{ teammates: Teammate[] } | null>(
  () => teammatesUrl.value,
  {
    key: 'admin-grants-teammates',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [teammatesUrl],
  },
)
const teammatesSkeleton = computed(() => !tmError.value && tmData.value == null)

const selected = ref<Teammate | null>(null)
// Clear the selection when the region view changes (the teammate may not belong).
watch(scopeRegion, () => { selected.value = null })

const grantsUrl = computed(() =>
  selected.value ? `/api/v1/admin/grants?teammate_id=${selected.value.id}` : '',
)
const { data: grantsData, error: grantsError, refresh } = useLazyFetch<{ teammate_id: string; grants: GrantRow[] } | null>(
  () => grantsUrl.value,
  {
    key: 'admin-grants-list',
    server: false,
    default: () => null,
    immediate: false,
    watch: [grantsUrl],
  },
)
// Only the CURRENT teammate's grants count as present: the response names its
// teammate, so the previous pick's list reads as absent while the new one loads.
const grants = computed(() =>
  grantsData.value && grantsData.value.teammate_id === selected.value?.id ? grantsData.value.grants : null,
)
const grantsSkeleton = computed(() => !grantsError.value && grants.value == null)

function selectTeammate(t: Teammate) {
  selected.value = t
}

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const revoking = ref<Set<string>>(new Set())
async function revokeGrant(g: GrantRow) {
  const who = selected.value?.email ?? 'this teammate'
  // Never interpolate client-authored text (g.client_name) into a native
  // confirm() dialog — a self-registered name could otherwise spoof or
  // obscure the dialog itself (S6; account.vue's revokeGrant is the correct
  // sibling — static text only). The row above already shows the client's
  // name + id; the dialog only needs to say WHOSE connection this revokes.
  const msg = g.is_emit
    ? `Revoke ${who}'s emit connection? It stops their device emitting immediately.`
    : `Revoke ${who}'s connection? It logs that client out.`
  if (!confirm(msg)) return
  revoking.value = new Set([...revoking.value, g.id])
  try {
    await $fetch(`/api/v1/admin/grants/${g.id}/revoke`, { method: 'POST', body: {} })
    flashToast('ok', `Connection revoked: ${sanitizeClientNameForDisplay(g.client_name)}`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Revoke refused.'))
    consola.warn('grant revoke failed', err)
  } finally {
    const next = new Set(revoking.value)
    next.delete(g.id)
    revoking.value = next
  }
}

function grantBadge(g: GrantRow): { kind: 'hunger' | 'rag-amber' | 'rag-green'; label: string } {
  switch (g.state) {
    case 'revoked': return { kind: 'hunger', label: 'Revoked' }
    case 'expired': return { kind: 'rag-amber', label: 'Expired' }
    case 'inactive': return { kind: 'rag-amber', label: 'Inactive' }
    default: return { kind: 'rag-green', label: 'Active' }
  }
}
function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-grants" data-admin-page="/admin/grants">
    <UiPageHead
      eyebrow="Administration"
      title="Connections"
      sub="Authorized connections (OAuth/MCP grants) per teammate. Revoke a connection to log a client out — emit grants also stop the device emitting."
    />

    <div
      v-if="toast"
      :data-testid="`admin-grants-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
      <!-- Teammate picker -->
      <UiCard>
        <UiEyebrow>Teammate</UiEyebrow>
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-grants-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse teammates in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-grants-regions-error"
            @retry="refreshRegions"
          />
        </div>
        <input
          v-model="search"
          type="text"
          placeholder="Search by name or email"
          class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="admin-grants-search"
        >
        <UiFetchErrorBanner v-if="tmError" :error="tmError" label="teammates" class="mt-3" @retry="refreshTeammates" />
        <AdminPageSkeleton v-else-if="teammatesSkeleton" :rows="6" :toolbar="false" class="mt-3" />
        <ul v-else class="mt-3 divide-y divide-calm-2 max-h-[420px] overflow-auto" data-testid="admin-grants-teammates">
          <li
            v-for="t in tmData?.teammates ?? []"
            :key="t.id"
            class="py-2"
          >
            <button
              type="button"
              class="text-left w-full hover:bg-brand-harmony-sheer/30 rounded px-1 py-0.5"
              :class="selected?.id === t.id ? 'bg-brand-harmony-sheer/50' : ''"
              :data-testid="`admin-grants-teammate-${t.id}`"
              @click="selectTeammate(t)"
            >
              <div class="text-sm text-carbon font-medium truncate">{{ t.display_name ?? t.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">{{ t.email }}</div>
            </button>
          </li>
          <li v-if="!(tmData?.teammates?.length)" class="py-3 text-xs text-carbon-3">
            No teammates match.
          </li>
        </ul>
      </UiCard>

      <!-- Grants for the selected teammate -->
      <UiCard>
        <UiEyebrow>Authorized connections</UiEyebrow>
        <p v-if="!selected" class="text-sm text-carbon-2 mt-2" data-testid="admin-grants-noselection">
          Pick a teammate on the left to see their connections.
        </p>
        <template v-else>
          <div class="text-sm text-carbon font-medium mt-1">{{ selected.display_name ?? selected.email }}</div>
          <div class="text-[11px] text-carbon-3">{{ selected.email }}</div>

          <UiFetchErrorBanner v-if="grantsError" :error="grantsError" label="their connections" class="mt-3" @retry="refresh" />
          <AdminPageSkeleton v-else-if="grantsSkeleton" :rows="3" :toolbar="false" class="mt-3" />
          <ul
            v-else-if="grants?.length"
            class="mt-3 divide-y divide-calm-2"
            data-testid="admin-grants-list"
          >
            <li
              v-for="g in grants"
              :key="g.id"
              class="flex flex-wrap items-center gap-3 py-3"
              :data-testid="`admin-grants-row-${g.id}`"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-carbon truncate">{{ sanitizeClientNameForDisplay(g.client_name) }}</span>
                  <code
                    class="text-[10px] bg-calm/40 px-1 rounded text-carbon-3"
                    :title="`Client registered ${fmtTs(g.client_registered_at)}`"
                    :data-testid="`admin-grant-client-id-${g.id}`"
                  >{{ g.client_id.slice(0, 8) }}</code>
                  <UiBadge :kind="grantBadge(g).kind" :data-testid="`admin-grant-state-${g.id}`">
                    {{ grantBadge(g).label }}
                  </UiBadge>
                  <UiBadge v-if="g.is_emit" kind="rag-amber" :data-testid="`admin-grant-emit-${g.id}`">Emits</UiBadge>
                </div>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="(label, i) in g.scope_labels" :key="i" class="text-[11px] text-carbon-3">· {{ label }}</li>
                </ul>
                <div class="text-[11px] text-carbon-3 mt-1">
                  connected {{ fmtTs(g.created_at) }} · last used {{ fmtTs(g.last_used_at) }}
                </div>
              </div>
              <UiButton
                v-if="g.state !== 'revoked'"
                kind="ghost"
                size="sm"
                :disabled="revoking.has(g.id)"
                :data-testid="`admin-grant-revoke-${g.id}`"
                title="Revoke this connection — logs the client out (and stops emission if it's an emit grant)."
                @click="revokeGrant(g)"
              >
                <span v-if="revoking.has(g.id)">…</span>
                <span v-else>Revoke</span>
              </UiButton>
              <span v-else class="text-[11px] text-carbon-3">—</span>
            </li>
          </ul>
          <p v-else class="text-xs text-carbon-2 mt-3" data-testid="admin-grants-empty">
            No authorized connections for this teammate.
          </p>
        </template>
      </UiCard>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/grants">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
