/*
 * #449: the Claude lane's state dir is keyed by Claude config folder. Claude
 * Desktop runs the same `claude-code` tool from its own CLAUDE_CONFIG_DIR, so a
 * store keyed by tool alone was shared by both installs and the last setup
 * supplied both credentials. The default ~/.claude keeps ~/.tokenscope.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { claudeStateDir, helperStateDir, claudeInstallStateDir, trustedStateDir, realHome } = await import(
  '../../../plugin/scripts/plugin-runtime.mjs'
)

const { buildHelperCommand } = await import('../../../plugin/scripts/env-builder.mjs')

// Built the way setup builds it, for this platform: a hand-written sh command
// wrapping a Windows path in double quotes reads its backslashes as escapes.
const helperCmd = (stateDir?: string) =>
  buildHelperCommand(
    { tool: 'claude-code', platform: process.platform, ...(stateDir ? { stateDir } : {}) },
    { scriptsDir: join(realHome(), 'plugin', 'scripts') },
  )

let fixture: string
beforeAll(() => {
  // Under the passwd home: a --state-dir outside it is refused, like redeem's.
  fixture = mkdtempSync(join(realHome(), '.ts-claude-state-dir-'))
})
afterAll(() => {
  if (fixture?.startsWith(join(realHome(), '.ts-claude-state-dir-'))) rmSync(fixture, { recursive: true, force: true })
})

describe('claudeStateDir', () => {
  it('the default <passwd home>/.claude keeps the trusted state dir itself', () => {
    expect(claudeStateDir(join(realHome(), '.claude'))).toBe(trustedStateDir())
  })

  it('a Desktop-style config folder gets its own dir under it, distinct per folder', () => {
    const desktop = claudeStateDir(join(realHome(), '.claude-desktop'))
    expect(desktop).not.toBe(trustedStateDir())
    expect(desktop).toMatch(new RegExp(`^${trustedStateDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]claude-config[\\\\/][0-9a-f]{12}$`))
    expect(claudeStateDir(join(realHome(), '.claude-other'))).not.toBe(desktop)
    expect(claudeStateDir(join(realHome(), '.claude-desktop'))).toBe(desktop)
  })
})

describe('helperStateDir', () => {
  const desktop = () => join(fixture, '.claude-desktop')

  it("the helper's own --state-dir wins", () => {
    const named = join(fixture, 'named-state')
    expect(helperStateDir(helperCmd(named), desktop())).toBe(named)
  })

  it('a helper with no --state-dir reads the default dir (an install enrolled before #449)', () => {
    expect(helperStateDir(helperCmd(), desktop())).toBe(trustedStateDir())
  })

  it("no helper yet: the config folder's own dir", () => {
    expect(helperStateDir(undefined, desktop())).toBe(claudeStateDir(desktop()))
  })

  it('a --state-dir outside the passwd home is not followed', () => {
    // The filesystem root, not tmpdir(): on Windows the temp dir is inside the home.
    const outside = join(parse(realHome()).root, 'ts-state-outside-449')
    expect(helperStateDir(helperCmd(outside), desktop())).toBe(claudeStateDir(desktop()))
  })
})

describe('claudeInstallStateDir', () => {
  it("reads the helper from the config folder's own settings.json", () => {
    const cfg = join(fixture, 'cfg-a')
    const named = join(fixture, 'state-a')
    mkdirSync(cfg)
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ otelHeadersHelper: helperCmd(named) }))
    expect(claudeInstallStateDir(cfg)).toBe(named)
  })

  it('no settings.json: the config folder’s own dir', () => {
    const cfg = join(fixture, 'cfg-b')
    expect(claudeInstallStateDir(cfg)).toBe(claudeStateDir(cfg))
  })
})
