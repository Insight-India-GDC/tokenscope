/*
 * env-builder — the per-repo OTel tag + settings-merge helpers.
 * Guards that merging never clobbers a developer's pre-existing local settings
 * and that the repo resource-attr string carries the instance id + code_hash.
 *
 * (The global device env block — buildDeviceEnvBlock — was removed in the
 * OAuth/MCP cutover; device emit is now provisioned by provision_emit →
 * /setup/redeem, not by this module.)
 *
 * Also the helper command (S1/S8 of #408, #410): buildHelperCommand is the one
 * producer of `otelHeadersHelper`, and reconcileHelperCommand is the migration
 * of a value already on disk, rebuilt from its record and never string-replaced.
 */
import { describe, it, expect } from 'vitest'
import {
  buildRepoResourceAttrs,
  mergeClaudeSettings,
  buildHelperCommand,
  parseHelperCommand,
  reconcileHelperCommand,
  reconcilePluginPaths,
  sharedHomeEquivalent,
} from '../../../plugin/scripts/env-builder.mjs'

// Windows (#430): skipped on win32 because this file builds from POSIX fixture paths (the win32 command shape is tested here with platform: 'win32' on every OS).
const POSIX_ONLY = process.platform === 'win32'

const LINUX = { record: { tool: 'claude-code', platform: 'linux' }, scriptsDir: '/plugin/scripts' }
const LINUX_CMD = '"/plugin/scripts/otel-headers-helper.sh" --tool claude-code'
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe.skipIf(POSIX_ONLY)('buildRepoResourceAttrs', () => {
  it('carries the instance id, project.code_hash, and tool in the server attr ordering', () => {
    expect(buildRepoResourceAttrs('sid', 'abc123')).toBe(
      'tokenscope.instance_id=sid,project.code_hash=abc123,tool=claude-code',
    )
  })
})

