/*
 * POST /api/v1/admin/diagnostics/provider-wire-shape — what do the providers
 * actually send?
 *
 * WHY A POST. It issues LIVE provider calls. A GET would fire on page render, so
 * every admin opening Diagnostics would spend provider budget and walk into rate
 * limits. The trigger is an explicit button, and the free stored-scan mode is the
 * default so a mis-click cannot cost anything.
 *
 * RBAC: requireRole('platform-admin'), matching network.get.ts:23 and
 * otel-logs.get.ts:43 rather than the wider admin/platform-admin tier the rest of
 * diagnostics uses. Same reason those two are gated there: this returns RAW
 * provider error bodies and infrastructure-level configuration, and it spends
 * real provider budget. assertSameOrigin because it is a POST (the
 * telemetry-recovery.post.ts convention).
 *
 * AUDITED IN TWO PARTS via recordAuditEvent — this is a privileged operator
 * action that reaches a third party, so who ran it, when, against which surfaces
 * and with what outcome is recorded. An ATTEMPT row is written BEFORE any
 * provider call and an OUTCOME row after: auditing only on the way out means a
 * thrown probe, a crash, or a failed audit write leaves real outbound calls with
 * no record that they were ever made. The payloads carry statuses and counts
 * only: no shape values, no error bodies, no credential, nothing identifying.
 *
 * DB ACCESS: the probe is handed a RUNNER, `(fn) => withRequestRls(event, fn)`,
 * not a handle. Every one of its DB reads therefore runs with the RLS session
 * GUCs set, in its own SHORT transaction that closes before the provider fetch
 * that follows it. Nothing here reaches for the raw pooled handle — the UF-1(a)
 * ratchet (scripts/check-handler-rls-context.mjs) is satisfied on its own terms,
 * not by an allowlist entry — and no transaction is ever held open across a
 * provider call. See DbRunner in server/diagnostics/provider-wire-probe.ts.
 *
 * (That checker greps the file's TEXT, comments included, so do not name the
 * raw-handle accessor here even to say we avoid it.)
 *
 * Read-only: nothing in the probe writes, backfills or mutates.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { readValidated } from '../../../../utils/validated-body'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { isRealUtcDay } from '#shared/schemas/activity'
import {
  runWireShapeProbe,
  defaultProbeDay,
  STORED_DEFAULT_WINDOW_DAYS,
  STORED_DEFAULT_ROW_LIMIT,
  STORED_MAX_ROW_LIMIT,
  type WireShapeReport,
} from '../../../../diagnostics/provider-wire-probe'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const Body = z.object({
  /*
   * Defaults to the FREE mode. 'live' and 'both' issue real provider calls, so
   * spending budget is always something the caller asked for explicitly.
   */
  mode: z.enum(['live', 'stored', 'both']).default('stored'),
  /** UTC day for the live probe. Defaults to yesterday — a day the providers have populated. */
  day: z
    .string()
    .regex(DAY_RE, 'day must be a UTC calendar day formatted YYYY-MM-DD')
    .refine(isRealUtcDay, 'not a real calendar day')
    .optional(),
  /** How far back the stored scan looks. */
  storedWindowDays: z.number().int().min(1).max(365).default(STORED_DEFAULT_WINDOW_DAYS),
  /** Row cap for the stored scan. Reported back so a truncated scan cannot read as exhaustive. */
  storedRowLimit: z.number().int().min(1).max(STORED_MAX_ROW_LIMIT).default(STORED_DEFAULT_ROW_LIMIT),
})

/** Per-surface outcome for the audit payload — statuses and counts only. */
function auditSurfaces(report: WireShapeReport): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const s of [...report.live, ...report.stored]) {
    rows.push({
      id: s.id,
      mode: s.mode,
      status: s.status,
      item_count: s.status === 'ok' ? s.summary.itemCount : null,
      drift_status: s.status === 'ok' ? s.drift.status : null,
      undeclared_count: s.status === 'ok' ? s.undeclared.paths.length : null,
      provider_status: s.mode === 'live' && s.status === 'errored' ? s.error.status : null,
    })
  }
  return rows
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const day = body.day ?? defaultProbeDay()

  const request = {
    mode: body.mode,
    day,
    stored_window_days: body.storedWindowDays,
    stored_row_limit: body.storedRowLimit,
  }
  const audit = (eventType: string, payload: Record<string, unknown>) =>
    withRequestRls(event, (tx) =>
      recordAuditEvent(tx, {
        eventType,
        actorTeammateId: caller.teammateId,
        subjectKind: 'provider-wire-shape',
        subjectId: null,
        payload,
        ipAddress: ip,
        userAgent: ua,
      }),
    )

  /*
   * ATTEMPT first. Everything after this line can issue a real provider call, so
   * the record that it was attempted must already be durable — an outcome-only
   * audit is written by code that may never run.
   */
  await audit('provider-wire-shape-probe-attempted', { ...request, phase: 'attempt' })

  let report
  try {
    report = await runWireShapeProbe((fn) => withRequestRls(event, fn), {
      mode: body.mode,
      day,
      storedWindowDays: body.storedWindowDays,
      storedRowLimit: body.storedRowLimit,
    })
  } catch (err) {
    // Best-effort outcome. The attempt row above is the durable one; failing to
    // write this must not replace the operator's real error with an audit error.
    await audit('provider-wire-shape-probed', {
      ...request,
      outcome: 'failed',
      error: err instanceof Error ? err.name : 'unknown',
      surfaces: [],
    }).catch(() => undefined)
    throw err
  }

  await audit('provider-wire-shape-probed', {
    ...request,
    outcome: 'completed',
    surfaces: auditSurfaces(report),
  })

  return report
})
