/*
 * otel-headers-helper.sh — one store per tool, and the refusals around it.
 *
 * Drives the REAL script against a stub `curl`: the claim under test is which
 * file the shipped helper opens and when it refuses. Why per-tool, and the
 * source/refusal rules asserted here: docs/design/device-store-per-tool-sections.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')

const CLAUDE_INSTANCE = 'claude-one'
const COPILOT_INSTANCE = 'copilot-one'
const bearerFor = (id: string) => `https://device.local/api/v1/instances/${id}/bearer`
const TOKEN_EP = 'https://device.local/api/v1/oauth/token'

const STUB = `#!/bin/sh
# stub curl: emulates -w '\\n%{http_code}' by printing <body>\\n<status>.
a="$*"
printf '%s\\n' "$a" >> "$STUB_ARGV"
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true
    printf '{"access_token":"stub-access","expires_in":3600}\\n200' ;;
  *"/bearer"*) printf '{"Authorization":"Bearer stub-bearer"}\\n200' ;;
  *) printf '\\n000' ;;
esac
exit 0
`

let tmp: string
let stubDir: string
let stateDir: string
let argvLog: string
/*
 * Where the STUBBED passwd database says this account's home is.
 *
 * `passwd_home()` shells out to `id` and `getent`, both resolved by name, and
 * `--tool-dir` is the trusted channel for putting stubs in front of them. Without
 * this the helper resolves the DEVELOPER'S real home and reads their actual
 * ~/.claude/settings.json to decide store ownership — so the tests would depend
 * on the machine they run on, and would touch a real credential file.
 */
let passwdHome: string
/** Write the fake GLOBAL ~/.claude/settings.json the helper is allowed to trust. */
function writeTrustedSettings(env: Record<string, string>) {
  mkdirSync(join(passwdHome, '.claude'), { recursive: true })
  writeFileSync(join(passwdHome, '.claude', 'settings.json'), JSON.stringify({ env }, null, 2))
}

const sentinel = () => join(stateDir, 'emit-failure.claude-code.json')
const sentinelMessage = () =>
  existsSync(sentinel()) ? (JSON.parse(readFileSync(sentinel(), 'utf8')).message as string) : null
/** Every URL the stub curl was asked for, in order. */
const curlTargets = () =>
  existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : []

function v2(tool: string, instance: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2,
    tool,
    instance_id: instance,
    bearer_endpoint: bearerFor(instance),
    oauth_token_endpoint: TOKEN_EP,
    oauth_client_id: 'cid',
    oauth_refresh_token: `rt-${tool}`,
    otel_resource_attributes: `tokenscope.instance_id=${instance},tool=${tool}`,
    ...extra,
  })
}

function run(tool: string | null, env: Record<string, string> = {}) {
  const args = [HELPER, '--state-dir', stateDir, '--tool-dir', stubDir]
  if (tool) args.push('--tool', tool)
  return spawnSync('sh', args, {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      STUB_ARGV: argvLog,
      ...env,
    },
  })
}

/** The environment a hostile repo contributes: a credential and its own endpoints. */
const REPO_ENV = {
  TOKENSCOPE_BEARER_ENDPOINT: 'https://evil.example/api/v1/instances/evil/bearer',
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://evil.example/token',
  TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-from-env',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-pertool-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  argvLog = join(tmp, 'argv.txt')
  passwdHome = join(tmp, 'passwd-home')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(passwdHome, { recursive: true })
  const curl = join(stubDir, 'curl')
  writeFileSync(curl, STUB)
  chmodSync(curl, 0o755)
  // Redirect the passwd lookup so "the real home" is a temp dir.
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(
    join(stubDir, 'getent'),
    `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`,
  )
  chmodSync(join(stubDir, 'getent'), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('each lane reads its OWN store', () => {
  it('the claude lane uses config.claude-code.json even when a copilot store sits beside it', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    writeFileSync(join(stateDir, 'config.copilot-cli.json'), v2('copilot-cli', COPILOT_INSTANCE))
    const r = run('claude-code')
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(CLAUDE_INSTANCE))
    expect(curlTargets().join(' ')).not.toContain(bearerFor(COPILOT_INSTANCE))
  })

  it('the copilot lane uses config.copilot-cli.json in the same directory', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    writeFileSync(join(stateDir, 'config.copilot-cli.json'), v2('copilot-cli', COPILOT_INSTANCE))
    const r = run('copilot-cli')
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(COPILOT_INSTANCE))
    expect(curlTargets().join(' ')).not.toContain(bearerFor(CLAUDE_INSTANCE))
  })

  it('the access-token cache is per tool, so one lane cannot present the other lane token', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    expect(run('claude-code').status).toBe(0)
    expect(existsSync(join(stateDir, 'oauth-access.claude-code.json'))).toBe(true)
    expect(existsSync(join(stateDir, 'oauth-access.copilot-cli.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'oauth-access.json'))).toBe(false)
  })

  it('defaults to the claude lane when no --tool is given (Claude Code passes no arguments)', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    const r = run(null)
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(CLAUDE_INSTANCE))
  })

  it('refuses an unknown --tool rather than deriving a filename from it', () => {
    const r = run('../../etc/passwd')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--tool must be/)
  })
})

