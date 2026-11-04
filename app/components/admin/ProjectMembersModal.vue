<script setup lang="ts">
/*
 * ProjectMembersModal — manage a project's members directly from the Projects
 * table (Admin → Region → Projects), instead of having to go through the
 * allocation editor. Lists current members, searches the ENTRA DIRECTORY
 * (org-wide) so a PM/admin can add ANY person — including brand-new teammates
 * who have never logged in / don't exist as a teammate row yet — and
 * adds/removes:
 *   GET    /api/v1/admin/projects/{id}/assignments
 *   GET    /api/v1/admin/directory/search?q=…                (people picker)
 *   POST   /api/v1/admin/projects/{id}/assignments        { oid, role }
 *   PATCH  /api/v1/admin/projects/{id}/assignments/{teammateId}  { role }
 *   DELETE /api/v1/admin/projects/{id}/assignments/{teammateId}
 *
 * Directory-driven membership: the Add action passes the picked person's
 * entra_oid; the server find-or-provisions their teammate (source='directory')
 * and assigns. When a brand-new person later onboards and starts emitting /
 * accruing bill, that spend reconciles onto the project. See
 * docs/design/provider-billing-attribution-model.md §"Directory is the
 * org-placement source of truth".
 *
 * J2: members carry an assignment role — 'manager' (PM, may manage this
 * project's budget top-ups) or 'member' — plus their HOME cost-owning
 * unit; members from a CC other than the project's lead CC get a
 * cross-CC chip (normal, not an error).
 */
import { ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

interface ProjectRef {
  id: string
  code: string
  display_name: string
}
interface Member {
  teammate_id: string
  email: string
  display_name: string | null
  role: 'manager' | 'member'
  home_cou_id: string | null
  home_cou_name: string | null
  is_cross_cou: boolean
}
// A hit from the Entra directory people-picker (GET /admin/directory/search).
interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  already_member: boolean // ALREADY a teammate somewhere in TokenScope (system-wide)
  existing_region_code: string | null
  /** Teammate exists but bound to this person's OTHER Entra identity (#121) — add converges on it. */
  teammate_via_other_identity?: boolean
}

// regionId is no longer needed: the picker is org-wide (directory search) and
// placement region is the project's own, resolved server-side.
const props = defineProps<{ project: ProjectRef | null }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const members = ref<Member[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const busyId = ref<string | null>(null)

const query = ref('')
const results = ref<DirectoryHit[]>([])
const searching = ref(false)

async function loadMembers() {
  if (!props.project) return
  loading.value = true
  error.value = null
  try {
    const r = await $fetch<{ members: Member[] }>(`/api/v1/admin/projects/${props.project.id}/assignments`)
    members.value = r.members
  } catch (e: unknown) {
    error.value = errText(e, 'Failed to load members')
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
    // Org-wide Entra directory picker — surfaces ANYONE in the directory, not
    // just people who already exist as a teammate. The person is emailed
    // against current members to hide those already on this project.
    const r = await $fetch<{ results: DirectoryHit[] }>(
      `/api/v1/admin/directory/search?q=${encodeURIComponent(q)}&limit=10`,
    )
    const have = new Set(members.value.map((m) => m.email.toLowerCase()))
    results.value = (r.results ?? []).filter((h) => !have.has((h.email ?? '').toLowerCase()))
  } catch (e: unknown) {
    error.value = errText(e, 'Search failed')
  } finally {
    searching.value = false
  }
}

async function add(hit: DirectoryHit) {
  if (!props.project) return
  busyId.value = hit.oid
  error.value = null
  try {
    // Pass the entra_oid — the server find-or-provisions the teammate
    // (source='directory') and assigns in one transaction.
    await $fetch(`/api/v1/admin/projects/${props.project.id}/assignments`, {
      method: 'POST',
      body: { oid: hit.oid },
    })
    query.value = ''
    results.value = []
    await loadMembers()
    emit('changed')
  } catch (e: unknown) {
    error.value = errText(e, 'Failed to add member')
  } finally {
    busyId.value = null
  }
}

async function setRole(m: Member, role: 'manager' | 'member') {
  if (!props.project) return
  busyId.value = m.teammate_id
  error.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${props.project.id}/assignments/${m.teammate_id}`, {
      method: 'PATCH',
      body: { role },
    })
    await loadMembers()
    emit('changed')
  } catch (e: unknown) {
    error.value = errText(e, 'Failed to change role')
  } finally {
    busyId.value = null
  }
}

async function remove(m: Member) {
  if (!props.project) return
  busyId.value = m.teammate_id
  error.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${props.project.id}/assignments/${m.teammate_id}`, { method: 'DELETE' })
    await loadMembers()
    emit('changed')
  } catch (e: unknown) {
    error.value = errText(e, 'Failed to remove member')
  } finally {
    busyId.value = null
  }
}

