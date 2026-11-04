<script setup lang="ts">
/*
 * AdminWorkerRunDetail — one worker run's recorded evidence.
 *
 * Why: docs/design/alert-diagnosability.md D5.
 *
 * The contract this component keeps:
 *   - `result.conditions` is the ops-alert shape and gets a real table
 *     (condition · severity · reason · count). `reason` and `correlationId` are
 *     ADDED by D1, so a run recorded before it carries neither: both are
 *     optional and render as an em-dash rather than as an assertion.
 *   - Every OTHER worker's `result` is an arbitrary object. It is rendered, not
 *     interpreted: scalars as a key/value grid, anything nested as formatted
 *     JSON. Guessing at a shape here prints `[object Object]` at an operator
 *     mid-incident.
 *   - A severity outside the known vocabulary still renders (neutral badge).
 *     This component displays a record; it does not validate one.
 */
import { computed } from 'vue'
import { fmtDurationMs } from '../../composables/useFormat'

/** The GET /api/v1/admin/worker-runs/{id} response. */
export interface WorkerRunDetailData {
  id: string
  worker: string
  status: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  rowsAffected?: number | null
  error: string | null
  result: unknown
  warnings: string[]
}

/**
 * One entry of ops-alert's `result.conditions`. `reason` (a closed union, never
 * free text) and `correlationId` arrive with alert-diagnosability D1; `count` is
 * set only by the conditions that carry one. All three are optional here so a
 * run recorded before D1 renders without them.
 */
export interface RunConditionEntry {
  severity: string
  count?: number
  reason?: string
  correlationId?: string
}

const props = defineProps<{ run: WorkerRunDetailData }>()

const EM_DASH = '—'

function isConditionEntry(v: unknown): v is RunConditionEntry {
  // EVERY field is checked, not just severity: an unchecked one renders as
  // `[object Object]` or a coerced number instead of taking the JSON fallback,
  // which is a misleading answer where the fallback would be an honest one.
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const e = v as Record<string, unknown>
  if (typeof e.severity !== 'string') return false
  if (e.reason !== undefined && typeof e.reason !== 'string') return false
  if (e.correlationId !== undefined && typeof e.correlationId !== 'string') return false
  if (e.count !== undefined && typeof e.count !== 'number') return false
  return true
}
function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}
function display(v: unknown): string {
  return v === null ? EM_DASH : String(v)
}
function toJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/** The result only when it is a plain object; anything else falls to raw JSON. */
const resultObject = computed<Record<string, unknown> | null>(() => {
  const r = props.run.result
  return r !== null && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null
})

/*
 * null = there is no conditions map to show (absent, or present but not the
 * shape we claim to understand — then it stays in `otherEntries` and renders as
 * JSON). An EMPTY array is a different fact: ops-alert ran and raised nothing.
 */
const conditionRows = computed<{ key: string, entry: RunConditionEntry }[] | null>(() => {
  const c = resultObject.value?.conditions
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) return null
  const entries = Object.entries(c as Record<string, unknown>)
  if (!entries.every(([, v]) => isConditionEntry(v))) return null
  return entries.map(([key, v]) => ({ key, entry: v as RunConditionEntry }))
})

/** Everything except the conditions map rendered above. */
const otherEntries = computed<[string, unknown][]>(() =>
  Object.entries(resultObject.value ?? {}).filter(
    ([k]) => !(k === 'conditions' && conditionRows.value !== null),
  ),
)
const scalarEntries = computed(() => otherEntries.value.filter(([, v]) => isScalar(v)))
const complexEntries = computed(() => otherEntries.value.filter(([, v]) => !isScalar(v)))

type BadgeKind = 'rag-green' | 'rag-red' | 'rag-amber' | 'neutral'
function severityKind(s: string): BadgeKind {
  if (s === 'critical') return 'rag-red'
  if (s === 'warning') return 'rag-amber'
  return 'neutral'
}

/*
 * The exact millisecond count is the number the incident turned on (5 293 ms
 * against a 5 000 ms budget), so it is shown verbatim beside the human form
 * wherever the human form has rounded it away.
 */
const durationLabel = computed(() => {
  const ms = props.run.durationMs
  if (ms === null) return EM_DASH
  return ms >= 1000 ? `${fmtDurationMs(ms)} (${ms.toLocaleString()} ms)` : fmtDurationMs(ms)
})

/** An instant, not a day bucket — rendered in the viewer's zone (CLAUDE.md, the clock). */
function fmtStamp(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : EM_DASH
}

const hasResult = computed(
  () => conditionRows.value !== null
    || otherEntries.value.length > 0
    || (props.run.result !== null && resultObject.value === null),
)
</script>