describe.skipIf(POSIX_ONLY)('a legacy shared store is claimed only by the lane that can prove it', () => {
  /*
   * THE 2026-09-09 SHAPE, exactly: the pre-split file holds the COPILOT
   * enrolment, and the Claude lane must not pair its credential with it.
   */
  it('the claude lane never USES a legacy store naming another instance', () => {
    /*
     * Previously a terminal refusal. Under the source table an unclaimable
     * legacy store is ABSENT for this lane, so resolution continues rather than
     * the device going dark — see the design doc's source table.
     *
     * The security property is unchanged and is what this asserts: the OTHER
     * lane's durable credential is never used and never leaves. Here nothing
     * lower supplies one either, so the run gets no further.
     */
    writeFileSync(join(stateDir, 'config.json'), v2('copilot-cli', COPILOT_INSTANCE))
    const r = run('claude-code')
    expect(r.status).toBe(1)
    // the foreign enrolment's endpoint was never contacted
    expect(curlTargets().join(' ')).not.toContain(bearerFor(COPILOT_INSTANCE))
  })

  it('falls through an unclaimable legacy store to its OWN settings, and still shuns the repo env', () => {
    writeFileSync(join(stateDir, 'config.json'), v2('copilot-cli', COPILOT_INSTANCE))
    writeTrustedSettings({
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-device',
      TOKENSCOPE_BEARER_ENDPOINT: bearerFor(CLAUDE_INSTANCE),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })
    const r = run('claude-code', REPO_ENV)
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(CLAUDE_INSTANCE))
    expect(curlTargets().join(' ')).not.toContain('evil.example')
    expect(curlTargets().join(' ')).not.toContain(bearerFor(COPILOT_INSTANCE))
  })

  it("a failing COPILOT lane writes only its own sentinel; the Claude lane's success leaves it, and vice versa", () => {
    // The 2026-09-24 shape: the legacy store has no credential, so the Copilot lane
    // refuses, while the Claude lane has its own healthy store.
    writeFileSync(join(stateDir, 'config.json'), v2('copilot-cli', COPILOT_INSTANCE, { oauth_refresh_token: '' }))
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    const copilotSentinel = join(stateDir, 'emit-failure.copilot-cli.json')
    const claudeSentinel = join(stateDir, 'emit-failure.claude-code.json')

    expect(run('copilot-cli').status).not.toBe(0)
    expect(JSON.parse(readFileSync(copilotSentinel, 'utf8')).message).toBe('legacy store present but incomplete')
    expect(existsSync(claudeSentinel)).toBe(false)

    expect(run('claude-code').status).toBe(0)
    expect(existsSync(claudeSentinel)).toBe(false)
    expect(existsSync(copilotSentinel)).toBe(true) // not the Claude lane's to clear
  })

  it('the copilot lane still reads a legacy store, so an un-migrated device keeps emitting', () => {
    writeFileSync(join(stateDir, 'config.json'), v2('copilot-cli', COPILOT_INSTANCE))
    const r = run('copilot-cli')
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(COPILOT_INSTANCE))
  })

  /*
   * THE NO-STORE WINDOW. An enrolled device can hold a durable credential in its
   * global settings and have no store yet: before its first redeem under the
   * per-tool layout, or in the gap before the session-start migration mints one.
   * The credential then came from the device while the DESTINATION came from the
   * process environment, which Claude Code merges a repository's settings env
   * into. That is the original MDASH pairing one path along, so the endpoints are
   * read from the device's own settings file too, all-or-nothing.
   */
  it('with no store, endpoints come from the trusted settings file, NOT the repo env', () => {
    writeTrustedSettings({
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-device',
      TOKENSCOPE_BEARER_ENDPOINT: bearerFor(CLAUDE_INSTANCE),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })
    const r = run('claude-code', REPO_ENV) // the repo supplies evil.example
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(CLAUDE_INSTANCE))
    expect(curlTargets().join(' ')).not.toContain('evil.example')
  })

  it('REFUSES when the settings file holds a credential but not both destinations', () => {
    writeTrustedSettings({
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-device',
      // no endpoints of its own: taking them from the env is the exfiltration
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })
    const r = run('claude-code', REPO_ENV)
    expect(r.status).toBe(1)
    expect(sentinelMessage()).toBe('settings credential without both settings endpoints')
    expect(curlTargets()).toHaveLength(0)
  })

  it('a device with NO store and NO settings credential still uses the environment', () => {
    const r = run('claude-code', {
      TOKENSCOPE_BEARER_ENDPOINT: bearerFor(CLAUDE_INSTANCE),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-env',
    })
    expect(r.status).toBe(0)
    expect(sentinelMessage()).toBeNull()
  })

  it('this lane own store WINS over a legacy one that is still on disk', () => {
    writeFileSync(join(stateDir, 'config.json'), v2('copilot-cli', COPILOT_INSTANCE))
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('claude-code', CLAUDE_INSTANCE))
    const r = run('claude-code')
    expect(r.status).toBe(0)
    expect(curlTargets().join(' ')).toContain(bearerFor(CLAUDE_INSTANCE))
  })
})

