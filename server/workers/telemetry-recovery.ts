/*
 * telemetry-recovery worker — drains widened re-reads of already-ingested
 * telemetry, one instance-day at a time (mig 0093, 0148).
 *
 * Two kinds of request share the queue:
 *   - operator: an admin re-reads named instances at a wider lookback (up to 90
 *     days) to recover a backlog the 7-day window cannot reach;
 *   - scheduled: the daily 7-day pass over the joiner's own selection, which
 *     recovers telemetry the 5-minute watermark read missed (late arrivals,
 *     partial failures). This used to be azure-monitor-read's daily deep rescan,
 *     which held one instance's whole window in memory and the joiner's lock for
 *     ~40 minutes (docs/design/bounded-daily-deep-read.md).
 *
 * Each request is read as instance × day: day k of a lookback L requested at R
 * covers TimeGenerated in [R − (L−k)·24h, R − (L−k−1)·24h). The windows are fixed
 * by R, so resuming on a later tick leaves no gap, and each read holds at most
 * one instance's 24 h of events (a unit of work, not a heap cap). The cursor
 * (cursor_index, cursor_day) persists after each instance-day and the budget is
 * checked after each one, so every tick makes progress; each windowed query has
 * its own server timeout below the dispatch budget.
 *
 * A failed instance-day is counted in `errors` and the cursor moves on, as the
 * old daily rescan moved past a failed instance: the next daily pass re-reads
 * the same 7 days, so it is retried for all but the oldest day.
 *
 * Two pairings hold for every request: deepRescan (a widened read through the
 * watermark returns almost nothing while reading green) and an explicit instance
 * scope (a widened read of the whole fleet is a self-DoS). The joiner's write is
 * onConflictDoNothing on the dedup index, so overlapping with azure-monitor-read
 * is safe; each worker holds its own lock.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { runReadJoiner, selectJoinableInstances } from './azure-monitor-reader'
import { getTelemetryReader, type EventWindow, type TelemetryReader } from '../azure/reader'
import { consola } from 'consola'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

/**
 * Wall-clock budget per tick, checked after each instance-day. With one more
 * instance-day (at most ~90 s, see WINDOWED_QUERY_TIMEOUT_S) the tick stays inside
 * the 200 s dispatch budget.
 */
export const RECOVERY_BUDGET_MS = 90_000
export const SCHEDULED_LOOKBACK_DAYS = 7
export const SCHEDULED_INTERVAL_HOURS = 24
/** A scheduled pass not claimed for this long takes the next tick ahead of operator requests. */
export const STARVE_MINUTES = 30

const DAY_MS = 24 * 60 * 60 * 1000

export type RecoveryKind = 'operator' | 'scheduled'

export interface TelemetryRecoveryResult {
  claimed: number
  requestId: string | null
  kind: RecoveryKind | null
  status: 'succeeded' | 'failed' | 'running' | null
  /** Instances finished (all their days) this run. */
  instancesProcessed: number
  daysProcessed: number
  rowsWritten: number
  errors: number
  /** Id of the scheduled pass this tick queued, if it queued one. */
  scheduledQueued: string | null
  /** Largest heapUsed sampled after an instance-day, in MB. */
  heapUsedPeakMb: number | null
  /**
   * The window the reader ACTUALLY applied, read back from the reader rather than
   * recomputed: a run must not report success having applied a narrower window
   * than asked for.
   */
  lookbackDaysApplied: number | null
}

interface ClaimedRecovery extends Record<string, unknown> {
  id: string
  kind: RecoveryKind
  instance_ids: string[]
  lookback_days: number
  cursor_index: number
  cursor_day: number
  requested_at_ms: string
}

/**
 * Day `day` (0-based, oldest first) of a request made at `requestedAt` with
 * `lookbackDays`: 24 h of event time, the last one ending at the request. Every
 * window is closed, so one read never spans more than a day however long the
 * request waited; events after the request belong to the normal tick and the
 * next pass.
 */
export function dayWindow(requestedAt: Date, lookbackDays: number, day: number): EventWindow {
  const from = new Date(requestedAt.getTime() - (lookbackDays - day) * DAY_MS)
  return { from, to: new Date(from.getTime() + DAY_MS) }
}

