// @vitest-environment node
/*
 * The plugin's `server_url` option as an API-base source (#415).
 *
 * Claude Code substitutes `pluginConfigs["tokenscope@<marketplace>"].options.server_url`
 * into `.mcp.json`'s `${user_config.server_url}`, reading it from managed and
 * USER settings only. The scripts must resolve the same value from the same
 * files, and must never take it from somewhere a cloned repository can write:
 * its `.claude/settings*.json` or the `CLAUDE_PLUGIN_OPTION_SERVER_URL` env var
 * Claude Code exports to hooks, which a repository's `env` also reaches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { realHome } from '../../../plugin/scripts/real-home.mjs'

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore — mjs import resolved by Vitest
const api = await import('../../../plugin/scripts/api-base.mjs')
// @ts-ignore — mjs import resolved by Vitest
const { acceptApiBaseArg } = await import('../../../plugin/scripts/argv-guard.mjs')
/* eslint-enable @typescript-eslint/ban-ts-comment */
const {
  resolveApiBase,
  configuredServerUrl,
  knownApiOrigins,
  DEFAULT_API_BASE,
  UNSET_SERVER_MESSAGE,
} = api

const PACKAGED = 'https://packaged.example.com'
const USER_URL = 'https://ts.customer.example.com'

let dir: string
let home: string
const saved = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-server-url-'))
  home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  delete process.env.TOKENSCOPE_API_BASE
})
afterEach(() => {
  process.env = { ...saved }
  rmSync(dir, { recursive: true, force: true })
})

function writeJson(path: string, doc: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(doc))
}
function userSettings(doc: unknown) {
  writeJson(join(home, '.claude', 'settings.json'), doc)
}
const option = (url: string) => ({ options: { server_url: url } })
/** configuredServerUrl against the fixture only: no managed file, no install path. */
const configured = (o: { managedPath?: string | null; scriptsDir?: string | null } = {}) =>
  configuredServerUrl({ home, managedPath: null, scriptsDir: null, ...o })

