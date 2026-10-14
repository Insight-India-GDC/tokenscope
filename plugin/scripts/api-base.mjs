/*
 * Resolve the TokenScope API base URL (the Claude Code plugin's scripts).
 *
 * Resolution order, most-explicit first:
 *   1. explicit arg             — the caller named it outright, so nothing
 *      ambient should be able to override that. The env var used to win here,
 *      which meant a stale exported TOKENSCOPE_API_BASE silently beat a base the
 *      caller had just passed in.
 *   2. TOKENSCOPE_API_BASE env, BUT ONLY WHEN IT NAMES LOOPBACK — the documented
 *      local-dev override (http://localhost:3450). An off-box value is ignored
 *      outright: a cloned repository can supply this variable and there is no way
 *      to tell a repo-injected value from a shell-exported one.
 *   3. configured               — the plugin's `server_url` option (#415), the
 *      value Claude Code substitutes into `.mcp.json`'s
 *      `${user_config.server_url}`. Read from the managed and USER settings
 *      files only (see configuredServerUrl), never from the
 *      `CLAUDE_PLUGIN_OPTION_SERVER_URL` env var Claude Code also exports,
 *      because a repository's `env` reaches hook processes too.
 *   4. discovered               — an MCP registration the human made with
 *      `claude mcp add` (see mcp-origin.mjs).
 *   5. DEFAULT_API_BASE         — the packaged default: the same value as
 *      `server_url`'s `default` in .claude-plugin/plugin.json, so an install
 *      with no configured value talks to one server from both halves.
 *
 * DEFAULT_API_BASE is the GBS Dev environment's custom domain in the internal
 * build. The public build ships it EMPTY (tools/publish/substitutions.txt), so a
 * device with nothing configured gets a "set your TokenScope URL" error instead
 * of a placeholder host. The OTLP, bearer and emit endpoints are not baked: the
 * resolved server returns them at provision time (server/auth/emit-provision.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
import { realHome } from './real-home.mjs'
import { claudeSettingsPath } from './claude-config-dir.mjs'

export const DEFAULT_API_BASE = ''

/** What a user is told when no source names a server (the public build's default is empty). */
export const UNSET_SERVER_MESSAGE =
  'No TokenScope server is configured. Set your TokenScope URL: in Claude Code run /plugin, ' +
  'choose tokenscope, then Configure, and paste the server URL from the Connect dialog of your ' +
  'TokenScope deployment.'

/** The plugin's name, the part before `@` in a `pluginConfigs` key. */
const PLUGIN_NAME = 'tokenscope'

/**
 * Claude Code's managed-settings file for this platform. Fixed paths, not
 * env-derived (`%ProgramFiles%` is env a repository can set). MDM/registry
 * policies and `managed-settings.d/` drop-ins are not read here.
 */
function managedSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

/**
 * The marketplace this copy of the plugin was installed from, read from its own
 * install path (`…/plugins/cache/<marketplace>/tokenscope/<version>/scripts`).
 * Null for a `--plugin-dir` or in-place load, which has no such path.
 */
function ownMarketplace(scriptsDir) {
  const parts = scriptsDir.split(sep)
  const i = parts.lastIndexOf('cache')
  if (i < 1 || parts[i - 1] !== 'plugins' || parts[i + 2] !== PLUGIN_NAME) return null
  return parts[i + 1] || null
}

/**
 * `server_url` from one settings file's `pluginConfigs`, or null.
 *
 * Shape, verified against Claude Code 2.1.291 (the settings-reference page
 * omits the `options` level):
 *   { "pluginConfigs": { "tokenscope@<marketplace>": { "options": { "server_url": "…" } } } }
 *
 * The plugin may be installed from more than one marketplace. This copy's own
 * marketplace key wins; otherwise every `tokenscope@*` value must agree, and
 * disagreement yields null rather than a guess.
 */
