/**
 * #449 (Windows without Node): claude-redeem.ps1 and status.ps1 resolve the
 * install's config folder and state folder like claude-config-dir.mjs and
 * plugin-runtime.mjs claudeStateDir. Runs claude-config-dir.ps1 under pwsh with
 * a temp profile ($HOME; off Windows), so it skips on win32, where the profile
 * cannot be redirected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolvePwsh, childEnv } from './helpers/shells.js'

const ROOT = resolve(__dirname, '../../..')
const LIB = join(ROOT, 'plugin/scripts/claude-config-dir.ps1')
const PWSH = resolvePwsh() ?? (process.env.TOKENSCOPE_PWSH || 'pwsh')
const SKIP = process.env.TOKENSCOPE_SKIP_PWSH === '1' || process.platform === 'win32'

let home: string
let cwd: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ts-cfg-ps-')))
  cwd = join(home, 'work')
  mkdirSync(cwd)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function ps(body: string, env: Record<string, string> = {}) {
  const script = [`. '${LIB}'`, `Set-Location -LiteralPath '${cwd}'`, body].join('\n')
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: childEnv({ HOME: home, PATH: process.env.PATH ?? '', ...env }),
  })
  if (r.status !== 0 || r.stderr) throw new Error(`pwsh failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}
const resolveCfg = (env: Record<string, string> = {}) =>
  ps("$r = Resolve-TsClaudeConfigDir (Get-TsProfileRoot); [Console]::Out.Write((ConvertTo-Json -Compress @{ dir = $r.Dir; source = $r.Source; refused = $r.Refused }))", env)

describe.skipIf(SKIP)('Resolve-TsClaudeConfigDir (claude-config-dir.mjs twin)', () => {
  it('unset: the default <profile>/.claude', () => {
    expect(resolveCfg()).toEqual({ dir: join(home, '.claude'), source: 'default', refused: null })
  })

  it("honours Claude Desktop's own folder inside the profile", () => {
    expect(resolveCfg({ CLAUDE_CONFIG_DIR: join(home, '.claude-desktop') })).toEqual({
      dir: join(home, '.claude-desktop'),
      source: 'env',
      refused: null,
    })
  })

  it.each([
    ['relative', 'claude-desktop', 'not-absolute'],
    ['outside the profile', '/etc', 'outside-home'],
    ['the profile itself', '<home>', 'is-home'],
  ])('refuses a value that is %s', (_name, value, reason) => {
    const r = resolveCfg({ CLAUDE_CONFIG_DIR: value === '<home>' ? home : value })
    expect(r).toMatchObject({ dir: join(home, '.claude'), source: 'default', refused: reason })
  })

  it('refuses a folder inside a git work tree', () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true })
    expect(resolveCfg({ CLAUDE_CONFIG_DIR: join(home, 'repo', 'cfg') }).refused).toBe('inside-repository')
  })

  it('refuses a value a project settings file sets (a repo choosing where the credential goes)', () => {
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: join(home, '.x') } }))
    expect(resolveCfg({ CLAUDE_CONFIG_DIR: join(home, '.x') }).refused).toBe('set-by-project')
  })

  it('a project settings file that cannot be read counts as setting it (fail closed)', () => {
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{ not json')
    expect(resolveCfg({ CLAUDE_CONFIG_DIR: join(home, '.x') }).refused).toBe('set-by-project')
  })
})

describe.skipIf(SKIP)('the state folder (plugin-runtime.mjs claudeStateDir twin)', () => {
  const stateDir = (cfgDir: string) =>
    ps(`[Console]::Out.Write((ConvertTo-Json -Compress @{ d = (Get-TsClaudeStateDir '${cfgDir}' (Get-TsProfileRoot)) }))`).d

  it('the default folder keeps <profile>/.tokenscope', () => {
    expect(stateDir(join(home, '.claude'))).toBe(join(home, '.tokenscope'))
  })

  it('another folder gets the same key Node gives it', () => {
    const cfg = join(home, '.claude-desktop')
    const key = createHash('sha256').update(cfg).digest('hex').slice(0, 12)
    expect(stateDir(cfg)).toBe(join(home, '.tokenscope', 'claude-config', key))
  })

  it("the settings helper's --state-dir wins when it is a confined path", () => {
    const named = join(home, '.tokenscope', 'claude-config', 'abc')
    const cmd = `"${join(home, 'p', 'otel-headers-helper.sh')}" --tool claude-code --state-dir "${named}"`
    const r = ps(
      `[Console]::Out.Write((ConvertTo-Json -Compress @{ d = (Get-TsHelperStateDir '${cmd.replace(/'/g, "''")}' '${join(home, '.claude')}' (Get-TsProfileRoot)) }))`,
    )
    expect(r.d).toBe(named)
    const outside = ps(
      `[Console]::Out.Write((ConvertTo-Json -Compress @{ d = (Get-TsHelperStateDir '"/x/h.sh" --state-dir /etc' '${join(home, '.claude')}' (Get-TsProfileRoot)) }))`,
    )
    expect(outside.d).toBe(join(home, '.tokenscope'))
  })

  it('a helper without --state-dir (enrolled before #449) reads the default store, as Node does', () => {
    const desktop = join(home, '.claude-desktop')
    const r = ps(
      `[Console]::Out.Write((ConvertTo-Json -Compress @{ d = (Get-TsHelperStateDir '"/x/otel-headers-helper.sh" --tool claude-code' '${desktop}' (Get-TsProfileRoot)) }))`,
    )
    expect(r.d).toBe(join(home, '.tokenscope'))
  })

  it('no helper yet: the config folder\'s own state folder', () => {
    const desktop = join(home, '.claude-desktop')
    const key = createHash('sha256').update(desktop).digest('hex').slice(0, 12)
    const r = ps(`[Console]::Out.Write((ConvertTo-Json -Compress @{ d = (Get-TsHelperStateDir '' '${desktop}' (Get-TsProfileRoot)) }))`)
    expect(r.d).toBe(join(home, '.tokenscope', 'claude-config', key))
  })
})
