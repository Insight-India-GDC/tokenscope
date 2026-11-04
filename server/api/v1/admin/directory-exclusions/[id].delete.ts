/*
 * DELETE /api/v1/admin/directory-exclusions/{id} — remove a directory-exclusion
 * pattern (mig 0083). Org-wide config: platform-admin only.
 * Hard delete (the pattern list is small, current-state config, not a history
 * ledger); audited with the removed pattern.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  if (!(isPlatformAdmin(caller.role))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Directory-exclusion patterns are org-wide config; requires an Admin.',
      },
    })
  }
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'exclusion pattern id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const removed = [
      ...(await tx.execute<{ pattern: string }>(sql`
        DELETE FROM directory_exclusion_pattern WHERE id = ${id}::uuid RETURNING pattern
      `)),
    ][0]
    if (!removed) {
      throw createError({ statusCode: 404, statusMessage: 'Exclusion pattern not found' })
    }
    await recordAuditEvent(tx, {
      eventType: 'directory-exclusion-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: { pattern: removed.pattern },
      ipAddress: ip,
      userAgent: ua,
    })
    return { id, pattern: removed.pattern, removed: true }
  })
})
