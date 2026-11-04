<script setup lang="ts">
/*
 * PlaceTeammateDialog — confirm a person's move to another Business Unit.
 *
 * The picker on the users table does not apply on `change`: a stray keystroke on
 * a focused select would move somebody, and reports group by where people sit
 * now, so a move also changes where their past usage reports. One click to
 * confirm is the whole ceremony.
 */
import { ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { BU_LABEL } from '#shared/reports/vocabulary'

const props = defineProps<{
  open: boolean
  /** What to call the person — their email; a uuid names nobody. */
  teammateLabel: string
  toUnitName: string
}>()

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl: dialogRef,
  onClose: () => emit('cancel'),
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="place-teammate-overlay"
    @click.self="emit('cancel')"
  >
    <div
      ref="dialogRef"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="place-teammate-title"
      data-testid="place-teammate-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2">
        <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Move teammate</p>
        <h2 id="place-teammate-title" class="text-lg font-bold text-carbon mt-0.5 break-all">
          {{ teammateLabel }}
        </h2>
        <p class="text-[12px] text-carbon-2 mt-0.5">
          Moving to <strong>{{ toUnitName }}</strong>
        </p>
      </div>

      <div class="px-6 py-4">
        <p class="text-[12px] text-carbon" data-testid="pt-explainer">
          Reports group usage by where each person sits now, so their usage,
          including what they have already recorded, will report under
          {{ toUnitName }}. Usage tagged to a project stays with that project's
          {{ BU_LABEL }}.
        </p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="pt-cancel" @click="emit('cancel')">Cancel</UiButton>
          <UiButton kind="primary" data-testid="pt-confirm" @click="emit('confirm')">Move</UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
