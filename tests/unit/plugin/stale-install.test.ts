/**
 * #456: a session open across a plugin update serves the OLD /tokenscope:setup
 * text, pointing at the old version's cache folder. The redeem refuses there,
 * before the handoff is spent, and only when Claude Code's own install record
 * shows a different TokenScope install is active.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staleInstall, staleInstallMessage } from '../../../plugin/scripts/stale-install.mjs'

let cfg: string

function version(v: string) {
  const root = join(cfg, 'plugins', 'cache', 'tokenscope', 'tokenscope', v)
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tokenscope', version: v }))
  return realpathSync(root)
}
function record(entries: Record<string, { installPath: string; version: string }[]>) {
  writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: entries }))
}

beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), 'ts-stale-'))
  mkdirSync(join(cfg, 'plugins', 'cache'), { recursive: true })
})
afterEach(() => rmSync(cfg, { recursive: true, force: true }))

describe('staleInstall', () => {
  it('is stale when the running copy is not the installed one', () => {
    const old = version('0.1.39')
    const now = version('0.1.52')
    record({ 'tokenscope@tokenscope': [{ installPath: now, version: '0.1.52' }] })
    const v = staleInstall({ pluginRoot: old, configDir: cfg })
    expect(v).toMatchObject({ running: old, runningVersion: '0.1.39', installed: [{ path: now, version: '0.1.52' }] })
    const msg = staleInstallMessage(v!)
    expect(msg).toContain('0.1.39')
    expect(msg).toContain('0.1.52 is installed now')
    expect(msg).toMatch(/restart Claude Code/)
  })

  it('is not stale when the running copy is the installed one', () => {
    const now = version('0.1.52')
    record({ 'tokenscope@tokenscope': [{ installPath: now, version: '0.1.52' }] })
    expect(staleInstall({ pluginRoot: now, configDir: cfg })).toBeNull()
  })

  it('does not judge a copy running outside the plugin cache (a directory marketplace checkout)', () => {
    const now = version('0.1.52')
    record({ 'tokenscope@tokenscope': [{ installPath: now, version: '0.1.52' }] })
    const checkout = mkdtempSync(join(tmpdir(), 'ts-checkout-'))
    try {
      expect(staleInstall({ pluginRoot: checkout, configDir: cfg })).toBeNull()
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })

  it('does not block when the install record is missing or unreadable', () => {
    const old = version('0.1.39')
    expect(staleInstall({ pluginRoot: old, configDir: cfg })).toBeNull()
    writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), '{ not json')
    expect(staleInstall({ pluginRoot: old, configDir: cfg })).toBeNull()
  })

  it('does not block when the recorded install no longer exists on disk', () => {
    const old = version('0.1.39')
    record({ 'tokenscope@tokenscope': [{ installPath: join(cfg, 'plugins', 'cache', 'gone'), version: '0.1.52' }] })
    expect(staleInstall({ pluginRoot: old, configDir: cfg })).toBeNull()
  })

  it('does not refuse a NEWER copy running while an older one is installed (a downgrade or pin)', () => {
    // The server's redeem_command picks the highest cached version.
    const newerCopy = version('0.1.53')
    const pinned = version('0.1.52')
    record({ 'tokenscope@tokenscope': [{ installPath: pinned, version: '0.1.52' }] })
    expect(staleInstall({ pluginRoot: newerCopy, configDir: cfg })).toBeNull()
  })

  it('does not refuse when a recorded version cannot be compared', () => {
    const old = version('0.1.39')
    const now = version('0.1.52')
    record({ 'tokenscope@tokenscope': [{ installPath: now, version: 'unknown' }] })
    expect(staleInstall({ pluginRoot: old, configDir: cfg })).toBeNull()
  })

  it('ignores other plugins in the record', () => {
    const old = version('0.1.39')
    const other = version('9.9.9')
    record({ 'someone-else@market': [{ installPath: other, version: '9.9.9' }] })
    expect(staleInstall({ pluginRoot: old, configDir: cfg })).toBeNull()
  })
})
