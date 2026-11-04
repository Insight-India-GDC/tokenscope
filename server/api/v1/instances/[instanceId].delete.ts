/*
 * DELETE /api/v1/instances/{instanceId} — admin-only force-end.
 *
 * Per api-and-connector-interfaces.md §1.4. Auth via the dashboard
 * session cookie + admin role. Same DB effect as /end but tagged
 * session-admin-deleted in audit_event.
 */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertSameOrigin } from '../../../auth/csrf'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { canModifyHolderOf } from '../../../auth/admin-guards'
import type { Role } from '../../../../shared/auth/roles'
import { schema } from '../../../db'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  // admin (region-scoped) + platform-admin (org-wide) — both can revoke an
  // instance from the admin instances view; requireRegionScope below bounds admin.
  const session = await requireRole(event, 'admin')
  // safeParse → 400 (AUTH-7): a bare .parse throws a raw ZodError → 500.
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  // ONE transaction carrying the caller's RLS identity: read → region gate →
  // force-end → audit.
  await withRequestRls(event, async (tx) => {
    const [row] = await tx
      .select({
        instanceId: schema.instanceAttestation.instanceId,
        tsActualEnd: schema.instanceAttestation.tsActualEnd,
        regionId: schema.teammate.regionId,
        teammateRole: schema.teammate.role,
      })
      .from(schema.instanceAttestation)
      .innerJoin(schema.teammate, eq(schema.teammate.id, schema.instanceAttestation.teammateId))
      .where(eq(schema.instanceAttestation.instanceId, sid))
      .limit(1)
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Instance not found' })

    // Region-bound the admin to the session's region: the region the device's
    // teammate sits in now, the same boundary GET /admin/instances lists by. RLS
    // is inert at runtime while the app connects as the table OWNER, so without
    // this any admin could force-end a session in any region by id.
    //
    // It does NOT become redundant once enforcement lands, but not for the reason
    // this comment used to give — it claimed `instance_attestation` "carries no
    // RLS policy at all", which is false: 0002 enabled it (as
    // `session_attestation`), 0019 renamed it and 0098 altered the live
    // `instance_attestation_region_scope`. The real reason is that the policy's
    // region arm and this check are the SAME boundary asserted twice, and the
    // table is in RLS_BOOTSTRAP_TABLES — DISABLEd at the role switch — so for
    // that window this app-level gate is the only one running.
    await requireRegionScope(event, row.regionId)
    if (!canModifyHolderOf(session.role, row.teammateRole as Role)) {
      throw createError({ statusCode: 403, statusMessage: 'Only an Admin may act on this teammate' })
    }

    if (!row.tsActualEnd) {
      await tx
        .update(schema.instanceAttestation)
        .set({ tsActualEnd: new Date() })
        .where(eq(schema.instanceAttestation.instanceId, sid))
    }

    await recordAuditEvent(tx, {
      eventType: 'session-admin-deleted',
      actorTeammateId: session.teammateId,
      actorSystem: 'admin',
      subjectKind: 'session',
      subjectId: sid,
      payload: { adminEmail: session.email },
    })
  })

  setResponseStatus(event, 204)
  return null
})
