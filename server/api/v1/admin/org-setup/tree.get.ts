/*
 * GET /api/v1/admin/org-setup/tree — the managers above TokenScope users, from the
 * stored manager chains rooted at the top person (docs/design/org-setup/00-spec.md).
 * No top set: no nodes. Platform-admin only.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { requestClock } from '../../../../utils/request-clock'
import { loadOrgTree } from '../../../../reconciliation/org-setup-read'
import type { OrgTreeResponse } from '../../../../../shared/org-setup/contract'

export default defineEventHandler(async (event): Promise<OrgTreeResponse> => {
  await requireRole(event, 'platform-admin')
  const { today } = requestClock(event)
  return withRequestRls(event, (tx) => loadOrgTree(tx, { today }), { isolationLevel: 'repeatable read' })
})
