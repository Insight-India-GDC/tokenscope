/*
 * POST /api/v1/me/project-requests/{id}/withdraw — the requester withdraws a
 * pending request. A conditional update on status = 'pending': losing a race
 * to an admin's decision is a 409. Someone else's request is a 404.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { closeRequestInboxItems } from '../../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'request id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE project_request
         SET status = 'withdrawn', decided_by = ${session.teammateId}::uuid, decided_at = now()
       WHERE id = ${id}::uuid
         AND requester_teammate_id = ${session.teammateId}::uuid
         AND status = 'pending'
       RETURNING id::text AS id
    `)
    if (![...rows][0]) {
      const own = [...(await tx.execute<{ status: string }>(sql`
        SELECT status FROM project_request
        WHERE id = ${id}::uuid AND requester_teammate_id = ${session.teammateId}::uuid
      `))][0]
      throw createError(
        own
          ? { statusCode: 409, statusMessage: `This request is already ${own.status}` }
          : { statusCode: 404, statusMessage: 'Project request not found' },
      )
    }

    await closeRequestInboxItems(tx, id, session.teammateId)
    await recordAuditEvent(tx, {
      eventType: 'project-request-withdrawn',
      actorTeammateId: session.teammateId,
      subjectKind: 'project_request',
      subjectId: id,
      payload: { before: { status: 'pending' }, after: { status: 'withdrawn' } },
      ipAddress: ip,
      userAgent: ua,
    })
    return { id, status: 'withdrawn' as const }
  })
})
