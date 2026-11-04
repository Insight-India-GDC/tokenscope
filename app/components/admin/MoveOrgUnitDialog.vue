<script setup lang="ts">
/*
 * MoveOrgUnitDialog — reparent a Business Unit (org unit) and its whole subtree to
 * a different parent WITHIN THE SAME REGION. The structural move OrgUnitDialog's
 * edit mode deferred ("coming soon"). Modelled on OrgUnitDialog: role="dialog" +
 * aria-modal + aria-labelledby, Escape closes, the first field is focused on
 * open, Tab cycles within the dialog (focus trap), and the error is an aria-live
 * alert.
 *
 * The new-parent picker lists the OTHER units in the same region. There is no
 * "top level": a region's only parentless units are its `default` unit and its
 * Unplaced holding node, so a stray top-level unit is moved under `default`. The
 * unit being moved and its descendants are excluded (a descendant's `path` starts
 * with `<unit.path>.`), and so are the holding node and anything beneath it.
 * The candidate list is reused from the region tree the parent already loaded —
 * no extra fetch.
 *
 * Submit → POST /api/v1/admin/org-units/{id}/move { new_parent_id }. The inline
 * error surfaces the server's `detail` (400 cross-region / cycle, 404 not found)
 * via apiErrorDetail.
 */
import { ref, computed } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
// `#shared`, never a relative path — see the note in app/pages/admin/regions/[id].vue.
import { HOLDING_UNIT_TYPE } from '#shared/placement/holding-nodes'
import type { OrgNode } from './OrgTree.vue'

const props = defineProps<{
  node: OrgNode
  // The region's full unit list (reused from the tree — candidate parents are
  // drawn from here, no extra fetch).
  units: OrgNode[]
}>()
const emit = defineEmits<{ close: []; moved: [] }>()

const newParentId = ref<string>('')
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'move-org-unit-dialog-title'

// Pre-select the unit's current parent so the picker opens reflecting reality.
const candidates = computed<OrgNode[]>(() => {
  const descendantPrefix = `${props.node.path}.`
  const holdingPaths = props.units.filter((u) => u.unit_type === HOLDING_UNIT_TYPE).map((u) => u.path)
  return props.units.filter(
    (u) =>
      u.id !== props.node.id
      && !u.path.startsWith(descendantPrefix)
      && !holdingPaths.some((h) => u.path === h || u.path.startsWith(`${h}.`)),
  )
})

function seedForm() {
  newParentId.value = props.node.parent_id ?? ''
  error.value = null
}

// This component renders only when opened (parent v-if), so it is mounted in the
// "open" state and unmounted to close — isOpen is constantly true while mounted.
// Seeding once on mount (via onOpen) matches OrgUnitDialog.
useModalA11y({
  isOpen: () => true,
  dialogEl,
  firstField,
  onClose: () => emit('close'),
  onOpen: seedForm,
})

// The unit's current parent label for the "Currently under" read-only line.
function currentParentLabel(): string {
  if (!props.node.parent_id) return 'The top of the region'
  const p = props.units.find((n) => n.id === props.node.parent_id)
  return p ? `${p.display_name} (${p.code})` : props.node.parent_id
}

async function move() {
  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/admin/org-units/${props.node.id}/move`, {
      method: 'POST',
      body: { new_parent_id: newParentId.value },
    })
    emit('moved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Move failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="move-org-unit-dialog-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      data-testid="move-org-unit-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Move Business Unit</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">{{ node.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded font-mono" data-testid="move-current-path">{{ node.path }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="mou-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <!-- Current parent (read-only context) -->
        <div class="text-[12px] font-semibold text-carbon">Currently under</div>
        <div class="mt-1 mb-3 px-3 py-2 text-sm text-carbon-2 bg-calm/40 rounded-md" data-testid="move-current-parent">
          {{ currentParentLabel() }}
        </div>

        <!-- New parent -->
        <label for="mou-parent" class="text-[12px] font-semibold text-carbon">New parent</label>
        <select
          id="mou-parent"
          ref="firstField"
          v-model="newParentId"
          class="mt-1 mb-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="move-parent-select"
        >
          <option value="" disabled>Choose a parent</option>
          <option v-for="p in candidates" :key="p.id" :value="p.id">
            {{ '— '.repeat(p.depth) }}{{ p.display_name }} ({{ p.code }})
          </option>
        </select>
        <p class="text-[11px] text-carbon-3 mb-2">
          Moves this unit and everything under it. Same region only — the unit itself and its
          descendants are excluded.
        </p>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="mou-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="mou-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="saving || !newParentId" data-testid="move-submit" @click="move">
            {{ saving ? 'Moving…' : 'Move' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
