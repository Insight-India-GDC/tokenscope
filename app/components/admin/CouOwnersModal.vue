<script setup lang="ts">
/*
 * CouOwnersModal — assign / revoke Business Unit owners from the region
 * page's Business Units tab (J4, mig 0048). Mirrors ProjectMembersModal:
 *   GET    …/admin/org-units?region={id}        (owners ride the tree payload)
 *   POST   …/admin/org-units/{id}/owners        { teammate_id }
 *   DELETE …/admin/org-units/{id}/owners/{teammateId}
 *
 * The owner is typically 2-3 levels removed from the unit in the org chart and
 * may not have signed in yet — so the picker searches the Entra DIRECTORY (the
 * same people-picker as region leaders), not just existing teammates. Assigning a
 * directory person who isn't a teammate find-or-provisions them server-side;
 * only a platform admin may do that (a region admin gets the server's 403 detail).
 * Ownership grants the P&L view (/cost-centres); it does not change their role.
 */
import { ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

interface CouOwner {
  teammate_id: string
  display_name: string | null
  email: string
  /*
   * C8b/C8c — whether the manager-chain walk can actually USE this owner, from
   * the walk's own condition (server/api/v1/admin/org-units.get.ts). 'ambiguous'
   * is the case that places NOBODY while looking identical to one that works.
   */
  placement_status?: 'resolves' | 'ambiguous' | 'inert'
  owns_unit_count?: number
  places_count?: number
}
interface CouRef {
  id: string
  code: string
  display_name: string
  owners: CouOwner[]
}
interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  department?: string | null
  already_member?: boolean
  /** Teammate exists but bound to this person's OTHER Entra identity (#121) — assign converges on it. */
  teammate_via_other_identity?: boolean
}

const props = defineProps<{ cou: CouRef | null; regionId: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const owners = ref<CouOwner[]>([])
const error = ref<string | null>(null)
const busyId = ref<string | null>(null)

const query = ref('')
const results = ref<DirectoryHit[]>([])
const searching = ref(false)

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
    results.value = r.results ?? []
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Directory search failed')
  } finally {
    searching.value = false
  }
}

async function assign(t: DirectoryHit) {
  if (!props.cou) return
  busyId.value = t.oid
  error.value = null
  try {
    const r = await $fetch<{ teammate_id: string; email: string; display_name: string | null }>(
      `/api/v1/admin/org-units/${props.cou.id}/owners`,
      { method: 'POST', body: { oid: t.oid } },
    )
    owners.value = [...owners.value, { teammate_id: r.teammate_id, display_name: r.display_name, email: r.email }]
    query.value = ''
    results.value = []
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to assign owner')
  } finally {
    busyId.value = null
  }
}

async function revoke(o: CouOwner) {
  if (!props.cou) return
  busyId.value = o.teammate_id
  error.value = null
  try {
    await $fetch(`/api/v1/admin/org-units/${props.cou.id}/owners/${o.teammate_id}`, {
      method: 'DELETE',
    })
    owners.value = owners.value.filter((x) => x.teammate_id !== o.teammate_id)
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to revoke owner')
  } finally {
    busyId.value = null
  }
}

