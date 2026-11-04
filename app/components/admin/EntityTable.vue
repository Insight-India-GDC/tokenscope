<script setup lang="ts">
/*
 * EntityTable — shared chrome for the Teammates / Projects / Repos tabs.
 *
 * Toolbar: a WORKING client-side search (filters the passed rows) + a single
 * legible "+ Add" CTA that links to a real create page when `addTo` is set.
 * No dead/disabled stub buttons (the old "Upload CSV" + disabled "+ Add" read
 * as broken); when there is no create page, the parent passes guidance text via
 * the `addHint` slot instead of a dead button.
 *
 * ── SELECTION + SORTING (the placement worklist) ───────────────────────────
 * Both are OPT-IN per usage and both are OFF unless the parent asks:
 *   `rowKey`   — set it and a checkbox column appears, with v-model:selected
 *                carrying the chosen keys. Without it the table is exactly what
 *                it was, so Projects/Repos are untouched.
 *   `sortable` — per column. Clicking a header cycles asc → desc → unsorted.
 *
 * Selection and sorting are deliberately CLIENT-SIDE over the loaded window,
 * the same scope the search already had — and the footer already says when that
 * window is truncated. What the header must therefore also do is bound
 * "select all": it selects the FILTERED rows, never a total the client has not
 * loaded, so the count next to the button can never promise rows the bulk action
 * would not be given.
 *
 * A row that leaves the filter KEEPS its selection. Typing in the search box is
 * a navigation, not a deselection — an admin who selects 12 people, refines the
 * search and then acts must not silently act on fewer than they picked. The
 * selection summary states the total so that is visible rather than surprising.
 */
import { ref, computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiButton from '../ui/Button.vue'
import UiEmptyState from '../ui/EmptyState.vue'

export interface EntityColumn<T> {
  key: keyof T | string
  label: string
  render?: (row: T) => string
  /** Header becomes a sort toggle. Sorts on `sortValue` if given, else the cell text. */
  sortable?: boolean
  /** Numeric/temporal sort key — cell TEXT sorts '9' above '10'. */
  sortValue?: (row: T) => number | string
  /** Right-align (money, counts). */
  align?: 'left' | 'right'
}

const props = defineProps<{
  entityLabel: string
  rows: Record<string, unknown>[]
  columns: EntityColumn<Record<string, unknown>>[]
  total?: number
  // When set, the "+ Add" CTA links to a working create page (e.g. Projects →
  // /projects/new). When unset, no add button renders — pass an #addHint slot
  // explaining how that entity is created (e.g. teammates self-onboard).
  addTo?: string
  /** Set to enable selection; returns the stable id of a row. */
  rowKey?: (row: Record<string, unknown>) => string
  /*
   * Override the empty state. A FILTERED view that returns nothing is not an
   * empty region: "This region has no teammates on file" over a region with 513
   * of them, filtered to unplaced, is a false statement about the estate. The
   * parent owns the filter, so the parent owns the sentence.
   */
  emptyHeadline?: string
  emptySub?: string
}>()

const selected = defineModel<string[]>('selected', { default: () => [] })

const query = ref('')
const singular = computed(() => props.entityLabel.toLowerCase().replace(/s$/, ''))
const slug = computed(() => props.entityLabel.toLowerCase())

function cellText(row: Record<string, unknown>, col: EntityColumn<Record<string, unknown>>): string {
  if (col.render) return col.render(row)
  const v = row[col.key as string]
  if (v === null || v === undefined) return '—'
  return String(v)
}

// Functional search: filter rows by any column's rendered text.
const filteredRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.rows
  return props.rows.filter((row) => props.columns.some((c) => cellText(row, c).toLowerCase().includes(q)))
})

// ── Sorting ───────────────────────────────────────────────────────────────
const sort = ref<{ key: string; dir: 'asc' | 'desc' } | null>(null)
function toggleSort(col: EntityColumn<Record<string, unknown>>) {
  if (!col.sortable) return
  const key = String(col.key)
  if (sort.value?.key !== key) sort.value = { key, dir: 'asc' }
  else if (sort.value.dir === 'asc') sort.value = { key, dir: 'desc' }
  else sort.value = null
}
const sortedRows = computed(() => {
  const s = sort.value
  if (!s) return filteredRows.value
  const col = props.columns.find((c) => String(c.key) === s.key)
  if (!col) return filteredRows.value
  // sortValue first — a money column compared as text puts '9.00' above '10.00',
  // which is exactly backwards for "largest spender first".
  const keyOf = (row: Record<string, unknown>) => (col.sortValue ? col.sortValue(row) : cellText(row, col))
  const dir = s.dir === 'asc' ? 1 : -1
  return [...filteredRows.value].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * dir
    return String(ka).localeCompare(String(kb), undefined, { numeric: true }) * dir
  })
})

// ── Selection ─────────────────────────────────────────────────────────────
const selectable = computed(() => props.rowKey != null)
const visibleKeys = computed(() => (props.rowKey ? sortedRows.value.map(props.rowKey) : []))
const selectedSet = computed(() => new Set(selected.value))
const allVisibleSelected = computed(
  () => visibleKeys.value.length > 0 && visibleKeys.value.every((k) => selectedSet.value.has(k)),
)
function toggleRow(key: string) {
  selected.value = selectedSet.value.has(key)
    ? selected.value.filter((k) => k !== key)
    : [...selected.value, key]
}
function toggleAllVisible() {
  if (allVisibleSelected.value) {
    const drop = new Set(visibleKeys.value)
    selected.value = selected.value.filter((k) => !drop.has(k))
  } else {
    selected.value = [...new Set([...selected.value, ...visibleKeys.value])]
  }
}

