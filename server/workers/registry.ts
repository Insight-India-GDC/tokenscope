/*
 * Worker registry — single source of truth mapping worker name to its
 * runner function. Used by both the internal HTTP endpoint
 * (POST /api/v1/internal/run-worker/{name}) and the run-worker CLI
 * (scripts/run-worker.ts).
 *
 * To add a new worker:
 *   1. Implement and export `runFoo` in server/workers/foo.ts.
 *   2. Add `{ name: 'foo', run: runFoo }` to WORKERS below.
 *   3. Document the recommended cron cadence in the external scheduler
 *      config (docs/build/worker-scheduler.md).
 *
 * Why a static registry instead of dynamic discovery: predictability.
 * The set of runnable worker names is auditable in one place, and the
 * HTTP endpoint can reject unknown names without ever loading their
 * code.
 */
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { runAggregateRollup } from './aggregate-rollup'
import { runUsageRollup } from './usage-rollup'
import { runArchiveLedger } from './archive-ledger'
import { runAnalyticsPollReconciledOrgs, sourceForOrg } from './analytics-poller'
import { runPlacementSync } from './placement-sync'
import { runRegionReenrichment } from './region-reenrichment'
import { runPlacementCheck, runScheduledPlacementCheck } from './placement-check'
import { runPrivilegedIdentityCleanup } from './privileged-identity-cleanup'
import { runPendingPlacementGc } from './pending-placement-gc'
import {
  runReadJoiner,
  selectJoinableInstances,
  recordJoinerSelectionCap,
  type JoinResult,
} from './azure-monitor-reader'
import { runBudgetAlert } from './budget-alert'
import { runConnectorHealth } from './connector-health'
import { runEndingSoon } from './ending-soon'
import { runHeartbeatCoverage } from './heartbeat-coverage'
import { runAttributionGap } from './attribution-gap'
import { runMitigationQuery } from './mitigation-query'
import { runReconciliation } from './reconciliation'
import { runCopilotPoolBill } from './copilot-pool-bill'
import { runReconciliationGap } from './reconciliation-gap'
import { runReconciliationSync } from './reconciliation-sync'
import { runReconciliationBackfill } from './reconciliation-backfill'
import { runTelemetryRecovery } from './telemetry-recovery'
import { runIdentitySync } from './identity-sync'
import { runUsageReconciliation } from './usage-reconciliation'
import { runSessionGc } from './session-gc'
import { runSoftPurge } from './soft-purge'
import { runVelocityWatch } from './velocity-watch'
import { runWentSilent } from './went-silent'
import { runReadPathHealth } from './read-path-health'
import { runGovernanceKeyBackfill } from './governance-key-backfill'
import { runGovernanceRecompute } from './governance-recompute'
import { runGithubCoverageSweep } from './github-coverage-sweep'
import { runProviderTransform } from './provider-transform'
import { runOpsAlert } from './ops-alert'
import { getTelemetryReader, emptyParseCounters } from '../azure/reader'
import { readSourceCoverage, type SourceCoverage } from '../azure/dcr-metrics'
import { UI_TRIGGERABLE_WORKER_NAMES } from '../../shared/workers/ui-triggerable'

type Db = PostgresJsDatabase<typeof schema>

/** Per-dispatch context the run-worker endpoint passes to a worker. Optional so
 * existing `run: runFoo` entries (which ignore it) stay assignable. */
