// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/device-id.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * device-id.mjs — the credential-free device-identity accessor.
 *
 * WHY THIS EXISTS (S16b). Setup needs ONE non-secret fact for idempotency: the
 * `tokenscope.instance_id` this host was last provisioned with, so re-running
 * `provision_emit` ROTATES that device instead of minting a duplicate. Until
 * this script existed, every setup prompt got that fact by telling the AI agent
 * to open the device store — and both stores hold the DURABLE emit credential
 * as a sibling of the id:
 *
 *   ~/.claude/settings.json    env.OTEL_RESOURCE_ATTRIBUTES (the id) sits beside
 *                              env.TOKENSCOPE_OAUTH_REFRESH_TOKEN
 *                              (claude-redeem.mjs's writeClaudeSettings puts
 *                              both into one `env`).
 *   ~/.tokenscope/config.copilot-cli.json  instance_id sits beside oauth_refresh_token
 *                              (copilot-redeem.mjs's writeTokenscopeConfig
 *                              writes both flat).
 *
 * So the NORMAL setup flow — no attacker, every device — pulled a long-lived
 * credential into the model's context and the session transcript. This script
 * is the fix: it reads the store in a SUBPROCESS and prints ONLY the
 * non-secret identity fields listed under `Out:` below, so the prompts can name
 * a command instead of a credential-bearing file.
 *
 * The output object is built from a fixed key set (never a spread of the parsed
 * store), so no future key added to either store can leak through this path.
 *
 * Node built-ins plus project imports that are vendored and drift-gated by the
 * same mechanism this file is (real-home.mjs, device-store.mjs,
 * claude-config-dir.mjs and its argv-guard.mjs) — so it vendors into
 * copilot-plugin/scripts/ by scripts/sync-copilot-plugin.mjs and is gated by
 * scripts/check-copilot-plugin-sync.mjs, the same treatment tokenscope-project.mjs
 * and endpoint-guard.mjs get. One implementation, two clients, no drift: a
 * drifted copy would be a second, un-gated reader of a credential file.
 *
 * THE TWO STORES RESOLVE THEIR HOME DIFFERENTLY, deliberately:
 *   - ~/.claude/settings.json → homedir() (or the install's own gated
 *     CLAUDE_CONFIG_DIR folder, claude-config-dir.mjs). This file is read only to learn what
 *     CLAUDE CODE itself will read, and Claude Code resolves its own settings
 *     through $HOME. Following the passwd home instead would report a device as
 *     un-enrolled on a host where it is emitting perfectly well.
 *   - ~/.tokenscope/config.<tool>.json → realHome(). This one is OURS, and
 *     copilot-redeem.mjs writes it under the passwd home precisely so a moved
 *     $HOME cannot choose where a durable refresh token lands. A reader that
 *     followed $HOME would read a store the writer never wrote — and, worse,
 *     would happily read one a moved $HOME planted, handing setup an
 *     attacker-chosen instance_id to rotate. Read where the writer writes.
 *
 * CLI:  node device-id.mjs [--tool claude-code|copilot-cli]
 * Out:  {"enrolled":bool,"tool":string|null,"instance_id":string|null,
 *        "bearer_host":string|null,"reason":string|null,
 *        "platform":string,"node":string}
 *
 * `platform` (process.platform) and `node` (process.version) are setup's step 0
 * (#408 S6): they tell the setup prompt which lane this device takes. A device
 * where this script cannot run at all has no Node, and on Windows takes the
 * PowerShell lane instead (device-id.ps1, which prints the same keys with
 * `node: null`).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isMainModule } from './is-main.mjs'
import { realHome } from './real-home.mjs'
import { resolveStorePath } from './device-store.mjs'
import { resolveClaudeConfigDir } from './claude-config-dir.mjs'

/** The emit tools an instance can be bound to. An instance is bound to exactly one. */
const EMIT_TOOLS = ['claude-code', 'copilot-cli']

/**
 * Shape every branch returns, so the printed object can only ever carry these
 * seven keys. Never spread a parsed store into it.
 */
