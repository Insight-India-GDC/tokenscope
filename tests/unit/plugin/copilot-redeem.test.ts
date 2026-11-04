/**
 * copilot-redeem — credential separation unit tests
 *
 * Pins the invariant that after writeTokenscopeConfig():
 *   1. ~/.tokenscope/config.json contains oauth_refresh_token (required by mintBearer).
 *   2. ~/.tokenscope/oauth-access.json does NOT contain oauth_refresh_token —
 *      otel-headers-helper.sh overwrites that file on every bearer refresh
 *      with {access_token, expires_at}, so storing the refresh_token there
 *      would destroy it on first mint (was bug B2).
 *   3. Cross-environment transition robustness: when the redeem points at a
 *      DIFFERENT deployment (the bearer-endpoint host changed — Sandbox→Dev,
 *      Dev→Prod), config.json is written CLEAN so stale credentials/endpoints
 *      from the OLD environment cannot survive at rest; on a SAME-environment
 *      re-run the credential/endpoint fields are refreshed in place while any
 *      legitimately user-set (non-managed) key is preserved.
 *
 * Also pins basic shell-RC block idempotency for completeness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, statSync, symlinkSync, chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundAccessToken } from '../../../plugin/scripts/device-store.mjs'

// Windows (#430): skipped on win32 because this file asserts POSIX file mode 0600; Windows reports 0666.
const POSIX_ONLY = process.platform === 'win32'

// ── helpers: dynamically import the CJS-like MJS helpers ────────────────────
// writeTokenscopeConfig is a module-private helper; we test via the public API
// by driving main() through its internal fn. Instead, reach in via a thin
// re-export shim or test the public surface: write files in a temp dir and
// verify their contents by invoking the relevant node APIs on the temp files.
//
// copilot-redeem.mjs has no named exports, but we can isolate the helpers
// by extracting them as pure functions. Since changing the module shape
// would require a spec change, instead we test the invariant at the
// integration boundary: invoke writeTokenscopeConfig by building a minimal
// mock bundle and checking the written files.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const {
  writeTokenscopeConfig, removeBlock, armUsageExtension, enableExtensionsFeature, copilotSettingsPath, legacyProjectDirs, detectShellRcTargets, detectEnvChange, emitEnvLabel,
  assertSafeRedeemBundle,
} = await import('../../../plugin/scripts/copilot-redeem.mjs')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-redeem-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A bundle the helper would ACCEPT: instance-shaped bearer, and attributes that
// name this instance and this tool. Writers now refuse anything less, because a
// store written inconsistently is one the helper refuses forever.
const FAKE_INSTANCE = 'bbbaaaaa-0000-0000-0000-000000000001'
const FAKE_BUNDLE = {
  instance_id: FAKE_INSTANCE,
  TOKENSCOPE_BEARER_ENDPOINT: `https://ts.example.com/api/v1/instances/${FAKE_INSTANCE}/bearer`,
  TOKENSCOPE_LOGS_ENDPOINT: 'https://ts.example.com/logs',
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example.com/oauth/token',
  COPILOT_OTEL_FILE_EXPORTER_PATH: '/tmp/copilot-otel.ndjson',
  OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${FAKE_INSTANCE},tool=copilot-cli`,
}

// ── S2: validate the server-supplied endpoint bundle BEFORE persisting ─────────
// Mirrors claude-redeem.test.ts's assertClaudeRedeemResponse coverage — S1's fix 3
// said "both redeem paths"; this is the second one. A compromised/MITM'd redeem
// response could otherwise plant a plaintext (or malformed) endpoint into
// config.json; every SUBSEQUENT bearer mint (otel-headers-helper.sh) or span
// forward (copilot-forwarder.mjs) would then send the durable credential / span
// data wherever that endpoint points. assertSafeRedeemBundle must refuse it
// BEFORE writeTokenscopeConfig ever writes it to disk.
describe.skipIf(POSIX_ONLY)('assertSafeRedeemBundle — S2: no unsafe endpoint reaches config.json', () => {
  it('does not throw for an all-https bundle', () => {
    expect(() => assertSafeRedeemBundle(FAKE_BUNDLE)).not.toThrow()
  })

  it('rejects a bearer endpoint that downgrades to plaintext http (off-box)', () => {
    const bad = { ...FAKE_BUNDLE, TOKENSCOPE_BEARER_ENDPOINT: 'http://attacker.example.com/bearer' }
    expect(() => assertSafeRedeemBundle(bad)).toThrow(/TOKENSCOPE_BEARER_ENDPOINT/)
  })

  it('rejects a logs endpoint that downgrades to plaintext http (off-box)', () => {
    const bad = { ...FAKE_BUNDLE, TOKENSCOPE_LOGS_ENDPOINT: 'http://attacker.example.com/v1/logs' }
    expect(() => assertSafeRedeemBundle(bad)).toThrow(/TOKENSCOPE_LOGS_ENDPOINT/)
  })

  it('rejects an oauth_token_endpoint that downgrades to plaintext http (off-box)', () => {
    const bad = { ...FAKE_BUNDLE, TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://attacker.example.com/oauth/token' }
    expect(() => assertSafeRedeemBundle(bad)).toThrow(/TOKENSCOPE_OAUTH_TOKEN_ENDPOINT/)
  })

  it('rejects a missing field the same way (endpoint-guard\'s own "empty" check doubles as presence)', () => {
    const bad = { ...FAKE_BUNDLE, TOKENSCOPE_LOGS_ENDPOINT: undefined }
    expect(() => assertSafeRedeemBundle(bad)).toThrow()
  })

  it('accepts a loopback bundle (a locally-running dev TokenScope server)', () => {
    const local = {
      TOKENSCOPE_BEARER_ENDPOINT: 'http://localhost:3450/api/v1/instances/abc/bearer',
      TOKENSCOPE_LOGS_ENDPOINT: 'http://127.0.0.1:3450/v1/logs',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://[::1]:3450/oauth/token',
    }
    expect(() => assertSafeRedeemBundle(local)).not.toThrow()
  })
})

describe.skipIf(POSIX_ONLY)('writeTokenscopeConfig — credential separation', () => {
  it('config.json contains oauth_refresh_token (required by mintBearer)', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_super_secret', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(config.oauth_refresh_token).toBe('rt_super_secret')
    expect(config.oauth_client_id).toBe('client-abc')
    expect(config.instance_id).toBe(FAKE_BUNDLE.instance_id)
  })

  /*
   * The access-token cache has ONE writer, the helper. A redeem never creates,
   * resets or clears it: a cache from another deployment is bound to that
   * deployment's bearer endpoint and fails the binding on its own.
   */
  it('never creates the access-token cache', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_super_secret', 'client-abc', dir)
    expect(existsSync(join(dir, 'oauth-access.copilot-cli.json'))).toBe(false)
  })

  it('the store carries no span path: the usage extension needs none, and a re-redeem drops an old one', () => {
    writeFileSync(join(dir, 'config.copilot-cli.json'), JSON.stringify({ copilot_otel_file_path: '.tokenscope.local/copilot-otel.jsonl' }))
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(config).not.toHaveProperty('copilot_otel_file_path')
  })


  it('both files are created even when the dir already exists', () => {
    // First write
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // Second write (same dir, new token)
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(config.oauth_refresh_token).toBe('rt2')
  })

  it('re-redeem does NOT clobber an existing oauth-access.json (live helper cache — PLG-2)', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // Simulate otel-headers-helper.sh having populated the access-token cache.
    const live = { access_token: 'live-access-token', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.copilot-cli.json'), JSON.stringify(live))
    // Re-redeem (credential rotation) must rotate config.json but keep the cache.
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    expect(JSON.parse(readFileSync(join(dir, 'oauth-access.copilot-cli.json'), 'utf8'))).toEqual(live)
    expect(JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8')).oauth_refresh_token).toBe('rt2')
  })

  it('atomic write leaves no temp droppings in the target dir', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })
})

