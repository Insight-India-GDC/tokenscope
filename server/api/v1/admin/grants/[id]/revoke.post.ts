/*
 * POST /api/v1/admin/grants/{id}/revoke — admin revoke of a teammate's grant,
 * region-scoped. Design doc §Grant lifecycle (F3.3, F3.4).
 *
 * Two-layer RBAC:
 *   - requireRole(admin) at the edge.
 *   - assertSameOrigin — admin actions run on the dashboard cookie session, so
 *     they carry the CSRF Origin check (same as the admin instance DELETE).
 *   - Region scope (F3.3): `oauth_token` has NO region, so we join the grant to
 *     its owning teammate, read teammate.region_id, and run
 *     requireRegionScope(event, region_id). A region admin revoking a
 *     peer-region teammate's grant gets the 403 (platform-admin
 *     are region-unbounded). RLS is inert under the owner connection, so this is
 *     the live gate. A missing grant 404s (no existence oracle leaked by scope).
 *   - Holder rule (canModifyHolderOf): a region admin may not revoke a
 *     platform-admin's grant.
 *
 * Effect: the SAME revokeGrant primitive as the user path — sets revoked_at and,
 * for an EMIT-scoped grant, ends the OWNING teammate's live instance_attestation
 * rows (F3.4) so the went-silent detector sees expected silence. Audited.
 */
import { createError, defineEventHandler } from 'h3'
import { eq } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { canModifyHolderOf } from '../../../../../auth/admin-guards'
import type { Role } from '../../../../../../shared/auth/roles'
import { schema } from '../../../../../db'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { revokeGrant } from '../../../../../utils/grant-revoke'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireRole(event, 'admin')
  const id = requireUuidParam(event, 'id', 'grant id')

  // ONE transaction carrying the caller's RLS identity: join → region gate →
  // revoke (+ the emit cascade) → audit. The gate throws before any mutation,
  // and a throw after one rolls it back.
  const result = await withRequestRls(event, async (tx) => {
    // Join the grant to its owning teammate for the region scope axis.
    const [row] = await tx
      .select({
        id: schema.oauthToken.id,
        teammateId: schema.oauthToken.teammateId,
        scope: schema.oauthToken.scope,
        revokedAt: schema.oauthToken.revokedAt,
        instanceId: schema.oauthToken.instanceId,
        regionId: schema.teammate.regionId,
        teammateEmail: schema.teammate.email,
        teammateRole: schema.teammate.role,
      })
      .from(schema.oauthToken)
      .innerJoin(schema.teammate, eq(schema.teammate.id, schema.oauthToken.teammateId))
      .where(eq(schema.oauthToken.id, id))
      .limit(1)

    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'Grant not found' })
    }

    // Region-bound the admin to the GRANT-OWNER's region. A region admin revoking
    // a peer-region grant is refused here (403), before any mutation.
    await requireRegionScope(event, row.regionId)
    if (!canModifyHolderOf(session.role, row.teammateRole as Role)) {
      throw createError({ statusCode: 403, statusMessage: 'Only an Admin may act on this teammate' })
    }

    const revoked = await revokeGrant(tx, row)

    await recordAuditEvent(tx, {
      eventType: 'grant-revoked',
      actorTeammateId: session.teammateId,
      actorSystem: 'admin',
      subjectKind: 'grant',
      subjectId: id,
      payload: {
        adminEmail: session.email,
        grantTeammateId: row.teammateId,
        grantTeammateEmail: row.teammateEmail,
        isEmit: revoked.isEmit,
        instancesEnded: revoked.instancesEnded,
        alreadyRevoked: !revoked.revoked,
      },
    })

    return revoked
  })

  return { id, revoked: result.revoked, is_emit: result.isEmit, instances_ended: result.instancesEnded }
})
