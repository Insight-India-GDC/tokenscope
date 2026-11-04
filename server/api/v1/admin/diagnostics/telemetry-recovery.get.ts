/*
 * GET /api/v1/admin/diagnostics/telemetry-recovery — widened-read queue status.
 *
 * The companion to the POST. A recovery is drained asynchronously in slices, so
 * "is it done, and did it actually recover anything?" has to be answerable
 * afterwards — otherwise the operator is back to inferring success from a 2xx,
 * which is the exact failure this feature exists to remove.
 *
 * Reports PROGRESS (cursor over the scoped instance count) and OUTCOME
 * (rows_written, errors) separately, because they answer different questions: a
 * request can be 100% processed and have written zero rows, which is a real and
 * important result — it means the backlog was not where the operator thought.
 *
 * RBAC: admin / platform-admin. Read-only, and the same tier as the attribution-gap
 * list it is used beside; enqueueing (the side that spends query budget) is
 * platform-admin-only on the POST.
 *
 * REGION CLAMP: telemetry_recovery_request has no region column of its own — a
 * request's `instance_ids` can span regions (an operator recovering telemetry
 * estate-wide). A region-scoped `admin` sees only requests that touch AT LEAST
 * ONE instance in their own region (an EXISTS membership check against
 * instance_attestation); platform-admin keep the estate-wide
 * queue, matching the pattern used by attribution-gaps and instance-telemetry.
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { getValidated } from '../../../../utils/validated-body'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

interface Row extends Record<string, unknown> {
  id: string
  status: string
  kind: 'operator' | 'scheduled'
  lookback_days: number
  instance_count: number
  cursor_index: number
  instances_processed: number
  rows_written: number
  errors: number
  reason: string | null
  error: string | null
  requested_by_email: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const { limit } = await getValidated(event, Query)

  // No-op for platform-admin; for a region-scoped admin, only requests touching
  // a device whose teammate sits in their region now — the same clamp as
  // attribution-gaps.get.ts / instance-telemetry.get.ts.
  const regionClause =
    session.role === 'admin'
      ? sql`AND EXISTS (
          SELECT 1 FROM instance_attestation ia JOIN teammate t ON t.id = ia.teammate_id
           WHERE ia.instance_id = ANY(r.instance_ids) AND t.region_id = ${session.regionId}::uuid
        )`
      : sql``

  return withRequestRls(event, async (db) => {
    const rows = await db.execute<Row>(sql`
      SELECT r.id::text                        AS id,
             r.status                          AS status,
             r.kind                            AS kind,
             r.lookback_days                   AS lookback_days,
             cardinality(r.instance_ids)       AS instance_count,
             r.cursor_index                    AS cursor_index,
             r.instances_processed             AS instances_processed,
             r.rows_written                    AS rows_written,
             r.errors                          AS errors,
             r.reason                          AS reason,
             r.error                           AS error,
             t.email                           AS requested_by_email,
             r.requested_at::text              AS requested_at,
             r.started_at::text                AS started_at,
             r.finished_at::text               AS finished_at
        FROM telemetry_recovery_request r
        LEFT JOIN teammate t ON t.id = r.requested_by
       WHERE TRUE
         ${regionClause}
       ORDER BY r.requested_at DESC
       LIMIT ${limit}
    `)

    const requests = [...rows].map((r) => {
      const total = Number(r.instance_count) || 0
      const done = Number(r.cursor_index) || 0
      return {
        id: r.id,
        status: r.status,
        kind: r.kind,
        lookbackDays: Number(r.lookback_days),
        instanceCount: total,
        // Progress over the SCOPE, so "80% of 40 devices" is legible without the
        // caller doing arithmetic against two fields that could be read out of step.
        instancesProcessed: done,
        percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
        // OUTCOME, kept separate from progress on purpose (see the header).
        rowsWritten: Number(r.rows_written),
        errors: Number(r.errors),
        reason: r.reason,
        error: r.error,
        requestedByEmail: r.requested_by_email,
        requestedAt: r.requested_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      }
    })

    // Queue state, not the history page: daily rows can push a long operator
    // recovery off the page. One operator recovery at a time (mig 0148), and the
    // enqueue's own pre-check is global, so this is too; the daily pass never
    // blocks the button.
    const [busy] = await db.execute<{ in_flight: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM telemetry_recovery_request
         WHERE kind = 'operator' AND status IN ('pending', 'running')
      ) AS in_flight
    `)

    return {
      requests,
      inFlight: Boolean(busy?.in_flight),
    }
  })
})
