/*
 * DELETE /api/v1/me/identities/{id} — unlink one of my identities. Scoped to
 * the caller (you can only remove your own rows), and to rows the caller linked
 * themselves (source='self'): directory-sync and admin bindings decide which
 * Business Unit carries the person's Copilot usage, so only an admin removes
 * them. The primary teammate email isn't a map row, so it can't be removed
 * here. Audited.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  // ONE transaction carrying the caller's RLS identity: the DELETE and its
  // audit row land together, or neither does.
  await withRequestRls(event, async (tx) => {
    const deleted = await tx.execute<{ identifier: string }>(sql`
      DELETE FROM teammate_identity_map
      WHERE id = ${id.data}::uuid AND teammate_id = ${session.teammateId}::uuid AND source = 'self'
      RETURNING identifier
    `)
    if (deleted.length === 0) throw createError({ statusCode: 404, statusMessage: 'Identity not found' })
    await recordAuditEvent(tx, {
      eventType: 'identity-unlinked',
      actorTeammateId: session.teammateId,
      actorSystem: 'me-identities',
      subjectKind: 'teammate',
      subjectId: session.teammateId,
      payload: { identifier: deleted[0]!.identifier },
    })
  })
  return { removed: true }
})
