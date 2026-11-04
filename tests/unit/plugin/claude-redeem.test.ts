/**
 * claude-redeem — device-enrolment unit tests
 *
 * claude-redeem.mjs is the Claude-Code analogue of copilot-redeem.mjs. It redeems
 * the emit handoff and writes the device's OTel plumbing + durable OAuth emit
 * credential into ~/.claude/settings.json. These tests pin the invariants the
 * emit path depends on:
 *
 *   1. The env block carries the three keys otel-headers-helper.sh REQUIRES
 *      (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID) — all or none,
 *      so a partial response never writes a half-configured (silently ignored)
 *      credential.
 *   2. The bearer endpoint is mapped from the bundle's otel_headers_helper_url.
 *   3. No TOKENSCOPE_READ_* keys are written (redeem is emit-only; read came from
 *      the MCP OAuth grant).
 *   4. writeClaudeSettings MERGES additively on a same-environment re-run — a
 *      developer's pre-existing permissions + unrelated env keys survive — and
 *      refuses to clobber an unparseable existing file.
 *   5. Cross-environment transition robustness: when the redeem points at a
 *      DIFFERENT deployment (the bearer-endpoint host changed), the env block is
 *      REPLACED wholesale so stale credentials/endpoints from the OLD environment
 *      (legacy TOKENSCOPE_SESSION_TOKEN / TOKENSCOPE_READ_*, the old bearer +
 *      OTLP endpoints) cannot survive at rest — while top-level non-env keys
 *      (permissions, statusLine) are still preserved. The change is detected from
 *      the bearer host and is silent on a same-host re-run.
 *   6. The refresh token lands in the 0600 device store only, never in
 *      settings.json, whose env block every child process inherits.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFakeHomePreload, fakeHomeNode, realIsolatedIndex } from './helpers/fake-home'

// Windows (#430): skipped on win32 because this file expects EACCES on an unwritable path; Windows reports EPERM (claude-redeem-ps1 covers the Windows redeem).
const POSIX_ONLY = process.platform === 'win32'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { buildClaudeDeviceEnv, assertClaudeRedeemResponse, writeClaudeSettings, writeSharedCredentialStore, parseArgs } = await import(
  '../../../plugin/scripts/claude-redeem.mjs'
)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { realHome } = await import('../../../plugin/scripts/real-home.mjs')

// A complete, valid /setup/redeem response for the claude-code path.
const FAKE_REDEEM_RESPONSE = {
  instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
  tool: 'claude-code',
  oauth_refresh_token: 'rt_super_secret',
  oauth_token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  oauth_client_id: 'client-abc',
  telemetry: {
    claude: {
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/f825e796/bearer',
      OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=f825e796,tool=claude-code',
    },
  },
}

const FAKE_CLAUDE_BUNDLE = {
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
  otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/abc/bearer',
  OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=abc,tool=claude-code',
}
const FAKE_OAUTH = {
  refresh_token: 'rt_super_secret',
  token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  client_id: 'client-abc',
}

let dir: string
const savedStateDir = process.env.TOKENSCOPE_STATE_DIR
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-claude-redeem-'))
  // The credential store is pinned by ARGUMENT at every call site below, not by
  // this variable. writeClaudeSettings resolves it with trustedStateDir(), which
  // deliberately ignores TOKENSCOPE_STATE_DIR — that is what stops a hostile repo
  // choosing where the durable credential lands, and it also means this env var
  // no longer redirects the write. It stayed set for the rest of the suite, but
  // the store path is now explicit: without that, every run here writes the
  // fixture credential into the REAL ~/.tokenscope on whatever machine runs it.
  process.env.TOKENSCOPE_STATE_DIR = join(dir, 'state')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.TOKENSCOPE_STATE_DIR
  else process.env.TOKENSCOPE_STATE_DIR = savedStateDir
})

describe.skipIf(POSIX_ONLY)('buildClaudeDeviceEnv', () => {
  it('maps the bundle + OAuth credential into the env keys the helper requires', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp')
    expect(env.OTEL_METRICS_EXPORTER).toBe('none')
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://ts.example.com/v1/logs')
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe('http/protobuf')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=abc,tool=claude-code')
    // The bearer endpoint comes from the bundle's otel_headers_helper_url.
    expect(env.TOKENSCOPE_BEARER_ENDPOINT).toBe(FAKE_CLAUDE_BUNDLE.otel_headers_helper_url)
    // The durable emit credential — all three present.
    expect(env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_super_secret')
    expect(env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(FAKE_OAUTH.token_endpoint)
    expect(env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('client-abc')
  })

  it('writes NO read-credential keys (redeem is emit-only)', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    expect(env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('TOKENSCOPE_READ_CLIENT_ID')
  })

  it('omits ALL OAuth keys when the credential block is incomplete (no half-config)', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { refresh_token: 'rt', client_id: 'c' }) // no token_endpoint
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_TOKEN_ENDPOINT')
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_CLIENT_ID')
  })

  it('returns {} for a missing bundle', () => {
    expect(buildClaudeDeviceEnv(null, FAKE_OAUTH)).toEqual({})
  })
})

describe.skipIf(POSIX_ONLY)('assertClaudeRedeemResponse', () => {
  it('returns {claude, oauth} for a complete valid response', () => {
    const { claude, oauth } = assertClaudeRedeemResponse(FAKE_REDEEM_RESPONSE)
    expect(claude.otel_headers_helper_url).toBe('https://ts.example.com/api/v1/instances/f825e796/bearer')
    expect(oauth).toEqual({
      refresh_token: 'rt_super_secret',
      token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
      client_id: 'client-abc',
    })
  })

  it.each([
    ['attributes name the other lane', { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=f825e796,tool=copilot-cli' }],
    ['attributes name another instance', { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=other,tool=claude-code' }],
    ['bearer addresses another instance', { otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/other/bearer' }],
  ])('rejects a bundle the helper would refuse (%s) before anything is written', (_l, patch) => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: { claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, ...patch } },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/tool|instance/)
  })

  it('rejects a Copilot bundle with a helpful message', () => {
    const copilot = { tool: 'copilot-cli', telemetry: { copilot: { instance_id: 'x' } } }
    expect(() => assertClaudeRedeemResponse(copilot)).toThrow(/Copilot bundle/)
  })

  it('rejects a response missing the claude bundle', () => {
    expect(() => assertClaudeRedeemResponse({ tool: 'claude-code', telemetry: {} })).toThrow(/usable Claude Code bundle/)
  })

  it('rejects a bundle missing OTEL_RESOURCE_ATTRIBUTES instance id (unattributable telemetry)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: { claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, OTEL_RESOURCE_ATTRIBUTES: 'tool=claude-code' } },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/tokenscope\.instance_id/)
  })

  it('rejects an EMPTY instance id value (tokenscope.instance_id=,...)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: {
        claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=,tool=claude-code' },
      },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/tokenscope\.instance_id/)
  })

  it('rejects a response missing an OAuth credential field', () => {
    const bad = { ...FAKE_REDEEM_RESPONSE, oauth_token_endpoint: '' }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/oauth_token_endpoint/)
  })

  // S1 fix 3 — validate BEFORE persisting a server-supplied bundle: a
  // compromised/MITM'd redeem response must not be able to plant a plaintext
  // endpoint that every subsequent bearer mint would then send the durable
  // credential to.
  it('rejects a bundle whose otel_headers_helper_url downgrades to plaintext http (off-box)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: { claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, otel_headers_helper_url: 'http://attacker.example.com/bearer' } },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/otel_headers_helper_url/)
  })

  it('rejects a bundle whose OTLP logs endpoint downgrades to plaintext http (off-box)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: { claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://attacker.example.com/v1/logs' } },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/)
  })

  it('rejects a response whose oauth_token_endpoint downgrades to plaintext http (off-box)', () => {
    const bad = { ...FAKE_REDEEM_RESPONSE, oauth_token_endpoint: 'http://attacker.example.com/oauth/token' }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/oauth_token_endpoint/)
  })

  it('accepts a loopback bearer/logs endpoint (a locally-running dev server)', () => {
    const local = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: {
        claude: {
          ...FAKE_REDEEM_RESPONSE.telemetry.claude,
          otel_headers_helper_url: 'http://localhost:3450/api/v1/instances/f825e796/bearer',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:3450/v1/logs',
        },
      },
      oauth_token_endpoint: 'http://localhost:3450/api/v1/oauth/token',
    }
    expect(() => assertClaudeRedeemResponse(local)).not.toThrow()
  })
})

describe.skipIf(POSIX_ONLY)('writeClaudeSettings', () => {
  // The helper RECORD the command is built from (buildHelperCommand), plus the
  // install it runs from. HELPER_CMD is what lands in settings.json.
  const HELPER = { record: { tool: 'claude-code', platform: 'linux' }, scriptsDir: '/plugin/scripts' }
  const HELPER_CMD = '"/plugin/scripts/otel-headers-helper.sh" --tool claude-code'

  it('writes otelHeadersHelper + env into a fresh settings.json', () => {
    const path = join(dir, 'settings.json')
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    writeClaudeSettings(path, HELPER, env, join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.otelHeadersHelper).toBe(HELPER_CMD)
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=abc,tool=claude-code')
  })

  it('keeps the refresh token OUT of settings.json: every child process inherits that env block', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(readFileSync(path, 'utf8')).not.toContain('rt_super_secret')
    // The helper still has everything it needs: the store, and the endpoints beside it.
    expect(JSON.parse(readFileSync(join(dir, 'state', 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe('rt_super_secret')
    expect(written.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(FAKE_OAUTH.token_endpoint)
    expect(written.env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe(FAKE_OAUTH.client_id)
  })

  it('a re-redeem strips a refresh token an older redeem left in settings.json', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt_left_by_old_redeem', MY_VAR: 'keep' } }))
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(written.env.MY_VAR).toBe('keep')
  })

  it('preserves a developer’s pre-existing permissions and unrelated env keys', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: ['Bash(node:*)'] }, env: { MY_VAR: 'keep' } }),
    )
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.permissions).toEqual({ allow: ['Bash(node:*)'] }) // top-level key preserved
    expect(written.env.MY_VAR).toBe('keep') // unrelated env key preserved (additive merge)
    expect(written.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1') // ours merged in
  })

  it('rotates the credential in place on re-run (overwrites the same keys)', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { ...FAKE_OAUTH, refresh_token: 'rt_rotated' }), join(dir, 'state'))
    expect(JSON.parse(readFileSync(join(dir, 'state', 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe('rt_rotated')
  })

  // ── cross-environment transition robustness ───────────────────────────────────
  // A "stale OLD environment" settings.json: a pre-cutover Sandbox enrolment that
  // still carries a legacy TOKENSCOPE_SESSION_TOKEN + TOKENSCOPE_READ_* and the old
  // deployment's bearer/OTLP endpoints — plus a developer's own top-level keys.
  const SANDBOX_BEARER = 'https://ep-tokenscope-sandbox-aue.example.com/api/v1/instances/old/bearer'
  const SANDBOX_OTLP = 'https://dce-tokenscope-otlp.example.com/v1/logs'
  const writeStaleSandboxSettings = (path: string) =>
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['Bash(node:*)'] },
        statusLine: { type: 'command', command: 'node /some/statusline.mjs', padding: 0 },
        otelHeadersHelper: '/old/otel-headers-helper.sh',
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          TOKENSCOPE_BEARER_ENDPOINT: SANDBOX_BEARER,
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: SANDBOX_OTLP,
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=sandboxinst,tool=claude-code',
          // Stale credentials from the OLD environment that must NOT survive.
          TOKENSCOPE_SESSION_TOKEN: 'legacy_session_tok',
          TOKENSCOPE_READ_REFRESH_TOKEN: 'legacy_read_rt',
          TOKENSCOPE_READ_CLIENT_ID: 'legacy_read_client',
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'sandbox_oauth_rt',
        },
      }),
    )

  // A Dev bundle — a DIFFERENT deployment (bearer host differs from FAKE_CLAUDE_BUNDLE
  // / the stale Sandbox host above).
  const DEV_BUNDLE = {
    ...FAKE_CLAUDE_BUNDLE,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://dce-tokenscope-dev.example.com/v1/logs',
    otel_headers_helper_url: 'https://tokenscope.example.com/api/v1/instances/devinst/bearer',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=devinst,tool=claude-code',
  }

  it('REPLACES the env block on an environment change — stale session/read creds and old endpoints are GONE', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    // Env-change was detected (Sandbox host → Dev host).
    expect(change.changed).toBe(true)
    // Stale OLD-environment credentials are wiped.
    expect(written.env).not.toHaveProperty('TOKENSCOPE_SESSION_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_CLIENT_ID')
    // The OLD deployment's endpoints are replaced with the new environment's.
    expect(written.env.TOKENSCOPE_BEARER_ENDPOINT).toBe(DEV_BUNDLE.otel_headers_helper_url)
    expect(written.env.TOKENSCOPE_BEARER_ENDPOINT).not.toBe(SANDBOX_BEARER)
    expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DEV_BUNDLE.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
    expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).not.toBe(SANDBOX_OTLP)
    // The old environment's credential is gone; the new one is in the store only.
    expect(written.env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(JSON.parse(readFileSync(join(dir, 'state', 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe('rt_super_secret')
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=devinst,tool=claude-code')
  })

  it('preserves NON-env top-level keys (permissions, statusLine) across an environment change', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.permissions).toEqual({ allow: ['Bash(node:*)'] })
    expect(written.statusLine).toEqual({ type: 'command', command: 'node /some/statusline.mjs', padding: 0 })
    // otelHeadersHelper is rebuilt from the record (a top-level key, restated).
    expect(written.otelHeadersHelper).toBe(HELPER_CMD)
  })

  it('detects an environment change when the bearer host changes (changed=true, with labels)', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    expect(change.changed).toBe(true)
    expect(change.oldLabel).toBe('Sandbox') // derived from the old bearer host
    expect(change.newLabel).toBe('Dev') // derived from the new bearer host
  })

  it('is SILENT (no env change) on a same-host re-run — additive merge keeps unrelated keys', () => {
    const path = join(dir, 'settings.json')
    // First enrol on FAKE_CLAUDE_BUNDLE (ts.example.com), then re-run on the SAME host.
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    // A developer hand-set an unrelated env key between runs — it must survive the
    // same-host (additive) re-run.
    const between = JSON.parse(readFileSync(path, 'utf8'))
    between.env.MY_VAR = 'keep'
    // A pre-OAuth/legacy enrolment also left a retired credential at rest.
    between.env.TOKENSCOPE_SESSION_TOKEN = 'legacy_session_tok'
    between.env.TOKENSCOPE_READ_REFRESH_TOKEN = 'legacy_read_rt'
    writeFileSync(path, JSON.stringify(between))
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { ...FAKE_OAUTH, refresh_token: 'rt_rotated' }), join(dir, 'state'))
    expect(change.changed).toBe(false)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env.MY_VAR).toBe('keep') // additive merge preserved a real custom key
    expect(JSON.parse(readFileSync(join(dir, 'state', 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe('rt_rotated')
    // F1: retired creds are stripped even on a SAME-env additive re-run — the
    // additive merge must NOT leave a legacy credential at rest.
    expect(written.env).not.toHaveProperty('TOKENSCOPE_SESSION_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
  })

  it('treats a fresh device (no existing bearer host) as NOT an environment change', () => {
    const path = join(dir, 'settings.json')
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    expect(change.changed).toBe(false)
  })

  /*
   * The tuple is validated BEFORE settings.json is touched. Round-10 review
   * reproduced the opposite: a fresh device, a bundle whose attributes named the
   * wrong lane, settings written, the store write's validation error swallowed
   * as best-effort, and success reported with the bad attributes persisted.
   */
  it.each([
    ['attributes name the other lane', { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=abc,tool=copilot-cli' }],
    ['attributes name another instance', { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=zzz,tool=claude-code' }],
    ['bearer addresses another instance', { TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example.com/api/v1/instances/zzz/bearer' }],
    ['no refresh token', { TOKENSCOPE_OAUTH_REFRESH_TOKEN: '' }],
  ])('on a fresh device, an inconsistent bundle (%s) writes NOTHING and throws', (_l, patch) => {
    const path = join(dir, 'settings.json')
    const state = join(dir, 'state')
    const env = { ...buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), ...patch }
    expect(() => writeClaudeSettings(path, HELPER, env, state)).toThrow()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(state, 'config.claude-code.json'))).toBe(false)
  })

  /*
   * settings.json has other writers (session-start's two self-heals, the
   * status-line toggle), all through casWriteFile. This one was the last blind
   * read/merge/rename; a concurrent write between its read and its rename was
   * silently overwritten.
   */
  /*
   * The concurrent write is triggered from INSIDE casWriteFile's render, between
   * its read and its compare: mergeClaudeSettings spreads the env block there,
   * and a spread invokes getters. OTEL_METRICS_EXPORTER is a key the up-front
   * validation never reads, so the getter fires only in the render. No mock and
   * no test-only seam; vitest cannot mock node:fs inside plugin-runtime.mjs.
   */
  const withRenderSideEffect = (onRender: () => void) => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    const value = env.OTEL_METRICS_EXPORTER
    Object.defineProperty(env, 'OTEL_METRICS_EXPORTER', {
      enumerable: true,
      get() {
        onRender()
        return value
      },
    })
    return env
  }

  it('re-derives from a concurrent write instead of renaming a stale snapshot over it', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['x'] }, env: { KEEP: '1' } }))
    let landed = false
    const env = withRenderSideEffect(() => {
      if (landed) return
      landed = true
      writeFileSync(path, JSON.stringify({ permissions: { allow: ['x'] }, env: { KEEP: '1', LANDED_MEANWHILE: 'yes' } }))
    })
    writeClaudeSettings(path, HELPER, env, join(dir, 'state'))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(landed).toBe(true)
    expect(written.env.LANDED_MEANWHILE).toBe('yes') // the winner's bytes survived
    expect(written.env.TOKENSCOPE_BEARER_ENDPOINT).toBe(FAKE_CLAUDE_BUNDLE.otel_headers_helper_url) // and ours landed on top
    expect(written.permissions).toEqual({ allow: ['x'] })
  })

  it('fails the enrolment loudly when the file never stops changing', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ env: {} }))
    let n = 0
    const env = withRenderSideEffect(() => {
      writeFileSync(path, JSON.stringify({ env: { CHURN: String(++n) } }))
    })
    expect(() => writeClaudeSettings(path, HELPER, env, join(dir, 'state'))).toThrow(/kept changing/)
    expect(n).toBeGreaterThan(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined()
    expect(existsSync(join(dir, 'state', 'config.claude-code.json'))).toBe(false)
  })

  it('refuses to replace a present-but-unreadable settings.json, and writes no store', () => {
    const path = join(dir, 'settings.json')
    const body = JSON.stringify({ env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'precious' } })
    writeFileSync(path, body)
    chmodSync(path, 0o000)
    try {
      expect(() =>
        writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state')),
      ).toThrow(/EACCES/)
    } finally {
      chmodSync(path, 0o600)
    }
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(existsSync(join(dir, 'state', 'config.claude-code.json'))).toBe(false)
  })

  it('refuses to clobber an existing but unparseable settings.json', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{ this is not json')
    expect(() =>
      writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state')),
    ).toThrow(/not valid JSON/)
    // The bad file is left untouched, not overwritten.
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json')
  })

  it('leaves no .tmp file behind after an atomic write', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('writes the settings file with 0600 perms (POSIX only)', () => {
    if (platform() === 'win32') return // chmod is a no-op on Windows
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  // ── S1 fix 4: the shared device credential store ─────────────────────────
  // tag-repo.mjs now strips TOKENSCOPE_OAUTH_REFRESH_TOKEN from every repo
  // tag it writes; otel-headers-helper.sh falls back to
  // ${STATE_DIR}/config.json → .oauth_refresh_token. writeClaudeSettings must
  // populate that store on every successful redeem, or the fallback has
  // nothing to fall back TO and a tagged repo's emission bricks.
  it('mirrors the refresh token into the shared state-dir credential store on redeem', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const cfg = JSON.parse(readFileSync(join(process.env.TOKENSCOPE_STATE_DIR!, 'config.claude-code.json'), 'utf8'))
    expect(cfg.oauth_refresh_token).toBe('rt_super_secret')
  })

  it('the state-dir store is 0700/0600 (credential-bearing)', () => {
    if (platform() === 'win32') return
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const stateDirPath = process.env.TOKENSCOPE_STATE_DIR!
    expect(statSync(stateDirPath).mode & 0o777).toBe(0o700)
    expect(statSync(join(stateDirPath, 'config.claude-code.json')).mode & 0o777).toBe(0o600)
  })

  it('rotates the stored refresh token on a re-run', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    const cfgPath = join(process.env.TOKENSCOPE_STATE_DIR!, 'config.claude-code.json')
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).oauth_refresh_token).toBe('rt_super_secret')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { ...FAKE_OAUTH, refresh_token: 'rt_rotated' }), join(dir, 'state'))
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).oauth_refresh_token).toBe('rt_rotated')
  })

  /*
   * THE INVERSE OF THE OLD ASSERTION, DELIBERATELY.
   *
   * This test used to require that a Claude redeem PRESERVE an `instance_id`
   * the Copilot lane had written into the shared config.json. That merge is the
   * 2026-09-09 outage: the two lanes have different instances, so preserving
   * one lane's field across the other's redeem left Claude's credential paired
   * with Copilot's bearer endpoint and every mint 401'd. Each lane now owns one
   * file, and the requirement is that a Claude redeem cannot reach the Copilot
   * lane's file at all.
   */
  it('a Claude redeem does not touch the Copilot lane store', () => {
    const path = join(dir, 'settings.json')
    const stateDirPath = process.env.TOKENSCOPE_STATE_DIR!
    mkdirSync(stateDirPath, { recursive: true })
    const copilotStore = join(stateDirPath, 'config.copilot-cli.json')
    const copilotBefore = JSON.stringify({
      version: 2,
      tool: 'copilot-cli',
      instance_id: 'copilot-instance',
      bearer_endpoint: 'https://api/api/v1/instances/copilot-instance/bearer',
      oauth_refresh_token: 'copilot-rt',
    })
    writeFileSync(copilotStore, copilotBefore)
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), join(dir, 'state'))
    expect(readFileSync(copilotStore, 'utf8')).toBe(copilotBefore)
    const claude = JSON.parse(
      readFileSync(join(stateDirPath, 'config.claude-code.json'), 'utf8'),
    )
    expect(claude.tool).toBe('claude-code')
    expect(claude.instance_id).not.toBe('copilot-instance')
  })

  it('a store write failure with NO store on disk fails the redeem loudly', () => {
    // settings.json no longer carries the credential, so a store that did not
    // land leaves the device with nothing to emit with.
    const blocker = join(dir, 'blocked-state')
    writeFileSync(blocker, 'not a directory')
    const path = join(dir, 'settings.json')
    expect(() => writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), blocker)).toThrow(
      /Enrolment is NOT complete/,
    )
  })

  it('a store write failure that leaves an EXISTING store behind fails the redeem loudly', () => {
    /*
     * The bricking case, and the reason this is no longer unconditionally
     * best-effort. The helper PREFERS a stored credential over the environment
     * and refuses to pair one with an environment destination — so a stale
     * token-only store that we failed to update does not degrade to the env
     * path, it stops emission permanently. Reporting a successful enrolment
     * over that is silence plus a success message.
     */
    const stateDirPath = join(dir, 'occupied-state')
    mkdirSync(stateDirPath, { recursive: true, mode: 0o700 })
    // A legacy token-only store: exactly what the helper refuses to pair.
    writeFileSync(join(stateDirPath, 'config.json'), JSON.stringify({ oauth_refresh_token: 'rt_old' }))
    // Make the directory unwritable so the update cannot land.
    chmodSync(stateDirPath, 0o500)
    try {
      expect(() =>
        writeClaudeSettings(join(dir, 'settings2.json'), HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), stateDirPath),
      ).toThrow(/Enrolment is NOT complete/)
    } finally {
      chmodSync(stateDirPath, 0o700)
    }
  })

  it('a write failure over an existing V2 store fails the redeem loudly too', () => {
    /*
     * The same bricking case one filename along, and the reason it needs its own
     * test: the shadowing probe used to name `config.json`, which after the
     * per-tool split is no longer the file this writer produces. A failed update
     * over a stale `config.claude-code.json` therefore looked like "nothing left
     * behind", and the redeem reported success while the helper kept preferring
     * the stale store.
     */
    const stateDirPath = join(dir, 'occupied-v2-state')
    mkdirSync(stateDirPath, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(stateDirPath, 'config.claude-code.json'),
      JSON.stringify({ version: 2, tool: 'claude-code', oauth_refresh_token: 'rt_old' }),
    )
    chmodSync(stateDirPath, 0o500)
    try {
      expect(() =>
        writeClaudeSettings(
          join(dir, 'settings3.json'),
          HELPER,
          buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH),
          stateDirPath,
        ),
      ).toThrow(/Enrolment is NOT complete/)
    } finally {
      chmodSync(stateDirPath, 0o700)
    }
  })

  /*
   * #410. The command must carry the state dir the store was written to, or the
   * helper mints from the DEFAULT store: another enrolment's identity, sent to
   * this enrolment's destination. The store keeps the record, so session start
   * and the repo pin rebuild the same command later.
   */
  it('a record with a state dir writes --state-dir into the command and the record into the store', () => {
    const path = join(dir, 'settings.json')
    const state = join(dir, 'state with space')
    const record = { tool: 'claude-code', platform: 'linux', stateDir: state }
    writeClaudeSettings(path, { record, scriptsDir: '/plugin/scripts' }, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH), state)
    expect(JSON.parse(readFileSync(path, 'utf8')).otelHeadersHelper).toBe(
      `"/plugin/scripts/otel-headers-helper.sh" --tool claude-code --state-dir "${state}"`,
    )
    expect(JSON.parse(readFileSync(join(state, 'config.claude-code.json'), 'utf8')).helper).toEqual(record)
  })

  it('platform win32 writes the PowerShell command (no real Windows needed)', () => {
    const path = join(dir, 'settings.json')
    const record = { tool: 'claude-code', platform: 'win32', stateDir: 'C:\\Users\\Jo Do\\.tokenscope' }
    writeClaudeSettings(
      path,
      { record, scriptsDir: 'C:\\Users\\Jo Do\\.claude\\plugins\\cache\\tokenscope\\tokenscope\\1.2.3\\scripts' },
      buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH),
      join(dir, 'state'),
    )
    expect(JSON.parse(readFileSync(path, 'utf8')).otelHeadersHelper).toBe(
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
        '"C:\\Users\\Jo Do\\.claude\\plugins\\cache\\tokenscope\\tokenscope\\1.2.3\\scripts\\otel-headers-helper.ps1" ' +
        '--tool claude-code --state-dir "C:\\Users\\Jo Do\\.tokenscope"',
    )
  })

  it('lists a session-scoped settings file in the state dir, once, and not the global one', () => {
    const state = join(dir, 'state')
    const scoped = join(dir, 'scoped', 'settings.json')
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    writeClaudeSettings(join(dir, 'settings.json'), HELPER, env, state)
    expect(existsSync(join(state, 'settings-files.claude-code.json'))).toBe(false)
    writeClaudeSettings(scoped, HELPER, env, state, { sessionScoped: true, indexDir: state })
    writeClaudeSettings(scoped, HELPER, env, state, { sessionScoped: true, indexDir: state })
    const list = JSON.parse(readFileSync(join(state, 'settings-files.claude-code.json'), 'utf8'))
    expect(list.files).toEqual([scoped])
    // Its state dir IS the index dir: the list there already covers it.
    expect(existsSync(join(state, 'isolated-settings-files.claude-code.json'))).toBe(false)
  })

  it('indexes a session-scoped file enrolled in ANOTHER state dir in the index dir, with that state dir', () => {
    const state = join(dir, 'iso-state')
    const index = join(dir, 'trusted')
    const scoped = join(dir, 'scoped', 'settings.json')
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    writeClaudeSettings(scoped, HELPER, env, state, { sessionScoped: true, indexDir: index })
    writeClaudeSettings(scoped, HELPER, env, state, { sessionScoped: true, indexDir: index })
    const doc = JSON.parse(readFileSync(join(index, 'isolated-settings-files.claude-code.json'), 'utf8'))
    expect(doc).toEqual({ version: 1, tool: 'claude-code', entries: [{ file: scoped, stateDir: state }] })
    // Paths only: no credential material in the index.
    expect(readFileSync(join(index, 'isolated-settings-files.claude-code.json'), 'utf8')).not.toContain(FAKE_OAUTH.refresh_token)
  })

  it('refuses, under a test runner, to index into the REAL default store', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    expect(() =>
      writeClaudeSettings(join(dir, 'guard', 'settings.json'), HELPER, env, join(dir, 'guard-state'), { sessionScoped: true }),
    ).toThrow(/REAL settings index/)
  })

  it('writeSharedCredentialStore is a no-op when there is no refresh token to store', () => {
    const stateDirPath = join(dir, 'no-token-state')
    writeSharedCredentialStore(undefined, stateDirPath)
    expect(existsSync(stateDirPath)).toBe(false)
  })
})

