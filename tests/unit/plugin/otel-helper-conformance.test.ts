// @vitest-environment node
/*
 * otel-headers-helper conformance — ONE behaviour suite, TWO helpers (#408 S4).
 *
 * The POSIX helper (`sh otel-headers-helper.sh`, real curl) and the Windows
 * helper (`<pwsh> -File otel-headers-helper.ps1`) are run through the SAME
 * scenarios against the SAME local HTTP stub server (127.0.0.1, which both
 * endpoint guards allow over plain http). Each scenario pins one guarantee from
 * issue #408 Appendix A (sections 1-11) or the #409 cached-bearer rules. The nine
 * `otel-helper-*.test.ts` files stay the .sh's detailed suite.
 *
 * KNOBS (environment of the vitest run):
 *   TOKENSCOPE_PWSH=<exe>    PowerShell for the ps1 leg (default `pwsh`; Windows
 *                            CI sets `powershell.exe` to run real 5.1). Invoked as
 *                            `<exe> -NoProfile -NonInteractive -ExecutionPolicy
 *                            Bypass -File <ps1> ...`, the shape setup writes.
 *   TOKENSCOPE_SKIP_PWSH=1   skip the ps1 leg. Without it a missing PowerShell
 *                            FAILS the run ("pwsh not found"), never skips.
 *   TOKENSCOPE_SKIP_SH=1     skip the sh leg (Windows CI: no POSIX sh/curl/getent).
 *   OTEL_HELPER_SH_PATH / OTEL_HELPER_PS1_PATH
 *                            run the suite against another copy of a helper.
 *
 * WHERE "HOME" COMES FROM, per leg. Both helpers read the account's real profile
 * (the default state dir and the `.claude/settings.json` source) from a place a
 * repository cannot set. The sh leg reads the passwd database: stub `id` and
 * `getent` in a `--tool-dir` dir point it at a temp home. The ps1 leg reads
 * `[Environment]::GetFolderPath('UserProfile')`, which on Linux/macOS .NET answers
 * from $HOME (verified under pwsh 7.5.9), so HOME is the temp home there. On
 * Windows it is SHGetKnownFolderPath and cannot be redirected: the scenarios that
 * need the profile are SKIPPED for the ps1 leg on win32 (visibly, `it.skip`),
 * and every other scenario passes `--state-dir`.
 *
 * MUTATIONS. Every scenario has at least one entry in MUTATIONS: a text edit
 * that removes the guard it protects, applied to a temp copy of the helper; the
 * mutation tests below assert the scenario then FAILS. An edit whose `find` text
 * no longer occurs exactly once fails loudly, so a refactor cannot quietly turn
 * a mutation into a no-op. Equivalent mutants found while building this:
 *   - The verdict flag (VERDICT_SEEN / $VerdictSeen) and the self-heal's
 *     drop-the-Azure-cache each mask the other's removal: after a 401 on the
 *     cached token there is no cache left to fall back to either way. K8/K9
 *     mutate both together.
 *   - The PSModulePath reset is not observable under pwsh 7, which always
 *     resolves Microsoft.PowerShell.* from $PSHOME (probed with a hostile
 *     module directory). The behavioural scenario (X2) bites on 5.1 only; the
 *     static scenario (X1) pins that the reset is the first statement.
 *   - X2 has no mutation. On real Windows PowerShell 5.1 (windows-latest,
 *     PR #416) a hostile PSModulePath did not replace Invoke-WebRequest even
 *     with BOTH the reset and the module-qualified call removed, and pwsh 7
 *     always resolves Microsoft.PowerShell.* from $PSHOME. A mutant that cannot
 *     fail anywhere certifies nothing, so the guards are kept as cheap defence
 *     in depth and pinned statically (X1, ps1-hardening.test.ts), and X2 stays
 *     as a behavioural regression check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync, copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

type Leg = 'sh' | 'ps1'

const ROOT = resolve(__dirname, '../../..')
const HELPERS: Record<Leg, string> = {
  sh: process.env.OTEL_HELPER_SH_PATH ?? join(ROOT, 'plugin/scripts/otel-headers-helper.sh'),
  ps1: process.env.OTEL_HELPER_PS1_PATH ?? join(ROOT, 'plugin/scripts/otel-headers-helper.ps1'),
}
const PLUGIN_MANIFEST = join(ROOT, 'plugin/.claude-plugin/plugin.json')
const PLUGIN_VERSION = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8')).version as string
const PWSH = process.env.TOKENSCOPE_PWSH || 'pwsh'
const SKIP_PWSH = process.env.TOKENSCOPE_SKIP_PWSH === '1'
const SKIP_SH = process.env.TOKENSCOPE_SKIP_SH === '1'
const IS_WIN = process.platform === 'win32'

const pwshProbe = SKIP_PWSH
  ? null
  : spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
const PWSH_OK = pwshProbe !== null && !pwshProbe.error && pwshProbe.status === 0
// 5 = Windows PowerShell 5.1 (CI on windows-latest); 7 = pwsh.
const PS_MAJOR = PWSH_OK ? Number(pwshProbe!.stdout.trim()) : 0

const RUN_TIMEOUT_MS = 30_000

// #412 platform/surface headers. The .sh gains them on the sprint branch; until
// the copy under test has them its leg is excluded from those scenarios (and
// their mutations), and joins automatically once it does.
const SH_HAS_412 = existsSync(HELPERS.sh) && readFileSync(HELPERS.sh, 'utf8').includes('X-TokenScope-Client-Platform')
const LEGS_412: Leg[] = SH_HAS_412 ? ['sh', 'ps1'] : ['ps1']
const EXPECTED_PLATFORM = ['darwin', 'linux', 'win32'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
  ? `${process.platform}-${process.arch}`
  : undefined

// Secrets the helpers handle. Distinct strings so a leak names its source.
const STORE_RT = 'rt-store-SECRET'
const ENV_RT = 'rt-env-SECRET'
const SETTINGS_RT = 'rt-settings-SECRET'
const ACCESS = 'access-SECRET'
const FRESH_BEARER = 'Bearer fresh-bearer-SECRET'
const CACHED_BEARER = 'Bearer cached-bearer-SECRET'
const SECRETS = [STORE_RT, ENV_RT, SETTINGS_RT, ACCESS, 'fresh-bearer-SECRET', 'cached-bearer-SECRET', 'cached-access-SECRET']

// ── The stub server ─────────────────────────────────────────────────────────────
// One per file. Routes by path: /api/v1/oauth/token (POST), /api/v1/instances/<id>/bearer
// (GET), /evil/... (anything a helper must never reach) and /capture (a redirect
// target that must never be hit). `down` destroys the socket: no HTTP response,
// which both curl and Invoke-WebRequest report as "unreachable".
type TokenMode = 'ok' | 'down' | 's429' | 's503' | 'dead' | 'noaccess' | 'redirect'
type BearerMode =
  | 'ok' | 'down' | 's401' | 's401detail' | 's401dirty' | 's403' | 's404' | 's408' | 's429' | 's503' | 'redirect' | 'noauth' | 'slowbody'
interface Req { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
const srv = {
  server: null as http.Server | null,
  base: '',
  token: 'ok' as TokenMode,
  bearer: ['ok'] as BearerMode[],
  expires: undefined as string | undefined,
  reqs: [] as Req[],
  bearerCount: 0,
  reset(o: { token?: TokenMode; bearer?: BearerMode[]; expires?: string } = {}) {
    this.token = o.token ?? 'ok'
    this.bearer = o.bearer ?? ['ok']
    this.expires = o.expires
    this.reqs = []
    this.bearerCount = 0
  },
  calls(kind: 'token' | 'bearer' | 'evil' | 'capture') {
    return this.reqs.filter((r) =>
      kind === 'token' ? r.path.endsWith('/oauth/token') && !r.path.startsWith('/evil')
        : kind === 'bearer' ? r.path.endsWith('/bearer') && !r.path.startsWith('/evil')
          : kind === 'evil' ? r.path.startsWith('/evil') || r.path.includes('/instances/evil/')
            : r.path.startsWith('/capture'))
  },
}
// `slowbody`: a 200 whose headers arrive at once and whose body then trickles,
// one byte a second, for TRICKLE_MS (#418). Every read makes progress, so only a
// deadline over the WHOLE request stops it; a complete body would be a valid
// mint, so a helper without one hands back the fresh bearer, late.
const TRICKLE_MS = 22_000
// The helpers' deadline is 10 s; the bound leaves room for interpreter startup
// (5.1 on a cold Windows runner) and stays below the 20 s mutations.
const SLOW_BODY_BOUND_MS = 15_000
function trickle(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.write(`{"Authorization":"${FRESH_BEARER}"`)
  const started = Date.now()
  const t = setInterval(() => {
    if (Date.now() - started >= TRICKLE_MS) {
      clearInterval(t)
      res.end('}')
    } else {
      res.write(' ')
    }
  }, 1000)
  res.on('close', () => clearInterval(t))
}
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  const path = (req.url ?? '').split('?')[0]
  srv.reqs.push({ method: req.method ?? '', path, headers: req.headers, body })
  if (path.startsWith('/capture')) return json(res, 200, { Authorization: 'Bearer captured', access_token: 'captured', expires_in: 3600 })
  if (path.endsWith('/oauth/token')) {
    const mode = path.startsWith('/evil') ? 'ok' : srv.token
    switch (mode) {
      case 'ok': return json(res, 200, { access_token: ACCESS, expires_in: 3600, token_type: 'Bearer' })
      case 'down': return req.socket.destroy()
      case 's429': return json(res, 429, 'slow down')
      case 's503': return json(res, 503, 'upstream')
      case 'dead': return json(res, 400, { error: 'invalid_grant' })
      case 'noaccess': return json(res, 200, { token_type: 'Bearer' })
      case 'redirect': res.writeHead(307, { Location: '/capture/oauth/token' }); return res.end()
    }
  }
  if (path.endsWith('/bearer')) {
    let mode: BearerMode = 'ok'
    if (!path.includes('/instances/evil/')) {
      mode = srv.bearer[Math.min(srv.bearerCount, srv.bearer.length - 1)]
      srv.bearerCount++
    }
    const exp: Record<string, string> = srv.expires ? { 'X-TokenScope-Bearer-Expires-At': srv.expires } : {}
    switch (mode) {
      case 'ok': return json(res, 200, { Authorization: FRESH_BEARER }, exp)
      case 'down': return req.socket.destroy()
      case 's401': return json(res, 401, { statusMessage: 'revoked' })
      case 's401detail': return json(res, 401, { detail: 'instance ended' })
      case 's401dirty':
        return json(res, 401, { statusMessage: `a\\b\nc"d${'x'.repeat(400)}` })
      case 's403': return json(res, 403, { statusMessage: 'forbidden' })
      case 's404': return json(res, 404, { statusMessage: 'gone' })
      case 's408': return json(res, 408, 'timeout')
      case 's429': return json(res, 429, 'slow down')
      case 's503': return json(res, 503, 'upstream unavailable')
      case 'redirect': res.writeHead(302, { Location: '/capture/bearer' }); return res.end()
      case 'noauth': return json(res, 200, { hello: 'world' })
      case 'slowbody': return trickle(res)
    }
  }
  json(res, 404, { statusMessage: 'no route' })
}

beforeAll(async () => {
  srv.server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => handle(req, res, body))
  })
  await new Promise<void>((r) => srv.server!.listen(0, '127.0.0.1', () => r()))
  srv.base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => srv.server!.close(() => r()))
})

const INST = 'inst-1'
const ep = {
  bearer: () => `${srv.base}/api/v1/instances/${INST}/bearer`,
  token: () => `${srv.base}/api/v1/oauth/token`,
  evilBearer: () => `${srv.base}/evil/api/v1/instances/${INST}/bearer`,
  evilToken: () => `${srv.base}/evil/oauth/token`,
}

// ── Harness ─────────────────────────────────────────────────────────────────────
interface RunOpts {
  args?: string[] // replaces the default `--state-dir <stateDir>` (and `--tool`)
  tool?: string
  stateDir?: string
  env?: Record<string, string> // added to the base environment
  envSource?: 'good' | 'evil' | 'none' // TOKENSCOPE_* in the process environment
}
interface Result { status: number | null; stdout: string; stderr: string }

// The test runner's own environment, minus anything that would feed a helper.
function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^(TOKENSCOPE_|OTEL_|CLAUDE_|AI_AGENT$)/.test(k)) continue
    e[k] = v
  }
  return e
}

class Ctx {
  readonly tmp: string
  readonly home: string
  readonly stateDir: string
  readonly toolDir: string
  constructor(readonly leg: Leg, readonly helper: string) {
    this.tmp = mkdtempSync(join(tmpdir(), `ts-conf-${leg}-`))
    this.home = join(this.tmp, 'home')
    this.stateDir = join(this.tmp, 'state')
    this.toolDir = join(this.tmp, 'bin')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.stateDir, { recursive: true })
    if (leg === 'sh') {
      // Pin the passwd lookup to the temp home (the sh reads passwd, not $HOME).
      mkdirSync(this.toolDir, { recursive: true })
      writeFileSync(join(this.toolDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
      writeFileSync(join(this.toolDir, 'getent'), `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' '${this.home}'\n`)
      chmodSync(join(this.toolDir, 'id'), 0o755)
      chmodSync(join(this.toolDir, 'getent'), 0o755)
    }
  }
  cleanup() { rmSync(this.tmp, { recursive: true, force: true }) }

  file(name: string, tool = 'claude-code', dir = this.stateDir) { return join(dir, name.replace('<tool>', tool)) }
  exists(name: string, tool?: string, dir?: string) { return existsSync(this.file(name, tool, dir)) }
  read(name: string, tool?: string, dir?: string) { return readFileSync(this.file(name, tool, dir), 'utf8') }
  json(name: string, tool?: string, dir?: string) { return JSON.parse(this.read(name, tool, dir)) }

  seedStore(over: Record<string, unknown> = {}, tool = 'claude-code', dir = this.stateDir) {
    const s = {
      version: 2,
      tool,
      instance_id: INST,
      bearer_endpoint: ep.bearer(),
      oauth_token_endpoint: ep.token(),
      oauth_refresh_token: STORE_RT,
      oauth_client_id: 'cid-store',
      otel_resource_attributes: `tokenscope.instance_id=${INST},tool=${tool}`,
      ...over,
    }
    // `undefined` in `over` removes a field (JSON.stringify drops it).
    writeFileSync(join(dir, `config.${tool}.json`), JSON.stringify(s, null, 2))
  }
  seedAccess(o: { endpoint?: string; expiresAt?: number; dir?: string; tool?: string } = {}) {
    writeFileSync(this.file('oauth-access.<tool>.json', o.tool, o.dir), JSON.stringify({
      access_token: 'cached-access-SECRET', expires_at: o.expiresAt ?? 9999999999, bearer_endpoint: o.endpoint ?? ep.bearer(),
    }))
  }
  seedAzure(o: { endpoint?: string; expiresAt?: number; dir?: string } = {}) {
    writeFileSync(this.file('azure-bearer.<tool>.json', undefined, o.dir), JSON.stringify({
      authorization: CACHED_BEARER, expires_at: o.expiresAt ?? 9999999999, bearer_endpoint: o.endpoint ?? ep.bearer(),
    }))
  }
  writeSettings(text: string) {
    mkdirSync(join(this.home, '.claude'), { recursive: true })
    writeFileSync(join(this.home, '.claude', 'settings.json'), text)
  }

  run(o: RunOpts = {}): Promise<Result> {
    const args = o.args ?? ['--state-dir', o.stateDir ?? this.stateDir, ...(o.tool ? ['--tool', o.tool] : [])]
    const src = o.envSource ?? 'good'
    const envSrc: Record<string, string> =
      src === 'none' ? {}
        : {
            TOKENSCOPE_BEARER_ENDPOINT: src === 'good' ? ep.bearer() : ep.evilBearer(),
            TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: src === 'good' ? ep.token() : ep.evilToken(),
            TOKENSCOPE_OAUTH_REFRESH_TOKEN: ENV_RT,
            TOKENSCOPE_OAUTH_CLIENT_ID: 'cid-env',
          }
    const env = { ...baseEnv(), HOME: this.home, ...envSrc, ...(o.env ?? {}) }
    const [cmd, argv] =
      this.leg === 'sh'
        ? ['sh', [this.helper, '--tool-dir', this.toolDir, ...args]]
        : [PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helper, ...args]]
    return new Promise((res, rej) => {
      // spawn, not spawnSync: the stub server lives on this event loop.
      const c = spawn(cmd, argv, { env, cwd: this.tmp })
      let stdout = ''
      let stderr = ''
      c.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      c.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      c.on('error', rej)
      c.on('close', (status) => res({ status, stdout, stderr }))
    })
  }
}

// Stray files a helper must never leave behind (temp files, curl header dumps).
const strays = (dir: string) => readdirSync(dir).filter((f) => /\.tmp\.|^\.bearer-hdr/.test(f))
const noSecrets = (...texts: string[]) => {
  for (const t of texts) for (const s of SECRETS) expect(t).not.toContain(s)
}
const sentinelOf = (c: Ctx, tool?: string) => (c.exists('emit-failure.<tool>.json', tool) ? c.json('emit-failure.<tool>.json', tool) : undefined)

// ── Scenarios ───────────────────────────────────────────────────────────────────
interface Scenario {
  id: string
  title: string
  legs?: Leg[] // default both
  needsProfile?: boolean // reads the account profile: ps1 leg cannot redirect it on win32
  run: (c: Ctx) => Promise<void>
}

const S: Scenario[] = [
  // §1 Arguments only
  {
    id: 'A1', title: 'an unknown argument exits 2 and prints nothing',
    run: async (c) => {
      const r = await c.run({ args: ['--state-dir', c.stateDir, '--bogus', 'x'] })
      expect(r.status).toBe(2)
      expect(r.stdout).toBe('')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'A2', title: 'a relative --state-dir exits 2 (never resolved against the cwd)',
    run: async (c) => {
      const r = await c.run({ args: ['--state-dir', 'rel-state'] })
      expect(r.status).toBe(2)
      expect(existsSync(join(c.tmp, 'rel-state'))).toBe(false)
    },
  },
  {
    id: 'A3', title: 'a flag with no value exits 2',
    run: async (c) => {
      expect((await c.run({ args: ['--state-dir', c.stateDir, '--tool'] })).status).toBe(2)
    },
  },
  {
    id: 'A4', title: '--tool outside the closed set exits 2',
    run: async (c) => {
      expect((await c.run({ args: ['--state-dir', c.stateDir, '--tool', 'evil-tool'] })).status).toBe(2)
    },
  },
  {
    id: 'A5', title: '--tool-dir is refused by the port (it has no subprocesses to stub)', legs: ['ps1'],
    run: async (c) => {
      expect((await c.run({ args: ['--state-dir', c.stateDir, '--tool-dir', c.tmp] })).status).toBe(2)
    },
  },
  {
    id: 'A6', title: 'no --state-dir: <real profile>/.tokenscope; TOKENSCOPE_STATE_DIR and USERPROFILE are ignored',
    needsProfile: true,
    run: async (c) => {
      const decoy = join(c.tmp, 'decoy')
      const r = await c.run({ args: [], env: { TOKENSCOPE_STATE_DIR: decoy, USERPROFILE: decoy } })
      expect(r.status).toBe(0)
      expect(existsSync(join(c.home, '.tokenscope', 'oauth-access.claude-code.json'))).toBe(true)
      expect(existsSync(decoy)).toBe(false)
    },
  },

  // §3/§4.1 Own store
  {
    id: 'S1', title: 'a complete v2 store is adopted WHOLE: its token, its endpoints, never the environment\'s',
    run: async (c) => {
      c.seedStore()
      const r = await c.run({ envSource: 'evil' })
      expect(r.status).toBe(0)
      expect(srv.calls('evil')).toHaveLength(0)
      const tok = srv.calls('token')
      expect(tok).toHaveLength(1)
      const form = new URLSearchParams(tok[0].body)
      expect(form.get('refresh_token')).toBe(STORE_RT)
      expect(form.get('client_id')).toBe('cid-store')
      expect(form.get('grant_type')).toBe('refresh_token')
    },
  },
  {
    id: 'S2', title: 'store tool mismatch → refused, nothing sent',
    run: async (c) => {
      // Renamed from the copilot lane: tool says copilot, attributes say claude.
      c.seedStore({ tool: 'copilot-cli' })
      const r = await c.run({ envSource: 'good' })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/^TokenScope: emission auth REFUSED/m)
      expect(sentinelOf(c).message).toBe('store tool mismatch')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'S3', title: 'store attributes name another tool → refused',
    run: async (c) => {
      c.seedStore({ otel_resource_attributes: `tokenscope.instance_id=${INST},tool=copilot-cli` })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store marker mismatch')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'S4', title: 'store missing a destination → refused; the environment never fills the gap',
    run: async (c) => {
      c.seedStore({ oauth_token_endpoint: undefined })
      const r = await c.run({ envSource: 'good' })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store present but unreadable')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'S5', title: 'store version is not 2 → refused',
    run: async (c) => {
      c.seedStore({ version: 1 })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store missing the v2 envelope')
    },
  },
  {
    id: 'S6', title: 'store attributes name another instance → refused',
    run: async (c) => {
      c.seedStore({ otel_resource_attributes: 'tokenscope.instance_id=other,tool=claude-code' })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store attributes inconsistent')
    },
  },
  {
    id: 'S7', title: 'store bearer URL addresses another instance (incl. a query-string look-alike) → refused',
    run: async (c) => {
      c.seedStore({ bearer_endpoint: `${srv.base}/api/v1/instances/other/bearer` })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store instance/endpoint mismatch')
      c.seedStore({ bearer_endpoint: `${srv.base}/x?next=/api/v1/instances/${INST}/bearer` })
      const r2 = await c.run()
      expect(r2.status).toBe(1)
      expect(sentinelOf(c).message).toBe('store instance/endpoint mismatch')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'S8', title: 'per-tool files: the copilot lane reads and writes only *.copilot-cli.json',
    run: async (c) => {
      c.seedStore({}, 'copilot-cli')
      const r = await c.run({ tool: 'copilot-cli', envSource: 'evil' })
      expect(r.status).toBe(0)
      expect(c.exists('oauth-access.<tool>.json', 'copilot-cli')).toBe(true)
      expect(c.exists('azure-bearer.<tool>.json', 'copilot-cli')).toBe(true)
      expect(readdirSync(c.stateDir).filter((f) => f.includes('claude-code'))).toEqual([])
      expect(srv.calls('evil')).toHaveLength(0)
    },
  },

  // §4.3 The real profile's settings.json env
  {
    id: 'G1', title: 'settings.json env with a credential and both endpoints is adopted whole',
    needsProfile: true,
    run: async (c) => {
      c.writeSettings(JSON.stringify({
        env: {
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: SETTINGS_RT, TOKENSCOPE_BEARER_ENDPOINT: ep.bearer(),
          TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: ep.token(), TOKENSCOPE_OAUTH_CLIENT_ID: 'cid-settings',
        },
      }))
      const r = await c.run({ envSource: 'evil' })
      expect(r.status).toBe(0)
      expect(srv.calls('evil')).toHaveLength(0)
      expect(new URLSearchParams(srv.calls('token')[0].body).get('refresh_token')).toBe(SETTINGS_RT)
    },
  },
  {
    id: 'G2', title: 'settings.json credential without both endpoints → refused, env endpoints never used',
    needsProfile: true,
    run: async (c) => {
      c.writeSettings(JSON.stringify({ env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: SETTINGS_RT, TOKENSCOPE_BEARER_ENDPOINT: ep.bearer() } }))
      const r = await c.run({ envSource: 'evil' })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('settings credential without both settings endpoints')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'G3', title: 'unparseable settings.json + an ambient credential → refused (trusted but unusable)',
    needsProfile: true,
    run: async (c) => {
      c.writeSettings('{ this is not json')
      const r = await c.run({ envSource: 'evil' })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('trusted source unusable, ambient credential present')
      // #452: both helpers say what they found, not only that they refused.
      expect(r.stderr).toContain('device store')
      expect(r.stderr).toContain('is missing.')
      expect(r.stderr).toContain('could not be read as a settings file.')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'G4', title: 'settings.json with an env block and no credential is absent: the environment is used',
    needsProfile: true,
    run: async (c) => {
      c.writeSettings(JSON.stringify({ env: { SOMETHING_ELSE: '1' } }))
      const r = await c.run({ envSource: 'good' })
      expect(r.status).toBe(0)
      expect(new URLSearchParams(srv.calls('token')[0].body).get('refresh_token')).toBe(ENV_RT)
    },
  },
  {
    id: 'G5', title: 'a nested look-alike credential key never pairs with environment endpoints',
    needsProfile: true,
    run: async (c) => {
      // Not under `env`. The .sh's whole-file grep finds it (and refuses for want
      // of endpoints); the port finds no env credential but sees the key (unusable).
      c.writeSettings(JSON.stringify({ env: {}, other: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: SETTINGS_RT } }))
      const r = await c.run({ envSource: 'evil' })
      expect(r.status).toBe(1)
      expect(srv.calls('evil')).toHaveLength(0)
    },
  },
  {
    id: 'G6', title: 'a user-edited settings.json with comments/trailing commas never pairs with environment endpoints',
    needsProfile: true,
    run: async (c) => {
      // Outcome differs by parser (sh greps; pwsh 7 parses; 5.1 refuses) and
      // both are acceptable. Borrowing a destination from the environment is not.
      c.writeSettings(`{
  // my settings
  "env": {
    "TOKENSCOPE_OAUTH_REFRESH_TOKEN": "${SETTINGS_RT}",
    "TOKENSCOPE_BEARER_ENDPOINT": "${ep.bearer()}",
    "TOKENSCOPE_OAUTH_TOKEN_ENDPOINT": "${ep.token()}",
  },
}`)
      const r = await c.run({ envSource: 'evil' })
      expect(srv.calls('evil')).toHaveLength(0)
      if (r.status === 0) expect(new URLSearchParams(srv.calls('token')[0].body).get('refresh_token')).toBe(SETTINGS_RT)
      else expect(r.status).toBe(1)
    },
  },

  // §4.4 The environment
  {
    id: 'E1', title: 'with nothing stored, the environment credential mints',
    run: async (c) => {
      const r = await c.run({ envSource: 'good' })
      expect(r.status).toBe(0)
      expect(new URLSearchParams(srv.calls('token')[0].body).get('refresh_token')).toBe(ENV_RT)
    },
  },
  {
    id: 'E2', title: 'nothing configured anywhere → NOT CONFIGURED, sentinel, exit 1',
    run: async (c) => {
      const r = await c.run({ envSource: 'none' })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/^TokenScope: emission auth NOT CONFIGURED/m)
      expect(sentinelOf(c).message).toBe('TOKENSCOPE_BEARER_ENDPOINT not set')
    },
  },

  // §5 Endpoint guard
  {
    id: 'P1', title: 'an off-box http bearer endpoint is refused before any request',
    run: async (c) => {
      const r = await c.run({ env: { TOKENSCOPE_BEARER_ENDPOINT: `http://example.invalid/api/v1/instances/${INST}/bearer` } })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('TOKENSCOPE_BEARER_ENDPOINT must be https off-box')
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'P2', title: 'an endpoint starting with "-" is refused',
    run: async (c) => {
      const r = await c.run({ env: { TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: `-${ep.token()}` } })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe("TOKENSCOPE_OAUTH_TOKEN_ENDPOINT starts with '-'")
      expect(srv.reqs).toHaveLength(0)
    },
  },
  {
    id: 'P3', title: 'a bearer endpoint with a quote is refused BEFORE the refresh',
    run: async (c) => {
      const r = await c.run({ env: { TOKENSCOPE_BEARER_ENDPOINT: `${srv.base}/api/v1/instances/${INST}/bearer"x` } })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('bearer endpoint not bindable')
      expect(srv.calls('token')).toHaveLength(0)
    },
  },
  {
    id: 'P4', title: 'an off-box http token endpoint is refused before the refresh token is sent',
    run: async (c) => {
      const r = await c.run({ env: { TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://example.invalid/oauth/token' } })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('TOKENSCOPE_OAUTH_TOKEN_ENDPOINT must be https off-box')
    },
  },
  {
    id: 'P5', title: 'loopback http must PARSE as loopback: userinfo cannot smuggle a host', legs: ['ps1'],
    run: async (c) => {
      const port = new URL(srv.base).port
      const r = await c.run({ env: { TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: `http://127.0.0.1:${port}@example.invalid/oauth/token` } })
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('TOKENSCOPE_OAUTH_TOKEN_ENDPOINT must be https off-box')
    },
  },

  // §6 No redirects
  {
    id: 'R1', title: 'a redirect from the token endpoint is a failure: the refresh body is never re-sent',
    run: async (c) => {
      srv.reset({ token: 'redirect' })
      c.seedAzure()
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(srv.calls('capture')).toHaveLength(0)
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false) // a verdict, not weather
      expect(r.stdout).toBe('')
    },
  },
  {
    id: 'R2', title: 'a redirect from /bearer is a failure and is not followed',
    run: async (c) => {
      srv.reset({ bearer: ['redirect'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(srv.calls('capture')).toHaveLength(0)
      expect(sentinelOf(c).http_status).toBeGreaterThanOrEqual(300)
      expect(sentinelOf(c).http_status).toBeLessThan(400)
    },
  },

  // §7 Access cache
  {
    id: 'C1', title: 'the refresh writes {access_token, expires_at, bearer_endpoint}; the next run reuses it',
    run: async (c) => {
      const before = Math.floor(Date.now() / 1000)
      expect((await c.run()).status).toBe(0)
      const cache = c.json('oauth-access.<tool>.json')
      expect(Object.keys(cache).sort()).toEqual(['access_token', 'bearer_endpoint', 'expires_at'])
      expect(cache.access_token).toBe(ACCESS)
      expect(cache.bearer_endpoint).toBe(ep.bearer())
      expect(cache.expires_at).toBeGreaterThanOrEqual(before + 3600)
      expect(cache.expires_at).toBeLessThanOrEqual(before + 3700)
      expect((await c.run()).status).toBe(0)
      expect(srv.calls('token')).toHaveLength(1)
      expect(srv.calls('bearer')).toHaveLength(2)
    },
  },
  {
    id: 'C2', title: 'a cached access token bound to a different endpoint is not presented',
    run: async (c) => {
      c.seedAccess({ endpoint: `${srv.base}/api/v1/instances/other/bearer` })
      expect((await c.run()).status).toBe(0)
      expect(srv.calls('token')).toHaveLength(1)
      expect(srv.calls('bearer')[0].headers.authorization).toBe(`Bearer ${ACCESS}`)
    },
  },
  {
    id: 'C3', title: 'a cached access token within 120s of expiry is refreshed, not presented',
    run: async (c) => {
      c.seedAccess({ expiresAt: Math.floor(Date.now() / 1000) + 60 })
      expect((await c.run()).status).toBe(0)
      expect(srv.calls('token')).toHaveLength(1)
    },
  },
  {
    id: 'C4', title: 'a refused refresh (invalid_grant) records the status and the error',
    run: async (c) => {
      srv.reset({ token: 'dead' })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/^TokenScope: emission auth FAILED \(OAuth refresh HTTP 400 invalid_grant\)/m)
      expect(sentinelOf(c)).toMatchObject({ http_status: 400, message: 'oauth refresh failed: invalid_grant' })
    },
  },
  {
    id: 'C5', title: 'a 200 refresh without access_token is a failure',
    run: async (c) => {
      srv.reset({ token: 'noaccess' })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('oauth refresh returned no access_token')
      expect(srv.calls('bearer')).toHaveLength(0)
    },
  },
  {
    id: 'C6', title: 'the refresh form body is percent-encoded (a token with + & = survives)',
    run: async (c) => {
      const odd = 'a+b&c=d/e SECRET'
      const r = await c.run({ env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: odd } })
      expect(r.status).toBe(0)
      expect(new URLSearchParams(srv.calls('token')[0].body).get('refresh_token')).toBe(odd)
    },
  },

  // §8 /bearer request
  {
    id: 'V1', title: '/bearer gets the access token and the sanitised version headers',
    run: async (c) => {
      const r = await c.run({ env: { CLAUDE_CODE_EXECPATH: 'C:\\Users\\x\\.local\\share\\claude\\versions\\2.1.240\\claude.exe' } })
      expect(r.status).toBe(0)
      const h = srv.calls('bearer')[0].headers
      expect(h.authorization).toBe(`Bearer ${ACCESS}`)
      expect(h['x-tokenscope-plugin-version']).toBe(PLUGIN_VERSION)
      expect(h['x-tokenscope-client-version']).toBe('2.1.240')
    },
  },
  {
    id: 'V2', title: 'with no CLI signal the client-version header is omitted; AI_AGENT is the fallback',
    run: async (c) => {
      expect((await c.run()).status).toBe(0)
      expect(srv.calls('bearer')[0].headers['x-tokenscope-client-version']).toBeUndefined()
      expect((await c.run({ env: { AI_AGENT: 'claude-code_2-1-211_agent' } })).status).toBe(0)
      expect(srv.calls('bearer')[1].headers['x-tokenscope-client-version']).toBe('2.1.211')
    },
  },

  {
    id: 'V3', title: '/bearer gets X-TokenScope-Client-Platform as <os>-<arch> in Node vocabulary', legs: LEGS_412,
    run: async (c) => {
      expect((await c.run()).status).toBe(0)
      expect(srv.calls('bearer')[0].headers['x-tokenscope-client-platform']).toBe(EXPECTED_PLATFORM)
    },
  },
  {
    id: 'V4', title: 'claude-code surface: CLAUDE_CODE_ENTRYPOINT as-is, omitted when absent or unsafe', legs: LEGS_412,
    run: async (c) => {
      expect((await c.run({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } })).status).toBe(0)
      expect((await c.run()).status).toBe(0)
      expect((await c.run({ env: { CLAUDE_CODE_ENTRYPOINT: 'a b"c' } })).status).toBe(0)
      expect(srv.calls('bearer').map((b) => b.headers['x-tokenscope-client-surface'])).toEqual(['sdk-cli', undefined, undefined])
    },
  },
  {
    id: 'V5', title: 'copilot-cli surface: app / cli from AI_AGENT, omitted when absent or foreign', legs: LEGS_412,
    run: async (c) => {
      c.seedStore({}, 'copilot-cli')
      for (const agent of ['github_copilot_app_agent', 'github_copilot_cli_agent', 'claude-code_2-1-211_agent', '']) {
        expect((await c.run({ tool: 'copilot-cli', envSource: 'none', env: { AI_AGENT: agent, CLAUDE_CODE_ENTRYPOINT: 'cli' } })).status).toBe(0)
      }
      expect(srv.calls('bearer').map((b) => b.headers['x-tokenscope-client-surface'])).toEqual(['app', 'cli', undefined, undefined])
    },
  },

  // §9 Self-heal
  {
    id: 'B1', title: 'a cached token refused with 401 is dropped, refreshed ONCE and retried ONCE',
    run: async (c) => {
      c.seedAccess()
      srv.reset({ bearer: ['s401', 'ok'] })
      const r = await c.run()
      expect(r.status).toBe(0)
      expect(srv.calls('token')).toHaveLength(1)
      expect(srv.calls('bearer').map((b) => b.headers.authorization)).toEqual(['Bearer cached-access-SECRET', `Bearer ${ACCESS}`])
    },
  },
  {
    id: 'B2', title: 'a FRESH token refused is final: no retry, message from statusMessage',
    run: async (c) => {
      srv.reset({ bearer: ['s401', 'ok'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(srv.calls('bearer')).toHaveLength(1)
      expect(sentinelOf(c)).toMatchObject({ http_status: 401, message: 'revoked' })
      expect(c.exists('oauth-access.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'B3', title: 'a 403 with only `detail` uses detail as the message',
    run: async (c) => {
      srv.reset({ bearer: ['s401detail'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).message).toBe('instance ended')
    },
  },

  // §10 Outcomes and sentinel
  {
    id: 'O1', title: '200: exactly one line of compact JSON on stdout (no BOM, LF), sentinel cleared',
    run: async (c) => {
      writeFileSync(c.file('emit-failure.<tool>.json'), '{"ts":"x","http_status":0,"message":"stale"}')
      const r = await c.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(`{"Authorization":"${FRESH_BEARER}"}\n`)
      expect(c.exists('emit-failure.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'O2', title: 'the sentinel message loses quotes, backslashes and newlines and is cut to 300',
    run: async (c) => {
      srv.reset({ bearer: ['s401dirty'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      const s = sentinelOf(c)
      expect(Object.keys(s).sort()).toEqual(['http_status', 'message', 'ts'])
      expect(s.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(s.message).not.toMatch(/["\\\n\r]/)
      // The .sh reads the raw JSON text up to the first escaped quote ("abnc");
      // the port decodes, strips and cuts ("abcdxxx..."). Both are safe.
      expect(s.message.startsWith('ab')).toBe(true)
      expect(s.message.length).toBeLessThanOrEqual(300)
    },
  },
  {
    id: 'O3', title: 'token material never reaches stdout on failure, stderr, the sentinel or the marker',
    run: async (c) => {
      c.seedStore()
      c.seedAccess()
      c.seedAzure({ expiresAt: 1000000000 })
      srv.reset({ bearer: ['s401', 'down'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      const files = ['emit-failure.<tool>.json', 'emit-degraded.<tool>.json'].filter((f) => c.exists(f)).map((f) => c.read(f))
      noSecrets(r.stderr, ...files)
      expect(r.stderr).toMatch(/^TokenScope: emission auth /m)
    },
  },

  // #409 Cached Azure bearer
  {
    id: 'K1', title: 'a clean mint caches the bearer, bound to the endpoint, with the response-header expiry',
    run: async (c) => {
      srv.reset({ expires: '1900000000' })
      expect((await c.run()).status).toBe(0)
      expect(c.json('azure-bearer.<tool>.json')).toEqual({ authorization: FRESH_BEARER, expires_at: 1900000000, bearer_endpoint: ep.bearer() })
    },
  },
  {
    id: 'K2', title: 'no expiry header (older server) → expires_at 0, still mints',
    run: async (c) => {
      expect((await c.run()).status).toBe(0)
      expect(c.json('azure-bearer.<tool>.json').expires_at).toBe(0)
    },
  },
  {
    id: 'K3', title: '/bearer unreachable → the cached bearer, degraded marker, stale sentinel cleared',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      writeFileSync(c.file('emit-failure.<tool>.json'), '{"ts":"x","http_status":0,"message":"stale"}')
      srv.reset({ bearer: ['down'] })
      const r = await c.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(`{"Authorization":"${CACHED_BEARER}"}\n`)
      expect(r.stderr).toMatch(/^TokenScope: emission auth DEGRADED/m)
      const d = c.json('emit-degraded.<tool>.json')
      expect(Object.keys(d).sort()).toEqual(['expires_at', 'reason', 'ts'])
      expect(d.reason).toMatch(/could not reach/)
      expect(d.expires_at).toBe(9999999999)
      expect(c.exists('emit-failure.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K4', title: '/bearer 503, 408 and 429 → the cached bearer',
    run: async (c) => {
      for (const m of ['s503', 's408', 's429'] as const) {
        c.seedAccess()
        c.seedAzure()
        srv.reset({ bearer: [m] })
        const r = await c.run()
        expect(r.status).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual({ Authorization: CACHED_BEARER })
        expect(c.json('emit-degraded.<tool>.json').reason).toBe(`bearer endpoint HTTP ${m.slice(1)}`)
      }
    },
  },
  {
    id: 'K5', title: 'token endpoint down / 429 / 503 while a refresh is needed → the cached bearer',
    run: async (c) => {
      for (const m of ['down', 's429', 's503'] as const) {
        c.seedAzure()
        srv.reset({ token: m })
        const r = await c.run()
        expect(r.status).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual({ Authorization: CACHED_BEARER })
        expect(c.json('emit-degraded.<tool>.json').reason).toMatch(/^OAuth token endpoint HTTP /)
      }
    },
  },
  {
    id: 'K6', title: 'an EXPIRED cached bearer is still handed back, with the marker AND the failure sentinel',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure({ expiresAt: 1000000000 })
      srv.reset({ bearer: ['down'] })
      const r = await c.run()
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ Authorization: CACHED_BEARER })
      expect(r.stderr).toMatch(/EXPIRED/)
      expect(c.json('emit-degraded.<tool>.json').expires_at).toBe(1000000000)
      expect(sentinelOf(c)).toMatchObject({ http_status: 0 })
      expect(sentinelOf(c).message).toMatch(/expired at 1000000000/)
    },
  },
  {
    id: 'K7', title: 'a 401 on a fresh token stops emission and drops the cached bearer',
    run: async (c) => {
      c.seedAzure()
      writeFileSync(c.file('emit-degraded.<tool>.json'), '{"ts":"x","reason":"old","expires_at":0}')
      srv.reset({ bearer: ['s401'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K8', title: '401 on the cached token, then the token endpoint goes down: still a verdict, no fallback',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      srv.reset({ bearer: ['s401'], token: 'down' })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K9', title: '401 on the cached token, refresh OK, retry 503: still a verdict, no fallback',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      srv.reset({ bearer: ['s401', 's503'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K10', title: '401 on the cached token, refresh OK, retry 200: self-heal rewrites the cached bearer',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      srv.reset({ bearer: ['s401', 'ok'], expires: '1900000000' })
      const r = await c.run()
      expect(r.status).toBe(0)
      expect(c.json('azure-bearer.<tool>.json')).toMatchObject({ authorization: FRESH_BEARER, expires_at: 1900000000 })
    },
  },
  {
    id: 'K11', title: 'a dead refresh credential (invalid_grant) drops the cached bearer',
    run: async (c) => {
      c.seedAzure()
      srv.reset({ token: 'dead' })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K12', title: 'a non-transient 4xx from /bearer (instance gone) drops the cached bearer',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      srv.reset({ bearer: ['s404'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(sentinelOf(c).http_status).toBe(404)
      expect(c.exists('azure-bearer.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K13', title: 'a cached bearer bound to another endpoint is never handed back',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure({ endpoint: `${srv.base}/api/v1/instances/other/bearer` })
      srv.reset({ bearer: ['down'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(sentinelOf(c).message).toBe('network error reaching bearer endpoint')
    },
  },
  {
    id: 'K14', title: 'nothing cached + unreachable → fails loudly, no marker',
    run: async (c) => {
      c.seedAccess()
      srv.reset({ bearer: ['down'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/^TokenScope: emission auth FAILED \(could not reach/m)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K15', title: 'a state dir containing a space works for the mint and the fallback',
    run: async (c) => {
      const spaced = join(c.tmp, 'state dir')
      mkdirSync(spaced, { recursive: true })
      srv.reset({ expires: '1900000000' })
      expect((await c.run({ stateDir: spaced })).status).toBe(0)
      expect(c.json('azure-bearer.<tool>.json', undefined, spaced).expires_at).toBe(1900000000)
      srv.reset({ bearer: ['down'] })
      const r = await c.run({ stateDir: spaced })
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ Authorization: FRESH_BEARER })
      expect(strays(spaced)).toEqual([])
    },
  },
  {
    id: 'K16', title: 'the next clean mint clears the degraded marker',
    run: async (c) => {
      writeFileSync(c.file('emit-degraded.<tool>.json'), '{"ts":"x","reason":"earlier outage","expires_at":0}')
      expect((await c.run()).status).toBe(0)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(false)
    },
  },
  {
    id: 'K17', title: 'a 200 without an Authorization header is not handed to Claude Code', legs: ['ps1'],
    run: async (c) => {
      srv.reset({ bearer: ['noauth'] })
      const r = await c.run()
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
    },
  },
  {
    id: 'K18', title: '/bearer sends headers then trickles the body → given up at the deadline, the cached bearer',
    run: async (c) => {
      c.seedAccess()
      c.seedAzure()
      srv.reset({ bearer: ['slowbody'] })
      const t0 = Date.now()
      const r = await c.run()
      const elapsed = Date.now() - t0
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(`{"Authorization":"${CACHED_BEARER}"}\n`)
      expect(r.stderr).toMatch(/^TokenScope: emission auth DEGRADED/m)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(true)
      expect(srv.calls('bearer')).toHaveLength(1)
      expect(elapsed).toBeLessThan(SLOW_BODY_BOUND_MS)
    },
  },
  {
    id: 'K19', title: '/bearer trickles the body and nothing is cached → fails loudly at the deadline',
    run: async (c) => {
      c.seedAccess()
      srv.reset({ bearer: ['slowbody'] })
      const t0 = Date.now()
      const r = await c.run()
      const elapsed = Date.now() - t0
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toMatch(/^TokenScope: emission auth FAILED \(could not reach/m)
      expect(Number(sentinelOf(c).http_status)).toBe(0)
      expect(c.exists('emit-degraded.<tool>.json')).toBe(false)
      expect(elapsed).toBeLessThan(SLOW_BODY_BOUND_MS)
    },
  },

  // File hygiene
  {
    id: 'H1', title: 'no temp or header-dump files survive a mint, a fallback or a failure',
    run: async (c) => {
      expect((await c.run()).status).toBe(0)
      srv.reset({ bearer: ['down'] })
      await c.run()
      srv.reset({ token: 'dead' })
      rmSync(c.file('oauth-access.<tool>.json'), { force: true })
      await c.run()
      expect(strays(c.stateDir)).toEqual([])
    },
  },
  {
    id: 'H2', title: 'every file written is ASCII JSON ending in LF, with no BOM',
    run: async (c) => {
      srv.reset({ expires: '1900000000' })
      expect((await c.run()).status).toBe(0)
      srv.reset({ bearer: ['down'] })
      c.seedAzure({ expiresAt: 1000000000 })
      expect((await c.run()).status).toBe(0) // writes the marker and the sentinel
      const files = readdirSync(c.stateDir)
      expect(files.sort()).toEqual(['azure-bearer.claude-code.json', 'emit-degraded.claude-code.json', 'emit-failure.claude-code.json', 'oauth-access.claude-code.json'])
      for (const f of files) {
        const buf = readFileSync(join(c.stateDir, f))
        if (f.startsWith('azure-bearer')) continue // seeded by the test
        expect(buf[0], f).toBe(0x7b) // '{', not EF BB BF
        expect(buf[buf.length - 1], f).toBe(0x0a)
        expect(buf.subarray(0, buf.length - 1).includes(0x0a), f).toBe(false)
        JSON.parse(buf.toString('utf8'))
      }
    },
  },

  // PowerShell-specific
  {
    id: 'X1', title: 'the PSModulePath reset is the first statement, before any cmdlet', legs: ['ps1'],
    run: async (c) => {
      const lines = readFileSync(c.helper, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      expect(lines[0]).toBe("$env:PSModulePath = $PSHOME + [IO.Path]::DirectorySeparatorChar + 'Modules'")
      // Then PATH, on Windows (tests/unit/plugin/ps1-hardening.test.ts pins its text).
      expect(lines[1]).toMatch(/^if \(\[Environment\]::OSVersion\.Platform -eq \[PlatformID\]::Win32NT\) \{ \$env:PATH = /)
      expect(lines[2]).toBe('Set-StrictMode -Version Latest')
      expect(lines[3]).toBe("$ErrorActionPreference = 'Stop'")
    },
  },
  {
    id: 'X2', title: 'a repo-supplied PSModulePath cannot replace a cmdlet the helper runs (bites on 5.1; pwsh 7 resists by itself)',
    legs: ['ps1'],
    run: async (c) => {
      const mods = join(c.tmp, 'mods', 'Microsoft.PowerShell.Utility')
      mkdirSync(mods, { recursive: true })
      const marker = join(c.tmp, 'hijacked')
      writeFileSync(join(mods, 'Microsoft.PowerShell.Utility.psm1'),
        ['Add-Type', 'ConvertFrom-Json'].map((f) => `function ${f} { Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value x }\n`).join('') +
          'Export-ModuleMember -Function *\n')
      writeFileSync(join(mods, 'Microsoft.PowerShell.Utility.psd1'),
        "@{ ModuleVersion = '99.0'; RootModule = 'Microsoft.PowerShell.Utility.psm1'; FunctionsToExport = @('Add-Type', 'ConvertFrom-Json') }\n")
      const r = await c.run({ env: { PSModulePath: join(c.tmp, 'mods') } })
      expect(r.status).toBe(0)
      expect(existsSync(marker)).toBe(false)
    },
  },
  {
    id: 'X3', title: 'the script is pure ASCII (5.1 reads a BOM-less script as the ANSI code page)', legs: ['ps1'],
    run: async (c) => {
      const buf = readFileSync(c.helper)
      expect([...buf].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09))).toBe(-1)
    },
  },
]

// ── Mutations: the guard each scenario protects ───────────────────────────────────
// [find, replace] edits on a temp copy of the helper; the named scenario must FAIL.
type Edit = [string, string]
interface Mutation { id: string; scenario: string; leg: Leg; edits: Edit[]; only51?: boolean }
const M = (leg: Leg, scenario: string, id: string, ...edits: Edit[]): Mutation => ({ id, scenario, leg, edits })

const MUTATIONS: Mutation[] = [
  // ── sh ──
  M('sh', 'A1', 'accept unknown arguments', ['      echo "otel-headers-helper: unknown argument" >&2\n      exit 2', '      shift']),
  M('sh', 'A2', 'accept a relative --state-dir', ['        /*) STATE_DIR="$2" ;;', '        *) STATE_DIR="$2" ;;']),
  M('sh', 'A3', 'tolerate a missing --tool value', ['[ $# -ge 2 ] || { echo "otel-headers-helper: --tool requires a value" >&2; exit 2; }', '[ $# -ge 2 ] || { TOOL=claude-code; shift; continue; }']),
  M('sh', 'A4', 'accept any --tool', ['        claude-code|copilot-cli) TOOL="$2" ;;', '        *) TOOL="$2" ;;']),
  M('sh', 'A6', 'state dir from TOKENSCOPE_STATE_DIR', ['[ -n "$STATE_DIR" ] || STATE_DIR="$(passwd_home)/.tokenscope"', '[ -n "$STATE_DIR" ] || STATE_DIR="${TOKENSCOPE_STATE_DIR}"']),
  M('sh', 'S1', 'environment fills the store\'s destinations', ['  adopt_source "$_s_tok" "$_s_bear" "$_s_tok_ep" "$_s_cid"', '  adopt_source "$_s_tok" "${TOKENSCOPE_BEARER_ENDPOINT:-$_s_bear}" "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT:-$_s_tok_ep}" "$_s_cid"']),
  M('sh', 'S2', 'no store tool check', ['if [ -n "$_s_tool" ] && [ "$_s_tool" != "$TOOL" ]; then', 'if false; then']),
  M('sh', 'S3', 'no store marker check', ['if [ -n "$_s_attr_tool" ] && [ "$_s_attr_tool" != "$TOOL" ]; then', 'if false; then']),
  M('sh', 'S4', 'no store completeness check', ['if [ -z "$_s_tok" ] || [ -z "$_s_bear" ] || [ -z "$_s_tok_ep" ]; then', 'if false; then']),
  M('sh', 'S5', 'no version check', ['if [ "$_s_ver" != "2" ] || ', 'if ']),
  M('sh', 'S6', 'no attribute instance check', [' || [ "$_s_attr_inst" != "$_s_inst" ]; then', '; then']),
  M('sh', 'S7', 'no bearer instance check', ['if [ -z "$_s_bear_inst" ] || [ "$_s_bear_inst" != "$_s_inst" ]; then', 'if false; then']),
  M('sh', 'S8', 'one shared access cache', ['ACCESS_CACHE="${STATE_DIR}/oauth-access.${TOOL}.json"', 'ACCESS_CACHE="${STATE_DIR}/oauth-access.claude-code.json"']),
  M('sh', 'G1', 'settings source skipped', ['  _gs_file="$(passwd_home)/.claude/settings.json"', '  _gs_file="/nonexistent/settings.json"']),
  M('sh', 'G2', 'settings credential without endpoints accepted', ['if [ -z "$_gs_bear" ] || [ -z "$_gs_tok_ep" ]; then', 'if false; then']),
  M('sh', 'G3', 'unusable trusted source falls through to env', ['[ "$TRUSTED_SEEN_UNUSABLE" -eq 1 ] && [ -n', 'false && [ -n']),
  M('sh', 'G4', 'an env block without the key counts as unusable', ["        *'\"env\"'*) : ;;", "        *'\"env\"'*) TRUSTED_SEEN_UNUSABLE=1 ;;"]),
  M('sh', 'G5', 'look-alike falls through to env', ['[ "$TRUSTED_SEEN_UNUSABLE" -eq 1 ] && [ -n', 'false && [ -n'], ['      if [ -z "$_gs_bear" ] || [ -z "$_gs_tok_ep" ]; then', '      if false; then'], ['      adopt_source "$_gs_tok" "$_gs_bear" "$_gs_tok_ep" "$_gs_cid"', '      :']),
  M('sh', 'G6', 'settings endpoints borrowed from env', ['      adopt_source "$_gs_tok" "$_gs_bear" "$_gs_tok_ep" "$_gs_cid"', '      adopt_source "$_gs_tok" "${TOKENSCOPE_BEARER_ENDPOINT:-$_gs_bear}" "${TOKENSCOPE_OAUTH_TOKEN_ENDPOINT:-$_gs_tok_ep}" "$_gs_cid"']),
  M('sh', 'E1', 'env source ignored', ['if [ -z "${TOKENSCOPE_BEARER_ENDPOINT:-}" ]; then', 'TOKENSCOPE_BEARER_ENDPOINT=""\nif [ -z "${TOKENSCOPE_BEARER_ENDPOINT:-}" ]; then']),
  M('sh', 'E2', 'unconfigured passes silently', ['  write_sentinel 0 "TOKENSCOPE_BEARER_ENDPOINT not set"\n  exit 1', '  exit 1']),
  M('sh', 'P1', 'http off-box allowed', ['    https://*) return 0 ;;', '    *) return 0 ;;']),
  M('sh', 'P2', 'leading dash allowed', ['    -*)\n      echo "TokenScope: emission auth FAILED (${_label} must not start', '    --never-matches--*)\n      echo "TokenScope: emission auth FAILED (${_label} must not start']),
  M('sh', 'P3', 'unbindable endpoint allowed', ['if [ "$_bindable" != "$TOKENSCOPE_BEARER_ENDPOINT" ]; then', 'if false; then']),
  M('sh', 'P4', 'token endpoint unchecked', ['assert_safe_endpoint "$TOKENSCOPE_OAUTH_TOKEN_ENDPOINT" "TOKENSCOPE_OAUTH_TOKEN_ENDPOINT"', ':']),
  M('sh', 'R1', 'refresh follows redirects', ['      -X POST \\', '      -L -X POST \\']),
  M('sh', 'R2', '/bearer follows redirects', ['      -H @- \\', '      -L -H @- \\']),
  M('sh', 'C1', 'access cache never written', ['      mv -f "$_tmp_cache" "$ACCESS_CACHE" 2>/dev/null || rm -f "$_tmp_cache" 2>/dev/null', '      rm -f "$_tmp_cache" 2>/dev/null']),
  M('sh', 'C2', 'cache not bound to endpoint', [' \\\n    || [ "$(json_str "$_cache" bearer_endpoint)" != "$_cache_bear_now" ]; then', '; then']),
  M('sh', 'C3', 'no expiry skew', ['EXPIRY_SKEW=120', 'EXPIRY_SKEW=0']),
  M('sh', 'C4', 'refresh error not recorded', ['  write_sentinel "$TOK_STATUS" "oauth refresh failed: ${_err}"', '  write_sentinel "$TOK_STATUS" "oauth refresh failed"']),
  M('sh', 'C5', 'missing access_token accepted', ['  if [ -z "$_new_access" ]; then', '  if false; then']),
  M('sh', 'C6', 'refresh token not percent-encoded', ['refresh_token=$(urlencode "${TOKENSCOPE_OAUTH_REFRESH_TOKEN}")', 'refresh_token=${TOKENSCOPE_OAUTH_REFRESH_TOKEN}']),
  M('sh', 'V1', 'no plugin version header', ['  VERSION_HEADER_ARGS="-H X-TokenScope-Plugin-Version:${PLUGIN_VERSION}"', '  VERSION_HEADER_ARGS=""']),
  M('sh', 'V2', 'no AI_AGENT fallback', ["    CLI_VERSION=\"$(printf '%s' \"${AI_AGENT:-}\"", "    CLI_VERSION=\"$(printf '%s' \"\""]),
  ...(SH_HAS_412
    ? [
        M('sh', 'V3', 'no platform header', ['CLIENT_PLATFORM="$(safe_version "$CLIENT_PLATFORM")"', 'CLIENT_PLATFORM=""']),
        M('sh', 'V4', 'surface unsanitised', ['CLIENT_SURFACE="$(safe_version "$CLIENT_SURFACE")"', 'CLIENT_SURFACE="$(printf %s "$CLIENT_SURFACE" | tr -d \' "\')"']),
        M('sh', 'V5', 'copilot surface defaults to cli', ['      github_copilot*) CLIENT_SURFACE=cli ;;', '      *) CLIENT_SURFACE=cli ;;']),
      ]
    : []),
  M('sh', 'B1', 'no self-heal', ['if [ "$USED_CACHE" = 1 ] && {', 'if false && {']),
  M('sh', 'B2', 'statusMessage ignored', ['SERVER_MSG="$(json_str "$BODY" statusMessage)"', 'SERVER_MSG=""']),
  M('sh', 'B3', 'detail ignored', ['[ -z "$SERVER_MSG" ] && SERVER_MSG="$(json_str "$BODY" detail)"', ':']),
  M('sh', 'O1', 'sentinel not cleared on success', ['    clear_sentinel\n    printf \'%s\\n\' "$BODY"', '    printf \'%s\\n\' "$BODY"']),
  M('sh', 'O2', 'sentinel message unsanitised', ["  _msg_safe=\"$(printf '%s' \"$_msg\" | tr -d '\"\\\\\\n\\r' | cut -c1-300)\"", '  _msg_safe="$_msg"']),
  M('sh', 'O3', 'refresh token in the refusal message', ['    echo "TokenScope: emission auth FAILED (could not reach ${TOKENSCOPE_BEARER_ENDPOINT})', '    echo "TokenScope: emission auth FAILED (could not reach ${TOKENSCOPE_BEARER_ENDPOINT} ${TOKENSCOPE_OAUTH_REFRESH_TOKEN})']),
  M('sh', 'K1', 'bearer not cached', ['    write_azure_cache "$BODY" "$BEARER_EXPIRES_AT"', '    :']),
  M('sh', 'K2', 'missing expiry not normalised', ["  case \"$_az_exp\" in '' | *[!0-9]*) _az_exp=0 ;; esac", "  case \"$_az_exp\" in '' | *[!0-9]*) _az_exp=1 ;; esac"]),
  M('sh', 'K3', 'no fallback when unreachable', ['    try_cached_bearer "could not reach ${TOKENSCOPE_BEARER_ENDPOINT}" || true', '    true']),
  M('sh', 'K4', 'no fallback on 5xx/408/429', ['    try_cached_bearer "bearer endpoint HTTP ${HTTP_STATUS}" || true', '    true']),
  M('sh', 'K5', 'no fallback when the token endpoint is down', ['        try_cached_bearer "OAuth token endpoint HTTP ${TOK_STATUS}" || true', '        true']),
  M('sh', 'K6', 'expired cache keeps health green', ['  if [ "$_tc_expired" = 1 ]; then', '  if false; then']),
  M('sh', 'K7', '401 keeps the cached bearer', ['    rm -f "$ACCESS_CACHE" 2>/dev/null\n    drop_azure_cache\n    clear_degraded\n    SERVER_MSG', '    rm -f "$ACCESS_CACHE" 2>/dev/null\n    clear_degraded\n    SERVER_MSG']),
  M('sh', 'K8', 'verdict does not disable the fallback', ['  if [ "${VERDICT_SEEN:-0}" = 1 ]; then return 1; fi', ''], ['  VERDICT_SEEN=1\n  drop_azure_cache', '  VERDICT_SEEN=1']),
  M('sh', 'K9', 'verdict does not disable the fallback (retry)', ['  if [ "${VERDICT_SEEN:-0}" = 1 ]; then return 1; fi', ''], ['  VERDICT_SEEN=1\n  drop_azure_cache', '  VERDICT_SEEN=1']),
  M('sh', 'K10', 'self-heal retry result not cached', ['    write_azure_cache "$BODY" "$BEARER_EXPIRES_AT"', '    [ "$USED_CACHE" = 1 ] || write_azure_cache "$BODY" "$BEARER_EXPIRES_AT"']),
  M('sh', 'K11', 'invalid_grant keeps the cached bearer', ['        drop_azure_cache\n        clear_degraded\n        ;;', '        clear_degraded\n        ;;']),
  M('sh', 'K12', '404 keeps the cached bearer', ['    # verdict, not weather — the cached bearer must not outlive it.\n    drop_azure_cache', '    # verdict, not weather — the cached bearer must not outlive it.']),
  M('sh', 'K13', 'cached bearer not bound to endpoint', ['  [ "$(json_str "$_tc" bearer_endpoint)" = "$_tc_bear_now" ] || return 1', '']),
  M('sh', 'K14', 'unreachable without cache is silent', ['    write_sentinel 0 "network error reaching bearer endpoint"\n    exit 1', '    exit 0']),
  M('sh', 'K15', 'header dump breaks on a space', ['${_hdr:+-D "$_hdr"}', '${_hdr:+-D $_hdr}']),
  M('sh', 'K16', 'clean mint keeps the marker', ['    clear_degraded\n    clear_sentinel\n    printf', '    clear_sentinel\n    printf']),
  M('sh', 'K18', 'deadline raised to 20 s', ["printf 'Authorization: Bearer %s\\n' \"$AUTH_TOKEN\" | curl -q -s --connect-timeout 5 --max-time 10", "printf 'Authorization: Bearer %s\\n' \"$AUTH_TOKEN\" | curl -q -s --connect-timeout 5 --max-time 20"]),
  M('sh', 'K19', 'deadline raised to 20 s', ["printf 'Authorization: Bearer %s\\n' \"$AUTH_TOKEN\" | curl -q -s --connect-timeout 5 --max-time 10", "printf 'Authorization: Bearer %s\\n' \"$AUTH_TOKEN\" | curl -q -s --connect-timeout 5 --max-time 20"]),
  M('sh', 'H1', 'header dump left behind', ['    rm -f "$_hdr" 2>/dev/null', '    :']),
  M('sh', 'H2', 'files without a trailing LF', ["    if printf '%s\\n' \"$2\" >\"$_wpj_tmp\" 2>/dev/null; then", "    if printf '%s' \"$2\" >\"$_wpj_tmp\" 2>/dev/null; then"]),

  // ── ps1 ──
  M('ps1', 'A1', 'accept unknown arguments', ["  Write-Err 'otel-headers-helper: unknown argument'\n  exit 2", '  $i += 1']),
  M('ps1', 'A2', 'accept a relative --state-dir', ['if (-not (Test-AbsolutePath $v)) {', 'if ($false) {']),
  M('ps1', 'A3', 'tolerate a missing value', ['if ($i + 1 -ge $args.Count) { Write-Err "otel-headers-helper: $a requires a value"; exit 2 }', 'if ($i + 1 -ge $args.Count) { break }']),
  M('ps1', 'A4', 'accept any --tool', ["if ($v -cne 'claude-code' -and $v -cne 'copilot-cli') {", 'if ($false) {']),
  M('ps1', 'A5', 'accept --tool-dir', ["  Write-Err 'otel-headers-helper: unknown argument'\n  exit 2", '  $i += 2']),
  M('ps1', 'A6', 'state dir from TOKENSCOPE_STATE_DIR', ["  $StateDir = [IO.Path]::Combine($ProfileDir, '.tokenscope')", '  $StateDir = [string]$env:TOKENSCOPE_STATE_DIR']),
  M('ps1', 'S1', 'environment fills the store\'s destinations', ['  Set-Source $sTok $sBear $sTokEp $sCid', '  Set-Source $sTok ([string]$env:TOKENSCOPE_BEARER_ENDPOINT) ([string]$env:TOKENSCOPE_OAUTH_TOKEN_ENDPOINT) $sCid']),
  M('ps1', 'S2', 'no store tool check', ["if ($sTool -ne '' -and $sTool -cne $Tool) {", 'if ($false) {']),
  M('ps1', 'S3', 'no store marker check', ["if ($sAttrTool -ne '' -and $sAttrTool -cne $Tool) {", 'if ($false) {']),
  M('ps1', 'S4', 'no store completeness check', ["if ($sTok -eq '' -or $sBear -eq '' -or $sTokEp -eq '') {", 'if ($false) {']),
  M('ps1', 'S5', 'no version check', ['if ($null -eq $sVer -or $sVer -ne 2 -or ', 'if (']),
  M('ps1', 'S6', 'no attribute instance check', [" -or $sAttrInst -cne $sInst) {", ') {']),
  M('ps1', 'S7', 'no bearer instance check', ["if ($sBearInst -eq '' -or $sBearInst -cne $sInst) {", 'if ($false) {']),
  M('ps1', 'S8', 'one shared access cache', ['$AccessCache = [IO.Path]::Combine($StateDir, "oauth-access.$Tool.json")', '$AccessCache = [IO.Path]::Combine($StateDir, "oauth-access.claude-code.json")']),
  M('ps1', 'G1', 'settings source skipped', ["  $gsFile = [IO.Path]::Combine($ProfileDir, '.claude', 'settings.json')", "  $gsFile = '/nonexistent/settings.json'"]),
  M('ps1', 'G2', 'settings credential without endpoints accepted', ["if ($gsBear -eq '' -or $gsTokEp -eq '') {", 'if ($false) {']),
  M('ps1', 'G3', 'unusable trusted source falls through to env', ["if (-not $Resolved -and $TrustedSeenUnusable -and $envTok -ne '') {", 'if ($false) {']),
  M('ps1', 'G4', 'an env block without the key counts as unusable', ["      if (-not ($gsEnv -is [System.Management.Automation.PSCustomObject]) -or $gsText.Contains('TOKENSCOPE_OAUTH_REFRESH_TOKEN')) {", '      if ($true) {']),
  M('ps1', 'G5', 'look-alike falls through to env', ["if (-not $Resolved -and $TrustedSeenUnusable -and $envTok -ne '') {", 'if ($false) {']),
  M('ps1', 'G6', 'settings endpoints borrowed from env', ["      Set-Source $gsTok $gsBear $gsTokEp (Get-JsonStr $gsEnv 'TOKENSCOPE_OAUTH_CLIENT_ID')", "      Set-Source $gsTok ([string]$env:TOKENSCOPE_BEARER_ENDPOINT) ([string]$env:TOKENSCOPE_OAUTH_TOKEN_ENDPOINT) ''"]),
  M('ps1', 'E1', 'env source ignored', ['  $RefreshToken = $envTok', "  $RefreshToken = ''"]),
  M('ps1', 'E2', 'unconfigured passes silently', ["    Write-Sentinel 0 'TOKENSCOPE_BEARER_ENDPOINT not set'\n    exit 1", '    exit 1']),
  M('ps1', 'P1', 'http off-box allowed', ["if ($ok -and $Ep.StartsWith('https://', [StringComparison]::Ordinal) -and $uri.Scheme -ceq 'https') { return }", 'if ($ok) { return }']),
  M('ps1', 'P2', 'leading dash allowed', ["if ($Ep.StartsWith('-', [StringComparison]::Ordinal)) {", 'if ($false) {']),
  M('ps1', 'P3', 'unbindable endpoint allowed', ['  if ((Remove-Unbindable $BearerEp) -cne $BearerEp) {', '  if ($false) {']),
  M('ps1', 'P4', 'token endpoint unchecked', ["  Assert-SafeEndpoint $TokenEp 'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT'", '']),
  M('ps1', 'P5', 'loopback by prefix only', ["$uri.IsLoopback -and $uri.UserInfo -eq '' -and", '']),
  M('ps1', 'R1', 'redirects followed', ['$handler.AllowAutoRedirect = $false', '$handler.AllowAutoRedirect = $true']),
  M('ps1', 'R2', 'redirects followed', ['$handler.AllowAutoRedirect = $false', '$handler.AllowAutoRedirect = $true']),
  M('ps1', 'C1', 'access cache never written', ['$ok = Write-PrivateJson $AccessCache (', "$ok = Write-PrivateJson ($AccessCache + '.off') ("]),
  M('ps1', 'C2', 'cache not bound to endpoint', ["(Get-JsonStr $ac 'bearer_endpoint') -ceq $BearerEp -and ", '']),
  M('ps1', 'C3', 'no expiry skew', ['$ExpirySkew = 120', '$ExpirySkew = 0']),
  M('ps1', 'C4', 'refresh error not recorded', ['    Write-Sentinel $st "oauth refresh failed: $err"', '    Write-Sentinel $st "oauth refresh failed"']),
  M('ps1', 'C5', 'missing access_token accepted', ["  if ($access -eq '') {", '  if ($false) {']),
  M('ps1', 'C6', 'refresh token not percent-encoded', ['[Uri]::EscapeDataString($script:RefreshToken)', '$script:RefreshToken']),
  M('ps1', 'V1', 'no plugin version header', ["$h['X-TokenScope-Plugin-Version'] = $PluginVersion", '$null = $PluginVersion']),
  M('ps1', 'V2', 'no AI_AGENT fallback', ['[regex]::Match([string]$env:AI_AGENT,', "[regex]::Match('',"]),
  M('ps1', 'V3', 'no platform header', ["  if ($ClientPlatform -ne '') { $h['X-TokenScope-Client-Platform'] = $ClientPlatform }", '']),
  M('ps1', 'V4', 'surface unsanitised', ['$ClientSurface = Get-SafeVersion $ClientSurface', "$ClientSurface = $ClientSurface -replace '[ \"]', ''"]),
  M('ps1', 'V5', 'copilot surface defaults to cli', ["  elseif ($agent.StartsWith('github_copilot', [StringComparison]::Ordinal)) { $ClientSurface = 'cli' }", "  else { $ClientSurface = 'cli' }"]),
  M('ps1', 'B1', 'no self-heal', ['if ($usedCache -and ($resp.Status -eq 401 -or $resp.Status -eq 403)) {', 'if ($false) {']),
  M('ps1', 'B2', 'statusMessage ignored', ["$msg = Get-JsonStr $body 'statusMessage'", "$msg = ''"]),
  M('ps1', 'B3', 'detail ignored', ["if ($msg -eq '') { $msg = Get-JsonStr $body 'detail' }", '']),
  M('ps1', 'O1', 'CRLF on stdout', ['[Console]::Out.Write($Json + "`n")', '[Console]::Out.Write($Json + "`r`n")']),
  M('ps1', 'O1', 'sentinel not cleared on success', ['    Clear-Sentinel\n    Write-HeaderAndExit', '    Write-HeaderAndExit']),
  M('ps1', 'O2', 'sentinel message unsanitised', ['  $m = Remove-Unbindable $Message', '  $m = $Message']),
  M('ps1', 'O3', 'refresh token in the refusal message', ['Write-Err "TokenScope: emission auth FAILED (could not reach $BearerEp)', 'Write-Err "TokenScope: emission auth FAILED (could not reach $BearerEp $RefreshToken)']),
  M('ps1', 'K1', 'bearer not cached', ["    Write-AzureCache $auth (Get-ResponseHeader $resp.Headers 'X-TokenScope-Bearer-Expires-At')", '    $null = $auth']),
  M('ps1', 'K2', 'missing expiry not normalised', ['  $exp = 0\n  if ($ExpiresAt', '  $exp = 1\n  if ($ExpiresAt']),
  M('ps1', 'K3', 'no fallback when unreachable', ['    Use-CachedBearer "could not reach $BearerEp"', '    $null = 0']),
  M('ps1', 'K4', 'no fallback on 5xx/408/429', ['    Use-CachedBearer "bearer endpoint HTTP $st"', '    $null = 0']),
  M('ps1', 'K5', 'no fallback when the token endpoint is down', ["      Use-CachedBearer ('OAuth token endpoint HTTP ' + (Format-Status $st))", '      $null = 0']),
  M('ps1', 'K6', 'expired cache keeps health green', ['  if ($expired) {\n    Write-Sentinel 0', '  if ($false) {\n    Write-Sentinel 0']),
  M('ps1', 'K7', '401 keeps the cached bearer', ['    Remove-QuietFile $AccessCache\n    Remove-AzureCache\n    Clear-Degraded\n    $msg', '    Remove-QuietFile $AccessCache\n    Clear-Degraded\n    $msg']),
  M('ps1', 'K8', 'verdict does not disable the fallback', ['  if ($script:VerdictSeen) { return }', ''], ['    $VerdictSeen = $true\n    Remove-AzureCache', '    $VerdictSeen = $true']),
  M('ps1', 'K9', 'verdict does not disable the fallback (retry)', ['  if ($script:VerdictSeen) { return }', ''], ['    $VerdictSeen = $true\n    Remove-AzureCache', '    $VerdictSeen = $true']),
  M('ps1', 'K10', 'self-heal retry result not cached', ["    Write-AzureCache $auth (Get-ResponseHeader", "    if (-not $usedCache) { Write-AzureCache $auth (Get-ResponseHeader"], ["'X-TokenScope-Bearer-Expires-At')\n    Clear-Degraded", "'X-TokenScope-Bearer-Expires-At') }\n    Clear-Degraded"]),
  M('ps1', 'K11', 'invalid_grant keeps the cached bearer', ['    } else {\n      Remove-AzureCache\n      Clear-Degraded\n    }', '    } else {\n      Clear-Degraded\n    }']),
  M('ps1', 'K12', '404 keeps the cached bearer', ['  # Any other status (3xx, 400, 404, 410): a verdict, not weather.\n  Remove-AzureCache', '  # Any other status (3xx, 400, 404, 410): a verdict, not weather.']),
  M('ps1', 'K13', 'cached bearer not bound to endpoint', ["  if ((Get-JsonStr $c 'bearer_endpoint') -cne $ep) { return }", '']),
  M('ps1', 'K14', 'unreachable without cache is silent', ["    Write-Sentinel 0 'network error reaching bearer endpoint'\n    exit 1", '    exit 0']),
  M('ps1', 'K15', 'temp names break on a space', ["$tmp = $Path + '.tmp.' + ([IO.Path]::GetRandomFileName() -replace '\\.', '')", "$tmp = $Path.Replace(' ', '/') + '.tmp.' + ([IO.Path]::GetRandomFileName() -replace '\\.', '')"]),
  M('ps1', 'K16', 'clean mint keeps the marker', ['    Clear-Degraded\n    Clear-Sentinel\n    Write-HeaderAndExit', '    Clear-Sentinel\n    Write-HeaderAndExit']),
  M('ps1', 'K17', 'body handed back without an Authorization', ["    if ($auth -eq '') {\n      Write-Err 'TokenScope: emission auth FAILED (bearer endpoint returned no Authorization)", "    if ($false) {\n      Write-Err 'TokenScope: emission auth FAILED (bearer endpoint returned no Authorization)"]),
  M('ps1', 'K18', 'deadline raised to 20 s', ['$HttpDeadlineMs = 10000', '$HttpDeadlineMs = 20000']),
  // The 5.1 Invoke-WebRequest shape: the deadline covers the headers, not the body.
  M('ps1', 'K18', 'deadline covers the headers only',
    ['[System.Net.Http.HttpCompletionOption]::ResponseContentRead', '[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead'],
    ['if (-not $read.Wait([int][Math]::Max(0, $HttpDeadlineMs - $sw.ElapsedMilliseconds))) { return $r }', 'if (-not $read.Wait(-1)) { return $r }']),
  M('ps1', 'K19', 'deadline raised to 20 s', ['$HttpDeadlineMs = 10000', '$HttpDeadlineMs = 20000']),
  M('ps1', 'H1', 'temp files left behind', ['if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) }\n        else { [IO.File]::Move($tmp, $Path) }', 'if ([IO.File]::Exists($Path)) { [IO.File]::Copy($tmp, $Path, $true) }\n        else { [IO.File]::Copy($tmp, $Path) }'], ['  finally { Remove-QuietFile $tmp }', '  finally { }']),
  M('ps1', 'H2', 'files written with a BOM', ["(New-Object Text.UTF8Encoding $false)", "(New-Object Text.UTF8Encoding $true)"]),
  M('ps1', 'X1', 'PSModulePath not reset', ["$env:PSModulePath = $PSHOME + [IO.Path]::DirectorySeparatorChar + 'Modules'\n", '']),
  // Equivalent under pwsh 7 (see header); runs, and must bite, on Windows PowerShell 5.1.
  // X2 has NO mutation, deliberately: see the header note. The scenario stays as
  // a behavioural regression check (the hostile module must never win); the
  // guards it would pin are pinned statically by X1 and ps1-hardening.test.ts.
  M('ps1', 'X3', 'non-ASCII in the script', ['# otelHeadersHelper for Windows', '# otelHeadersHelper for Windows \u2014']),
]

// ── Legs ────────────────────────────────────────────────────────────────────────
const LEGS: { leg: Leg; skip: boolean; unavailable?: string }[] = [
  { leg: 'sh', skip: SKIP_SH },
  {
    leg: 'ps1',
    skip: SKIP_PWSH,
    unavailable: PWSH_OK ? undefined : `${PWSH} not found or not runnable (${pwshProbe?.error?.message ?? `exit ${pwshProbe?.status}`}). Install PowerShell 7 or set TOKENSCOPE_SKIP_PWSH=1.`,
  },
]

const appliesTo = (s: Scenario, leg: Leg) => !s.legs || s.legs.includes(leg)
const skipOnThisHost = (s: Scenario, leg: Leg) => leg === 'ps1' && IS_WIN && !!s.needsProfile

async function runScenario(s: Scenario, leg: Leg, helper: string) {
  srv.reset()
  const c = new Ctx(leg, helper)
  try {
    await s.run(c)
  } finally {
    c.cleanup()
  }
}

for (const { leg, skip, unavailable } of LEGS) {
  const d = skip ? describe.skip : describe
  d(`otel-headers-helper conformance — ${leg}`, () => {
    if (unavailable) {
      it(`${leg} leg: PowerShell is available`, () => {
        throw new Error(`pwsh not found: ${unavailable}`)
      })
      return
    }
    for (const s of S.filter((x) => appliesTo(x, leg))) {
      const t = skipOnThisHost(s, leg) ? it.skip : it
      t(`${s.id}: ${s.title}`, () => runScenario(s, leg, HELPERS[leg]), RUN_TIMEOUT_MS)
    }
  })
}

// Both helpers on ONE state dir: a device can switch helpers without re-enrolling.
const bothAvailable = !SKIP_SH && !SKIP_PWSH && PWSH_OK
;(bothAvailable ? describe : describe.skip)('otel-headers-helper conformance — sh <-> ps1 share one store', () => {
  it('each helper reuses the access cache and the cached Azure bearer the other wrote', async () => {
    for (const [first, second] of [['sh', 'ps1'], ['ps1', 'sh']] as [Leg, Leg][]) {
      srv.reset({ expires: '1900000000' })
      const a = new Ctx(first, HELPERS[first])
      const b = new Ctx(second, HELPERS[second])
      try {
        a.seedStore()
        expect((await a.run({ envSource: 'none' })).status).toBe(0)
        expect(srv.calls('token')).toHaveLength(1)
        srv.reset({ bearer: ['ok', 'down'] })
        const r1 = await b.run({ stateDir: a.stateDir, envSource: 'none' })
        expect(r1.status).toBe(0)
        expect(srv.calls('token')).toHaveLength(0) // the other helper's access cache was presented
        const r2 = await b.run({ stateDir: a.stateDir, envSource: 'none' })
        expect(r2.status).toBe(0)
        expect(JSON.parse(r2.stdout)).toEqual({ Authorization: FRESH_BEARER })
        expect(a.exists('emit-degraded.<tool>.json')).toBe(true)
      } finally {
        a.cleanup()
        b.cleanup()
      }
    }
  }, RUN_TIMEOUT_MS * 2)
})

// ── Mutation run ────────────────────────────────────────────────────────────────
// A temp copy of the helper laid out like the plugin (scripts/ beside
// .claude-plugin/plugin.json) so the version-header scenario still finds a manifest.
function mutatedCopy(dir: string, m: Mutation): string {
  // LF-normalised: the anchors are written with \n, and a checkout that ignored
  // .gitattributes (eol=lf) would otherwise turn every mutation into a loud
  // "occurs 0 times" rather than a test of the guard.
  let text = readFileSync(HELPERS[m.leg], 'utf8').replace(/\r\n/g, '\n')
  for (const [find, replace] of m.edits) {
    const n = text.split(find).length - 1
    if (n !== 1) throw new Error(`mutation ${m.leg}/${m.scenario} "${m.id}": find text occurs ${n} times (must be exactly 1): ${JSON.stringify(find)}`)
    text = text.replace(find, () => replace)
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  copyFileSync(PLUGIN_MANIFEST, join(dir, '.claude-plugin', 'plugin.json'))
  const out = join(dir, 'scripts', basename(HELPERS[m.leg]))
  writeFileSync(out, text)
  return out
}

// Scenarios with no mutation that can fail on any interpreter we run, each with
// the evidence. Adding to this set needs the same: a guard you cannot break
// observably is pinned statically, not by a mutant that always passes.
const NO_OBSERVABLE_MUTATION = new Set(['ps1/X2'])

describe('otel-headers-helper conformance — mutation list is complete', () => {
  it('every scenario has a mutation for every leg it runs on', () => {
    const missing: string[] = []
    for (const s of S) for (const leg of ['sh', 'ps1'] as Leg[]) {
      if (NO_OBSERVABLE_MUTATION.has(`${leg}/${s.id}`)) continue
      if (appliesTo(s, leg) && !MUTATIONS.some((m) => m.leg === leg && m.scenario === s.id)) missing.push(`${leg}/${s.id}`)
    }
    expect(missing).toEqual([])
    for (const m of MUTATIONS) expect(S.some((s) => s.id === m.scenario && appliesTo(s, m.leg)), `${m.leg}/${m.scenario}`).toBe(true)
  })

  // A mutant that does not even parse fails every scenario, which would make
  // its "the scenario fails" result vacuous. Each copy must still parse.
  it('every mutated copy still parses (no vacuous syntax-error mutants)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-conf-parse-'))
    try {
      const ps1: string[] = []
      MUTATIONS.forEach((m, i) => {
        const p = mutatedCopy(join(dir, String(i)), m)
        if (m.leg === 'sh' && !SKIP_SH) {
          const r = spawnSync('sh', ['-n', p], { encoding: 'utf8' })
          expect(r.status, `sh/${m.scenario} "${m.id}": ${r.stderr}`).toBe(0)
        }
        if (m.leg === 'ps1') ps1.push(p)
      })
      if (!SKIP_PWSH && PWSH_OK && ps1.length) {
        const list = join(dir, 'ps1-list.txt')
        writeFileSync(list, ps1.join('\n'))
        const script = [
          `$bad = @()`,
          `foreach ($p in [IO.File]::ReadAllLines('${list.replace(/'/g, "''")}')) {`,
          `  $e = $null; $t = $null`,
          `  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e)`,
          `  if ($e -and $e.Count) { $bad += $p + ': ' + $e[0].Message }`,
          `}`,
          `$bad -join [Environment]::NewLine`,
        ].join('\n')
        const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout.trim()).toBe('')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, RUN_TIMEOUT_MS)
})

for (const { leg, skip, unavailable } of LEGS) {
  const d = skip || unavailable ? describe.skip : describe
  d(`otel-headers-helper conformance — mutations (${leg}): each guard's removal fails its scenario`, () => {
    for (const m of MUTATIONS.filter((x) => x.leg === leg)) {
      const s = S.find((x) => x.id === m.scenario)!
      const t = skipOnThisHost(s, leg) || (m.only51 && PS_MAJOR !== 5) ? it.skip : it
      t(`${m.scenario} fails when: ${m.id}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), `ts-conf-mut-${leg}-`))
        try {
          const helper = mutatedCopy(dir, m)
          let failed = false
          try {
            await runScenario(s, leg, helper)
          } catch {
            failed = true
          }
          expect(failed, `scenario ${s.id} still passes with "${m.id}" applied: the test does not pin its guard`).toBe(true)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }, RUN_TIMEOUT_MS)
    }
  })
}
