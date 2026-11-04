/*
 * otel-headers-helper.sh — the retry-once-on-401 self-heal (ADR-0007 follow-up).
 *
 * A CACHED OAuth access token that /bearer rejects (401/403) was likely
 * superseded (concurrent CW / out-of-band refresh / deploy) — the helper must
 * drop the cache, force ONE fresh refresh, and retry, rather than drop the emit
 * cycle and trip the proactive warning. A genuinely revoked credential fails the
 * refresh, or 401s the retry too (fatal).
 *
 * We drive the helper with a stub `curl` on PATH (no live network) that
 * distinguishes the OAuth-token POST from the /bearer GET and alternates the
 * /bearer status via a counter file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')

let tmp: string
let stubDir: string
let stateDir: string

const STUB = `#!/bin/sh
# stub curl: emulates -w '\\n%{http_code}' by printing <body>\\n<status>.
a="$*"
[ -n "\${STUB_ARGV:-}" ] && printf '%s\\n' "$a" >> "$STUB_ARGV"
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true   # drain the --data-binary @- stdin
    if [ "\${STUB_TOKEN_FAIL:-0}" = "1" ]; then printf '{"error":"invalid_grant"}\\n400'
    else printf '{"access_token":"stub-access","expires_in":3600}\\n200'; fi ;;
  *"/bearer"*)
    n=0; [ -f "$STUB_COUNTER" ] && n="$(cat "$STUB_COUNTER")"; n=$((n+1)); printf '%s' "$n" > "$STUB_COUNTER"
    case "\${STUB_BEARER_MODE:-heal}" in
      ok)   printf '{"Authorization":"Bearer stub-bearer"}\\n200' ;;
      fail) printf '{"statusMessage":"revoked"}\\n401' ;;
      *)    if [ "$n" -eq 1 ]; then printf '{"statusMessage":"superseded"}\\n401'; else printf '{"Authorization":"Bearer stub-bearer"}\\n200'; fi ;;
    esac ;;
  *) printf '\\n000' ;;
esac
exit 0
`

// The state dir arrives as an ARGUMENT, not `TOKENSCOPE_STATE_DIR`: the helper
// stopped reading that variable because Claude Code invokes it directly with a
// repository's merged settings env (docs/security-sprint/repo-env-inheritance-capture.md).
// `HOME` is still set here only to prove it is IGNORED — see the anchor tests.
function runHelper(env: Record<string, string>) {
  return spawnSync('sh', [HELPER, '--state-dir', stateDir, '--tool-dir', stubDir], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      // S1 fix 3: the helper now pre-flight-validates both endpoints (https
      // required off-box) before any curl call — https:// here, not http://,
      // so this fixture exercises the retry logic through the validator
      // rather than getting rejected by it.
      TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      STUB_COUNTER: join(tmp, 'counter'),
      ...env,
    },
  })
}

function bearerCalls() {
  const f = join(tmp, 'counter')
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
}
const BEARER_EP = 'https://stub.local/api/v1/instances/x/bearer'
/*
 * The cache is BOUND to the bearer endpoint it was minted for, so a fixture has
 * to record the endpoint this run resolves to or it is (correctly) discarded as
 * belonging to a different destination.
 */