// Re-seed on the OWNERS array too, not just the unit id: assign/revoke emit
// `changed`, the parent refetches the tree, and the refreshed rows are the only
// place the C8b/C8c diagnostics come from. Watching the id alone would leave an
// owner just assigned showing no placement status until the modal was reopened.
watch(
  () => props.cou?.owners,
  () => { owners.value = props.cou?.owners ? [...props.cou.owners] : [] },
  { immediate: true },
)
// The search box is per-UNIT state, so it resets only when the unit changes.
watch(
  () => props.cou?.id,
  () => {
    query.value = ''
    results.value = []
    error.value = null
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="cou"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="cou-owners-modal"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto">
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Business Unit owners</p>
          <h2 class="text-lg font-bold text-carbon mt-0.5">{{ cou.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ cou.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="cou-owners-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p v-if="error" class="text-xs text-rag-red mb-3" data-testid="cou-owners-error">{{ error }}</p>

        <label class="text-[12px] font-semibold text-carbon">Assign an owner</label>
        <input
          v-model="query"
          type="search"
          placeholder="Search the directory by name or email…"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="cou-owners-search"
          @input="search"
        >
        <!-- C8a: say what the role DOES, at the point of use. Without this,
             configuring a Region leader looks like it should be sufficient for
             placement, and it never is. -->
        <p class="text-[11px] text-carbon-3 mt-1 leading-relaxed">
          <span class="font-bold text-carbon-2">People whose manager chain reaches this
          owner are placed into this Business Unit.</span>
          Owners also get the P&amp;L view of its projects — their role is unchanged.
          <span class="block mt-1">
            This is different from a <em>Region leader</em>, which sets the region only
            and places nobody into a Business Unit.
          </span>
        </p>
        <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
          <li v-for="t in results" :key="t.oid" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-carbon truncate">
                {{ t.display_name ?? t.email }}
                <span v-if="t.already_member" class="text-[10px] text-brand-harmony font-semibold ml-1">· teammate</span>
                <span
                  v-else-if="t.teammate_via_other_identity"
                  class="text-[10px] text-brand-harmony font-semibold ml-1"
                  title="Already a teammate via their other Entra identity — assigning resolves to the same person"
                >· teammate (other identity)</span>
              </div>
              <div class="text-[11px] text-carbon-3 truncate">{{ t.email }}<span v-if="t.department"> · {{ t.department }}</span></div>
            </div>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="busyId === t.oid"
              :data-testid="`cou-owners-assign-${t.oid}`"
              @click="assign(t)"
            >
              Assign
            </UiButton>
          </li>
        </ul>
        <p v-else-if="query.trim() && !searching" class="text-[12px] text-carbon-3 mt-2">No matching people.</p>

        <div class="mt-5">
          <p class="text-[12px] font-semibold text-carbon">Current owners ({{ owners.length }})</p>
          <ul v-if="owners.length" class="mt-2 divide-y divide-calm-2" data-testid="cou-owners-list">
            <li v-for="o in owners" :key="o.teammate_id" class="flex items-center gap-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="text-sm text-carbon truncate">{{ o.display_name ?? o.email }}</div>
                <div class="text-[11px] text-carbon-3 truncate">{{ o.email }}</div>
                <!-- C8b: the owner the walk skips. Stated as the CONSEQUENCE
                     ("places nobody"), not as a category, because the category
                     is not what an admin needs to know. -->
                <div
                  v-if="o.placement_status === 'ambiguous'"
                  class="text-[11px] text-rag-amber leading-relaxed mt-0.5"
                  :data-testid="`cou-owner-ambiguous-${o.teammate_id}`"
                >
                  ⚠ Places nobody. This person owns {{ o.owns_unit_count }} active
                  Business Units, so the manager-chain walk cannot tell which one a report
                  belongs to — it skips them entirely, on every unit they own. Leave
                  them on one Business Unit only, or place their people directly.
                </div>
                <div
                  v-else-if="o.placement_status === 'inert'"
                  class="text-[11px] text-carbon-3 leading-relaxed mt-0.5"
                  :data-testid="`cou-owner-inert-${o.teammate_id}`"
                >
                  Places nobody automatically — this owner has no directory identity the
                  manager chain can match, so they hold the P&amp;L view only.
                </div>
                <!-- C8c: realised reach, and the label has to say which one it is.
                     "Currently places N" reads as a live statement about today's
                     manager chain. It is not: the number counts the placement
                     PROVENANCE stored on each teammate, written by whichever walk
                     placed them. Nothing re-derives it — a bill identity that never
                     signs in is never re-walked — so an obsolete count persists
                     indefinitely and looks current. Name the basis. -->
                <div
                  v-else-if="o.placement_status === 'resolves'"
                  class="text-[11px] text-carbon-2 mt-0.5"
                  :data-testid="`cou-owner-places-${o.teammate_id}`"
                >
                  {{ o.places_count ?? 0 }} recorded
                  {{ (o.places_count ?? 0) === 1 ? 'placement' : 'placements' }} into this
                  Business Unit name this owner.
                  <span class="block text-carbon-3">
                    Placements already made, not a re-derivation against today's manager
                    chain — if the chain has since changed, this count has not.
                  </span>
                </div>
              </div>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="busyId === o.teammate_id"
                :data-testid="`cou-owners-revoke-${o.teammate_id}`"
                @click="revoke(o)"
              >
                Revoke
              </UiButton>
            </li>
          </ul>
          <p v-else class="text-[12px] text-carbon-3 mt-2">
            No owners yet — this Business Unit's projects have no P&L viewer.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
