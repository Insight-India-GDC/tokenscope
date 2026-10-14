/*
 * Claude Code's own credential store, read where Claude Code keeps it, for one
 * question: has the TokenScope MCP server been signed in?
 *
 * macOS: the login Keychain item "Claude Code-credentials" only. A failed
 * Keychain read is "not signed in", never a fall back to a file under HOME,
 * which a repository's settings can move. Elsewhere: .credentials.json in the
 * config folder (claude-config-dir.mjs; ~/.claude unless CLAUDE_CONFIG_DIR).
 *
 * homedir(), not realHome(): this mirrors a file Claude Code itself reads,
 * through the same HOME (see real-home.mjs). `security` is called by absolute
 * path, so a PATH a repository sets cannot substitute another binary. The parsed
 * store holds Claude's tokens: callers take a yes/no from it and never log or
 * return it, and the status line's cache holds only that yes/no.
 *
 * The Keychain read starts a process and can stall on an access prompt, so the
 * status line, which renders on every prompt, never calls it directly on macOS:
 * it reads a cached answer and refreshes it in a throttled, detached child
 * (`node claude-credentials.mjs --refresh-cache`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { trustedStateDir } from './plugin-runtime.mjs'
import { claudeConfigDir } from './claude-config-dir.mjs'

export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** The status line's cached answer, and its refresh throttle, in the trusted state dir. */
export const MCP_AUTH_CACHE = 'mcp-auth.json'
export const MCP_AUTH_STAMP = 'mcp-auth-poll.stamp'
export const MCP_AUTH_TTL_MS = 60 * 1000

function keychainCredentials() {
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      // An access prompt would block; give up rather than wait on it.
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

function fileCredentials() {
  try {
    // The config folder is the install's own (CLAUDE_CONFIG_DIR, gated: claude-config-dir.mjs).
    // homedir-ok: the file Claude Code itself reads, through the same HOME.
    return JSON.parse(readFileSync(join(claudeConfigDir({ home: homedir() }), '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The parsed credential store, or null: the Keychain on macOS, the file
 * elsewhere. The readers are injectable so tests can drive every branch on any OS.
 */
export function readClaudeCredentials({
  platform = process.platform,
  readKeychain = keychainCredentials,
  readFile = fileCredentials,
} = {}) {
  if (platform === 'darwin') {
    const fromKeychain = readKeychain()
    return fromKeychain && typeof fromKeychain === 'object' ? fromKeychain : null
  }
  return readFile()
}

/**
 * Whether the store has an `.mcpOAuth` entry for the TokenScope plugin MCP
 * server: key `plugin:tokenscope:tokenscope`, or that plus `|<suffix>`.
 * Fail-defensive: anything else is false.
 */
export function isMcpAuthed(creds) {
  const mcp = creds && typeof creds === 'object' ? creds.mcpOAuth : null
  if (!mcp || typeof mcp !== 'object') return false
  return Object.keys(mcp).some(
    (k) => k === 'plugin:tokenscope:tokenscope' || k.startsWith('plugin:tokenscope:tokenscope|'),
  )
}

/** Signed in to the TokenScope MCP server, per Claude Code's store. Never throws. */
export function probeMcpAuth(opts) {
  try {
    return isMcpAuthed(readClaudeCredentials(opts))
  } catch {
    return false
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The cached `{ authed, checkedAt }`, or null when absent or malformed. */
export function readMcpAuthCache(dir = trustedStateDir()) {
  const c = readJson(join(dir, MCP_AUTH_CACHE))
  return c && typeof c.authed === 'boolean' && typeof c.checkedAt === 'string' ? c : null
}

export function writeMcpAuthCache(authed, dir = trustedStateDir(), now = new Date()) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MCP_AUTH_CACHE), `${JSON.stringify({ authed: Boolean(authed), checkedAt: now.toISOString() })}\n`, {
    mode: 0o600,
  })
}

/**
 * Pure: a refresh is due when the cache is older than the TTL and no refresh
 * started within the TTL is still in flight.
 */
export function mcpAuthRefreshDue(cache, stampAt, now = Date.now()) {
  const fresh = (ts) => {
    const t = ts ? Date.parse(ts) : NaN
    // A future time (clock rollback, a corrupt file) is not fresh.
    return Number.isFinite(t) && now >= t && now - t < MCP_AUTH_TTL_MS
  }
  if (cache && fresh(cache.checkedAt)) return false
  return !fresh(stampAt)
}

/**
 * How the status line starts the background refresh: an EMPTY environment, so
 * nothing a repository's settings put in it (NODE_OPTIONS, NODE_PATH, HOME, ...)
 * reaches the process that reads the Keychain. It needs none: `security` is
 * called by absolute path and the state dir comes from realHome().
 */
export function mcpAuthRefreshSpawn(scriptPath) {
  return { file: process.execPath, args: [scriptPath, '--refresh-cache'], options: { detached: true, stdio: 'ignore', env: {} } }
}

/** The stamp's time, or null. */
export function readMcpAuthStamp(dir = trustedStateDir()) {
  return readJson(join(dir, MCP_AUTH_STAMP))?.at ?? null
}

if (isMainModule(import.meta.url) && process.argv.includes('--refresh-cache')) {
  try {
    writeMcpAuthCache(probeMcpAuth())
  } catch {
    /* best-effort: the next render retries after the throttle */
  }
}
