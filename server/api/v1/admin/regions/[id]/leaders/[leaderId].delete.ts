/*
 * DELETE /api/v1/admin/regions/{id}/leaders/{leaderId} — revoke a region
 * leader (region derivation, mig 0068). Soft-revoke: the row keeps its
 * history (revoked_at/revoked_by); re-assignment later is a new row, which
 * the partial-unique index permits once the old one is revoked.
 * platform-admin only (see leaders.post.ts).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../../db/audit'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'region id')
  const leaderId = requireUuidParam(event, 'leaderId', 'leader id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const regionRows = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${id}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) {
      throw createError({ statusCode: 404, statusMessage: 'Region not found' })
    }

    // Soft-revoke by region_leader.id, scoped to the region in the path so a
    // leader id from another region can't be revoked through this region's URL.
    const revoked = await tx.execute<{ id: string; leader_oid: string; leader_email: string }>(sql`
      UPDATE region_leader
      SET revoked_at = now(), revoked_by = ${caller.teammateId}::uuid
      WHERE id = ${leaderId}::uuid
        AND region_id = ${id}::uuid
        AND revoked_at IS NULL
      RETURNING id::text AS id, leader_oid, leader_email
    `)
    const row = [...revoked][0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'No active leader with this id in this region' })
    }

    await recordAuditEvent(tx, {
      eventType: 'region-leader-revoked',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: id,
      payload: {
        leader_id: leaderId,
        leader_oid: row.leader_oid,
        leader_email: row.leader_email,
        region_code: regionRow.code,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { revoked: true, id: leaderId }
  })
})
