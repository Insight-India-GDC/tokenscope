<script setup lang="ts">
/*
 * BulkPlaceDialog — pick one Business Unit, place the selected teammates into it.
 * POST /api/v1/admin/users/bulk-place.
 *
 * WHAT IT MUST NOT DO IS HIDE A PARTIAL FAILURE. The endpoint returns per-id
 * outcomes precisely so one bad id cannot discard 39 good placements, and a
 * dialog that collapses that into "done" throws the distinction away. So a
 * response with any refusal keeps the dialog OPEN and lists what was refused,
 * with the server's own sentence per row. A clean run closes and hands the
 * parent a summary for the toast.
 *
 * STAYING OPEN IS NOT THE SAME AS NOTHING HAVING HAPPENED. The 38 that succeeded
 * are COMMITTED, so the dialog emits `partial` and the parent refreshes: without
 * it, the placed rows sit on screen as unplaced behind the dialog and the region
 * counts disagree with the database until something else reloads them. The same
 * event carries the FAILED ids, which become the new selection — a retry that
 * resubmits the 38 that already worked earns 38 no-ops, and the button would
 * offer to "Place 40" when there are two left to place.
 *
 * The picker offers only cost-owning units — the server refuses anything else
 * (422), and offering a destination the write will reject teaches an admin the
 * feature is broken.
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import { BU_LABEL } from '#shared/reports/vocabulary'

interface TargetUnit {
  id: string
  code: string
  display_name: string
  depth: number
}

interface PlaceResult {
  teammate_id: string
  /** 'noop' = already in that Business Unit; nothing was written for them. */
  status: 'placed' | 'noop' | 'failed'
  reason?: string
}

const props = defineProps<{
  open: boolean
  teammateIds: string[]
  targets: TargetUnit[]
  /** id → label, so a refusal names the person rather than a uuid. */
  labelFor: (teammateId: string) => string
}>()
const emit = defineEmits<{
  close: []
  /*
   * `placedIds` is what makes C5's rule offer possible: the offer must be built
   * from the teammates whose placement actually COMMITTED, not from the selection
   * (which can contain refusals) and not from a count (which names nobody).
   */
  placed: [
    summary: {
      placed: number
      noop: number
      unitName: string
      unitId: string
      placedIds: string[]
    },
  ]
  /*
   * Some placed, some refused. The dialog stays open on this one — the parent's
   * job is to make the rest of the page agree with what DID commit, and to hand
   * the selection back as just the ids still to place.
   */
  partial: [summary: { placed: number; noop: number; failed: number; unitName: string; failedIds: string[] }]
}>()

const targetId = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const failures = ref<PlaceResult[]>([])

const targetName = computed(
  () => props.targets.find((t) => t.id === targetId.value)?.display_name ?? 'that Business Unit',
)

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    targetId.value = ''
    error.value = null
    failures.value = []
  },
  { immediate: true },
)

// Shared dialog contract: Escape closes, Tab is trapped, the Business Unit
// picker takes focus on open and focus returns to the opener on close.
const dialogEl = ref<HTMLElement | null>(null)
const targetEl = ref<HTMLSelectElement | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: targetEl,
  onClose: () => emit('close'),
})

async function submit() {
  if (!targetId.value || !props.teammateIds.length) return
  saving.value = true
  error.value = null
  failures.value = []
  try {
    const res = await $fetch<{
      placed: number
      noop: number
      failed: number
      results: PlaceResult[]
    }>(
      '/api/v1/admin/users/bulk-place',
      {
        method: 'POST',
        body: {
          teammate_ids: props.teammateIds,
          org_unit_id: targetId.value,
        },
      },
    )
    const noop = res.noop ?? 0
    if (res.failed > 0) {
      // Stay open. The good placements ARE committed — say so, and name what
      // was not, rather than implying the whole batch failed or the whole
      // batch worked.
      failures.value = res.results.filter((r) => r.status === 'failed')
      error.value = `${res.placed} placed${noop ? `, ${noop} already there` : ''}, ${res.failed} refused. The placements below did not happen; everything else did.`
      // The parent owns the page behind this dialog and the selection: tell it
      // what committed, and hand back exactly the ids still to place.
      emit('partial', {
        placed: res.placed,
        noop,
        failed: res.failed,
        unitName: targetName.value,
        failedIds: failures.value.map((f) => f.teammate_id),
      })
      return
    }
    emit('placed', {
      placed: res.placed,
      noop,
      unitName: targetName.value,
      unitId: targetId.value,
      placedIds: res.results.filter((r) => r.status === 'placed').map((r) => r.teammate_id),
    })
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Placement failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="bulk-place-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-place-title"
      data-testid="bulk-place-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Place teammates</p>
          <h2 id="bulk-place-title" class="text-lg font-bold text-carbon mt-0.5">
            {{ teammateIds.length }} {{ teammateIds.length === 1 ? 'teammate' : 'teammates' }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="bulk-place-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <label for="bulk-place-target" class="text-[12px] font-semibold text-carbon">Business Unit</label>
        <select
          id="bulk-place-target"
          ref="targetEl"
          v-model="targetId"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="bulk-place-target"
        >
          <option value="">Choose a Business Unit…</option>
          <option v-for="t in targets" :key="t.id" :value="t.id">
            {{ '— '.repeat(Math.max(0, t.depth - 1)) }}{{ t.display_name }} ({{ t.code }})
          </option>
        </select>
        <p class="text-[11px] text-carbon-3 mt-1">
          Only Business Units are listed. Their spend then rolls up to this
          unit's P&amp;L instead of stopping at the region.
        </p>

        <p class="mt-3 text-[12px] text-carbon" data-testid="bulk-place-explainer">
          Reports group usage by where each person sits now, so their usage,
          including what they have already recorded, will report under
          {{ targetName }}. Usage tagged to a project stays with that project's
          {{ BU_LABEL }}.
        </p>

        <p v-if="!targets.length" class="text-xs text-rag-amber mt-3" data-testid="bulk-place-no-targets">
          This region has no Business Units yet — create one on the Business Units
          tab first, otherwise there is nowhere for this spend to land.
        </p>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="bulk-place-error" role="alert">{{ error }}</p>
        <ul
          v-if="failures.length"
          class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2 max-h-52 overflow-y-auto"
          data-testid="bulk-place-failures"
        >
          <li v-for="f in failures" :key="f.teammate_id" class="px-3 py-2">
            <div class="text-sm text-carbon truncate">{{ labelFor(f.teammate_id) }}</div>
            <div class="text-[11px] text-carbon-3">{{ f.reason }}</div>
          </li>
        </ul>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="bulk-place-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton
            kind="primary"
            :disabled="saving || !targetId || !teammateIds.length"
            data-testid="bulk-place-submit"
            @click="submit"
          >
            {{ saving ? 'Placing…' : `Place ${teammateIds.length}` }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