export interface WorkerRunContext {
  /** worker_run.id for this dispatch — workers that write the reconciliation ledger
   * stamp it onto reconciliation_record.run_id. Null if the run-start insert failed. */
  runId: string | null
  /**
   * Optional per-dispatch options parsed from the (signed) request body. Generic
   * and optional so workers that ignore it are unaffected. Today only
   * azure-monitor-read reads `opts.deepRescan` — it lets an operator FORCE a
   * full-window re-read (a one-off Container Apps job execution with
   * DEEP_RESCAN=true) to recover a read-path backlog. The body is inside the signed HMAC payload
   * (server/auth/internal-request.ts), so this is tamper-proof.
   */
  opts?: {
    deepRescan?: boolean
    // azure-monitor-read: widen the reader's OUTER scan bound past the 7-day
    // default (max 90). The recovery lever for a backlog older than a week —
    // without it a signed re-run recovers only the last 7 days and reports
    // success indistinguishably from a full recovery.
    lookbackDays?: number
    // azure-monitor-read: scope a recovery re-run to specific instance ids
    // instead of the scheduled selection.
    sessionIds?: string[]
    // privileged-identity-cleanup: destructive apply gate (default report-only).
    // Only reachable via the signed HMAC worker body, never the UI trigger.
    apply?: boolean
    // analytics-poll: explicit YYYY-MM-DD window override (validated by
    // workerOptsSchema) — the #142 historical re-split lever. Both must be set
    // and form a valid span; otherwise the default trailing window applies.
    startingAt?: string
    endingAt?: string
    // analytics-poll: scope the poll to ONE reconciled org's external id.
    // Strongly recommended alongside a window override — an unscoped override
    // re-pulls every reconciled org serially against the shared 60-RPM cap.
    externalOrgId?: string
    // placement-check: re-gather only this cycle's failed lookups.
    retryFailed?: boolean
    // Set by the run-worker endpoint (the scheduler), never parsed from the body.
    // placement-check: run the scheduled read instead of one admin-page pass.
    scheduled?: boolean
  }
}

export interface WorkerEntry {
  name: string
  run: (db: Db, ctx?: WorkerRunContext) => Promise<unknown>
  /*
   * The cron cadence this worker runs on. Named "recommended" from when the
   * scheduler was external and this was informational — it is NOT informational
   * any more: the admin worker-controls card shows it to operators as the live
   * schedule, and worker-schedule-lockstep asserts it EQUALS the deployed cron in
   * infra/modules/worker-jobs.bicep. Change one, change both, or CI fails.
   *
   * Meaningless for workers in UNSCHEDULED_WORKERS (they have no job at all); the
   * enablement API suppresses it for those rather than imply a schedule.
   */
  recommendedCron: string
  description: string
}

/*
 * Anthropic cost data is NOT final on the day it's reported: the Enterprise
 * Analytics API states values "may be revised for up to 30 days as late events
 * arrive." A start-of-CURRENT-month poll window therefore ORPHANED late
 * prior-month revisions the moment the month rolled over — e.g. on June 1+ a
 * revision to a May 28 charge was never re-pulled, so actual_spend (the
 * bill-anchored money surface, mig 0059) silently under/over-counted that day
 * forever. Re-pull a TRAILING window that crosses the month boundary instead.
 *
 * 30 days = the documented revision horizon. The Analytics API returns
 * idempotent daily rows, so re-polls upsert (progressively-correct actuals) —
 * widening the window only re-states days that may still move, never duplicates.
 *
 * SCALE NOTE: at many reconciled orgs this is days×calls per 15-min tick against
 * the 60-RPM org cap (enterprise path = 2 serialized calls/day). If that bites,
 * split into a short frequent window + a daily deep 30-day re-pull (delta-driven
 * — back off days where bill==recorded). See
 * docs/design/bill-anchored-reconciliation-and-existence.md §5 (L1). Pure +
 * exported for unit testing (run() uses `new Date()` directly otherwise).
 */
export const ANTHROPIC_REVISION_WINDOW_DAYS = 30

export function analyticsPollWindow(now: Date): { startingAt: string; endingAt: string } {
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - ANTHROPIC_REVISION_WINDOW_DAYS)
  return {
    startingAt: start.toISOString().slice(0, 10),
    endingAt: now.toISOString().slice(0, 10),
  }
}

