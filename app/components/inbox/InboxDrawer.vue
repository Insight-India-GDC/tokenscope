<script setup lang="ts">
/*
 * InboxDrawer — right-side drawer for the inbox detail view.
 *
 * Per design-notes §Screen 7: drawer over sub-page (deviation
 * accepted). Header shows category + severity chips + subject; body
 * is per-kind via DrawerBodyOverBudget / Velocity / SyncConflict /
 * Untagged; footer has the category-appropriate action buttons.
 *
 * Body-routing decision lives in `./types.ts::variantForCategory`
 * (single source of truth, unit-tested separately).
 *
 * The parent owns the <Transition>; this component is a plain aside
 * so it can be unmounted/mounted by `v-if`.
 */

import { computed, ref } from 'vue'
import { useModalA11y } from '../../composables/useModalA11y'
import UiButton from '../ui/Button.vue'
import UiBadge from '../ui/Badge.vue'
import DrawerBodyOverBudget from './DrawerBodyOverBudget.vue'
import DrawerBodyVelocity from './DrawerBodyVelocity.vue'
import DrawerBodySyncConflict from './DrawerBodySyncConflict.vue'
import DrawerBodyUntagged from './DrawerBodyUntagged.vue'
import DrawerBodyPersonalSubscription from './DrawerBodyPersonalSubscription.vue'
import DrawerBodyOverEmission from './DrawerBodyOverEmission.vue'
import DrawerBodyProjectRequest from './DrawerBodyProjectRequest.vue'
import DrawerBodyBudgetRequest from './DrawerBodyBudgetRequest.vue'
import { categoryLabel, variantForCategory, type InboxItem } from './types'

const props = defineProps<{
  item: InboxItem
}>()

const emit = defineEmits<{
  close: []
  resolve: []
  dismiss: []
  snooze: []
  'mark-read': []
}>()

const variant = computed(() => variantForCategory(props.item.category))

// The drawer is mounted only while an item is open (the parent's v-if), so it
// is open for its whole lifetime. Shared dialog contract: Escape closes, Tab is
// trapped in the drawer, Close takes focus on open and focus returns to the
// row that opened it when the drawer unmounts.
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)
useModalA11y({
  isOpen: () => true,
  dialogEl,
  firstField: closeBtn,
  onClose: () => emit('close'),
})

const severityBadgeKind = computed<
  'hunger' | 'rag-red' | 'vision' | 'neutral'
>(() => {
  switch (props.item.severity) {
    case 'urgent':
      return 'rag-red'
    case 'attention':
      return 'hunger'
    case 'info':
    default:
      return 'vision'
  }
})
</script>

<template>
  <aside
    ref="dialogEl"
    role="dialog"
    aria-modal="true"
    :aria-label="`Inbox item: ${item.subject}`"
    class="fixed top-0 right-0 h-full w-full max-w-[480px] bg-white shadow-[-8px_0_32px_rgba(88,40,115,0.16)] z-50 flex flex-col"
    data-testid="inbox-drawer"
    :data-variant="variant"
  >
    <header class="px-6 py-5 border-b border-calm-2">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral">{{ categoryLabel(item.category) }}</UiBadge>
          <UiBadge :kind="severityBadgeKind">{{ item.severity }}</UiBadge>
        </div>
        <button
          ref="closeBtn"
          type="button"
          class="text-carbon-3 hover:text-carbon cursor-pointer p-1 -mr-1 rounded transition-colors"
          aria-label="Close drawer"
          data-testid="drawer-close"
          @click="emit('close')"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <h2 class="mt-3 text-lg font-bold tracking-tight text-carbon leading-tight">
        {{ item.subject }}
      </h2>
      <div class="mt-2 flex items-center justify-between gap-3 text-xs text-carbon-3">
        <span>Created {{ new Date(item.created_at).toLocaleString() }}</span>
        <!-- The PROJECT page, not the budget editor: a member who is not the
             manager can open the first and not the second. The server emits the
             code only when this recipient can open the page. -->
        <NuxtLink
          v-if="item.target_project_code"
          :to="`/projects/${encodeURIComponent(item.target_project_code)}`"
          class="font-bold text-brand-harmony hover:underline"
          data-testid="drawer-open-project"
        >
          Open project →
        </NuxtLink>
      </div>
    </header>
    <!-- Keyed by item: selecting another item of the same kind remounts the body,
         so no body can keep showing the first item's figures. -->
    <div :key="item.id" class="flex-1 overflow-y-auto px-6 py-5" data-testid="drawer-body">
      <DrawerBodyOverBudget v-if="variant === 'over-budget'" :body="item.body" />
      <DrawerBodyVelocity v-else-if="variant === 'velocity'" :body="item.body" />
      <DrawerBodySyncConflict v-else-if="variant === 'sync-conflict'" :body="item.body" />
      <DrawerBodyUntagged v-else-if="variant === 'untagged'" :body="item.body" />
      <DrawerBodyPersonalSubscription v-else-if="variant === 'personal-subscription'" :body="item.body" />
      <DrawerBodyOverEmission v-else-if="variant === 'over-emission'" :body="item.body" />
      <DrawerBodyProjectRequest v-else-if="variant === 'project-request'" :category="item.category" :body="item.body" />
      <DrawerBodyBudgetRequest v-else-if="variant === 'budget-request'" :category="item.category" :body="item.body" />
      <div v-else class="text-sm text-carbon-2 leading-relaxed">
        Details for this category aren't laid out yet. Use the
        actions below to acknowledge, resolve, or dismiss.
      </div>
    </div>
    <footer class="px-6 py-4 border-t border-calm-2 flex items-center justify-end gap-2 flex-wrap">
      <UiButton
        v-if="item.ack_state === 'unread'"
        kind="ghost"
        size="sm"
        data-testid="drawer-action-mark-read"
        @click="emit('mark-read')"
      >
        Mark read
      </UiButton>
      <UiButton
        v-if="variant === 'velocity' || variant === 'over-budget'"
        kind="ghost"
        size="sm"
        data-testid="drawer-action-snooze"
        title="Clears the bell badge but keeps the item tracked."
        @click="emit('snooze')"
      >
        Acknowledge
      </UiButton>
      <UiButton
        kind="secondary"
        size="sm"
        data-testid="drawer-action-dismiss"
        @click="emit('dismiss')"
      >
        Dismiss
      </UiButton>
      <!--
        Over-budget items get a navigation button instead of an
        ack-style resolve: clicking "Add top-up" should take the user
        to the allocator with the top-up form pre-opened, not just
        clear the bell. The inbox item stops re-firing on its own once
        the producer sees used <= cap (budget-alert worker).

        Defensive fallback: if target_allocation_id is null (project
        has no current baseline allocation), fall back to the ack-style
        Resolve so the button is never inert. Per data-model, an
        over-budget alert without a baseline should not occur, but the
        producer is allowed to dispatch on top-up-only coverage too.
      -->
      <UiButton
        v-if="variant === 'over-budget' && item.target_allocation_id"
        :to="`/allocations/${item.target_allocation_id}?focus=topup`"
        kind="primary"
        size="sm"
        data-testid="drawer-action-add-topup"
      >
        Add top-up →
      </UiButton>
      <UiButton
        v-else
        kind="primary"
        size="sm"
        data-testid="drawer-action-resolve"
        @click="emit('resolve')"
      >
        Resolve
      </UiButton>
    </footer>
  </aside>
</template>
