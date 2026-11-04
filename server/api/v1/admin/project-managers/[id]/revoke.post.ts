/*
 * POST /api/v1/admin/project-managers/{id}/revoke — take a teammate off the
 * PMO list (soft revoke, mig 0164). Platform-admin only (A3). Projects the
 * holder already created, and their PM assignments on them, are untouched.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'grant id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{ teammate_id: string }>(sql`
      UPDATE project_manager_grant
         SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
       WHERE id = ${id}::uuid AND revoked_at IS NULL
       RETURNING teammate_id::text AS teammate_id
    `)
    const revoked = [...rows][0]
    if (!revoked) {
      const exists = [...(await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM project_manager_grant WHERE id = ${id}::uuid
      `))][0]
      throw createError(
        exists
          ? { statusCode: 409, statusMessage: 'Grant already revoked' }
          : { statusCode: 404, statusMessage: 'Grant not found' },
      )
    }

    await recordAuditEvent(tx, {
      eventType: 'project-manager-revoked',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: revoked.teammate_id,
      payload: { grant_id: id },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, teammate_id: revoked.teammate_id, revoked: true }
  })
})