function seedBogusCache(bearerEndpoint: string = BEARER_EP) {
  writeFileSync(
    join(stateDir, 'oauth-access.claude-code.json'),
    JSON.stringify({ access_token: 'BOGUS', expires_at: 9999999999, bearer_endpoint: bearerEndpoint }),
  )
}
const sentinelExists = () => existsSync(join(stateDir, 'emit-failure.claude-code.json'))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const curl = join(stubDir, 'curl')
  writeFileSync(curl, STUB)
  chmodSync(curl, 0o755)
  /*
   * Redirect the passwd lookup at a temp home with NO ~/.claude/settings.json.
   *
   * With no store, the helper now sources the credential and BOTH destinations
   * from the device's own global settings file rather than the process env
   * (a repository can contribute to the env; it cannot edit that file). Left
   * unstubbed, `passwd_home()` resolves the DEVELOPER'S real home, so these
   * fixtures would silently run against a real enrolment and the assertions
   * would depend on the machine.
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
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('otel-headers-helper retry-once-on-401', () => {
  it('self-heals a superseded cached token: 401 → force refresh → retry → 200', () => {
    seedBogusCache()
    const r = runHelper({ STUB_BEARER_MODE: 'heal' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer') // the retry minted a real bearer
    expect(bearerCalls()).toBe(2) // cached attempt + one retry
    expect(sentinelExists()).toBe(false) // no cry-wolf
  })

  it('a genuinely revoked credential still fails after the retry (exit 1 + sentinel)', () => {
    seedBogusCache()
    const r = runHelper({ STUB_BEARER_MODE: 'fail' })
    expect(r.status).toBe(1)
    expect(bearerCalls()).toBe(2) // tried cache, retried once, then gave up
    expect(sentinelExists()).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'emit-failure.claude-code.json'), 'utf8')).http_status).toBe(401)
  })

  it('a failed refresh exits before ever calling /bearer (no retry loop on a dead refresh)', () => {
    // No cache → forces an initial refresh, which the stub fails.
    const r = runHelper({ STUB_TOKEN_FAIL: '1' })
    expect(r.status).toBe(1)
    expect(bearerCalls()).toBe(0) // never reached /bearer
    expect(sentinelExists()).toBe(true)
  })

  it('never passes the refresh token on curl argv (secret-off-argv invariant — rides via stdin)', () => {
    const argvLog = join(tmp, 'argv.log')
    // No cache → forces a refresh POST; mode ok → /bearer 200.
    const r = runHelper({ STUB_BEARER_MODE: 'ok', STUB_ARGV: argvLog, TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'SECRET-REFRESH-VALUE' })
    expect(r.status).toBe(0)
    const logged = readFileSync(argvLog, 'utf8')
    expect(logged).toContain('/oauth/token') // the refresh POST did happen…
    expect(logged).not.toContain('SECRET-REFRESH-VALUE') // …but the token is NOT on argv (it rides via --data-binary @- stdin)
  })

  it('a valid cached token is used directly — exactly ONE /bearer call, no retry (200)', () => {
    // BOUND, or the binding check discards it and this stops testing cache use at
    // all: both the cached and the refreshed path make exactly one /bearer call,
    // so the old assertion passed either way.
    writeFileSync(
      join(stateDir, 'oauth-access.claude-code.json'),
      JSON.stringify({ access_token: 'GOOD', expires_at: 9999999999, bearer_endpoint: BEARER_EP }),
    )
    const r = runHelper({ STUB_BEARER_MODE: 'ok', STUB_ARGV: join(tmp, 'argv.txt') })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer')
    expect(bearerCalls()).toBe(1) // no retry needed
    expect(sentinelExists()).toBe(false)
    // The point of the case: the CACHE was used, so no refresh happened. Without
    // this the assertion above holds on the refreshed path too.
    const argv = existsSync(join(tmp, 'argv.txt')) ? readFileSync(join(tmp, 'argv.txt'), 'utf8') : ''
    expect(argv).not.toContain('/oauth/token')
  })
})

describe.skipIf(POSIX_ONLY)('otel-headers-helper — S1 fix 3: endpoint pre-flight (assert_safe_endpoint)', () => {
  function argvLogEmpty(logPath: string): boolean {
    return !existsSync(logPath) || readFileSync(logPath, 'utf8').trim() === ''
  }

  it("a bearer endpoint starting with '-' → exit 1 + sentinel, curl NEVER invoked", () => {
    const argvLog = join(tmp, 'argv.log')
    const r = runHelper({ TOKENSCOPE_BEARER_ENDPOINT: '-K/tmp/x', STUB_ARGV: argvLog })
    expect(r.status).toBe(1)
    expect(sentinelExists()).toBe(true)
    expect(argvLogEmpty(argvLog)).toBe(true) // curl never ran — rejected before the first call
    expect(bearerCalls()).toBe(0)
  })

  it('a plaintext http bearer endpoint for an off-box host → exit 1 + sentinel, curl NEVER invoked', () => {
    const argvLog = join(tmp, 'argv.log')
    const r = runHelper({ TOKENSCOPE_BEARER_ENDPOINT: 'http://evil.example.com/bearer', STUB_ARGV: argvLog })
    expect(r.status).toBe(1)
    expect(sentinelExists()).toBe(true)
    expect(argvLogEmpty(argvLog)).toBe(true)
    expect(bearerCalls()).toBe(0)
  })

  it("a plaintext http OAuth token endpoint for an off-box host → exit 1 + sentinel, curl NEVER invoked", () => {
    const argvLog = join(tmp, 'argv.log')
    const r = runHelper({ TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://evil.example.com/oauth/token', STUB_ARGV: argvLog })
    expect(r.status).toBe(1)
    expect(sentinelExists()).toBe(true)
    expect(argvLogEmpty(argvLog)).toBe(true)
  })

  it('a loopback bearer endpoint (local dev) PASSES the pre-flight and proceeds to curl', () => {
    const r = runHelper({ TOKENSCOPE_BEARER_ENDPOINT: 'http://127.0.0.1:3450/api/v1/instances/x/bearer', STUB_BEARER_MODE: 'ok' })
    expect(r.status).toBe(0)
    expect(bearerCalls()).toBeGreaterThan(0) // reached curl — the loopback exception cleared it
  })
})

describe.skipIf(POSIX_ONLY)('otel-headers-helper — S1 fix 4: the shared device credential store fallback', () => {
  /** Run the helper WITHOUT TOKENSCOPE_OAUTH_REFRESH_TOKEN in its env at all
   * (unlike runHelper(), which always sets it — a tagged-repo session omits
   * it entirely per tag-repo.mjs's `delete deviceEnv.TOKENSCOPE_OAUTH_REFRESH_TOKEN`). */
  function runHelperNoRefreshTokenEnv(env: Record<string, string>) {
    return spawnSync('sh', [HELPER, '--state-dir', stateDir, '--tool-dir', stubDir], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        HOME: tmp,
        TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
        TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
        STUB_COUNTER: join(tmp, 'counter'),
        ...env,
        // NOTE: TOKENSCOPE_OAUTH_REFRESH_TOKEN deliberately absent.
      },
    })
  }

  it('TOKENSCOPE_OAUTH_REFRESH_TOKEN unset + a 0600 ${STATE_DIR}/config.json present → mints a bearer from the stored value', () => {
    /*
     * The stored ENDPOINT is part of this fixture now. The helper refuses to
     * pair a stored credential with an environment-supplied destination (a
     * hostile repo contributes to that environment, and the durable token does
     * not rotate), so a store holding only the token is the legacy shape the
     * SessionStart hook migrates via migrateStoredEndpoints. This case is the
     * post-migration one: both come from the device.
     */
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      JSON.stringify({
        // The v2 envelope is required for adoption, and instance_id must agree
        // with the instance the bearer endpoint names.
        version: 2,
        tool: 'claude-code',
        instance_id: 'x',
        otel_resource_attributes: 'tokenscope.instance_id=x,tool=claude-code',
        oauth_refresh_token: 'rt-from-device-store',
        // BOTH destinations: the helper will not use a stored credential unless
        // both come from the store, because pairing one with an env-supplied
        // destination is the hole this guards.
        oauth_token_endpoint: 'https://stub.local/api/v1/oauth/token',
        bearer_endpoint: 'https://stub.local/api/v1/instances/x/bearer',
      }),
    )
    chmodSync(join(stateDir, 'config.claude-code.json'), 0o600)
    const argvLog = join(tmp, 'argv.log')
    const r = runHelperNoRefreshTokenEnv({ STUB_BEARER_MODE: 'ok', STUB_ARGV: argvLog })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer')
    // The refresh POST fired (using the store's value) and never leaked it to argv.
    const logged = readFileSync(argvLog, 'utf8')
    expect(logged).toContain('/oauth/token')
    expect(logged).not.toContain('rt-from-device-store')
  })

  it('TOKENSCOPE_OAUTH_REFRESH_TOKEN unset AND no config.json in the state dir → fails loud (sentinel + exit 1), never silently', () => {
    const r = runHelperNoRefreshTokenEnv({})
    expect(r.status).toBe(1)
    expect(sentinelExists()).toBe(true)
    expect(r.stderr).toMatch(/NOT CONFIGURED/)
  })

  it('a config.json present but WITHOUT an oauth_refresh_token field → still fails loud (no silent half-config)', () => {
    writeFileSync(join(stateDir, 'config.claude-code.json'), JSON.stringify({ version: 2, tool: 'claude-code', instance_id: 'x', otel_resource_attributes: 'tokenscope.instance_id=x,tool=claude-code' }))
    const r = runHelperNoRefreshTokenEnv({})
    expect(r.status).toBe(1)
    expect(sentinelExists()).toBe(true)
  })
})
