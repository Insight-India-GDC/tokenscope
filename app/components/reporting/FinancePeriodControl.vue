<script setup lang="ts">
/*
 * FinancePeriodControl — the period selector for the Finance (§B chargeback /
 * reconciliation) scope. Finance is inherently RETROSPECTIVE: you can only charge
 * back a COMPLETE billing period, never a month in progress or an arbitrary rolling
 * day-window. So Finance does NOT use the shared day-range DateRangeControl (whose
 * "This month" / "Last 30 days" presets are meaningless — and misleading here: a
 * cleared range lit "This month" while the report actually showed last month).
 *
 * Instead this offers COMPLETE periods only — full calendar months and full
 * quarters — defaulting to the last complete month. It self-wires to useReportState:
 * a month writes `?month` (clearing from/to); a quarter writes the whole-quarter
 * `?from`/`?to` range (the finance endpoint sums the period_months it spans),
 * clearing `?month`.
 */
import { computed } from 'vue'
import { useReportState } from '../../composables/useReportState'
import { lastCompleteMonth } from './period-presets'

const rs = useReportState()

/*
 * "Last complete month" comes from the SERVER's clock (F1/D3). This file used to
 * hold its own `lastCompleteMonth(now = new Date())` — with an injectable seam
 * that no caller ever used — and ScopeFinance held a BYTE-IDENTICAL copy, plus
 * two admin pages. Four definitions of the same month, agreeing by luck. Finance
 * defaults are the last place a period should be a browser opinion.
 *
 * Empty until the clock lands: the selector renders, the option list does not
 * name months nobody has vouched for.
 */
const { today } = useServerClock()
const lastComplete = computed(() => (today.value ? lastCompleteMonth(today.value) : null))

function monthLong(m: string): string {
  const d = new Date(`${m}-01T00:00:00.000Z`)
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
function monthShort(m1: number): string {
  return new Date(Date.UTC(2000, m1 - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
}

// ── Complete months: last 12, newest first ───────────────────────────────────
const months = computed(() => {
  if (!lastComplete.value) return []
  const y0 = Number(lastComplete.value.slice(0, 4))
  const m0 = Number(lastComplete.value.slice(5, 7))
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y0, m0 - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    return { value: `m:${key}`, label: monthLong(key) }
  })
})

// ── Complete quarters: the last 4 whose END month ≤ last complete month ───────
const quarters = computed(() => {
  if (!lastComplete.value) return []
  const y0 = Number(lastComplete.value.slice(0, 4))
  const m0 = Number(lastComplete.value.slice(5, 7))
  let endAbs = y0 * 12 + (m0 - 1) // 0-based absolute month index of the last complete month
  while (((endAbs % 12) % 3) !== 2) endAbs-- // step back to a quarter-END month (Mar/Jun/Sep/Dec)
  return Array.from({ length: 4 }, (_, i) => {
    const idx = endAbs - i * 3
    const ey = Math.floor(idx / 12)
    const em = (idx % 12) + 1 // 1-based end month (3/6/9/12)
    const q = em / 3 // 1..4
    const sm = em - 2 // start month
    const lastDay = new Date(Date.UTC(ey, em, 0)).getUTCDate()
    return {
      value: `q:${ey}-${q}`,
      label: `Q${q} ${ey} · ${monthShort(sm)}–${monthShort(em)}`,
      from: `${ey}-${String(sm).padStart(2, '0')}-01`,
      to: `${ey}-${String(em).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    }
  })
})

// Which option is active. A quarter when the URL range exactly matches one; else the
// selected month (or the last-complete default when nothing is set).
const selected = computed(() => {
  if (rs.from.value && rs.to.value) {
    const q = quarters.value.find((x) => x.from === rs.from.value && x.to === rs.to.value)
    if (q) return q.value
  }
  const m = rs.month.value ?? lastComplete.value
  return m ? `m:${m}` : ''
})

function onChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v.startsWith('m:')) {
    rs.patch({ month: v.slice(2), from: null, to: null })
  } else {
    const q = quarters.value.find((x) => x.value === v)
    if (q) rs.patch({ from: q.from, to: q.to, month: null })
  }
}
</script>

<template>
  <label class="inline-flex items-center gap-2" data-testid="finance-period-control">
    <span class="text-[11px] font-semibold uppercase tracking-wide text-carbon-3">Billing period</span>
    <select
      :value="selected"
      class="border border-calm-2 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-carbon-1 focus:border-brand-harmony cursor-pointer"
      data-testid="finance-period-select"
      @change="onChange"
    >
      <optgroup label="Month">
        <option v-for="m in months" :key="m.value" :value="m.value">{{ m.label }}</option>
      </optgroup>
      <optgroup label="Quarter">
        <option v-for="q in quarters" :key="q.value" :value="q.value">{{ q.label }}</option>
      </optgroup>
    </select>
  </label>
</template>
