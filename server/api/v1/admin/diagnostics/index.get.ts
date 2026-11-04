/*
 * GET /api/v1/admin/diagnostics — read-only operational health snapshot,
 * the DB-only part: Postgres reachability + active migration, last-sync per
 * source, pipeline freshness and worker execution health. Target < 500 ms warm.
 *
 * The network-bound probes (`services`, `telemetryRead`) live at
 * ./probes.get.ts and the 7-day costing aggregates (`costDrift`,
 * `costingRungs`) at ./costing.get.ts — docs/design/admin-nav-responsiveness.md
 * D4 splits the old single endpoint by COST so the page can draw each panel as
 * its read lands instead of holding the whole page on the slowest probe.
 *
 * RBAC: admin / platform-admin. Read-only — no mutations.
 *
 * Four transactions, one per read (postgres probe, lastSync, pipeline,
 * workers), each with its own catch. A failing statement aborts the Postgres
 * transaction it runs in, so two reads that must survive each other's failure
 * cannot share one; and a read that shares a transaction with a catch-and-
 * continue probe would see that probe's abort. The three table reads are
 * therefore NOT issued concurrently on one connection (F5) — the concurrency
 * is worth less than a card that stays populated when its neighbour's table is
 * absent. Each block is wrapped so one failure never 500s the endpoint.
 *
 * A caught failure keeps the read's empty/unknown initialiser so existing
 * consumers keep working, and DECLARES itself in `reads` — one
 * `{ available }` entry per independently-fallible read, with a classified
 * reason and a correlation id when false. Without it an aborted query and a
 * genuinely empty table are the same bytes on the wire, and the page renders
 * "no worker runs yet" for "the workers query failed". (`postgres` is not in
 * `reads`: it already declares itself with `reachable: false` + `error`.)
 *
 * BullMQ / Redis are NOT wired in MVP-Final (no `redis` or `bullmq`
 * package in dependencies as of Wave V). The diagnostics endpoint
 * returns `unavailable: true` for those sections so the UI can render
 * a placeholder card without a dependency on a runtime that doesn't
 * exist yet.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import {
  classifyDispatchDuration,
  dispatchBudgetReason as dispatchBudgetReasonFor,
  DISPATCH_TIMEOUT_MS,
  type DispatchBudgetState,
} from '#shared/workers/dispatch-budget'
import {
  classifyProbeError,
  readUnavailable,
  type ReadAvailability,
} from '../../../../utils/redact-probe-error'

interface MigrationRow extends Record<string, unknown> {
  name: string
  applied_at: string
}

interface LastSyncRow extends Record<string, unknown> {
  source: string
  ts: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')

  // One entry per independently-fallible read below; the only thing separating
  // an empty result from a failed one in the payload.
  let lastSyncRead: ReadAvailability = { available: true }
  let pipelineRead: ReadAvailability = { available: true }
  let workersRead: ReadAvailability = { available: true }

  // ── Postgres ──────────────────────────────────────────────────────
  // Two independent probes inside ONE withRequestRls call (saves a
  // round-trip on the GUC set). SELECT 1 → reachability + latency;
  // _drizzle_migrations read → active-migration name. Each is in its
  // own try so a missing migration table (test-container bootstrap that
  // applies SQL without ever creating `_drizzle_migrations`) doesn't
  // mask the reachability signal. drizzle/migrate.ts:23-26 creates the
  // table at first boot in production, so the missing-table path is
  // exclusively a test concern.
  const pgStart = Date.now()
  let pgReachable = false
  let pgError: string | null = null
  let pgErrorCorrelationId: string | null = null
  let activeMigration: string | null = null
  try {
    await withRequestRls(event, async (tx) => {
      await tx.execute(sql`SELECT 1`)
      pgReachable = true
      try {
        const migRows = await tx.execute<MigrationRow>(sql`
          SELECT name, COALESCE(applied_at::text, '') AS applied_at
          FROM _drizzle_migrations
          ORDER BY applied_at DESC NULLS LAST
          LIMIT 1
        `)
        const row = [...migRows][0]
        if (row) activeMigration = row.name
      } catch (migErr) {
        // Table may not exist in test bootstrap; reachability is
        // already true from the SELECT 1 above. Report the migration
        // table state honestly rather than masking.
        const message = migErr instanceof Error ? migErr.message : String(migErr)
        if (/_drizzle_migrations/.test(message)) {
          activeMigration = 'unknown (migration marker table absent)'
        } else {
          // Genuine error reading the marker table — surface it.
          throw migErr
        }
      }
    })
  } catch (err) {
    const classified = classifyProbeError(err, 'diagnostics:postgres')
    pgError = classified.reason
    pgErrorCorrelationId = classified.correlationId
  }
  const pgLatencyMs = Date.now() - pgStart

  // ── Redis (not wired in MVP-Final) ────────────────────────────────
  // The `redis` / `ioredis` packages aren't in the dependency tree as
  // of Wave V. Returning `unavailable: true` is honest; the UI renders
  // a placeholder.
  const redis = { unavailable: true as const, reason: 'redis not wired in MVP-Final' }

  // ── BullMQ queues (not wired in MVP-Final) ────────────────────────
  const queues = { unavailable: true as const, reason: 'bullmq not wired in MVP-Final' }

  // ── Last-sync per source ──────────────────────────────────────────
  // We have no sync_history table in MVP-Final. The closest signal is
  // teammate.last_sync_at + org_unit.last_sync_at. Aggregate by source string
  // — empty result when no sync rows exist (manual mode).
  let lastSync: { source: string; ts: string | null }[] = []
  try {
    const rows = await withRequestRls(event, (tx) =>
      tx.execute<LastSyncRow>(sql`
        SELECT source, MAX(last_sync_at)::text AS ts
        FROM (
          SELECT source, last_sync_at FROM teammate WHERE last_sync_at IS NOT NULL
          UNION ALL
          SELECT source, last_sync_at FROM org_unit WHERE last_sync_at IS NOT NULL
        ) s
        GROUP BY source
        ORDER BY source
      `),
    )
    lastSync = [...rows].map((r) => ({ source: r.source, ts: r.ts }))
  } catch (err) {
    // Non-fatal — lastSync keeps its empty initialiser (a bootstrap env where
    // the tables are absent); reads.lastSync says the emptiness is a failure.
    lastSyncRead = readUnavailable(err, 'diagnostics:last-sync')
  }

  // ── Pipeline freshness (emit -> gather) ───────────────────────────
  // The signal that would have flagged the 12h silent-emission outage at a
  // glance. Two timestamps off the single-source ledger:
  //   lastUsageSeen   = MAX(ts_event)    — when the most recent USAGE happened
  //                     (emission freshness; stale => client stopped emitting
  //                     or the ingest path is dropping).
  //   lastLedgerWrite = MAX(ts_recorded) — when the joiner last WROTE a row
  //                     (gather freshness).
  // If usage is stale but the joiner keeps running (cron healthy), the break
  // is upstream in emit/ingest — exactly the failure mode that lost ~24h of
  // spend silently. Region admins see the people who sit in their region now
  // (current-org-lens §3.2), never the rows' stamped region; org-wide roles see all.
  const regionFilter =
    session.role === 'admin'
      ? sql`WHERE teammate_id IN (SELECT id FROM teammate WHERE region_id = ${session.regionId}::uuid)`
      : sql``
  let pipeline: {
    lastUsageSeen: string | null
    lastLedgerWrite: string | null
    usageAgeMinutes: number | null
    ledgerAgeMinutes: number | null
    status: 'ok' | 'warn' | 'stale' | 'unknown'
  } = { lastUsageSeen: null, lastLedgerWrite: null, usageAgeMinutes: null, ledgerAgeMinutes: null, status: 'unknown' }
  try {
    const rows = await withRequestRls(event, (tx) =>
      tx.execute<{ last_usage: string | null; last_write: string | null }>(sql`
        SELECT MAX(ts_event)::text AS last_usage, MAX(ts_recorded)::text AS last_write
        FROM attribution_record ${regionFilter}
      `),
    )
    const r = [...rows][0]
    const now = Date.now()
    const ageMin = (ts: string | null): number | null =>
      ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000)) : null
    const usageAge = ageMin(r?.last_usage ?? null)
    const ledgerAge = ageMin(r?.last_write ?? null)
    // Heuristic RAG on usage freshness: emission can be naturally quiet, so the
    // thresholds are generous. ok < 1h, warn < 6h, stale >= 6h.
    const status: 'ok' | 'warn' | 'stale' | 'unknown' =
      usageAge == null ? 'unknown' : usageAge < 60 ? 'ok' : usageAge < 360 ? 'warn' : 'stale'
    pipeline = {
      lastUsageSeen: r?.last_usage ?? null,
      lastLedgerWrite: r?.last_write ?? null,
      usageAgeMinutes: usageAge,
      ledgerAgeMinutes: ledgerAge,
      status,
    }
  } catch (err) {
    // Non-fatal — pipeline keeps its unknown initialiser; reads.pipeline
    // separates that 'unknown' from "no usage has ever landed".
    pipelineRead = readUnavailable(err, 'diagnostics:pipeline')
  }

  // ── Worker execution health (outcome of each dispatch) ────────────
  // The signal the freshness panel CANNOT give: a worker cron that fails
  // every run. The freshness panel measures data recency (max ts_recorded)
  // and a partially-completing worker still advances it — so the joiner
  // cron once failed every run with a 504 while the panel showed green.
  // worker_run records each dispatch's outcome; here we read the latest run
  // per worker plus the count of TRAILING failures (newest-first run of
  // consecutive 'failure' rows) in ONE query — no N+1.
  //
  // Query shape:
  //   ranked        — runs numbered per worker, newest first.
  //   boundary      — per worker, the rank of the newest streak-RESET run:
  //                   'success' or 'skipped' (admin-disabled, mig 0090). NULL ⇒
  //                   no such run. MUST match the reset rule in ops-alert.ts
  //                   (ar-M12) so the card and the pager agree about one
  //                   ledger. A trailing 'running' (killed/wedged) is NOT a
  //                   reset and does not hide the failures beneath it.
  //   consecutiveFailures = count of 'failure' runs ranked strictly NEWER than
  //                   that reset boundary (the trailing failure streak).
  // The latest-per-worker projection (rn = 1) is joined to that streak count,
  // and the latest run's started_at is surfaced so the RAG can apply the
  // stale-running staleness rule below.
  let workers: {
    worker: string
    status: string
    finishedAt: string | null
    startedAt: string | null
    durationMs: number | null
    ageMinutes: number | null
    startedAgeMinutes: number | null
    consecutiveFailures: number
    rag: 'ok' | 'failing' | 'stale' | 'disabled' | 'unknown'
    /**
     * How the last run's duration sits against the dispatch budget. The ledger
     * and the platform disagree about a worker that OVERRUNS: the work finished
     * and wrote `success` here, while the cron trigger gave up waiting and the
     * platform recorded a FAILED execution and retried. Without this, that
     * worker reads `ok` on this card and red in Azure, and only someone holding
     * both views can tell. Null when the duration is unknown.
     */
    dispatchBudget: DispatchBudgetState | null
    /** Plain-language reason when dispatchBudget is 'near' or 'over'. */
    dispatchBudgetReason: string | null
  }[] = []
  // A 'running' row older than this is treated as wedged/killed (failing) — the
  // run never transitioned. Well past the 240s replica timeout so a genuinely
  // in-flight run is never falsely flagged.
  const STALE_RUNNING_MINUTES = 15
  try {
    const rows = await withRequestRls(event, (tx) =>
      tx.execute<{
        worker_name: string
        status: string
        finished_at: string | null
        started_at: string
        duration_ms: number | null
        rows_affected: number | null
        sessions_processed: string | null
        new_events_seen: string | null
        source_coverage: string | null
        source_rows_received: string | null
        source_rows_dropped: string | null
        consecutive_failures: number
      }>(sql`
        WITH ranked AS (
          SELECT worker_name, status, finished_at, started_at, duration_ms, rows_affected, result,
                 ROW_NUMBER() OVER (PARTITION BY worker_name ORDER BY started_at DESC, id DESC) AS rn
          FROM worker_run
        ),
        boundary AS (
          SELECT worker_name, MIN(rn) AS first_reset_rn
          FROM ranked
          WHERE status IN ('success', 'skipped')
          GROUP BY worker_name
        ),
        streak AS (
          SELECT r.worker_name,
                 COUNT(*) FILTER (
                   WHERE r.status = 'failure'
                     AND r.rn < COALESCE(b.first_reset_rn, 2147483647)
                 ) AS consecutive_failures
          FROM ranked r
          LEFT JOIN boundary b USING (worker_name)
          GROUP BY r.worker_name
        )
        SELECT r.worker_name,
               r.status,
               r.finished_at::text AS finished_at,
               r.started_at::text AS started_at,
               r.duration_ms,
               -- THE ATTRIBUTION-STALL EVIDENCE. The stall condition is a streak
               -- of runs that wrote ZERO rows while the ingest pipeline received
               -- rows the joiner did not land — the operator's narrative is
               -- "source received N · reader saw M new · wrote R". source_coverage
               -- is the DCR ingest verdict the alert GATES on (rows-arrived =
               -- backlog, no-rows = idle, unknown = probe could not measure →
               -- bearer fallback); source_rows_received/dropped are its metric
               -- values; new_events_seen is the reader-side middle term (past the
               -- watermark, diagnostic); sessions_processed is the SELECTION size
               -- (an open editor keeps it at 1). NULL = a run recorded before the
               -- key existed (unknown, not zero).
               r.rows_affected,
               (r.result->>'sessionsProcessed') AS sessions_processed,
               (r.result->>'newEventsSeen') AS new_events_seen,
               (r.result->'sourceCoverage'->>'status') AS source_coverage,
               (r.result->'sourceCoverage'->>'rowsReceived') AS source_rows_received,
               (r.result->'sourceCoverage'->>'rowsDropped') AS source_rows_dropped,
               s.consecutive_failures::int AS consecutive_failures
        FROM ranked r
        JOIN streak s USING (worker_name)
        WHERE r.rn = 1
        ORDER BY r.worker_name
      `),
    )
    const now = Date.now()
    const ageMin = (ts: string | null): number | null =>
      ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000)) : null
    workers = [...rows].map((r) => {
      const consecutiveFailures = Number(r.consecutive_failures) || 0
      const startedAgeMinutes = ageMin(r.started_at ?? null)
      // RAG:
      //   - any trailing failure (under the newest success) ⇒ failing.
      //   - latest run 'success' ⇒ ok.
      //   - latest run 'running': a FRESH one (started < threshold) is genuinely
      //     in-progress ⇒ ok (in-progress); a STALE one (started ≥ threshold,
      //     never transitioned) is a killed/wedged worker ⇒ failing (red), NOT
      //     merely 'stale' (amber). This is the killed-mid-run signal.
      //   - latest run 'skipped' ⇒ disabled: an admin switched the worker off;
      //     nothing is wrong and nothing ran, and the chip says which.
      //   - otherwise unknown (no runs / unexpected status).
      let rag: 'ok' | 'failing' | 'stale' | 'disabled' | 'unknown'
      if (consecutiveFailures >= 1) rag = 'failing'
      else if (r.status === 'success') rag = 'ok'
      else if (r.status === 'skipped') rag = 'disabled'
      else if (r.status === 'running') {
        rag =
          startedAgeMinutes != null && startedAgeMinutes >= STALE_RUNNING_MINUTES
            ? 'failing'
            : 'ok'
      } else rag = 'unknown'
      // Non-finite collapses to null, not NaN. Two reasons: the SSR payload is
      // serialised with devalue, which preserves NaN faithfully all the way to a
      // rendered "NaNms" (plain JSON would have turned it into null); and leaving it
      // would let durationMs claim a value while dispatchBudget below says null —
      // two fields on the same row disagreeing about whether the duration is known.
      const rawDuration = r.duration_ms == null ? null : Number(r.duration_ms)
      const durationMs = rawDuration != null && Number.isFinite(rawDuration) ? rawDuration : null
      const dispatchBudget = classifyDispatchDuration(durationMs)
      return {
        worker: r.worker_name,
        status: r.status,
        finishedAt: r.finished_at,
        startedAt: r.started_at ?? null,
        durationMs,
        ageMinutes: ageMin(r.finished_at ?? r.started_at),
        startedAgeMinutes,
        consecutiveFailures,
        /*
         * The attribution-stall evidence, on the row an operator already looks
         * at. sourceCoverage is what the alert GATES on (rows-arrived = the DCR
         * received rows we did not land = the fault; no-rows = idle; unknown =
         * probe could not measure → bearer fallback). rowsReceived is its metric
         * value; newEventsSeen is the reader-side middle term; sessionsProcessed
         * is the selection size (context, not evidence). null = not recorded (a
         * pre-deploy run), never 0.
         */
        rowsAffected: r.rows_affected == null ? null : Number(r.rows_affected),
        sessionsProcessed: r.sessions_processed == null ? null : Number(r.sessions_processed),
        newEventsSeen: r.new_events_seen == null ? null : Number(r.new_events_seen),
        sourceCoverage: r.source_coverage,
        sourceRowsReceived: r.source_rows_received == null ? null : Number(r.source_rows_received),
        sourceRowsDropped: r.source_rows_dropped == null ? null : Number(r.source_rows_dropped),
        rag,
        dispatchBudget,
        dispatchBudgetReason: dispatchBudgetReasonFor(dispatchBudget, durationMs),
      }
    })
  } catch (err) {
    // Non-fatal — workers keeps its empty initialiser (the table may be absent
    // in a bootstrap env); reads.workers is what stops the card claiming "no
    // worker runs recorded yet" when the query is what failed.
    workersRead = readUnavailable(err, 'diagnostics:workers')
  }

  return {
    postgres: {
      reachable: pgReachable,
      latencyMs: pgLatencyMs,
      activeMigration,
      ...(pgError ? { error: pgError, errorCorrelationId: pgErrorCorrelationId } : {}),
    },
    redis,
    queues,
    pipeline,
    workers,
    // The budget each worker's duration is judged against, so the card can name
    // the threshold instead of hard-coding a number that would drift from the
    // bicep the moment either changed.
    dispatchBudgetMs: DISPATCH_TIMEOUT_MS,
    lastSync,
    // Availability of each read above, keyed by the field it governs.
    reads: { lastSync: lastSyncRead, pipeline: pipelineRead, workers: workersRead },
    nodeEnv: process.env.NODE_ENV ?? 'development',
    containerInfo: {
      revision: process.env.CONTAINER_APP_REVISION ?? null,
    },
  }
})
