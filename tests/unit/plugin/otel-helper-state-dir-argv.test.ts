// @vitest-environment node
/*
 * otel-headers-helper.sh — the state dir is an ARGUMENT, never an environment
 * variable (audit round 2 follow-up).
 *
 * WHY THIS FILE EXISTS. `hookStateDir()` repairs the SessionStart hook's own
 * `process.env`. It cannot reach `otelHeadersHelper`, which **Claude Code**
 * invokes — a sibling process of every hook, spawned about every 29 minutes to
 * mint the emit bearer, carrying Claude Code's own repo-merged environment.
 * Captured, not reasoned (docs/security-sprint/repo-env-inheritance-capture.md):
 * a repository shipping `{"env":{"TOKENSCOPE_STATE_DIR":"<repo>/exfil"}}` got a
 * live emit ACCESS TOKEN written into its own working tree — and the same probe
 * re-run WITH the hook fix installed still collected the token, because the hook
 * was never in that code path.
 *
 * So the channel moves to one the settings merge cannot write: argv. Nothing in
 * a settings file contributes arguments to `otelHeadersHelper`.
 *
 * These tests drive the REAL script (no mock), because the whole claim is about
 * what the shipped file does with its own environment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')

/*
 * THE NO-ARGUMENT CASES MUST NOT TOUCH THE REAL DEVICE.
 *
 * With no `--state-dir` the helper resolves the passwd home — that is the fix —
 * so the obvious test writes a failure sentinel into the developer's own
 * `~/.tokenscope`, where `/tokenscope:status` later reads it and reports a fault
 * that never happened. A snapshot-and-restore around it is NOT enough, and this
 * file learned that the hard way: one run left a sentinel behind, the next run
 * snapshotted it as "pre-existing" and faithfully restored it, and a test
 * artefact was thereby promoted to a genuine-looking emission failure.
 *
 * So the passwd lookup itself is redirected instead. `passwd_home()` shells out
 * to `id` and `getent`, both resolved by name, and `--tool-dir` is the trusted
 * channel for putting stubs in front of them — so a stubbed passwd database
 * points the "real" home at a temp dir. The assertions then get to be POSITIVE
 * (the sentinel lands exactly HERE) rather than merely "not in the attacker's
 * directory", which an implementation that wrote nowhere would also satisfy.
 */
let tmp: string
let stubDir: string
let argDir: string
let envDir: string
/** Where the STUBBED passwd database says this account's home is. */
let passwdHome: string

/*
 * A `curl` stub that always fails, so the helper reaches its "write the failure
 * sentinel" path without touching the network. The sentinel is the observable:
 * it is written into the helper's resolved STATE_DIR, so WHICH directory it
 * lands in is exactly the fact under test.
 */
const CURL_STUB = `#!/bin/sh
exit 7
`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-argv-'))
  stubDir = join(tmp, 'stub')
  argDir = join(tmp, 'from-argv')
  envDir = join(tmp, 'from-env')
  passwdHome = join(tmp, 'passwd-home')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(argDir, { recursive: true })
  mkdirSync(envDir, { recursive: true })
  mkdirSync(passwdHome, { recursive: true })
  writeFileSync(join(stubDir, 'curl'), CURL_STUB)
  chmodSync(join(stubDir, 'curl'), 0o755)
  // A stubbed passwd database: `id -un` names a user, `getent passwd <user>`
  // returns a line whose 6th field is our temp home. This is what keeps the
  // no-argument cases off the developer's real ~/.tokenscope.
  writeFileSync(join(stubDir, 'id'), '#!/bin/sh\nprintf \'tsprobe\\n\'\n')
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(
    join(stubDir, 'getent'),
    `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`,
  )
  chmodSync(join(stubDir, 'getent'), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('sh', [HELPER, '--tool-dir', stubDir, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      ...env,
    },
  })
}

const sentinel = (dir: string) => join(dir, 'emit-failure.claude-code.json')

