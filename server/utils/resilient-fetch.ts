/*
 * resilientFetch — the shared outbound-HTTP chokepoint for server-side calls to
 * external APIs (Anthropic Admin API, GitHub billing/GraphQL, the local
 * telemetry store). Every bare `fetch` to a third party hangs forever on a
 * black-holed endpoint and treats a 429 as a hard failure; a wedged call
 * strands the dispatching worker_run in 'running' (robustness review ING-7 /
 * SYS-4, 2026-06-09).
 *
 * Behaviour:
 *   - Per-attempt timeout via AbortSignal.timeout (default 30 s).
 *   - Bounded retries (default 2 extra attempts) on network errors / timeouts,
 *     HTTP 429, and HTTP 5xx — with exponential backoff.
 *   - Honours a `retry-after` header (seconds or HTTP-date), capped so a
 *     hostile/buggy upstream can't park a worker for hours.
 *   - Never retries other 4xx (the request itself is wrong; retrying spams).
 *   - Optional `deadline` (epoch ms): no attempt and no wait is started that
 *     would end past it, and each attempt's timeout shrinks to the time left.
 *     When the deadline stops the retries before a wait, the last response is
 *     returned (or the last error thrown) exactly as when the retries run out;
 *     when it passes during a wait, the drained response cannot be returned and
 *     DeadlinePassedError is thrown instead.
 *   - Optional caller `signal`: aborts the attempt in flight and any wait, and
 *     starts nothing further; the call rejects with the signal's reason.
 *
 * Returns the final Response (ok or not) — callers keep their own `res.ok`
 * handling. Throws only when every attempt failed at the network layer, or
 * when the deadline stops it before any attempt produced a network error to
 * rethrow (before the first attempt, or before a retry of a 429/5xx answer).
 */

export interface ResilientFetchOptions {
  /** Per-attempt timeout in ms (default 30 000). */
  timeoutMs?: number
  /** Extra attempts after the first (default 2 → at most 3 requests). */
  retries?: number
  /** Base backoff in ms; attempt n waits base * 2^n (default 1 000). */
  backoffMs?: number
  /**
   * Absolute deadline (epoch ms). No attempt starts once it has passed, an
   * attempt's timeout is min(timeoutMs, time left), and a backoff / retry-after
   * wait that would end at or past it is not started. Absent → no deadline.
   */
  deadline?: number
  /** Cancels the call outright: the attempt in flight, any wait, and every retry. */
  signal?: AbortSignal
}

/** Thrown when the deadline stops the call with no network error to rethrow:
 *  before the first attempt, or before a retry of a 429/5xx answer. */
export class DeadlinePassedError extends Error {
  constructor(host: string) {
    super(`resilientFetch: deadline passed before a request to ${host}`)
    this.name = 'DeadlinePassedError'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 1_000
// Cap any single wait (incl. retry-after) — a worker tick must not park for hours.
const MAX_WAIT_MS = 30_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** Parse a retry-after header (delta-seconds or HTTP-date) to ms; null when absent/garbage. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  if (/^\d+$/.test(header.trim())) return Number(header) * 1000
  // HTTP-dates always contain letters; gating on that stops Date.parse's lenient
  // numeric forms (e.g. '-5' parses as a year) from yielding a bogus wait.
  if (/[a-z]/i.test(header)) {
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return null
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

export async function resilientFetch(
  url: string,
  init: RequestInit = {},
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_RETRIES
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const deadline = opts.deadline
  const signal = opts.signal

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortReason(signal)
    let attemptTimeoutMs = timeoutMs
    if (deadline !== undefined) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // Past the deadline before this attempt: send nothing. On a retry the
        // previous attempt's failure (kept in lastError) is what gets thrown.
        lastError ??= new DeadlinePassedError(new URL(url).host)
        break
      }
      attemptTimeoutMs = Math.min(timeoutMs, remaining)
    }
    let res: Response | null = null
    try {
      const timeout = AbortSignal.timeout(attemptTimeoutMs)
      res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal)
      // Network error / timeout — retryable.
      lastError = err
    }
    if (res && !retryableStatus(res.status)) return res
    if (attempt === retries) {
      if (res) return res // final attempt's 429/5xx — caller owns the !ok path
      break
    }
    const retryAfterMs = res ? parseRetryAfterMs(res.headers.get('retry-after')) : null
    const waitMs = Math.min(retryAfterMs ?? backoffMs * 2 ** attempt, MAX_WAIT_MS)
    // A wait that ends at or past the deadline leaves no time for the retry it
    // exists for: stop here, exactly as if the retries had run out.
    if (deadline !== undefined && Date.now() + waitMs >= deadline) {
      if (res) return res
      break
    }
    // Drain the body so the retried connection can be reused (undici keep-alive).
    if (res) await res.arrayBuffer().catch(() => undefined)
    await sleep(waitMs, signal)
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`resilientFetch: all attempts failed for ${new URL(url).host}`)
}
