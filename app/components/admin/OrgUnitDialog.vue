<script setup lang="ts">
/*
 * OrgUnitDialog — accessible create / edit editor for a region's Business Unit
 * (org-unit) tree. Modelled on TagSessionDialog: role="dialog" + aria-modal +
 * aria-labelledby, Escape closes, the first field is focused on open, Tab cycles
 * within the dialog (focus trap), and the error is an aria-live alert.
 *
 * Create mode: parent, code, display_name, unit_type, is_cost_owning_unit →
 * POST /api/v1/admin/org-units. The parent defaults to the region's `default`
 * unit and there is no root option; the holding node and anything under it are
 * not offered. A new unit defaults to a cost-owning Business Unit so it can take
 * an owner straight away.
 * Edit mode: code, display_name, unit_type, is_cost_owning_unit →
 * PATCH /api/v1/admin/org-units/{id}. The parent is changed with Move; the
 * `default` unit's and the holding node's codes are fixed.
 *
 * The inline error surfaces `err.data.data.detail` (409 dup, 422 bad parent).
 */
import { computed, ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
// `#shared`, never a relative path — see the note in app/pages/admin/regions/[id].vue.
import { HOLDING_UNIT_TYPE } from '#shared/placement/holding-nodes'
import type { OrgNode } from './OrgTree.vue'

const props = defineProps<{
  mode: 'create' | 'edit'
  regionId: string
  node?: OrgNode | null
  parents: OrgNode[]
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const parentId = ref<string>('')
const code = ref('')
const displayName = ref('')
const unitType = ref('bu')
const isCou = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'org-unit-dialog-title'

const UNIT_TYPES = ['bu', 'practice', 'team']

/*
 * The per-region Unplaced node. Editing it must NOT offer the cost-owning
 * toggle: it is the one control on that screen that moves the unplaced count,
 * and it moves it to zero by homing everyone's spend to a bucket nobody owns
 * (server/db/org-units.ts holds the enforcing rule — this only removes the
 * accident). Keyed on unit_type, the classification key, so a second holding
 * node under another code is covered too.
 *
 * Create mode can never be a holding node: the type select offers bu/practice/
 * team only.
 */
const isHoldingNode = computed(
  () => props.mode === 'edit' && props.node?.unit_type === HOLDING_UNIT_TYPE,
)

const isDefaultUnit = (n: OrgNode) => n.code === 'default' && !n.parent_id

const codeLocked = computed(
  () => props.mode === 'edit' && !!props.node && (isDefaultUnit(props.node) || props.node.unit_type === HOLDING_UNIT_TYPE),
)

const parentOptions = computed<OrgNode[]>(() => {
  const holdingPaths = props.parents.filter((u) => u.unit_type === HOLDING_UNIT_TYPE).map((u) => u.path)
  return props.parents.filter((u) => !holdingPaths.some((h) => u.path === h || u.path.startsWith(`${h}.`)))
})

function seedForm() {
  if (props.mode === 'edit' && props.node) {
    parentId.value = props.node.parent_id ?? ''
    code.value = props.node.code
    displayName.value = props.node.display_name
    unitType.value = props.node.unit_type
    isCou.value = props.node.is_cost_owning_unit
  } else {
    parentId.value = props.parents.find(isDefaultUnit)?.id ?? ''
    code.value = ''
    displayName.value = ''
    unitType.value = 'bu'
    isCou.value = true
  }
  error.value = null
}

// This component renders only when opened (parent v-if), so it is mounted in
// the "open" state and unmounted to close. isOpen is therefore constantly true
// while mounted; the parent's modal overlay prevents switching mode/node on a
// live instance, so seeding once on mount (via onOpen) matches prior behaviour.
useModalA11y({
  isOpen: () => true,
  dialogEl,
  firstField,
  onClose: () => emit('close'),
  onOpen: seedForm,
})

// The parent display name for the read-only line in edit mode.
function parentLabel(): string {
  if (!props.node?.parent_id) return 'The top of the region'
  const p = props.parents.find((n) => n.id === props.node?.parent_id)
  return p ? `${p.display_name} (${p.code})` : props.node.parent_id
}

async function save() {
  saving.value = true
  error.value = null
  try {
    if (props.mode === 'create') {
      await $fetch('/api/v1/admin/org-units', {
        method: 'POST',
        body: {
          region_id: props.regionId,
          parent_id: parentId.value || null,
          code: code.value.trim(),
          display_name: displayName.value.trim(),
          unit_type: unitType.value.trim(),
          is_cost_owning_unit: isCou.value,
        },
      })
    } else if (props.node) {
      await $fetch(`/api/v1/admin/org-units/${props.node.id}`, {
        method: 'PATCH',
        body: {
          ...(code.value.trim() !== props.node.code ? { code: code.value.trim() } : {}),
          display_name: displayName.value.trim(),
          unit_type: unitType.value.trim(),
          is_cost_owning_unit: isCou.value,
        },
      })
    }
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Save failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="org-unit-dialog-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      data-testid="org-unit-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
            {{ mode === 'create' ? 'New Business Unit' : 'Edit Business Unit' }}
          </p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ mode === 'create' ? 'Add a Business Unit' : displayName }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="oud-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <!-- Parent -->
        <template v-if="mode === 'create'">
          <label for="oud-parent" class="text-[12px] font-semibold text-carbon">Parent</label>
          <select
            id="oud-parent"
            ref="firstField"
            v-model="parentId"
            class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
            data-testid="oud-parent"
          >
            <option value="" disabled>Choose a parent</option>
            <option v-for="p in parentOptions" :key="p.id" :value="p.id">
              {{ '— '.repeat(p.depth) }}{{ p.display_name }} ({{ p.code }})
            </option>
          </select>
        </template>
        <template v-else>
          <div class="text-[12px] font-semibold text-carbon">Parent</div>
          <div class="mt-1 mb-3 px-3 py-2 text-sm text-carbon-2 bg-calm/40 rounded-md" data-testid="oud-parent-readonly">
            {{ parentLabel() }}
            <span class="block text-[11px] text-carbon-3 mt-0.5">To re-parent this unit, use the Move action on its row.</span>
          </div>
        </template>

        <!-- Code -->
        <label for="oud-code" class="text-[12px] font-semibold text-carbon">Code</label>
        <input
          v-if="!codeLocked"
          id="oud-code"
          v-model="code"
          placeholder="e.g. apac-eng-platform"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white font-mono focus:border-brand-harmony"
          data-testid="oud-code"
        >
        <div
          v-else
          class="mt-1 mb-3 px-3 py-2 text-sm font-mono text-carbon-2 bg-calm/40 rounded-md"
          data-testid="oud-code-readonly"
        >
          {{ code }}
        </div>

        <!-- Display name -->
        <label for="oud-name" class="text-[12px] font-semibold text-carbon">Display name</label>
        <input
          id="oud-name"
          :ref="(el) => { if (mode === 'edit') firstField = el as HTMLElement | null }"
          v-model="displayName"
          placeholder="e.g. Platform Engineering"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="oud-name"
        >

        <!-- Unit type. Read-only on a holding node: its type IS its identity —
             every reader classifies "not a real placement" on it, and the type
             select does not offer it, so a live select would silently re-type the
             node the first time the field was touched. -->
        <label for="oud-type" class="text-[12px] font-semibold text-carbon">Unit type</label>
        <select
          v-if="!isHoldingNode"
          id="oud-type"
          v-model="unitType"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="oud-type"
        >
          <option v-for="t in UNIT_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
        <div
          v-else
          class="mt-1 mb-3 px-3 py-2 text-sm text-carbon-2 bg-calm/40 rounded-md"
          data-testid="oud-type-readonly"
        >
          {{ unitType }}
        </div>

        <!-- Cost-owning unit. NOT offered on a holding node — see isHoldingNode. -->
        <template v-if="!isHoldingNode">
          <label class="flex items-center gap-2 text-[12px] font-semibold text-carbon mb-1 cursor-pointer">
            <input
              v-model="isCou"
              type="checkbox"
              class="w-4 h-4 accent-brand-harmony"
              data-testid="oud-cou"
            >
            Business Unit (a P&amp;L node)
          </label>
          <p class="text-[11px] text-carbon-3 mb-2">Projects bill to the nearest Business Unit above them.</p>
        </template>
        <div
          v-else
          class="mt-1 mb-2 p-3 rounded-md bg-brand-vision-lite/60 border border-brand-vision/30 text-[11px] text-brand-vision-ink leading-relaxed"
          data-testid="oud-holding-note"
        >
          <span class="font-bold">This is the holding node for teammates with no Business Unit.</span>
          It cannot be made a Business Unit: that would home every unplaced teammate's
          spend to a bucket nobody owns, dropping the unhomed figure to zero
          without placing a single person. Place them into real Business Units from
          the Teammates tab instead.
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="oud-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="oud-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="saving || (mode === 'create' && !parentId)" data-testid="oud-submit" @click="save">
            {{ saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
