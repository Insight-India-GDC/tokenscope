/*
 * PUT /api/v1/admin/workers/enablement — turn a scheduled worker on or off.
 *
 * The write side of the admin kill-switch (mig 0090). Takes effect on the worker's
 * VERY NEXT tick — no deploy, no infra change. Every toggle is attributed
 * (updated_by/at) and audited.
 *
 * RBAC: requireRole(platform-admin). NOT region-scoped `admin`, for the same reason
 * the RUN twin gives at [name]/run.post.ts:29-33 — `worker_enablement` has no region
 * column (mig 0090), and every worker it governs operates GLOBALLY, so a toggle
 * exceeds a region admin's scope. Disabling is the stronger case of the two: forcing
 * a run costs a sweep, whereas turning one off stops attribution, budget alerts or
 * spoof detection fleet-wide until someone notices. The read side (enablement.get)
 * stays open to `admin` — seeing the estate's kill-switch state is not a region
 * boundary crossing.
 */
import { defineEventHandler, createError, getHeader, getRequestIP } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { WORKERS } from '../../../../workers/registry'
import { setWorkerEnabled } from '../../../../workers/enablement'
import { isWorkerScheduled } from '../../../../../shared/workers/unscheduled'
import { recordAuditEvent } from '../../../../db/audit'
import { readValidated } from '../../../../utils/validated-body'

const bodySchema = z.object({
  workerName: z.string().min(1),
  enabled: z.boolean(),
  // Why it is being turned off. Required for a disable so the next person (or the
  // next incident) is not left guessing; meaningless for an enable, which clears it.
  reason: z.string().min(1).max(500).optional(),
})

export default defineEventHandler(async (event) => {
  // CSRF: this control can stop attribution / budget alerting / spoof detection
  // fleet-wide, so a logged-in admin must not be cross-site-forced into it.
  assertSameOrigin(event)
  const session = await requireRole(event, 'platform-admin')
  const body = await readValidated(event, bodySchema)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Only real registry workers — a typo would otherwise create a dead row that
  // silently governs nothing and reads as a configured control.
  if (!WORKERS.some((w) => w.name === body.workerName)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown worker '${body.workerName}'` })
  }
  // Same rule, second case: a worker with no cron job never ticks, so a row
  // governing its runs governs nothing. The UI already offers no toggle for these;
  // without this the API would still mint the dead row a script or a stale client
  // could create, and it would then render as a configured control on the card.
  if (!isWorkerScheduled(body.workerName)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Worker '${body.workerName}' has no scheduled job, so enabling or disabling it has no effect`,
    })
  }
  if (!body.enabled && !body.reason) {
    throw createError({ statusCode: 400, statusMessage: 'A reason is required when disabling a worker' })
  }

  return withRequestRls(event, async (db) => {
    await setWorkerEnabled(db, {
      workerName: body.workerName,
      enabled: body.enabled,
      reason: body.reason ?? null,
      updatedBy: session.teammateId,
    })
    // Stopping a worker can halt attribution / alerting fleet-wide — that belongs
    // in the audit trail, not just in a column.
    await recordAuditEvent(db, {
      eventType: body.enabled ? 'worker-enabled' : 'worker-disabled',
      actorTeammateId: session.teammateId,
      subjectKind: 'worker',
      payload: { worker: body.workerName, reason: body.reason ?? null },
      ipAddress: ip,
      userAgent: ua,
    })
    return { workerName: body.workerName, enabled: body.enabled, reason: body.reason ?? null }
  })
})
