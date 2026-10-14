// @vitest-environment node
/*
 * plugin/scripts/status.ps1 — /tokenscope:status on Windows without Node (#408 S5).
 *
 * 1. SHARED FIXTURE TABLE. The same (exit, sentinel, degraded marker) inputs go
 *    through interpretEmissionProbe (status.mjs) and through status.ps1's
 *    Get-EmissionVerdict (dot-sourced under pwsh). The whole verdict must match:
 *    emitting, degraded, probe_status and the message, word for word.
 * 2. END TO END. status.ps1 runs the real otel-headers-helper.ps1 against a local
 *    stub server, in a temp profile: OK / revoked / not configured verdicts, the
 *    MCP-auth check, and no token material anywhere in its output.
 *
 * Under pwsh on Linux, [Environment]::GetFolderPath('UserProfile') answers from
 * $HOME (see otel-helper-conformance.test.ts), which is how the temp profile is
 * reached. On Windows it is SHGetKnownFolderPath and cannot be redirected, so the
 * three whole-script runs are SKIPPED there (visibly, as in that suite); the
 * child launch they depend on is still run on Windows against the real helper
 * with an explicit state dir. TOKENSCOPE_PWSH / TOKENSCOPE_SKIP_PWSH as in that
 * suite: a missing pwsh FAILS, never skips silently.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { interpretEmissionProbe } from '../../../plugin/scripts/status.mjs'
import { resolvePwsh, childEnv } from './helpers/shells.js'

const ROOT = resolve(__dirname, '../../..')
const STATUS_PS1 = process.env.STATUS_PS1_PATH ?? join(ROOT, 'plugin/scripts/status.ps1')
const PWSH = resolvePwsh() ?? (process.env.TOKENSCOPE_PWSH || 'pwsh')
const SKIP = process.env.TOKENSCOPE_SKIP_PWSH === '1'
const WIN = process.platform === 'win32'
if (WIN && !SKIP) console.warn('[status-ps1] win32: the profile cannot be redirected; whole-script runs are skipped')

const NOW_SEC = 1_800_000_000
const FUTURE = NOW_SEC + 3600
const PAST = NOW_SEC - 3600

interface Fixture {
  name: string
  status: number | null
  stdoutHasAuth: boolean
  sentinel: Record<string, unknown> | null
  degraded: Record<string, unknown> | null
}
const FIXTURES: Fixture[] = [
  { name: 'ok', status: 0, stdoutHasAuth: true, sentinel: null, degraded: null },
  { name: 'ok with a stale sentinel', status: 0, stdoutHasAuth: true, sentinel: { ts: 't', http_status: 401, message: 'old' }, degraded: null },
  { name: 'degraded, valid cache', status: 0, stdoutHasAuth: true, sentinel: null, degraded: { ts: '2026-10-07T01:02:03Z', reason: 'HTTP 503', expires_at: FUTURE } },
  { name: 'degraded, expired cache', status: 0, stdoutHasAuth: true, sentinel: null, degraded: { ts: '2026-10-07T01:02:03Z', reason: 'network', expires_at: PAST } },
  { name: 'degraded, expiry as a numeric string', status: 0, stdoutHasAuth: true, sentinel: null, degraded: { ts: 'x', reason: 'r', expires_at: String(PAST) } },
  { name: 'degraded, empty marker', status: 0, stdoutHasAuth: true, sentinel: null, degraded: {} },
  { name: 'degraded, empty reason and zero expiry', status: 0, stdoutHasAuth: true, sentinel: null, degraded: { ts: '', reason: '', expires_at: 0 } },
  { name: 'degraded marker but no auth', status: 0, stdoutHasAuth: false, sentinel: null, degraded: { reason: 'r' } },
  { name: 'exit 0, no auth', status: 0, stdoutHasAuth: false, sentinel: null, degraded: null },
  { name: '401', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 401, message: 'revoked' }, degraded: null },
  { name: '403', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 403, message: 'forbidden' }, degraded: null },
  { name: '404', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 404, message: 'gone' }, degraded: null },
  { name: '401 with an empty message', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 401, message: '' }, degraded: null },
  { name: 'network (http 0)', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 0, message: 'unreachable' }, degraded: null },
  { name: '503', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: 503, message: 'upstream' }, degraded: null },
  { name: 'http_status as a string is no status', status: 1, stdoutHasAuth: false, sentinel: { ts: 't', http_status: '401', message: 'm' }, degraded: null },
  { name: 'no sentinel', status: 1, stdoutHasAuth: false, sentinel: null, degraded: null },
  { name: 'killed (null exit), no sentinel', status: null, stdoutHasAuth: false, sentinel: null, degraded: null },
  { name: 'exit 2, 429', status: 2, stdoutHasAuth: false, sentinel: { http_status: 429 }, degraded: null },
]

function pwshOrThrow() {
  const probe = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) throw new Error(`pwsh missing (${PWSH}); set TOKENSCOPE_SKIP_PWSH=1 to skip`)
}

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-status-ps1-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(SKIP)('status.ps1 verdicts == interpretEmissionProbe (shared fixture table)', () => {
  afterEach(() => vi.useRealTimers())

  it('every fixture yields the same verdict and wording', () => {
    pwshOrThrow()
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SEC * 1000)
    const expected = FIXTURES.map((f) => ({ name: f.name, ...interpretEmissionProbe(f) }))
    vi.useRealTimers()

    const fx = join(tmp, 'fixtures.json')
    writeFileSync(fx, JSON.stringify(FIXTURES))
    const script = [
      `. '${STATUS_PS1}'`,
      `$fx = ConvertFrom-JsonText ([IO.File]::ReadAllText('${fx}'))`,
      '$out = @(foreach ($f in $fx) {',
      '  $v = Get-EmissionVerdict $f.status ([bool]$f.stdoutHasAuth) $f.sentinel $f.degraded ' + NOW_SEC,
      '  $o = [ordered]@{ name = $f.name }',
      '  foreach ($k in $v.Keys) { $o[$k] = $v[$k] }',
      '  $o',
      '})',
      '[Console]::Out.Write((ConvertTo-AsciiJson $out))',
    ].join('\n')
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    const actual = JSON.parse(r.stdout)
    expect(actual).toHaveLength(FIXTURES.length)
    for (let i = 0; i < FIXTURES.length; i++) expect(actual[i]).toEqual(expected[i])
  })
})

// ── end to end ─────────────────────────────────────────────────────────────────
const RT = 'rt-store-SECRET'
const ACCESS = 'access-SECRET'
const BEARER = 'Bearer fresh-bearer-SECRET'
const MCP_TOKEN = 'mcp-oauth-SECRET'
const SECRETS = [RT, ACCESS, 'fresh-bearer-SECRET', MCP_TOKEN]
let bearerMode: 'ok' | 's401' = 'ok'
let server: http.Server
let base = ''

describe.skipIf(SKIP)('status.ps1 end to end (real otel-headers-helper.ps1, stub server)', () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]
        res.setHeader('content-type', 'application/json')
        if (path.endsWith('/oauth/token')) {
          res.writeHead(200)
          return res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer' }))
        }
        if (path.endsWith('/bearer') && bearerMode === 'ok') {
          res.writeHead(200)
          return res.end(JSON.stringify({ Authorization: BEARER }))
        }
        res.writeHead(401)
        res.end(JSON.stringify({ statusMessage: 'revoked' }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  function profile(o: { store?: boolean; mcpKey?: string } = {}) {
    const home = mkdtempSync(join(tmp, 'home '))
    const state = join(home, '.tokenscope')
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(join(home, '.claude'))
    if (o.store !== false) {
      writeFileSync(
        join(state, 'config.claude-code.json'),
        JSON.stringify({
          version: 2,
          tool: 'claude-code',
          instance_id: 'inst-1',
          bearer_endpoint: `${base}/api/v1/instances/inst-1/bearer`,
          oauth_token_endpoint: `${base}/api/v1/oauth/token`,
          oauth_refresh_token: RT,
          oauth_client_id: 'cid',
          otel_resource_attributes: 'tokenscope.instance_id=inst-1,tool=claude-code',
        }),
        { mode: 0o600 },
      )
    }
    if (o.mcpKey) {
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({ mcpOAuth: { [o.mcpKey]: { accessToken: MCP_TOKEN } } }),
        { mode: 0o600 },
      )
    }
    return home
  }

  // ASYNC spawn: the stub server lives in this process, and spawnSync would
  // block the event loop that has to answer the helper.
  async function runStatus(home: string, extraEnv: Record<string, string> = {}) {
    pwshOrThrow()
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const c = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', STATUS_PS1], {
        env: childEnv({ HOME: home, PATH: process.env.PATH ?? '', ...extraEnv }),
      })
      let stdout = ''
      let stderr = ''
      c.stdout.on('data', (d) => (stdout += d))
      c.stderr.on('data', (d) => (stderr += d))
      c.on('close', (status) => done({ status, stdout, stderr }))
    })
    expect(r.status).toBe(0)
    for (const s of SECRETS) {
      expect(r.stdout).not.toContain(s)
      expect(r.stderr).not.toContain(s)
    }
    return JSON.parse(r.stdout)
  }

  it.skipIf(WIN)('OK: the helper mints, the verdict is the shared OK wording, MCP authed', async () => {
    bearerMode = 'ok'
    const out = await runStatus(profile({ mcpKey: 'plugin:tokenscope:tokenscope|abc123' }))
    expect(out.emitting).toBe(true)
    expect(out.probe.status).toBe(200)
    expect(out.probe.message).toBe(interpretEmissionProbe({ status: 0, stdoutHasAuth: true, sentinel: null }).message)
    expect(out.mcp_authed).toBe(true)
    expect(out.last_failure).toBeNull()
    expect(out.runtime).toBe('powershell')
  })

  it.skipIf(WIN)('revoked: 401 verdict from the sentinel the helper wrote; another server key is not MCP auth', async () => {
    bearerMode = 's401'
    const out = await runStatus(profile({ mcpKey: 'plugin:other:tokenscope|x' }))
    expect(out.emitting).toBe(false)
    expect(out.probe.status).toBe(401)
    expect(out.probe.message).toMatch(/^NOT SENDING: .* \(HTTP 401\)\. Usage is being dropped\. Run \/tokenscope:setup/)
    expect(out.last_failure.http_status).toBe(401)
    expect(out.mcp_authed).toBe(false)
  })

  // Off Windows, .NET has no user environment store, so the app's login value
  // reads as missing: this pins the gate and the shape, not the registry read.
  it.skipIf(WIN)('desktop_env appears only in a Claude app session', async () => {
    bearerMode = 'ok'
    const home = profile({ mcpKey: 'plugin:tokenscope:tokenscope|abc123' })
    expect((await runStatus(home)).desktop_env).toBeUndefined()
    expect((await runStatus(home, { CLAUDE_CODE_ENTRYPOINT: 'cli' })).desktop_env).toBeUndefined()
    const out = await runStatus(home, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })
    expect(out.desktop_env.verdict).toBe('missing')
    expect(out.desktop_env.fix).toContain('/tokenscope:setup')
  })

  it.skipIf(WIN)('not configured: no store, no settings credential -> setup, and no request is made', async () => {
    bearerMode = 'ok'
    const out = await runStatus(profile({ store: false }))
    expect(out.emitting).toBe(false)
    expect(out.probe.status).toBeNull()
    expect(out.probe.message).toMatch(/^Not configured/)
    expect(out.probe.message).toContain('/tokenscope:setup')
  })

  // The child launch the OK verdict rests on — status.ps1's own process start,
  // environment scrub and pipe reading, then the real helper's refresh + mint —
  // with the state dir passed explicitly, so it runs on Windows too.
  it('Invoke-EmitHelper runs the REAL helper to a mint (every OS)', async () => {
    pwshOrThrow()
    bearerMode = 'ok'
    const state = join(profile(), '.tokenscope')
    const helper = join(ROOT, 'plugin/scripts/otel-headers-helper.ps1')
    const script = [
      `. '${STATUS_PS1}'`,
      `$r = Invoke-EmitHelper '${helper}' '${state}' 'claude-code' $null 30000`,
      '[Console]::Out.Write((ConvertTo-AsciiJson $r))',
    ].join('\n')
    const r = await new Promise<{ stdout: string; stderr: string }>((done) => {
      const c = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv({ HOME: tmp, PATH: process.env.PATH ?? '' }) })
      let stdout = ''
      let stderr = ''
      c.stdout.on('data', (d) => (stdout += d))
      c.stderr.on('data', (d) => (stderr += d))
      c.on('close', () => done({ stdout, stderr }))
    })
    expect(r.stderr).toBe('')
    for (const s of SECRETS) expect(r.stdout).not.toContain(s)
    expect(JSON.parse(r.stdout)).toEqual({ status: 0, hasAuth: true })
  }, 60_000)
})

// ── the child run: timeout and environment ─────────────────────────────────────
describe.skipIf(SKIP)('status.ps1 runs the helper bounded and with a scrubbed environment', () => {
  const runInvoke = (helperBody: string, call: string, env: NodeJS.ProcessEnv = {}) => {
    const stub = join(tmp, `stub-${Math.random().toString(36).slice(2)}.ps1`)
    writeFileSync(stub, helperBody)
    const script = [`. '${STATUS_PS1}'`, `$r = ${call.replace('STUB', `'${stub}'`)}`, '[Console]::Out.Write((ConvertTo-AsciiJson $r))'].join('\n')
    const t0 = Date.now()
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60_000,
    })
    return { ...r, elapsed: Date.now() - t0 }
  }

  it('a helper that hangs is killed at the timeout, and reads as no exit status', () => {
    pwshOrThrow()
    // Holds stdout open the whole time: a synchronous read would wait it out.
    const r = runInvoke('[Console]::Out.Write("x"); Start-Sleep -Seconds 30', `Invoke-EmitHelper STUB '${tmp}' 'claude-code' $null 1500`)
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual({ status: null, hasAuth: false })
    expect(r.elapsed).toBeLessThan(15_000)
  }, 60_000)

  it('the child does not inherit profiler hooks or repo-steerable TokenScope keys', () => {
    pwshOrThrow()
    const dump = join(tmp, 'child-env.json')
    const body = [
      '$o = [ordered]@{}',
      "foreach ($k in @('COR_ENABLE_PROFILING','COR_PROFILER','CORECLR_PROFILER_PATH','COMPlus_EnableDiagnostics','TOKENSCOPE_STATE_DIR','TOKENSCOPE_API_BASE','TOKENSCOPE_BEARER_ENDPOINT','TOKENSCOPE_OAUTH_REFRESH_TOKEN','PSModulePath','KEEP_ME','SystemRoot')) { $o[$k] = [Environment]::GetEnvironmentVariable($k) }",
      `[IO.File]::WriteAllText('${dump}', ($o | ConvertTo-Json))`,
      'exit 0',
    ].join('\n')
    const globalEnv = "([pscustomobject]@{ TOKENSCOPE_BEARER_ENDPOINT = 'https://global.example/bearer' })"
    const r = runInvoke(body, `Invoke-EmitHelper STUB '${tmp}' 'claude-code' ${globalEnv}`, {
      COR_ENABLE_PROFILING: '1',
      COR_PROFILER: '{x}',
      CORECLR_PROFILER_PATH: '/repo/evil.so',
      COMPlus_EnableDiagnostics: '1',
      TOKENSCOPE_STATE_DIR: '/repo/state',
      TOKENSCOPE_API_BASE: 'https://repo.example',
      TOKENSCOPE_BEARER_ENDPOINT: 'https://repo.example/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'from-repo',
      PSModulePath: '/repo/mods',
      KEEP_ME: 'kept',
    })
    expect(r.status, r.stderr).toBe(0)
    const seen = JSON.parse(readFileSync(dump, 'utf8'))
    expect(seen).toMatchObject({
      COR_ENABLE_PROFILING: null,
      COR_PROFILER: null,
      CORECLR_PROFILER_PATH: null,
      COMPlus_EnableDiagnostics: null,
      TOKENSCOPE_STATE_DIR: null,
      TOKENSCOPE_API_BASE: null,
      // Restored from the device's own settings, as safeProcessEnv does.
      TOKENSCOPE_BEARER_ENDPOINT: 'https://global.example/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: null,
      KEEP_ME: 'kept',
    })
    expect(seen.PSModulePath).not.toContain('/repo/mods')
    // The scrub REMOVES keys from the inherited environment, never builds one
    // from empty: a Windows child without SystemRoot has no working networking.
    if (WIN) expect(seen.SystemRoot).toBeTruthy()
  }, 60_000)
})
