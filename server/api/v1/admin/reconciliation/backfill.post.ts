/*
 * POST /api/v1/admin/reconciliation/backfill — enqueue an on-demand historical pull.
 *
 * The steady-state reconciliation-sync pulls only [yesterday, today]. This lets an admin pull a
 * chosen window so §A surfaces unaccounted usage for older days. Enqueues a
 * reconciliation_backfill_request (mig 0074); the reconciliation-backfill worker drains it.
 *
 * Body (zod): { targetKind: 'org'|'enterprise', targetId: uuid, startDate: 'YYYY-MM-DD' }.
 *   - org       → a RECONCILED anthropic provider_org (credential grain = org).
 *   - enterprise→ a RECONCILED github provider_enterprise (credential grain = enterprise).
 *   - startDate within the last 90 days and not in the future; endDate = today (UTC).
 *   - one in-flight (pending|running) request per scope (409 otherwise — no queue spam).
 *
 * RBAC: requireRole('platform-admin') + assertSameOrigin. Audited. The target is resolved
 * with no region term (a provider_org of any region, or a region-less provider_enterprise),
 * so platform-admin is the only clamp — same rule as the enterprises routes.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { reconciliationBackfillRequest } from '../../../../../drizzle/schema'
import { isRealUtcDay } from '#shared/schemas/activity'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BACKFILL_DAYS = 90

const Body = z.object({
  targetKind: z.enum(['org', 'enterprise']),
  targetId: z.string().regex(UUID_RE),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealUtcDay, 'not a real calendar day'),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid backfill request',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid backfill request',
      status: 400,
      detail,
    },
  })
}

/** UTC midnight of `d`, as a Date — for whole-day arithmetic without TZ drift. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export default defineEventHandler(async (event) => {
  // provider_org / provider_enterprise are resolved estate-wide, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Window validation against today (UTC). endDate = today; startDate within [today-90, today].
  const today = utcMidnight(new Date())
  const endDate = today.toISOString().slice(0, 10)
  const start = new Date(`${body.startDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) badRequest(`startDate '${body.startDate}' is not a valid date`)
  if (start.getTime() > today.getTime()) badRequest('startDate cannot be in the future')
  const floor = new Date(today)
  floor.setUTCDate(floor.getUTCDate() - MAX_BACKFILL_DAYS)
  if (start.getTime() < floor.getTime()) {
    badRequest(`startDate is more than ${MAX_BACKFILL_DAYS} days ago (earliest allowed: ${floor.toISOString().slice(0, 10)})`)
  }

  return await withRequestRls(event, async (tx) => {
    // Resolve the target scope: org → anthropic provider_org, enterprise → github provider_enterprise.
    // Only a RECONCILED scope has a resolvable credential to pull with.
    let provider: 'anthropic' | 'github'
    let externalRef: string
    let displayName: string
    if (body.targetKind === 'org') {
      const rows = await tx.execute<{ provider: string; external_org_id: string; display_name: string; mode: string }>(sql`
        SELECT provider, external_org_id, display_name, reconciliation_mode AS mode
        FROM provider_org WHERE id = ${body.targetId}::uuid LIMIT 1`)
      const row = [...rows][0]
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Org not found', data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Org not found', status: 404, detail: 'No provider_org matches targetId.' } })
      if (row.provider !== 'anthropic') badRequest(`targetKind 'org' backfills an anthropic org, but this is a ${row.provider} org (use targetKind 'enterprise' for github)`)
      if (row.mode !== 'reconciled') badRequest(`org '${row.external_org_id}' is '${row.mode}', not 'reconciled' — only reconciled scopes can be backfilled`)
      provider = 'anthropic'
      externalRef = row.external_org_id
      displayName = row.display_name
    } else {
      const rows = await tx.execute<{ provider: string; external_id: string; display_name: string; mode: string }>(sql`
        SELECT provider, external_id, display_name, reconciliation_mode AS mode
        FROM provider_enterprise WHERE id = ${body.targetId}::uuid LIMIT 1`)
      const row = [...rows][0]
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Enterprise not found', data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Enterprise not found', status: 404, detail: 'No provider_enterprise matches targetId.' } })
      if (row.provider !== 'github') badRequest(`targetKind 'enterprise' backfills a github enterprise, but this is a ${row.provider} enterprise`)
      if (row.mode !== 'reconciled') badRequest(`enterprise '${row.external_id}' is '${row.mode}', not 'reconciled' — only reconciled scopes can be backfilled`)
      provider = 'github'
      externalRef = row.external_id
      displayName = row.display_name
    }

    // One in-flight request per scope — don't let the queue fill with duplicates.
    const inflight = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM reconciliation_backfill_request
      WHERE provider = ${provider} AND lower(external_ref) = lower(${externalRef})
        AND status IN ('pending', 'running') LIMIT 1`)
    if ([...inflight][0]) {
      throw createError({ statusCode: 409, statusMessage: 'Backfill already in flight', data: { type: 'https://tokenscope.example.com/errors/conflict', title: 'Backfill already in flight', status: 409, detail: `A backfill for ${provider} '${externalRef}' is already pending or running.` } })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(reconciliationBackfillRequest)
        .values({ provider, targetKind: body.targetKind, externalRef, displayName, startDate: body.startDate, endDate, requestedBy: caller.teammateId })
        .returning({ id: reconciliationBackfillRequest.id })
    } catch (err: unknown) {
      // Race backstop for the in-flight pre-check: the partial-unique index (mig 0074) is the
      // source of truth when two POSTs slip past the SELECT concurrently.
      translatePgConstraintError(err, {
        '23505': {
          status: 409,
          title: 'Backfill already in flight',
          detail: `A backfill for ${provider} '${externalRef}' is already pending or running.`,
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'reconciliation-backfill-requested',
      actorTeammateId: caller.teammateId,
      subjectKind: 'reconciliation-backfill',
      subjectId: created!.id,
      payload: { provider, target_kind: body.targetKind, external_ref: externalRef, start_date: body.startDate, end_date: endDate },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: created!.id, provider, targetKind: body.targetKind, externalRef, displayName, startDate: body.startDate, endDate, status: 'pending' }
  })
})
