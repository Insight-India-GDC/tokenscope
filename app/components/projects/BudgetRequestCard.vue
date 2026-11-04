<script setup lang="ts">
/*
 * A member's budget requests on this project (spec §5): ask the project's
 * managers to add to its budget, see what happened to earlier asks, withdraw
 * one still waiting. One request may wait at a time; the server enforces it.
 * Budgets are for reporting, so the copy never says spend is blocked.
 * The body of the Request more budget drawer (#477); the drawer carries the title.
 */
import { computed, ref } from 'vue'
import type { BudgetRequestRow } from '#shared/schemas/project-budget'
import { isConfirmedRejection, mutationErrorDetail } from '../../composables/useApiError'

const props = defineProps<{
  projectId: string
  ended: boolean
  mine: BudgetRequestRow[]
  /** Whether mine loaded: an empty list means "none" only when 'ready'. */
  requestsState: 'loading' | 'error' | 'ready'
}>()
const emit = defineEmits<{ changed: []; retry: [] }>()

const amount = ref('')
const reason = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const waiting = computed(() => props.mine.find((r) => r.status === 'pending') ?? null)
const canSubmit = computed(
  () =>
    !busy.value &&
    /^\d{1,7}(\.\d{1,2})?$/.test(amount.value.trim()) &&
    Number(amount.value) > 0 &&
    reason.value.trim().length > 0,
)

async function submit() {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/projects/${props.projectId}/budget-requests`, {
      method: 'POST',
      body: { amount_usd: amount.value.trim(), reason: reason.value.trim() },
    })
    amount.value = ''
    reason.value = ''
    emit('changed')
  } catch (err) {
    error.value = mutationErrorDetail(
      err,
      'Could not send the request.',
      'We could not tell whether your request was sent. Check your requests below before sending it again.',
    )
    if (!isConfirmedRejection(err)) emit('changed')
  } finally {
    busy.value = false
  }
}

async function withdraw(id: string) {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/projects/${props.projectId}/budget-requests/${id}/withdraw`, { method: 'POST' })
    emit('changed')
  } catch (err) {
    error.value = mutationErrorDetail(
      err,
      'Could not withdraw the request.',
      'We could not tell whether the request was withdrawn. Check its status below before trying again.',
    )
    if (!isConfirmedRejection(err)) emit('changed')
  } finally {
    busy.value = false
  }
}

const STATUS_WORD: Record<string, string> = {
  pending: 'waiting for a manager',
  approved: 'approved',
  rejected: 'declined',
  withdrawn: 'withdrawn',
}
</script>

<template>
  <div data-testid="budget-request-card">
    <p v-if="ended" class="text-[12px] text-carbon-3 mt-1">This project has ended, so its budget no longer changes.</p>
    <p v-else-if="requestsState === 'loading'" class="text-[12px] text-carbon-3 mt-1" data-testid="budget-request-loading">
      Loading your requests…
    </p>
    <!-- Without the earlier requests the form cannot tell whether one is already waiting. -->
    <div v-else-if="requestsState === 'error'" class="flex items-center gap-2 mt-1" data-testid="budget-request-load-error">
      <p class="text-[12px] text-brand-heart">Could not load your budget requests.</p>
      <UiButton kind="secondary" size="sm" data-testid="budget-request-retry" @click="emit('retry')">Retry</UiButton>
    </div>
    <template v-else-if="!waiting">
      <p class="text-[11px] text-carbon-3 mt-1 mb-2">
        Ask this project's managers to add to its budget. They can approve the amount you ask for, a
        different amount, or decline.
      </p>
      <div class="flex items-end gap-2 flex-wrap">
        <label class="text-[11px] text-carbon-3">
          Amount (USD)
          <input v-model="amount" inputmode="decimal" class="block w-28 px-2 py-1.5 text-sm border border-calm-2 rounded-md" data-testid="budget-request-amount">
        </label>
        <label class="text-[11px] text-carbon-3 grow">
          What is it for?
          <input v-model="reason" maxlength="1000" class="block w-full px-2 py-1.5 text-sm border border-calm-2 rounded-md" data-testid="budget-request-reason">
        </label>
        <UiButton kind="primary" size="sm" :disabled="!canSubmit" data-testid="budget-request-submit" @click="submit">
          Send request
        </UiButton>
      </div>
    </template>

    <div v-if="mine.length" class="mt-5 text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-2">Your requests</div>
    <ul v-if="mine.length" class="space-y-1" data-testid="budget-request-mine">
      <li v-for="r in mine" :key="r.id" class="text-[12px] text-carbon-2 flex items-center gap-2 flex-wrap">
        <span>
          {{ fmtUsd(r.amount_usd) }} · {{ STATUS_WORD[r.status] ?? r.status }}<template
            v-if="r.status === 'approved' && r.approved_amount_usd && r.approved_amount_usd !== r.amount_usd"
          > ({{ fmtUsd(r.approved_amount_usd) }} added)</template>
          <template v-if="r.decision_note"> · “{{ r.decision_note }}”</template>
          <span class="text-carbon-3"> · asked {{ new Date(r.created_at).toLocaleDateString() }}</span>
        </span>
        <UiButton
          v-if="r.status === 'pending'"
          kind="ghost"
          size="sm"
          :disabled="busy"
          :data-testid="`budget-request-withdraw-${r.id}`"
          @click="withdraw(r.id)"
        >
          Withdraw
        </UiButton>
      </li>
    </ul>
    <p v-if="error" class="text-[12px] text-brand-heart mt-2" data-testid="budget-request-error">{{ error }}</p>
  </div>
</template>
