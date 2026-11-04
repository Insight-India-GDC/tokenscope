// @vitest-environment node
/*
 * landed-check (Claude) — the "did my telemetry LAND?" probe
 * (plugin/scripts/landed-check.mjs). It calls GET /instances/{id}/health and
 * writes the last-landed.claude-code.json cache the always-on statusline reads.
 *
 * Pins the contract the statusline's classifyLanding() now DEPENDS on: on a real
 * 200 the cache carries `ok:true` (so a reached-but-stale answer is judge-able,
 * not "unknown") plus `lastBearer` (the emit-activity proxy that separates a dead
 * export from an idle client), `revoked`, and `lastEmission`. Fail-open guards
 * return a typed { ok:false, reason } and NEVER touch the cache, so the statusline
 * degrades to the neutral "unknown" fallback rather than a false red.
 *
 * All state is in a temp dir; fetch is stubbed (no network).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { refreshLanded } = await import('../../../plugin/scripts/landed-check.mjs')

const INSTANCE = 'e0d06f65-1100-4d6f-b544-e377a7b391a6'
const env = {
  TOKENSCOPE_BEARER_ENDPOINT: `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`,
  OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`,
}

let dir: string

function writeAccess(token: string | null = 'tok') {
  // BOUND to the destination it was minted for, as every cache reader now
  // requires: a record naming a different endpoint is discarded, not presented.
  writeFileSync(
    join(dir, 'oauth-access.claude-code.json'),
    JSON.stringify(token ? { access_token: token, bearer_endpoint: env.TOKENSCOPE_BEARER_ENDPOINT } : {}),
  )
}
function mockFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl as never))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-landed-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('refreshLanded (Claude) — fail-open guards leave the cache untouched', () => {
  it('missing bearer endpoint / instance id → not-configured, no cache written', async () => {
    writeAccess()
    const r = await refreshLanded({ env: {}, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'not-configured' })
    expect(existsSync(join(dir, 'last-landed.claude-code.json'))).toBe(false)
  })

  it("attrs naming another instance than the endpoint's → instance-mismatch, no cache written", async () => {
    // A repo tag can carry another local install's instance id; this /health
    // answer would then be cached under that install's name.
    writeAccess()
    mockFetch(() => ({ ok: true, json: async () => ({ last_emission: '2026-10-15T11:00:00Z' }) }))
    const other ='tokenscope.instance_id=7c2e9a41-5b0d-4f38-a6e2-d19b8c3f0a57,tool=claude-code'
    const r = await refreshLanded({ env: { ...env, OTEL_RESOURCE_ATTRIBUTES: other }, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'instance-mismatch' })
    expect(existsSync(join(dir, 'last-landed.claude-code.json'))).toBe(false)
  })

  it('no cached access token → no-token', async () => {
    writeAccess(null)
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'no-token' })
  })

  it('fetch throws → fetch-failed (no throw, no cache write)', async () => {
    writeAccess()
    mockFetch(() => {
      throw new Error('offline')
    })
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(existsSync(join(dir, 'last-landed.claude-code.json'))).toBe(false)
  })

  it('never follows a redirect: the scheme guard checked only the first URL', async () => {
    writeAccess()
    const spy = vi.fn(() => ({ ok: false, status: 500 }))
    vi.stubGlobal('fetch', spy as never)
    await refreshLanded({ env, stateDir: dir })
    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' })
  })

  it('non-2xx → http-<status>', async () => {
    writeAccess()
    mockFetch(() => ({ ok: false, status: 403 }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'http-403' })
  })
})

describe('refreshLanded (Claude) — S1 fixes 2+3: state dir + endpoint safety', () => {
  it('a non-https, off-loopback health URL is rejected before any fetch', async () => {
    writeAccess()
    const spy = vi.fn()
    mockFetch(spy)
    const r = await refreshLanded({
      env: {
        TOKENSCOPE_BEARER_ENDPOINT: 'http://evil.example/api/v1/instances/x/bearer',
        OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`,
      },
      stateDir: dir,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-endpoint' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('IGNORES an ambient process.env.TOKENSCOPE_STATE_DIR for the delivery cache', async () => {
    /*
     * CONTRACT CHANGE, deliberate. This case used to assert that a process-level
     * TOKENSCOPE_STATE_DIR was honoured, on the reasoning that it is the
     * legitimate deployment pin and only a repo-TAGGED env is hostile. The
     * ambient environment cannot tell those apart: Claude Code merges a cloned
     * repo's .claude/settings.json env block into the processes it spawns, and
     * the status line is one of them.
     *
     * That matters here because last-landed.claude-code.json is not just displayed — it
     * feeds landedRefreshDue(). A repo that picks this directory can pre-seed a
     * fresh, healthy cache, so the status line reports delivery that is not
     * happening AND skips the refresh that would discover it.
     *
     * The pin itself is not lost, it moved to a channel a repo cannot write —
     * see the case below.
     */
    /*
     * NO explicit stateDir — the DEFAULT path is the whole point, and passing one
     * makes this vacuous (an explicit dir wins whether or not the ambient env is
     * consulted, so the assertion holds either way; the first version of this
     * test did exactly that and survived its own mutation).
     *
     * Falling through to the passwd home is safe here because refreshLanded
     * refuses to write the real device store under a vitest worker. That refusal
     * is what this asserts: reaching it proves the ambient value was NOT used,
     * because a consulted ambient value is not the passwd home and would have
     * written happily.
     */
    const poisoned = join(dir, 'repo-chosen')
    mkdirSync(poisoned, { recursive: true })
    const saved = process.env.TOKENSCOPE_STATE_DIR
    process.env.TOKENSCOPE_STATE_DIR = poisoned
    try {
      writeAccess()
      mockFetch(() => ({ ok: true, json: async () => ({ last_emission: null, silent: true, revoked: false }) }))
      const r = await refreshLanded({ env })
      expect(
        existsSync(join(poisoned, 'last-landed.claude-code.json')),
        'the ambient env chose where the delivery cache was written',
      ).toBe(false)
      expect(r.ok).toBe(false)
      expect(String(r.reason)).toMatch(/refusing to write the real device store/i)
    } finally {
      if (saved === undefined) delete process.env.TOKENSCOPE_STATE_DIR
      else process.env.TOKENSCOPE_STATE_DIR = saved
    }
  })
})

