/*
 * GET /api/v1/admin/org-setup/decisions — the overview's "For you to decide" cards,
 * built now from stored evidence under the live config, minus what an Admin
 * dismissed in the current cycle (docs/design/org-setup/00-spec.md, Screen 5).
 * Platform-admin only.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { requestClock } from '../../../../utils/request-clock'
import { loadOrgSetupDecisions } from '../../../../reconciliation/org-setup-read'
import type { OrgSetupDecisionsResponse } from '../../../../../shared/org-setup/contract'

export default defineEventHandler(async (event): Promise<OrgSetupDecisionsResponse> => {
  await requireRole(event, 'platform-admin')
  const { today } = requestClock(event)
  return withRequestRls(event, (tx) => loadOrgSetupDecisions(tx, { today }), { isolationLevel: 'repeatable read' })
})