// ── cross-environment transition robustness ────────────────────────────────────
// Re-provisioning a device from one TokenScope deployment to another (Sandbox→Dev,
// Dev→Prod) must NOT leave the OLD deployment's bearer/logs endpoints or OAuth
// credential at rest in config.json. The change is detected from the bearer host.
describe.skipIf(POSIX_ONLY)('writeTokenscopeConfig — refuses to write a store the helper would refuse', () => {
  /*
   * The helper refuses an inconsistent envelope on read. Without this, a bad
   * bundle was WRITTEN successfully, setup reported success, and every later
   * mint failed with nothing able to repair the file.
   */
  it('throws on a bundle whose attributes name another instance, and writes nothing', () => {
    const bad = { ...FAKE_BUNDLE, OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=someone-else,tool=copilot-cli' }
    expect(() => writeTokenscopeConfig(bad, 'rt', 'client-abc', dir)).toThrow(/instance/)
    expect(existsSync(join(dir, 'config.copilot-cli.json'))).toBe(false)
  })
})

describe.skipIf(POSIX_ONLY)('writeTokenscopeConfig — cross-environment transition', () => {
  // A SANDBOX bundle (the device's first/old enrolment).
  const SANDBOX_BUNDLE = {
    instance_id: 'sandbox-inst-0000',
    TOKENSCOPE_BEARER_ENDPOINT:
      'https://ep-tokenscope-sandbox-aue.example.com/api/v1/instances/sandbox-inst-0000/bearer',
    TOKENSCOPE_LOGS_ENDPOINT: 'https://dce-tokenscope-otlp.example.com/v1/logs',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ep-tokenscope-sandbox-aue.example.com/oauth/token',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=sandbox-inst-0000,tool=copilot-cli',
  }
  // A DEV bundle — a DIFFERENT deployment (bearer host differs from SANDBOX_BUNDLE).
  const DEV_BUNDLE = {
    instance_id: 'dev-inst-0000',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope.example.com/api/v1/instances/dev-inst-0000/bearer',
    TOKENSCOPE_LOGS_ENDPOINT: 'https://dce-tokenscope-dev.example.com/v1/logs',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://tokenscope.example.com/oauth/token',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=dev-inst-0000,tool=copilot-cli',
  }

  it('writes a CLEAN config on an environment change — stale old-env endpoints/creds are GONE', () => {
    // First enrol on Sandbox (writes config.json with Sandbox endpoints + a Sandbox cred,
    // plus an unrelated key the old deployment happened to carry).
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    const stale = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    stale.stale_old_env_field = 'should-not-survive'
    writeFileSync(join(dir, 'config.copilot-cli.json'), JSON.stringify(stale, null, 2) + '\n')

    // Re-provision onto Dev (a different deployment).
    const change = writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))

    expect(change.changed).toBe(true)
    // Endpoints + credential are the NEW (Dev) environment's.
    expect(cfg.bearer_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
    expect(cfg.logs_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_LOGS_ENDPOINT)
    expect(cfg.oauth_token_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT)
    expect(cfg.oauth_refresh_token).toBe('dev_rt')
    expect(cfg.oauth_client_id).toBe('dev-client')
    expect(cfg.instance_id).toBe(DEV_BUNDLE.instance_id)
    expect(cfg.otel_resource_attributes).toBe(DEV_BUNDLE.OTEL_RESOURCE_ATTRIBUTES)
    // NOTHING from the OLD environment survives — not its endpoints, not its cred,
    // not any extra field it carried.
    expect(cfg.bearer_endpoint).not.toBe(SANDBOX_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
    expect(cfg.logs_endpoint).not.toBe(SANDBOX_BUNDLE.TOKENSCOPE_LOGS_ENDPOINT)
    expect(cfg.oauth_refresh_token).not.toBe('sandbox_rt')
    expect(cfg).not.toHaveProperty('stale_old_env_field')
  })

  it('env change reports old→new labels derived from the bearer hosts (never a credential)', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    const change = writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    expect(change.changed).toBe(true)
    expect(change.oldLabel).toBe('Sandbox')
    expect(change.newLabel).toBe('Dev')
  })

  it('leaves the cache alone on an environment change; the endpoint binding retires it', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    const live = {
      access_token: 'sandbox-access-token',
      expires_at: 9999999999,
      bearer_endpoint: SANDBOX_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT,
    }
    writeFileSync(join(dir, 'oauth-access.copilot-cli.json'), JSON.stringify(live))
    writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    const cache = JSON.parse(readFileSync(join(dir, 'oauth-access.copilot-cli.json'), 'utf8'))
    expect(cache).toEqual(live)
    // What actually retires it: no consumer will present it to the Dev endpoint.
    expect(readBoundAccessToken(cache, DEV_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)).toBeNull()
    expect(readBoundAccessToken(cache, SANDBOX_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)).toBe('sandbox-access-token')
  })

  /*
   * A store copied or renamed from the other lane declares tool: 'claude-code',
   * and the helper refuses it. Re-running setup is the documented repair, so the
   * v2 envelope has to be REPLACED, not preserved. It was missing from
   * MANAGED_CONFIG_KEYS, so this branch copied the stale value straight back
   * over the fresh one and setup could not fix the one thing it exists to fix.
   */
  it('SAME environment: REPAIRS a wrong-lane v2 envelope rather than preserving it', () => {
    writeFileSync(
      join(dir, 'config.copilot-cli.json'),
      JSON.stringify({
        version: 1,
        tool: 'claude-code', // copied from the other lane
        bearer_endpoint: FAKE_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT,
        logs_endpoint: FAKE_BUNDLE.TOKENSCOPE_LOGS_ENDPOINT,
        keep_me: 'operator-set',
      }),
    )
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_new', 'client-abc', dir)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(cfg.tool).toBe('copilot-cli')
    expect(cfg.version).toBe(2)
    expect(cfg.keep_me).toBe('operator-set') // genuinely user-set keys still survive
  })

  it('SAME environment: refreshes credential/endpoint fields, PRESERVES user-set keys', () => {
    // Enrol, then a user/tool adds an unrelated key to config.json.
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const cfg0 = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    cfg0.my_custom_setting = 'keep-me'
    writeFileSync(join(dir, 'config.copilot-cli.json'), JSON.stringify(cfg0, null, 2) + '\n')

    // Same-deployment re-run (same bearer host) with a rotated credential.
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    const cfg1 = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))

    expect(change.changed).toBe(false)
    // Credential refreshed in place.
    expect(cfg1.oauth_refresh_token).toBe('rt2')
    // User-set key preserved.
    expect(cfg1.my_custom_setting).toBe('keep-me')
  })

  it('SAME environment: does NOT reset a live oauth-access.json cache', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const live = { access_token: 'live-access-token', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.copilot-cli.json'), JSON.stringify(live))
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    // Same-env re-run keeps a perfectly valid cached access token (PLG-2 behaviour).
    expect(JSON.parse(readFileSync(join(dir, 'oauth-access.copilot-cli.json'), 'utf8'))).toEqual(live)
  })

  it('a fresh device (no existing config) is NOT an environment change', () => {
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    expect(change.changed).toBe(false)
  })

  it('ignores an unparseable existing config (treats as fresh, writes clean valid JSON)', () => {
    writeFileSync(join(dir, 'config.copilot-cli.json'), '{ not valid json')
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // No prior bearer host to compare → not an env change; the corrupt file is replaced.
    expect(change.changed).toBe(false)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(cfg.oauth_refresh_token).toBe('rt1')
    expect(cfg.bearer_endpoint).toBe(FAKE_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
  })

  it('leaves no temp droppings on an environment change', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
  })
})

