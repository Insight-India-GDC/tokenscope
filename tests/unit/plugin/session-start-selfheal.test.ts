/*
 * selfHealPluginPaths — the SessionStart hook's Job 0, which REWRITES the global
 * ~/.claude/settings.json (the file that holds the durable emit credential) to
 * repoint version-pinned plugin paths to the active version. These tests exercise
 * the dangerous I/O against a temp dir: it must never clobber an unparseable file,
 * must preserve the credential, must only repoint to targets that exist, and must
 * fail-open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { selfHealPluginPaths, dropSettingsRefreshToken } from '../../../plugin/hooks/session-start.mjs'
import { writeClaudeSettings } from '../../../plugin/scripts/claude-redeem.mjs'
import { buildHelperCommand } from '../../../plugin/scripts/env-builder.mjs'

// Windows (#430): skipped on win32 because this file expects the .sh helper; on win32 the helper is the .ps1.
const POSIX_ONLY = process.platform === 'win32'

let dir = ''
let settingsPath = ''
let storeDir = '' // the state dir; never the real ~/.tokenscope
let scriptsDir = '' // active version's scripts dir (cache-like layout so it's "ours" + versioned)

const STALE = {
  statusLine: { type: 'command', command: 'node "/x/plugins/cache/tokenscope/tokenscope/0.1.13/scripts/statusline.mjs"', padding: 0 },
  otelHeadersHelper: '/x/plugins/cache/tokenscope/tokenscope/0.1.13/scripts/otel-headers-helper.sh',
  env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'super-secret', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  permissions: { allow: ['Bash'] },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-selfheal-'))
  settingsPath = join(dir, 'settings.json')
  storeDir = join(dir, 'state')
  scriptsDir = join(dir, 'plugins', 'cache', 'tokenscope', 'tokenscope', '0.1.99', 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  writeFileSync(join(scriptsDir, 'statusline.mjs'), '// active')
  writeFileSync(join(scriptsDir, 'otel-headers-helper.sh'), '# active')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('selfHealPluginPaths', () => {
  it('repoints stale paths to the active version and PRESERVES the credential + other keys', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.statusLine.command).toBe(`"${process.execPath}" "${join(scriptsDir, 'statusline.mjs')}"`)
    expect(out.statusLine.padding).toBe(0)
    expect(out.otelHeadersHelper).toBe(`"${join(scriptsDir, 'otel-headers-helper.sh')}" --tool claude-code`)
    // The credential + unrelated keys survive untouched.
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret')
    expect(out.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(out.permissions).toEqual({ allow: ['Bash'] })
  })

  it('NEVER clobbers an unparseable settings.json (would wipe the credential)', () => {
    const garbage = '{ this is not valid json, has a secret: TOKEN '
    writeFileSync(settingsPath, garbage)
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage) // byte-for-byte untouched
  })

  it('NEVER replaces a present-but-unreadable settings.json (throws; main() contains it)', () => {
    const body = JSON.stringify(STALE, null, 2)
    writeFileSync(settingsPath, body)
    chmodSync(settingsPath, 0o000)
    try {
      expect(() => selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })).toThrow(/EACCES/)
    } finally {
      chmodSync(settingsPath, 0o600)
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(body)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
  })

  it('is idempotent: a second run makes no change and leaves no temp files', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    const after1 = readFileSync(settingsPath, 'utf8')
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(readFileSync(settingsPath, 'utf8')).toBe(after1)
    expect(readdirSync(dir).some((f) => f.includes('.tmp.'))).toBe(false)
  })

  it('does NOT repoint to a target that is missing on disk (no phantom path)', () => {
    rmSync(join(scriptsDir, 'otel-headers-helper.sh')) // active helper absent
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // statusline (present) healed; helper (missing target) left at its stale value.
    expect(out.statusLine.command).toContain('0.1.99')
    expect(out.otelHeadersHelper).toBe(STALE.otelHeadersHelper)
  })

  it('no-ops (fail-open) when settings.json does not exist', () => {
    expect(() => selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })).not.toThrow()
  })
})

/*
 * S8 of #408 / #410. On 8f5d8293 the self-heal REPLACED the value with the bare
 * active path, so a `--state-dir` was dropped at the next session start, and a
 * session-scoped settings file was never reached at all.
 */