export const WORKERS: ReadonlyArray<WorkerEntry> = [
  {
    name: 'analytics-poll',
    run: (db, ctx) => {
      /*
       * Scheduler entrypoint: poll every RECONCILED Anthropic org (each with its
       * own admin key) over the trailing revision window (see
       * analyticsPollWindow). With zero reconciled orgs this is a clean no-op (it
       * does NOT require NUXT_ANTHROPIC_API_ENDPOINT) — so the scheduled job
       * succeeds until a reconciled org + key is onboarded.
       *
       * A signed { startingAt, endingAt } body (or `--opts` via the CLI)
       * overrides the window — the #142 historical re-split lever: re-pulling a
       * pre-split period rewrites its collapsed claude-code rows as per-surface
       * lanes. Honoured only as a PAIR forming a valid span; anything else falls
       * back to the auto window (fail-soft, like every other worker opt).
       * An override re-pulls EVERY reconciled org unless scoped with
       * { externalOrgId } — scope it: the Enterprise API's 60-RPM org-wide cap
       * is shared with reconciliation-sync, and a long unscoped re-pull starves it.
       */
      const { startingAt, endingAt, externalOrgId } = ctx?.opts ?? {}
      const window =
        startingAt && endingAt && startingAt <= endingAt
          ? { startingAt, endingAt }
          : analyticsPollWindow(new Date())
      return runAnalyticsPollReconciledOrgs(db, window, { onlyExternalOrgId: externalOrgId })
    },
    recommendedCron: '*/15 * * * *',
    description:
      'Poll reconciled Anthropic orgs for new actual_spend rows (per-surface lanes; signed {startingAt,endingAt,externalOrgId} body re-pulls history, scoped to one org)',
  },
  {
    name: 'placement-sync',
    run: (db) => runPlacementSync(db),
    recommendedCron: '*/30 * * * *',
    description: 'Provision+place cost-bearing users from the owed-bill queue (bill-driven placement)',
  },
  {
    name: 'region-reenrichment',
    run: (db) => runRegionReenrichment(db),
    recommendedCron: '0 */6 * * *',
    description: 'Re-derive region for bill teammates on a holding node (mig 0068 heal/backfill; rehome-safe only)',
  },
  {
    name: 'placement-check',
    run: (db, ctx) =>
      ctx?.opts?.scheduled === true
        ? runScheduledPlacementCheck(db)
        : runPlacementCheck(db, { retryFailed: ctx?.opts?.retryFailed === true }),
    recommendedCron: '17 * * * *',
    description:
      'Hourly: once the top of the organisation is set in Org setup, start a placement-check cycle when the monthly or weekly re-read is due, gather directory evidence (attributes + full manager chain) for up to 150 people not yet checked in it, and once everyone is read look up each active unit owner and region leader. The admin page runs the same pass on demand; {retryFailed:true} re-gathers only failed lookups (docs/design/org-setup/00-spec.md)',
  },
  {
    name: 'privileged-identity-cleanup',
    // REPORT-only from the scheduler (no apply flag): counts + audits teammate
    // rows matching the directory-exclusion policy. Destructive apply is
    // cron/CLI/HMAC-only via a signed body {apply:true} + hard cap — never the
    // one-click UI (excluded from UI_TRIGGERABLE_WORKER_NAMES). See the worker.
    run: (db, ctx) => runPrivilegedIdentityCleanup(db, { apply: ctx?.opts?.apply === true }),
    recommendedCron: '30 4 * * *',
    description: 'Report/clean teammate rows matching the directory-exclusion policy (#121; report-only unless a signed {apply:true} body + cap)',
  },
  {
    name: 'pending-placement-gc',
    run: (db) => runPendingPlacementGc(db),
    recommendedCron: '0 4 * * *',
    description: 'GC replayed owed bills from pending_placement (mig 0066) past the 90-day retention window',
  },
  {
    name: 'azure-monitor-read',
    run: async (db, ctx) => {
      // The tick's start: JOINER_DEADLINE_MS is measured from here, so the
      // coverage probe and the selection below count against it.
      const tickStartedAtMs = Date.now()
      /*
       * Scheduler entrypoint: scan the last 24h of instance_attestation rows
       * still needing a (re)join — active sessions (re-scanned each tick for
       * new spend) + ended-but-unattributed ones. Bounded by runReadJoiner's
       * own 24h default; explicit sessionIds keep us safe on production-scale
       * tables (per R1 sweep F2).
       */
      // RECOVERY override: an operator may scope a signed re-run to specific
      // instances (ctx.opts.sessionIds) instead of the scheduled selection. A
      // targeted pass then pairs with lookbackDays below to reach a backlog older
      // than the reader's 7-day default. No selection ran, so there is no cap to
      // report.
      const override = ctx?.opts?.sessionIds
      const scoped = Boolean(override && override.length > 0)
      // INGEST-SIDE COVERAGE PROBE (PR #319). Runs BEFORE selection so it also
      // measures the selection-dead-zone shape (fleet emitting, nothing
      // selected). Fail-soft: readSourceCoverage never throws — every fault is a
      // 'unknown' verdict — but a belt-and-braces catch keeps a probe fault from
      // ever being the reason attribution stops. Only on the SCHEDULED path: a
      // scoped recovery run is excluded from the stall streak, so its coverage is
      // never read. See docs/design/read-path-attribution-coverage-signal.md.
      let sourceCoverage: SourceCoverage | null = null
      if (!scoped) {
        try {
          sourceCoverage = await readSourceCoverage({
            dcrResourceId: process.env.NUXT_AZURE_DCR_RESOURCE_ID,
            miClientId: process.env.NUXT_AZURE_MI_CLIENT_ID,
          })
        } catch (e) {
          consola.error('[azure-monitor-read] source-coverage probe threw; attribution is unaffected', e)
          sourceCoverage = null
        }
      }
      const { ids: sessionIds, capHit } =
        scoped ? { ids: override!, capHit: null } : await selectJoinableInstances(db)
      // Raise/clear the fleet-level signal for a truncated selection. ONLY on the
      // scheduled path: a scoped override ran no selection, so its `capHit: null`
      // is an absence of evidence, and letting it reach the recorder would
      // auto-resolve a live signal mid-outage — the same trap read-path-health
      // documents for scoped runs. Fenced like the stale-dismissal sweep: this is
      // observability, and it must never be the reason attribution stops.
      if (!scoped) {
        try {
          await recordJoinerSelectionCap(db, capHit)
        } catch (e) {
          consola.error('[azure-monitor-read] selection-cap signal failed; attribution is unaffected', e)
        }
      }
      // Scheduled ticks never deep-read: the daily re-read of late telemetry is
      // telemetry-recovery's scheduled request, drained one instance-day at a
      // time under its own lock (docs/design/bounded-daily-deep-read.md). Only an
      // operator's signed body (ctx.opts.deepRescan) forces a full-window read here.
      const deepRescan = ctx?.opts?.deepRescan ?? false
      if (sessionIds.length === 0) {
        // `satisfies JoinResult` is the enforcement of the "never omit the
        // object" convention below: this literal drifted from JoinResult twice
        // (parseCounters / telemetryOnlySpend / staleDismissalsReturned were all
        // added to the interface and never here) because WorkerEntry.run returns
        // Promise<unknown>, so nothing type-checked the empty tick. Now a new
        // JoinResult field is a compile error here until it is given its zero.
        return {
          sessionsProcessed: 0,
          attributionRowsWritten: 0,
          // No reader ran, so nothing was fetched or seen past a watermark.
          usageRowsFetched: 0,
          newEventsSeen: 0,
          // The ingest-side probe DID run (before selection), so an empty tick
          // still carries a real coverage measurement — this is the row-11
          // (selection-dead-zone) case the stall alerts must still page on.
          sourceCoverage,
          // Nothing was read, so no dismissal could be handed back.
          staleDismissalsReturned: 0,
          spansSkippedNoRateCard: 0,
          // No reader was constructed, so the ingest boundary rejected nothing.
          parseCounters: emptyParseCounters(),
          // No rows were written, so no (region, day) carries telemetry-only spend
          // this tick. Empty ARRAY, never omitted — a consumer summing it must not
          // have to special-case the empty tick.
          telemetryOnlySpend: [],
          // No spans were considered, so every rung is zero (never omit the
          // object — a consumer reading result.costingRungs.provider must not
          // have to special-case the empty tick).
          costingRungs: { provider: 0, rateCard: 0, carrier: 0, skipped: 0 },
          spansSpilledUnauthorized: 0,
          sessionRecordsRepointed: 0,
          sessionReportsRefused: 0,
          projectFallbackRetries: 0,
          spansSpilledEnded: 0,
          errors: 0,
          // Nothing was read, so nothing was deep-read.
          deepRescan: false,
          signalRowsWritten: 0,
          // An empty selection cannot have hit the cap.
          selectionCapHit: null,
          // No reader was constructed and no query ran, so there is no applied window.
          lookbackDaysApplied: null,
          scoped: false,
          signalErrors: 0,
          devicesSelected: 0,
          devicesAttempted: 0,
          deadlineHit: false,
          // No device was selected, so there is no read age to report.
          oldestReadAgeMinutes: null,
          devicesNeverRead: 0,
          // No device was attempted, so no stamp was tried.
          rotationStampFailed: false,
          heapUsedPeakMb: null,
        } satisfies JoinResult
      }
      // lookbackDays widens the reader's OUTER scan bound (default 7d). Without
      // it, a "recovery" re-run silently reaches back only a week and reports
      // success — the failure mode that made a weeks-long backlog look
      // unrecoverable after the dead-zone incident.
      const reader = getTelemetryReader({ lookbackDays: ctx?.opts?.lookbackDays })
      return runReadJoiner(db, reader, {
        sessionIds,
        deepRescan,
        selectionCapHit: capHit,
        // The pre-selection ingest coverage verdict, echoed into JoinResult.
        sourceCoverage,
        // lookbackDaysApplied is read back from the reader inside runReadJoiner —
        // recomputing it here would let the reported and applied windows diverge.
        // Same `scoped` the cap-signal gate above reads, for the same reason.
        scoped,
        // Only the scheduled read moves a device to the back of the rotation
        // (mig 0149). An operator's scoped run did not come from the selection,
        // and a forced deep read is an operator's out-of-band pass; neither
        // touches joiner_read_at. telemetry-recovery calls runReadJoiner
        // directly and never sets it.
        stampReadAt: !scoped && !deepRescan,
        startedAtMs: tickStartedAtMs,
      })
    },
    recommendedCron: '*/5 * * * *',
    description: 'Join recent OTel spans into attribution_record',
  },
  {
    name: 'mitigation-query',
    run: (db) => runMitigationQuery(db),
    recommendedCron: '*/30 * * * *',
    description: 'Re-evaluate active mitigations against current spend',
  },
  {
    name: 'reconciliation',
    run: (db) => runReconciliation(db),
    recommendedCron: '0 */1 * * *',
    description: 'Detect OTel-vs-Anthropic attribution gaps, emit untagged-backlog items',
  },
  {
    name: 'reconciliation-gap',
    run: (db) => runReconciliationGap(db),
    recommendedCron: '0 */6 * * *', // every 6h — the safety-net alert, not a per-minute control
    description:
      'Raise a first-class reconciliation-gap alert when OTel-attributed vs Anthropic-actuals diverges past the bar (ADR-0005 §4)',
  },
  {
    name: 'reconciliation-sync',
    run: (db, ctx) => runReconciliationSync(db, { runId: ctx?.runId ?? null }),
    recommendedCron: '0 */1 * * *', // hourly freshness; daily-grain truth, monthly invoice true-up
    description:
      'Pull vendor billing via the registered adapters (Anthropic, GitHub) and reconcile into reconciliation_record, for every org or enterprise with a credential',
  },
  {
    name: 'identity-sync',
    run: (db) => runIdentitySync(db),
    recommendedCron: '0 3 * * *', // daily — seed teammate_identity_map from provider directories
    description:
      'Seed teammate_identity_map from provider seats/SCIM directories via the registered resolvers (GitHub today)',
  },
  {
    name: 'usage-reconciliation',
    run: (db) => runUsageReconciliation(db),
    recommendedCron: '0 */2 * * *', // every 2h — refresh per-day API-minus-OTel unaccounted usage
    description:
      'Reconcile provider API usage truth vs OTel-captured per (teammate, day); upsert the taggable "unaccounted usage" records, detect over-emission, and lift any developer quarantine whose conversation strayed outside its flag\'s (UTC day, tool) cell, escalating the flag, and send each newly escalated flag to its region admins\' inbox (provider-billing-attribution-model.md §A)',
  },
  {
    name: 'reconciliation-backfill',
    run: (db, ctx) => runReconciliationBackfill(db, { runId: ctx?.runId ?? null }),
    recommendedCron: '*/15 * * * *', // drain the on-demand backfill queue (mig 0074); one request/tick
    description:
      'Drain the admin backfill queue: pull a historical window for one credential scope + run §A reconcile so older days surface as unaccounted usage (provider-billing-attribution-model.md §A)',
  },
  {
    name: 'telemetry-recovery',
    run: (db, ctx) => runTelemetryRecovery(db, { runId: ctx?.runId ?? null }),
    // Every 5 minutes: a request drains one budget of instance-days per tick, so
    // the cadence IS the drain rate. At rest the tick is two indexed queries.
    recommendedCron: '*/5 * * * *',
    description:
      'Drain widened re-reads one instance-day at a time: operator recoveries and the scheduled daily 7-day pass that recovers late telemetry (mig 0093, 0148)',
  },
  {
    name: 'copilot-pool-bill',
    run: (db) => runCopilotPoolBill(db),
    recommendedCron: '0 5 * * *', // daily — Copilot is month-grain + settles slowly; a daily re-read
    description:
      'Read the enterprise billing usage report → write the POOLED Copilot chargeback (copilot_pool_bill), homed org→CoU. A reader, not a calculator (provider-billing-attribution-model.md §B).',
  },
  {
    name: 'ending-soon',
    run: (db) => runEndingSoon(db),
    recommendedCron: '0 8 * * *', // daily 8am UTC — a proactive heads-up, not a control loop
    description:
      'Warn devs assigned to / contributing on a project entering its end_date window (D3); one inbox item per (dev, project)',
  },
  {
    name: 'session-gc',
    run: (db) => runSessionGc(db),
    recommendedCron: '0 2 * * *',
    description: 'Garbage-collect expired session attestations',
  },
  {
    name: 'soft-purge',
    run: (db) => runSoftPurge(db),
    recommendedCron: '0 3 * * *',
    description: 'Apply soft-deletion retention to expired rows',
  },
  {
    name: 'archive-ledger',
    // OFF unless LEDGER_ARCHIVE_ENABLED=true — exports cold attribution_record
    // partitions to warm storage (after rollup + export verify) then DETACH+DROP.
    run: (db) => runArchiveLedger(db),
    recommendedCron: '0 4 1 * *', // monthly, 1st at 04:00 UTC
    description: 'Archive cold attribution_record partitions to warm storage + retire (off by default)',
  },
  {
    name: 'aggregate-rollup',
    // Self-bootstrapping: an empty attribution_aggregate (first deploy)
    // triggers a 90-day backfill instead of the incremental 2-day window.
    run: (db) => runAggregateRollup(db),
    recommendedCron: '*/15 * * * *',
    description:
      'Materialise attribution_aggregate (teammate/project × day × tool × model × token_type) — the consumption-dashboard read path',
  },
  {
    name: 'usage-rollup',
    // Full-history backfill RESUMES across runs (bounded chunks per
    // invocation — the dispatch budget); steady state recomputes a NARROW
    // trailing window with one wide pass per UTC day
    // (docs/design/usage-rollup-lane.md; performance-observability-baseline.md
    // O5). Minutes ≡ 2 (mod 5) avoid simultaneous STARTS with the */5 and
    // */15 pollers — starts only, NOT overlap: dispatches can run ~200 s
    // (dr-M6; O4's duty-cycle numbers verify the offset helps).
    run: (db) => runUsageRollup(db),
    recommendedCron: '7,22,37,52 * * * *',
    description:
      'Materialise usage_rollup_daily from v_complete_usage (day-grain §A) — the region reporting read path',
  },
  {
    name: 'velocity-watch',
    run: (db) => runVelocityWatch(db),
    // Sunday 23:50 UTC — the last 10 minutes of the ISO week, NOT Monday morning.
    // The worker compares the week CONTAINING `now` against the 4 full trailing
    // weeks, so at Monday 09:00 the "current week" is 9 hours old and a dev would
    // have to burn 1.25 weeks of spend before lunch to clear mean x threshold: the
    // job would run green and structurally never fire. Evaluate the week when it
    // is complete.
    recommendedCron: '50 23 * * 0',
    description: 'Detect per-teammate weekly velocity above 25% over 4-week trailing mean',
  },
  {
    name: 'connector-health',
    run: (db) => runConnectorHealth(db),
    recommendedCron: '*/30 * * * *',
    description: 'Emit sync-conflict items from pending sync_conflict rows',
  },
  {
    name: 'budget-alert',
    run: (db) => runBudgetAlert(db),
    // HOURLY, not */15: the threshold it evaluates is month-grain, so a quarter-hour
    // cadence buys nothing and costs 4x the dispatches
    // (docs/design/stranded-workers-lifecycle.md). Asserted equal to the deployed
    // cron by worker-schedule-lockstep — admins are shown this as the live schedule.
    recommendedCron: '0 * * * *',
    description: 'Scan complete spend (Claude + Copilot) vs allocation, emit over-budget inbox items',
  },
  {
    name: 'went-silent',
    run: (db) => runWentSilent(db),
    recommendedCron: '0 */1 * * *', // hourly — surface a credential-rejection within the hour
    description:
      'Alert the owning teammate when a live instance\'s emit credential is being rejected at /bearer (bearer-auth-failed); auto-resolve on recovery',
  },
  {
    name: 'read-path-health',
    run: (db) => runReadPathHealth(db),
    // Recommended: every ~15 min. went-silent only catches WRITE/emit-credential
    // silence (bearer-auth-failed); THIS worker catches the READ-path outage
    // (the azure-monitor-read gatherer dead while clients still emit) that went
    // undetected for ~5.5 days. Reads the persisted worker_run ledger only — it
    // does NOT re-run the gatherer. Cron wiring is infra (lead to schedule).
    recommendedCron: '*/15 * * * *',
    description:
      'Alert admins when the OTel read path (azure-monitor-read) has silently stalled/failed while clients still emit; auto-resolve on recovery',
  },
  {
    name: 'attribution-gap',
    run: (db) => runAttributionGap(db),
    // Every ~30 min. The PER-INSTANCE counterpart to read-path-health: that
    // worker gates on FLEET-wide signals (a zero-write streak, MAX(last_bearer_at)
    // across every instance), so a SINGLE starved instance never moves it. The
    // 2026-07-24 dead-zone outage was invisible to every existing alarm for 19
    // days because of exactly that gap.
    recommendedCron: '*/30 * * * *',
    description:
      'Alert admins when an individual device is minting ingest credentials (so it is emitting) while its attribution has fallen days behind — the silent "spend goes nowhere" outage class; auto-resolves when the gap closes',
  },
  {
    name: 'heartbeat-coverage',
    run: (db) => runHeartbeatCoverage(db),
    recommendedCron: '*/30 * * * *', // every 30 min — the EARLY detection leg before reconciliation (~1h+)
    description:
      'Quarantine "unverified spend" — sessions whose claimed instance has no covering /bearer heartbeat (cross-instance-spoof signal). Informational only; never auto-revokes (MCP backbone §heartbeat-coverage)',
  },
  {
    name: 'governance-key-backfill',
    run: (db) => runGovernanceKeyBackfill(db),
    // Bounded/resumable historical backfill (design §8.4) — money-adjacent bulk
    // UPDATE, so cron/HMAC-only (NOT in UI_TRIGGERABLE_WORKER_NAMES). Hourly is
    // plenty; the backlog converges to empty after the first few runs post-deploy.
    recommendedCron: '0 * * * *',
    description:
      'Resolve provider_org_id/provider_enterprise_id governance keys on historical actual_spend/reconciliation_record/pending_placement rows the ingest-time writers could not stamp; parks truly-unresolvable rows for operator review (docs/design/usage-completeness-and-provider-governance.md §8.4)',
  },
  {
    name: 'governance-recompute',
    run: (db) => runGovernanceRecompute(db),
    // Periodic catch-up for the chargeback verdict (design §4.1), resuming from
    // a persisted cursor. Money-adjacent bulk UPDATE — cron/HMAC-only.
    recommendedCron: '*/15 * * * *',
    description:
      'Recompute actual_spend.chargeback_exempt in every period from authoritative provider_org/provider_enterprise.billing, resuming from a persisted (date, id) cursor and wrapping to the oldest row at the end; personal declarations never participate (docs/design/usage-completeness-and-provider-governance.md §4.1/§8.4)',
  },
  {
    name: 'github-coverage-sweep',
    run: (db) => runGithubCoverageSweep(db),
    // Hourly — comfortably inside the persisted-observation TTL (3h,
    // coverage-store.ts's DEFAULT_COVERAGE_OBSERVATION_TTL_MS), so a single missed
    // tick never flips the UI to "unknown" while a genuinely-stalled sweep still does
    // within a business day. Read-mostly (a live App-mode probe + an upsert into the
    // two observation tables) and idempotent — safe for UI_TRIGGERABLE_WORKER_NAMES
    // (an admin who just fixed a permission grant has a real reason to force a
    // same-second recheck rather than wait up to an hour).
    recommendedCron: '0 * * * *',
    description:
      'Compute + persist GitHub enterprise-org coverage (mislinked/coverage-unknown/stale/not-installed/suspended/not-onboarded/connected) for every registered GitHub enterprise, dispatching a deduplicated admin inbox alert on a transition into a non-connected state or a capability loss (docs/design/usage-completeness-and-provider-governance.md §6)',
  },
  {
    name: 'provider-transform',
    run: (db, ctx) => {
      /*
       * Derive the BILLED lane (provider_usage_fact) from the provider's own
       * captured payloads — target-state-data-architecture.md §6, stage T0.
       *
       * WINDOW: the SAME trailing 30-day window the poller re-polls
       * (analyticsPollWindow). That is precisely the set of days Anthropic may
       * still restate, so it is the set whose derived facts may still move.
       * Deriving a narrower window would leave a revision landing in
       * actual_spend and never reaching the fact table; a wider one re-derives
       * days that cannot have changed.
       *
       * A signed { startingAt, endingAt } body overrides it — the backfill
       * lever for history older than the revision window (the design's "bounded
       * backfill from actual_spend.raw_payload so the current quarter is
       * coherent"). Honoured only as a PAIR forming a valid span, matching
       * analytics-poll's fail-soft treatment of the same opts. { externalOrgId }
       * scopes the run to one provider org's source.
       */
      const { startingAt, endingAt, externalOrgId } = ctx?.opts ?? {}
      const window =
        startingAt && endingAt && startingAt <= endingAt
          ? { startingAt, endingAt }
          : analyticsPollWindow(new Date())
      return runProviderTransform(db, {
        ...window,
        source: externalOrgId ? sourceForOrg(externalOrgId) : undefined,
      })
    },
    /*
     * HOURLY, not the poller's quarter-hourly tick. The fact table is DAY-grain
     * and nothing reads it at T0, so sub-hourly freshness buys nothing; meanwhile
     * each tick re-derives a 30-day window across every source. Deliberately NOT in
     * UI_TRIGGERABLE_WORKER_NAMES — it is a bulk money-adjacent derive, which
     * that file's contract keeps cron/HMAC-only.
     *
     * SCHEDULED, not parked in UNSCHEDULED_WORKERS: an inert table is the
     * POINT of T0, but an unpopulated one is the silent-no-op trap. T2 repoints
     * the model axis at this table and would find it empty.
     */
    recommendedCron: '0 * * * *',
    description:
      'Derive the normalised provider layer (provider_usage_fact -- NOT billed-only; §B is a read-time filter over it) at teammate/day/tool/model/cost_type grain from actual_spend.raw_payload; upsert-then-guarded-prune, homing stamped once and never refreshed (docs/design/target-state-data-architecture.md §6, T0)',
  },
  {
    name: 'ops-alert',
    run: (db) => runOpsAlert(db),
    // ≡4 mod 5 — off the shared 5- and 15-minute tick grids so its probes
    // measure the estate, not the estate mid-worker-burst (ops-alerting
    // ar-L22: exact literal, lockstepped with the deployed cron). Its OWN
    // liveness is the A4 Azure-native dead-man (successful-execution count on
    // the job), which is also why it never evaluates itself in the fleet
    // predicate.
    recommendedCron: '9,24,39,54 * * * *',
    description:
      'Evaluate the ops conditions (telemetry-read table probe, attribution stall, worker fleet, private-link network sweep, admin inbox aging) and page the operator on the external ntfy channel — every severity two-run damped, 6h reminders, recovery notices; each observation records WHY it fired into this run\'s result; inbox + audit parity per condition (docs/design/ops-alerting.md A2/A3/A5, alert-diagnosability.md D1-D4)',
  },
]

const BY_NAME = new Map(WORKERS.map((w) => [w.name, w]))

export function getWorker(name: string): WorkerEntry | undefined {
  return BY_NAME.get(name)
}

export function listWorkerNames(): string[] {
  return WORKERS.map((w) => w.name)
}

/*
 * Workers an admin may trigger on-demand from the UI (admin/workers/[name]/run).
 * The HMAC cron endpoint can run EVERY registered worker; the UI button is a
 * deliberately NARROWER surface. The canonical list is the SINGLE SOURCE shared
 * with the client picker (shared/workers/ui-triggerable.ts) so the two never
 * drift; this Set is the O(1) gate the endpoint enforces. Every name MUST be a
 * real registered worker (guarded by a unit test).
 */
export const UI_TRIGGERABLE_WORKERS: ReadonlySet<string> = new Set(UI_TRIGGERABLE_WORKER_NAMES)
