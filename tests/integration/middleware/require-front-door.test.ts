/*
 * Unit-shaped tests for the require-front-door middleware.
 *
 * Lives under tests/integration/ to match the project's convention for
 * h3-helper tests that touch the request lifecycle (Nuxt env, headers,
 * defineEventHandler) — same shelf as session.test.ts and the
 * tests/unit/server/internal-request.test.ts pattern.
 *
 * The middleware is a pure function over env + headers — no Nitro boot,
 * no DB. We invoke the exported handler directly with a mocked h3 event.
 * The handler is synchronous (no awaited work), so the test invokes it
 * with a plain call and asserts via thrown / not-thrown.
 *
 * Coverage:
 *   1. AZURE_FRONT_DOOR_ID empty → pass-through regardless of header
 *   2. AZURE_FRONT_DOOR_ID set + matching header → pass-through
 *   3. AZURE_FRONT_DOOR_ID set + wrong header → throws 403
 *   4. AZURE_FRONT_DOOR_ID set + no header → throws 403
 *   5. /api/health bypasses the check regardless of env / header
 *   6. AZURE_FRONT_DOOR_REQUIRED truth table (no template sets it):
 *      REQUIRED unset + ID empty → allow;
 *      REQUIRED=true + ID empty → deny (except /api/health, still allowed);
 *      REQUIRED=true + ID set + matching header → allow; mismatched → 403.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import middleware from '../../../server/middleware/require-front-door'

const FDID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'

function makeEvent(opts: {
  path?: string
  headers?: Record<string, string>
}): H3Event {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'GET'
  req.url = opts.path ?? '/api/v1/me'
  // Required for getRequestURL to compose a URL — h3 reads the Host
  // header and falls back to localhost. Set explicitly so the test is
  // independent of h3 internals.
  req.headers.host = 'ca-tokenscope-sandbox-aue.example.azurecontainerapps.io'
  if (opts.headers) {
    Object.assign(req.headers, opts.headers)
  }
  const res = new ServerResponse(req)
  return createEvent(req, res)
}

// defineEventHandler wraps the handler in an object with a `.handler`
// property AND makes the object itself callable via h3's runtime. To
// test the inner logic directly, prefer the .handler property when
// present, falling back to a direct invocation.
type CallableHandler = (event: H3Event) => unknown
type WrappedHandler = CallableHandler & { handler?: CallableHandler }
const wrapped = middleware as unknown as WrappedHandler
const handler: CallableHandler = wrapped.handler ?? wrapped

// invoke() returns { ok: true } when the handler completes without
// throwing (the no-op + allow paths) and { ok: false, err } when it
// throws (the rejection path). This keeps the assertion shape uniform
// across the sync + (theoretical) async cases — Promise.resolve handles
// both.
async function invoke(event: H3Event): Promise<
  { ok: true } | { ok: false; err: { statusCode: number; data: Record<string, unknown> } }
> {
  try {
    await Promise.resolve(handler(event))
    return { ok: true }
  } catch (err) {
    return { ok: false, err: err as { statusCode: number; data: Record<string, unknown> } }
  }
}

describe('require-front-door middleware', () => {
  // Silence the warn-log the rejection path emits — keeps the test
  // output clean. The presence of the warn is asserted on the
  // negative-path tests via the spy.
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.AZURE_FRONT_DOOR_REQUIRED
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.AZURE_FRONT_DOOR_REQUIRED
    warnSpy.mockRestore()
  })

  it('is a no-op when AZURE_FRONT_DOOR_ID is unset (Wave-I deploy phase)', async () => {
    const event = makeEvent({ path: '/api/v1/me' })
    const result = await invoke(event)
    expect(result.ok).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when AZURE_FRONT_DOOR_ID is the empty string (phase-2 transitional)', async () => {
    process.env.AZURE_FRONT_DOOR_ID = ''
    const event = makeEvent({ path: '/api/v1/me' })
    const result = await invoke(event)
    expect(result.ok).toBe(true)
  })

  it('passes through when the header matches the env var', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({
      path: '/api/v1/me',
      headers: { 'x-azure-fdid': FDID },
    })
    const result = await invoke(event)
    expect(result.ok).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('throws 403 when the header is present but wrong', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({
      path: '/api/v1/me',
      headers: { 'x-azure-fdid': 'attacker-supplied-value' },
    })
    const result = await invoke(event)
    expect(result.ok).toBe(false)
    if (result.ok) return // type narrow
    expect(result.err.statusCode).toBe(403)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('throws 403 when the header is missing entirely', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({ path: '/api/v1/me' })
    const result = await invoke(event)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.err.statusCode).toBe(403)
  })

  it('bypasses the check for /api/health regardless of env var', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({ path: '/api/health' })
    const result = await invoke(event)
    expect(result.ok).toBe(true)
  })

  it('bypasses the check for /api/health even when no env var is set', async () => {
    // Pre-AFD deploys: same code path; should still pass.
    const event = makeEvent({ path: '/api/health' })
    const result = await invoke(event)
    expect(result.ok).toBe(true)
  })

  it('emits the RFC-9457 error envelope on rejection', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({ path: '/api/v1/me' })
    const result = await invoke(event)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.err.statusCode).toBe(403)
    expect(result.err.data).toMatchObject({
      type: 'https://tokenscope.example.com/errors/front-door-required',
      title: 'Front Door required',
      status: 403,
    })
    expect(typeof result.err.data.detail).toBe('string')
  })

  it('does not log the expected AFD ID on rejection (convention: do not log known-good values)', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    const event = makeEvent({
      path: '/api/v1/me',
      headers: { 'x-azure-fdid': 'attacker' },
    })
    await invoke(event)
    // Inspect every recorded warn call; none should contain the FDID.
    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(FDID)
      }
    }
  })

  // ── AZURE_FRONT_DOOR_REQUIRED truth table (code-half only) ─────────
  describe('/api/health exemption compares the ROUTED path, not a normalised one', () => {
    beforeEach(() => {
      process.env.AZURE_FRONT_DOOR_ID = FDID
    })

    it.each(['/api/health', '/api/health?probe=live'])('%s with no header stays exempt', async (path) => {
      const result = await invoke(makeEvent({ path }))
      expect(result.ok).toBe(true)
    })

    it.each([
      '/api/v1/mcp/x/../../../health',
      '/api/v1/mcp/x/%2e%2e/%2e%2e/%2e%2e/health',
      '/api/v1/mcp/x/%2E%2E/%2E%2E/%2E%2E/health',
      '/api/v1/mcp/x/.%2e/%2e./../health',
      '/api/health/../v1/x',
      '/api/health/%2e%2e/v1/x',
    ])('%s with no header is NOT exempt (403)', async (path) => {
      const result = await invoke(makeEvent({ path }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.err.statusCode).toBe(403)
    })
  })

  describe('AZURE_FRONT_DOOR_REQUIRED', () => {
    it('REQUIRED unset + ID empty → allow (the existing three-phase no-op, unchanged)', async () => {
      // AZURE_FRONT_DOOR_ID already deleted in the outer beforeEach.
      const event = makeEvent({ path: '/api/v1/me' })
      const result = await invoke(event)
      expect(result.ok).toBe(true)
    })

    it('REQUIRED=true + ID empty → deny (operator has explicitly closed the pre-AFD window)', async () => {
      process.env.AZURE_FRONT_DOOR_REQUIRED = 'true'
      const event = makeEvent({ path: '/api/v1/me' })
      const result = await invoke(event)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.err.statusCode).toBe(403)
    })

    it('REQUIRED=true + ID empty → /api/health is STILL allowed (never lets the probe fail closed)', async () => {
      process.env.AZURE_FRONT_DOOR_REQUIRED = 'true'
      const event = makeEvent({ path: '/api/health' })
      const result = await invoke(event)
      expect(result.ok).toBe(true)
    })

    it('REQUIRED=true + ID set + matching header → allow', async () => {
      process.env.AZURE_FRONT_DOOR_REQUIRED = 'true'
      process.env.AZURE_FRONT_DOOR_ID = FDID
      const event = makeEvent({ path: '/api/v1/me', headers: { 'x-azure-fdid': FDID } })
      const result = await invoke(event)
      expect(result.ok).toBe(true)
    })

    it('REQUIRED=true + ID set + mismatched header → 403', async () => {
      process.env.AZURE_FRONT_DOOR_REQUIRED = 'true'
      process.env.AZURE_FRONT_DOOR_ID = FDID
      const event = makeEvent({
        path: '/api/v1/me',
        headers: { 'x-azure-fdid': 'attacker-supplied-value' },
      })
      const result = await invoke(event)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.err.statusCode).toBe(403)
    })

    it('REQUIRED unset (falsy/absent) never infers "this looks like production" — ID empty still no-ops even with an unrelated truthy-ish value unset', async () => {
      // Explicitly NOT setting AZURE_FRONT_DOOR_REQUIRED at all — the flag
      // must never be inferred, only read literally as the string 'true'.
      delete process.env.AZURE_FRONT_DOOR_REQUIRED
      const event = makeEvent({ path: '/api/v1/me' })
      const result = await invoke(event)
      expect(result.ok).toBe(true)
    })
  })
})
