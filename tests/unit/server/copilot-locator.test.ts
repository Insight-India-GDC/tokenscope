/**
 * #458: the Copilot skills and the server's redeem_command find the plugin's
 * scripts under a marketplace install AND a direct (path) install, and never in
 * a direct folder that belongs to another plugin. The fragment runs in real sh
 * against a throwaway HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { copilotScriptLocator } from '../../../server/utils/copilot-locator'

const ROOT = resolve(__dirname, '../../..')
let home: string

function install(dir: string, name: string | null, script = 'status.mjs') {
  const d = join(home, '.copilot', 'installed-plugins', dir)
  mkdirSync(join(d, 'scripts'), { recursive: true })
  writeFileSync(join(d, 'scripts', script), '')
  if (name !== null) writeFileSync(join(d, 'plugin.json'), `{\n  "name": "${name}",\n  "version": "0.1.28"\n}\n`)
  return join(d, 'scripts', script)
}
const locate = (script = 'status.mjs') =>
  spawnSync('sh', ['-c', `${copilotScriptLocator(script)}; printf '%s' "$s"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home },
  }).stdout

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ts-copilot-loc-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe.skipIf(process.platform === 'win32')('copilotScriptLocator (POSIX sh)', () => {
  it('finds a marketplace install', () => {
    const p = install('tokenscope/tokenscope-copilot', 'tokenscope')
    expect(locate()).toBe(p)
  })

  it('finds a direct (path) install whose plugin.json names tokenscope', () => {
    const p = install('_direct/copilot-plugin', 'tokenscope')
    expect(locate()).toBe(p)
  })

  it('ignores a direct folder that belongs to another plugin, whatever it is called', () => {
    install('_direct/copilot-plugin', 'someone-else')
    install('_direct/tokenscope-ish', null)
    expect(locate()).toBe('')
  })

  it('does not take a name that only starts with tokenscope', () => {
    install('_direct/copilot-plugin', 'tokenscope-evil')
    expect(locate()).toBe('')
  })

  it('reads only the top-level name: an author or dependency named tokenscope does not count', () => {
    const d = join(home, '.copilot', 'installed-plugins', '_direct', 'other')
    mkdirSync(join(d, 'scripts'), { recursive: true })
    writeFileSync(join(d, 'scripts', 'status.mjs'), '')
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'other', author: { name: 'tokenscope' } }, null, 2))
    expect(locate()).toBe('')
  })

  it('a marketplace install wins over a leftover direct one, whatever the marketplace is called', () => {
    const market = install('Insight/tokenscope-copilot', 'tokenscope')
    install('_direct/copilot-plugin', 'tokenscope')
    expect(locate()).toBe(market)
  })

  // Copilot review on PR 496: a DIRECT folder named tokenscope-copilot matched the
  // marketplace glob and skipped the manifest check.
  it('a direct folder called tokenscope-copilot still needs its manifest to name tokenscope', () => {
    install('_direct/tokenscope-copilot', 'unrelated-plugin')
    expect(locate()).toBe('')
    const ours = install('_direct/tokenscope-copilot', 'tokenscope')
    expect(locate()).toBe(ours)
  })

  it('is empty when nothing is installed', () => {
    expect(locate()).toBe('')
  })

  it('needs the script itself, not only the plugin folder', () => {
    install('_direct/copilot-plugin', 'tokenscope', 'device-id.mjs')
    expect(locate('copilot-redeem.mjs')).toBe('')
  })
})

describe('every Copilot locator uses the same fragment', () => {
  it('refuses a script name that could break out of the shell string', () => {
    expect(() => copilotScriptLocator("x'; touch pwned; '.mjs")).toThrow()
  })

  it.each([
    ['copilot-plugin/skills/status/SKILL.md', 'status.mjs'],
    ['copilot-plugin/skills/tokenscope-setup/SKILL.md', 'device-id.mjs'],
    ['copilot-plugin/skills/tokenscope-setup/SKILL.md', 'copilot-redeem.mjs'],
    ['copilot-plugin/skills/activity/SKILL.md', 'copilot-session.mjs'],
  ])('%s quotes it for %s', (file, script) => {
    const text = readFileSync(join(ROOT, file), 'utf8')
    expect(text).toContain(copilotScriptLocator(script))
    // No lookup of the plugin's scripts survives outside a full fragment.
    let rest = text
    for (const f of ['status.mjs', 'device-id.mjs', 'copilot-redeem.mjs', 'copilot-session.mjs']) rest = rest.split(copilotScriptLocator(f)).join('')
    expect(rest).not.toContain('ls -d "$HOME"/.copilot/installed-plugins')
  })

  it('the server redeem_command uses it', () => {
    expect(readFileSync(join(ROOT, 'server/utils/mcp.ts'), 'utf8')).toContain("copilotScriptLocator('copilot-redeem.mjs')")
  })
})