describe.skipIf(POSIX_ONLY)('selfHealPluginPaths — rebuilds from the record', () => {
  const active = () => `"${join(scriptsDir, 'otel-headers-helper.sh')}" --tool claude-code`
  const helperOf = (p: string) => JSON.parse(readFileSync(p, 'utf8')).otelHeadersHelper

  it('keeps the --state-dir an existing value carries', () => {
    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: `${STALE.otelHeadersHelper} --state-dir /srv/ts state` }))
    // A pre-sprint hand edit: the value above is not parseable (unquoted space
    // in the arg), so it is left exactly as it is rather than guessed at.
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(settingsPath)).toBe(`${STALE.otelHeadersHelper} --state-dir /srv/ts state`)

    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: `${STALE.otelHeadersHelper} --state-dir /srv/ts` }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(settingsPath)).toBe(`${active()} --state-dir /srv/ts`)
  })

  it('rebuilds every session-scoped file listed in the state dir, each with its own state dir', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE))
    const scoped = join(dir, 'sandbox', 'settings.json')
    mkdirSync(join(dir, 'sandbox'))
    writeFileSync(scoped, JSON.stringify({ otelHeadersHelper: `${STALE.otelHeadersHelper} --state-dir ${join(dir, 'sb-state')}`, env: { K: 'v' } }))
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'settings-files.claude-code.json'), JSON.stringify({ version: 1, files: [scoped] }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(scoped)).toBe(`${active()} --state-dir ${join(dir, 'sb-state')}`)
    expect(JSON.parse(readFileSync(scoped, 'utf8')).env).toEqual({ K: 'v' })
  })

  it('also reads the list in the state dir the GLOBAL helper names', () => {
    const named = join(dir, 'named-state')
    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: `${STALE.otelHeadersHelper} --state-dir ${named}` }))
    const scoped = join(dir, 'sandbox', 'settings.json')
    mkdirSync(join(dir, 'sandbox'))
    writeFileSync(scoped, JSON.stringify({ otelHeadersHelper: STALE.otelHeadersHelper }))
    mkdirSync(named)
    writeFileSync(join(named, 'settings-files.claude-code.json'), JSON.stringify({ version: 1, files: [scoped] }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(scoped)).toBe(active())
  })

  it('skips a listed path that is not a settings.json inside home', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE))
    const outside = mkdtempSync(join(tmpdir(), 'ts-selfheal-outside-'))
    try {
      const foreign = join(outside, 'settings.json')
      const misnamed = join(dir, 'notes.json')
      for (const f of [foreign, misnamed]) writeFileSync(f, JSON.stringify({ otelHeadersHelper: STALE.otelHeadersHelper }))
      mkdirSync(storeDir)
      writeFileSync(join(storeDir, 'settings-files.claude-code.json'), JSON.stringify({ version: 1, files: [foreign, misnamed] }))
      selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
      expect(helperOf(foreign)).toBe(STALE.otelHeadersHelper)
      expect(helperOf(misnamed)).toBe(STALE.otelHeadersHelper)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('on win32 moves the device to the PowerShell helper', () => {
    writeFileSync(join(scriptsDir, 'otel-headers-helper.ps1'), '# active')
    writeFileSync(settingsPath, JSON.stringify(STALE))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir, platform: 'win32' })
    expect(helperOf(settingsPath)).toMatch(
      /^"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*otel-headers-helper\.ps1" --tool claude-code$/,
    )
  })

  it('a repo-set TOKENSCOPE_STATE_DIR does not choose the settings-files list', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE))
    const scoped = join(dir, 'sandbox', 'settings.json')
    mkdirSync(join(dir, 'sandbox'))
    writeFileSync(scoped, JSON.stringify({ otelHeadersHelper: STALE.otelHeadersHelper }))
    // The list a repository planted, in the dir its settings env points at.
    const planted = join(dir, 'repo-state')
    mkdirSync(planted)
    writeFileSync(join(planted, 'settings-files.claude-code.json'), JSON.stringify({ version: 1, files: [scoped] }))
    const saved = process.env.TOKENSCOPE_STATE_DIR
    process.env.TOKENSCOPE_STATE_DIR = planted
    try {
      // No storeDir: the default is under test. `home` confines every listed
      // path to the temp dir, so the real ~/.tokenscope list touches nothing.
      selfHealPluginPaths({ settingsPath, scriptsDir, home: dir })
    } finally {
      if (saved === undefined) delete process.env.TOKENSCOPE_STATE_DIR
      else process.env.TOKENSCOPE_STATE_DIR = saved
    }
    expect(helperOf(scoped)).toBe(STALE.otelHeadersHelper)
    expect(helperOf(settingsPath)).toBe(active())
  })

  it('emit-only snapshot: once Node is installed, the value moves to the active install', () => {
    // What claude-redeem.ps1 writes: the helper copied into <state>/helper/scripts.
    const snapDir = join(storeDir, 'helper', 'scripts')
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, 'otel-headers-helper.ps1'), '# snapshot')
    writeFileSync(join(scriptsDir, 'otel-headers-helper.ps1'), '# active')
    const ps = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File'
    const snapValue = `${ps} "${join(snapDir, 'otel-headers-helper.ps1')}" --tool claude-code`
    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: snapValue }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir, platform: 'win32' })
    // win32 join: the command is built for Windows even though this disk is POSIX.
    expect(helperOf(settingsPath)).toBe(`${ps} "${win32.join(scriptsDir, 'otel-headers-helper.ps1')}" --tool claude-code`)

    // A snapshot-shaped path for some OTHER state dir is not ours.
    const other = join(dir, 'elsewhere', 'helper', 'scripts', 'otel-headers-helper.ps1')
    const foreign = `${ps} "${other}" --tool claude-code`
    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: foreign }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir, platform: 'win32' })
    expect(helperOf(settingsPath)).toBe(foreign)
  })
})

