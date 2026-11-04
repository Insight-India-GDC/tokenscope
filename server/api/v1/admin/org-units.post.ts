/*
 * POST /api/v1/admin/org-units — create a cost centre / org unit
 * (admin org-units tab, design-notes §Screen 5).
 *
 * A "cost centre" is just an org_unit with is_cost_owning_unit = true — the same
 * row shape, so this one endpoint mints both. Validation, the LTREE path and the
 * audit event live in server/db/org-unit-create.ts, shared with Org setup.
 *
 * Scope: admin / platform-admin only; a region admin is bound to their own
 * region (requireRegionScope), and a child unit's parent must live in the
 * same region.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import {
  ORG_UNIT_CODE_MAX,
  ORG_UNIT_CODE_MIN,
  ORG_UNIT_CODE_PATTERN,
  RESERVED_ORG_UNIT_CODE,
  createOrgUnit,
} from '../../../db/org-unit-create'

const Body = z.object({
  region_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().optional(),
  code: z.string().min(ORG_UNIT_CODE_MIN).max(ORG_UNIT_CODE_MAX).regex(ORG_UNIT_CODE_PATTERN, 'invalid org unit code'),
  display_name: z.string().min(1).max(200),
  unit_type: z.string().min(1).max(40),
  is_cost_owning_unit: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  // The reserved code is refused before the region-scope check, as it always was.
  if (body.code !== RESERVED_ORG_UNIT_CODE) await requireRegionScope(event, body.region_id)

  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const created = await createOrgUnit(
      tx,
      {
        regionId: body.region_id,
        parentId: body.parent_id ?? null,
        code: body.code,
        displayName: body.display_name,
        unitType: body.unit_type,
        isCostOwningUnit: body.is_cost_owning_unit,
      },
      { actorTeammateId: caller.teammateId, ipAddress, userAgent },
    )
    return { id: created.id, code: created.code, path: created.path, is_cost_owning_unit: created.isCostOwningUnit }
  })
})