describe('refreshLanded (Claude) — success writes the cache the statusline reads', () => {
  it('200 → writes ok:true + lastEmission + lastBearer + revoked (the fields classifyLanding needs)', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        last_emission: '2026-06-30 21:38:58.933+00',
        last_bearer_at: '2026-07-01T00:30:28.697Z',
        silent: false,
        revoked: false,
      }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.ok).toBe(true)
    expect(r.lastEmission).toBe('2026-06-30 21:38:58.933+00')
    expect(r.lastBearer).toBe('2026-07-01T00:30:28.697Z')
    expect(r.revoked).toBe(false)

    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.claude-code.json'), 'utf8'))
    expect(cache.ok).toBe(true) // load-bearing: distinguishes reached-but-stale from unreachable
    expect(cache.instanceId).toBe(INSTANCE)
    expect(cache.lastEmission).toBe('2026-06-30 21:38:58.933+00')
    expect(cache.lastBearer).toBe('2026-07-01T00:30:28.697Z') // the emit-activity proxy
    expect(cache.revoked).toBe(false)
    expect(cache.checkedAt).toBeTruthy() // the poll-throttle stamp
  })

  it('200 → carries ts_start into the cache, so the statusline can AGE a never-landed enrolment', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        last_emission: null,
        last_bearer_at: '2026-07-01T00:30:28.697Z',
        ts_start: '2026-06-28T09:00:00.000Z',
        silent: true,
        revoked: false,
      }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.tsStart).toBe('2026-06-28T09:00:00.000Z')
    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.claude-code.json'), 'utf8'))
    // Without this the null last_emission above is indistinguishable from a
    // seconds-old enrolment, which is how a dead device reads as benign cyan.
    expect(cache.tsStart).toBe('2026-06-28T09:00:00.000Z')
  })

  it('200 from an OLDER server with no ts_start → tsStart null, cache still written (back-compat)', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({ last_emission: null, silent: true, revoked: false }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.ok).toBe(true)
    expect(r.tsStart).toBeNull()
    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.claude-code.json'), 'utf8'))
    expect(cache.tsStart).toBeNull() // classifyLanding then keeps its old neutral behaviour
  })

  it('200 revoked instance → cache carries revoked:true', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({ last_emission: null, silent: true, revoked: true }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.revoked).toBe(true)
    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.claude-code.json'), 'utf8'))
    expect(cache.revoked).toBe(true)
    expect(cache.ok).toBe(true)
  })
})
