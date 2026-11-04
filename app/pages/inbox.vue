<script setup lang="ts">
/*
 * Per-actor inbox (design-notes §Screen 7).
 *
 * Filter bar (Category / Severity / Status) sits in its own card.
 * List rows use the hi-fi grid layout (severity icon / subject +
 * meta / category badge / timestamp / chevron) with unread = Hunger
 * dot + bold copy. Click opens a right-side drawer (per design-notes,
 * promoted over the prior inline panel) with a per-kind body.
 */
import { ref, computed, nextTick, watch } from 'vue'
import { consola } from 'consola'
import InboxFilterBar, {
  type InboxCategoryFilter,
  type InboxSeverityFilter,
  type InboxStatusFilter,
} from '../components/inbox/InboxFilterBar.vue'
import InboxDrawer from '../components/inbox/InboxDrawer.vue'
import { apiErrorDetail, isConfirmedRejection } from '../composables/useApiError'
import { categoryLabel, type InboxItem } from '../components/inbox/types'

const category = ref<InboxCategoryFilter>('all')
const severity = ref<InboxSeverityFilter>('all')
const status = ref<InboxStatusFilter>('all')
const drawerId = ref<string | null>(null)

const fetchUrl = computed(() => {
  const params = new URLSearchParams()
  if (status.value !== 'all') {
    params.set('ack_state', status.value)
  }
  if (category.value !== 'all') {
    params.set('category', category.value)
  }
  if (severity.value !== 'all') {
    params.set('severity', severity.value)
  }
  const qs = params.toString()
  return `/api/v1/me/inbox${qs ? `?${qs}` : ''}`
})

const { data, refresh, pending, error } = useFetch<{ items: InboxItem[]; total: number }>(fetchUrl, {
  default: () => ({ items: [], total: 0 }),
})

/*
 * Empty, refused and failed are three different answers, and only the first
 * means "nothing is waiting". `default` fills `data` with an empty list even
 * when the read failed, so the error is checked BEFORE the list: a failed load
 * must never read as an empty inbox. Refused = the server answered with a 4xx
 * and a reason (isConfirmedRejection); anything else (no answer, a 5xx) is a
 * failure, and then we cannot know what is in the inbox.
 */
const loadState = computed<'refused' | 'failed' | null>(() => {
  if (!error.value) return null
  return isConfirmedRejection(error.value) ? 'refused' : 'failed'
})
const refusedDetail = computed(() =>
  apiErrorDetail(error.value, 'none').replace(/\.$/, ''),
)

const drawerItem = computed<InboxItem | null>(() => {
  if (!drawerId.value || !data.value) return null
  return data.value.items.find((i) => i.id === drawerId.value) ?? null
})

// FE-5: action failures surface as a toast (the admin-pages flashToast house
// pattern) instead of an unhandled rejection from a template handler.
const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

/**
 * PATCH the ack state. Never throws — failures toast + return false so
 * callers (resolve/dismiss/snooze) only close the drawer on success.
 */
async function ack(id: string, newState: InboxItem['ack_state']): Promise<boolean> {
  try {
    await $fetch(`/api/v1/me/inbox/${id}`, {
      method: 'PATCH',
      body: { ack_state: newState },
    })
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Inbox update failed — try again.'))
    consola.warn('inbox: ack failed', { id, newState, err })
    return false
  }
  await refresh()
  // Resolving/dismissing moves the item out of the "open" set, so the header
  // bell (keyed 'inbox-open-count') must re-sync now, not on the next reload.
  await refreshNuxtData('inbox-open-count')
  return true
}

// Track the element that opened the drawer so we restore focus there on
// close: focus comes back to the row.
const lastFocusedEl = ref<HTMLElement | null>(null)

function openDrawer(item: InboxItem, originEl?: HTMLElement | null) {
  drawerId.value = item.id
  if (originEl) lastFocusedEl.value = originEl
  if (item.ack_state === 'unread') {
    // ack never rejects — a failed auto-mark-read toasts + logs internally.
    void ack(item.id, 'read')
  }
  // Move focus to the drawer close button so keyboard users can dismiss
  // with one keystroke. Wait for the next tick so the drawer is mounted.
  void nextTick(() => {
    const closeBtn = document.querySelector<HTMLElement>('[data-testid="drawer-close"]')
    closeBtn?.focus()
  })
}

function closeDrawer() {
  drawerId.value = null
  // Restore focus to the row that opened the drawer.
  void nextTick(() => {
    lastFocusedEl.value?.focus()
    lastFocusedEl.value = null
  })
}

// Escape and the Tab focus trap belong to the drawer (useModalA11y in
// InboxDrawer.vue), which emits `close` into closeDrawer above.
watch(drawerId, (v) => {
  // Defensive: if the underlying item disappears (refresh), close.
  if (v && !drawerItem.value) drawerId.value = null
})

// FE-5: the drawer closes ONLY when the PATCH succeeded — a failed action
// keeps it open with the toast explaining why.
async function handleResolve(id: string) {
  if (await ack(id, 'resolved')) closeDrawer()
}

