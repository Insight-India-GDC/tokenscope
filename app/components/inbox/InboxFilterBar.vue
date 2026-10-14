<script setup lang="ts">
/*
 * InboxFilterBar — three segmented controls for Category /
 * Severity / Status. Per design-notes §Screen 7: lives in its own
 * card above the list, separates filter state from results.
 *
 * Category options map to `inbox_item.category`; we collapse the four
 * pilot-relevant categories (`over-budget`, `velocity-warning`,
 * `sync-conflict`, `untagged-backlog`) into the four labelled buttons
 * shown in the hi-fi. Status uses the `open/closed` semantics from
 * the inbox API.
 */

import UiCard from '../ui/Card.vue'
import type { INBOX_CATEGORIES } from '#shared/schemas/inbox'

// From the list endpoint's own enum: a filter it would reject cannot compile.
export type InboxCategoryFilter = 'all' | (typeof INBOX_CATEGORIES)[number]

export type InboxSeverityFilter = 'all' | 'info' | 'attention' | 'urgent'

export type InboxStatusFilter = 'all' | 'unread' | 'read'

const CATEGORY_OPTIONS: Array<{ key: InboxCategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'over-budget', label: 'Over budget' },
  { key: 'velocity-warning', label: 'Velocity' },
  { key: 'sync-conflict', label: 'Sync conflicts' },
  { key: 'untagged-backlog', label: 'Untagged' },
  { key: 'personal-subscription-prompt', label: 'Personal subscription' },
  { key: 'over-emission-escalated', label: 'Over-emission' },
]

const SEVERITY_OPTIONS: Array<{ key: InboxSeverityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'info', label: 'Info' },
  { key: 'attention', label: 'Attention' },
  { key: 'urgent', label: 'Urgent' },
]

const STATUS_OPTIONS: Array<{ key: InboxStatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'read', label: 'Read' },
]

defineProps<{
  category: InboxCategoryFilter
  severity: InboxSeverityFilter
  status: InboxStatusFilter
}>()

const emit = defineEmits<{
  (e: 'update:category', value: InboxCategoryFilter): void
  (e: 'update:severity', value: InboxSeverityFilter): void
  (e: 'update:status', value: InboxStatusFilter): void
}>()
</script>

<template>
  <UiCard class="mb-5" data-testid="inbox-filter-bar">
    <div class="flex flex-wrap items-start gap-x-10 gap-y-4">
      <div>
        <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Category
        </div>
        <div class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in CATEGORY_OPTIONS"
            :key="opt.key"
            type="button"
            class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
            :class="
              category === opt.key
                ? 'bg-white text-brand-harmony shadow-sm'
                : 'text-carbon-2 hover:text-brand-harmony'
            "
            :data-testid="`filter-category-${opt.key}`"
            @click="emit('update:category', opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <div>
        <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Severity
        </div>
        <div class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in SEVERITY_OPTIONS"
            :key="opt.key"
            type="button"
            class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
            :class="
              severity === opt.key
                ? 'bg-white text-brand-harmony shadow-sm'
                : 'text-carbon-2 hover:text-brand-harmony'
            "
            :data-testid="`filter-severity-${opt.key}`"
            @click="emit('update:severity', opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <div>
        <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Status
        </div>
        <div class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in STATUS_OPTIONS"
            :key="opt.key"
            type="button"
            class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
            :class="
              status === opt.key
                ? 'bg-white text-brand-harmony shadow-sm'
                : 'text-carbon-2 hover:text-brand-harmony'
            "
            :data-testid="`filter-status-${opt.key}`"
            @click="emit('update:status', opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>
  </UiCard>
</template>
