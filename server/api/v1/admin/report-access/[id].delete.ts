/*
 * DELETE /api/v1/admin/report-access/{id} — revoke a report-access grant
 * (mig 0129, replaces the three-mode admin dial's write side, task #19).
 * Soft-revoke: the row keeps its history (revoked_at/revoked_by), like
 * cou_owner (mig 0048) — a re-grant later is a new row.
 *
 * ORG-WIDE ONLY (A4): requireRole(event, 'platform-admin').
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'report-access grant id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{
      id: string
      teammate_id: string
      permission: string
      granted_at: string
      expires_at: string | null
    }>(sql`
      UPDATE report_access_grant
         SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
       WHERE id = ${id}::uuid AND revoked_at IS NULL
       RETURNING id::text AS id, teammate_id::text AS teammate_id, permission,
                 granted_at::text AS granted_at, expires_at::text AS expires_at
    `)
    const row = [...rows][0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'No active grant',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'No active grant',
          status: 404,
          detail: 'No active report-access grant matches that id.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'report-access-revoked',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: row.teammate_id,
      payload: {
        before: { permission: row.permission, granted_at: row.granted_at, expires_at: row.expires_at },
        after: { revoked_at: new Date().toISOString() },
        context: { grant_id: row.id, teammate_id: row.teammate_id },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { revoked: true, id: row.id }
  })
})
