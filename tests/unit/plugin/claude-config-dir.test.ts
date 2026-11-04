/*
 * claude-config-dir.mjs: which Claude Code config folder the scripts act on.
 * CLAUDE_CONFIG_DIR is honoured only when the user's own environment set it to
 * a folder of theirs; a repository must not be able to choose it, because the
 * folder decides where a durable credential is written.
 *
 * Fixtures live under the passwd home (realHome), because the gate confines the
 * folder there; each test gets its own directory and removes it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  claudeConfigDir,
  claudeSettingsPath,
  projectSetsEnvKey,
  resolveClaudeConfigDir,
} from '../../../plugin/scripts/claude-config-dir.mjs'
import { realHome } from '../../../plugin/scripts/real-home.mjs'

// Windows (#430): skipped on win32 because this file assumes tmpdir() is outside the home and HOME steers homedir(); on Windows tmpdir() is inside the profile and homedir() follows USERPROFILE.
const POSIX_ONLY = process.platform === 'win32'

const made: string[] = []
function sandbox() {
  const d = mkdtempSync(join(realHome(), '.ts-claude-config-dir-'))
  made.push(d)
  return realpathSync(d)
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** cwd with no project settings anywhere above it that names the variable. */
function quietCwd(base: string) {
  const cwd = join(base, 'work')
  mkdirSync(cwd, { recursive: true })
  return cwd
}

