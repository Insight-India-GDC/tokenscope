/*
 * claude-redeem.ps1 / device-id.ps1 — the Windows-without-Node setup lane
 * (#408 S3) must leave a device in the SAME state the Node redeem does.
 *
 * Each case runs the Node redeem and the PowerShell redeem, one after the other,
 * against the same stub /setup/redeem server, in the same freshly seeded
 * directory, and compares what they wrote BYTE FOR BYTE. The only permitted
 * difference is the platform: the PowerShell lane records `platform: 'win32'`
 * and writes the PowerShell form of `otelHeadersHelper`, which this test builds
 * with env-builder's own buildHelperCommand rather than restating it.
 *
 * Refusals are compared the same way: same exit code, same files (untouched),
 * and the same answer to "was the handoff code spent" (did the stub see a POST).
 *
 * Runs the .ps1 under `pwsh` (PowerShell 7 on Linux; the script is written to
 * Windows PowerShell 5.1). Without pwsh this FAILS rather than skipping, unless
 * TOKENSCOPE_SKIP_PWSH=1 says so explicitly (same rule as the helper's
 * conformance suite).
 *
 * Fixtures live under the account's real home: --settings-path and --state-dir
 * are confined to it in both lanes, and every run passes both. Every run also
 * makes the case dir the account home for both lanes (fake-home preload for
 * Node, HOME for pwsh), because the default store's isolated settings index is
 * written to `<home>/.tokenscope` whatever the argv says; so neither lane ever
 * touches the real ~/.claude or ~/.tokenscope.
 *
 * WINDOWS (CI runs this under Windows PowerShell 5.1). GetFolderPath('UserProfile')
 * ignores HOME there, so the PowerShell lane's profile cannot be redirected and
 * the Node lane keeps the real profile too, to stay comparable. Every redeem
 * case's fixtures then live in a unique subdirectory of the REAL profile, and
 * the default store's isolated index is the real profile's. That is allowed
 * ONLY on an ephemeral GitHub Actions runner (CI=true and GITHUB_ACTIONS=true);
 * on a developer's Windows machine those cases skip with a logged reason, and
 * nothing is written to the profile. Even on CI, the cases that would write the
 * profile's OWN files (its .claude/settings.json, its default store) skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { join, parse, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { writeFakeHomePreload, fakeHomeNode, realIsolatedIndex } from './helpers/fake-home'
import { resolvePwsh } from './helpers/shells'
const { realHome } = await import('../../../plugin/scripts/real-home.mjs')
const { buildHelperCommand } = await import('../../../plugin/scripts/env-builder.mjs')
const { mergeDesktopAttrs } = await import('../../../plugin/scripts/desktop-env.mjs')

const SCRIPTS = join(process.cwd(), 'plugin/scripts')
const NODE_REDEEM = join(SCRIPTS, 'claude-redeem.mjs')
const PS_REDEEM = join(SCRIPTS, 'claude-redeem.ps1')
const NODE_DEVICE_ID = join(SCRIPTS, 'device-id.mjs')
const PS_DEVICE_ID = join(SCRIPTS, 'device-id.ps1')

const SKIP_PWSH = process.env.TOKENSCOPE_SKIP_PWSH === '1'
// TOKENSCOPE_PWSH names the PowerShell to run, as in the helper conformance suite.
const PWSH = resolvePwsh() ?? (process.env.TOKENSCOPE_PWSH || 'pwsh')
const HAVE_PWSH = spawnSync(PWSH, ['-NoProfile', '-Command', 'exit 0']).status === 0

const WIN = process.platform === 'win32'
// An ephemeral runner, whose real profile nobody keeps.
const EPHEMERAL_CI = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
// win32: the redeem cases need fixtures under the real profile (see header).
const REAL_PROFILE_OK = !WIN || EPHEMERAL_CI
if (WIN && !SKIP_PWSH && !REAL_PROFILE_OK) {
  console.warn(
    '[claude-redeem-ps1] win32 outside CI: the PowerShell profile cannot be redirected, so the redeem and device-id ' +
      'equivalence cases (which need fixtures under your real profile) are skipped. They run on the Windows CI runner.',
  )
}
if (WIN && !SKIP_PWSH && REAL_PROFILE_OK) {
  console.warn(
    "[claude-redeem-ps1] win32: the configured-server_url cases, the default-store case and device-id are skipped: " +
      "each would write the profile's OWN .claude/settings.json or default store, not a fixture subdirectory.",
  )
}

/** The account home both lanes run under: the case dir, or on win32 the real profile. */
const homeOf = (dir: string) => (WIN ? realHome() : dir)

