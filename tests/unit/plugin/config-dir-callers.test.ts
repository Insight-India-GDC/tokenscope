/*
 * The scripts that read Claude Code's OWN files follow the config folder of the
 * install running them (claude-config-dir.mjs), not a hard-coded ~/.claude.
 * On 2026-10-10 a Claude Desktop with CLAUDE_CONFIG_DIR=~/.claude-desktop was
 * judged by the CLI's credential and the CLI's sign-in: status said green while
 * the desktop sent nothing.
 *
 * Fixtures live under the passwd home, where the gate confines the folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { realHome } from '../../../plugin/scripts/real-home.mjs'
import { trustedGlobalSettingsEnv, globalSettingsEnv } from '../../../plugin/scripts/plugin-runtime.mjs'
import { readClaudeCredentials } from '../../../plugin/scripts/claude-credentials.mjs'
import { globalSettingsPath } from '../../../plugin/scripts/tag-repo.mjs'

let base: string
let cfg: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(realHome(), '.ts-config-dir-callers-')))
  cfg = join(base, '.claude-desktop')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { TOKENSCOPE_BEARER_ENDPOINT: 'https://desktop.example/b' } }))
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'plugin:tokenscope:tokenscope|abc': {} } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', cfg)
  // homedir() follows HOME: pin it to the passwd home so both readers agree.
  vi.stubEnv('HOME', realHome())
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

describe('moved callers read the config folder’s files', () => {
  it('the settings env readers (status probe, statusline, landed-check, hooks)', () => {
    expect(trustedGlobalSettingsEnv().TOKENSCOPE_BEARER_ENDPOINT).toBe('https://desktop.example/b')
    expect(homedir()).toBe(realHome())
    expect(globalSettingsEnv().TOKENSCOPE_BEARER_ENDPOINT).toBe('https://desktop.example/b')
  })

  it('the sign-in check reads the config folder’s .credentials.json (off macOS)', () => {
    const store = readClaudeCredentials({ platform: 'linux' }) as { mcpOAuth?: Record<string, unknown> } | null
    expect(Object.keys(store?.mcpOAuth ?? {})).toEqual(['plugin:tokenscope:tokenscope|abc'])
  })

  it('the repo tag copies the env of the config folder’s settings.json', () => {
    expect(globalSettingsPath()).toBe(join(cfg, 'settings.json'))
  })
})
