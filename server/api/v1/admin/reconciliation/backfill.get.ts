/*
 * GET /api/v1/admin/reconciliation/backfill — recent backfill requests + status, for the admin
 * Reconciliation UI to poll. Newest first, capped. RBAC: requireRole('platform-admin').
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

interface RequestRow extends Record<string, unknown> {
  id: string
  provider: string
  target_kind: string
  external_ref: string
  display_name: string | null
  start_date: string
  end_date: string
  status: string
  rows_written: number
  error: string | null
  requested_at: string
  finished_at: string | null
}

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): backfill requests target orgs/enterprises of every region (no region term), so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  const rows = await withRequestRls(event, (tx) =>
    tx.execute<RequestRow>(sql`
      SELECT id::text AS id, provider, target_kind, external_ref, display_name,
             start_date::text AS start_date, end_date::text AS end_date, status,
             rows_written, error, requested_at::text AS requested_at, finished_at::text AS finished_at
      FROM reconciliation_backfill_request
      ORDER BY requested_at DESC
      LIMIT 25
    `),
  )
  return {
    requests: [...rows].map((r) => ({
      id: r.id,
      provider: r.provider,
      targetKind: r.target_kind,
      externalRef: r.external_ref,
      displayName: r.display_name,
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status,
      rowsWritten: r.rows_written,
      error: r.error,
      requestedAt: r.requested_at,
      finishedAt: r.finished_at,
    })),
  }
})
