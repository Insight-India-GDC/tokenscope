/*
 * Per-dispatch worker-options parsing for the internal run-worker endpoint
 * (server/api/v1/internal/run-worker/[name].post.ts). Extracted into its own
 * module (rather than living in the route file) so it is unit-testable without
 * booting Nitro and without any route-scanner ambiguity around named exports.
 *
 * The options ride the request BODY, which is inside the signed HMAC payload
 * (server/auth/internal-request.ts — the body-sha256 leg of the signed tuple),
 * so a caller cannot set these flags without a valid signature. No
 * signature-scheme change was needed to make the body a trusted input.
 *
 * Honoured options:
 *  - `deepRescan` (azure-monitor-read) — forces a full-window re-read to recover
 *    a read-path backlog after a silent outage. NOTE: "full window" means the
 *    reader's OUTER duration, which defaults to 7 days — pair it with
 *    `lookbackDays` to reach further back.
 *  - `lookbackDays` (azure-monitor-read) — widen the reader's outer scan bound
 *    beyond the 7-day default, up to 90 (the longest retention we provision).
 *    THE recovery lever for a backlog older than a week: the joiner dead-zone
 *    incident left weeks of already-ingested spend unjoined, and without this
 *    a signed re-run silently recovers only the last 7 days and reports success
 *    — indistinguishable from a full recovery. Costs query time proportional to
 *    the window, so use it for one-off recovery, not the cron.
 *  - `sessionIds` (azure-monitor-read) — scope a re-run to specific instance
 *    ids instead of the scheduled selection, so a recovery pass targets the
 *    affected instances rather than re-reading the whole fleet at a wide window.
 *  - `apply` (privileged-identity-cleanup) — the destructive-apply gate: without
 *    it the cleanup worker only REPORTS; with it (and only via this signed body,
 *    never the UI trigger) it may deactivate excluded teammates, under a hard cap.
 *  - `startingAt` / `endingAt` (analytics-poll) — override the default trailing
 *    30-day revision window with an explicit YYYY-MM-DD span. The operator lever
 *    for the #142 historical re-split: re-pulling a pre-split period rewrites its
 *    collapsed rows as per-surface lanes (the poller's stale-row prune converges
 *    the old collapsed rows). The Enterprise Analytics API holds data from
 *    2026-01-01, so that is the earliest useful startingAt.
 *    OPERATOR WARNING: without `externalOrgId` the override re-pulls the FULL
 *    window for EVERY reconciled org, serially, against the 60-RPM org-wide
 *    Enterprise API cap that reconciliation-sync shares — a multi-month
 *    all-orgs re-pull can run long and starve that worker's tick. Prefer
 *    scoping to one org per invocation.
 *  - `externalOrgId` (analytics-poll) — scope the poll (and therefore a window
 *    override) to ONE reconciled org's external id. Unknown id → clean no-op
 *    (orgsPolled 0), visible in the worker result.
 * Every other worker ignores these. The shape is deliberately generic/optional.
 */
import { readRawBody, type H3Event } from 'h3'
import { z } from 'zod'
import type { WorkerRunContext } from './registry'

/*
 * Max instances per WIDENED (lookbackDays) recovery run.
 *
 * The bound is DATA VOLUME, not round-trip count — those are the same for a
 * 500-id run whatever the window. What a widened run multiplies is how much each
 * read scans and holds: this path reads each instance's whole window in one query
 * inside one dispatch, with no slicing, so 50 x 90 days is already far past what
 * one dispatch can serve. Prefer an operator request on the telemetry-recovery
 * queue, which reads one instance-day at a time; this lever is for a handful of
 * instances. Unwidened scoped runs keep the larger cap because they scan no more
 * than a normal tick.
 */
const MAX_WIDENED_BATCH = 50

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine((s) => {
    // Calendar-valid, not just shape-valid: 2026-13-40 must fail HERE with a
    // clean validation path, not later as a raw Postgres ::date cast error.
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y!, m! - 1, d!))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d
  }, 'not a real calendar date')