<template>
  <div class="pb-3 pl-1 text-sm" data-testid="worker-run-detail">
    <dl class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-carbon-3 mb-3">
      <div class="flex gap-1.5">
        <dt>Duration</dt>
        <dd class="font-mono font-bold text-carbon" data-testid="worker-run-duration">{{ durationLabel }}</dd>
      </div>
      <div class="flex gap-1.5">
        <dt>Started</dt>
        <dd class="text-carbon-2">{{ fmtStamp(run.startedAt) }}</dd>
      </div>
      <div class="flex gap-1.5">
        <dt>Finished</dt>
        <dd class="text-carbon-2">{{ fmtStamp(run.finishedAt) }}</dd>
      </div>
      <div v-if="run.rowsAffected !== null && run.rowsAffected !== undefined" class="flex gap-1.5">
        <dt>Rows</dt>
        <dd class="text-carbon-2">{{ run.rowsAffected }}</dd>
      </div>
    </dl>

    <div v-if="run.warnings.length" class="mb-3" data-testid="worker-run-warnings">
      <div class="text-[11px] uppercase font-bold text-carbon-3 mb-1">Warnings</div>
      <ul class="list-disc list-inside text-brand-hunger text-xs">
        <li v-for="(w, i) in run.warnings" :key="i">{{ w }}</li>
      </ul>
    </div>

    <div
      v-if="run.error"
      class="mb-3 font-mono text-xs text-brand-hunger break-all"
      data-testid="worker-run-error"
    >{{ run.error }}</div>

    <!-- ops-alert: the diagnosis the alert was raised on. -->
    <div v-if="conditionRows && conditionRows.length" class="mb-3 overflow-x-auto">
      <div class="text-[11px] uppercase font-bold text-carbon-3 mb-1">Conditions observed</div>
      <table class="w-full text-xs border-collapse" data-testid="worker-run-conditions">
        <thead>
          <tr class="text-left text-carbon-3">
            <th class="font-bold py-1 pr-4">Condition</th>
            <th class="font-bold py-1 pr-4">Severity</th>
            <th class="font-bold py-1 pr-4">Reason</th>
            <th class="font-bold py-1 text-right">Count</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in conditionRows" :key="c.key">
            <tr class="border-t border-calm-2" :data-testid="`worker-run-condition-${c.key}`">
              <td class="font-mono text-carbon py-1 pr-4 align-top">{{ c.key }}</td>
              <td class="py-1 pr-4 align-top">
                <UiBadge :kind="severityKind(c.entry.severity)">{{ c.entry.severity }}</UiBadge>
              </td>
              <td class="font-mono text-carbon-2 py-1 pr-4 align-top">{{ c.entry.reason ?? EM_DASH }}</td>
              <td class="font-mono text-carbon-2 py-1 text-right align-top">{{ c.entry.count ?? EM_DASH }}</td>
            </tr>
            <!-- The correlation id is what an operator pastes into the provider's
                 own console, so it stays whole and selects in one click. -->
            <tr v-if="c.entry.correlationId" :data-testid="`worker-run-correlation-${c.key}`">
              <td colspan="4" class="pb-1 pl-1 text-[11px] text-carbon-3">
                correlation id
                <code class="font-mono text-carbon-2 select-all break-all ml-1">{{ c.entry.correlationId }}</code>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p
      v-else-if="conditionRows"
      class="mb-3 text-xs text-carbon-3 italic"
      data-testid="worker-run-conditions-empty"
    >
      No conditions raised on this run.
    </p>

    <!-- Any other worker's result: shown as recorded, never interpreted. -->
    <div
      v-if="scalarEntries.length"
      class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1"
      data-testid="worker-run-result-scalars"
    >
      <div
        v-for="[k, v] in scalarEntries"
        :key="k"
        class="flex items-center justify-between gap-2 border-b border-calm-2 py-1"
      >
        <span class="text-carbon-2 font-mono text-xs">{{ k }}</span>
        <span class="text-carbon font-mono text-xs font-bold">{{ display(v) }}</span>
      </div>
    </div>
    <div v-for="[k, v] in complexEntries" :key="k" class="mt-2" data-testid="worker-run-result-json">
      <div class="text-[11px] uppercase font-bold text-carbon-3 mb-1">{{ k }}</div>
      <pre class="overflow-x-auto rounded-md bg-calm-1 text-[11px] leading-relaxed font-mono px-3 py-2 text-carbon-2">{{ toJson(v) }}</pre>
    </div>
    <!-- A result that is not an object at all (a bare array or string) still renders. -->
    <pre
      v-if="run.result !== null && resultObject === null"
      class="overflow-x-auto rounded-md bg-calm-1 text-[11px] leading-relaxed font-mono px-3 py-2 text-carbon-2"
      data-testid="worker-run-result-raw"
    >{{ toJson(run.result) }}</pre>

    <p
      v-if="!hasResult && !run.error"
      class="text-carbon-3 italic text-xs"
      data-testid="worker-run-result-empty"
    >
      No per-run result recorded.
    </p>
  </div>
</template>
