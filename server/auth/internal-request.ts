/*
 * HMAC verification for internal machine-to-machine endpoints
 * (worker scheduler trigger). Separate from the session HMAC so
 * compromising one key does not surrender the other.
 *
 * Request shape:
 *   X-Internal-Signature: hex(HMAC-SHA-256(key, `${timestamp}\n${method}\n${path}\n${bodySha256Hex}`))
 *   X-Internal-Timestamp: unix seconds (string)
 *
 * Verification rules:
 *   1. Timestamp within +/- 60 seconds of server clock (replay window)
 *   2. Signature constant-time-equal to expected
 *
 * Key source:
 *   - Dev: NUXT_INTERNAL_WORKER_HMAC_KEY env var (>= 32 chars, >= 3.5 bits/byte entropy)
 *   - Prod (post-Epic 10): Azure Key Vault, cached at boot
 *
 * Why a separate key from the session HMAC: blast-radius separation.
 * The session HMAC protects user tokens; this key protects worker
 * triggers. A leaked worker key cannot replay user sessions, and
 * vice-versa.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { createError, getHeader, readRawBody } from 'h3'
import { requireStrongEnvKey } from './key-strength'

// The signer (scripts/cron-trigger.mjs) signs at send time and the jobs share
// Azure's clock with the app, so a minute is ample.
const REPLAY_WINDOW_SECONDS = 60

let cachedKey: Buffer | null = null

export function getInternalHmacKey(): Buffer {
  if (cachedKey) return cachedKey
  // Length + entropy floor (>= 32 chars, >= 3.5 bits/byte) — see
  // server/auth/key-strength.ts for the rationale and the shared
  // implementation (this used to be a verbatim-duplicated local copy,
  // identical to server/auth/hmac.ts's).
  const raw = requireStrongEnvKey('NUXT_INTERNAL_WORKER_HMAC_KEY')
  cachedKey = Buffer.from(raw, 'utf8')
  return cachedKey
}

export function resetInternalHmacKeyForTests(): void {
  cachedKey = null
}

export function signInternalRequest(opts: {
  timestamp: number
  method: string
  path: string
  body: string
  key?: Buffer
}): string {
  const bodySha = createHash('sha256').update(opts.body).digest('hex')
  const payload = `${opts.timestamp}\n${opts.method.toUpperCase()}\n${opts.path}\n${bodySha}`
  return createHmac('sha256', opts.key ?? getInternalHmacKey()).update(payload).digest('hex')
}

export async function verifyInternalRequest(event: H3Event): Promise<void> {
  /*
   * Uniform 401 surface. An attacker probing the endpoint should not
   * be able to distinguish "I sent no headers" from "I sent wrong
   * headers" from "my timestamp is stale" — each branch gives the same
   * surface. Internal diagnostics (header presence, timestamp validity)
   * are server-side only.
   */
  const sigHeader = getHeader(event, 'x-internal-signature')
  const tsHeader = getHeader(event, 'x-internal-timestamp')
  if (!sigHeader || !tsHeader) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const ts = Number.parseInt(tsHeader, 10)
  if (!Number.isFinite(ts)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const rawBody = await readRawBody(event)
  const body =
    rawBody === undefined
      ? ''
      : typeof rawBody === 'string'
        ? rawBody
        : Buffer.from(rawBody as unknown as ArrayBufferLike).toString('utf8')
  const method = event.node.req.method ?? 'POST'
  const path = event.node.req.url ?? ''
  const expected = signInternalRequest({ timestamp: ts, method, path, body })
  if (sigHeader.length !== expected.length) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    // Malformed hex → unauthenticated; `ok` stays false from the initializer.
  }
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