describe.skipIf(POSIX_ONLY)('resolveClaudeConfigDir', () => {
  it('unset → <home>/.claude, source default', () => {
    const home = sandbox()
    expect(resolveClaudeConfigDir({ env: {}, home, cwd: quietCwd(home) })).toEqual({
      dir: join(home, '.claude'),
      source: 'default',
      refused: null,
    })
  })

  it('a folder of the user’s inside their home → honoured (Claude Desktop’s own install)', () => {
    const base = sandbox()
    const cfg = join(base, '.claude-desktop')
    mkdirSync(cfg)
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: quietCwd(base) })
    expect(r).toEqual({ dir: cfg, source: 'env', refused: null })
    expect(claudeSettingsPath({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: quietCwd(base) })).toBe(join(cfg, 'settings.json'))
  })

  it('a folder that does not exist yet is still honoured (Claude Code creates it)', () => {
    const base = sandbox()
    const cfg = join(base, 'not-yet')
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: quietCwd(base) })).toBe(cfg)
  })

  it('refuses a relative path', () => {
    const base = sandbox()
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: 'rel/cfg' }, home: base, cwd: quietCwd(base) })
    expect(r.source).toBe('default')
    expect(r.dir).toBe(join(base, '.claude'))
    expect(r.refused?.reason).toBe('not-absolute')
  })

  it('refuses a folder outside the passwd home', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ts-ccd-out-'))
    made.push(outside)
    const base = sandbox()
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: outside }, home: base, cwd: quietCwd(base) })
    expect(r.refused?.reason).toBe('outside-home')
    expect(r.dir).toBe(join(base, '.claude'))
  })

  it('refuses a symlink that leads out of the home', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ts-ccd-out-'))
    made.push(outside)
    const base = sandbox()
    const link = join(base, 'link-out')
    symlinkSync(outside, link)
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: link }, home: base, cwd: quietCwd(base) }).refused?.reason).toBe(
      'outside-home',
    )
  })

  it('refuses a folder inside a git work tree (a repository publishes what is written into it)', () => {
    const base = sandbox()
    mkdirSync(join(base, 'repo', '.git'), { recursive: true })
    const cfg = join(base, 'repo', 'cfg')
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd: quietCwd(base) }).refused?.reason).toBe(
      'inside-repository',
    )
  })

  it('refuses an existing path that is not a directory, and still accepts one not created yet', () => {
    const base = sandbox()
    const file = join(base, 'a-file')
    writeFileSync(file, 'x')
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: file }, home: base, cwd: quietCwd(base) })
    expect(r.refused?.reason).toBe('not-a-directory')
    expect(r.dir).toBe(join(base, '.claude'))
  })

  it('refuses the home itself', () => {
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: realHome() }, cwd: quietCwd(sandbox()) })
    expect(r.refused?.reason).toBe('is-home')
  })

  it('refuses a value a project settings file supplies, even a well-formed one', () => {
    const base = sandbox()
    const cfg = join(base, '.claude-desktop')
    const project = join(base, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: cfg } }))
    const cwd = join(project, 'sub')
    mkdirSync(cwd)
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd })
    expect(r.refused?.reason).toBe('set-by-project')
    expect(r.dir).toBe(join(base, '.claude'))
  })

  it('fails closed on a project settings file it cannot inspect (padded past the size cap, or not JSON)', () => {
    const base = sandbox()
    const cfg = join(base, '.claude-desktop')
    const project = join(base, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    const file = join(project, '.claude', 'settings.local.json')
    writeFileSync(file, `{"env":{"CLAUDE_CONFIG_DIR":"${cfg}"}}${' '.repeat(1024 * 1024)}`)
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd: project }).refused?.reason).toBe(
      'set-by-project',
    )
    writeFileSync(file, '{ not json')
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd: project }).refused?.reason).toBe(
      'set-by-project',
    )
    // A readable project file that does not name it is fine.
    writeFileSync(file, JSON.stringify({ env: { OTHER: '1' } }))
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd: project }).source).toBe('env')
  })

  it('a FIFO at a project settings path neither blocks nor hides the key', () => {
    const base = sandbox()
    const cfg = join(base, '.claude-desktop')
    const project = join(base, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    execFileSync('mkfifo', [join(project, '.claude', 'settings.json')])
    expect(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, home: base, cwd: project }).refused?.reason).toBe(
      'set-by-project',
    )
  })

  it('a home reached through a symlink still recognises the user’s own settings file', () => {
    const real = sandbox()
    const link = `${real}-link`
    symlinkSync(real, link)
    made.push(link)
    const cfg = join(real, '.claude-desktop')
    // The user's own file is unreadable to the gate (not JSON), which would
    // refuse if it were mistaken for a project file.
    mkdirSync(join(real, '.claude'), { recursive: true })
    writeFileSync(join(real, '.claude', 'settings.json'), '{ not json')
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: real, trustedHome: link, home: link })
    expect(r.refused).toBeNull()
    expect(r.source).toBe('env')
  })

  it('…and when ~/.claude is itself a symlink (dotfile managers), under a symlinked home', () => {
    const real = sandbox()
    const link = `${real}-link`
    symlinkSync(real, link)
    made.push(link)
    const dots = join(real, 'dotfiles', 'claude')
    mkdirSync(dots, { recursive: true })
    writeFileSync(join(dots, 'settings.json'), '{ not json')
    symlinkSync(dots, join(real, '.claude'))
    const cfg = join(real, '.claude-desktop')
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: real, trustedHome: link, home: link })
    expect(r.refused).toBeNull()
  })

  it('the user’s own ~/.claude/settings.json naming it is not a project file', () => {
    const base = sandbox()
    const cfg = join(base, '.claude-desktop')
    mkdirSync(join(base, '.claude'), { recursive: true })
    writeFileSync(join(base, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: cfg } }))
    const r = resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: base, trustedHome: base, home: base })
    expect(r).toEqual({ dir: cfg, source: 'env', refused: null })
  })
})

describe.skipIf(POSIX_ONLY)('projectSetsEnvKey', () => {
  it('walks from cwd to the root, in settings.json and settings.local.json', () => {
    const base = sandbox()
    mkdirSync(join(base, 'a', '.claude'), { recursive: true })
    writeFileSync(join(base, 'a', '.claude', 'settings.json'), JSON.stringify({ env: { K: '1' } }))
    mkdirSync(join(base, 'a', 'b', 'c'), { recursive: true })
    expect(projectSetsEnvKey('K', join(base, 'a', 'b', 'c'))).toBe(true)
    expect(projectSetsEnvKey('OTHER', join(base, 'a', 'b', 'c'))).toBe(false)
    expect(projectSetsEnvKey('K', join(base, 'a', 'b', 'c'), { userFiles: [join(base, 'a', '.claude', 'settings.json')] })).toBe(
      false,
    )
  })
})
