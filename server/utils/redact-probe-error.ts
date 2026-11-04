/*
 * redact-probe-error — the ONE place a driver-level probe failure (Postgres,
 * an HTTP reader endpoint, DNS) turns into something safe to put in an HTTP
 * response, modelled on api/health.get.ts:29-37 (same postgres-js driver:
 * "log the real error server-side, return a static string to the caller").
 *
 * WHY THIS EXISTS. A raw `err.message` from postgres-js or Node's network
 * stack routinely carries host, database name, and user (`connect ECONNREFUSED
 * 10.x.x.x:5432`, `password authentication failed for user "app"`) — exactly
 * the topology an unauthenticated-adjacent admin probe must not leak. But this
 * project has ALSO been burned by the opposite failure: a classified
 * "connect-failed" reason masking what was actually a 400 request error (see
 * feedback_classified_errors_mask_raw_cause). So the raw error is NEVER
 * dropped — it goes to the server log at full fidelity, tagged with a
 * correlation id the caller also receives, so an operator with log access can
 * always go from "the page says driver-unreachable, correlation abc123" to
 * the exact underlying error.
 *
 * Never interpolate any fragment of `err.message` (or any other error
 * property) into the returned reason — only the log line gets the raw value.
 */
import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { ProbeErrorReason } from '../../shared/observability/probe-error-reason'

/*
 * The reason VOCABULARY lives in shared/observability/probe-error-reason.ts so
 * shared/ code (which may not import from server/) can union with it instead of
 * copying its members — see that file's header. Re-exported here so every
 * existing `import type { ProbeErrorReason } from '.../redact-probe-error'`
 * keeps resolving; this module remains the only place a raw error is CLASSIFIED.
 */
export type { ProbeErrorReason } from '../../shared/observability/probe-error-reason'

export interface ClassifiedProbeError {
  reason: ProbeErrorReason
  /** Ties this redacted reason back to the full-fidelity line in the server log. */
  correlationId: string
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const REFUSED_CODES = new Set(['ECONNREFUSED'])
// postgres-js's own connection-lifecycle codes (src/errors.js `connection()`)
// plus the raw Node socket codes it forwards unwrapped on a dead/dropped link.
const UNREACHABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
])
// Postgres SQLSTATE codes (postgres-js's PostgresError carries the server's
// own 5-char code in `.code`): 28P01 invalid_password, 28000
// invalid_authorization_specification.
const AUTH_DENIED_CODES = new Set(['28P01', '28000'])
// 42P01 undefined_table, 3D000 invalid_catalog_name (database absent) — both
// "the thing this probe expected to read is not there".
const RELATION_MISSING_CODES = new Set(['42P01', '3D000'])
// 57014 query_canceled — what the server raises when a `statement_timeout` a
// probe set on its own transaction fires. A bounded probe MUST be able to name
// its own bound; classified as unreachable it would send an operator looking at
// the network for a query that was merely slow.
const STATEMENT_TIMEOUT_CODES = new Set(['57014'])

/*
 * The driver code is often NOT on the thrown error. drizzle-orm rethrows every
 * driver error wrapped in `DrizzleQueryError`, carrying the postgres-js error
 * on `.cause` (drizzle-orm/pg-core/session.js) — so reading only `err.code`
 * classifies EVERY database probe failure as 'unknown', which is the
 * uninformative-by-construction shape this module exists to avoid. Walk the
 * cause chain, depth-capped so a cyclic `cause` cannot spin.
 */
const MAX_CAUSE_DEPTH = 5

function codeOf(err: unknown): string | undefined {
  let cur: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur && typeof cur === 'object'; depth++) {
    if ('code' in cur) {
      const c = (cur as { code?: unknown }).code
      if (typeof c === 'string') return c
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * One log-line rendering of an error WITH its cause chain. undici reports every
 * transport failure (TLS verification, DNS, refused) as a bare
 * `TypeError: fetch failed` and puts the reason on `.cause`, so `String(err)`
 * alone hides exactly what an operator needs. For server logs only, never a
 * response. URL query strings are dropped: a signed link's signature lives there.
 */
export function describeError(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur !== undefined && cur !== null; depth++) {
    const code = typeof cur === 'object' && 'code' in cur ? (cur as { code?: unknown }).code : undefined
    parts.push(`${typeof code === 'string' ? `[${code}] ` : ''}${String(cur)}`)
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined
  }
  return parts.join(' <- caused by: ').replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, '$1?<redacted>')
}

function classify(err: unknown): ProbeErrorReason {
  const code = codeOf(err)
  if (!code) return 'unknown'
  if (DNS_CODES.has(code)) return 'dns-fail'
  if (REFUSED_CODES.has(code)) return 'connect-refused'
  if (UNREACHABLE_CODES.has(code)) return 'driver-unreachable'
  if (AUTH_DENIED_CODES.has(code)) return 'auth-denied'
  if (RELATION_MISSING_CODES.has(code)) return 'relation-missing'
  if (STATEMENT_TIMEOUT_CODES.has(code)) return 'statement-timeout'
  return 'unknown'
}

/**
 * Classify a caught probe error into a safe reason code, logging the raw
 * error server-side at full fidelity under a correlation id the caller gets
 * back too. `context` is a short, static label (e.g.
 * `'diagnostics:postgres'`) identifying WHICH probe failed — it is a
 * hardcoded string at each call site, never derived from request input.
 */
export function classifyProbeError(err: unknown, context: string): ClassifiedProbeError {
  const correlationId = randomUUID()
  consola.error(`[probe-error:${context}] ${correlationId}`, err instanceof Error ? err : String(err))
  return { reason: classify(err), correlationId }
}

/**
 * Whether ONE independently-fallible read of a multi-read response answered.
 *
 * A handler that assembles several reads and catches each one separately must
 * not let a caught failure return the read's zero/empty initialiser unlabelled:
 * "no rows" and "the query threw" are then the same bytes on the wire, and the
 * page renders "nothing happened" for "we could not find out". Every such read
 * declares itself here instead — see docs/design/admin-nav-responsiveness.md D4
 * for why those reads cannot share a transaction in the first place.
 */
export type ReadAvailability =
  | { available: true }
  | { available: false; error: ProbeErrorReason; errorCorrelationId: string }

/** The unavailable branch, classified and logged like any other probe error. */
export function readUnavailable(err: unknown, context: string): ReadAvailability {
  const { reason, correlationId } = classifyProbeError(err, context)
  return { available: false, error: reason, errorCorrelationId: correlationId }
}
