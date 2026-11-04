/*
 * plugin-runtime — the shared runtime helpers extracted from status.mjs /
 * usage.mjs / session-start.mjs / read-credential.mjs (one place owns the
 * emit-path contract). Tests the mechanism: path resolution, settings-env
 * reading, the state dir + sentinel, and the real-emit-path invoker's
 * classification (without ever surfacing a bearer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveScriptsDir,
  resolveHelperPath,
  stateDir,
  readSettingsEnv,
  readEmitSentinel,
  runEmitHelper,
} from '../../../plugin/scripts/plugin-runtime.mjs'

// Windows (#430): skipped on win32 because this file expects the .sh helper; on win32 the helper is the .ps1.
const POSIX_ONLY = process.platform === 'win32'

let tmp: string
const savedEnv = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-runtime-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env = { ...savedEnv }
})

describe.skipIf(POSIX_ONLY)('resolveScriptsDir / resolveHelperPath', () => {
  it('REFUSES a CLAUDE_PLUGIN_ROOT outside our own install', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/opt/plugin'
    // Confined: a CLAUDE_PLUGIN_ROOT outside our own install is refused and we
    // fall back to the bundle this module was loaded from (MDASH §2.6 follow-up).
    expect(resolveScriptsDir()).toBe(resolve(__dirname, '../../../plugin/scripts'))
    expect(resolveHelperPath()).toBe(resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh'))
  })
})

describe.skipIf(POSIX_ONLY)('stateDir', () => {
  // S1 hardening: TOKENSCOPE_STATE_DIR is resolved from process.env ONLY — a
  // PASSED `env` object (readEmitSentinel's argument, or any settings-derived
  // object) is IGNORED for this key, because nothing legitimately writes
  // TOKENSCOPE_STATE_DIR to global OR repo settings.json (a settings-derived
  // object is attacker-reachable in a hostile repo; process.env is not routed
  // through that path the same way — see plugin-runtime.mjs's stateDir doc).
  it('IGNORES TOKENSCOPE_STATE_DIR on a passed env object — process.env only', () => {
    expect(stateDir({ TOKENSCOPE_STATE_DIR: '/custom/state' }).endsWith('/.tokenscope')).toBe(true)
  })
  it('falls back to ~/.tokenscope', () => {
    const d = stateDir({})
    expect(d.endsWith('/.tokenscope')).toBe(true)
  })
  it('ignores a leaked HOME — anchors on the passwd home (the recurring silent-drop fix)', () => {
    // The whole bug: a leaked HOME made the forwarder resolve a phantom
    // ~/.tokenscope. stateDir() must NOT follow HOME; it anchors on the passwd
    // home, so a leaked HOME env cannot move the state dir.
    const real = userInfo().homedir
    const leaked = stateDir({ HOME: '/tmp/ts-home-LEAKED' })
    expect(leaked).toBe(join(real, '.tokenscope'))
    expect(leaked).not.toContain('/tmp/ts-home-LEAKED')
  })
  it('honours a process-level TOKENSCOPE_STATE_DIR — and a passed env object can never override it', () => {
    // The override is a genuine PROCESS/deployment concern (a real shell
    // export or container config) — never a per-settings OTEL env block.
    // Restored after the assertion.
    const prev = process.env.TOKENSCOPE_STATE_DIR
    process.env.TOKENSCOPE_STATE_DIR = '/pinned/state'
    try {
      expect(stateDir({ SOME_OTHER: 'x' })).toBe('/pinned/state')
      // A passed env's OWN TOKENSCOPE_STATE_DIR does NOT win over the real
      // process-level pin — it is not consulted at all (S1 hardening: a
      // hostile-repo-tainted `env` object must not be able to redirect where
      // otel-headers-helper.sh would later write a live access token).
      expect(stateDir({ TOKENSCOPE_STATE_DIR: '/attacker-supplied' })).toBe('/pinned/state')
    } finally {
      if (prev === undefined) delete process.env.TOKENSCOPE_STATE_DIR
      else process.env.TOKENSCOPE_STATE_DIR = prev
    }
  })
})

describe.skipIf(POSIX_ONLY)('readSettingsEnv', () => {
  it('returns the env block from a settings file', () => {
    const p = join(tmp, 'settings.json')
    writeFileSync(p, JSON.stringify({ env: { A: '1' }, otelHeadersHelper: '/h.sh' }))
    expect(readSettingsEnv(p)).toEqual({ A: '1' })
  })
  it('returns {} for a missing / unparseable file', () => {
    expect(readSettingsEnv(join(tmp, 'nope.json'))).toEqual({})
    writeFileSync(join(tmp, 'bad.json'), 'not json')
    expect(readSettingsEnv(join(tmp, 'bad.json'))).toEqual({})
  })
})

describe.skipIf(POSIX_ONLY)('readEmitSentinel', () => {
  // readEmitSentinel(env) resolves its dir via stateDir(env) — which (S1
  // hardening) reads TOKENSCOPE_STATE_DIR from process.env only, never from
  // the passed `env` object. Pin the dir via process.env here, matching how
  // production callers actually get a real state dir (a genuine deployment
  // pin), not by handing a settings-derived object the key. The file's OWN
  // top-level afterEach already restores the full process.env after every
  // test, so no extra cleanup is needed here.
  beforeEach(() => {
    process.env.TOKENSCOPE_STATE_DIR = join(tmp, '.tokenscope')
  })

  it('reads emit-failure.claude-code.json from the state dir', () => {
    mkdirSync(join(tmp, '.tokenscope'), { recursive: true })
    writeFileSync(join(tmp, '.tokenscope', 'emit-failure.claude-code.json'), JSON.stringify({ http_status: 401, message: 'x' }))
    expect(readEmitSentinel({})).toEqual({ http_status: 401, message: 'x' })
  })

  it("never reads another lane's sentinel as this one's (a failing Copilot lane is not a Claude failure)", () => {
    mkdirSync(join(tmp, '.tokenscope'), { recursive: true })
    writeFileSync(join(tmp, '.tokenscope', 'emit-failure.copilot-cli.json'), JSON.stringify({ http_status: 0, message: 'c' }))
    writeFileSync(join(tmp, '.tokenscope', 'emit-failure.json'), JSON.stringify({ http_status: 0, message: 'legacy' }))
    expect(readEmitSentinel({})).toBeNull()
    expect(readEmitSentinel({}, undefined, 'copilot-cli')).toEqual({ http_status: 0, message: 'c' })
  })
  it('returns null when no sentinel', () => {
    expect(readEmitSentinel({})).toBeNull()
  })

  it('an EXPLICIT dir wins over the ambient TOKENSCOPE_STATE_DIR', () => {
    /*
     * The sentinel answers "is emission healthy", and its ABSENCE reads as
     * healthy. So a caller that lets the ambient environment choose which
     * directory is searched lets a repository point it at an empty one and
     * report health it did not verify — masking a real, current failure.
     *
     * The status line was that caller. It now passes trustedStateDir()
     * explicitly, and this is the primitive that makes it work: a real sentinel
     * in the explicit dir is found even while the ambient value names a decoy
     * that has none.
     */
    const trusted = join(tmp, 'trusted-state')
    const decoy = join(tmp, 'repo-decoy')
    mkdirSync(trusted, { recursive: true })
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(trusted, 'emit-failure.claude-code.json'), JSON.stringify({ http_status: 401, message: 'real' }))
    process.env.TOKENSCOPE_STATE_DIR = decoy

    expect(
      readEmitSentinel(process.env, trusted),
      'the ambient state dir masked a live emit failure',
    ).toEqual({ http_status: 401, message: 'real' })
  })
})