/*
 * An ISOLATED enrolment: `claude-redeem --settings-path S --state-dir X` while the
 * global settings use the default store. S used to be listed in X only, and session
 * start never reads X (it is neither the default store nor the dir the global
 * helper names), so a plugin update left S on the removed version for good.
 */
describe.skipIf(POSIX_ONLY)('selfHealPluginPaths — a settings file enrolled in another state dir', () => {
  const bundleEnv = {
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt_isolated',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example.com/api/v1/oauth/token',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example.com/api/v1/instances/f825e796/bearer',
    TOKENSCOPE_OAUTH_CLIENT_ID: 'client-xyz',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ingest.example.com/v1/logs',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=f825e796,tool=claude-code',
  }
  const helperOf = (p: string) => JSON.parse(readFileSync(p, 'utf8')).otelHeadersHelper

  function enrolIsolated() {
    const oldScripts = join(dir, 'plugins', 'cache', 'tokenscope', 'tokenscope', '0.1.13', 'scripts')
    mkdirSync(oldScripts, { recursive: true })
    writeFileSync(join(oldScripts, 'otel-headers-helper.sh'), '# old')
    // The global file runs the default store (no --state-dir), on the old version.
    writeFileSync(settingsPath, JSON.stringify({ ...STALE, otelHeadersHelper: `"${join(oldScripts, 'otel-headers-helper.sh')}" --tool claude-code` }))
    const iso = join(dir, 'iso-state')
    const scoped = join(dir, 'project', '.claude', 'settings.json')
    mkdirSync(join(dir, 'project', '.claude'), { recursive: true })
    const record = { tool: 'claude-code', platform: process.platform, stateDir: iso }
    // What main() does for --settings-path S --state-dir X; `storeDir` stands in
    // for the trusted default store (the real one is the passwd home).
    writeClaudeSettings(scoped, { record, scriptsDir: oldScripts }, bundleEnv, iso, { sessionScoped: true, indexDir: storeDir })
    // The plugin update: 0.1.99 (beforeEach) is active, the old version is gone.
    rmSync(join(dir, 'plugins', 'cache', 'tokenscope', 'tokenscope', '0.1.13'), { recursive: true, force: true })
    return { iso, scoped, record }
  }

  it('is indexed in the default store, and session start moves it to the active install keeping --state-dir X', () => {
    const { iso, scoped, record } = enrolIsolated()
    const index = JSON.parse(readFileSync(join(storeDir, 'isolated-settings-files.claude-code.json'), 'utf8'))
    expect(index.entries).toEqual([{ file: scoped, stateDir: iso }])
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(scoped)).toBe(buildHelperCommand(record, { scriptsDir }))
    expect(helperOf(scoped)).toContain(`--state-dir ${iso}`)
    // The credential stays in X's store, never in S.
    expect(JSON.parse(readFileSync(join(iso, 'config.claude-code.json'), 'utf8')).oauth_refresh_token).toBe('rt_isolated')
    expect(JSON.parse(readFileSync(scoped, 'utf8')).env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
  })

  it('is left alone once its helper names a different state dir than the index pairs it with', () => {
    const { scoped } = enrolIsolated()
    const other = join(dir, 'other-state')
    const repointed = `${STALE.otelHeadersHelper} --state-dir ${other}`
    writeFileSync(scoped, JSON.stringify({ otelHeadersHelper: repointed }))
    selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
    expect(helperOf(scoped)).toBe(repointed)
  })

  it('an index entry outside home is skipped, not followed', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ts-selfheal-iso-outside-'))
    try {
      const foreign = join(outside, 'settings.json')
      const value = `${STALE.otelHeadersHelper} --state-dir ${outside}`
      writeFileSync(foreign, JSON.stringify({ otelHeadersHelper: value }))
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(
        join(storeDir, 'isolated-settings-files.claude-code.json'),
        JSON.stringify({ version: 1, entries: [{ file: foreign, stateDir: outside }] }),
      )
      selfHealPluginPaths({ settingsPath, scriptsDir, storeDir, home: dir })
      expect(helperOf(foreign)).toBe(value)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(POSIX_ONLY)('dropSettingsRefreshToken — the durable credential leaves the global env block', () => {
  const IID = '9a1e0000-0000-4000-8000-000000000001'
  const BEARER = `https://ts.example.com/api/v1/instances/${IID}/bearer`
  const writeStore = (inDir: string, bearer = BEARER) => {
    const iid = bearer.split('/instances/')[1]!.split('/')[0]!
    mkdirSync(inDir, { recursive: true })
    writeFileSync(
      join(inDir, 'config.claude-code.json'),
      JSON.stringify({
        version: 2,
        tool: 'claude-code',
        instance_id: iid,
        bearer_endpoint: bearer,
        oauth_token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
        oauth_client_id: 'cid',
        oauth_refresh_token: 'rt-in-store',
        otel_resource_attributes: `tokenscope.instance_id=${iid},tool=claude-code`,
      }),
    )
  }
  const settingsWithToken = (extra: Record<string, unknown> = {}) => ({
    permissions: { allow: ['Bash'] },
    env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-in-settings', TOKENSCOPE_BEARER_ENDPOINT: BEARER, MY_VAR: 'keep' },
    ...extra,
  })

  it('removes it once the store holds the same enrolment, keeping everything else', () => {
    writeStore(storeDir)
    writeFileSync(settingsPath, JSON.stringify(settingsWithToken()))
    expect(dropSettingsRefreshToken({ settingsPath, storeDir })).toBe(true)
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(out.env.TOKENSCOPE_BEARER_ENDPOINT).toBe(BEARER)
    expect(out.env.MY_VAR).toBe('keep')
    expect(out.permissions).toEqual({ allow: ['Bash'] })
  })

  it('leaves it alone with no store: it is still the only copy', () => {
    const body = JSON.stringify(settingsWithToken())
    writeFileSync(settingsPath, body)
    expect(dropSettingsRefreshToken({ settingsPath, storeDir })).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toBe(body)
  })

  it('leaves it alone when the store names another instance', () => {
    writeStore(storeDir, 'https://ts.example.com/api/v1/instances/9a1e0000-0000-4000-8000-000000000002/bearer')
    const body = JSON.stringify(settingsWithToken())
    writeFileSync(settingsPath, body)
    expect(dropSettingsRefreshToken({ settingsPath, storeDir })).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toBe(body)
  })

  it('checks the store the helper command names with --state-dir, not the default', () => {
    const other = join(dir, 'other-state')
    writeStore(other)
    const helper = buildHelperCommand({ tool: 'claude-code', platform: 'linux', stateDir: other }, { scriptsDir })
    writeFileSync(settingsPath, JSON.stringify(settingsWithToken({ otelHeadersHelper: helper })))
    expect(dropSettingsRefreshToken({ settingsPath, storeDir })).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
  })

  it('never clobbers an unparseable settings.json', () => {
    writeStore(storeDir)
    const garbage = '{ not json TOKENSCOPE_OAUTH_REFRESH_TOKEN'
    writeFileSync(settingsPath, garbage)
    expect(dropSettingsRefreshToken({ settingsPath, storeDir })).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage)
  })
})
