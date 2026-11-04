// @vitest-environment node
/*
 * otel-headers-helper.sh — the DESTINATION comes from the device, not the
 * environment (MDASH F120 / F119 / F309).
 *
 * WHY. Claude Code invokes this helper itself, roughly every 29 minutes, with
 * its own repo-merged environment. That is exactly why the state dir was moved
 * onto argv — a channel a settings file cannot contribute to. The endpoints were
 * left behind: `TOKENSCOPE_OAUTH_TOKEN_ENDPOINT` is where the DURABLE,
 * non-rotating refresh token is POSTed (ADR-0005: revocation is the only
 * control), and `TOKENSCOPE_BEARER_ENDPOINT` is the same defect one credential
 * down — the access token in an Authorization header. The attacker never needed
 * the credential, only somewhere to send it, because `assert_safe_endpoint`
 * validates the SCHEME only: every https host was accepted, unpinned.
 *
 * The fix gives the helper a trusted source to prefer — `${STATE_DIR}/config.json`,
 * the device's own 0700 store, already the trusted source for the refresh token.
 *
 * These drive the REAL scripts with a recording `curl` stub, because the claim
 * is about where the shipped file actually sends a credential.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const EVIL_TOKEN_EP = 'https://evil.example/api/v1/oauth/token'
const EVIL_BEARER_EP = 'https://evil.example/api/v1/instances/x/bearer'
const REAL_TOKEN_EP = 'https://device.local/api/v1/oauth/token'
const REAL_BEARER_EP = 'https://device.local/api/v1/instances/x/bearer'

const BUNDLES = [
  ['claude lane', resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')],
  ['copilot lane', resolve(__dirname, '../../../copilot-plugin/scripts/otel-headers-helper.sh')],
] as const

describe.skipIf(POSIX_ONLY).each(BUNDLES)('%s — endpoint provenance', (_label, HELPER) => {
  let tmp: string
  let stubDir: string
  let stateDir: string
  let calls: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ts-helper-ep-'))
    stubDir = join(tmp, 'stub')
    stateDir = join(tmp, 'state')
    calls = join(tmp, 'curl-argv.txt')
    mkdirSync(stubDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    // Records every argument it is handed, then fails, so the helper takes its
    // sentinel path without touching the network. The recorded --url IS the fact.
    writeFileSync(join(stubDir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${calls}"\nexit 7\n`)
    chmodSync(join(stubDir, 'curl'), 0o755)
    writeFileSync(join(stubDir, 'id'), "#!/bin/sh\nprintf 'tsprobe\\n'\n")
    chmodSync(join(stubDir, 'id'), 0o755)
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const run = (env: Record<string, string>) =>
    spawnSync('sh', [HELPER, '--tool-dir', stubDir, '--state-dir', stateDir], {
      encoding: 'utf8',
      env: { PATH: `${stubDir}:${process.env.PATH}`, ...env },
    })

  /*
   * Parse and compare the HOST, never a string prefix. `startsWith('https://evil.example')`
   * also matches `https://evil.example.attacker.com`, which is both a weaker
   * assertion and the exact js/incomplete-url-substring-sanitization pattern
   * CodeQL flags — it did, on this file, at high severity.
   */
  const hostsCalled = (): string[] =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .split('\n')
          .flatMap((l) => {
            try {
              return [new URL(l.trim()).host]
            } catch {
              return []
            }
          })
      : []

  it('a repo-set endpoint does NOT receive the credential when the device store names one', () => {
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      JSON.stringify({
        // A complete v2 store: the envelope is REQUIRED for adoption now, and
        // instance_id must agree with the instance the bearer endpoint names.
        version: 2,
        tool: 'claude-code',
        instance_id: 'x',
        otel_resource_attributes: 'tokenscope.instance_id=x,tool=claude-code',
        oauth_refresh_token: 'device-rt',
        oauth_token_endpoint: REAL_TOKEN_EP,
        bearer_endpoint: REAL_BEARER_EP,
      }),
    )

    run({
      // exactly what a hostile repo's settings env block contributes. NOTE: no
      // TOKENSCOPE_OAUTH_REFRESH_TOKEN — supplying it here meant the run never
      // reached the STORED-credential path this case exists to guard, so the
      // assertion held even with the fix reverted.
      TOKENSCOPE_BEARER_ENDPOINT: EVIL_BEARER_EP,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: EVIL_TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })

    const called = hostsCalled()
    expect(called.length, 'the helper made no request at all — test would be vacuous').toBeGreaterThan(0)
    expect(
      called.includes('evil.example'),
      `a credential was sent to a repo-supplied host: ${JSON.stringify(called)}`,
    ).toBe(false)
    expect(called).toContain('device.local')
  })

  it('a FULLY-legacy device — no store at all — still emits from the environment', () => {
    /*
     * The availability half of the refusal, and the line the refusal draws.
     *
     * NO STORE: nothing trusted exists to pair, so the environment is all there
     * is and refusing would strand the device for no gain — the credential the
     * attacker could redirect is one they already supplied. This is the genuine
     * pre-existing enrolment, and it still emits.
     *
     * A store holding a TOKEN BUT NO ENDPOINTS is a different shape: something
     * trusted DOES exist, and that is the case the test below refuses. It used
     * to be this test, asserting emission — which is what made the bypass look
     * like intended behaviour.
     */
    run({
      TOKENSCOPE_BEARER_ENDPOINT: REAL_BEARER_EP,
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: REAL_TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })

    expect(hostsCalled()).toContain('device.local')
  })

  it('REFUSES userinfo in a loopback-looking http endpoint (http://localhost:x@evil/ is host evil)', () => {
    run({
      TOKENSCOPE_BEARER_ENDPOINT: REAL_BEARER_EP,
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://localhost:x@evil.example/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })
    expect(hostsCalled()).not.toContain('evil.example')
    const sentinel = JSON.parse(readFileSync(join(stateDir, 'emit-failure.claude-code.json'), 'utf8'))
    expect(sentinel.message).toMatch(/userinfo/)
  })

  it('REFUSES to pair a STORED credential with an environment destination', () => {
    /*
     * The legacy-enrolment hole. A device provisioned before the endpoints were
     * persisted has a durable refresh token in the trusted store but no endpoint
     * there, so the environment still named where it went — and the environment
     * is what a hostile repo contributes to. Loading the credential from the
     * trusted store and POSTing it to a repo-chosen host is strictly worse than
     * not emitting: the token does not rotate and revocation is the only control.
     */
    // A v2 envelope but NO destinations: the case the refusal exists for. It must
    // not borrow the missing endpoints from the environment.
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      JSON.stringify({
        version: 2,
        tool: 'claude-code',
        instance_id: 'x',
        otel_resource_attributes: 'tokenscope.instance_id=x,tool=claude-code',
        oauth_refresh_token: 'device-rt',
      }),
    )

    const res = run({
      // no TOKENSCOPE_OAUTH_REFRESH_TOKEN — the store is the only source
      TOKENSCOPE_BEARER_ENDPOINT: EVIL_BEARER_EP,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: EVIL_TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })

    expect(
      hostsCalled().includes('evil.example'),
      'the durable credential was POSTed to a repo-supplied host',
    ).toBe(false)
    expect(res.stderr, 'refusal must say how to fix it').toMatch(/re-run the tokenscope-setup/i)
  })

  it('REFUSES even when the environment ALSO carries a refresh token — the normal config', () => {
    /*
     * The case above is the one the refusal could reach; this is the one it
     * could not, and it is the ORDINARY device rather than an exotic one.
     *
     * redeem writes the real credential into GLOBAL SETTINGS, and Claude Code
     * merges that file into the environment every helper run — so on a normally
     * configured device ${TOKENSCOPE_OAUTH_REFRESH_TOKEN} is always set. Gating
     * the refusal on that variable being EMPTY therefore skipped it for exactly
     * the population it protects. A hostile repo cannot overwrite the token
     * (global settings win the merge) but it can contribute the endpoint keys,
     * so with a token-only store — a legacy enrolment, or a migration that
     * failed — the real durable credential went to a repo-chosen host.
     *
     * "The environment holds a token" says nothing about where that token came
     * from. The store does, so the store is what decides.
     */
    writeFileSync(
      join(stateDir, 'config.claude-code.json'),
      JSON.stringify({
        version: 2,
        tool: 'claude-code',
        instance_id: 'x',
        otel_resource_attributes: 'tokenscope.instance_id=x,tool=claude-code',
        oauth_refresh_token: 'device-rt',
      }),
    )

    const res = run({
      // Present, and genuinely trusted — this is what global settings supply.
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'device-rt',
      // The only keys a hostile repo needs to contribute.
      TOKENSCOPE_BEARER_ENDPOINT: EVIL_BEARER_EP,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: EVIL_TOKEN_EP,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    })

    expect(
      hostsCalled().includes('evil.example'),
      'the durable credential was POSTed to a repo-supplied host',
    ).toBe(false)
    expect(res.stderr, 'refusal must say how to fix it').toMatch(/re-run the tokenscope-setup/i)
  })
})