describe('configuredServerUrl — reads the user settings file Claude Code reads', () => {
  it('returns the server_url a user configured', () => {
    userSettings({ pluginConfigs: { 'tokenscope@tokenscope': option(USER_URL) } })
    expect(configured()).toBe(USER_URL)
  })

  it('uses the verified shape: a value without the `options` level is not read', () => {
    // Claude Code 2.1.291 ignores `{ "tokenscope@x": { "server_url": … } }` (live
    // check, #415). Reading it here would make the scripts and the MCP url disagree.
    userSettings({ pluginConfigs: { 'tokenscope@tokenscope': { server_url: USER_URL } } })
    expect(configured()).toBeNull()
  })

  it('ignores another plugin of the same option name', () => {
    userSettings({ pluginConfigs: { 'other@tokenscope': option(USER_URL) } })
    expect(configured()).toBeNull()
  })

  it('a repository env var cannot supply it', () => {
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = 'https://repo.attacker.example'
    // A cloned repository pointing CLAUDE_CONFIG_DIR into itself. Inside a git
    // work tree, so refused on every OS (on Windows tmpdir() is inside the
    // home, so "outside the home" alone would not refuse it there).
    mkdirSync(join(dir, '.git'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'attacker-config')
    writeJson(join(dir, 'attacker-config', 'settings.json'), {
      pluginConfigs: { 'tokenscope@tokenscope': option('https://repo.attacker.example') },
    })
    expect(configured()).toBeNull()
    expect(resolveApiBase(null, { configured: configured(), packagedDefault: PACKAGED })).toBe(
      PACKAGED,
    )
  })

  it('prefers this install’s own marketplace when two disagree, and refuses to guess otherwise', () => {
    userSettings({
      pluginConfigs: {
        'tokenscope@alpha': option('https://alpha.example.com'),
        'tokenscope@beta': option('https://beta.example.com'),
      },
    })
    const scriptsDir = [
      '',
      'h',
      '.claude',
      'plugins',
      'cache',
      'beta',
      'tokenscope',
      '0.1.44',
      'scripts',
    ].join(sep)
    expect(configured({ scriptsDir })).toBe('https://beta.example.com')
    expect(configured()).toBeNull()
  })

  it('accepts several marketplaces that agree', () => {
    userSettings({
      pluginConfigs: { 'tokenscope@alpha': option(USER_URL), 'tokenscope@beta': option(USER_URL) },
    })
    expect(configured()).toBe(USER_URL)
  })

  it('managed settings outrank the user, as they do in Claude Code', () => {
    userSettings({ pluginConfigs: { 'tokenscope@tokenscope': option(USER_URL) } })
    const managedPath = join(dir, 'managed-settings.json')
    writeJson(managedPath, {
      pluginConfigs: { 'tokenscope@tokenscope': option('https://org.example.com') },
    })
    expect(configured({ managedPath })).toBe('https://org.example.com')
  })

  it('a missing or malformed settings file is "nothing configured", not a throw', () => {
    expect(configured()).toBeNull()
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json')
    expect(configured()).toBeNull()
  })
})

describe('resolveApiBase — where the configured server_url sits in the order', () => {
  const base = { packagedDefault: PACKAGED }

  it('beats a discovered registration and the packaged default', () => {
    expect(
      resolveApiBase(null, {
        ...base,
        configured: USER_URL,
        discovered: 'https://ts-mcp.example.com',
      }),
    ).toBe(USER_URL)
  })

  it('loses to an explicit arg and to the loopback override', () => {
    expect(resolveApiBase('https://ts-arg.example.com', { ...base, configured: USER_URL })).toBe(
      'https://ts-arg.example.com',
    )
    process.env.TOKENSCOPE_API_BASE = 'http://localhost:3450'
    expect(resolveApiBase(null, { ...base, configured: USER_URL })).toBe('http://localhost:3450')
  })

  it('strips a trailing slash the user pasted', () => {
    expect(resolveApiBase(null, { ...base, configured: `${USER_URL}/` })).toBe(USER_URL)
  })

  it('an invalid configured value throws rather than falling through to the default', () => {
    // Falling through would enrol against a deployment the user did not choose.
    expect(() => resolveApiBase(null, { ...base, configured: 'http://plain.example.com' })).toThrow(
      /API base/,
    )
  })

  it('reads the user settings file when the caller passes nothing', () => {
    // The production default parameter, not a seam: an omitted `configured`
    // must still consult the settings file rather than skip the tier.
    const src = readFileSync(join(process.cwd(), 'plugin', 'scripts', 'api-base.mjs'), 'utf8')
    expect(src).toMatch(/configured = configuredServerUrl\(\)/)
  })
})

describe('no server at all — the public build', () => {
  it('throws a message that tells the user where to set it', () => {
    let err: (Error & { reason?: string }) | undefined
    try {
      resolveApiBase(null, { configured: null, discovered: null, packagedDefault: '' })
    } catch (e) {
      err = e as Error & { reason?: string }
    }
    expect(err?.reason).toBe('server-unset')
    expect(err?.message).toBe(UNSET_SERVER_MESSAGE)
    expect(UNSET_SERVER_MESSAGE).toMatch(/\/plugin/)
    expect(UNSET_SERVER_MESSAGE).toMatch(/Connect dialog/)
  })

  it('a configured value is enough without any packaged default', () => {
    expect(resolveApiBase(null, { configured: USER_URL, packagedDefault: '' })).toBe(USER_URL)
  })
})

describe('the two halves of the Claude plugin share one default', () => {
  it('DEFAULT_API_BASE equals plugin.json’s server_url default (the MCP url’s fallback)', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
    )
    expect(manifest.userConfig.server_url.default).toBe(DEFAULT_API_BASE)
  })

  it('the MCP url is the server_url template, not a host', () => {
    const mcp = JSON.parse(readFileSync(join(process.cwd(), 'plugin', '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.tokenscope.url).toBe('${user_config.server_url}/api/v1/mcp')
  })
})

describe('--api-base may select the configured server_url (argv-guard known origins)', () => {
  it('knownApiOrigins carries the configured value', () => {
    expect(knownApiOrigins({ configured: USER_URL, discovered: null })).toContain(USER_URL)
  })

  it('a redeem flag naming the configured server is accepted, and an unknown one is dropped', () => {
    const warnings: string[] = []
    const warn = (m: string) => warnings.push(m)
    const allowed = knownApiOrigins({ configured: `${USER_URL}/`, discovered: null })
    expect(acceptApiBaseArg(USER_URL, { allowed, warn })).toBe(USER_URL)
    expect(warnings).toEqual([])
    expect(acceptApiBaseArg('https://elsewhere.example.com', { allowed, warn })).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('claude-redeem builds its allowed list from knownApiOrigins with the configured value', () => {
    const src = readFileSync(join(process.cwd(), 'plugin', 'scripts', 'claude-redeem.mjs'), 'utf8')
    expect(src).toMatch(/const configured = configuredServerUrl\(\)/)
    expect(src).toMatch(/allowed: knownApiOrigins\(\{ configured, discovered \}\)/)
    expect(src).toMatch(/\{ discovered, configured \}/)
  })
})

describe('api-base.mjs never reads a repo-settable source for the server', () => {
  // CLAUDE_CONFIG_DIR is reached only through claude-config-dir.mjs's gate
  // (behaviour pinned below and in claude-config-dir.test.ts); nothing here
  // reads it, the plugin options env or the cwd directly.
  it('has no CLAUDE_PLUGIN_OPTION_*, CLAUDE_CONFIG_DIR or cwd read of its own', () => {
    const code = readFileSync(join(process.cwd(), 'plugin', 'scripts', 'api-base.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/CLAUDE_PLUGIN_OPTION/)
    expect(code).not.toMatch(/CLAUDE_CONFIG_DIR/)
    expect(code).not.toMatch(/process\.cwd\(\)/)
    expect(code).toMatch(/serverUrlFromSettings\(claudeSettingsPath\(\{ home \}\), marketplace\)/)
  })
})

describe('configuredServerUrl — the config folder of the install asking', () => {
  // The value names the host a handoff code is posted to, so a custom
  // CLAUDE_CONFIG_DIR is read only through claude-config-dir.mjs's gate.
  it('reads CLAUDE_CONFIG_DIR’s settings.json when the folder is the user’s', () => {
    const base = mkdtempSync(join(realHome(), '.ts-server-url-cfg-'))
    try {
      const cfg = join(base, '.claude-desktop')
      writeJson(join(cfg, 'settings.json'), { pluginConfigs: { 'tokenscope@tokenscope': option(USER_URL) } })
      writeJson(join(base, '.claude', 'settings.json'), { pluginConfigs: { 'tokenscope@tokenscope': option('https://cli.example.com') } })
      process.env.CLAUDE_CONFIG_DIR = cfg
      expect(configuredServerUrl({ home: base, managedPath: null, scriptsDir: null })).toBe(USER_URL)
      // Inside a git work tree (a repository pointing it at itself): not trusted
      // on any OS, so ~/.claude is read instead. (Not "outside the home": on
      // Windows tmpdir() is inside the user profile.)
      mkdirSync(join(dir, '.git'), { recursive: true })
      process.env.CLAUDE_CONFIG_DIR = join(dir, 'elsewhere')
      writeJson(join(dir, 'elsewhere', 'settings.json'), { pluginConfigs: { 'tokenscope@tokenscope': option('https://evil.example.com') } })
      expect(configuredServerUrl({ home: base, managedPath: null, scriptsDir: null })).toBe('https://cli.example.com')
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
      rmSync(base, { recursive: true, force: true })
    }
  })
})
