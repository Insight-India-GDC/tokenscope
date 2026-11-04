/*
 * POST /api/v1/admin/org-units/{id}/owners — assign a cost-centre owner
 * (J4, mig 0048). admin (region-scoped) / platform-admin.
 *
 * The org unit must be a cost-owning unit — ownership is the P&L relationship,
 * and the owner is typically 2-3 levels removed from the unit in the org chart,
 * so ANY active teammate in the region (or outside it, for global roles) can be
 * assigned; their org role does not change.
 *
 * Two ways to identify the owner — consistent with the region-leaders picker:
 *   - { teammate_id } — an EXISTING teammate (the legacy path).
 *   - { oid }         — an Entra DIRECTORY pick (GET /admin/directory/search). The
 *                       owner may not be a teammate yet (owners are execs/leads who
 *                       often haven't signed in), so we FIND-OR-PROVISION the
 *                       teammate from the directory identity (placed in THIS
 *                       cost-centre's region default unit, role 'developer' — the
 *                       P&L grant is independent of org role), then assign.
 *                       Provisioning a new person is platform-admin only.
 * Re-assigning after a revoke is allowed; duplicate ACTIVE ownership 409s on the
 * partial unique index. The checks and the audit event live in
 * server/db/org-unit-owner-assign.ts, shared with Org setup.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { getDirectoryUserByOid } from '../../../../../azure/directory'
import { assignUnitOwner } from '../../../../../db/org-unit-owner-assign'

// Exactly one of teammate_id / oid — the picker sends oid (directory), legacy
// callers may still send teammate_id.
const Body = z
  .object({
    teammate_id: z.string().uuid().optional(),
    oid: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => (b.teammate_id ? 1 : 0) + (b.oid ? 1 : 0) === 1, {
    message: 'Provide exactly one of teammate_id or oid',
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'org unit id')
  const body = await readValidated(event, Body)
  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null

  // Directory pick: re-resolve identity SERVER-SIDE (never trust a client email /
  // display name) BEFORE the tx — getDirectoryUserByOid is a Graph call.
  const dir = body.oid ? await getDirectoryUserByOid(body.oid) : null
  if (body.oid && !dir) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Directory user not found',
      data: {
        type: 'https://tokenscope.example.com/errors/directory-user',
        title: 'Directory user not found',
        status: 404,
        detail: 'No Entra directory user matches that object id.',
      },
    })
  }
  return await withRequestRls(event, async (tx) => {
    const r = await assignUnitOwner(
      tx,
      { orgUnitId: id, owner: dir ? { dir } : { teammateId: body.teammate_id! } },
      {
        caller: { teammateId: caller.teammateId, role: caller.role },
        assertRegionScope: async (regionId) => {
          await requireRegionScope(event, regionId)
        },
        ipAddress,
        userAgent,
      },
    )
    return {
      id: r.id,
      teammate_id: r.teammateId,
      email: r.email,
      display_name: r.displayName,
      identity_adopted: r.identityAdopted,
      provisioned: r.provisioned,
    }
  })
})
