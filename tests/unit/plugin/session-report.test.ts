// @vitest-environment node
/*
 * #494: the SessionStart hook tells TokenScope which install a session runs on,
 * from this install's own settings and credential. These pin what is sent, to
 * where, and that every failure is a quiet reason rather than a throw.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { readHookInput, reportSessionInstance } from '../../../plugin/scripts/session-report.mjs'

const INSTANCE = '203d6725-f9f9-46d5-987b-571adfbb0857'
const SESSION = '9a1e0000-0000-4000-8000-00000000c0de'
const BEARER = `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`

let stateDir: string
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'sr-state-'))
  writeFileSync(
    join(stateDir, 'oauth-access.claude-code.json'),
    JSON.stringify({ access_token: 'tok', bearer_endpoint: BEARER }),
  )
})
afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

const env = { TOKENSCOPE_BEARER_ENDPOINT: BEARER }
const ok204 = () => vi.fn(async () => ({ ok: true, status: 204 }))

describe('reportSessionInstance', () => {
  it('POSTs the session to this instance’s claude-sessions route with the bound token', async () => {
    const fetchImpl = ok204()
    const r = await reportSessionInstance({ sessionId: SESSION.toUpperCase(), env, stateDir, fetchImpl: fetchImpl as never })
    expect(r).toEqual({ ok: true, instanceId: INSTANCE })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://tokenscope.example.com/api/v1/instances/${INSTANCE}/claude-sessions`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({ claudeSessionId: SESSION })
  })

  it('sends nothing without a session id shaped like Claude’s', async () => {
    const fetchImpl = ok204()
    for (const sessionId of [undefined, '', 'not-a-uuid', 42]) {
      expect(await reportSessionInstance({ sessionId, env, stateDir, fetchImpl: fetchImpl as never })).toEqual({
        ok: false,
        reason: 'no-session-id',
      })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends nothing when the install is not set up, or its endpoint is not a bearer endpoint', async () => {
    const fetchImpl = ok204()
    expect(await reportSessionInstance({ sessionId: SESSION, env: {}, stateDir, fetchImpl: fetchImpl as never })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
    const r = await reportSessionInstance({
      sessionId: SESSION,
      env: { TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope.example.com/api/v1/health' },
      stateDir,
      fetchImpl: fetchImpl as never,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-endpoint' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never presents a token minted for another endpoint', async () => {
    writeFileSync(
      join(stateDir, 'oauth-access.claude-code.json'),
      JSON.stringify({ access_token: 'tok', bearer_endpoint: BEARER.replace(INSTANCE, '11111111-2222-4333-8444-555555555555') }),
    )
    const fetchImpl = ok204()
    expect(await reportSessionInstance({ sessionId: SESSION, env, stateDir, fetchImpl: fetchImpl as never })).toEqual({
      ok: false,
      reason: 'no-token',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('turns a refusal or a network error into a reason, never a throw', async () => {
    const refused = vi.fn(async () => ({ ok: false, status: 404 }))
    expect(await reportSessionInstance({ sessionId: SESSION, env, stateDir, fetchImpl: refused as never })).toEqual({
      ok: false,
      reason: 'http-404',
    })
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await reportSessionInstance({ sessionId: SESSION, env, stateDir, fetchImpl: down as never })).toEqual({
      ok: false,
      reason: 'fetch-failed',
    })
  })
})

describe('readHookInput', () => {
  it('parses the hook’s JSON payload', async () => {
    const stdin = new PassThrough()
    const p = readHookInput({ stdin: stdin as never, timeoutMs: 1000 })
    stdin.end(JSON.stringify({ session_id: SESSION, source: 'startup' }))
    expect(await p).toEqual({ session_id: SESSION, source: 'startup' })
  })

  it('gives up on an open pipe that never writes', async () => {
    const stdin = new PassThrough()
    expect(await readHookInput({ stdin: stdin as never, timeoutMs: 20 })).toBeNull()
  })

  it('is null for a terminal, for garbage, and for a JSON value that is not an object', async () => {
    expect(await readHookInput({ stdin: { isTTY: true } as never })).toBeNull()
    for (const raw of ['not json', '[1,2]', '"x"']) {
      const stdin = new PassThrough()
      const p = readHookInput({ stdin: stdin as never, timeoutMs: 1000 })
      stdin.end(raw)
      expect(await p).toBeNull()
    }
  })
})
