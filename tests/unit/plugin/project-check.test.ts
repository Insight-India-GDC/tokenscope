// @vitest-environment node
/*
 * project-check firewall: ONLY an explicit HTTP-200 billable:false warns
 * ('not-billable'); every other path stays silent ('unverifiable' / 'no-tag').
 * This is the fail-open / no-false-positive guarantee.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepoProjectBillable } from '../../../plugin/scripts/project-check.mjs'

const INSTANCE = '203d6725-f9f9-46d5-987b-571adfbb0857'
const HASH = 'a'.repeat(64)
// An OTEL attrs string with a frozen emitting project.code_hash (so the committed
// .tokenscope is irrelevant and we don't depend on cwd).
const ATTRS = `tokenscope.instance_id=${INSTANCE},project.code_hash=${HASH},tool=claude-code`
const BEARER = `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`

let stateDir: string
let emptyCwd: string

function baseEnv() {
  return { OTEL_RESOURCE_ATTRIBUTES: ATTRS, TOKENSCOPE_BEARER_ENDPOINT: BEARER }
}
const run = (over: Record<string, unknown> = {}) =>
  checkRepoProjectBillable({ env: baseEnv(), cwd: emptyCwd, stateDir, timeoutMs: 50, ...over })

function mockFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl as never))
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'pc-state-'))
  emptyCwd = mkdtempSync(join(tmpdir(), 'pc-cwd-')) // no .tokenscope here
  // BOUND to the destination it was minted for, as every cache reader now requires.
  writeFileSync(
    join(stateDir, 'oauth-access.claude-code.json'),
    JSON.stringify({ access_token: 'tok', bearer_endpoint: BEARER }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(emptyCwd, { recursive: true, force: true })
})

describe('checkRepoProjectBillable — the one warning case', () => {
  it('HTTP-200 billable:false → not-billable (THE warning)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ billable: false, your_projects: [{ code: 'X' }] }) }))
    const r = await run()
    expect(r.status).toBe('not-billable')
    expect(r.yourProjects).toEqual([{ code: 'X' }])
  })

  it('HTTP-200 billable:true → ok', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ billable: true, project: { code: 'OK' } }) }))
    expect((await run()).status).toBe('ok')
  })
})

describe('checkRepoProjectBillable — fail-open firewall (all silent)', () => {
  it('no token cached → unverifiable (silent)', async () => {
    rmSync(join(stateDir, 'oauth-access.claude-code.json'), { force: true })
    mockFetch(() => {
      throw new Error('should not be called')
    })
    expect((await run()).status).toBe('unverifiable')
  })

  it('no bearer endpoint / no instance → unverifiable', async () => {
    expect((await checkRepoProjectBillable({ env: { OTEL_RESOURCE_ATTRIBUTES: ATTRS }, cwd: emptyCwd, stateDir })).status).toBe('unverifiable')
  })

  it('HTTP 401 → unverifiable (silent, not a warning)', async () => {
    mockFetch(() => ({ ok: false, status: 401 }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('HTTP 500 → unverifiable', async () => {
    mockFetch(() => ({ ok: false, status: 500 }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('fetch throws (timeout/offline) → unverifiable', async () => {
    mockFetch(() => {
      throw new Error('aborted')
    })
    expect((await run()).status).toBe('unverifiable')
  })

  it('bad JSON → unverifiable', async () => {
    mockFetch(() => ({ ok: true, json: async () => { throw new Error('bad') } }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('no .tokenscope AND no emitting tag → no-tag (silent)', async () => {
    mockFetch(() => {
      throw new Error('should not be called')
    })
    const r = await checkRepoProjectBillable({
      env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`, TOKENSCOPE_BEARER_ENDPOINT: BEARER },
      cwd: emptyCwd,
      stateDir,
    })
    expect(r.status).toBe('no-tag')
  })

  it('never follows a redirect: the scheme guard checked only the first URL', async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => ({ billable: true }) }))
    vi.stubGlobal('fetch', spy as never)
    await run()
    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' })
  })

  it('builds the /project-resolve URL from the cached /bearer endpoint', async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => ({ billable: true }) }))
    vi.stubGlobal('fetch', spy as never)
    await run()
    expect(spy).toHaveBeenCalledOnce()
    const calledUrl = String((spy.mock.calls[0] as unknown[])[0])
    expect(calledUrl).toContain(`/instances/${INSTANCE}/project-resolve?code_hash=${HASH}`)
    expect(calledUrl).not.toContain('/bearer')
  })
})

describe('checkRepoProjectBillable — S1 fixes 2+3: state dir + endpoint safety', () => {
  it('a non-https, off-loopback bearer endpoint is rejected before any fetch (unverifiable, silent)', async () => {
    const spy = vi.fn()
    mockFetch(spy)
    const r = await checkRepoProjectBillable({
      env: { ...baseEnv(), TOKENSCOPE_BEARER_ENDPOINT: 'http://evil.example/api/v1/instances/x/bearer' },
      cwd: emptyCwd,
      stateDir,
    })
    expect(r.status).toBe('unverifiable')
    expect(spy).not.toHaveBeenCalled()
  })

  it('resolves the state dir through stateDir(), NOT a repo-supplied process.env.TOKENSCOPE_STATE_DIR', async () => {
    // No explicit `stateDir` opt passed and no env.TOKENSCOPE_STATE_DIR — must
    // resolve via the shared stateDir() helper's process-env fallback, proving
    // the read goes through ONE resolution order rather than a second,
    // independent `env.TOKENSCOPE_STATE_DIR || process.env...` read.
    const saved = process.env.TOKENSCOPE_STATE_DIR
    process.env.TOKENSCOPE_STATE_DIR = stateDir
    try {
      mockFetch(() => ({ ok: true, json: async () => ({ billable: true }) }))
      const r = await checkRepoProjectBillable({ env: baseEnv(), cwd: emptyCwd })
      expect(r.status).toBe('ok')
    } finally {
      if (saved === undefined) delete process.env.TOKENSCOPE_STATE_DIR
      else process.env.TOKENSCOPE_STATE_DIR = saved
    }
  })
})

// #503: a command run from a session gets no OTEL_* keys, so the attrs can be
// absent while the device is set up. The check still runs, on the instance this
// install's own endpoint addresses, and checks the committed .tokenscope.
describe('checkRepoProjectBillable — no resource attributes (#503)', () => {
  // The function falls back to process.env's attrs; a runner that sets them
  // would otherwise decide these cases.
  let savedAttrs: string | undefined
  beforeEach(() => {
    savedAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES
    delete process.env.OTEL_RESOURCE_ATTRIBUTES
  })
  afterEach(() => {
    if (savedAttrs !== undefined) process.env.OTEL_RESOURCE_ATTRIBUTES = savedAttrs
  })

  it('checks the committed tag via the endpoint’s instance, not "not-configured"', async () => {
    writeFileSync(join(emptyCwd, '.tokenscope'), 'project:\n  code: HBR-2041\n')
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ billable: true }) }))
    vi.stubGlobal('fetch', fetchSpy as never)
    const r = await run({ env: { TOKENSCOPE_BEARER_ENDPOINT: BEARER } })
    expect(r).toMatchObject({ status: 'ok', code: 'HBR-2041', scope: 'committed' })
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain(`/instances/${INSTANCE}/project-resolve?code_hash=`)
  })

  it('is still "not-configured" with no endpoint at all', async () => {
    writeFileSync(join(emptyCwd, '.tokenscope'), 'project:\n  code: HBR-2041\n')
    mockFetch(() => {
      throw new Error('should not be called')
    })
    expect(await run({ env: {} })).toEqual({ status: 'unverifiable', reason: 'not-configured' })
  })
})