/** A directory outside the account home (on Windows the temp dir is INSIDE the profile). */
function outsideHome(name: string): string {
  const fold = (p: string) => (WIN ? p.toLowerCase() : p)
  // Native realpath on both sides: on Windows tmpdir() can be the 8.3 short form
  // (C:\\Users\\RUNNER~1\\...) of a directory that IS inside the long-form profile.
  const canon = (p: string) => { try { return realpathSync.native(p) } catch { return p } }
  const home = canon(realHome())
  const t = canon(tmpdir())
  const under = fold(t) === fold(home) || fold(t).startsWith(fold(home + sep))
  return join(under ? parse(home).root : t, name)
}
const LINK_TARGET = outsideHome('ts-redeem-ps1-link-target')
const ELSEWHERE = outsideHome('ts-redeem-ps1-elsewhere')

const SECRET = 'rt_DURABLE_SECRET_ps1'
const CODE = 'hand-off-code-0123456789'
const INSTANCE = 'f825e796'

type Run = { status: number | null; stdout: string; stderr: string }

describe('PowerShell setup lane is present', () => {
  it('pwsh is available (set TOKENSCOPE_SKIP_PWSH=1 to skip the PowerShell legs explicitly)', () => {
    if (SKIP_PWSH) return
    expect(HAVE_PWSH, 'pwsh missing: the claude-redeem.ps1 equivalence suite cannot run').toBe(true)
  })
})

describe('PowerShell scripts are written for Windows PowerShell 5.1', () => {
  for (const f of ['claude-redeem.ps1', 'device-id.ps1', 'ps-json.ps1']) {
    it(`${f} is ASCII with no BOM (5.1 reads a BOM-less script in the ANSI code page)`, () => {
      const bytes = readFileSync(join(SCRIPTS, f))
      expect([...bytes].every((b) => b < 0x80), `${f} has a non-ASCII byte`).toBe(true)
    })
  }
  it('the packaged default is read from plugin.json, never restated (the public build empties it there)', () => {
    const src = readFileSync(PS_REDEEM, 'utf8')
    expect(src).not.toMatch(/https:\/\/[a-z0-9.-]+\.(com|net|io)/i)
    expect(src).toContain("Get-TsJsonMember $doc 'userConfig'")
  })
  it('both scripts reset PSModulePath before anything else runs', () => {
    for (const f of [PS_REDEEM, PS_DEVICE_ID]) {
      const firstStatement = readFileSync(f, 'utf8')
        .split('\n')
        .find((l) => l.trim() && !l.trim().startsWith('#'))
      expect(firstStatement).toBe("$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')")
    }
  })
})