/**
 * Queue the daily pass when none is in flight and none was queued in the last
 * SCHEDULED_INTERVAL_HOURS. Its scope is the joiner's own selection. Returns
 * the new request's id, or null when nothing was queued.
 */
export async function enqueueScheduledPass(db: Db): Promise<string | null> {
  // A pass still in flight a day later (preempted, or failing transiently) is
  // closed out rather than left to block the next one: the next pass re-reads
  // the same 7 days, so only its oldest day is given up — as when the old daily
  // rescan failed.
  await db.execute(sql`
    UPDATE telemetry_recovery_request
       SET status = 'failed', finished_at = now(),
           error = COALESCE(error || ' — ', '') || 'superseded by the next daily pass'
     WHERE kind = 'scheduled'
       AND status IN ('pending', 'running')
       AND requested_at <= now() - (${SCHEDULED_INTERVAL_HOURS} * INTERVAL '1 hour')
  `)
  const recent = await db.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM telemetry_recovery_request
     WHERE kind = 'scheduled'
       AND (status IN ('pending', 'running')
            OR requested_at > now() - (${SCHEDULED_INTERVAL_HOURS} * INTERVAL '1 hour'))
     LIMIT 1
  `)
  if (recent.length > 0) return null
  const { ids } = await selectJoinableInstances(db)
  if (ids.length === 0) return null
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO telemetry_recovery_request (kind, instance_ids, lookback_days, reason)
    VALUES ('scheduled',
            ${`{${ids.join(',')}}`}::uuid[],
            ${SCHEDULED_LOOKBACK_DAYS},
            'daily pass: re-read the last 7 days to recover late telemetry')
    ON CONFLICT DO NOTHING
    RETURNING id::text AS id
  `)
  return rows[0]?.id ?? null
}

