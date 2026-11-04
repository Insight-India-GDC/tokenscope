/*
 * otel-headers-helper.sh — CLIENT VERSION reporting on the /bearer mint.
 *
 * Every version-specific incident this project has had ended in "go ask the human
 * what version they are on". The helper now states what is running, on a call the
 * device already makes every ~29 minutes. Untested, this would be the easiest
 * thing in the codebase to break invisibly: the headers are optional, the server
 * stores NULL when they are missing, and NULL is a legitimate value — so a
 * regression that stopped sending them looks exactly like a fleet that has not
 * upgraded yet. Nothing would fail. Hence these tests.
 *
 * Driven with a stub `curl` on PATH (no live network) that logs its argv, so we
 * assert on what is ACTUALLY sent rather than on what the script appears to build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const REAL_HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')
const REAL_PLUGIN_JSON = resolve(__dirname, '../../../plugin/.claude-plugin/plugin.json')
const REAL_COPILOT_PLUGIN_JSON = resolve(__dirname, '../../../copilot-plugin/plugin.json')

let tmp: string
let stubDir: string
let stateDir: string
let argvLog: string
/** Helper copied into a plugin-shaped tree, so $0-relative plugin.json lookup is exercised. */
let helperPath: string

const STUB = `#!/bin/sh
# stub curl: logs argv, emulates -w '\\n%{http_code}' by printing <body>\\n<status>.
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

/**
 * Build a plugin-shaped tree and return the helper path inside it.
 *
 * TWO LAYOUTS, because this one script is vendored into BOTH plugins and the
 * parity gate (scripts/check-copilot-plugin-sync.mjs) keeps the copies byte-
 * identical — so the single file has to be correct in both trees:
 *   'claude'  → <root>/.claude-plugin/plugin.json   (plugin/)
 *   'copilot' → <root>/plugin.json                  (copilot-plugin/)
 * `pluginJson` null omits the manifest entirely (partial install).
 */
function installHelper(pluginJson: string | null, layout: 'claude' | 'copilot' = 'claude'): string {
  const root = join(tmp, 'plugin')
  // Rebuild from scratch: a re-install inside one test must not inherit the
  // previous tree's manifest, or the "missing manifest" case would pass
  // vacuously against a file that is still there.
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(REAL_HELPER, join(root, 'scripts', 'otel-headers-helper.sh'))
  if (pluginJson !== null) {
    if (layout === 'claude') {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), pluginJson)
    } else {
      writeFileSync(join(root, 'plugin.json'), pluginJson)
    }
  }
  return join(root, 'scripts', 'otel-headers-helper.sh')
}

function runHelper(env: Record<string, string> = {}) {
  // `--state-dir` and `--tool-dir` on argv, not in env: the helper prepends a
  // TRUSTED PATH before its first external command (a repo-set PATH would
  // otherwise choose the `curl` the refresh token is handed to), which would
  // shadow this file's stubs. `--tool-dir` is the trusted channel for putting
  // them back in front. Same reason `TOKENSCOPE_STATE_DIR` no longer works here.
  return spawnSync('sh', [helperPath, '--state-dir', stateDir, '--tool-dir', stubDir], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      // S1 fix 3: the helper pre-flight-validates both endpoints (https
      // required off-box) before any curl call.
      TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      STUB_ARGV: argvLog,
      ...env,
    },
  })
}

/** The argv line for the /bearer call (the OAuth POST is a separate line). */
function bearerArgv(): string {
  return readFileSync(argvLog, 'utf8')
    .split('\n')
    .find((l) => l.includes('/bearer')) ?? ''
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-ver-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  argvLog = join(tmp, 'argv.log')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(argvLog, '')
  const curl = join(stubDir, 'curl')
  writeFileSync(curl, STUB)
  chmodSync(curl, 0o755)
  /*
   * Redirect the passwd lookup at an empty temp home. With no store, the helper
   * resolves the credential and BOTH destinations from the device's own
   * ~/.claude/settings.json rather than the environment; left unstubbed that is
   * the DEVELOPER'S real file, so this fixture would run against a real
   * enrolment and never reach the endpoints it sets.
   */
  const passwdHome = join(tmp, 'passwd-home')
  mkdirSync(passwdHome, { recursive: true })
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(
    join(stubDir, 'getent'),
    `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`,
  )
  chmodSync(join(stubDir, 'getent'), 0o755)
  helperPath = installHelper('{"name":"tokenscope","version":"9.9.9"}')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('otel-headers-helper — client version headers', () => {
  it('sends the plugin version read from the plugin.json beside it', () => {
    // Anchored on $0, not on an env var: it must report the version of the code
    // that ACTUALLY ran. Those diverge exactly when a stale pinned helper path is
    // the bug being hunted.
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(bearerArgv()).toContain('X-TokenScope-Plugin-Version:9.9.9')
  })

  it('sends the CLI version parsed from CLAUDE_CODE_EXECPATH', () => {
    runHelper({ CLAUDE_CODE_EXECPATH: '/home/u/.local/share/claude/versions/2.1.212/claude' })
    expect(bearerArgv()).toContain('X-TokenScope-Client-Version:2.1.212')
  })

  it('parses a WINDOWS-style backslash exec path too', () => {
    // Copilot review flagged the bracket-expression form as implementation-
    // dependent across sed variants. This script runs on developer machines, not
    // on a runner we control, so the separator is normalised rather than matched
    // — and pinned here so a future "simplification" back to the bracket form
    // fails instead of quietly blinding every Windows device.
    runHelper({ CLAUDE_CODE_EXECPATH: 'C:\\Users\\x\\claude\\versions\\2.1.212\\claude.exe' })
    expect(bearerArgv()).toContain('X-TokenScope-Client-Version:2.1.212')
  })

  it('falls back to AI_AGENT when CLAUDE_CODE_EXECPATH is absent', () => {
    runHelper({ AI_AGENT: 'claude-code_2-1-211_agent' })
    expect(bearerArgv()).toContain('X-TokenScope-Client-Version:2.1.211')
  })

  it('prefers CLAUDE_CODE_EXECPATH over AI_AGENT when both are present', () => {
    runHelper({
      CLAUDE_CODE_EXECPATH: '/versions/2.1.212/claude',
      AI_AGENT: 'claude-code_1-0-0_agent',
    })
    expect(bearerArgv()).toContain('X-TokenScope-Client-Version:2.1.212')
    expect(bearerArgv()).not.toContain('1.0.0')
  })

  it('OMITS the CLI header when the version cannot be determined — never guesses', () => {
    // NULL on the server means "not reported", which is itself the signal. A
    // fabricated or defaulted value would destroy that signal.
    runHelper()
    const argv = bearerArgv()
    expect(argv).toContain('/bearer')
    expect(argv).not.toContain('X-TokenScope-Client-Version')
  })

  it('OMITS the plugin header when plugin.json is missing (partial install)', () => {
    helperPath = installHelper(null)
    const r = runHelper()
    expect(r.status).toBe(0) // and the mint still succeeds — reporting is never load-bearing
    expect(bearerArgv()).not.toContain('X-TokenScope-Plugin-Version')
  })

  it('still mints when the version headers cannot be built — diagnostics never break emission', () => {
    // The one hard rule: this is a diagnostic, and a diagnostic that can stop a
    // device emitting is a net loss.
    helperPath = installHelper('not json at all {{{')
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer')
  })

  it('DROPS a junk plugin version rather than sending it', () => {
    // Defence in depth with the server's own sanitiser: the value is interpolated
    // into a curl argument, so a value with whitespace or a quote is a correctness
    // problem here before it is a rendering problem there.
    helperPath = installHelper('{"version":"9.9.9 rc1; echo pwned"}')
    const r = runHelper()
    expect(r.status).toBe(0)
    const argv = bearerArgv()
    expect(argv).not.toContain('pwned')
    expect(argv).not.toContain('X-TokenScope-Plugin-Version')
  })

  it('sends the headers on the RETRY too, not just the first attempt', () => {
    // present_bearer runs twice on the superseded-token self-heal path. A
    // successful mint that happened on the retry must still report its version,
    // or a device with a churning credential would look like a non-reporter.
    const healStub = `#!/bin/sh
