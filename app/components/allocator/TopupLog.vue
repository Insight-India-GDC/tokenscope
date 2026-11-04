<script setup lang="ts">
/*
 * TopupLog — append-only top-up log + inline "Add top-up" form
 * (per design-notes §Screen 4).
 *
 * The list is read-only — top-ups never edit or delete (the
 * underlying allocation row is immutable once written). The inline
 * form reveals on click; submit emits `add` with the form payload.
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd } from '../../composables/useFormat'

export interface TopupRow {
  id: string
  budget_usd: string
  effective: string
  created_at: string | null
  actor_display_name: string | null
  reason: string | null
}

const props = withDefaults(
  defineProps<{
    topups: TopupRow[]
    /*
     * Inbox-driven deep-link: when an over-budget alert's "Add top-up"
     * action navigates here with ?focus=topup, the allocator page
     * forwards `initiallyExpanded=true` so the form opens immediately
     * + the amount input gets focus + the section scrolls into view.
     */
    initiallyExpanded?: boolean
    /*
     * FE-6: the parent owns the POST. While `submitting` is true the form is
     * locked; when it flips back to false the form resets + collapses ONLY if
     * `submitError` is null — a rejected POST keeps the user's input visible
     * alongside the error.
     */
    submitting?: boolean
    submitError?: string | null
  }>(),
  { initiallyExpanded: false, submitting: false, submitError: null },
)

const emit = defineEmits<{
  add: [{ budget_usd: string; effective_from: string; effective_to: string; reason: string }]
}>()

const expanded = ref(props.initiallyExpanded)
const sectionRef = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!props.initiallyExpanded) return
  // Wait for the form to mount (v-if=expanded), then scroll the section
  // into view and focus the amount input. Used when ?focus=topup is in
  // the URL.
  void nextTick(() => {
    sectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const amount = document.querySelector<HTMLInputElement>('[data-testid="topup-amount"]')
    amount?.focus()
  })
})
const form = ref({
  budget_usd: '',
  effective_from: defaultFromIso(),
  effective_to: defaultToIso(),
  reason: '',
})

function defaultFromIso(): string {
  const d = new Date()
  d.setUTCDate(1)
  return d.toISOString().slice(0, 10)
}
function defaultToIso(): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() + 1, 1)
  return d.toISOString().slice(0, 10)
}

const canSubmit = computed(() => {
  return (
    /^\d+(\.\d{1,2})?$/.test(form.value.budget_usd) &&
    Number(form.value.budget_usd) > 0 &&
    form.value.effective_from &&
    form.value.effective_to &&
    form.value.effective_from < form.value.effective_to
  )
})

function submit() {
  if (!canSubmit.value || props.submitting) return
  emit('add', { ...form.value })
}

// Reset + collapse only after the parent signals success (FE-6): submitting
// flipped true→false with no error. On failure the input stays put so the
// user can fix and retry.
watch(
  () => props.submitting,
  (now, was) => {
    if (!was || now || props.submitError) return
    form.value = {
      budget_usd: '',
      effective_from: defaultFromIso(),
      effective_to: defaultToIso(),
      reason: '',
    }
    expanded.value = false
  },
)

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}
</script>

<template>
  <section ref="sectionRef" data-testid="topup-log">
    <header class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-carbon">Top-ups</div>
      <UiButton
        kind="secondary"
        size="sm"
        data-testid="topup-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? '× Cancel' : '+ Add top-up' }}
      </UiButton>
    </header>

    <form
      v-if="expanded"
      class="border border-calm-2 rounded-lg p-4 mb-3 bg-brand-harmony-sheer/40 space-y-3"
      data-testid="topup-form"
      @submit.prevent="submit"
    >
      <div class="grid grid-cols-3 gap-3">
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Amount (USD)</span>
          <input
            v-model="form.budget_usd"
            type="text"
            inputmode="decimal"
            placeholder="500.00"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
            data-testid="topup-amount"
          >
        </label>
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">From</span>
          <input
            v-model="form.effective_from"
            type="date"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="topup-from"
          >
        </label>
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">To</span>
          <input
            v-model="form.effective_to"
            type="date"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="topup-to"
          >
        </label>
      </div>
      <label class="text-xs block">
        <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Reason (optional)</span>
        <input
          v-model="form.reason"
          type="text"
          placeholder="Q2 scope extension, embeddings POC, …"
          maxlength="500"
          class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="topup-reason"
        >
      </label>
      <div
        v-if="submitError"
        class="px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart"
        data-testid="topup-error"
        role="alert"
      >
        Top-up failed — {{ submitError }}
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <UiButton kind="ghost" size="sm" type="button" @click="expanded = false">Cancel</UiButton>
        <UiButton
          kind="primary"
          size="sm"
          type="submit"
          :disabled="!canSubmit || submitting"
          data-testid="topup-submit"
        >
          {{ submitting ? 'Adding…' : 'Add' }}
        </UiButton>
      </div>
    </form>

    <ul v-if="topups.length > 0" class="border border-calm-2 rounded-lg overflow-hidden" data-testid="topup-list">
      <li
        v-for="t in topups"
        :key="t.id"
        class="grid grid-cols-[100px_1fr_100px] items-center gap-3 px-4 py-3 border-b border-calm-2 last:border-b-0 bg-white"
      >
        <span class="text-xs text-carbon-3 font-mono">{{ fmtDate(t.created_at) }}</span>
        <div class="text-sm text-carbon">
          {{ t.reason ?? '—' }}
          <div class="text-[11px] text-carbon-3">
            Added by {{ t.actor_display_name ?? 'system' }}
          </div>
        </div>
        <span class="text-right text-sm font-bold text-rag-green" style="font-variant-numeric: tabular-nums">
          +{{ fmtUsd(t.budget_usd) }}
        </span>
      </li>
    </ul>
    <div v-else class="text-xs text-carbon-3 italic">
      No top-ups yet. Add one if the project needs more headroom this period.
    </div>
  </section>
</template>