export async function runTelemetryRecovery(
  db: Db,
  opts?: {
    now?: Date
    runId?: string | null
    budgetMs?: number
    /**
     * Reader factory seam. Production passes nothing and gets the configured
     * reader; tests inject a stub. Takes lookbackDays so the injected reader is
     * built the same way the real one is.
     */
    readerFor?: (lookbackDays: number) => TelemetryReader
    /** Queue the daily pass when it is due (default true). Tests of the drain alone turn it off. */
    scheduled?: boolean
  },
): Promise<TelemetryRecoveryResult> {
  const now = opts?.now ?? new Date()
  const runId = opts?.runId ?? null
  const budgetMs = opts?.budgetMs ?? RECOVERY_BUDGET_MS
  const readerFor = opts?.readerFor ?? ((lookbackDays: number) => getTelemetryReader({ lookbackDays }))

  let scheduledQueued: string | null = null
  try {
    if (opts?.scheduled ?? true) scheduledQueued = await enqueueScheduledPass(db)
  } catch (err) {
    // A failed enqueue must not stop an operator's recovery from draining.
    consola.warn(`[telemetry-recovery] could not queue the daily pass: ${describeError(err)}`)
  }

  // Operator requests first, then the one already running, then the oldest —
  // except that a scheduled pass untouched for STARVE_MINUTES takes the tick, so
  // a run of operator campaigns cannot stall the daily pass indefinitely.
  // SKIP LOCKED + the per-worker dispatch lock keep this single-flight.
  const claimedRows = await db.execute<ClaimedRecovery>(sql`
    UPDATE telemetry_recovery_request
       SET status = 'running',
           claimed_at = now(),
           started_at = COALESCE(started_at, now()),
           run_id = ${runId},
           error = NULL
     WHERE id = (
       SELECT id FROM telemetry_recovery_request
        WHERE status IN ('pending', 'running')
        ORDER BY (kind = 'scheduled'
                  AND COALESCE(claimed_at, requested_at) < now() - (${STARVE_MINUTES} * INTERVAL '1 minute')) DESC,
                 (kind = 'operator') DESC,
                 (status = 'running') DESC,
                 requested_at
          FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id::text AS id,
              kind,
              instance_ids::text[] AS instance_ids,
              lookback_days,
              cursor_index,
              cursor_day,
              floor(EXTRACT(EPOCH FROM requested_at) * 1000)::bigint::text AS requested_at_ms
  `)
  const req = claimedRows[0]
  const empty = {
    instancesProcessed: 0,
    daysProcessed: 0,
    rowsWritten: 0,
    errors: 0,
    scheduledQueued,
    heapUsedPeakMb: null,
    lookbackDaysApplied: null,
  }
  if (!req) return { claimed: 0, requestId: null, kind: null, status: null, ...empty }

  const ids = [...req.instance_ids]
  const lookback = req.lookback_days
  const requestedAt = new Date(Number(req.requested_at_ms))
  let cursor = Math.max(0, Math.min(Number(req.cursor_index) || 0, ids.length))
  let day = Math.max(0, Math.min(Number(req.cursor_day) || 0, lookback))
  let instancesThisRun = 0
  let daysThisRun = 0
  let rowsThisRun = 0
  let errorsThisRun = 0
  let heapPeak = 0
  let lookbackDaysApplied: number | null = null
  const result = (status: 'succeeded' | 'failed' | 'running'): TelemetryRecoveryResult => ({
    claimed: 1,
    requestId: req.id,
    kind: req.kind,
    status,
    instancesProcessed: instancesThisRun,
    daysProcessed: daysThisRun,
    rowsWritten: rowsThisRun,
    errors: errorsThisRun,
    scheduledQueued,
    heapUsedPeakMb: daysThisRun > 0 ? Math.round(heapPeak / (1024 * 1024)) : null,
    lookbackDaysApplied,
  })

  try {
    // Wall clock, not the injectable `now`: the budget bounds elapsed time, and
    // mixing the two clocks would let a past `now` drain nothing while reporting
    // a clean, resumable run.
    const deadline = Date.now() + budgetMs
    // One reader for the run: the Azure client and credential memo are per reader.
    const reader = readerFor(lookback)
    while (cursor < ids.length) {
      const joined = await runReadJoiner(db, reader, {
        sessionIds: [ids[cursor]!],
        deepRescan: true,
        scoped: true,
        now,
        window: dayWindow(requestedAt, lookback, day),
      })
      lookbackDaysApplied = joined.lookbackDaysApplied ?? lookbackDaysApplied
      // Token and signal lanes fail separately in the joiner; either is a day not
      // fully recovered.
      const dayErrors = joined.errors + joined.signalErrors
      rowsThisRun += joined.attributionRowsWritten
      errorsThisRun += dayErrors
      daysThisRun += 1
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
      // Advance by position, never by sessionsProcessed: the joiner's gates skip
      // purged or revoked instances, and waiting for them would never finish.
      day += 1
      if (day >= lookback) {
        day = 0
        cursor += 1
        instancesThisRun += 1
      }

      await db.execute(sql`
        UPDATE telemetry_recovery_request
           SET cursor_index = ${cursor},
               cursor_day = ${day},
               instances_processed = ${cursor},
               rows_written = rows_written + ${joined.attributionRowsWritten},
               errors = errors + ${dayErrors},
               claimed_at = now()
         WHERE id = ${req.id}::uuid
      `)
      if (Date.now() >= deadline) break
    }

    if (cursor >= ids.length) {
      await db.execute(sql`
        UPDATE telemetry_recovery_request
           SET status = 'succeeded', finished_at = now()
         WHERE id = ${req.id}::uuid
      `)
      return result('succeeded')
    }
    return result('running')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (req.kind === 'scheduled') {
      // Transient by assumption: keep it running so the next tick resumes from
      // the cursor; a pass that keeps failing is superseded after a day.
      await db.execute(sql`
        UPDATE telemetry_recovery_request SET error = ${message.slice(0, 2000)}, claimed_at = now()
         WHERE id = ${req.id}::uuid
      `)
      consola.warn(`[telemetry-recovery] scheduled pass ${req.id} hit an error and will resume: ${message}`)
      return result('running')
    }
    await db.execute(sql`
      UPDATE telemetry_recovery_request
         SET status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)}
       WHERE id = ${req.id}::uuid
    `)
    consola.warn(`[telemetry-recovery] request ${req.id} failed: ${message}`)
    return result('failed')
  }
}
