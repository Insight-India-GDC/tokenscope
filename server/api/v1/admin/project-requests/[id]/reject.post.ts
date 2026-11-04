/*
 * POST /api/v1/admin/project-requests/{id}/reject — an admin turns down a
 * pending request with a required note. Conditional on status = 'pending': a
 * second decision or a racing withdraw is a 409.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { readValidated } from '../../../../../utils/validated-body'
import { requireRole, requireRegionScopeOrNotFound } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { RejectProjectRequestBody } from '../../../../../projects/schemas'
import {
  closeRequestInboxItems,
  loadProjectRequest,
  notifyRequestDecided,
} from '../../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'request id')
  const body = await readValidated(event, RejectProjectRequestBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const notFound = createError({ statusCode: 404, statusMessage: 'Project request not found' })

  return await withRequestRls(event, async (tx) => {
    const req = await loadProjectRequest(tx, id)
    if (!req) throw notFound
    await requireRegionScopeOrNotFound(event, req.region_id, notFound)

    const decided = await tx.execute<{ id: string }>(sql`
      UPDATE project_request
         SET status = 'rejected', decided_by = ${caller.teammateId}::uuid, decided_at = now(),
             decision_note = ${body.note}
       WHERE id = ${id}::uuid AND status = 'pending'
       RETURNING id::text AS id
    `)
    if (![...decided][0]) {
      throw createError({ statusCode: 409, statusMessage: 'This request was already decided or withdrawn' })
    }

    await recordAuditEvent(tx, {
      eventType: 'project-request-rejected',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project_request',
      subjectId: id,
      payload: { before: { status: 'pending' }, after: { status: 'rejected' }, context: { note: body.note } },
      ipAddress: ip,
      userAgent: ua,
    })
    await closeRequestInboxItems(tx, id, caller.teammateId)
    await notifyRequestDecided(tx, req, { status: 'rejected', note: body.note, projectCode: null, projectName: null })

    return { request: await loadProjectRequest(tx, id) }
  })
})