describe.skipIf(SKIP_PWSH || !REAL_PROFILE_OK)('claude-redeem.ps1 writes what claude-redeem.mjs writes', () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let requests: Array<{ body: Record<string, unknown>; mode: unknown }> = []
  let root: string
  let preload: string
  const indexBefore = realIsolatedIndex(realHome())

  const bundle = () => ({
    instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
    tool: 'claude-code',
    oauth_refresh_token: SECRET,
    oauth_token_endpoint: `${baseUrl}/api/v1/oauth/token`,
    oauth_client_id: 'client-xyz',
    telemetry: {
      claude: {
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}/azmon-stub/v1/logs`,
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
        otel_headers_helper_url: `${baseUrl}/api/v1/instances/${INSTANCE}/bearer`,
        OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`,
      },
    },
  })

  beforeAll(async () => {
    root = mkdtempSync(join(realHome(), '.ts-redeem-ps1-'))
    preload = writeFakeHomePreload(root)
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        requests.push({ body, mode: req.headers['x-tokenscope-setup-mode'] })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (body.handoff_code === 'BADBUNDLE') {
          const b = bundle()
          b.telemetry.claude.OTEL_RESOURCE_ATTRIBUTES = 'tool=claude-code'
          res.end(JSON.stringify(b))
        } else {
          res.end(JSON.stringify(bundle()))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(async () => {
    if (root && root.startsWith(join(realHome(), '.ts-redeem-ps1-'))) rmSync(root, { recursive: true, force: true })
    rmSync(LINK_TARGET, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (WIN) {
      // The runner's real default store took the index; put back what was there.
      if (indexBefore === null) rmSync(realIndexPath(), { force: true })
      else writeFileSync(realIndexPath(), indexBefore)
    }
    expect(realIsolatedIndex(realHome()), 'a spawned redeem wrote the REAL settings index').toBe(indexBefore)
  })
  const realIndexPath = () => join(realHome(), '.tokenscope', 'isolated-settings-files.claude-code.json')

  type LaneOpts = {
    /** Leave TOKENSCOPE_API_BASE unset, so only local configuration names the host. */
    noEnvBase?: boolean
    /** Working directory, relative to the case dir. */
    cwd?: string
    /** Extra environment for the run. */
    env?: NodeJS.ProcessEnv
  }

  // Async spawn: the stub server runs on this worker's event loop.
  const spawnRun = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) =>
    new Promise<Run>((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        // A loopback TOKENSCOPE_API_BASE is the only base either lane accepts
        // from the environment; it is what a refused --api-base falls back to,
        // so a refusal case still reaches the stub instead of a real host.
        env: { ...process.env, TOKENSCOPE_API_BASE: baseUrl, CLAUDE_PLUGIN_ROOT: '', ...env },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.stderr.on('data', (c) => (stderr += c))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
  /*
   * The case dir is the account home for both lanes: the configured server_url
   * (#415) is read from <home>/.claude/settings.json and the isolated settings
   * index is written to <home>/.tokenscope, and the Node lane's home is the
   * passwd entry, which no env var moves (see helpers/fake-home.ts). pwsh on
   * Linux takes its profile from HOME. On win32 neither moves (header).
   */
  const runNode = (args: string[], o: LaneOpts, dir: string) => {
    const fake = WIN ? { args: [], env: {} } : fakeHomeNode(preload, dir)
    const env: NodeJS.ProcessEnv = { ...fake.env }
    if (o.noEnvBase) env.TOKENSCOPE_API_BASE = ''
    return spawnRun(process.execPath, [...fake.args, NODE_REDEEM, ...args], env, o.cwd ? join(dir, o.cwd) : undefined)
  }
  const runPs = (args: string[], o: LaneOpts, dir: string) => {
    const env: NodeJS.ProcessEnv = { ...(WIN ? {} : { HOME: dir }), ...o.env }
    if (o.noEnvBase) env.TOKENSCOPE_API_BASE = ''
    return spawnRun(
      PWSH,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_REDEEM, ...args],
      env,
      o.cwd ? join(dir, o.cwd) : undefined,
    )
  }

  type Snapshot = { run: Run; posts: number; mode: unknown; files: Record<string, string | null> }

  /**
   * Seed `dir`, run one lane, snapshot every file the redeem can write, wipe.
   * The same dir for both lanes, so paths inside the files compare equal.
   */
  async function lane(
    which: 'node' | 'ps',
    dir: string,
    seed: (dir: string) => void,
    args: (dir: string) => string[],
    opts: LaneOpts,
  ): Promise<Snapshot> {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    // win32: the index is the runner's real one (REAL_PROFILE_OK gates this).
    if (WIN) rmSync(realIndexPath(), { force: true })
    seed(dir)
    requests = []
    const run = await (which === 'node' ? runNode(args(dir), opts, dir) : runPs(args(dir), opts, dir))
    const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
    const files = {
      settings: read(join(dir, 'home', '.claude', 'settings.json')),
      repoSettings: read(join(dir, 'repo', '.claude', 'settings.json')),
      store: read(join(dir, 'state', 'config.claude-code.json')),
      list: read(join(dir, 'state', 'settings-files.claude-code.json')),
      index: read(join(homeOf(dir), '.tokenscope', 'isolated-settings-files.claude-code.json')),
    }
    return { run, posts: requests.length, mode: requests[0]?.mode, files }
  }

  const stdArgs = (dir: string) => [
    '--handoff-code', CODE,
    '--api-base', baseUrl,
    '--instance-id', 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
    '--settings-path', join(dir, 'home', '.claude', 'settings.json'),
    '--state-dir', join(dir, 'state'),
  ]

  /** What the PS lane must write, derived from what the Node lane wrote. */
  function expectedPs(node: Snapshot, dir: string) {
    const out: Record<string, string | null> = { ...node.files }
    // A refusal leaves whatever was seeded; only a success is rewritten.
    if (node.run.status !== 0) return out
    if (node.files.settings) {
      const s = JSON.parse(node.files.settings)
      s.otelHeadersHelper = buildHelperCommand(
        { tool: 'claude-code', platform: 'win32', stateDir: join(dir, 'state') },
        // The emit-only lane runs a SNAPSHOT of the helper in the state dir.
        { scriptsDir: join(dir, 'state', 'helper', 'scripts') },
      )
      out.settings = `${JSON.stringify(s, null, 2)}\n`
    }
    if (node.files.store) {
      const st = JSON.parse(node.files.store)
      expect(st.helper.platform).toBe(process.platform)
      st.helper.platform = 'win32'
      out.store = `${JSON.stringify(st, null, 2)}\n`
    }
    return out
  }

  async function both(name: string, seed: (dir: string) => void, args = stdArgs, opts: LaneOpts = {}) {
    const dir = join(root, name)
    const node = await lane('node', dir, seed, args, opts)
    const ps = await lane('ps', dir, seed, args, opts)
    return { dir, node, ps }
  }

  function expectSameOutcome(r: Awaited<ReturnType<typeof both>>) {
    expect(r.ps.run.status, `ps stderr: ${r.ps.run.stderr}`).toBe(r.node.run.status)
    expect(r.ps.posts).toBe(r.node.posts)
    expect(r.ps.files).toEqual(expectedPs(r.node, r.dir))
    for (const s of [r.ps.run.stdout, r.ps.run.stderr]) {
      expect(s).not.toContain(SECRET)
      expect(s).not.toContain(CODE)
    }
  }

  const noSeed = () => {}

  it('fresh device: same store, same settings, same session-file list and index; states emit-only', async () => {
    const r = await both('fresh', noSeed)
    expect(r.node.run.status).toBe(0)
    expect(r.node.files.store).not.toBeNull()
    expect(r.node.files.list).not.toBeNull()
    // --state-dir is not the default store, so the default store indexes the pairing.
    expect(JSON.parse(r.node.files.index ?? '{}').entries).toEqual([
      { file: join(r.dir, 'home', '.claude', 'settings.json'), stateDir: join(r.dir, 'state') },
    ])
    expectSameOutcome(r)
    expect(r.node.mode).toBe('full')
    expect(r.ps.mode).toBe('emit-only')
    // The plain summary: what works without Node, and how to get the rest.
    expect(r.ps.run.stdout).toContain('Tracking is on for Claude Code on this computer, without Node.js.')
    expect(r.ps.run.stdout).toContain('Next: restart Claude Code.')
    expect(r.ps.run.stdout).toContain('Needs Node.js: the status line')
    expect(r.ps.run.stdout).toContain('winget install OpenJS.NodeJS.LTS, then run /tokenscope:setup again.')
    // The session-start refresh needs Node, so the reason for re-running setup is stated with it.
    expect(r.ps.run.stdout).toContain(
      'Without Node.js, a plugin update does not update your tracking settings, so run /tokenscope:setup again after each update.',
    )
    // The Node summary: what happened and the one thing to do next, no internals.
    expect(r.node.run.stdout).toContain('✓ Tracking is on for Claude Code on this computer.')
    expect(r.node.run.stdout).toContain('Next: restart Claude Code.')
    expect(r.node.run.stdout).not.toMatch(/OTel|plumbing/)
    // One restart is not enough in a tagged repo after re-enrolment: both lanes say when to restart again.
    for (const out of [r.node.run.stdout, r.ps.run.stdout]) {
      expect(out).toContain('In a repo with a .tokenscope file, restart once more if you see a "superseded device enrolment" warning.')
    }
    // cmd.exe would look for a bare `powershell.exe` in the repository first.
    const helper = JSON.parse(r.ps.files.repoSettings ?? r.ps.files.settings ?? '{}').otelHeadersHelper
    expect(helper).toMatch(/^"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile /)
  }, 60_000)

  /*
   * Claude Desktop (desktop-env.mjs): the device goes into the USER environment,
   * which the app merges at launch. Only Windows persists a 'User' variable
   * (.NET ignores that target elsewhere), so the stored value is asserted on the
   * Windows runner, and the runner's previous value is put back.
   */
  it('Claude Desktop: the device goes into the user environment, with the restart step; the CLI never touches it', async () => {
    const ps = (cmd: string) => spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' })
    const userEnv = () => ps("[Environment]::GetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', 'User')").stdout.trim()
    const setUserEnv = (v: string) =>
      ps(`[Environment]::SetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', ${v ? `'${v.replace(/'/g, "''")}'` : '$null'}, 'User')`)
    const before = WIN ? userEnv() : ''
    try {
      if (WIN) setUserEnv('team=apac')
      const cli = await lane('ps', join(root, 'desktop-cli'), noSeed, stdArgs, { cwd: '.', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } })
      expect(cli.run.status, cli.run.stderr).toBe(0)
      expect(cli.run.stdout).not.toContain('Claude Desktop')
      if (WIN) expect(userEnv()).toBe('team=apac')

      const desk = await lane('ps', join(root, 'desktop'), noSeed, stdArgs, { cwd: '.', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
      expect(desk.run.status, desk.run.stderr).toBe(0)
      expect(desk.run.stdout).toContain('Claude Desktop: this device is set in your user environment, so Desktop sessions are attributed.')
      expect(desk.run.stdout).toContain('Next: quit the Claude app completely and open it again.')
      if (WIN) expect(userEnv()).toBe(mergeDesktopAttrs('team=apac', 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c'))
    } finally {
      if (WIN) setUserEnv(before)
    }
  }, 60_000)

  it('emit-only: the helper is a snapshot in the state dir that survives the install being removed', async () => {
    const r = await both('snapshot', noSeed)
    expect(r.ps.run.status, r.ps.run.stderr).toBe(0)
    // The PS lane ran last, so its files are on disk.
    const snap = join(r.dir, 'state', 'helper')
    expect(readFileSync(join(snap, 'scripts', 'otel-headers-helper.ps1'))).toEqual(
      readFileSync(join(SCRIPTS, 'otel-headers-helper.ps1')),
    )
    // Where the helper reads its version header from (..\.claude-plugin\plugin.json).
    expect(readFileSync(join(snap, '.claude-plugin', 'plugin.json'))).toEqual(
      readFileSync(join(SCRIPTS, '..', '.claude-plugin', 'plugin.json')),
    )
    const helper = JSON.parse(r.ps.files.settings!).otelHeadersHelper as string
    expect(helper).toContain('helper\\scripts\\otel-headers-helper.ps1')
    expect(helper).not.toContain('plugin\\scripts')
  }, 60_000)

  it('existing settings: unrelated keys survive, retired keys go, same bytes', async () => {
    const seed = (dir: string) => {
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      const body = JSON.stringify({
          permissions: { allow: ['Bash(npm test:*)', 'Read(<a>&\'b\')'], deny: [] },
          statusLine: { type: 'command', command: 'my-line', padding: 0 },
          otelHeadersHelper: '/old/helper.sh',
          env: {
            MY_VAR: 'keep me',
            TOKENSCOPE_SESSION_TOKEN: 'retired',
            TOKENSCOPE_BEARER_ENDPOINT: `${baseUrl}/api/v1/instances/${INSTANCE}/bearer`,
          },
          cleanupPeriodDays: 30,
          nested: { deep: { deeper: { deepest: [1, { x: null }] } } },
          when: '2026-10-07T00:00:00Z',
        })
      // Written as raw text so the index-like key "2" sits LAST on disk: a
      // JavaScript object lists it first, and both lanes must agree on that.
      writeFileSync(join(dir, 'home', '.claude', 'settings.json'), body.replace(/}$/, ',"2":"index-like key"}'))
    }
    const r = await both('existing', seed)
    expect(r.node.run.status).toBe(0)
    const s = JSON.parse(r.ps.files.settings!)
    expect(s.env.MY_VAR).toBe('keep me')
    expect(s.env).not.toHaveProperty('TOKENSCOPE_SESSION_TOKEN')
    expect(s.permissions.allow).toEqual(['Bash(npm test:*)', 'Read(<a>&\'b\')'])
    expectSameOutcome(r)
  }, 60_000)

  it('cross-environment move: the env block is REPLACED in both lanes', async () => {
    const otherHost = baseUrl.replace('127.0.0.1', 'localhost')
    const seed = (dir: string) => {
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      writeFileSync(
        join(dir, 'home', '.claude', 'settings.json'),
        JSON.stringify({
          permissions: { allow: [] },
          env: {
            MY_VAR: 'from the old environment',
            TOKENSCOPE_BEARER_ENDPOINT: `${otherHost}/api/v1/instances/old/bearer`,
            TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'old-token',
          },
        }),
      )
    }
    const r = await both('cross-env', seed)
    expect(r.node.run.status).toBe(0)
    expect(JSON.parse(r.ps.files.settings!).env).not.toHaveProperty('MY_VAR')
    expect(r.ps.run.stdout).toContain('Environment changed')
    expect(r.node.run.stdout).toContain('Environment changed')
    expectSameOutcome(r)
  }, 60_000)

  it('non-JSON settings: both refuse to overwrite, after the POST, and write no store', async () => {
    const seed = (dir: string) => {
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      writeFileSync(join(dir, 'home', '.claude', 'settings.json'), '{ "permissions": oops')
    }
    const r = await both('non-json', seed)
    expect(r.node.run.status).toBe(1)
    expect(r.node.files.settings).toBe('{ "permissions": oops')
    expect(r.node.files.store).toBeNull()
    expect(r.ps.run.stderr).toContain('is not valid JSON')
    expectSameOutcome(r)
  }, 60_000)

  it('a settings file with a byte-order mark is refused by both (JSON.parse refuses it)', async () => {
    const seed = (dir: string) => {
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
      writeFileSync(join(dir, 'home', '.claude', 'settings.json'), '﻿{}')
    }
    const r = await both('bom', seed)
    expect(r.node.run.status).toBe(1)
    expectSameOutcome(r)
  }, 60_000)

  it('foreign --api-base: both warn, ignore it, and redeem at the locally known host', async () => {
    const r = await both('foreign-api-base', noSeed, (dir) =>
      stdArgs(dir).map((a) => (a === baseUrl ? 'https://evil.example' : a)),
    )
    expect(r.node.run.status).toBe(0)
    expect(r.node.run.stderr).toContain('ignoring --api-base (origin-not-allowed)')
    expect(r.ps.run.stderr).toContain('ignoring --api-base (origin-not-allowed)')
    expect(r.ps.posts).toBe(1)
    expectSameOutcome(r)
  }, 60_000)

  it('--settings-path inside a git repository: both refuse BEFORE spending the code', async () => {
    const seed = (dir: string) => mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    const r = await both('in-repo', seed, (dir) =>
      stdArgs(dir).map((a) => (a.endsWith(join('home', '.claude', 'settings.json')) ? join(dir, 'repo', '.claude', 'settings.json') : a)),
    )
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expect(r.ps.run.stderr).toContain('must not name a path inside a git repository')
    expectSameOutcome(r)
  }, 60_000)

  it('--state-dir outside the profile: both refuse before the POST, and write nothing there', async () => {
    // "Both refuse" alone would also pass if both lanes wrote the store first and
    // then failed; the directory itself must stay untouched.
    rmSync(ELSEWHERE, { recursive: true, force: true })
    const r = await both('outside-home', noSeed, (dir) =>
      stdArgs(dir).map((a) => (a === join(dir, 'state') ? ELSEWHERE : a)),
    )
    const psSaw = `ps exit=${r.ps.run.status} posts=${r.ps.posts} stdout=${JSON.stringify(r.ps.run.stdout)} stderr=${JSON.stringify(r.ps.run.stderr)} elsewhere=${ELSEWHERE}`
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expect(r.ps.posts, psSaw).toBe(0)
    expect(r.ps.run.status, psSaw).toBe(1)
    expect(r.ps.run.stderr, psSaw).toContain('must name a path inside your home directory')
    expectSameOutcome(r)
    expect(existsSync(ELSEWHERE), `a redeem wrote into ${ELSEWHERE}`).toBe(false)
  }, 60_000)

  it('win32: a state dir inside the profile written as an 8.3 short name is accepted by both', async (ctx) => {
    // Windows-only: tmpdir() on the runner is C:\\Users\\RUNNER~1\\AppData\\Local\\Temp,
    // inside the profile. Node used to compare the short form literally and refuse
    // it; PowerShell normalises. Both must accept, and agree.
    const short = tmpdir()
    let long = short
    try { long = realpathSync.native(short) } catch { /* keep */ }
    if (!WIN || !REAL_PROFILE_OK || short.toLowerCase() === long.toLowerCase()) {
      ctx.skip()
      return
    }
    const shortState = join(short, `ts-redeem-ps1-short-${process.pid}`)
    try {
      const r = await both('short-name', noSeed, (dir) =>
        stdArgs(dir).map((a) => (a === join(dir, 'state') ? shortState : a)),
      )
      const saw = `node exit=${r.node.run.status} stderr=${JSON.stringify(r.node.run.stderr)} | ps exit=${r.ps.run.status} stderr=${JSON.stringify(r.ps.run.stderr)}`
      expect(r.node.run.status, saw).toBe(0)
      expect(r.ps.run.status, saw).toBe(0)
    } finally {
      rmSync(shortState, { recursive: true, force: true })
    }
  }, 90_000)

  it('--state-dir through a symlink out of the profile: both refuse before the POST', async (ctx) => {
    // A junction on Windows (no privilege needed); skip where none can be made.
    const probe = join(root, 'link-probe')
    try {
      mkdirSync(LINK_TARGET, { recursive: true })
      symlinkSync(LINK_TARGET, probe, 'junction')
      rmSync(probe, { force: true, recursive: false })
    } catch (err) {
      console.warn(`[claude-redeem-ps1] cannot create a link out of the profile (${(err as Error).message}); skipping`)
      ctx.skip()
    }
    const seed = (dir: string) => {
      mkdirSync(LINK_TARGET, { recursive: true })
      symlinkSync(LINK_TARGET, join(dir, 'link'), 'junction')
    }
    const r = await both('symlink-out', seed, (dir) =>
      stdArgs(dir).map((a) => (a === join(dir, 'state') ? join(dir, 'link', 'state') : a)),
    )
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expect(existsSync(join(LINK_TARGET, 'state'))).toBe(false)
    expectSameOutcome(r)
  }, 60_000)

  it('an existing session-file list: the new path is appended once, same bytes', async () => {
    const seed = (dir: string) => {
      mkdirSync(join(dir, 'state'), { recursive: true })
      writeFileSync(
        join(dir, 'state', 'settings-files.claude-code.json'),
        JSON.stringify({ version: 1, tool: 'claude-code', files: ['/elsewhere/settings.json', join(dir, 'home', '.claude', 'settings.json'), 7] }),
      )
    }
    const r = await both('existing-list', seed)
    expect(r.node.run.status).toBe(0)
    expect(JSON.parse(r.ps.files.list!).files).toEqual(['/elsewhere/settings.json', join(r.dir, 'home', '.claude', 'settings.json')])
    expectSameOutcome(r)
  }, 60_000)

  it('an existing isolated index: the pairing is replaced, malformed entries dropped, same bytes', async () => {
    const scoped = (dir: string) => join(dir, 'home', '.claude', 'settings.json')
    const seed = (dir: string) => {
      mkdirSync(join(homeOf(dir), '.tokenscope'), { recursive: true })
      writeFileSync(
        join(homeOf(dir), '.tokenscope', 'isolated-settings-files.claude-code.json'),
        JSON.stringify({
          version: 1,
          tool: 'claude-code',
          entries: [
            { file: '/elsewhere/settings.json', stateDir: '/elsewhere/state', extra: 1 },
            { file: scoped(dir), stateDir: '/old/state' },
            { file: 7 },
            'junk',
          ],
        }),
      )
    }
    const r = await both('existing-index', seed)
    expect(r.node.run.status).toBe(0)
    expect(JSON.parse(r.ps.files.index!).entries).toEqual([
      { file: '/elsewhere/settings.json', stateDir: '/elsewhere/state' },
      { file: scoped(r.dir), stateDir: join(r.dir, 'state') },
    ])
    expectSameOutcome(r)
  }, 60_000)

  // win32: the default store would be the runner's real one.
  it.skipIf(WIN)('--state-dir IS the default store: no isolated index in either lane', async () => {
    const r = await both('default-store', noSeed, (dir) =>
      stdArgs(dir).map((a) => (a === join(dir, 'state') ? join(dir, '.tokenscope') : a)),
    )
    // The snapshot's store/list paths assume <case>/state, so compare what this
    // case is about directly: both succeed, both list S, neither indexes it.
    for (const x of [r.node, r.ps]) {
      expect(x.run.status, x.run.stderr).toBe(0)
      expect(x.files.index).toBeNull()
    }
    expect(existsSync(join(r.dir, '.tokenscope', 'settings-files.claude-code.json'))).toBe(true)
  }, 60_000)

  it('--settings-path that is not settings.json: both refuse', async () => {
    const r = await both('basename', noSeed, (dir) =>
      stdArgs(dir).map((a) => (a.endsWith('settings.json') ? join(dir, 'home', '.claude', 'notes.txt') : a)),
    )
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expectSameOutcome(r)
  }, 60_000)

  it('an unknown flag (the deleted --redeem-url) is refused by both', async () => {
    const r = await both('unknown-flag', noSeed, (dir) => [...stdArgs(dir), '--redeem-url', 'https://evil.example/x'])
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expect(r.ps.run.stderr).toContain('unknown flag: --redeem-url')
    expectSameOutcome(r)
  }, 60_000)

  // ── the plugin's configured server_url (#415) ─────────────────────────────
  // Read from managed then USER settings only: here `<case dir>/.claude/settings.json`,
  // the fake home's. The redeem itself still writes the --settings-path file.
  // win32: the user settings would be the real profile's own; skipped there.
  const seedUserServerUrl = (configs: Record<string, unknown>) => (dir: string) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: configs }))
  }
  const noApiBase = (dir: string) => stdArgs(dir).filter((a, i, all) => a !== '--api-base' && all[i - 1] !== '--api-base')

  it.skipIf(WIN)('configured server_url: with no flag and no env, it is where both lanes redeem', async () => {
    const r = await both(
      'configured-selects',
      seedUserServerUrl({ 'tokenscope@some-marketplace': { options: { server_url: `${baseUrl}/` } } }),
      noApiBase,
      { noEnvBase: true },
    )
    expect(r.node.run.status, r.node.run.stderr).toBe(0)
    expect(r.node.posts).toBe(1)
    expectSameOutcome(r)
  }, 60_000)

  it.skipIf(WIN)('configured server_url: --api-base may SELECT it (no warning in either lane)', async () => {
    // `.invalid` never resolves, so the selected host is visible as the redeem
    // failing to connect rather than as the stub being hit.
    const r = await both(
      'configured-arg',
      seedUserServerUrl({ 'tokenscope@m': { options: { server_url: 'https://configured.invalid' } } }),
      (dir) => stdArgs(dir).map((a) => (a === baseUrl ? 'https://configured.invalid' : a)),
    )
    expect(r.node.run.status).toBe(1)
    expect(r.node.run.stderr).toContain('Redeem failed')
    expect(r.ps.run.stderr).toContain('Redeem failed')
    for (const x of [r.node, r.ps]) expect(x.run.stderr).not.toContain('ignoring --api-base')
    expect(r.node.posts).toBe(0)
    expectSameOutcome(r)
  }, 60_000)

  it.skipIf(WIN)('configured server_url: disagreeing tokenscope@* entries configure nothing', async () => {
    const r = await both(
      'configured-disagree',
      seedUserServerUrl({
        'tokenscope@a': { options: { server_url: 'https://a.invalid' } },
        'tokenscope@b': { options: { server_url: 'https://b.invalid' } },
      }),
      (dir) => stdArgs(dir).map((a) => (a === baseUrl ? 'https://a.invalid' : a)),
    )
    expect(r.node.run.status).toBe(0)
    for (const x of [r.node, r.ps]) expect(x.run.stderr).toContain('ignoring --api-base (origin-not-allowed)')
    expectSameOutcome(r)
  }, 60_000)

  it('a PROJECT settings server_url is ignored: --api-base naming it is refused by both', async () => {
    const seed = (dir: string) => {
      for (const f of ['settings.json', 'settings.local.json']) {
        mkdirSync(join(dir, 'project', '.claude'), { recursive: true })
        writeFileSync(
          join(dir, 'project', '.claude', f),
          JSON.stringify({ pluginConfigs: { 'tokenscope@m': { options: { server_url: 'https://project.invalid' } } } }),
        )
      }
    }
    const r = await both(
      'project-ignored',
      seed,
      (dir) => stdArgs(dir).map((a) => (a === baseUrl ? 'https://project.invalid' : a)),
      { cwd: 'project' },
    )
    expect(r.node.run.status).toBe(0)
    expect(r.node.posts).toBe(1)
    for (const x of [r.node, r.ps]) expect(x.run.stderr).toContain('ignoring --api-base (origin-not-allowed)')
    expectSameOutcome(r)
  }, 60_000)

  it.skipIf(WIN)('an invalid configured server_url is an error in both lanes, never a fallback', async () => {
    const r = await both(
      'configured-invalid',
      seedUserServerUrl({ 'tokenscope@m': { options: { server_url: 'http://plain.invalid' } } }),
      noApiBase,
      { noEnvBase: true },
    )
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    for (const x of [r.node, r.ps]) expect(x.run.stderr).toContain('API base is unsafe (insecure-scheme)')
    expectSameOutcome(r)
  }, 60_000)

  it('a flag with no value is refused by both', async () => {
    // `--instance-id --handoff-code <code>`: read leniently, the code would be
    // spent as a positional with a bogus instance id.
    const r = await both('missing-value', noSeed, (dir) => ['--instance-id', ...stdArgs(dir).slice(0, 2), ...stdArgs(dir).slice(4)])
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(0)
    expectSameOutcome(r)
  }, 60_000)

  it('a bundle with no instance id: both exit 1 and write nothing', async () => {
    const r = await both('bad-bundle', noSeed, (dir) => stdArgs(dir).map((a) => (a === CODE ? 'BADBUNDLE' : a)))
    expect(r.node.run.status).toBe(1)
    expect(r.node.posts).toBe(1)
    expect(r.node.files.settings).toBeNull()
    // Refused by the attribution check itself, not only by the store's
    // consistency rule further down (which would also catch it, less clearly).
    for (const x of [r.node, r.ps]) expect(x.run.stderr).toContain('missing a non-empty OTEL_RESOURCE_ATTRIBUTES')
    expectSameOutcome(r)
  }, 60_000)

  it('a handoff code that begins with "-" still works as --handoff-code', async () => {
    const r = await both('dash-code', noSeed, (dir) => stdArgs(dir).map((a) => (a === CODE ? '-dash-code-012345' : a)))
    expect(r.node.run.status).toBe(0)
    expectSameOutcome(r)
  }, 60_000)
})