describe.skipIf(POSIX_ONLY)('a present store that cannot be read is NOT treated as no store', () => {
  /*
   * The boundary this whole design states: only a device with NO store of any
   * kind uses the environment. Every consistency check below is conditional on a
   * non-empty field, so an unreadable file contributed nothing and the helper
   * fell through to the ambient environment — which on the Claude lane a
   * repository can supply. That is a downgrade reachable by truncating a file.
   */
  it.each([
    ['empty', ''],
    ['not json', 'this is not json at all'],
    ['truncated mid-write', '{"version":2,"tool":"claude-code","bearer_e'],
    ['json but not an enrolment', '{"hello":"world"}'],
  ])('refuses a %s store instead of using the environment', (_label, contents) => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), contents)
    const r = run('claude-code', REPO_ENV)
    expect(r.status).toBe(1)
    expect(sentinelMessage()).toBe('store present but unreadable')
    // and it did NOT reach the repo-supplied endpoint
    expect(curlTargets().join(' ')).not.toContain('evil.example')
    expect(curlTargets()).toHaveLength(0)
  })
})

describe.skipIf(POSIX_ONLY)('a store that contradicts itself is refused, not used', () => {
  it('refuses when the file declares a different tool than the lane reading it', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), v2('copilot-cli', CLAUDE_INSTANCE))
    const r = run('claude-code')
    expect(r.status).toBe(1)
    expect(sentinelMessage()).toBe('store tool mismatch')
    expect(curlTargets()).toHaveLength(0)
  })

  it('refuses when the resource attributes carry another lane marker', () => {
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      v2('claude-code', CLAUDE_INSTANCE, {
        otel_resource_attributes: `tokenscope.instance_id=${CLAUDE_INSTANCE},tool=copilot-cli`,
      }),
    )
    const r = run('claude-code')
    expect(r.status).toBe(1)
    expect(sentinelMessage()).toBe('store marker mismatch')
  })

  it('refuses when the bearer endpoint addresses an instance the file does not name', () => {
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      v2('claude-code', CLAUDE_INSTANCE, { bearer_endpoint: bearerFor(COPILOT_INSTANCE) }),
    )
    const r = run('claude-code')
    expect(r.status).toBe(1)
    expect(sentinelMessage()).toBe('store instance/endpoint mismatch')
    expect(curlTargets()).toHaveLength(0)
  })
})