describe.skipIf(POSIX_ONLY)('mergeClaudeSettings', () => {
  it('preserves existing keys, sets the helper, merges the env block', () => {
    const existing = { permissions: { allow: ['Bash(node:*)'] }, env: { FOO: 'bar' } }
    const merged = mergeClaudeSettings(existing, LINUX, {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    })
    expect(merged.permissions).toEqual({ allow: ['Bash(node:*)'] })
    expect(merged.otelHeadersHelper).toBe(LINUX_CMD)
    expect(merged.env.FOO).toBe('bar') // pre-existing env preserved
    expect(merged.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1') // new merged in
  })

  it('handles a missing / non-object existing settings', () => {
    const merged = mergeClaudeSettings(null, LINUX, { A: '1' })
    expect(merged.env).toEqual({ A: '1' })
    expect(merged.otelHeadersHelper).toBe(LINUX_CMD)
  })

  it('replaces the env block wholesale when replaceEnv is set (repo-pin self-heal)', () => {
    const existing = { permissions: { allow: ['x'] }, env: { STALE: 'gone', FOO: 'old' } }
    const merged = mergeClaudeSettings(existing, LINUX, { FOO: 'new' }, { replaceEnv: true })
    expect(merged.env).toEqual({ FOO: 'new' }) // STALE dropped, not key-merged
    expect(merged.permissions).toEqual({ allow: ['x'] }) // non-env keys preserved
  })

  it('refuses a bare path (the old signature) instead of writing an unbuilt command', () => {
    expect(() => mergeClaudeSettings({}, '/h.sh', {})).toThrow(TypeError)
  })

  it('leaves otelHeadersHelper alone when no helper is given', () => {
    expect(mergeClaudeSettings({ otelHeadersHelper: 'mine' }, null, {}).otelHeadersHelper).toBe('mine')
  })
})

describe.skipIf(POSIX_ONLY)('buildHelperCommand', () => {
  it('POSIX: quoted script, --tool always, --state-dir only when the record has one', () => {
    expect(buildHelperCommand({ tool: 'claude-code', platform: 'darwin' }, { scriptsDir: '/p/scripts' })).toBe(
      '"/p/scripts/otel-headers-helper.sh" --tool claude-code',
    )
    expect(
      buildHelperCommand({ tool: 'copilot-cli', platform: 'linux', stateDir: '/home/u/.ts-sandbox' }, { scriptsDir: '/p/scripts' }),
    ).toBe('"/p/scripts/otel-headers-helper.sh" --tool copilot-cli --state-dir /home/u/.ts-sandbox')
  })

  it('POSIX: a space survives sh, and $ ` \\ " are not expanded inside the quotes', () => {
    const cmd = buildHelperCommand(
      { tool: 'claude-code', platform: 'linux', stateDir: '/home/a b/$HOME`id`\\x' },
      { scriptsDir: '/Users/Jo "D"/scripts' },
    )
    expect(cmd).toBe(
      '"/Users/Jo \\"D\\"/scripts/otel-headers-helper.sh" --tool claude-code --state-dir "/home/a b/\\$HOME\\`id\\`\\\\x"',
    )
  })

  it('win32: the PowerShell command, from platform alone (no real Windows needed)', () => {
    expect(
      buildHelperCommand(
        { tool: 'claude-code', platform: 'win32', stateDir: 'C:\\Users\\Jo Do\\.tokenscope\\' },
        { scriptsDir: 'C:\\Users\\Jo Do\\plugins\\scripts' },
      ),
    ).toBe(
      `"${PS}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ` +
        '"C:\\Users\\Jo Do\\plugins\\scripts\\otel-headers-helper.ps1" --tool claude-code ' +
        // The trailing backslash is doubled so it cannot escape the closing quote.
        '--state-dir "C:\\Users\\Jo Do\\.tokenscope\\\\"',
    )
  })

  it.each([
    ['an unknown tool', { tool: 'cursor', platform: 'linux' }, '/p', /unknown tool/],
    ['an unknown record field', { tool: 'claude-code', platform: 'linux', path: '/x' }, '/p', /unknown field/],
    ['a relative state dir', { tool: 'claude-code', platform: 'linux', stateDir: 'rel' }, '/p', /not absolute/],
    ['a state dir with a newline', { tool: 'claude-code', platform: 'linux', stateDir: '/a\nb' }, '/p', /not usable/],
    ['a relative scripts dir', { tool: 'claude-code', platform: 'linux' }, 'p/scripts', /scripts dir/],
    ['% on Windows (cmd.exe expands it inside quotes)', { tool: 'claude-code', platform: 'win32', stateDir: 'C:\\%TEMP%' }, 'C:\\p', /cmd\.exe/],
  ])('refuses %s', (_l, record, scriptsDir, reason) => {
    expect(() => buildHelperCommand(record, { scriptsDir })).toThrow(reason)
  })

  it('round-trips through parseHelperCommand on both platforms', () => {
    for (const [record, scriptsDir] of [
      [{ tool: 'claude-code', platform: 'linux', stateDir: '/home/a b/$x' }, '/s p/scripts'],
      [{ tool: 'copilot-cli', platform: 'win32', stateDir: 'C:\\U s\\.ts\\' }, 'C:\\U s\\scripts'],
    ] as const) {
      const parsed = parseHelperCommand(buildHelperCommand(record, { scriptsDir }))
      expect(parsed).toMatchObject({ scriptDir: scriptsDir, tool: record.tool, stateDir: record.stateDir })
    }
  })
})

/*
 * cmd.exe runs the persisted value and searches the CURRENT DIRECTORY (the
 * repository) before PATH, and a repository can set PATH: a bare interpreter
 * name lets a repo pick the program that receives the refresh token.
 */
describe.skipIf(POSIX_ONLY)('the persisted Windows command never starts with a bare interpreter', () => {
  const rec = { tool: 'claude-code', platform: 'win32' } as const

  it('starts with the absolute, quoted powershell.exe', () => {
    const cmd = buildHelperCommand(rec, { scriptsDir: 'C:\\p\\scripts' })
    expect(cmd).toMatch(/^"[A-Za-z]:\\[^"]*\\powershell\.exe" -NoProfile /)
    expect(cmd.startsWith(`"${PS}" `)).toBe(true)
  })

  it('takes a non-C: install from the resolver, and refuses anything that is not an absolute powershell.exe', () => {
    const d = 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(buildHelperCommand(rec, { scriptsDir: 'C:\\p', powershell: d }).startsWith(`"${d}" `)).toBe(true)
    for (const bad of ['powershell.exe', 'pwsh', '.\\powershell.exe', 'C:\\repo\\powershell.exe']) {
      expect(() => buildHelperCommand(rec, { scriptsDir: 'C:\\p', powershell: bad })).toThrow(/absolute/)
    }
  })

  it('the bare legacy value is still recognised as ours', () => {
    const legacy =
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\U s\\scripts\\otel-headers-helper.ps1" --tool claude-code --state-dir C:\\s'
    expect(parseHelperCommand(legacy)).toEqual({
      script: 'C:\\U s\\scripts\\otel-headers-helper.ps1',
      scriptDir: 'C:\\U s\\scripts',
      tool: 'claude-code',
      stateDir: 'C:\\s',
    })
  })

  it('a quoted interpreter that is not Windows PowerShell is NOT ours', () => {
    expect(
      parseHelperCommand('"C:\\repo\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\p\\otel-headers-helper.ps1"'),
    ).toBeNull()
  })

  it('migrates: a bare legacy value at the active version is rebuilt with the absolute path', () => {
    const dir = 'C:\\Users\\Jo\\.claude\\plugins\\cache\\tokenscope\\tokenscope\\1.1.0\\scripts'
    const legacy = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${dir}\\otel-headers-helper.ps1" --tool claude-code`
    const healed = reconcileHelperCommand(legacy, { scriptsDir: dir, platform: 'win32', exists: () => true })
    expect(healed).toBe(`"${PS}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${dir}\\otel-headers-helper.ps1" --tool claude-code`)
    // ...and the healed value is stable.
    expect(reconcileHelperCommand(healed, { scriptsDir: dir, platform: 'win32', exists: () => true })).toBe(healed)
  })
})

describe.skipIf(POSIX_ONLY)('parseHelperCommand — reads back only what we could have written', () => {
  it('the pre-sprint bare path, spaces and all, with a hand-added --state-dir', () => {
    expect(parseHelperCommand('/Users/Jo Do/x/otel-headers-helper.sh --state-dir /tmp/s')).toEqual({
      script: '/Users/Jo Do/x/otel-headers-helper.sh',
      scriptDir: '/Users/Jo Do/x',
      stateDir: '/tmp/s',
    })
  })

  it.each([
    ['another script', '/usr/local/bin/my-helper.sh'],
    ['a flag the record cannot carry', '/x/otel-headers-helper.sh --tool-dir /opt/bin'],
    ['a repeated flag', '/x/otel-headers-helper.sh --state-dir /a --state-dir /b'],
    ['a dangling flag', '/x/otel-headers-helper.sh --state-dir'],
    ['an unterminated quote', '"/x/otel-headers-helper.sh --tool claude-code'],
  ])('null for %s', (_l, value) => {
    expect(parseHelperCommand(value)).toBeNull()
  })
})

/*
 * S8 migration fixtures. `exists` is injected so each case states the disk it
 * assumes. Every one of these failed on 8f5d8293, where the self-heal replaced
 * the value with the bare active path (or did not exist as a function).
 */
describe.skipIf(POSIX_ONLY)('reconcileHelperCommand — migrating a value already on disk', () => {
  const v = (ver: string) => `/h/.claude/plugins/cache/tokenscope/tokenscope/${ver}/scripts`
  const ACTIVE = v('1.1.0')
  const everything = () => true
  const heal = (current: string, opts: Record<string, unknown> = {}) =>
    reconcileHelperCommand(current, { scriptsDir: ACTIVE, platform: 'linux', exists: everything, ...opts })

  it('bare .sh path → the quoted form at the active version', () => {
    expect(heal(`${v('1.0.0')}/otel-headers-helper.sh`)).toBe(`"${ACTIVE}/otel-headers-helper.sh" --tool claude-code`)
  })

  it('.sh + --state-dir → the state dir is PRESERVED (#410), not dropped', () => {
    expect(heal(`${v('1.0.0')}/otel-headers-helper.sh --state-dir /home/u/.ts-sandbox`)).toBe(
      `"${ACTIVE}/otel-headers-helper.sh" --tool claude-code --state-dir /home/u/.ts-sandbox`,
    )
  })

  it('same version, old shape → reshaped in place (no version bump needed)', () => {
    expect(heal(`${ACTIVE}/otel-headers-helper.sh`)).toBe(`"${ACTIVE}/otel-headers-helper.sh" --tool claude-code`)
  })

  it('unversioned marketplace pin → repaired from the versioned active install', () => {
    expect(heal('/h/.claude/plugins/marketplaces/tokenscope/plugin/scripts/otel-headers-helper.sh')).toBe(
      `"${ACTIVE}/otel-headers-helper.sh" --tool claude-code`,
    )
  })

  it('version N+1 under plugin N → untouched (a downgrade never rewrites a newer pin)', () => {
    expect(heal(`"${v('1.2.0')}/otel-headers-helper.sh" --tool claude-code --state-dir /s`)).toBeNull()
    expect(heal(`${v('1.2.0')}/otel-headers-helper.sh`)).toBeNull()
  })

  it('version N+1 under plugin N whose script is GONE → repaired (the one thing a downgrade may do)', () => {
    const exists = (p: string) => p.startsWith(ACTIVE)
    expect(heal(`${v('1.2.0')}/otel-headers-helper.sh --state-dir /s`, { exists })).toBe(
      `"${ACTIVE}/otel-headers-helper.sh" --tool claude-code --state-dir /s`,
    )
  })

  it('never points at a target that does not exist', () => {
    const exists = (p: string) => !p.startsWith(ACTIVE)
    expect(heal(`${v('1.0.0')}/otel-headers-helper.sh`, { exists })).toBeNull()
  })

  it('a Windows device moves off the .sh to the PowerShell helper', () => {
    const win = (ver: string) => `C:\\Users\\Jo Do\\.claude\\plugins\\cache\\tokenscope\\tokenscope\\${ver}\\scripts`
    expect(
      reconcileHelperCommand(`${win('1.0.0')}\\otel-headers-helper.sh`, {
        scriptsDir: win('1.1.0'),
        platform: 'win32',
        exists: everything,
      }),
    ).toBe(
      `"${PS}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win('1.1.0')}\\otel-headers-helper.ps1" --tool claude-code`,
    )
  })

  it('the stored record is looked up by the value\'s OWN state dir, and used', () => {
    const asked: unknown[] = []
    const recordFor = (sd: unknown) => {
      asked.push(sd)
      return { tool: 'claude-code', platform: 'darwin', stateDir: '/s' }
    }
    // The record's platform is NOT used: the running platform decides the helper.
    expect(heal(`${v('1.0.0')}/otel-headers-helper.sh --state-dir /s`, { recordFor })).toBe(
      `"${ACTIVE}/otel-headers-helper.sh" --tool claude-code --state-dir /s`,
    )
    expect(asked).toEqual(['/s'])
  })

  it('leaves alone what is not ours or not understood', () => {
    expect(heal('/usr/local/bin/otel-headers-helper.sh')).toBeNull()
    expect(heal(`${v('1.0.0')}/otel-headers-helper.sh --tool-dir /opt/bin`)).toBeNull()
  })

  it('is idempotent: a healed value heals to itself', () => {
    const once = heal(`${v('1.0.0')}/otel-headers-helper.sh --state-dir "/home/a b"`)!
    expect(heal(once)).toBe(once)
  })

  // #455: setup from a directory marketplace (a local checkout) wrote the
  // checkout's path, which the self-heal did not recognise, so it stayed after
  // the marketplace went back to GitHub.
  it('a checkout path from a directory-marketplace setup → moved to the versioned active install', () => {
    expect(heal('"/home/u/src/TokenScope/plugin/scripts/otel-headers-helper.sh" --tool claude-code')).toBe(
      `"${ACTIVE}/otel-headers-helper.sh" --tool claude-code`,
    )
  })

  it('a checkout path is left alone by a session running from the checkout itself', () => {
    const checkout = '/home/u/src/TokenScope/plugin/scripts'
    const cmd = `"${checkout}/otel-headers-helper.sh" --tool claude-code`
    expect(reconcileHelperCommand(cmd, { scriptsDir: checkout, platform: 'linux', exists: everything })).toBeNull()
  })

  it('a helper of the same name outside a plugin/scripts folder is still not ours', () => {
    expect(heal('/home/u/bin/otel-headers-helper.sh')).toBeNull()
  })
})

// #447: one ~/.claude shared by a host (/home/u) and a container (/home/claude).
describe.skipIf(POSIX_ONLY)('shared ~/.claude: the self-heal never ping-pongs between sides', () => {
  const HOST = '/home/u/.claude/plugins/cache/tokenscope/tokenscope/0.1.51/scripts'
  const CONT = '/home/claude/.claude/plugins/cache/tokenscope/tokenscope/0.1.51/scripts'
  // Seen from inside the container: only its own spelling exists.
  const inContainer = (p: string) => p.startsWith('/home/claude/')
  // The host has run a session recently (recorded in tokenscope-sides.json).
  const otherSides = ['/home/u/.claude']

  it('recognises the host spelling as the same install', () => {
    expect(sharedHomeEquivalent(`${HOST}/otel-headers-helper.sh`, CONT, inContainer, otherSides)).toBe(`${CONT}/otel-headers-helper.sh`)
  })

  it('is not a shared home when the prefix is the same, or the file is not here', () => {
    expect(sharedHomeEquivalent(`${CONT}/otel-headers-helper.sh`, CONT, inContainer)).toBeNull()
    expect(sharedHomeEquivalent(`${HOST}/otel-headers-helper.sh`, CONT, () => false)).toBeNull()
    expect(sharedHomeEquivalent('/usr/local/bin/otel-headers-helper.sh', CONT, inContainer)).toBeNull()
  })

  it('leaves the host-written helper alone in the container (it used to rewrite it)', () => {
    const hostCmd = `"${HOST}/otel-headers-helper.sh" --tool claude-code`
    expect(reconcileHelperCommand(hostCmd, { scriptsDir: CONT, platform: 'linux', exists: inContainer, otherSides })).toBeNull()
  })

  it('repairs it as before when no other side has run: a renamed or restored home', () => {
    const oldHome = `"${HOST}/otel-headers-helper.sh" --tool claude-code`
    expect(reconcileHelperCommand(oldHome, { scriptsDir: CONT, platform: 'linux', exists: inContainer })).toBe(
      `"${CONT}/otel-headers-helper.sh" --tool claude-code`,
    )
  })

  it('still repairs a path that is gone on every side', () => {
    const gone = '"/home/old/.claude/plugins/cache/tokenscope/tokenscope/0.1.40/scripts/otel-headers-helper.sh" --tool claude-code'
    const onlyActive = (p: string) => p.startsWith(CONT)
    // Not a shared home: the same suffix (0.1.40) does not exist here either.
    expect(reconcileHelperCommand(gone, { scriptsDir: CONT, platform: 'linux', exists: onlyActive })).toBe(
      `"${CONT}/otel-headers-helper.sh" --tool claude-code`,
    )
  })

  it('leaves the host-written status line alone in the container too', () => {
    const hostLine = { type: 'command', command: `"/usr/bin/node" "${HOST.replace('0.1.51', '0.1.50')}/statusline.mjs"` }
    const exists = (p: string) => p.startsWith('/home/claude/')
    const { changed } = reconcilePluginPaths(
      { statusLine: hostLine },
      { statuslinePath: `${CONT}/statusline.mjs`, scriptsDir: CONT, platform: 'linux', exists, otherSides },
    )
    expect(changed).toBe(false)
  })
})