function serverUrlFromSettings(path, marketplace) {
  let doc
  try {
    if (!existsSync(path)) return null
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const configs = doc?.pluginConfigs
  if (!configs || typeof configs !== 'object') return null
  const valueOf = (key) => {
    const v = configs[key]?.options?.server_url
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  if (marketplace) {
    const own = valueOf(`${PLUGIN_NAME}@${marketplace}`)
    if (own) return own
  }
  const values = new Set(
    Object.keys(configs)
      .filter((k) => k.startsWith(`${PLUGIN_NAME}@`))
      .map(valueOf)
      .filter(Boolean),
  )
  return values.size === 1 ? [...values][0] : null
}

/**
 * The user's configured `server_url`, or null.
 *
 * Read from the files Claude Code itself reads `pluginConfigs` from: managed
 * settings first (it outranks the user), then `<passwd home>/.claude/settings.json`.
 * Project and local settings are NOT read: Claude Code ignores `pluginConfigs`
 * there from 2.1.207 so a cloned repository cannot supply it, and this value
 * names the host a handoff code and the enrollment secret are POSTed to.
 *
 * `realHome()`, not `$HOME`: a repository can set HOME for hook processes. A
 * custom CLAUDE_CONFIG_DIR is followed only through claude-config-dir.mjs's
 * gate (absolute, inside the passwd home, outside any git work tree, not named
 * by a project settings file), so a repository cannot choose the file read here.
 *
 * @param {{ home?: string, managedPath?: string|null, scriptsDir?: string }} [opts]
 *   test seams; production passes nothing.
 */
export function configuredServerUrl({
  home = realHome(),
  managedPath = managedSettingsPath(),
  scriptsDir = defaultScriptsDir(),
} = {}) {
  const marketplace = scriptsDir ? ownMarketplace(scriptsDir) : null
  return (
    (managedPath ? serverUrlFromSettings(managedPath, marketplace) : null) ||
    serverUrlFromSettings(claudeSettingsPath({ home }), marketplace)
  )
}

/**
 * The origins an `--api-base` flag may SELECT (argv-guard.mjs's `allowed`):
 * the packaged default, the configured `server_url` and the discovered
 * registration. Empty entries are dropped by argv-guard.
 */
export function knownApiOrigins({ discovered = null, configured = null } = {}) {
  return [DEFAULT_API_BASE, configured, discovered]
}

function defaultScriptsDir() {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

/**
 * Is this base one only somebody already ON the machine could be served by?
 *
 * The whole reason TOKENSCOPE_API_BASE is dangerous is that it can name an
 * OFF-BOX destination: a cloned repository supplies it (Claude Code merges a
 * repo's `.claude` env over the global one), and there is no way to tell a
 * repo-injected value from a shell-exported one — they are the same
 * `process.env`. A loopback value cannot express that threat. To be served by
 * `127.0.0.1` an attacker must already be running a process on the developer's
 * machine, and a cloned repo does not run until the developer runs it, at which
 * point the machine is compromised by a much shorter path than an env var.
 *
 * Same reasoning `isPublicOriginTrusted` uses server-side for a loopback Host,
 * so the two halves of the system agree on where the trust boundary is.
 */
function isLoopbackBase(value) {
  try {
    const u = new URL(value)
    // Scheme FIRST. A loopback hostname alone is not enough: `assertSafeEndpoint`
    // takes an early exit for loopback (that is the documented dev exception),
    // so it does not re-check the scheme, and `ftp://127.0.0.1` or
    // `gopher://[::1]` would sail through to become an "API base" that fails
    // later and confusingly. This gate is the one that has to say http(s).
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

/**
 * Resolve the API base (explicit arg > loopback env override > configured
 * `server_url` > discovered registration > packaged default), trailing slash
 * stripped, VALIDATED before it is returned (S1 fix 2/3). Throws
 * UNSET_SERVER_MESSAGE when nothing names a server (the public build).
 *
 * `configured` and `packagedDefault` are seams: production passes neither and
 * gets the settings-file read and DEFAULT_API_BASE.
 *
 * WHY THE ARG OUTRANKS EVERYTHING. This used to read env-first, on the general
 * principle that an operator's environment overrides a script default. That is
 * right when the arg IS a default, and wrong here, because the argument the
 * redeem flow passes is not a default: it is the origin of the server that
 * MINTED the one-time handoff code, returned by that server in the same
 * response. A handoff can only be redeemed at its issuer, so a stale
 * TOKENSCOPE_API_BASE outranking it does not "override a default", it sends a
 * live single-use secret to a host that cannot honour it — silently, since the
 * wrong host simply 404s.
 *
 * WHY THE ENV SOURCE IS NOW LOOPBACK-ONLY, and why there is no longer a
 * `trustEnv` flag. That flag defaulted to TRUE with `trustEnv: false` as the
 * opt-out, which made "is this safe?" mean "did we enumerate every caller?" —
 * a question answered from memory, and answered wrong. The redeem helpers were
 * hardened and both ENROL doors kept the old precedence for weeks, carrying the
 * org-wide enrollment secret outbound and the durable emit destination back.
 * By the time every caller passed `false`, the flag's only remaining value was
 * `false`, so the branch was already unreachable and deleting it is provably
 * behaviour-preserving rather than merely tidier. A parameter whose safe setting
 * has to be remembered is the defect; a required parameter would only have made
 * the remembering louder.
 *
 * What deletion alone would NOT have fixed is local Claude development, which
 * that state left broken: no env read, and no discoverable bundle either — see
 * `mcp-origin.mjs` on why the Claude bundle tier is structurally invisible to
 * discovery — so a local developer fell silently through to the baked dev host.
 * Gating on loopback restores exactly that case and expresses none of the
 * threat, because the threat is naming an off-box destination.
 *
 * Callers therefore inherit the safe behaviour with nothing to pass and nothing
 * to forget, which is the only form of this fix that a caller written next year
 * cannot undo by omission.
 *
 * Validating the RESOLVED base here, once, means every caller inherits the
 * endpoint guard rather than each needing its own.
 */
export function resolveApiBase(
  argBase,
  { discovered, configured = configuredServerUrl(), packagedDefault = DEFAULT_API_BASE } = {},
) {
  // Trim EVERY source: a whitespace-only TOKENSCOPE_API_BASE (e.g. a
  // fat-fingered `export`) is truthy and would otherwise become a garbage base.
  //
  // `configured` outranks `discovered`: it is the value Claude Code puts in the
  // plugin's own MCP url, so it is where this plugin's handoff codes are minted.
  // An invalid configured value is NOT skipped: it reaches the guard below and
  // throws, rather than quietly sending the enrolment to the packaged default.
  const envBase = (process.env.TOKENSCOPE_API_BASE || '').trim()
  const raw =
    (argBase ?? '').trim() ||
    (isLoopbackBase(envBase) ? envBase : '') ||
    (configured ?? '').trim() ||
    (discovered ?? '').trim() ||
    (packagedDefault ?? '').trim()
  if (!raw) {
    const err = new Error(UNSET_SERVER_MESSAGE)
    err.reason = 'server-unset'
    throw err
  }
  const stripped = raw.replace(/\/+$/, '')
  try {
    assertSafeEndpoint(stripped, { allowLoopback: true })
  } catch (err) {
    // Redact at the resolution boundary. This throw propagates to callers that
    // print err.message from a generic top-level handler, so the raw guard
    // error would put the rejected base on stdout/stderr in clear text. The
    // base can come from an env var or a discovered MCP registration, i.e. not
    // always something the user typed and already knows.
    throw unsafeEndpointError('API base', err)
  }
  return stripped
}
