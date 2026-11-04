/*
 * GET /api/v1/admin/placement-check — every checked person's current home against
 * what the stored directory evidence derives under the CURRENT config
 * (docs/design/placement-check/00-spec.md P5). Platform-admin only.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { requestClock } from '../../../../utils/request-clock'
import { loadPlacementCheck } from '../../../../reconciliation/placement-check-read'
import type { PlacementCheckResponse } from '../../../../../shared/placement/placement-check'

export default defineEventHandler(async (event): Promise<PlacementCheckResponse> => {
  await requireRole(event, 'platform-admin')
  const { today } = requestClock(event)
  return withRequestRls(event, (tx) => loadPlacementCheck(tx, { today }), { isolationLevel: 'repeatable read' })
})