a="$*"
printf '%s\\n' "$a" >> "$STUB_ARGV"
case "$a" in
  *"/oauth/token"*) cat >/dev/null 2>&1 || true; printf '{"access_token":"fresh","expires_in":3600}\\n200' ;;
  *"/bearer"*)
    n=0; [ -f "$STUB_COUNTER" ] && n="$(cat "$STUB_COUNTER")"; n=$((n+1)); printf '%s' "$n" > "$STUB_COUNTER"
    if [ "$n" -eq 1 ]; then printf '{"statusMessage":"superseded"}\\n401'; else printf '{"Authorization":"Bearer stub-bearer"}\\n200'; fi ;;
  *) printf '\\n000' ;;
esac
exit 0
`
    const curl = join(stubDir, 'curl')
    writeFileSync(curl, healStub)
    chmodSync(curl, 0o755)
    // Seed a cached (now-superseded) token so the first /bearer uses it and 401s.
    // BOUND to the endpoint this run resolves to: the cache is part of the source
    // model now, so a record naming a different destination is discarded rather
    // than replayed, and this case needs the cached-token path to be reached.
    writeFileSync(
      join(stateDir, 'oauth-access.claude-code.json'),
      JSON.stringify({
        access_token: 'STALE',
        expires_at: 9999999999,
        bearer_endpoint: 'https://stub.local/api/v1/instances/x/bearer',
      }),
    )

    const r = runHelper({ STUB_COUNTER: join(tmp, 'counter'), CLAUDE_CODE_EXECPATH: '/versions/2.1.212/claude' })
    expect(r.status).toBe(0)
    const bearerLines = readFileSync(argvLog, 'utf8').split('\n').filter((l) => l.includes('/bearer'))
    expect(bearerLines).toHaveLength(2) // cached attempt + retry
    for (const line of bearerLines) {
      expect(line).toContain('X-TokenScope-Plugin-Version:9.9.9')
      expect(line).toContain('X-TokenScope-Client-Version:2.1.212')
    }
  })

  it('never puts the emit credential in a version header', () => {
    // Guards the deliberate unquoted expansion of $VERSION_HEADER_ARGS: the header
    // arguments must carry nothing but the version / platform / surface tokens.
    const r = runHelper({ TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'SECRET-REFRESH-VALUE', CLAUDE_CODE_EXECPATH: '/versions/2.1.212/claude' })
    expect(r.status).toBe(0)
    const argv = bearerArgv()
    expect(argv).not.toContain('SECRET-REFRESH-VALUE')
    expect(argv).toContain('X-TokenScope-Plugin-Version:9.9.9')
  })
})

/** Stub `uname` (found first via --tool-dir) so the platform is the test's choice, not the runner's. */
function stubUname(sys: string, machine: string) {
  const p = join(stubDir, 'uname')
  writeFileSync(p, `#!/bin/sh\ncase "$1" in -s) echo '${sys}' ;; -m) echo '${machine}' ;; esac\n`)
  chmodSync(p, 0o755)
}

