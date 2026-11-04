<script setup lang="ts">
/*
 * BackfillDialog — enqueue an on-demand historical provider-usage pull for a
 * single RECONCILED scope (an anthropic provider_org or a github
 * provider_enterprise). Mirrors ProviderOrgDialog's create path: one POST to
 * .../reconciliation/backfill, server validation surfaced inline, no key value
 * ever carried.
 *
 * The steady-state reconciliation-sync pulls only [yesterday, today]; this lets
 * an admin choose a window so §A surfaces older unaccounted-usage days to tag.
 * The server sets endDate = today; we only collect startDate, constrained to the
 * last 90 days (min/max computed client-side to match the server window).
 *
 * A11y mirrors ProviderOrgDialog / SetBudgetDialog.
 */
import { ref, computed, type Ref } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'

export interface BackfillTarget {
  targetKind: 'org' | 'enterprise'
  targetId: string
  provider: 'anthropic' | 'github'
  displayName: string
  externalRef: string
}

const props = defineProps<{
  /* null = closed; a target = open against that scope. */
  target: BackfillTarget | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const MAX_BACKFILL_DAYS = 90
const DEFAULT_BACKFILL_DAYS = 30

/** YYYY-MM-DD for UTC midnight `daysAgo` days before today. */
function ymdDaysAgo(daysAgo: number): string {
  const d = new Date()
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  utc.setUTCDate(utc.getUTCDate() - daysAgo)
  return utc.toISOString().slice(0, 10)
}

const today = computed(() => ymdDaysAgo(0))
const minDate = computed(() => ymdDaysAgo(MAX_BACKFILL_DAYS))
const startDate = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'backfill-title'

useModalA11y({
  isOpen: () => props.target !== null,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    startDate.value = ymdDaysAgo(DEFAULT_BACKFILL_DAYS)
    error.value = null
    saving.value = false
  },
})

const canSubmit = computed(() => {
  if (saving.value) return false
  if (!startDate.value) return false
  if (startDate.value < minDate.value || startDate.value > today.value) return false
  return true
})

async function save() {
  if (!canSubmit.value || !props.target) return
  saving.value = true
  error.value = null
  try {
    await $fetch('/api/v1/admin/reconciliation/backfill', {
      method: 'POST',
      body: {
        targetKind: props.target.targetKind,
        targetId: props.target.targetId,
        startDate: startDate.value,
      },
    })
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Backfill request failed.')
    consola.warn('reconciliation backfill enqueue failed', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="target"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="backfill-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
            Backfill provider usage
          </p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ target.displayName }}
          </h2>
          <p class="text-[11px] text-carbon-3 mt-0.5 font-mono">
            {{ target.provider }} / {{ target.externalRef }}
          </p>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="backfill-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <div>
          <label for="bf-start-date" class="text-[12px] font-semibold text-carbon">Start date</label>
          <input
            id="bf-start-date"
            ref="firstField"
            v-model="startDate"
            type="date"
            :min="minDate"
            :max="today"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
            data-testid="bf-start-date"
          >
          <p class="text-[11px] text-carbon-3 mt-1">
            Pulls this scope's provider usage from the chosen date to today, so older days surface as
            unaccounted usage to tag. Up to 90 days.
          </p>
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="backfill-error" role="alert">
          {{ error }}
        </p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="backfill-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="bf-submit" @click="save">
            {{ saving ? 'Enqueuing…' : 'Start backfill' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
