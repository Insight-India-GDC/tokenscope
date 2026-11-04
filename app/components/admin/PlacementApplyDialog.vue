<script setup lang="ts">
/*
 * PlacementApplyDialog: confirm and apply the selected placement-check rows.
 * POST /api/v1/admin/placement-check/apply.
 *
 * Says how many move region (signed out of the web app, as a region move is)
 * versus Business Unit. Rows an admin placed by hand need a second, explicit
 * confirmation. After the call it lists every row's outcome and stays open;
 * the parent refetches on `applied`.
 */
import { computed, ref, type ComponentPublicInstance } from 'vue'
import UiButton from '../ui/Button.vue'
import { mutationErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import type { PlacementApplyResponse, PlacementCheckRow } from '#shared/placement/placement-check'
import { applyPlacementInBatches } from '../../utils/placement-apply'
import { BU_LABEL } from '#shared/reports/vocabulary'
import {
  PLACEMENT_REFUSAL_TEXT,
  buildPlacementApplyItems,
  movesRegion,
  placementHomeText,
} from '../../utils/placement-check-view'

const props = defineProps<{ open: boolean; rows: PlacementCheckRow[] }>()
const emit = defineEmits<{ close: []; applied: [res: PlacementApplyResponse] }>()

const confirmManual = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const result = ref<PlacementApplyResponse | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const cancelBtn = ref<ComponentPublicInstance | null>(null)

useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: cancelBtn,
  onClose: () => emit('close'),
  onOpen: () => {
    confirmManual.value = false
    error.value = null
    result.value = null
  },
})

const regionMoves = computed(() => props.rows.filter(movesRegion).length)
const unitMoves = computed(() => props.rows.length - regionMoves.value)
const manualRows = computed(() => props.rows.filter((r) => r.verdict === 'manual'))
const canSubmit = computed(
  () => !saving.value && props.rows.length > 0 && (manualRows.value.length === 0 || confirmManual.value),
)

const byId = computed(() => new Map(props.rows.map((r) => [r.teammateId, r])))
function labelFor(id: string): string {
  const r = byId.value.get(id)
  return r ? (r.name ?? r.email) : id
}
const moved = computed(() => result.value?.results.filter((r) => r.outcome === 'moved').length ?? 0)
const refused = computed(() => result.value?.results.filter((r) => r.outcome === 'refused').length ?? 0)

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const { done, error: e } = await applyPlacementInBatches(buildPlacementApplyItems(props.rows, confirmManual.value))
  if (e) {
    // "Not changed" only when the server refused the batch; otherwise it may have landed.
    error.value = done.results.length
      ? mutationErrorDetail(
          e,
          `Apply stopped after ${done.results.length}; the rest were not changed.`,
          `Apply stopped after ${done.results.length}. We could not tell whether the next batch was applied: reload the placement check to see where everyone is now.`,
        )
      : mutationErrorDetail(
          e,
          'Apply failed. Nothing was changed.',
          'We could not tell whether the apply went through. Reload the placement check to see where everyone is now before applying again.',
        )
  }
  saving.value = false
  if (done.results.length) {
    result.value = done
    emit('applied', done)
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="placement-apply-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="placement-apply-title"
      data-testid="placement-apply-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Apply placement</p>
          <h2 id="placement-apply-title" class="text-lg font-bold text-carbon mt-0.5">
            {{ plural(rows.length, 'teammate', 'teammates') }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="placement-apply-close" @click="emit('close')">Close</UiButton>
      </div>

      <div v-if="!result" class="px-6 py-4 space-y-3 text-sm text-carbon">
        <ul class="space-y-1.5" data-testid="placement-apply-counts">
          <li v-if="regionMoves" data-testid="placement-apply-region-count">
            <strong>{{ plural(regionMoves, 'person moves', 'people move') }} region.</strong>
            They are signed out of the web app and sign in again into the new region. Their devices keep reporting.
          </li>
          <li v-if="unitMoves" data-testid="placement-apply-unit-count">
            <strong>{{ plural(unitMoves, 'person moves', 'people move') }} {{ BU_LABEL }}</strong> within their region.
          </li>
        </ul>
        <p class="text-[12px]" data-testid="placement-apply-lens-note">
          Reports group usage by where each person sits now, so their usage, including what they
          have already recorded, follows them. Usage tagged to a project stays with that project's {{ BU_LABEL }}.
        </p>
        <div
          v-if="manualRows.length"
          class="rounded-lg border border-brand-hunger/40 bg-brand-hunger/5 px-3 py-2.5"
          data-testid="placement-apply-manual"
        >
          <p class="text-[12px]">
            {{ plural(manualRows.length, 'person was', 'people were') }} placed by an admin:
            {{ manualRows.map((r) => r.name ?? r.email).join(', ') }}.
          </p>
          <label class="mt-2 flex items-start gap-2 text-[12px] cursor-pointer">
            <input v-model="confirmManual" type="checkbox" class="mt-0.5" data-testid="placement-apply-confirm-manual">
            <span>Move them anyway, replacing the admin's placement.</span>
          </label>
        </div>
        <p v-if="error" class="text-xs text-rag-red" role="alert" data-testid="placement-apply-error">{{ error }}</p>
        <div class="flex justify-end gap-2 pt-2">
          <UiButton ref="cancelBtn" kind="ghost" data-testid="placement-apply-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="placement-apply-submit" @click="submit">
            {{ saving ? 'Applying…' : `Apply ${rows.length}` }}
          </UiButton>
        </div>
      </div>

      <div v-else class="px-6 py-4 text-sm text-carbon" data-testid="placement-apply-result">
        <p data-testid="placement-apply-summary">
          {{ moved }} moved<template v-if="refused">, {{ refused }} refused</template>.
          <template v-if="refused">Refused rows were not changed.</template>
        </p>
        <p v-if="error" class="mt-2 text-xs text-rag-red" role="alert" data-testid="placement-apply-partial-error">{{ error }}</p>
        <ul class="mt-3 border border-calm-2 rounded-md divide-y divide-calm-2 max-h-72 overflow-y-auto">
          <li
            v-for="r in result.results"
            :key="r.teammateId"
            class="px-3 py-2"
            :data-testid="`placement-apply-outcome-${r.teammateId}`"
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate">{{ labelFor(r.teammateId) }}</span>
              <span :class="r.outcome === 'moved' ? 'text-brand-harmony' : 'text-rag-red'" class="text-[12px] font-semibold shrink-0">
                {{ r.outcome === 'moved' ? 'Moved' : 'Refused' }}
              </span>
            </div>
            <div v-if="r.outcome === 'moved' && byId.get(r.teammateId)" class="text-[11px] text-carbon-3">
              → {{ placementHomeText(byId.get(r.teammateId)!.derived) }}
            </div>
            <div v-else-if="r.outcome === 'refused'" class="text-[11px] text-carbon-3">
              {{ PLACEMENT_REFUSAL_TEXT[r.reason ?? 'error'] }}
            </div>
          </li>
        </ul>
        <div class="flex justify-end pt-4">
          <UiButton kind="primary" data-testid="placement-apply-done" @click="emit('close')">Done</UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