describe.skipIf(POSIX_ONLY)('the state dir comes from argv', () => {
  it('--state-dir places the sentinel and token cache', () => {
    run(['--state-dir', argDir])
    expect(existsSync(sentinel(argDir))).toBe(true)
  })

  it('IGNORES TOKENSCOPE_STATE_DIR — the variable a repository can set', () => {
    // The exact shape captured against Claude Code 2.1.232: the variable is
    // present in the environment, and names a directory the caller never chose.
    run(['--state-dir', argDir], { TOKENSCOPE_STATE_DIR: envDir })

    expect(existsSync(sentinel(argDir))).toBe(true)
    expect(existsSync(sentinel(envDir))).toBe(false)
  })

  it('IGNORES TOKENSCOPE_STATE_DIR when there is no argument either', () => {
    // Claude Code's own invocation passes NO arguments. That is the path the
    // capture exploited, and the one that must land on the passwd home.
    const r = run([], { TOKENSCOPE_STATE_DIR: envDir })

    expect(existsSync(sentinel(envDir))).toBe(false)
    // POSITIVE assertion too, not just "not the attacker's dir": an
    // implementation that resolved somewhere else entirely — or nowhere — would
    // satisfy the negative on its own. This is the pair that pins the default,
    // and it can be positive precisely because the passwd lookup is stubbed.
    expect(existsSync(join(passwdHome, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(true)
    // It ran the emit path rather than refusing to start.
    expect(r.status).not.toBe(2)
  })

  it('IGNORES a moved $HOME, which is equally repo-settable', () => {
    run([], { HOME: envDir })
    expect(existsSync(join(envDir, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(false)
    expect(existsSync(join(passwdHome, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(true)
  })
})

describe.skipIf(POSIX_ONLY)('the tools the refresh token is handed to are not repo-selectable', () => {
  it('does NOT run a `curl` planted on a hostile PATH', () => {
    // The capture showed PATH is repo-settable and reaches this script, which
    // Claude Code invokes directly holding TOKENSCOPE_OAUTH_REFRESH_TOKEN. A
    // planted `curl` would simply be handed the token. The helper prepends a
    // trusted PATH before its first external command; no --tool-dir here,
    // because that is the whole point.
    const hostile = join(tmp, 'hostile-bin')
    const marker = join(tmp, 'HOSTILE-CURL-RAN.txt')
    mkdirSync(hostile, { recursive: true })
    writeFileSync(join(hostile, 'curl'), `#!/bin/sh\ntouch "${marker}"\nexit 7\n`)
    chmodSync(join(hostile, 'curl'), 0o755)

    spawnSync('sh', [HELPER, '--state-dir', argDir], {
      encoding: 'utf8',
      env: {
        PATH: `${hostile}:${process.env.PATH}`,
        TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
        TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
        TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      },
    })

    expect(existsSync(marker)).toBe(false)
  })

  it('passes `-q` first, so a planted .curlrc / CURL_HOME cannot configure curl', () => {
    // Without -q, curl reads ~/.curlrc (or $CURL_HOME/.curlrc) BEFORE any of our
    // flags — enough to add a proxy, trust an attacker CA, or dump the
    // refresh-token request body to a file.
    const argvLog = join(tmp, 'curl-argv.txt')
    writeFileSync(join(stubDir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${argvLog}"\nexit 7\n`)
    chmodSync(join(stubDir, 'curl'), 0o755)

    run(['--state-dir', argDir])

    expect(existsSync(argvLog)).toBe(true)
    const firstArgs = readFileSync(argvLog, 'utf8').trim().split('\n')
    expect(firstArgs.length).toBeGreaterThan(0)
    for (const a of firstArgs) expect(a).toBe('-q')
  })
})

describe.skipIf(POSIX_ONLY)('argv is validated, not merely read', () => {
  it('refuses an unknown argument rather than ignoring it', () => {
    // Same rule argv-guard.mjs applies to the redeem helpers: a flag this script
    // does not implement is argv nobody in the product wrote. Tolerating it is
    // how `--redeem-url` survived.
    const r = run(['--redeem-url', 'https://evil.example'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown argument/)
  })

  it('refuses --state-dir with no value instead of reinterpreting the next token', () => {
    const r = run(['--state-dir'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/requires a value/)
  })

  it('resolves the home from dscl when getent is absent (the macOS shape)', () => {
    // macOS has no `getent` AND keeps regular accounts in Directory Services,
    // not /etc/passwd — so a getent-plus-/etc/passwd implementation finds
    // nothing there and every Mac falls through to the repo-settable $HOME,
    // making the whole anchor a no-op on the platform most devs use. Stub the
    // macOS shape: no getent, a working dscl.
    const macos = join(tmp, 'macos-bin')
    const dsclHome = join(tmp, 'dscl-home')
    mkdirSync(macos, { recursive: true })
    mkdirSync(dsclHome, { recursive: true })
    writeFileSync(join(macos, 'id'), "#!/bin/sh\nprintf 'tsprobe\\n'\n")
    writeFileSync(join(macos, 'getent'), '#!/bin/sh\nexit 127\n') // absent on macOS
    writeFileSync(
      join(macos, 'dscl'),
      `#!/bin/sh\nprintf 'NFSHomeDirectory: %s\\n' "${dsclHome}"\n`,
    )
    writeFileSync(join(macos, 'curl'), CURL_STUB)
    for (const f of ['id', 'getent', 'dscl', 'curl']) chmodSync(join(macos, f), 0o755)

    const r = spawnSync('sh', [HELPER, '--tool-dir', macos], {
      encoding: 'utf8',
      env: {
        PATH: `${macos}:${process.env.PATH}`,
        HOME: envDir, // the repo-settable value that must NOT win
        TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
        TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
        TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      },
    })

    expect(existsSync(join(dsclHome, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(true)
    expect(existsSync(join(envDir, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(false)
    // No fallback happened, so no degradation warning either.
    expect(r.stderr).not.toMatch(/no passwd entry/)
  })

  it('WARNS instead of degrading silently when there is no passwd entry', () => {
    // The last-resort branch of passwd_home follows $HOME, which re-opens exactly
    // what the anchor exists to close. On a minimal container with no passwd
    // entry for the uid that is reachable, and a silent fallback there looks
    // identical to the anchor working. Stub `id` to fail to reach it.
    const failingId = join(tmp, 'no-passwd')
    mkdirSync(failingId, { recursive: true })
    writeFileSync(join(failingId, 'id'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(failingId, 'id'), 0o755)
    // getent must fail too, or the real passwd database answers and the
    // fallback branch is never reached.
    writeFileSync(join(failingId, 'getent'), '#!/bin/sh\nexit 2\n')
    chmodSync(join(failingId, 'getent'), 0o755)
    // …and dscl, the macOS source, or a Mac would resolve fine and never reach
    // the fallback branch under test.
    writeFileSync(join(failingId, 'dscl'), '#!/bin/sh\nexit 2\n')
    chmodSync(join(failingId, 'dscl'), 0o755)

    const r = spawnSync('sh', [HELPER, '--tool-dir', failingId], {
      encoding: 'utf8',
      env: {
        PATH: `${failingId}:${stubDir}:${process.env.PATH}`,
        HOME: envDir, // the fallback target — kept inside tmp so nothing real is touched
        TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
        TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
        TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      },
    })

    expect(r.stderr).toMatch(/no passwd entry/)
    // …and it really did fall back there, so the warning is not decoration.
    expect(existsSync(join(envDir, '.tokenscope', 'emit-failure.claude-code.json'))).toBe(true)
  })

  it.each([
    ['an empty value', ''],
    ['a relative path', 'relative/state'],
    ['an option-like path', '--force'],
  ])('refuses %s for --state-dir', (_label, value) => {
    // Empty would make every path start at `/`; relative would put the token
    // cache under the cwd, which for a hook IS the repository; option-like turns
    // into a flag for the mkdir/rm that follow, quoting notwithstanding.
    const r = run(['--state-dir', value])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/absolute path|requires a value/)
  })

  it('never echoes the rejected argument back to stderr', () => {
    // argv here is model-composable in the Copilot lane; the message must not
    // hand a terminal whatever bytes the caller chose.
    const r = run(['--[31mBOOM'])
    expect(r.status).toBe(2)
    expect(r.stderr).not.toContain('BOOM')
    expect(r.stderr).not.toContain('')
  })
})
