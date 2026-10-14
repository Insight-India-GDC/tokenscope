/*
 * GET /api/v1/admin/reconciliation/enterprises/{id}/copilot-rate-plans — the
 * effective-dated Copilot rate-plan history for one provider_enterprise
 * (ADR-0011 D9, design §5.3). Newest-starting first, including retired rows
 * (a complete audit trail, not just the live set).
 *
 * RBAC: requireRole(platform-admin).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../../../auth/rbac'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { listCopilotRatePlans } from '../../../../../../governance/copilot-rate-plan'

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): a rate plan hangs off a region-less provider_enterprise, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  return withRequestRls(event, async (tx) => {
    const plans = await listCopilotRatePlans(tx, id)
    return { plans, total: plans.length }
  })
})
