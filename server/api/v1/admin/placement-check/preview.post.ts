/*
 * POST /api/v1/admin/placement-check/preview — whose derived home a proposed
 * directory rule would change, decided over the stored evidence with the live rules
 * and with the live rules plus this one (docs/design/placement-check/00-spec.md P8).
 * The body is validated and its target resolved exactly as the rule upsert does.
 * Writes nothing. Platform-admin only.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { resolveDirectoryRuleTarget } from '../../../../reconciliation/directory-rule-target'
import { previewPlacementRule } from '../../../../reconciliation/placement-check-read'
import { normalizeMatchValue } from '../../../../../shared/placement/region-attributes'
import { DirectoryRegionRuleBody } from '../../../../../shared/schemas/directory-region-rule'
import type { PlacementRulePreviewResponse } from '../../../../../shared/placement/placement-check'

export default defineEventHandler(async (event): Promise<PlacementRulePreviewResponse> => {
  await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, DirectoryRegionRuleBody)
  return withRequestRls(event, async (tx) => {
    const target = await resolveDirectoryRuleTarget(tx, body)
    return previewPlacementRule(tx, {
      attribute: body.attribute,
      matchMode: body.match_mode,
      value: normalizeMatchValue(body.match_value),
      target: { regionId: target.regionId, orgUnitId: target.orgUnitId },
    })
  })
})
