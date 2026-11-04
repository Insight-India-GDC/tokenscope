<script setup lang="ts">
/*
 * The one confirmation before Org setup moves people. It shows the rows the caller
 * read from the live placement check a moment ago, which are exactly the rows the
 * caller then applies: nothing is re-selected between the question and the move.
 */
import { computed, ref, type ComponentPublicInstance } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import type { PlacementCheckRow } from '#shared/placement/placement-check'
import { movesRegion } from '../../utils/placement-check-view'
import { plural } from '../../utils/org-setup-view'

const props = defineProps<{ open: boolean; rows: PlacementCheckRow[]; busy: boolean }>()
const emit = defineEmits<{ confirm: []; close: [] }>()

const dialogEl = ref<HTMLElement | null>(null)
const cancelBtn = ref<ComponentPublicInstance | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: cancelBtn,
  onClose: () => {
    if (!props.busy) emit('close')
  },
})

const regionMoves = computed(() => props.rows.filter(movesRegion).length)
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4" data-testid="org-setup-move-overlay">
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl px-6 py-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="org-setup-move-title"
      data-testid="org-setup-move-confirm"
    >
      <h2 id="org-setup-move-title" class="text-lg font-bold text-carbon" data-testid="org-setup-move-title">
        Move {{ plural(rows.length, 'person', 'people') }}?
      </h2>
      <p class="text-sm text-carbon mt-2" data-testid="org-setup-move-text">
        {{ regionMoves.toLocaleString('en') }} of them change region and are signed out of the web app once. This cannot be undone.
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <UiButton ref="cancelBtn" kind="ghost" :disabled="busy" data-testid="org-setup-move-cancel" @click="emit('close')">Cancel</UiButton>
        <UiButton kind="primary" :disabled="busy || !rows.length" data-testid="org-setup-move-go" @click="emit('confirm')">
          {{ busy ? 'Moving…' : `Move ${plural(rows.length, 'person', 'people')}` }}
        </UiButton>
      </div>
    </div>
  </div>
</template>