describe.skipIf(POSIX_ONLY)('detectEnvChange — bearer-host comparison', () => {
  const bundleFor = (bearer: string, logs = '') => ({
    TOKENSCOPE_BEARER_ENDPOINT: bearer,
    TOKENSCOPE_LOGS_ENDPOINT: logs,
  })

  it('changed=false on a fresh device (no existing bearer host)', () => {
    expect(detectEnvChange(null, bundleFor('https://tokenscope.example.com/bearer')).changed).toBe(false)
  })

  it('changed=false on a same-host re-run', () => {
    const existing = { bearer_endpoint: 'https://ts.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('https://ts.example.com/bearer')).changed).toBe(false)
  })

  it('changed=true only when both hosts are present AND differ', () => {
    const existing = { bearer_endpoint: 'https://ep-tokenscope-sandbox-aue.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('https://tokenscope.example.com/bearer')).changed).toBe(true)
  })

  it('changed=false when the new bundle has no parseable bearer host (cannot classify a move)', () => {
    const existing = { bearer_endpoint: 'https://ts.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('')).changed).toBe(false)
  })
})

describe.skipIf(POSIX_ONLY)('emitEnvLabel — host classification (mirrors statusline)', () => {
  it('classifies the known product tokens from the bearer host', () => {
    // `.example.com`, not the real internal host, and deliberately so: the public
    // mirror's publish step rewrites `tokenscope.example.com` wholesale to
    // `tokenscope.example.com` (tools/publish/substitutions.txt), which strips the
    // `-dev` token this function classifies on — rewriting the INPUT while leaving
    // the expected `'Dev'` alone, so the assertion failed on every public release.
    // The two lines below were already written this way and always passed.
    expect(emitEnvLabel('https://tokenscope-dev.example.com/bearer')).toBe('Dev')
    expect(emitEnvLabel('https://ep-tokenscope-sandbox-aue.example.com/bearer')).toBe('Sandbox')
    expect(emitEnvLabel('https://tokenscope-production.example.com/bearer')).toBe('Prod')
  })

  it('classifies localhost as Local', () => {
    expect(emitEnvLabel('http://localhost:3000/bearer')).toBe('Local')
  })

  it('returns the bare host for an unrecognised deployment', () => {
    expect(emitEnvLabel('https://ts.example.com/bearer')).toBe('ts.example.com')
  })

  it('returns null when nothing is configured', () => {
    expect(emitEnvLabel('', '')).toBe(null)
    expect(emitEnvLabel(undefined, undefined)).toBe(null)
  })
})

describe.skipIf(POSIX_ONLY)('removeBlock idempotency', () => {
  const BLOCK_START = '# >>> TokenScope >>>'
  const BLOCK_END   = '# <<< TokenScope <<<'

  it('removeBlock strips the delimited block and leaves surrounding content intact', () => {
    const content = `# preamble\n${BLOCK_START}\nexport FOO=bar\n${BLOCK_END}\n# epilogue\n`
    const stripped = removeBlock(content)
    expect(stripped).not.toContain('FOO=bar')
    expect(stripped).toContain('# preamble')
    expect(stripped).toContain('# epilogue')
  })

  it('removeBlock is idempotent (double-remove safe)', () => {
    const content = `${BLOCK_START}\nexport X=1\n${BLOCK_END}\n`
    expect(removeBlock(removeBlock(content))).toBe(removeBlock(content))
  })
})

describe.skipIf(POSIX_ONLY)('cutover to the usage extension (armUsageExtension)', () => {
  const BLOCK_START = '# >>> TokenScope >>>'
  const BLOCK_END = '# <<< TokenScope <<<'
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ts-cutover-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('removes the old exporter block from every rc that carries it, leaves the rest of each file, and touches no other rc', () => {
    const withBlock = join(home, '.bashrc')
    writeFileSync(withBlock, `# mine\n${BLOCK_START}\nexport COPILOT_OTEL_FILE_EXPORTER_PATH=".tokenscope.local/copilot-otel.jsonl"\n${BLOCK_END}\nalias ll='ls -l'\n`)
    const without = join(home, '.profile')
    writeFileSync(without, '# untouched\n')
    const before = statSync(without).mtimeMs
    const settingsPath = join(home, '.copilot', 'settings.json')

    const r = armUsageExtension([withBlock, without, join(home, '.zshrc')], { settingsPath })
    expect(r.rcCleaned).toEqual([withBlock])
    const cleaned = readFileSync(withBlock, 'utf8')
    expect(cleaned).not.toContain('COPILOT_OTEL_FILE_EXPORTER_PATH')
    expect(cleaned).toContain('# mine')
    expect(cleaned).toContain("alias ll='ls -l'")
    expect(statSync(without).mtimeMs).toBe(before)
    expect(existsSync(join(home, '.zshrc'))).toBe(false) // never creates an rc
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ enabledFeatureFlags: { EXTENSIONS: true }, extensions: { mode: 'load_only' } })
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
  })

  it("finds Copilot's settings the way Copilot does: $COPILOT_HOME, else $HOME (not the passwd home)", () => {
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      expect(copilotSettingsPath({})).toBe(join(home, '.copilot', 'settings.json'))
      expect(copilotSettingsPath({ COPILOT_HOME: '/opt/ch' })).toBe('/opt/ch/settings.json')
    } finally {
      process.env.HOME = saved
    }
  })

  it("merges the flag into Copilot's existing settings without losing other keys or flags", () => {
    const settingsPath = join(home, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', enabledFeatureFlags: { AUTO_APPROVAL: true } }))
    expect(enableExtensionsFeature(settingsPath)).toBe('enabled')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      enabledFeatureFlags: { AUTO_APPROVAL: true, EXTENSIONS: true },
      extensions: { mode: 'load_only' },
    })
    expect(enableExtensionsFeature(settingsPath)).toBe('already')
  })

  it("sets load_only (the agent cannot create or load extensions) unless the user chose a mode, and never overrides 'disabled'", () => {
    const settingsPath = join(home, 'settings.json')
    // Already enabled, no mode: tightened to load_only.
    writeFileSync(settingsPath, JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
    expect(enableExtensionsFeature(settingsPath)).toBe('enabled')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions).toEqual({ mode: 'load_only' })
    // A mode the user chose is kept.
    writeFileSync(settingsPath, JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true }, extensions: { mode: 'load_and_augment' } }))
    expect(enableExtensionsFeature(settingsPath)).toBe('already')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions.mode).toBe('load_and_augment')
    // 'disabled' is the user's choice and capture needs extensions: manual, file untouched.
    const off = JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true }, extensions: { mode: 'disabled' } })
    writeFileSync(settingsPath, off)
    expect(enableExtensionsFeature(settingsPath)).toBe('manual')
    expect(readFileSync(settingsPath, 'utf8')).toBe(off)
  })

  it("Copilot's legacy config.json wins over settings.json: a mode or flags there are respected, never silently overridden", () => {
    const settingsPath = join(home, 'settings.json')
    writeFileSync(join(home, 'config.json'), JSON.stringify({ extensions: { mode: 'disabled' } }))
    const logs: string[] = []
    expect(enableExtensionsFeature(settingsPath, { log: (m: string) => logs.push(m) })).toBe('manual')
    expect(existsSync(settingsPath)).toBe(false) // nothing written that config.json would shadow
    expect(logs.join(' ')).toMatch(/config\.json defines/)
    writeFileSync(join(home, 'config.json'), JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
    expect(enableExtensionsFeature(settingsPath)).toBe('already')
  })

  it('logs the extension mode actually in effect, never a mode it did not set', () => {
    const settingsPath = join(home, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ extensions: { mode: 'load_and_augment' } }))
    const logs: string[] = []
    expect(enableExtensionsFeature(settingsPath, { log: (m: string) => logs.push(m) })).toBe('enabled')
    expect(logs.join(' ')).toMatch(/extension mode: load_and_augment/)
    expect(logs.join(' ')).not.toMatch(/load_only/)
    // A symlinked file with the flag on and no mode: 'already', and it says the mode is the default.
    const target = join(home, 'linked.json')
    writeFileSync(target, JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
    const linked = join(home, 'linked-settings.json')
    symlinkSync(target, linked)
    const l2: string[] = []
    expect(enableExtensionsFeature(linked, { log: (m: string) => l2.push(m) })).toBe('already')
    expect(l2.join(' ')).toMatch(/mode is the default/)
  })

  it('a hand-written JSONC settings file is read (so a flag enabled by hand counts) but never rewritten', () => {
    const settingsPath = join(home, 'settings.json')
    const on = '// mine\n{\n  "enabledFeatureFlags": { "EXTENSIONS": true, },\n}\n'
    writeFileSync(settingsPath, on)
    expect(enableExtensionsFeature(settingsPath)).toBe('already')
    expect(readFileSync(settingsPath, 'utf8')).toBe(on)
    const offJsonc = '// mine\n{ "theme": "dark", }\n'
    writeFileSync(settingsPath, offJsonc)
    const logs: string[] = []
    expect(enableExtensionsFeature(settingsPath, { log: (m: string) => logs.push(m) })).toBe('manual')
    expect(readFileSync(settingsPath, 'utf8')).toBe(offJsonc)
    expect(logs.join(' ')).toMatch(/edit it by hand/)
  })

  it("never quotes the settings file in its message (through a symlink it could be any file)", () => {
    const secret = join(home, 'private.txt')
    writeFileSync(secret, 'TOP-SECRET-VALUE not json')
    const settingsPath = join(home, 'settings.json')
    symlinkSync(secret, settingsPath)
    const logs: string[] = []
    expect(enableExtensionsFeature(settingsPath, { log: (m: string) => logs.push(m) })).toBe('manual')
    expect(logs.join(' ')).not.toMatch(/TOP-SECRET/)
    expect(logs.join(' ')).toMatch(/syntax TokenScope cannot read/)
  })

  it("never rewrites a settings file it cannot parse (Copilot's own format), and says how to enable it", () => {
    const settingsPath = join(home, 'settings.json')
    const jsonc = '// copilot settings\n{ "theme": "dark", }\n'
    writeFileSync(settingsPath, jsonc)
    const logs: string[] = []
    expect(enableExtensionsFeature(settingsPath, { log: (m: string) => logs.push(m) })).toBe('manual')
    expect(readFileSync(settingsPath, 'utf8')).toBe(jsonc)
    expect(logs.join(' ')).toMatch(/"EXTENSIONS": true/)
  })

  it('a settings file that cannot be written is the manual path, with the same guidance, never a throw', () => {
    const blocker = join(home, 'not-a-dir')
    writeFileSync(blocker, 'x') // the settings "directory" is a file, so mkdir fails
    const logs: string[] = []
    expect(enableExtensionsFeature(join(blocker, 'settings.json'), { log: (m: string) => logs.push(m) })).toBe('manual')
    expect(logs.join(' ')).toMatch(/"EXTENSIONS": true/)
  })

  it('never writes through a symlinked settings file, but reads one: enabled by hand is recognised', () => {
    const target = join(home, 'elsewhere.json')
    writeFileSync(target, '{}')
    const settingsPath = join(home, 'settings.json')
    symlinkSync(target, settingsPath)
    expect(enableExtensionsFeature(settingsPath)).toBe('manual')
    expect(readFileSync(target, 'utf8')).toBe('{}')
    writeFileSync(target, JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
    expect(enableExtensionsFeature(settingsPath)).toBe('already')
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  })

  const legacyRc = `# mine\n${BLOCK_START}\nexport COPILOT_OTEL_FILE_EXPORTER_PATH="x"\n${BLOCK_END}\n`

  it('make before break: when the feature cannot be enabled, the old exporter block stays', () => {
    const rc = join(home, '.bashrc')
    writeFileSync(rc, legacyRc)
    const settingsPath = join(home, 'settings.json')
    writeFileSync(settingsPath, '// jsonc\n{}')
    const r = armUsageExtension([rc], { settingsPath })
    expect(r).toEqual({ rcCleaned: [], extensions: 'manual', projectsCleaned: [] })
    expect(readFileSync(rc, 'utf8')).toBe(legacyRc)
  })

  it('keeps the rc file mode, and reports a symlinked rc instead of replacing the link', () => {
    const rc = join(home, '.bashrc')
    writeFileSync(rc, legacyRc)
    chmodSync(rc, 0o600)
    const real = join(home, 'dotfiles-zshrc')
    writeFileSync(real, legacyRc)
    const link = join(home, '.zshrc')
    symlinkSync(real, link)
    const logs: string[] = []
    const r = armUsageExtension([rc, link], { settingsPath: join(home, 'settings.json'), log: (m: string) => logs.push(m) })
    expect(r.rcCleaned).toEqual([rc])
    expect(statSync(rc).mode & 0o777).toBe(0o600)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe(legacyRc)
    expect(logs.join(' ')).toMatch(/symlink/)
  })

  it('an rc that cannot be read is reported and skipped; the other rc files are still cleaned', () => {
    const broken = join(home, '.profile')
    mkdirSync(broken) // EISDIR on read
    const rc = join(home, '.bashrc')
    writeFileSync(rc, legacyRc)
    const logs: string[] = []
    const r = armUsageExtension([broken, rc], { settingsPath: join(home, 'settings.json'), log: (m: string) => logs.push(m) })
    expect(r.rcCleaned).toEqual([rc])
    expect(logs.join(' ')).toMatch(/Could not clean .*\.profile/)
  })

  it('at migration, removes the legacy forwarder files from each project once, and nothing else there', () => {
    const p1 = join(home, 'repo1')
    const p2 = join(home, 'repo2')
    for (const p of [p1, p2]) mkdirSync(join(p, '.tokenscope.local'), { recursive: true })
    for (const f of ['copilot-otel.jsonl', 'forwarder-offset', 'copilot-forwarder.pid']) writeFileSync(join(p1, '.tokenscope.local', f), 'x')
    writeFileSync(join(p2, '.tokenscope.local', 'copilot-otel.jsonl'), 'x')
    writeFileSync(join(p2, '.tokenscope.local', 'user-notes.txt'), 'keep me')
    writeFileSync(join(p1, '.tokenscope'), 'committed project code')
    const r = armUsageExtension([], { settingsPath: join(home, 'settings.json'), projectDirs: [p1, p2, p1, 'relative/dir'] })
    expect(r.projectsCleaned.sort()).toEqual([p1, p2].sort())
    expect(existsSync(join(p1, '.tokenscope.local'))).toBe(false)
    expect(existsSync(join(p1, '.tokenscope'))).toBe(true)
    expect(existsSync(join(p2, '.tokenscope.local', 'copilot-otel.jsonl'))).toBe(false)
    expect(readFileSync(join(p2, '.tokenscope.local', 'user-notes.txt'), 'utf8')).toBe('keep me')
  })

  it('does not remove them when the migration could not enable extensions (the forwarder still needs them)', () => {
    const p1 = join(home, 'repo1')
    mkdirSync(join(p1, '.tokenscope.local'), { recursive: true })
    writeFileSync(join(p1, '.tokenscope.local', 'copilot-otel.jsonl'), 'x')
    const settingsPath = join(home, 'settings.json')
    writeFileSync(settingsPath, '// jsonc\n{}')
    expect(armUsageExtension([], { settingsPath, projectDirs: [p1] }).projectsCleaned).toEqual([])
    expect(existsSync(join(p1, '.tokenscope.local', 'copilot-otel.jsonl'))).toBe(true)
  })

  it("finds the projects to clean: the current one plus Copilot's trusted folders (config read, never written)", () => {
    const ch = join(home, 'ch')
    mkdirSync(ch)
    const cfg = '{"trustedFolders":["/a/repo","/b/repo"],"other":1}'
    writeFileSync(join(ch, 'config.json'), cfg)
    expect(legacyProjectDirs('/cwd/repo', join(ch, 'settings.json'))).toEqual(['/cwd/repo', '/a/repo', '/b/repo'])
    expect(readFileSync(join(ch, 'config.json'), 'utf8')).toBe(cfg)
    expect(legacyProjectDirs('/cwd/repo', join(home, 'none', 'settings.json'))).toEqual(['/cwd/repo'])
    // Read the way every other reader reads Copilot's files: comments and trailing commas tolerated.
    writeFileSync(join(ch, 'config.json'), '// mine\n{ "trustedFolders": ["/a/repo",], }\n')
    expect(legacyProjectDirs('/cwd/repo', join(ch, 'settings.json'))).toEqual(['/cwd/repo', '/a/repo'])
  })

  it('a start marker with no end marker leaves the file alone (never deletes to end of file)', () => {
    const torn = `# mine\n${BLOCK_START}\nexport X=1\nalias ll='ls -l'\n`
    expect(removeBlock(torn)).toBe(torn)
    const nested = `${BLOCK_START}\nexport A=1\n# user line\n${BLOCK_START}\nexport B=2\n${BLOCK_END}\n`
    expect(removeBlock(nested)).toBe(nested)
    const twoBlocks = `${BLOCK_START}\nexport A=1\n${BLOCK_END}\n# keep\n${BLOCK_START}\nexport B=2\n${BLOCK_END}\n`
    expect(removeBlock(twoBlocks)).toBe('# keep\n')
    const rc = join(home, '.bashrc')
    writeFileSync(rc, torn)
    expect(armUsageExtension([rc], { settingsPath: join(home, 'settings.json') }).rcCleaned).toEqual([])
    expect(readFileSync(rc, 'utf8')).toBe(torn)
  })
})

