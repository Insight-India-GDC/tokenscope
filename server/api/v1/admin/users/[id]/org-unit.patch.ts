/*
 * PATCH /api/v1/admin/users/:id/org-unit { org_unit_id } — move a
 * teammate to another cost centre WITHIN their existing region.
 *
 * Why this is distinct from the region PATCH: this is an intra-region
 * move. It changes which cost centre the teammate's spend rolls up to,
 * but NOT what they can see — their region scope and org_path-derived
 * visibility are unchanged. So, unlike PATCH .../region (which re-scopes
 * a teammate and therefore bumps revoked_at to force a re-login), this
 * endpoint must NOT bump revoked_at: the teammate's live sessions stay
 * valid.
 *
 * Admin / platform-admin only. Everything below the request parsing —
 * the region-scope check, the target-unit containment, the provenance
 * strip and the audit row — is server/db/place-teammate.ts, SHARED with
 * POST /admin/users/bulk-place so the two surfaces cannot drift on who
 * may move whom. This one keeps the 'any-active-unit' target policy: it
 * is a general per-row move, not the "get spend to a cost centre" bulk
 * action, and moving someone onto a plain team node is legitimate here.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { placeTeammate, REHOME_REMOVED_DETAIL } from '../../../../../db/place-teammate'

const Body = z
  .object({
    org_unit_id: z.string().uuid(),
    // Accepted only to be refused: see REHOME_REMOVED_DETAIL.
    rehome: z.unknown().optional(),
  })
  .refine((d) => d.rehome === undefined, { message: REHOME_REMOVED_DETAIL })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const idParse = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParse.success) throw createError({ statusCode: 400, statusMessage: 'Invalid teammate id' })
  const teammateId = idParse.data
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const placed = await placeTeammate(event, tx, {
      teammateId,
      orgUnitId: body.org_unit_id,
      targetPolicy: 'any-active-unit',
      caller: { teammateId: caller.teammateId },
      ipAddress: ip,
      userAgent: ua,
    })
    // `outcome` is additive and rides the same shared rule as the bulk door:
    // 'noop' means they were already in that unit, so nothing was written and
    // (crucially) the manager-chain provenance was NOT stripped.
    return {
      id: placed.id,
      org_unit_id: placed.orgUnitId,
      outcome: placed.outcome,
    }
  })
})