describe.skipIf(POSIX_ONLY)('runEmitHelper', () => {
  function stubHelper(body: string) {
    const dir = join(tmp, 'scripts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'otel-headers-helper.sh')
    writeFileSync(path, body)
    // NOT via CLAUDE_PLUGIN_ROOT: resolveScriptsDir confines that to our own
    // install now, so steering it here would exercise the attacker's channel
    // rather than the caller's. runEmitHelper takes an explicit helperPath.
    return path
  }

  it('ran=true, status 0, hasAuth when the helper prints an Authorization bearer', () => {
    const helperPath = stubHelper('echo \'{"Authorization":"Bearer SECRET"}\'\nexit 0\n')
    const r = runEmitHelper({ helperPath })
    expect(r.ran).toBe(true)
    expect(r.status).toBe(0)
    expect(r.hasAuth).toBe(true)
  })

  it('hasAuth=false on a non-zero exit (auth failure)', () => {
    const helperPath = stubHelper('echo "boom" >&2\nexit 1\n')
    const r = runEmitHelper({ helperPath })
    expect(r.ran).toBe(true)
    expect(r.status).toBe(1)
    expect(r.hasAuth).toBe(false)
  })

  it('hasAuth=false when stdout is exit-0 but not a bearer object', () => {
    const helperPath = stubHelper('echo "not json"\nexit 0\n')
    const r = runEmitHelper({ helperPath })
    expect(r.status).toBe(0)
    expect(r.hasAuth).toBe(false)
  })

  it('ran=false when the helper is missing', () => {
    const r = runEmitHelper({ helperPath: join(tmp, 'empty', 'otel-headers-helper.sh') })
    expect(r.ran).toBe(false)
  })
})
