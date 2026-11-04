<script setup lang="ts">
/*
 * AddTeammateDialog — directory-based teammate provisioning for Admin → Users.
 *
 * Flow: debounced search of the Entra directory
 *   (GET /api/v1/admin/directory/search?q=) → pick a person → place them
 *   (org unit + role) → POST /api/v1/admin/teammates. Directory hits already a
 *   teammate are shown disabled with the region they already live in.
 *
 * Region admins may only grant region-scoped roles
 * (developer/manager/admin/finance); the org-wide grant (
 * platform-admin) are hidden unless the caller is themselves org-wide.
 *
 * Accessibility mirrors TagSessionDialog: role="dialog" + aria-modal +
 * aria-labelledby, Escape closes, first field focused on open, focus trap,
 * error as aria-live alert.
 */
import { ref, onBeforeUnmount, computed, type Ref } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import UiAuxFetchError from '../ui/AuxFetchError.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
import { SELECTABLE_ROLES, roleLabel, type Role } from '#shared/auth/roles'
import { BU_LABEL } from '#shared/reports/vocabulary'

interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  department: string | null
  job_title: string | null
  // J4: Entra employeeOrgData — placement SUGGESTION (shown next to the
  // org-unit picker), never auto-applied.
  cost_center: string | null
  division: string | null
  already_member: boolean
  existing_region_code: string | null
  /** Teammate exists but bound to this person's OTHER Entra identity (#121). */
  teammate_via_other_identity?: boolean
}

const props = defineProps<{
  regionId: string
  orgUnits: { id: string; display_name: string }[]
  /*
   * The caller's org-units read failed. An empty picker over a failed read is
   * the false empty D2 forbids (admin-nav-responsiveness.md): the submit is
   * gated on a unit, so without this the dialog is simply unusable and silent
   * about why.
   */
  orgUnitsError?: unknown
  open: boolean
  callerRole: string
}>()
const emit = defineEmits<{ close: []; added: []; retryOrgUnits: [] }>()

const query = ref('')
const results = ref<DirectoryHit[]>([])
const searching = ref(false)
const selected = ref<DirectoryHit | null>(null)

const orgUnitId = ref('')
const role = ref<Role>('developer')

const submitting = ref(false)
const error = ref<string | null>(null)

const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'add-teammate-title'
let searchTimer: ReturnType<typeof setTimeout> | null = null

// Region admins can only grant region-scoped roles; org-wide grants are gated.
const callerIsOrgWide = computed(
  () => props.callerRole === 'platform-admin',
)
const grantableRoles = computed<Role[]>(() =>
  callerIsOrgWide.value
    ? [...SELECTABLE_ROLES]
    : SELECTABLE_ROLES.filter((r) => r !== 'platform-admin'),
)

// Shared dialog a11y; onOpen resets the search/placement form on each open.
useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    query.value = ''
    results.value = []
    selected.value = null
    orgUnitId.value = ''
    role.value = 'developer'
    error.value = null
  },
})
// The debounced-search timer is owned by this component, not the a11y contract.
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 300)
}

async function runSearch() {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const r = await $fetch<{ results: DirectoryHit[] }>(
      `/api/v1/admin/directory/search?q=${encodeURIComponent(q)}&limit=15`,
    )
    results.value = r.results ?? []
  } catch (e: unknown) {
    error.value = errText(e, 'Directory search failed')
    consola.warn('directory search failed', e)
  } finally {
    searching.value = false
  }
}

function pick(hit: DirectoryHit) {
  // teammate_via_other_identity: the person's teammate row exists under their
  // OTHER Entra oid (#121) — provisioning this identity would 409; the row is
  // managed from the Users table like any existing teammate.
  if (hit.already_member || hit.teammate_via_other_identity) return
  selected.value = hit
  error.value = null
}

function clearSelection() {
  selected.value = null
  error.value = null
}

const canSubmit = computed(
  () => !submitting.value && !!selected.value && !!orgUnitId.value && !!role.value && !!props.regionId,
)

async function submit() {
  if (!canSubmit.value || !selected.value) return
  submitting.value = true
  error.value = null
  try {
    await $fetch('/api/v1/admin/teammates', {
      method: 'POST',
      body: {
        oid: selected.value.oid,
        region_id: props.regionId,
        org_unit_id: orgUnitId.value,
        role: role.value,
      },
    })
    emit('added')
  } catch (e: unknown) {
    error.value = errText(e, 'Could not add teammate')
    consola.warn('add teammate failed', e)
  } finally {
    submitting.value = false
  }
}