// Whether the server returned a truncated window (more rows exist than were
// loaded). Search is client-side over the loaded window only, so when truncated
// the footer must say so — otherwise "X of {total}" reads as if all {total} rows
// were searched.
const truncated = computed(() => props.total != null && props.rows.length < props.total)
const searching = computed(() => query.value.trim().length > 0)
const footerNote = computed(() => {
  if (props.total == null) return null
  const lbl = slug.value
  if (searching.value && truncated.value)
    return `${sortedRows.value.length} match in the first ${props.rows.length} of ${props.total} ${lbl} — refine on the server to search the rest.`
  if (searching.value) return `${sortedRows.value.length} of ${props.total} ${lbl} match.`
  if (truncated.value) return `Showing the first ${props.rows.length} of ${props.total} ${lbl}.`
  return null
})
</script>

<template>
  <UiCard flush :data-testid="`entity-table-${slug}`">
    <div class="px-5 pt-5 pb-3 flex flex-wrap items-center gap-3">
      <input
        v-model="query"
        type="search"
        :placeholder="`Search ${slug}…`"
        class="flex-1 min-w-[200px] px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
        :data-testid="`entity-search-${slug}`"
      >
      <slot name="toolbar" />
      <UiButton
        v-if="addTo"
        kind="primary"
        size="sm"
        :to="addTo"
        :data-testid="`entity-add-${slug}`"
      >
        + Add {{ singular }}
      </UiButton>
      <span v-else-if="$slots.addHint" class="text-xs text-carbon-3"><slot name="addHint" /></span>
    </div>

    <!-- Selection bar: only when something is picked, so the default view is
         unchanged. The count is the SELECTION total, not the visible subset. -->
    <div
      v-if="selectable && selected.length"
      class="px-5 py-3 border-t border-calm-2 bg-brand-harmony-sheer/60 flex flex-wrap items-center gap-3"
      :data-testid="`entity-selection-${slug}`"
    >
      <span class="text-sm font-bold text-carbon">
        {{ selected.length }} selected
      </span>
      <UiButton kind="ghost" size="sm" :data-testid="`entity-selection-clear-${slug}`" @click="selected = []">
        Clear
      </UiButton>
      <slot name="selectionActions" :selected="selected" />
    </div>

    <div v-if="rows.length === 0" class="border-t border-calm-2">
      <UiEmptyState
        :headline="emptyHeadline ?? `No ${slug} yet`"
        :sub="emptySub ?? `This region has no ${slug} on file.`"
      />
    </div>
    <div v-else-if="sortedRows.length === 0" class="border-t border-calm-2 px-5 py-8 text-center text-sm text-carbon-3">
      No {{ slug }} match “{{ query }}”.
      <span v-if="truncated" class="block text-[11px] mt-1">Only the first {{ rows.length }} of {{ total }} were searched — refine on the server for the rest.</span>
    </div>
    <div v-else class="overflow-x-auto border-t border-calm-2">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
            <th v-if="selectable" class="px-5 py-3 w-10">
              <input
                type="checkbox"
                class="w-4 h-4 accent-brand-harmony align-middle"
                :checked="allVisibleSelected"
                :aria-label="`Select all listed ${slug}`"
                :data-testid="`entity-select-all-${slug}`"
                @change="toggleAllVisible"
              >
            </th>
            <th
              v-for="c in columns"
              :key="String(c.key)"
              class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3"
              :class="c.align === 'right' ? 'text-right' : 'text-left'"
              :aria-sort="sort?.key === String(c.key) ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined"
            >
              <button
                v-if="c.sortable"
                type="button"
                class="uppercase tracking-[1.2px] font-bold text-carbon-3 hover:text-brand-harmony inline-flex items-center gap-1"
                :data-testid="`entity-sort-${slug}-${String(c.key)}`"
                @click="toggleSort(c)"
              >
                {{ c.label }}
                <span aria-hidden="true">{{ sort?.key === String(c.key) ? (sort.dir === 'asc' ? '▲' : '▼') : '↕' }}</span>
              </button>
              <template v-else>{{ c.label }}</template>
            </th>
            <th v-if="$slots.rowActions" class="px-5 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr
            v-for="(row, idx) in sortedRows"
            :key="rowKey ? rowKey(row) : idx"
            class="hover:bg-brand-harmony-sheer/30"
            :class="selectable && rowKey && selectedSet.has(rowKey(row)) ? 'bg-brand-harmony-sheer/50' : ''"
          >
            <td v-if="selectable && rowKey" class="px-5 py-3 w-10">
              <input
                type="checkbox"
                class="w-4 h-4 accent-brand-harmony align-middle"
                :checked="selectedSet.has(rowKey(row))"
                :aria-label="`Select ${cellText(row, columns[0]!)}`"
                :data-testid="`entity-select-${slug}-${rowKey(row)}`"
                @change="toggleRow(rowKey(row))"
              >
            </td>
            <td
              v-for="c in columns"
              :key="String(c.key)"
              class="px-5 py-3 text-sm text-carbon"
              :class="c.align === 'right' ? 'text-right tabular-nums' : ''"
            >
              {{ cellText(row, c) }}
            </td>
            <td v-if="$slots.rowActions" class="px-5 py-3 text-right whitespace-nowrap">
              <slot name="rowActions" :row="row" />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="footerNote" class="px-5 py-3 text-xs text-carbon-3 border-t border-calm-2">
        {{ footerNote }}
      </div>
    </div>
  </UiCard>
</template>