describe.skipIf(POSIX_ONLY)('parseArgs', () => {
  it('accepts a bare positional handoff code', () => {
    expect(parseArgs(['abc123']).handoffCode).toBe('abc123')
  })

  it('accepts flags and does not treat a flag value as the positional code', () => {
    // --settings-path is deliberately absent here: it is now confined to the
    // account's own home (S16a), so a fixture path like '/s' is refused. Its
    // accept + refuse cases live in redeem-argv-guard.test.ts, which anchors a
    // temp dir under realHome() to exercise both.
    const a = parseArgs(['--handoff-code', 'h', '--api-base', 'https://x', '--instance-id', 'i'])
    expect(a.handoffCode).toBe('h')
    expect(a.apiBase).toBe('https://x')
    expect(a.instanceId).toBe('i')
  })
})

// End-to-end: spawn the real helper (main()) against a mock /setup/redeem server.
// Covers the orchestration unit tests can't reach: URL resolution, the POST,
// instance_id binding, exit codes, and the on-disk write.
describe.skipIf(POSIX_ONLY)('main() against a mock redeem server', () => {
  // Vitest runs with cwd at the repo root; resolve the helper from there.
  const HELPER = join(process.cwd(), 'plugin/scripts/claude-redeem.mjs')
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let lastBody: { handoff_code?: string; instance_id?: string } = {}
  let lastSetupMode: string | string[] | undefined

  // --settings-path is confined to the account's own home (S16a: it names where a
  // durable OAuth emit credential is written, and this process's argv is composed
  // by a model). So the fixture has to live there — a tmpdir() path is refused,
  // which redeem-argv-guard.test.ts pins as behaviour in its own right. One dir
  // for the whole describe, a distinct SUBdirectory per case, because the
  // basename must stay `settings.json`.
  let homeDir: string
  let preload: string
  // The default store's isolated index is anchored on the passwd home, which no
  // argv moves; the fake-home preload makes homeDir the child's account home.
  const indexBefore = realIsolatedIndex(realHome())
  const settingsIn = (name: string) => join(homeDir, name, 'settings.json')
  beforeAll(() => {
    homeDir = mkdtempSync(join(realHome(), '.ts-claude-redeem-main-'))
    preload = writeFakeHomePreload(homeDir)
  })
  afterAll(() => {
    if (homeDir && homeDir.startsWith(join(realHome(), '.ts-claude-redeem-main-'))) {
      rmSync(homeDir, { recursive: true, force: true })
    }
    expect(realIsolatedIndex(realHome()), 'a spawned redeem wrote the REAL settings index').toBe(indexBefore)
  })

  const claudeBundle = (attrs = 'tokenscope.instance_id=f825e796,tool=claude-code') => ({
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}/azmon-stub/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
    otel_headers_helper_url: `${baseUrl}/api/v1/instances/f825e796/bearer`,
    OTEL_RESOURCE_ATTRIBUTES: attrs,
  })

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        lastBody = JSON.parse(raw || '{}')
        lastSetupMode = req.headers['x-tokenscope-setup-mode']
        const code = lastBody.handoff_code
        if (code === 'BADATTRS') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildResp(claudeBundle('tool=claude-code'))))
        } else if (code === 'GOOD') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildResp(claudeBundle())))
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ statusMessage: 'Invalid, expired, or already-used handoff code' }))
        }
      })
    })
    function buildResp(claude: object) {
      return {
        instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
        tool: 'claude-code',
        oauth_refresh_token: 'rt_DURABLE_SECRET',
        oauth_token_endpoint: `${baseUrl}/api/v1/oauth/token`,
        oauth_client_id: 'client-xyz',
        telemetry: { claude },
      }
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  // Async spawn (NOT spawnSync): the mock server runs in this same worker's event
  // loop, so a synchronous spawn would deadlock — the child's POST could never be
  // served while spawnSync blocked the loop.
  const run = (code: string, settingsPath: string, extra: string[] = []) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const fake = fakeHomeNode(preload, homeDir)
      const child = spawn(
        'node',
        // --state-dir keeps the spawned CLI's credential store inside this
        // test's sandbox — without it the subprocess writes the fixture refresh
        // token into the REAL ~/.tokenscope, which is exactly what happened once.
        // It must be under homeDir, not a /tmp dir: the flag is confined by
        // assertConfinedPath, because unconfined it reopened the model-controlled
        // path sink argv-guard exists to close.
        [...fake.args, HELPER, '--handoff-code', code, '--api-base', baseUrl, '--settings-path', settingsPath, '--state-dir', join(homeDir, 'state'), ...extra],
        { encoding: 'utf8', env: { ...process.env, ...fake.env } } as never,
      )
      let stdout = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.on('close', (status) => resolve({ status, stdout }))
    })

  it('happy path: redeems, writes settings.json, exits 0, binds instance_id', async () => {
    const path = settingsIn('happy')
    const r = await run('GOOD', path, ['--instance-id', 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c'])
    expect(r.status).toBe(0)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(JSON.parse(readFileSync(join(homeDir, 'state', 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe(
      'rt_DURABLE_SECRET',
    )
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toContain('tokenscope.instance_id=f825e796')
    // --instance-id was forwarded to the server for the bound-instance check.
    expect(lastBody.instance_id).toBe('f825e796-ef29-4aa0-9a35-4aa2a5b8059c')
    // The Node redeem states it is the FULL setup (mig 0150, diagnostic only);
    // the PowerShell redeem for Windows devices without Node says emit-only.
    expect(lastSetupMode).toBe('full')
    // The durable secret must never appear on stdout.
    expect(r.stdout).not.toContain('rt_DURABLE_SECRET')
  })

  it('bad bundle (no instance id): exits 1 and writes NOTHING', async () => {
    const path = settingsIn('bad-bundle')
    const r = await run('BADATTRS', path)
    expect(r.status).toBe(1)
    expect(existsSync(path)).toBe(false)
  })

  // #410 acceptance, end to end through main(). On 8f5d8293 the command was the
  // bare helper path, so this session-scoped enrolment minted from the default
  // store.
  it('--state-dir X lands in otelHeadersHelper as --state-dir X, and the file is listed in X', async () => {
    const path = settingsIn('state-dir-410')
    const r = await run('GOOD', path)
    expect(r.status).toBe(0)
    const state = realpathSync(join(homeDir, 'state'))
    const helper = JSON.parse(readFileSync(path, 'utf8')).otelHeadersHelper
    expect(helper).toContain('otel-headers-helper.sh" --tool claude-code --state-dir ')
    expect([`--state-dir ${state}`, `--state-dir "${state}"`].some((t) => helper.endsWith(t))).toBe(true)
    const list = JSON.parse(readFileSync(join(state, 'settings-files.claude-code.json'), 'utf8'))
    expect(list.files).toContain(realpathSync(path))
    // X is not the default store, so the default store indexes the pairing too.
    const index = JSON.parse(readFileSync(join(homeDir, '.tokenscope', 'isolated-settings-files.claude-code.json'), 'utf8'))
    expect(index.entries).toContainEqual({ file: realpathSync(path), stateDir: state })
  })

  // No --settings-path: the default destination is the config folder of the
  // install running setup. On 2026-10-10 a Claude Desktop with its own folder
  // (CLAUDE_CONFIG_DIR=~/.claude-desktop) had its credential written into the
  // CLI's ~/.claude/settings.json and sent nothing.
  const runDefault = (code: string, extraEnv: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const fake = fakeHomeNode(preload, homeDir)
      const child = spawn(
        'node',
        [...fake.args, HELPER, '--handoff-code', code, '--api-base', baseUrl, '--state-dir', join(homeDir, 'state-default')],
        { encoding: 'utf8', env: { ...process.env, ...fake.env, ...extraEnv } } as never,
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.stderr.on('data', (c) => (stderr += c))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })

  it('with CLAUDE_CONFIG_DIR set to a folder of the user’s, writes THAT folder’s settings.json, not ~/.claude’s', async () => {
    const cfg = join(homeDir, '.claude-desktop')
    const cli = join(homeDir, '.claude', 'settings.json')
    const r = await runDefault('GOOD', { CLAUDE_CONFIG_DIR: cfg })
    expect(r.status).toBe(0)
    const written = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toContain('tokenscope.instance_id=f825e796')
    expect(written.otelHeadersHelper).toContain('otel-headers-helper.sh')
    expect(existsSync(cli)).toBe(false)
    expect(r.stdout).toContain(`Saved to ${join(realpathSync(cfg), 'settings.json')}`)
  })

  // #449: Claude Desktop (its own CLAUDE_CONFIG_DIR) and the CLI on one machine
  // shared ONE store keyed by tool, so the last setup supplied both installs'
  // credential. No --state-dir here: the default destination is under test.
  const runNoStateDir = (code: string, extraEnv: Record<string, string>) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const fake = fakeHomeNode(preload, homeDir)
      const child = spawn('node', [...fake.args, HELPER, '--handoff-code', code, '--api-base', baseUrl], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: '', ...fake.env, ...extraEnv },
      } as never)
      let stderr = ''
      child.stderr.on('data', (c) => (stderr += c))
      child.on('close', (status) => resolve({ status, stderr }))
    })

  it('a Desktop config folder gets its own store, named in its helper; the default store is untouched', async () => {
    const defaultStore = join(homeDir, '.tokenscope', 'config.claude-code.json')
    mkdirSync(join(homeDir, '.tokenscope'), { recursive: true })
    const cliStore = JSON.stringify({ cli: 'enrolment' })
    writeFileSync(defaultStore, cliStore)
    const cfg = join(homeDir, '.claude-desktop-449')
    mkdirSync(cfg)
    const r = await runNoStateDir('GOOD', { CLAUDE_CONFIG_DIR: cfg })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(defaultStore, 'utf8')).toBe(cliStore)
    const key = createHash('sha256').update(realpathSync(cfg)).digest('hex').slice(0, 12)
    const desktopState = join(homeDir, '.tokenscope', 'claude-config', key)
    expect(JSON.parse(readFileSync(join(desktopState, 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe(
      'rt_DURABLE_SECRET',
    )
    const helper = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8')).otelHeadersHelper
    expect([`--state-dir ${desktopState}`, `--state-dir "${desktopState}"`].some((t) => helper.endsWith(t))).toBe(true)
  })

  it('the default ~/.claude keeps ~/.tokenscope, with no --state-dir in its helper', async () => {
    const r = await runNoStateDir('GOOD', {})
    expect(r.status, r.stderr).toBe(0)
    const store = JSON.parse(readFileSync(join(homeDir, '.tokenscope', 'config.claude-code.json'), 'utf8'))
    expect(store.oauth_refresh_token).toBe('rt_DURABLE_SECRET')
    const helper = JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')).otelHeadersHelper
    expect(helper).toMatch(/otel-headers-helper\.sh" --tool claude-code$/)
  })

  // Linux only: on macOS the Desktop step would run the real launchctl. Under the
  // fake home its environment.d file lands inside homeDir.
  it.skipIf(platform() !== 'linux')('in the Claude app on Linux, setup gives ONE next step: log out, not restart', async () => {
    const r = await runDefault('GOOD', { CLAUDE_CONFIG_DIR: join(homeDir, '.claude-desktop-linux'), CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Next: Log out of your computer and back in, then open the Claude app.')
    expect(r.stdout).not.toContain('Next: restart Claude Code')
    expect(existsSync(join(homeDir, '.config', 'environment.d', '90-tokenscope.conf'))).toBe(true)
  })

  it('a CLAUDE_CONFIG_DIR outside the home is not used: ~/.claude, with a warning', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ts-redeem-cfg-out-'))
    try {
      const r = await runDefault('GOOD', { CLAUDE_CONFIG_DIR: outside })
      expect(r.status).toBe(0)
      expect(existsSync(join(outside, 'settings.json'))).toBe(false)
      expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(true)
      expect(r.stderr).toContain('CLAUDE_CONFIG_DIR is set but was not used (outside-home)')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('401 from server: exits 1 and writes NOTHING', async () => {
    const path = settingsIn('unauthorized')
    const r = await run('WRONGCODE', path)
    expect(r.status).toBe(1)
    expect(existsSync(path)).toBe(false)
  })
})