async function handleDismiss(id: string) {
  if (await ack(id, 'dismissed')) closeDrawer()
}

async function handleSnooze(id: string) {
  // Snooze is "ack + reopen 24h later" in the full model; for the
  // pilot, treat as acknowledged so the bell badge clears without
  // closing the inbox row.
  if (await ack(id, 'acknowledged')) closeDrawer()
}

function severityIconColor(sev: string): string {
  if (sev === 'urgent') return 'bg-[#FEE2E2] text-rag-red'
  if (sev === 'attention') return 'bg-brand-hunger-lite text-brand-heart'
  return 'bg-brand-vision-lite text-brand-vision-ink'
}

</script>

<template>
  <div class="max-w-[1440px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Inbox"
      title="What needs your attention"
      sub="Conflicts, alerts and action requests routed to you. They appear only here: TokenScope does not send them by Teams or email."
    >
      <template #actions>
        <button
          type="button"
          class="px-3 py-1.5 text-xs font-bold text-carbon-3 rounded-md opacity-50 cursor-not-allowed"
          title="Bulk mark-read lands in a later MVP-Final slice — until then, use per-row Resolve / Mark read."
          disabled
        >
          Mark all read
        </button>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`inbox-toast-${toast.kind}`"
      role="alert"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <InboxFilterBar
      :category="category"
      :severity="severity"
      :status="status"
      @update:category="(v) => (category = v)"
      @update:severity="(v) => (severity = v)"
      @update:status="(v) => (status = v)"
    />

    <UiCard v-if="pending" flush>
      <div class="p-10 text-center text-carbon-3 text-sm">Loading…</div>
    </UiCard>

    <UiCard v-else-if="loadState === 'refused'" flush data-testid="inbox-refused">
      <UiEmptyState
        headline="The server refused to list your inbox."
        :sub="`Reason given: ${refusedDetail}. Your items are not shown here, and none of them has been cleared.`"
      />
    </UiCard>

    <UiCard v-else-if="loadState === 'failed'" flush data-testid="inbox-failed">
      <UiEmptyState
        headline="Your inbox didn't load."
        sub="We couldn't get an answer from the server, so we can't tell whether anything is waiting for you. Nothing has been cleared."
      >
        <UiButton kind="secondary" size="sm" data-testid="inbox-retry" @click="refresh()">
          Try again
        </UiButton>
      </UiEmptyState>
    </UiCard>

    <UiCard v-else-if="!data || data.items.length === 0" flush data-testid="inbox-empty">
      <UiEmptyState
        headline="Nothing to see here."
        sub="Alerts, conflicts and requests routed to you appear in this inbox, and only here. Check back when you want to see them."
      />
    </UiCard>

    <UiCard v-else flush>
      <ul class="divide-y divide-calm-2" data-testid="inbox-list">
        <li
          v-for="item in data.items"
          :key="item.id"
          :data-testid="`inbox-row-${item.ack_state}`"
        >
          <button
            type="button"
            class="w-full grid grid-cols-[28px_1fr_auto_auto_16px] items-center gap-4 px-5 py-4 hover:bg-brand-harmony-sheer transition-colors text-left cursor-pointer"
            :aria-label="`Open ${item.subject}`"
            @click="(ev) => openDrawer(item, ev.currentTarget as HTMLElement)"
          >
            <span class="flex items-center gap-1.5">
              <span
                v-if="item.ack_state === 'unread'"
                class="inline-block w-1.5 h-1.5 rounded-full bg-brand-hunger shrink-0"
                aria-hidden="true"
              />
              <span
                class="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold shrink-0"
                :class="severityIconColor(item.severity)"
                :title="item.severity"
              >
                {{ item.severity[0]?.toUpperCase() ?? '?' }}
              </span>
            </span>
            <div class="min-w-0">
              <div
                class="text-sm text-carbon"
                :class="[
                  item.ack_state === 'unread' ? 'font-bold' : 'font-medium',
                  ['dismissed', 'resolved'].includes(item.ack_state) ? 'text-carbon-2' : '',
                ]"
              >
                {{ item.subject }}
              </div>
              <div class="text-[11px] text-carbon-3 mt-1">
                {{ item.related_entity_kind ?? '—' }} · {{ item.ack_state }}
              </div>
            </div>
            <UiBadge kind="neutral">{{ categoryLabel(item.category) }}</UiBadge>
            <span class="text-[11px] text-carbon-3 whitespace-nowrap">
              {{ fmtTimeAgo(item.created_at) }}
            </span>
            <svg
              class="w-4 h-4 text-carbon-3 shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </li>
      </ul>
    </UiCard>

    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-150 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <InboxDrawer
        v-if="drawerItem"
        :item="drawerItem"
        @close="closeDrawer"
        @resolve="handleResolve(drawerItem.id)"
        @dismiss="handleDismiss(drawerItem.id)"
        @snooze="handleSnooze(drawerItem.id)"
        @mark-read="ack(drawerItem.id, 'read')"
      />
    </Transition>
  </div>
</template>
