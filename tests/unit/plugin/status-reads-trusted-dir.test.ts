/*
 * /tokenscope:status reads the helper's sentinel and degraded marker from the
 * directory the helper WROTE them to (Copilot review, PR #416).
 *
 * runEmitHelper pins the helper to this install's state dir
 * (claudeInstallStateDir: trustedStateDir() for the default ~/.claude). The probe used to read
 * back through stateDir(), which honours a live TOKENSCOPE_STATE_DIR — a value a
 * repository's merged settings can supply (safeProcessEnv strips it only from
 * its own copy). With that variable pointing elsewhere, status missed the
 * cached-bearer marker and printed "Emission auth OK" while TokenScope was
 * unreachable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = vi.hoisted(() => ({ trusted: '', ambient: '' }))

vi.mock('../../../plugin/scripts/plugin-runtime.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../plugin/scripts/plugin-runtime.mjs')>()
  return {
    ...real,
    trustedStateDir: () => dirs.trusted,
    // This install's own dir (#449); the default ~/.claude's is the trusted one.
    claudeInstallStateDir: () => dirs.trusted,
    // The helper "ran" and exited 0 with a header, as it does on the cached path.
    runEmitHelper: () => ({ ran: true, status: 0, hasAuth: true }),
  }
})

const { probeEmissionAuth } = await import('../../../plugin/scripts/status.mjs')

let root: string
const savedStateDir = process.env.TOKENSCOPE_STATE_DIR

const configuredEnv = {
  TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example/api/v1/instances/x/bearer',
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example/api/v1/oauth/token',
  TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-status-dir-'))
  dirs.trusted = join(root, 'trusted')
  dirs.ambient = join(root, 'repo-chosen')
  mkdirSync(dirs.trusted, { recursive: true })
  mkdirSync(dirs.ambient, { recursive: true })
  // A repo-supplied override pointing at a directory with NO marker in it.
  process.env.TOKENSCOPE_STATE_DIR = dirs.ambient
})
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.TOKENSCOPE_STATE_DIR
  else process.env.TOKENSCOPE_STATE_DIR = savedStateDir
  rmSync(root, { recursive: true, force: true })
})

describe('status probe reads where the helper writes', () => {
  it('reports DEGRADED from the trusted store even when TOKENSCOPE_STATE_DIR points elsewhere', () => {
    writeFileSync(
      join(dirs.trusted, 'emit-degraded.claude-code.json'),
      JSON.stringify({ ts: '2026-10-07T00:00:00Z', reason: 'could not reach ts', expires_at: 9_999_999_999 }),
    )
    const v = probeEmissionAuth(configuredEnv)
    expect(v.degraded).toBe(true)
    expect(v.message).toMatch(/DEGRADED/)
    expect(v.message).not.toMatch(/^OK:/)
  })

  it('a marker planted in the repo-chosen directory is NOT read', () => {
    writeFileSync(
      join(dirs.ambient, 'emit-degraded.claude-code.json'),
      JSON.stringify({ ts: 'x', reason: 'planted', expires_at: 0 }),
    )
    const v = probeEmissionAuth(configuredEnv)
    expect(v.degraded).toBeUndefined()
    expect(v.message).toMatch(/^OK: this computer can send usage to TokenScope\./)
  })

  it('a device whose refresh token is only in the store (not settings) is configured', () => {
    const iid = '9a1e0000-0000-4000-8000-000000000001'
    const bearer = `https://ts.example/api/v1/instances/${iid}/bearer`
    writeFileSync(
      join(dirs.trusted, 'config.claude-code.json'),
      JSON.stringify({
        version: 2,
        tool: 'claude-code',
        instance_id: iid,
        bearer_endpoint: bearer,
        oauth_token_endpoint: 'https://ts.example/api/v1/oauth/token',
        oauth_client_id: 'cid',
        oauth_refresh_token: 'rt_in_store',
        otel_resource_attributes: `tokenscope.instance_id=${iid},tool=claude-code`,
      }),
    )
    const settingsEnv = {
      TOKENSCOPE_BEARER_ENDPOINT: bearer,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    }
    const v = probeEmissionAuth(settingsEnv)
    expect(v.message).not.toMatch(/Not configured/)
    expect(v.message).toMatch(/^OK:/)
  })
})
