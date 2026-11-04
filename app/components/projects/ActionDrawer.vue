<script setup lang="ts">
/*
 * The right-hand drawer the project page's header actions open (#477, spec
 * docs/design/ideas/project-page-actions): Manage, and Request more budget.
 * The same shell as the session detail drawer: scrim, role="dialog",
 * aria-modal, a labelled title, and the shared useModalA11y contract (Escape,
 * focus trap, focus on Close at open, focus back to the opener at close).
 * Full width at phone width.
 *
 * The body mounts on first open and stays mounted (hidden) after close: a save
 * still in flight when the drawer closes must still emit `changed`, or the page
 * would never refresh what it changed. The page unmounts the drawer itself when
 * the viewer loses the action.
 */
import { ref, useId, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'

const props = defineProps<{
  open: boolean
  title: string
  /** The small line above the title: the project's name. */
  eyebrow: string
  testid: string
}>()
const emit = defineEmits<{ close: [] }>()

const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLElement | null>(null)
const titleId = `${props.testid}-title-${useId()}`
const opened = ref(props.open)
watch(
  () => props.open,
  (open) => {
    if (open) opened.value = true
  },
)

useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: closeBtn,
  onClose: () => emit('close'),
})
</script>

<template>
  <div
    v-if="opened"
    v-show="open"
    class="fixed inset-0 z-[60] flex justify-end bg-carbon/40"
    :data-testid="testid"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-xl h-full bg-paper shadow-2xl overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-calm-2 px-6 py-4 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony truncate">{{ eyebrow }}</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">{{ title }}</h2>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" :data-testid="`${testid}-close`" @click="emit('close')">Close</UiButton>
      </div>
      <div class="px-6 py-5">
        <slot />
      </div>
    </div>
  </div>
</template>
