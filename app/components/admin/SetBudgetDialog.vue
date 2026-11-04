<script setup lang="ts">
/*
 * SetBudgetDialog — create the FIRST baseline budget for an existing,
 * budget-less project (the recovery path the admin Projects list was missing:
 * its "Budget" action only ever deep-linked to an ALREADY-existing
 * allocation, so a project created without a budget — e.g. when the
 * two-step new-project flow's budget step failed — was stranded with a
 * greyed-out button and no way to add one).
 *
 * POSTs the baseline pool to /api/v1/allocations (project_id + budget +
 * effective), mirroring the new-project budget step + the shared
 * allocation validation. A11y contract matches ProjectEditDialog.
 */
import { ref, computed, type Ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'

export interface SetBudgetTarget {
  id: string
  code: string
  display_name: string
}

const props = defineProps<{ project: SetBudgetTarget | null }>()
const emit = defineEmits<{ close: []; saved: [allocationId: string] }>()

const budgetUsd = ref('')
const fromIso = ref('')
const toIso = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'set-budget-title'

useModalA11y({
  isOpen: () => !!props.project,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    budgetUsd.value = ''
    fromIso.value = ''
    toIso.value = ''
    error.value = null
  },
})

// Same client-side gate as the new-project budget step (server re-validates
// via BudgetUsdSchema / EffectiveRangeSchema).
const canSubmit = computed(() => {
  if (saving.value) return false
  if (!/^\d+(\.\d{1,2})?$/.test(budgetUsd.value)) return false
  if (Number(budgetUsd.value) <= 0) return false
  if (!fromIso.value || !toIso.value) return false
  return fromIso.value < toIso.value
})

async function save() {
  const p = props.project
  if (!p || !canSubmit.value) return
  saving.value = true
  error.value = null
  try {
    // `Z` (midnight-UTC) bounds — valid in both V8's ISO parser and PG (the
    // bare-hour `+00` form is rejected by new Date(); see allocation-validation).
    const a = await $fetch<{ id: string }>('/api/v1/allocations', {
      method: 'POST',
      body: {
        project_id: p.id,
        budget_usd: budgetUsd.value,
        effective: `[${fromIso.value}T00:00:00Z,${toIso.value}T00:00:00Z)`,
      },
    })
    emit('saved', a.id)
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Budget creation failed.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="project"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="set-budget-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Set baseline budget</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">{{ project.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ project.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="set-budget-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p class="text-[12px] text-carbon-2 mb-3">
          This project has no budget yet. Set a baseline pool and effective period; you can add top-ups later.
        </p>

        <label for="sb-budget" class="text-[12px] font-semibold text-carbon">Budget (USD)</label>
        <input
          id="sb-budget"
          ref="firstField"
          v-model="budgetUsd"
          type="text"
          inputmode="decimal"
          placeholder="1000.00"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
          data-testid="sb-budget"
        >

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="sb-from" class="text-[12px] font-semibold text-carbon">From</label>
            <input
              id="sb-from"
              v-model="fromIso"
              type="date"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
              data-testid="sb-from"
            >
          </div>
          <div>
            <label for="sb-to" class="text-[12px] font-semibold text-carbon">To</label>
            <input
              id="sb-to"
              v-model="toIso"
              type="date"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
              data-testid="sb-to"
            >
          </div>
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="set-budget-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="set-budget-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="sb-submit" @click="save">
            {{ saving ? 'Creating…' : 'Create budget' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