describe.skipIf(POSIX_ONLY)('--remove (uninstall) cleans rc files the same way migration does', () => {
  it('removes the block from every rc, keeps each file mode, and never replaces a symlinked rc', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-remove-'))
    try {
      const block = `# mine\n# >>> TokenScope >>>\nexport COPILOT_OTEL_FILE_EXPORTER_PATH="x"\n# <<< TokenScope <<<\n`
      writeFileSync(join(home, '.bashrc'), block)
      chmodSync(join(home, '.bashrc'), 0o600)
      writeFileSync(join(home, '.zshrc'), block) // written under another shell
      writeFileSync(join(home, 'dotfiles-profile'), block)
      symlinkSync(join(home, 'dotfiles-profile'), join(home, '.profile'))
      const r = spawnSync(process.execPath, [join(__dirname, '../../../plugin/scripts/copilot-redeem.mjs'), '--remove'], {
        env: { ...process.env, HOME: home, SHELL: '/bin/bash' },
        encoding: 'utf8',
      })
      expect(r.status).toBe(0)
      for (const f of ['.bashrc', '.zshrc']) expect(readFileSync(join(home, f), 'utf8')).toBe('# mine\n')
      expect(statSync(join(home, '.bashrc')).mode & 0o777).toBe(0o600)
      expect(lstatSync(join(home, '.profile')).isSymbolicLink()).toBe(true)
      expect(r.stdout).toMatch(/\.profile is a symlink/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a block left only in a symlinked rc is reported, not "nothing to remove"', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-remove-link-'))
    try {
      writeFileSync(join(home, 'dotfiles-profile'), '# >>> TokenScope >>>\nexport X=1\n# <<< TokenScope <<<\n')
      symlinkSync(join(home, 'dotfiles-profile'), join(home, '.profile'))
      const r = spawnSync(process.execPath, [join(__dirname, '../../../plugin/scripts/copilot-redeem.mjs'), '--remove'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      })
      expect(r.stdout).toMatch(/\.profile is a symlink/)
      expect(r.stdout).not.toMatch(/nothing to remove/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe.skipIf(POSIX_ONLY)('detectShellRcTargets — cleanup reaches every rc an earlier setup may have written', () => {
  it('every supported rc that exists, whatever the current shell (a bash block survives a switch to zsh)', () => {
    expect(detectShellRcTargets(undefined, dir)).toEqual([])
    for (const f of ['.bashrc', '.profile', '.zshrc', '.zshenv']) writeFileSync(join(dir, f), '# x\n')
    writeFileSync(join(dir, '.not-an-rc'), '# x\n')
    expect(detectShellRcTargets(undefined, dir).sort()).toEqual(['.bashrc', '.profile', '.zshenv', '.zshrc'].map((f) => join(dir, f)).sort())
  })

  it('explicit --shell-rc names the one file', () => {
    expect(detectShellRcTargets('/custom/rc', dir)).toEqual(['/custom/rc'])
  })
})

// ── the credential store's ANCHOR (audit round 2, finding 2) ────────────────
//
// config.json holds oauth_refresh_token, so the directory it lands in is a
// TRUST SINK. os.homedir() consults $HOME first, so a model- or repo-set HOME
// redirected the durable credential into a directory somebody else chose. The
// anchor is the passwd home (realHome()), which an env var cannot move.
//
// The assertion is on the ANCHOR rather than on a real write, deliberately: a
// test that let the no-override path run would write into the developer's own
// ~/.tokenscope. TOKENSCOPE_DIR is the value writeTokenscopeConfig defaults to,
// so pinning it pins the write.
describe.skipIf(POSIX_ONLY)('the durable credential store does not follow a moved $HOME', () => {
  const HOME_KEYS = ['HOME', 'USERPROFILE'] as const

  it('TOKENSCOPE_DIR is anchored on the passwd home, not $HOME', async () => {
    const saved = Object.fromEntries(HOME_KEYS.map((k) => [k, process.env[k]]))
    const moved = mkdtempSync(join(tmpdir(), 'ts-moved-home-'))
    try {
      // Set HOME *before* the import: TOKENSCOPE_DIR is resolved at module load.
      for (const k of HOME_KEYS) process.env[k] = moved
      vi.resetModules()
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — mjs import resolved by Vitest
      const mod = await import('../../../plugin/scripts/copilot-redeem.mjs')
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — mjs import resolved by Vitest
      const { realHome } = await import('../../../plugin/scripts/real-home.mjs')

      expect(mod.TOKENSCOPE_DIR).toBe(join(realHome(), '.tokenscope'))
      expect(mod.TOKENSCOPE_DIR).not.toBe(join(moved, '.tokenscope'))
      expect(mod.TOKENSCOPE_DIR.startsWith(moved)).toBe(false)
    } finally {
      for (const k of HOME_KEYS) {
        // Reflect.deleteProperty, not `delete` (lint: no-dynamic-delete); and never
        // assign undefined — process.env stringifies it to the literal "undefined".
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = saved[k] as string
      }
      rmSync(moved, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('the shell-rc targets DO still follow $HOME (the shell resolves them that way)', () => {
    // The other direction, so the anchor change is not over-applied: an rc file
    // is executed by the user's SHELL, which finds it through $HOME. Only the
    // credential moved to the passwd home.
    writeFileSync(join(dir, '.bashrc'), '# x\n')
    writeFileSync(join(dir, '.profile'), '# x\n')
    expect(detectShellRcTargets(undefined, dir)).toEqual([join(dir, '.bashrc'), join(dir, '.profile')])
  })
})
