/*
 * POST /api/v1/admin/org-setup/dismissals — set an Org setup decision aside until a
 * later placement-check cycle (docs/design/org-setup/00-spec.md). Only the kinds in
 * DISMISSIBLE_KINDS; 409 when no cycle has started. Idempotent: dismissing the same
 * subject twice in a cycle writes and audits once. Platform-admin only.
 */
import { createError, defineEventHandler, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { readValidated } from '../../../../utils/validated-body'
import { currentPlacementCycle } from '../../../../reconciliation/placement-check-store'
import { DISMISSIBLE_KINDS } from '../../../../../shared/org-setup/contract'

const Body = z
  .object({
    kind: z.enum(DISMISSIBLE_KINDS),
    subjectKey: z.string().trim().min(1).max(500),
  })
  .strict()

interface OrgSetupDismissalResponse {
  kind: (typeof DISMISSIBLE_KINDS)[number]
  subjectKey: string
  cycleId: string
  /** False when this subject was already dismissed in the cycle. */
  created: boolean
}

export default defineEventHandler(async (event): Promise<OrgSetupDismissalResponse> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    const cycle = await currentPlacementCycle(tx)
    if (!cycle) {
      throw createError({
        statusCode: 409,
        statusMessage: 'No check started',
        data: {
          type: 'https://tokenscope.example.com/errors/placement-check-no-cycle',
          title: 'No check started',
          status: 409,
          detail: 'A decision can be set aside only once the directory has been read.',
        },
      })
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO org_setup_dismissal (kind, subject_key, cycle_id, dismissed_by)
      VALUES (${body.kind}, ${body.subjectKey}, ${cycle.id}::uuid, ${caller.teammateId}::uuid)
      ON CONFLICT (kind, subject_key, cycle_id) DO NOTHING
      RETURNING id::text AS id`)
    const created = [...inserted].length > 0
    if (created) {
      await recordAuditEvent(tx, {
        eventType: 'org-setup-decision-dismissed',
        actorTeammateId: caller.teammateId,
        subjectKind: 'org_setup_dismissal',
        subjectId: [...inserted][0]!.id,
        payload: { kind: body.kind, subject_key: body.subjectKey, cycle_id: cycle.id },
        ipAddress: ip,
        userAgent: ua,
      })
    }
    return { kind: body.kind, subjectKey: body.subjectKey, cycleId: cycle.id, created }
  })
})