function errText(e: unknown, fallback: string): string {
  return apiErrorDetail(e, fallback)
}

watch(
  () => props.project?.id,
  (id) => {
    query.value = ''
    results.value = []
    members.value = []
    error.value = null
    if (id) loadMembers()
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="project"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="project-members-modal"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto">
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Manage members</p>
          <h2 class="text-lg font-bold text-carbon mt-0.5">{{ project.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ project.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="members-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p v-if="error" class="text-xs text-rag-red mb-3" data-testid="members-error">{{ error }}</p>

        <!-- Add a member -->
        <label class="text-[12px] font-semibold text-carbon">Add a member</label>
        <input
          v-model="query"
          type="search"
          placeholder="Search anyone in the directory by name or email…"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="members-search"
          @input="search"
        >
        <p class="text-[11px] text-carbon-3 mt-1">
          Search the whole Entra directory — add anyone, even if they've never used TokenScope yet.
          Their spend reconciles onto this project once they onboard.
        </p>
        <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
          <li v-for="h in results" :key="h.oid" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-carbon truncate">{{ h.display_name ?? h.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">{{ h.email }}</div>
            </div>
            <span
              v-if="h.already_member"
              class="text-[10px] px-1.5 py-0.5 rounded bg-calm/60 text-carbon-2"
              :title="h.existing_region_code ? `Existing teammate (${h.existing_region_code})` : 'Existing teammate'"
            >Existing teammate</span>
            <span
              v-else-if="h.teammate_via_other_identity"
              class="text-[10px] px-1.5 py-0.5 rounded bg-calm/60 text-carbon-2"
              title="Already a teammate via their other Entra identity — adding resolves to the same person"
            >Teammate — other identity</span>
            <span
              v-else
              class="text-[10px] px-1.5 py-0.5 rounded bg-brand-harmony/15 text-brand-harmony"
              title="Not in TokenScope yet — will be added from the directory"
            >New — from directory</span>
            <UiButton kind="primary" size="sm" :disabled="busyId === h.oid" :data-testid="`members-add-${h.oid}`" @click="add(h)">
              Add
            </UiButton>
          </li>
        </ul>
        <p v-else-if="query.trim() && !searching" class="text-[12px] text-carbon-3 mt-2">No matching people in the directory.</p>

        <!-- Current members -->
        <div class="mt-5">
          <p class="text-[12px] font-semibold text-carbon">Current members ({{ members.length }})</p>
          <p v-if="loading" class="text-[12px] text-carbon-3 mt-2">Loading…</p>
          <ul v-else-if="members.length" class="mt-2 divide-y divide-calm-2" data-testid="members-list">
            <li v-for="m in members" :key="m.teammate_id" class="flex items-center gap-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-sm text-carbon truncate">{{ m.display_name ?? m.email }}</span>
                  <span
                    v-if="m.role === 'manager'"
                    class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-harmony/15 text-brand-harmony"
                    :data-testid="`members-pm-${m.teammate_id}`"
                  >PM</span>
                  <span
                    v-if="m.is_cross_cou && m.home_cou_name"
                    class="text-[10px] px-1.5 py-0.5 rounded bg-calm/60 text-carbon-2"
                    :title="`Home Business Unit: ${m.home_cou_name} (cross-CC member)`"
                  >{{ m.home_cou_name }}</span>
                </div>
                <div class="text-[11px] text-carbon-3 truncate">{{ m.email }}</div>
              </div>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="busyId === m.teammate_id"
                :data-testid="`members-role-${m.teammate_id}`"
                @click="setRole(m, m.role === 'manager' ? 'member' : 'manager')"
              >
                {{ m.role === 'manager' ? 'Demote to member' : 'Make PM' }}
              </UiButton>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="busyId === m.teammate_id"
                :data-testid="`members-remove-${m.teammate_id}`"
                @click="remove(m)"
              >
                Remove
              </UiButton>
            </li>
          </ul>
          <p v-else class="text-[12px] text-carbon-3 mt-2">No members yet — search above to add one.</p>
        </div>
      </div>
    </div>
  </div>
</template>
