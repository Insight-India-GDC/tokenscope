/*
 * POST /api/v1/admin/placement-check/pass — run one placement-check pass through the
 * worker dispatch path (single-flight, worker_run ledger), on the worker lane like
 * every other admin-triggered worker. Body `{ retryFailed: true }` re-gathers only
 * the current cycle's failed lookups. Platform-admin only; the trigger is audited
 * before the dispatch.
 */
import { createError, defineEventHandler, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { getWorkerDb } from '../../../../db/worker-db'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { readValidated } from '../../../../utils/validated-body'
import { dispatchWorker } from '../../../../workers/dispatch'
import { getWorker } from '../../../../workers/registry'
import type { PlacementCheckResult } from '../../../../workers/placement-check'
import { currentPlacementCycle } from '../../../../reconciliation/placement-check-store'
import type { PlacementPassResponse } from '../../../../../shared/placement/placement-check'

const WORKER = 'placement-check'

const Body = z.object({ retryFailed: z.boolean().optional() }).strict().optional()

function conflict(type: string, title: string, detail: string): never {
  throw createError({
    statusCode: 409,
    statusMessage: title,
    data: { type: `https://tokenscope.example.com/errors/${type}`, title, status: 409, detail },
  })
}

export default defineEventHandler(async (event): Promise<PlacementPassResponse> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = (await readValidated(event, Body)) ?? {}
  const retryFailed = body.retryFailed === true
  const entry = getWorker(WORKER)
  if (!entry) throw createError({ statusCode: 500, statusMessage: `Worker '${WORKER}' is not registered` })
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const cycle = await withRequestRls(event, async (tx) => {
    const current = await currentPlacementCycle(tx)
    if (!current) return null
    await recordAuditEvent(tx, {
      eventType: 'admin-run-worker',
      actorTeammateId: caller.teammateId,
      subjectKind: 'worker',
      payload: { worker: WORKER, trigger: 'placement-check', cycle_id: current.id, retry_failed: retryFailed },
      ipAddress: ip,
      userAgent: ua,
    })
    return current
  })
  if (!cycle) conflict('placement-check-no-cycle', 'No check started', 'Start a placement check before running a pass.')

  const dispatched = await dispatchWorker(await getWorkerDb(), entry, { retryFailed })
  if (dispatched.skipped) {
    conflict('worker-disabled', 'Worker disabled', `Worker '${WORKER}' is disabled in Admin → Workers.`)
  }
  const result = dispatched.result as PlacementCheckResult
  return { checked: result.checked, errors: result.errors, remaining: result.remaining }
})
