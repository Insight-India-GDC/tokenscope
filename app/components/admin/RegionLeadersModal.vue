<script setup lang="ts">
/*
 * RegionLeadersModal — assign / revoke region leaders from the region
 * detail page (region derivation, mig 0068). Mirrors CouOwnersModal, but
 * the picker is the Entra directory people-picker (a leader can be anyone
 * in the org chart — the manager-walk target), not the region's teammates:
 *   GET    …/admin/regions/{id}/leaders
 *   POST   …/admin/regions/{id}/leaders        { leader_oid, leader_email, kind, display_name? }
 *   DELETE …/admin/regions/{id}/leaders/{leaderId}
 *
 * A leader is the fallback target for placing unplaced users: an unplaced
 * user's manager chain is walked up to the nearest leader, and that leader's
 * region homes them. Soft-revoke keeps history; re-assignment is a new row.
 * Writes are platform-admin only; region admins get the list read-only.
 */
import { ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

interface Leader {
  id: string
  leader_oid: string
  leader_email: string
  kind: 'region-svp' | 'shared-function-global'
  display_name: string | null
}
interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  department: string | null
  job_title: string | null
}

const props = defineProps<{ regionId: string | null; regionName: string; regionCode: string; readOnly?: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const leaders = ref<Leader[]>([])
const error = ref<string | null>(null)
const busyId = ref<string | null>(null)
const loading = ref(false)

const query = ref('')
const results = ref<DirectoryHit[]>([])
const searching = ref(false)
const kind = ref<'region-svp' | 'shared-function-global'>('region-svp')

async function load() {
  if (!props.regionId) return
  loading.value = true
  error.value = null
  try {
    const r = await $fetch<{ leaders: Leader[] }>(`/api/v1/admin/regions/${encodeURIComponent(props.regionId)}/leaders`)
    leaders.value = r.leaders ?? []
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to load leaders')
  } finally {
    loading.value = false
  }
}

async function search() {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const r = await $fetch<{ results: DirectoryHit[] }>(
      `/api/v1/admin/directory/search?q=${encodeURIComponent(q)}&limit=10`,
    )
    const have = new Set(leaders.value.map((l) => l.leader_oid))
    results.value = (r.results ?? []).filter((h) => !have.has(h.oid))
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Directory search failed')
  } finally {
    searching.value = false
  }
}

async function assign(h: DirectoryHit) {
  if (!props.regionId) return
  busyId.value = h.oid
  error.value = null
  try {
    const created = await $fetch<Leader>(`/api/v1/admin/regions/${encodeURIComponent(props.regionId)}/leaders`, {
      method: 'POST',
      body: {
        leader_oid: h.oid,
        leader_email: h.email,
        kind: kind.value,
        display_name: h.display_name ?? undefined,
      },
    })
    leaders.value = [...leaders.value, created]
    query.value = ''
    results.value = []
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to assign leader')
  } finally {
    busyId.value = null
  }
}

async function revoke(l: Leader) {
  if (!props.regionId) return
  busyId.value = l.id
  error.value = null
  try {
    await $fetch(`/api/v1/admin/regions/${encodeURIComponent(props.regionId)}/leaders/${encodeURIComponent(l.id)}`, { method: 'DELETE' })
    leaders.value = leaders.value.filter((x) => x.id !== l.id)
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to revoke leader')
  } finally {
    busyId.value = null
  }
}

watch(
  () => props.regionId,
  () => {
    leaders.value = []
    query.value = ''
    results.value = []
    error.value = null
    kind.value = 'region-svp'
    if (props.regionId) load()
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="regionId"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="region-leaders-modal"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto">
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Region leaders</p>
          <h2 class="text-lg font-bold text-carbon mt-0.5">{{ regionName }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ regionCode }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="region-leaders-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p v-if="error" class="text-xs text-rag-red mb-3" data-testid="region-leaders-error">{{ error }}</p>

        <p v-if="readOnly" class="text-[12px] text-carbon-3" data-testid="region-leaders-readonly">
          Region leaders are set by an Admin.
        </p>
        <template v-else>
        <label class="text-[12px] font-semibold text-carbon">Add a leader</label>
        <!-- C8a: what this role does AND, just as importantly, what it does not.
             A region leader looks like it should be enough to place people; it
             never is, and an admin who does not know that concludes placement is
             broken rather than unconfigured. -->
        <p class="text-[11px] text-carbon-3 mt-1 mb-2 leading-relaxed">
          Unplaced users whose manager chain reaches a leader are homed in that
          leader's <strong>region</strong>.
          <span class="block mt-1 text-carbon-2">
            <span class="font-bold">Sets the region only. Does not place anyone into a
            Business Unit</span> — their spend still reaches the region and stops there. To
            place people, assign a <em>Business Unit owner</em> on the Business Units tab, or
            place them directly from Teammates.
          </span>
        </p>
        <div class="flex gap-2">
          <input
            v-model="query"
            type="search"
            placeholder="Search the directory by name or email…"
            class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="region-leaders-search"
            @input="search"
          >
          <select
            v-model="kind"
            class="px-2 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
            data-testid="region-leaders-kind"
            title="Region SVP — a geographic leader. Shared-function global — IT/HR-style global function."
          >
            <option value="region-svp">Region SVP</option>
            <option value="shared-function-global">Shared function (global)</option>
          </select>
        </div>
        <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
          <li v-for="h in results" :key="h.oid" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-carbon truncate">{{ h.display_name ?? h.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">
                {{ h.email }}<span v-if="h.department"> · {{ h.department }}</span>
              </div>
            </div>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="busyId === h.oid"
              :data-testid="`region-leaders-assign-${h.oid}`"
              @click="assign(h)"
            >
              Add
            </UiButton>
          </li>
        </ul>
        <p v-else-if="query.trim() && !searching" class="text-[12px] text-carbon-3 mt-2">No matching people.</p>
        </template>

        <div class="mt-5">
          <p class="text-[12px] font-semibold text-carbon">Current leaders ({{ leaders.length }})</p>
          <ul v-if="leaders.length" class="mt-2 divide-y divide-calm-2" data-testid="region-leaders-list">
            <li v-for="l in leaders" :key="l.id" class="flex items-center gap-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="text-sm text-carbon truncate">{{ l.display_name ?? l.leader_email }}</div>
                <div class="text-[11px] text-carbon-3 truncate">
                  {{ l.leader_email }} ·
                  <span class="font-semibold">{{ l.kind === 'region-svp' ? 'Region SVP' : 'Shared function' }}</span>
                </div>
              </div>
              <UiButton
                v-if="!readOnly"
                kind="ghost"
                size="sm"
                :disabled="busyId === l.id"
                :data-testid="`region-leaders-revoke-${l.id}`"
                @click="revoke(l)"
              >
                Revoke
              </UiButton>
            </li>
          </ul>
          <p v-else-if="!loading" class="text-[12px] text-carbon-3 mt-2">
            No leaders yet — unplaced users in this region rely on the department map only.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
