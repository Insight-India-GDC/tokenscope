/*
 * GET /api/v1/admin/org-setup/settings — the top of the organisation and the
 * directory re-read cadence (docs/design/org-setup/00-spec.md). Platform-admin only.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { loadOrgSetupSettings } from '../../../../reconciliation/org-setup-store'
import type { OrgSetupSettings } from '../../../../../shared/org-setup/contract'

export default defineEventHandler(async (event): Promise<OrgSetupSettings> => {
  await requireRole(event, 'platform-admin')
  return withRequestRls(event, (tx) => loadOrgSetupSettings(tx))
})
