/*
 * otel-headers-helper.sh — ride out a TokenScope outage on the cached Azure
 * bearer (#409).
 *
 * Claude Code discards the helper's headers the moment the helper fails, and
 * exports nothing until it succeeds again (docs: "exports fail … until the
 * helper works again"). Before this change the helper called /bearer on every
 * run with nothing to fall back on, so one failed call — a TokenScope deploy —
 * cost up to 29 minutes of telemetry although the Azure token handed out a
 * few minutes earlier was typically still valid.
 *
 * Rule (owner ruling, #409): /bearer or the token endpoint UNREACHABLE
 * (network, timeout, 5xx, 429) → hand back the last Azure bearer, unconditionally,
 * and let Azure judge it; an auth VERDICT (401/403 from /bearer, invalid_grant
 * from the token endpoint, any other 4xx) → stop AND drop the cache, and a
 * verdict seen earlier in the same run disables the fallback for the rest of it.
 * The expiry returned by /bearer is stored for diagnostics: a known-expired
 * cache is still handed back, but the failure sentinel is written so the
 * health readers go red instead of green.
 *
 * Which of these fail with the fix reverted: every cache write, every
 * "hands back the cached bearer" case, the degraded-marker handling, and the
 * verdict cases that assert the cache is DELETED (the old helper never deletes a
 * file it does not know about). The pure boundary cases ("different endpoint",
 * "nothing cached") pass before and after; they are here so the fallback can
 * never widen into "always use the cache".
 *
 * Stub `curl` on PATH (no live network): honours `-D <file>` so the expiry
 * header can be served, exits 7 like real curl on a connection failure, and
 * can sequence /bearer responses per call via STUB_BEARER_SEQ.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

// OTEL_HELPER_PATH lets a mutation run point this suite at another copy of the
// helper (e.g. `git show main:…`) without touching the working tree.
const HELPER = process.env.OTEL_HELPER_PATH ?? resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')
const BEARER_EP = 'https://stub.local/api/v1/instances/x/bearer'

let tmp: string
let stubDir: string
let stateDir: string

const STUB = `#!/bin/sh
a="$*"
hdr=""; prev=""
for w in "$@"; do [ "$prev" = "-D" ] && hdr="$w"; prev="$w"; done
# Per-call /bearer sequencing: STUB_BEARER_SEQ="s401,s503" serves s401 to the
# first call, s503 to the second, and the last entry thereafter.
bearer_mode() {
  if [ -n "\${STUB_BEARER_SEQ:-}" ]; then
    n=0; [ -f "$STUB_COUNTER" ] && n="$(cat "$STUB_COUNTER")"; n=$((n+1)); printf '%s' "$n" > "$STUB_COUNTER"
    m="$(printf '%s' "$STUB_BEARER_SEQ" | tr ',' '\\n' | sed -n "\${n}p")"
    [ -n "$m" ] || m="$(printf '%s' "$STUB_BEARER_SEQ" | tr ',' '\\n' | tail -n1)"
    printf '%s' "$m"
  else
    printf '%s' "\${STUB_BEARER_MODE:-ok}"
  fi
}
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true
    case "\${STUB_TOKEN_MODE:-ok}" in
      ok)   printf '{"access_token":"stub-access","expires_in":3600}\\n200' ;;
      down) printf '\\n000'; exit 7 ;;
      s429) printf 'slow down\\n429' ;;
      s503) printf 'upstream\\n503' ;;
      dead) printf '{"error":"invalid_grant"}\\n400' ;;
    esac ;;
  *"/bearer"*)
    case "$(bearer_mode)" in
      ok)
        if [ -n "$hdr" ] && [ -n "\${STUB_EXPIRES:-}" ]; then
          printf 'HTTP/1.1 200 OK\\r\\nX-TokenScope-Bearer-Expires-At: %s\\r\\n\\r\\n' "$STUB_EXPIRES" > "$hdr"
        fi
        printf '{"Authorization":"Bearer fresh-bearer"}\\n200' ;;
      down) printf '\\n000'; exit 7 ;;
      s408) printf 'timeout\\n408' ;;
      s429) printf 'slow down\\n429' ;;
      s503) printf 'upstream unavailable\\n503' ;;
      s401) printf '{"statusMessage":"revoked"}\\n401' ;;
      s404) printf '{"statusMessage":"gone"}\\n404' ;;
    esac ;;
  *) printf '\\n000'; exit 7 ;;
esac
exit 0
`

function runHelper(env: Record<string, string> = {}, dir: string = stateDir) {
  return spawnSync('sh', [HELPER, '--state-dir', dir, '--tool-dir', stubDir], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      TOKENSCOPE_BEARER_ENDPOINT: BEARER_EP,
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      STUB_COUNTER: join(tmp, 'counter'),
      ...env,
    },
  })
}

const azureCachePath = (dir = stateDir) => join(dir, 'azure-bearer.claude-code.json')
const degradedPath = (dir = stateDir) => join(dir, 'emit-degraded.claude-code.json')
const sentinelPath = (dir = stateDir) => join(dir, 'emit-failure.claude-code.json')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const readText = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

function seedAzureCache(opts: { endpoint?: string; expiresAt?: number; dir?: string } = {}) {
  writeFileSync(
    azureCachePath(opts.dir),
    JSON.stringify({
      authorization: 'Bearer cached-bearer',
      expires_at: opts.expiresAt ?? 9999999999,
      bearer_endpoint: opts.endpoint ?? BEARER_EP,
    }),
  )
}
/** A valid OAuth access cache, so /bearer is reached without a refresh. */
function seedAccessCache(dir = stateDir) {
  writeFileSync(
    join(dir, 'oauth-access.claude-code.json'),
    JSON.stringify({ access_token: 'cached-access', expires_at: 9999999999, bearer_endpoint: BEARER_EP }),
  )
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-cb-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stubDir, 'curl'), STUB)
  chmodSync(join(stubDir, 'curl'), 0o755)
  // Pin the passwd lookup to a temp home with no ~/.claude/settings.json, so the
  // fixture never resolves the developer's real enrolment (same as the retry test).
  const passwdHome = join(tmp, 'passwd-home')
  mkdirSync(passwdHome, { recursive: true })
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(join(stubDir, 'getent'), `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`)
  chmodSync(join(stubDir, 'getent'), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('otel-headers-helper — cached Azure bearer (#409): clean mint', () => {
  it('caches the minted bearer, bound to the endpoint, with the expiry from the response header', () => {
    const r = runHelper({ STUB_EXPIRES: '1900000000' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer fresh-bearer' })
    expect(readJson(azureCachePath())).toEqual({
      authorization: 'Bearer fresh-bearer',
      expires_at: 1900000000,
      bearer_endpoint: BEARER_EP,
    })
    expect(existsSync(degradedPath())).toBe(false)
  })

  it('stores expiry 0 when the server sends no expiry header (older server), and still mints', () => {
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(readJson(azureCachePath()).expires_at).toBe(0)
  })

  it('writes the cache 0600 (it holds token material)', () => {
    runHelper({ STUB_EXPIRES: '1900000000' })
    expect(statSync(azureCachePath()).mode & 0o777).toBe(0o600)
  })

  it('the next clean mint clears the degraded marker', () => {
    writeFileSync(degradedPath(), '{"ts":"x","reason":"earlier outage","expires_at":0}')
    const r = runHelper()
    expect(r.status).toBe(0)
    expect(existsSync(degradedPath())).toBe(false)
  })

  it('never puts the bearer on stderr', () => {
    const r = runHelper({ STUB_EXPIRES: '1900000000' })
    expect(r.stderr).not.toContain('fresh-bearer')
  })
})

describe.skipIf(POSIX_ONLY)('otel-headers-helper — cached Azure bearer (#409): unreachable → cache', () => {
  it('hands back the cached bearer when /bearer is unreachable — degraded, NOT failed', () => {
    seedAccessCache()
    seedAzureCache()
    writeFileSync(sentinelPath(), '{"ts":"x","http_status":0,"message":"stale"}') // must be cleared
    const r = runHelper({ STUB_BEARER_MODE: 'down' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer cached-bearer' })
    expect(r.stderr).toMatch(/DEGRADED/)
    const d = readJson(degradedPath())
    expect(d.reason).toMatch(/could not reach/)
    expect(d.expires_at).toBe(9999999999)
    expect(existsSync(sentinelPath())).toBe(false) // emission is continuing
  })

  it.each(['s503', 's408', 's429'])('hands back the cached bearer on %s from /bearer', (mode) => {
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_MODE: mode })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer cached-bearer' })
    expect(readJson(degradedPath()).reason).toMatch(new RegExp(`HTTP ${mode.slice(1)}`))
  })

  it.each(['down', 's429', 's503'])(
    'hands back the cached bearer when the OAuth token endpoint is %s (refresh needed, TokenScope down)',
    (mode) => {
      seedAzureCache() // no access cache → a refresh is attempted first
      const r = runHelper({ STUB_TOKEN_MODE: mode })
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer cached-bearer' })
      expect(readJson(degradedPath()).reason).toMatch(/token endpoint HTTP/)
    },
  )

  it('hands back an EXPIRED cached bearer too (Azure is the judge) — but writes the failure sentinel so health goes red', () => {
    seedAccessCache()
    seedAzureCache({ expiresAt: 1000000000 })
    const r = runHelper({ STUB_BEARER_MODE: 'down' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer cached-bearer' })
    expect(r.stderr).toMatch(/EXPIRED/)
    expect(existsSync(degradedPath())).toBe(true)
    expect(existsSync(sentinelPath())).toBe(true)
    expect(readJson(sentinelPath()).message).toMatch(/expired at 1000000000/)
  })

  it('token material never reaches stderr, the degraded marker or the sentinel on the cache path', () => {
    seedAccessCache()
    seedAzureCache({ expiresAt: 1000000000 }) // expired → both files are written
    const r = runHelper({ STUB_BEARER_MODE: 'down' })
    expect(r.status).toBe(0)
    for (const text of [r.stderr, readText(degradedPath()), readText(sentinelPath())]) {
      expect(text).not.toContain('cached-bearer')
      expect(text).not.toContain('cached-access')
    }
  })

  it('works with a state dir containing a space (the -D header file lives there)', () => {
    const spaced = join(tmp, 'state dir')
    mkdirSync(spaced, { recursive: true })
    const r = runHelper({ STUB_EXPIRES: '1900000000' }, spaced)
    expect(r.status).toBe(0)
    expect(readJson(azureCachePath(spaced)).expires_at).toBe(1900000000)
    seedAccessCache(spaced)
    const r2 = runHelper({ STUB_BEARER_MODE: 'down' }, spaced)
    expect(r2.status).toBe(0)
    expect(JSON.parse(r2.stdout)).toEqual({ Authorization: 'Bearer fresh-bearer' })
  })
})

describe.skipIf(POSIX_ONLY)('otel-headers-helper — cached Azure bearer (#409): verdicts never fall back', () => {
  it('a 401 from /bearer stops emission and drops the cached bearer', () => {
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_MODE: 's401' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(existsSync(azureCachePath())).toBe(false)
    expect(existsSync(degradedPath())).toBe(false)
    expect(existsSync(sentinelPath())).toBe(true)
  })

  it('401 on the cached OAuth token, then the token endpoint goes DOWN: still a verdict, no cache fallback', () => {
    // Self-heal path: cached access token refused → drop it → refresh → the
    // refresh hits a deploy. The earlier 401 outranks the later transient.
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_SEQ: 's401', STUB_TOKEN_MODE: 'down' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(existsSync(azureCachePath())).toBe(false)
    expect(existsSync(degradedPath())).toBe(false)
  })

  it('401 on the cached OAuth token, refresh OK, retry hits a 503: still a verdict, no cache fallback', () => {
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_SEQ: 's401,s503' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(existsSync(azureCachePath())).toBe(false)
  })

  it('401 on the cached OAuth token, refresh OK, retry 200: the self-heal still works and rewrites the cache', () => {
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_SEQ: 's401,ok', STUB_EXPIRES: '1900000000' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer fresh-bearer' })
    expect(readJson(azureCachePath()).authorization).toBe('Bearer fresh-bearer')
  })

  it('a dead refresh credential (invalid_grant) stops emission and drops the cached bearer', () => {
    seedAzureCache()
    const r = runHelper({ STUB_TOKEN_MODE: 'dead' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(existsSync(azureCachePath())).toBe(false)
  })

  it('a non-transient 4xx from /bearer (instance gone) stops emission and drops the cached bearer', () => {
    seedAccessCache()
    seedAzureCache()
    const r = runHelper({ STUB_BEARER_MODE: 's404' })
    expect(r.status).toBe(1)
    expect(existsSync(azureCachePath())).toBe(false)
  })

  it('ignores a cached bearer bound to a different endpoint', () => {
    seedAccessCache()
    seedAzureCache({ endpoint: 'https://other.local/api/v1/instances/y/bearer' })
    const r = runHelper({ STUB_BEARER_MODE: 'down' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(existsSync(sentinelPath())).toBe(true)
  })

  it('with nothing cached, unreachable still fails loudly as before', () => {
    seedAccessCache()
    const r = runHelper({ STUB_BEARER_MODE: 'down' })
    expect(r.status).toBe(1)
    expect(existsSync(sentinelPath())).toBe(true)
    expect(existsSync(degradedPath())).toBe(false)
  })

  it('the sentinel written for an unreachable endpoint is valid JSON (curl reports 000)', () => {
    // `"http_status":000` is not JSON: every reader JSON.parses the sentinel,
    // got null, and read "no sentinel" — so the status line showed healthy
    // while emission was failing. Both the /bearer and the token-endpoint path.
    seedAccessCache()
    runHelper({ STUB_BEARER_MODE: 'down' })
    expect(readJson(sentinelPath()).http_status).toBe(0)
    rmSync(sentinelPath())
    rmSync(join(stateDir, 'oauth-access.claude-code.json'))
    runHelper({ STUB_TOKEN_MODE: 'down' })
    expect(readJson(sentinelPath()).http_status).toBe(0)
  })
})