function result({ enrolled = false, tool = null, instanceId = null, bearerHost = null, reason = null }) {
  return {
    enrolled,
    tool,
    instance_id: instanceId,
    bearer_host: bearerHost,
    reason,
    platform: process.platform,
    node: process.version,
  }
}

/**
 * URL host of an endpoint, lowercased, or null. Same extraction as
 * copilot-redeem's `bearerHost`, which returns `''` rather than null for an
 * absent/unparseable endpoint — this file's fixed output shape uses null.
 */
export function hostOf(endpoint) {
  try {
    return new URL(String(endpoint ?? '').trim()).host.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Extract one `key=value` from an OTEL_RESOURCE_ATTRIBUTES string, or null.
 *
 * NO DYNAMIC REGEX. This built one from `key` and escaped only `.`
 * (CodeQL js/incomplete-sanitization, alerts 15 + 16): every other
 * metacharacter reached the pattern intact, so a key like `to[o]l` would have
 * matched `tool=`, and one containing `(` would have thrown a SyntaxError out
 * of a helper whose contract is that it never throws. `key` is an internal
 * constant today, which is what kept it un-exploitable — not the escaping.
 *
 * Splitting on `,` and comparing keys LITERALLY makes the whole alert class
 * structurally impossible rather than escaped-correctly, and is an exact
 * behavioural match for the pattern it replaces:
 *   - `(?:^|,)` — a key is only recognised at the start of a comma-delimited
 *     field, so `xtool=y` still does not answer for `tool`;
 *   - `\s*` before the key — leading whitespace is skipped (trimStart), while
 *     whitespace BEFORE the `=` is not, exactly as `key=` required;
 *   - `([^,]*)` — the value runs to the next comma, so a value containing `=`
 *     is preserved whole;
 *   - first match wins; a present-but-empty value reads as absent.
 */
export function attrValue(attrs, key) {
  if (typeof attrs !== 'string') return null
  for (const field of attrs.split(',')) {
    const eq = field.indexOf('=')
    if (eq === -1) continue
    if (field.slice(0, eq).trimStart() !== key) continue
    const v = field.slice(eq + 1).trim()
    return v === '' ? null : v
  }
  return null
}

/**
 * Device identity from a PARSED ~/.claude/settings.json object. Pure + exported
 * for tests. Returns enrolled:false (never a partial id) when the store holds no
 * instance id, or when it is bound to a different emit tool than `wantTool`.
 *
 * The tool guard is load-bearing, not cosmetic: instances are per-HOST but bound
 * to ONE emit tool, so an id read out of one tool's store is not a valid thing
 * to provision the other with. The server refuses that outright — 409, BEFORE
 * any rotation (`locateOrCreateInstance`'s cross-TOOL guard, emit-provision.ts)
 * — which is what makes handing over the wrong id a hard failure rather than a
 * silent one. It was silent before that guard existed: the rotation committed
 * first and killed the other CLI's working emitting on the same host. Either
 * way the caller must never be handed an id it would pass to the wrong tool.
 */
export function readClaudeDevice(settings, wantTool = 'claude-code') {
  const env = settings && typeof settings.env === 'object' && settings.env ? settings.env : null
  if (!env) return result({ reason: 'no-enrolment' })
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES
  const instanceId = attrValue(attrs, 'tokenscope.instance_id')
  if (!instanceId) return result({ reason: 'no-enrolment' })
  // Absent `tool=` means a pre-tool-attr enrolment. Every writer that puts an
  // OTEL_RESOURCE_ATTRIBUTES into ~/.claude/settings.json — claude-redeem.mjs
  // and enroll.mjs — goes through assertClaudeRedeemResponse, which REFUSES a
  // copilot bundle outright, so claude-code is the sound default. (Other
  // writers of that file — statusline-toggle.mjs, session-start.mjs's two
  // self-heals — never author the attrs; they preserve whatever is there.)
  const tool = attrValue(attrs, 'tool') ?? 'claude-code'
  const bearerHost = hostOf(env.TOKENSCOPE_BEARER_ENDPOINT)
  if (tool !== wantTool) return result({ tool, bearerHost, reason: 'tool-mismatch' })
  return result({ enrolled: true, tool, instanceId, bearerHost })
}

/**
 * Device identity from a PARSED Copilot store (`config.copilot-cli.json`, or
 * the legacy `config.json`). Pure + exported for tests. Same contract as
 * readClaudeDevice.
 */
export function readCopilotDevice(config, wantTool = 'copilot-cli') {
  if (!config || typeof config !== 'object') return result({ reason: 'no-enrolment' })
  const instanceId = typeof config.instance_id === 'string' ? config.instance_id.trim() : ''
  if (!instanceId) return result({ reason: 'no-enrolment' })
  // A v2 store names its lane. The legacy config.json may be EITHER lane's (it
  // was shared before the per-tool split), so its attrs marker decides, and
  // copilot-cli is the default only for a marker-less legacy file.
  const tool =
    (typeof config.tool === 'string' && config.tool) ||
    attrValue(config.otel_resource_attributes, 'tool') ||
    'copilot-cli'
  const bearerHost = hostOf(config.bearer_endpoint)
  if (tool !== wantTool) return result({ tool, bearerHost, reason: 'tool-mismatch' })
  return result({ enrolled: true, tool, instanceId, bearerHost })
}

/** Parse a JSON file, or null if absent/unreadable/malformed. Never throws. */
function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve this host's device identity for `tool`, reading that tool's own store.
 *
 * `home` is injectable for tests and, when given, is used for EITHER store. Left
 * out, each store gets the home its own writer used — `realHome()` for the
 * TokenScope-owned `~/.tokenscope`, `homedir()` for Claude Code's own
 * `~/.claude`. See the module header for why those differ.
 */
export function deviceIdentity(tool = 'claude-code', home = undefined) {
  if (!EMIT_TOOLS.includes(tool)) return result({ reason: 'unknown-tool' })
  if (tool === 'copilot-cli') {
    const cfg = readJson(resolveStorePath('copilot-cli', join(home ?? realHome(), '.tokenscope')))
    return cfg === null ? result({ reason: 'no-enrolment' }) : readCopilotDevice(cfg, tool)
  }
  // The config folder of the install asking (CLAUDE_CONFIG_DIR, gated), so a
  // Claude Desktop with its own folder reads its own enrolment.
  const configDir = resolveClaudeConfigDir({ home: home ?? homedir() })
  const settingsFile = join(configDir.dir, 'settings.json')
  const settings = readJson(settingsFile)
  const own = settings === null ? result({ reason: 'no-enrolment' }) : readClaudeDevice(settings, tool)
  // A second install on this host (its own config folder, not yet set up)
  // shares the host's claude-code enrolment in ~/.tokenscope, which the emit
  // helper reads first. Report THAT instance, so setup rotates it rather than
  // minting a second one and leaving the first install's labels on a
  // superseded id.
  // Only when the folder's file is absent or parsed cleanly: setup cannot write
  // a malformed file, so reusing the shared instance there would rotate the
  // credential the other install still holds and then fail to save the new one.
  const cleanlyAbsent = settings !== null || !existsSync(settingsFile)
  if (own.reason === 'no-enrolment' && configDir.source === 'env' && cleanlyAbsent) {
    const store = readJson(resolveStorePath('claude-code', join(home ?? realHome(), '.tokenscope')))
    if (store !== null && store.tool === 'claude-code') return readCopilotDevice(store, tool)
  }
  return own
}

/** Parse `--tool <name>` (also `--tool=<name>`); defaults to claude-code. */
export function parseArgs(argv) {
  const i = argv.indexOf('--tool')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--tool='))
  return eq ? eq.slice('--tool='.length) : 'claude-code'
}

// CLI entry guard so tests can import the pure helpers without running the read
// (mirrors status.mjs / backfill.mjs).
const isMain = isMainModule(import.meta.url)
if (isMain) {
  console.log(JSON.stringify(deviceIdentity(parseArgs(process.argv.slice(2))), null, 2))
}