function errText(e: unknown, fallback: string): string {
  return apiErrorDetail(e, fallback)
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="add-teammate-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Provision teammate</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">Add teammate from directory</h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="add-teammate-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <!-- Step 1: directory search -->
        <template v-if="!selected">
          <label for="at-search" class="text-[12px] font-semibold text-carbon">Search the directory</label>
          <input
            id="at-search"
            ref="firstField"
            v-model="query"
            type="search"
            placeholder="Search by name or email…"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="at-search"
            @input="onSearchInput"
          >
          <p class="text-[11px] text-carbon-3 mt-1">
            Pick a person to place them into this region. Existing teammates are shown disabled.
          </p>

          <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
            <li
              v-for="hit in results"
              :key="hit.oid"
              class="flex items-center gap-3 px-3 py-2"
              :class="hit.already_member || hit.teammate_via_other_identity ? 'opacity-60' : ''"
            >
              <div class="min-w-0 flex-1">
                <div class="text-sm text-carbon truncate">{{ hit.display_name ?? hit.email }}</div>
                <div class="text-[11px] text-carbon-3 truncate">
                  {{ hit.email }}<span v-if="hit.department"> · {{ hit.department }}</span>
                </div>
                <div v-if="hit.already_member" class="text-[11px] text-brand-hunger mt-0.5">
                  Already in {{ hit.existing_region_code ?? 'another region' }}
                </div>
                <div v-else-if="hit.teammate_via_other_identity" class="text-[11px] text-brand-hunger mt-0.5">
                  Already a teammate via their other Entra identity — manage them from the Users table
                </div>
              </div>
              <UiButton
                kind="primary"
                size="sm"
                :disabled="hit.already_member || hit.teammate_via_other_identity"
                :data-testid="`at-result-${hit.oid}`"
                @click="pick(hit)"
              >
                {{ hit.already_member || hit.teammate_via_other_identity ? 'In use' : 'Select' }}
              </UiButton>
            </li>
          </ul>
          <p v-else-if="query.trim() && !searching" class="text-[12px] text-carbon-3 mt-2">
            No matching people in the directory.
          </p>
          <p v-else-if="searching" class="text-[12px] text-carbon-3 mt-2">Searching…</p>
        </template>

        <!-- Step 2: placement -->
        <template v-else>
          <div class="flex items-start justify-between gap-3 mb-4 p-3 rounded-md bg-brand-harmony-sheer/40 border border-brand-harmony/20">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-carbon truncate">{{ selected.display_name ?? selected.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">
                {{ selected.email }}<span v-if="selected.job_title"> · {{ selected.job_title }}</span>
              </div>
            </div>
            <UiButton kind="ghost" size="sm" data-testid="at-change" @click="clearSelection">Change</UiButton>
          </div>

          <label for="at-orgunit" class="text-[12px] font-semibold text-carbon">Business Unit placement</label>
          <p
            v-if="selected.cost_center || selected.department"
            class="text-[11px] text-carbon-3 mt-0.5"
            data-testid="at-placement-hint"
          >
            Directory suggests:
            <template v-if="selected.cost_center">{{ selected.cost_center }}</template>
            <template v-if="selected.cost_center && selected.department"> · </template>
            <template v-if="selected.department">{{ selected.department }}</template>
            <span class="italic"> (Entra hint — pick the matching unit below)</span>
          </p>
          <div class="mt-1 mb-3">
            <select
              id="at-orgunit"
              v-model="orgUnitId"
              :disabled="!!orgUnitsError"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/40 disabled:cursor-not-allowed"
              data-testid="at-orgunit"
            >
              <option value="" disabled>Select an org unit…</option>
              <option v-for="u in orgUnits" :key="u.id" :value="u.id">{{ u.display_name }}</option>
            </select>
            <UiAuxFetchError
              :error="orgUnitsError"
              :label="`${BU_LABEL}s`"
              testid="at-orgunit-error"
              @retry="emit('retryOrgUnits')"
            />
          </div>

          <label for="at-role" class="text-[12px] font-semibold text-carbon">Role</label>
          <select
            id="at-role"
            v-model="role"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
            data-testid="at-role"
          >
            <option v-for="r in grantableRoles" :key="r" :value="r">{{ roleLabel(r) }}</option>
          </select>

          <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="add-teammate-error" role="alert">{{ error }}</p>

          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="add-teammate-cancel" @click="emit('close')">Cancel</UiButton>
            <UiButton kind="primary" :disabled="!canSubmit" data-testid="at-submit" @click="submit">
              {{ submitting ? 'Adding…' : 'Add teammate' }}
            </UiButton>
          </div>
        </template>

        <p
          v-if="error && !selected"
          class="text-xs text-rag-red mt-3"
          data-testid="add-teammate-error"
          role="alert"
        >{{ error }}</p>
      </div>
    </div>
  </div>
</template>
