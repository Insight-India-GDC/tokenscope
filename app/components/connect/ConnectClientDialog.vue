<script setup lang="ts">
/*
 * ConnectClientDialog — the homepage pop-up shell around ConnectClientGuide.
 * Opened by the "Connect Claude" / "Connect Copilot" buttons on the developer
 * homepage; shows the SAME instructions as the account page (same underlying
 * ConnectClientGuide component) so the two surfaces never drift.
 *
 * Accessibility mirrors TagSessionDialog: role="dialog" + aria-modal, Escape
 * closes, backdrop click closes, focus is trapped and restored on close.
 */
import { ref } from 'vue'
import type { ConnectGuideKind } from '#shared/connect'
import UiButton from '../ui/Button.vue'
import ConnectClientGuide from './ConnectClientGuide.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { useConnectConfig } from '../../composables/useConnectConfig'

const props = defineProps<{ kind: ConnectGuideKind | null }>()
const emit = defineEmits<{ close: [] }>()

const dialogEl = ref<HTMLElement | null>(null)
const { config, failed } = useConnectConfig()

useModalA11y({
  isOpen: () => !!props.kind,
  dialogEl,
  // Focus the dialog container on open (it's tabindex="-1"); Tab then moves
  // into Close + the copy buttons. We can't use the Close <UiButton> as the
  // first field — a component ref is the instance, not a focusable element.
  firstField: dialogEl,
  onClose: () => emit('close'),
})
</script>

<template>
  <div
    v-if="kind"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="connect-client-modal"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      tabindex="-1"
      class="w-full max-w-lg max-h-[88vh] overflow-y-auto bg-white rounded-xl shadow-xl outline-none"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`connect-dialog-title-${kind}`"
    >
      <div class="flex justify-end px-4 pt-3">
        <UiButton kind="ghost" size="sm" data-testid="connect-close" @click="emit('close')">
          Close
        </UiButton>
      </div>
      <div class="px-6 pb-6 pt-1">
        <ConnectClientGuide
          :kind="kind"
          :config="config"
          :failed="failed"
          :title-id="`connect-dialog-title-${kind}`"
        />
      </div>
    </div>
  </div>
</template>
