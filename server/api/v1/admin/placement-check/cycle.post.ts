/*
 * POST /api/v1/admin/placement-check/cycle — start a placement check: every active
 * person becomes due for a pass (docs/design/placement-check/00-spec.md P4).
 * Platform-admin only; audited.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { startPlacementCycle } from '../../../../reconciliation/placement-check-store'

export default defineEventHandler(async (event): Promise<{ id: string; startedAt: string }> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  return withRequestRls(event, async (tx) => {
    const cycle = await startPlacementCycle(tx, caller.teammateId)
    await recordAuditEvent(tx, {
      eventType: 'placement-check-started',
      actorTeammateId: caller.teammateId,
      subjectKind: 'placement_check_cycle',
      subjectId: cycle.id,
      payload: { cycle_id: cycle.id },
      ipAddress: ip,
      userAgent: ua,
    })
    return cycle
  })
})
