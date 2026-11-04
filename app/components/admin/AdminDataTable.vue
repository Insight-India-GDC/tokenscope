<script setup lang="ts">
/*
 * AdminDataTable — minimal table primitive for the Wave-VI admin
 * sub-pages (Users / Audit).
 *
 * Why local instead of app/components/ui/: per the Wave-VI brief, a
 * shared UiTable doesn't exist and shouldn't be invented just for two
 * admin pages. EntityTable (also under app/components/admin/) is too
 * opinionated — it owns search + disabled-add-CTAs and a fixed header
 * shape. This component is a pure header + cell-render renderer with
 * a slot-per-row escape hatch.
 *
 * Type choice: rows are Record<string, unknown> rather than a generic.
 * vue-tsc's defineSlots + generic-script interaction strips the type
 * inside the slot binding anyway; consumers cast in the slot template
 * (or pass `render` for the simple case).
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiEmptyState from '../ui/EmptyState.vue'

export interface AdminColumn {
  key: string
  label: string
  render?: (row: Record<string, unknown>) => string
  /** Tailwind classes applied to <td>. Useful for fixed-width / truncate. */
  cellClass?: string
}

const props = defineProps<{
  rows: Record<string, unknown>[]
  columns: AdminColumn[]
  total?: number
  emptyHeadline?: string
  emptySub?: string
  loading?: boolean
}>()

defineSlots<{
  /** Override the entire <tr>. Receives row + index. */
  row(props: { row: Record<string, unknown>; index: number }): unknown
  /** Pre-row toolbar — search, filters, etc. */
  toolbar(): unknown
}>()

function cellText(row: Record<string, unknown>, col: AdminColumn): string {
  if (col.render) return col.render(row)
  const v = row[col.key]
  if (v === null || v === undefined) return '—'
  return String(v)
}

const showFooter = computed(() => props.total != null && props.rows.length < (props.total ?? 0))
</script>

<template>
  <UiCard flush>
    <div v-if="$slots.toolbar" class="px-5 pt-5 pb-3 flex flex-wrap items-center gap-3 border-b border-calm-2">
      <slot name="toolbar" />
    </div>
    <!-- Absent-data state: pulse rows, announced via aria-busy (smoke-gate contract, D2). -->
    <div v-if="loading" class="px-5 py-6 animate-pulse space-y-2" data-testid="admin-skeleton" aria-busy="true" role="status">
      <span class="sr-only">Loading…</span>
      <div v-for="r in 6" :key="r" class="h-8 rounded-md bg-calm-1" />
    </div>
    <UiEmptyState
      v-else-if="rows.length === 0"
      :headline="emptyHeadline ?? 'No rows'"
      :sub="emptySub ?? 'No data matches the current filters.'"
    />
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
            <th
              v-for="c in columns"
              :key="c.key"
              scope="col"
              class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3 whitespace-nowrap"
            >
              {{ c.label }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <template v-for="(row, idx) in rows" :key="idx">
            <slot name="row" :row="row" :index="idx">
              <tr class="hover:bg-brand-harmony-sheer/30">
                <td
                  v-for="c in columns"
                  :key="c.key"
                  class="px-5 py-3 text-sm text-carbon"
                  :class="c.cellClass"
                >
                  {{ cellText(row, c) }}
                </td>
              </tr>
            </slot>
          </template>
        </tbody>
      </table>
      <div v-if="showFooter" class="px-5 py-3 text-xs text-carbon-3 border-t border-calm-2">
        Showing {{ rows.length }} of {{ total }}.
      </div>
    </div>
  </UiCard>
</template>
