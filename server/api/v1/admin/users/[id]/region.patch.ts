/*
 * PATCH /api/v1/admin/users/:id/region { region_id, org_unit_id? } — move a
 * teammate to another region. Cross-region reassignment is org-wide, so only
 * platform-admin may do it. The write and its revoke cascade are
 * server/db/reassign-teammate-region.ts, shared with placement-check apply.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { reassignTeammateRegion } from '../../../../../db/reassign-teammate-region'

const Body = z.object({
  region_id: z.string().uuid(),
  org_unit_id: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)

  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid teammate id' })
  const body = await readValidated(event, Body)

  const result = await withRequestRls(event, (tx) =>
    reassignTeammateRegion(tx as never, {
      teammateId: id.data,
      regionId: body.region_id,
      orgUnitId: body.org_unit_id,
      caller: { teammateId: caller.teammateId },
    }),
  )

  return { ok: true, previousRegionId: result.previousRegionId, newRegionId: result.newRegionId, orgUnitId: result.orgUnitId }
})
