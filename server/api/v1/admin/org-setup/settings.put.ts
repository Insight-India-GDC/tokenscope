/*
 * PUT /api/v1/admin/org-setup/settings — set the top of the organisation and/or the
 * re-read cadence (docs/design/org-setup/00-spec.md). A top person different from the
 * stored one starts a placement-check cycle in the same transaction, so the page's
 * passes read the directory under the new top. Platform-admin only; audited with the
 * before and after values.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { readValidated } from '../../../../utils/validated-body'
import { loadOrgSetupSettings } from '../../../../reconciliation/org-setup-store'
import { startPlacementCycle } from '../../../../reconciliation/placement-check-store'
import { READ_CADENCES, type OrgSetupSettings } from '../../../../../shared/org-setup/contract'

const Body = z
  .object({
    top: z
      .object({
        oid: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((s) => !s.startsWith('bill:') && !s.startsWith('provisional:'), 'must be a directory object id'),
        name: z.string().trim().max(400).nullable(),
        email: z.string().trim().max(320).nullable(),
      })
      .strict()
      .optional(),
    readCadence: z.enum(READ_CADENCES).optional(),
  })
  .strict()

export default defineEventHandler(async (event): Promise<OrgSetupSettings> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    // Lock before reading `before`, so two concurrent saves audit a consistent chain.
    await tx.execute(sql`SELECT 1 FROM org_setup_setting WHERE id FOR UPDATE`)
    const before = await loadOrgSetupSettings(tx)
    const top = body.top ?? before.top
    const cadence = body.readCadence ?? before.readCadence
    await tx.execute(sql`
      UPDATE org_setup_setting
      SET top_oid = ${top?.oid ?? null}, top_name = ${top?.name ?? null}, top_email = ${top?.email ?? null},
          read_cadence = ${cadence}, updated_by = ${caller.teammateId}::uuid, updated_at = NOW()
      WHERE id`)
    const after = await loadOrgSetupSettings(tx)

    let cycleId: string | null = null
    if (body.top && body.top.oid !== before.top?.oid) {
      const cycle = await startPlacementCycle(tx, caller.teammateId)
      cycleId = cycle.id
      await recordAuditEvent(tx, {
        eventType: 'placement-check-started',
        actorTeammateId: caller.teammateId,
        subjectKind: 'placement_check_cycle',
        subjectId: cycle.id,
        payload: { cycle_id: cycle.id, trigger: 'org-setup-top-changed' },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'org-setup-settings-changed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: {
        before: { top: before.top, read_cadence: before.readCadence },
        after: { top: after.top, read_cadence: after.readCadence },
        cycle_id: cycleId,
      },
      ipAddress: ip,
      userAgent: ua,
    })
    return after
  })
})