// win32: the fixture IS the profile's own .claude/settings.json; skipped there.
describe.skipIf(SKIP_PWSH || WIN)('device-id.ps1 prints what device-id.mjs prints', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(realHome(), '.ts-device-id-ps1-'))
  })
  afterAll(() => {
    if (home && home.startsWith(join(realHome(), '.ts-device-id-ps1-'))) rmSync(home, { recursive: true, force: true })
  })

  // HOME moves BOTH readers here: device-id.mjs reads Claude's settings through
  // homedir(), and on Linux .NET's UserProfile folder is $HOME.
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, HOME: home } })
    return { status: r.status, out: r.stdout }
  }
  const settings = (body: string | null) => {
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    if (body === null) return
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), body)
  }

  const cases: Array<[string, string | null]> = [
    [
      'enrolled',
      JSON.stringify({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: ` tokenscope.instance_id=${INSTANCE},tool=claude-code`,
          TOKENSCOPE_BEARER_ENDPOINT: `https://TS.Example.com:8443/api/v1/instances/${INSTANCE}/bearer`,
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: SECRET,
        },
      }),
    ],
    ['no settings', null],
    ['not json', '{nope'],
    ['no env', '{"permissions":{}}'],
    ['other tool', JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=copilot-cli` } })],
    ['empty id', JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=,tool=claude-code' } })],
  ]
  it.each(cases)('%s', (_name, body) => {
    settings(body)
    const n = run(process.execPath, [NODE_DEVICE_ID, '--tool', 'claude-code'])
    const p = run(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_DEVICE_ID, '--tool', 'claude-code'])
    expect(p.status).toBe(0)
    expect(p.out).not.toContain(SECRET)
    const nodeOut = JSON.parse(n.out)
    const psOut = JSON.parse(p.out)
    expect(nodeOut.platform).toBe(process.platform)
    expect(nodeOut.node).toBe(process.version)
    expect(psOut.platform).toBe(process.platform)
    expect(psOut.node).toBeNull()
    // Same keys in the same order; same values apart from the runtime itself.
    expect(Object.keys(psOut)).toEqual(Object.keys(nodeOut))
    expect({ ...psOut, node: nodeOut.node }).toEqual(nodeOut)
  }, 30_000)
})