/** Same as runHelper, on an explicit lane. */
function runHelperTool(tool: 'claude-code' | 'copilot-cli', env: Record<string, string> = {}) {
  return spawnSync('sh', [helperPath, '--state-dir', stateDir, '--tool-dir', stubDir, '--tool', tool], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      STUB_ARGV: argvLog,
      ...env,
    },
  })
}

describe.skipIf(POSIX_ONLY)('otel-headers-helper — client platform + surface headers (#412)', () => {
  it.each([
    ['Linux', 'x86_64', 'linux-x64'],
    ['Linux', 'aarch64', 'linux-arm64'],
    ['Darwin', 'arm64', 'darwin-arm64'],
    ['Darwin', 'x86_64', 'darwin-x64'],
    ['MINGW64_NT-10.0-26100', 'x86_64', 'win32-x64'],
    ['MSYS_NT-10.0', 'x86_64', 'win32-x64'],
  ])('maps uname %s/%s to Node vocabulary %s', (sys, machine, expected) => {
    stubUname(sys, machine)
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(bearerArgv()).toContain(`X-TokenScope-Client-Platform:${expected}`)
  })

  it.each([
    ['FreeBSD', 'x86_64'],
    ['Linux', 'riscv64'],
  ])('OMITS the platform header for an unrecognised %s/%s — never guesses', (sys, machine) => {
    stubUname(sys, machine)
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(bearerArgv()).toContain('/bearer')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Platform')
  })

  it('sends CLAUDE_CODE_ENTRYPOINT verbatim as the surface on the claude-code lane', () => {
    runHelper({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    expect(bearerArgv()).toContain('X-TokenScope-Client-Surface:sdk-cli')
  })

  it('OMITS the surface when CLAUDE_CODE_ENTRYPOINT is absent', () => {
    runHelper()
    expect(bearerArgv()).toContain('/bearer')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Surface')
  })

  it('DROPS a junk entrypoint rather than sending it', () => {
    const r = runHelper({ CLAUDE_CODE_ENTRYPOINT: 'cli; echo pwned' })
    expect(r.status).toBe(0)
    expect(bearerArgv()).not.toContain('pwned')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Surface')
  })

  it("ignores AI_AGENT on the claude-code lane (it is Copilot's surface signal)", () => {
    runHelper({ AI_AGENT: 'github_copilot_app_agent' })
    expect(bearerArgv()).toContain('/bearer')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Surface')
  })

  it.each([
    ['github_copilot_app_agent', 'app'],
    ['github_copilot_cli_agent', 'cli'],
  ])('copilot-cli lane: AI_AGENT=%s → surface %s', (agent, surface) => {
    const r = runHelperTool('copilot-cli', { AI_AGENT: agent, CLAUDE_CODE_ENTRYPOINT: 'entrypoint-must-not-win' })
    expect(r.status).toBe(0)
    expect(bearerArgv()).toContain(`X-TokenScope-Client-Surface:${surface}`)
    expect(bearerArgv()).not.toContain('entrypoint-must-not-win')
  })

  it('copilot-cli lane: an absent or foreign AI_AGENT sends NO surface (no default to cli)', () => {
    // The forwarder mints without AI_AGENT even on an App device; a `cli` default
    // would overwrite a true `app` reading on every such mint.
    expect(runHelperTool('copilot-cli').status).toBe(0)
    expect(bearerArgv()).toContain('/bearer')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Surface')
    writeFileSync(argvLog, '')
    expect(runHelperTool('copilot-cli', { AI_AGENT: 'claude-code_2-1-211_agent' }).status).toBe(0)
    expect(bearerArgv()).toContain('/bearer')
    expect(bearerArgv()).not.toContain('X-TokenScope-Client-Surface')
  })
})

describe.skipIf(POSIX_ONLY)('the SHIPPED plugins report a real version', () => {
  it('plugin/.claude-plugin/plugin.json carries a version the helper will actually send', () => {
    // The tests above use a synthetic manifest. This pins the real one: a
    // malformed or missing version there would ship a fleet that silently reports
    // nothing, which is indistinguishable from a fleet that has not upgraded.
    const real = JSON.parse(readFileSync(REAL_PLUGIN_JSON, 'utf8'))
    expect(real.version).toMatch(/^\d+\.\d+\.\d+$/)
    helperPath = installHelper(readFileSync(REAL_PLUGIN_JSON, 'utf8'))
    runHelper()
    expect(bearerArgv()).toContain(`X-TokenScope-Plugin-Version:${real.version}`)
  })

  it('the COPILOT plugin layout resolves too — its manifest is at plugin.json, not .claude-plugin/', () => {
    /*
     * This script is vendored into copilot-plugin/scripts/ byte-identically, but
     * that tree puts its manifest one level up at plugin.json. A lookup that only
     * knew the Claude layout would find nothing there and send no header — and
     * because "no header" legitimately means "not reported", the ENTIRE Copilot
     * fleet would read as permanently un-upgraded with no error anywhere. Silent,
     * plausible, and wrong: exactly the failure mode this feature exists to end.
     */
    const real = JSON.parse(readFileSync(REAL_COPILOT_PLUGIN_JSON, 'utf8'))
    expect(real.version).toMatch(/^\d+\.\d+\.\d+$/)
    helperPath = installHelper(readFileSync(REAL_COPILOT_PLUGIN_JSON, 'utf8'), 'copilot')
    runHelper()
    expect(bearerArgv()).toContain(`X-TokenScope-Plugin-Version:${real.version}`)
  })

  it('the vendored Copilot copy is the same script (parity gate holds at runtime, not just in CI)', () => {
    // check-copilot-plugin-sync.mjs asserts byte parity ignoring its SYNC NOTE
    // header. Assert the behaviour that parity is FOR: the copy actually reports.
    const copilotHelper = resolve(__dirname, '../../../copilot-plugin/scripts/otel-headers-helper.sh')
    const root = join(tmp, 'plugin')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(copilotHelper, join(root, 'scripts', 'otel-headers-helper.sh'))
    writeFileSync(join(root, 'plugin.json'), readFileSync(REAL_COPILOT_PLUGIN_JSON, 'utf8'))
    helperPath = join(root, 'scripts', 'otel-headers-helper.sh')
    const r = runHelper()
    expect(r.status).toBe(0)
    const version = JSON.parse(readFileSync(REAL_COPILOT_PLUGIN_JSON, 'utf8')).version
    expect(bearerArgv()).toContain(`X-TokenScope-Plugin-Version:${version}`)
  })
})
