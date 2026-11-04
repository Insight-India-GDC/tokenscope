/*
 * Unit tests for the internal-request HMAC verifier.
 *
 * Exercises the signing/verifying contract without booting Nitro or
 * touching the DB. Test scenarios:
 *   - valid signed request passes
 *   - missing headers reject with 401
 *   - tampered body rejects
 *   - tampered path rejects
 *   - timestamp outside replay window rejects
 *   - bad-signature rejects
 *
 * Why unit-level: the verifier is pure HMAC + clock math. Boot-coupled
 * integration tests would just duplicate the same assertions slower.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  signInternalRequest,
  verifyInternalRequest,
  resetInternalHmacKeyForTests,
} from '../../../server/auth/internal-request'

const KEY = 'unit-test-internal-key-with-sufficient-entropy-aaaaaaaaaaaa'

function makeEvent(opts: {
  method?: string
  path?: string
  body?: string
  timestamp?: number
  signature?: string
  headers?: Record<string, string>
}) {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = opts.method ?? 'POST'
  req.url = opts.path ?? '/api/v1/internal/run-worker/budget-alert'
  if (opts.timestamp !== undefined) {
    req.headers['x-internal-timestamp'] = String(opts.timestamp)
  }
  if (opts.signature !== undefined) {
    req.headers['x-internal-signature'] = opts.signature
  }
  if (opts.headers) {
    Object.assign(req.headers, opts.headers)
  }
  const res = new ServerResponse(req)
  const event = createEvent(req, res)
  ;(event as unknown as { _rawBody?: string })._rawBody = opts.body ?? ''
  // Inject body via the readBody/readRawBody hook: h3 caches on event.
  Object.defineProperty(event.node.req, 'rawBody', {
    value: Buffer.from(opts.body ?? '', 'utf8'),
    writable: true,
  })
  // h3 readRawBody reads via event._requestBody if present
  ;(event as unknown as { _requestBody?: Buffer })._requestBody = Buffer.from(
    opts.body ?? '',
    'utf8',
  )
  return event
}

describe('verifyInternalRequest', () => {
  beforeEach(() => {
    process.env.NUXT_INTERNAL_WORKER_HMAC_KEY = KEY
    resetInternalHmacKeyForTests()
  })
  afterEach(() => {
    delete process.env.NUXT_INTERNAL_WORKER_HMAC_KEY
    resetInternalHmacKeyForTests()
  })

  it('accepts a freshly-signed request', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = ''
    const sig = signInternalRequest({
      timestamp: ts,
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body,
    })
    const event = makeEvent({
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body,
      timestamp: ts,
      signature: sig,
    })
    await expect(verifyInternalRequest(event)).resolves.toBeUndefined()
  })

  it('rejects when signature header is missing', async () => {
    const event = makeEvent({ timestamp: Math.floor(Date.now() / 1000) })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })

  it('rejects when timestamp is missing', async () => {
    const event = makeEvent({ signature: 'a'.repeat(64) })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })

  it('rejects when timestamp is outside replay window', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600
    const sig = signInternalRequest({
      timestamp: stale,
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body: '',
    })
    const event = makeEvent({
      path: '/api/v1/internal/run-worker/reconciliation',
      timestamp: stale,
      signature: sig,
    })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })

  it('replay window is one minute: two minutes old is rejected, thirty seconds old is accepted', async () => {
    const path = '/api/v1/internal/run-worker/reconciliation'
    const signed = (ts: number) =>
      makeEvent({ path, timestamp: ts, signature: signInternalRequest({ timestamp: ts, method: 'POST', path, body: '' }) })
    const now = Math.floor(Date.now() / 1000)
    await expect(verifyInternalRequest(signed(now - 120))).rejects.toThrow(/Unauthorized/)
    await expect(verifyInternalRequest(signed(now - 30))).resolves.toBeUndefined()
  })

  it('rejects a signature for a different path', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const sig = signInternalRequest({
      timestamp: ts,
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body: '',
    })
    const event = makeEvent({
      path: '/api/v1/internal/run-worker/soft-purge',
      timestamp: ts,
      signature: sig,
    })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })

  it('rejects a tampered body', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const sig = signInternalRequest({
      timestamp: ts,
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body: '',
    })
    const event = makeEvent({
      path: '/api/v1/internal/run-worker/reconciliation',
      timestamp: ts,
      signature: sig,
      body: '{"injected":true}',
    })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })

  it('rejects when the request URL has an unexpected query-string', async () => {
    /*
     * Path canonicalization contract (docs/build/worker-scheduler.md):
     * the verifier reads event.node.req.url verbatim, so a signature
     * computed for /foo will not verify against /foo?retry=1. If a
     * proxy adds query params after signing, signature fails — this
     * test pins that behavior so a future "auto-strip query" change
     * is a deliberate choice, not a silent drift.
     */
    const ts = Math.floor(Date.now() / 1000)
    const sig = signInternalRequest({
      timestamp: ts,
      method: 'POST',
      path: '/api/v1/internal/run-worker/reconciliation',
      body: '',
    })
    const event = makeEvent({
      path: '/api/v1/internal/run-worker/reconciliation?retry=1',
      timestamp: ts,
      signature: sig,
    })
    await expect(verifyInternalRequest(event)).rejects.toThrow(/Unauthorized/)
  })
})