// Unknown keys are STRIPPED (not rejected) — forward-compatible with a future
// scheduler that sends options this build doesn't know about, and defensive
// against noise.
export const workerOptsSchema = z
  .object({
    deepRescan: z.boolean().optional(),
    // Bounded to the reader's own MAX_LOOKBACK_DAYS so an absurd value cannot
    // reach the Azure query; the reader clamps too (defence in depth).
    lookbackDays: z.number().int().min(1).max(90).optional(),
    sessionIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    apply: z.boolean().optional(),
    startingAt: isoDay.optional(),
    endingAt: isoDay.optional(),
    externalOrgId: z.string().min(1).optional(),
    retryFailed: z.boolean().optional(),
  })
  .strip()
  .superRefine((v, ctx) => {
    // A widened window without a scope is a self-DoS, not a recovery: the full
    // selection (up to the instance cap) would be re-read at up to 90 days,
    // serially, two Log Analytics round-trips each, past the ~120s worker
    // gateway ceiling — the handler keeps running holding the single-flight
    // lock, so every scheduled tick 409s and attribution stops fleet-wide for
    // the duration. Enforced rather than left to a doc comment.
    if (v.lookbackDays !== undefined && (v.sessionIds === undefined || v.sessionIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lookbackDays'],
        message: 'lookbackDays requires sessionIds — a widened read must be scoped to the instances being recovered',
      })
    }
    // Scoping alone does not bound the cost the paragraph above describes: 500
    // ids at 90 days is the SAME serial round-trip count as the unscoped body
    // this refinement rejects, and the explicit-ids read path has neither a LIMIT
    // nor a time window of its own. So a WIDENED read is additionally capped to a
    // batch the gateway ceiling can actually serve. Recovery is a campaign of
    // small batches (see the runbook), not one heroic call.
    // A widened read without deepRescan is near-useless and fails SILENTLY: the
    // per-instance watermark bounds the read to events newer than the last
    // attributed one, and post-deploy that watermark is already fresh (the first
    // liveness-fixed tick moved it). So the query scans 90 days and returns
    // almost nothing, while lookbackDaysApplied/scoped/sessionsProcessed all read
    // GREEN — the operator's verification passes on a near-zero recovery. Enforce
    // the pairing rather than documenting it.
    if (v.lookbackDays !== undefined && v.deepRescan !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deepRescan'],
        message: 'lookbackDays requires deepRescan:true — without it the per-instance watermark bounds the widened read to almost nothing',
      })
    }
    if (v.lookbackDays !== undefined && v.sessionIds && v.sessionIds.length > MAX_WIDENED_BATCH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionIds'],
        message: `a widened read (lookbackDays) is limited to ${MAX_WIDENED_BATCH} instances per run — split the recovery into batches`,
      })
    }
  })

/*
 * Parse the (already-verified, already-read) request body into worker opts.
 *
 * IMPORTANT: verifyInternalRequest already called readRawBody(event) to compute
 * the body-sha256 for signature verification, so h3 has CACHED the raw body on
 * the event (Symbol.for('h3RawBody')). This second readRawBody returns that
 * cached value — it does NOT re-consume the request stream.
 *
 * Fail-soft on EVERY malformation (no body, empty body, non-JSON, wrong shape,
 * a read error): an operator fat-fingering the body must NEVER 500 a scheduled
 * dispatch — it degrades to no-opts (the auto-decided behaviour). Returns
 * undefined when there are no opts, so the endpoint omits `opts` entirely and
 * ctx?.opts stays undefined on the auto path.
 */
export async function parseWorkerOpts(event: H3Event): Promise<WorkerRunContext['opts']> {
  let raw: string | undefined
  try {
    // Default encoding is utf8; returns undefined when there was no body.
    raw = await readRawBody(event)
  } catch {
    return undefined
  }
  if (!raw || raw.trim() === '') return undefined
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = workerOptsSchema.safeParse(json)
  if (!parsed.success) {
    // Fail-soft is deliberate (a future scheduler sending options this build
    // does not know must never 500 the tick) but it MUST NOT be silent. Unknown
    // keys are already handled by .strip(), so reaching here means a KNOWN option
    // was malformed — e.g. `"lookbackDays": "90"` as a string from a shell
    // template. The run then takes the DEFAULT path and returns HTTP 200 with
    // rows written, which is indistinguishable from the operator's intent: the
    // exact silent-success trap that made a recoverable backlog look recovered.
    // Say so loudly; the worker result also echoes what was actually applied.
    console.warn(
      `[run-worker-opts] worker options were DROPPED (malformed) — the run will take its DEFAULT path, ignoring every option in the body: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    )
    return undefined
  }
  // Omit `opts` when it carries nothing (e.g. the body was `{}`) so ctx.opts
  // stays undefined and workers take their auto path unchanged.
  return Object.keys(parsed.data).length > 0 ? parsed.data : undefined
}
