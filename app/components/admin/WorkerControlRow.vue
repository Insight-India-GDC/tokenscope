<script setup lang="ts">
/*
 * One row of the admin "Scheduled worker controls" card.
 *
 * Extracted from the diagnostics page so this contract is unit-testable. It is
 * small but it makes CLAIMS to an operator, and a review caught it making two
 * false ones at once: it rendered a cron for a worker that has no cron job, and
 * offered an enable/disable toggle for a worker that never ticks. Both looked
 * fine in the template and neither could fail a test, because the markup lived
 * inline in a page that cannot be mounted without Nuxt data plumbing.
 *
 * The rule this encodes: `scheduled === false` means NO Container Apps job
 * exists, so there is nothing to turn on or off. Show that plainly instead of
 * implying control that does not exist.
 */
export interface WorkerControlRowData {
  name: string
  /** False = registered but never dispatched (no cron job at all). */
  scheduled: boolean
  unscheduledReason: string | null
  /** Live cron; null when unscheduled. */
  recommendedCron: string | null
  enabled: boolean
  /** Operator's recorded reason for having disabled it. */
  reason: string | null
}

/*
 * Trailing-24 h duty-cycle aggregate for one worker, from
 * GET /api/v1/admin/worker-runs?summary=24h
 * (docs/design/performance-observability-baseline.md O4/dr-H7 — this card is
 * the specified consumer). p50Ms is null when every counted run lacks a
 * duration (reaped rows); absent entirely = the worker had no completed run
 * in the window, rendered as em-dashes, never as zeros.
 *
 * maxMs is rendered beside p50 because a median cannot show a tail: the
 * telemetry-read page of 2026-08-28 was a 5 293 ms run behind a p50 of 1.7 s,
 * and this card showed only the p50 (docs/design/alert-diagnosability.md D5).
 */
export interface WorkerDutyCycleSummary {
  runs: number
  p50Ms: number | null
  maxMs: number | null
  busyMs: number
}

/** ms → 's' under a minute, 'm:ss' from there. Null (no data) is an em-dash. */
function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${total}s`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

withDefaults(
  defineProps<{
    worker: WorkerControlRowData
    busy?: boolean
    /**
     * Whether this row's recent-runs panel is open. The panel itself is the
     * `runs` slot, so this row owns only the disclosure — the page owns which
     * worker is expanded (docs/design/alert-diagnosability.md D5).
     */
    runsOpen?: boolean
    /**
     * Whether THIS viewer may toggle. The write endpoint is platform-admin only
     * (enablement.put.ts) while the read side stays open to `admin`, so a region
     * admin can legitimately see this card and must not be offered a button that
     * would 403 — same rule as the unscheduled case below. Defaults true so the
     * component keeps its old behaviour for any caller that does not care.
     */
    canToggle?: boolean
    /** 24 h duty-cycle aggregate; null/absent = no completed run in the window. */
    summary?: WorkerDutyCycleSummary | null
  }>(),
  { busy: false, runsOpen: false, canToggle: true, summary: null },
)
defineEmits<{ toggle: [], 'toggle-runs': [] }>()
</script>

<template>
  <li
    class="py-2"
    :data-testid="`admin-worker-toggle-${worker.name}`"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <!-- On/Off only means something for a worker that TICKS. -->
          <UiBadge
            v-if="worker.scheduled"
            :kind="worker.enabled ? 'harmony' : 'hunger'"
            data-testid="worker-state-badge"
          >
            {{ worker.enabled ? 'On' : 'Off' }}
          </UiBadge>
          <UiBadge v-else kind="vision" data-testid="worker-unscheduled-badge">Not scheduled</UiBadge>
          <span class="font-mono text-sm text-carbon truncate">{{ worker.name }}</span>
          <span
            v-if="worker.scheduled && worker.recommendedCron"
            class="text-[11px] text-carbon-3 font-mono"
            data-testid="worker-cron"
          >{{ worker.recommendedCron }}</span>
        </div>
        <p v-if="!worker.scheduled" class="text-[11px] text-carbon-3 mt-0.5">
          No cron job — this worker never runs.{{ worker.unscheduledReason ? ` ${worker.unscheduledReason}` : '' }}
        </p>
        <!-- The disabled-reason explains why a RUNNING worker was switched off. For an
             unscheduled worker it would assert a distinction that does not exist (it
             never runs either way), so it is suppressed along with the toggle. A stale
             row from before the API guard can still exist; do not surface it as though
             it governed anything. -->
        <p v-if="worker.scheduled && !worker.enabled && worker.reason" class="text-[11px] text-brand-hunger mt-0.5">
          {{ worker.reason }}
        </p>
      </div>
      <div class="flex items-center gap-4 shrink-0">
        <!-- 24 h duty cycle (O4/dr-H7). No summary = no completed run in the
             window — em-dashes, never zeros: "never ran" is not "ran for 0 ms". -->
        <div
          class="hidden sm:flex items-center gap-3 text-[11px] font-mono text-carbon-3"
          data-testid="worker-duty-cycle"
        >
          <span
            class="w-16 text-right whitespace-nowrap"
            title="Completed runs started in the trailing 24 h"
            data-testid="worker-runs-24h"
          >{{ summary ? `${summary.runs} run${summary.runs === 1 ? '' : 's'}` : '—' }}</span>
          <span
            class="w-20 text-right whitespace-nowrap"
            title="Median run duration over the trailing 24 h"
            data-testid="worker-p50-24h"
          >{{ summary ? `p50 ${fmtMs(summary.p50Ms)}` : '—' }}</span>
          <!-- The tail p50 cannot show. A timeout is a MAX, not a median. -->
          <span
            class="w-20 text-right whitespace-nowrap"
            title="Slowest single run over the trailing 24 h"
            data-testid="worker-max-24h"
          >{{ summary ? `max ${fmtMs(summary.maxMs)}` : '—' }}</span>
          <span
            class="w-24 text-right whitespace-nowrap"
            title="Total busy time over the trailing 24 h (duty cycle)"
            data-testid="worker-busy-24h"
          >{{ summary ? `busy ${fmtMs(summary.busyMs)}` : '—' }}</span>
        </div>
        <!-- The drill-down into what a run actually did. Offered for EVERY worker,
             scheduled or not: the run ledger is a record, and an unscheduled
             worker's empty list is itself the confirmation that it never ran. -->
        <button
          type="button"
          class="text-[11px] font-bold text-brand-vision-ink hover:underline whitespace-nowrap cursor-pointer"
          :aria-expanded="runsOpen"
          data-testid="worker-runs-toggle"
          @click="$emit('toggle-runs')"
        >
          {{ runsOpen ? 'Hide runs' : 'Recent runs' }}
        </button>
        <!-- No toggle when unscheduled: enabling or disabling has no observable
             effect, so offering the button implies control that does not exist.
             Same for a viewer who may not toggle — the API would 403, and a button
             that always fails is a claim of control, not a control. -->
        <UiButton
          v-if="worker.scheduled && canToggle"
          :kind="worker.enabled ? 'secondary' : 'primary'"
          size="sm"
          :disabled="busy"
          data-testid="worker-toggle-button"
          @click="$emit('toggle')"
        >
          {{ busy ? '…' : worker.enabled ? 'Disable' : 'Enable' }}
        </UiButton>
      </div>
    </div>
    <!-- The recent-runs panel, mounted only while open so it fetches on demand
         and never at page setup (admin-nav-responsiveness D1). -->
    <slot v-if="runsOpen" name="runs" />
  </li>
</template>
