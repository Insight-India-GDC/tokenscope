#!/usr/bin/env node

/**
 * check-copilot-plugin-sync.mjs
 *
 * CI parity gate: diffs plugin/scripts/* against copilot-plugin/scripts/*,
 * ignoring the SYNC NOTE header line added by sync-copilot-plugin.mjs.
 *
 * Also verifies (PLG-9) that the packaged TokenScope API host is CONSISTENT
 * across the places it lives (see checkApiHosts). A partial host update
 * silently splits the plugin: MCP talks to one server while redeem/emit talk to
 * another.
 *
 * Exits 1 if any file pair differs (drift detected) or the API hosts diverge.
 * Run: npm run check:copilot-plugin-sync
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const FILES = [
  'copilot-forwarder.mjs',
  // copilot-session.mjs (#475): the last-session note both senders write and the
  // `activity` skill reads; a drifted copy would key the note differently.
  'copilot-session.mjs',
  // copilot-emit.mjs / copilot-usage.mjs — the shared emit primitives and the
  // usage-extension core; both carry the credential and endpoint guards.
  'copilot-emit.mjs',
  'copilot-usage.mjs',
  // is-main.mjs — the "launched directly?" guard every runnable script uses.
  'is-main.mjs',
  'otlp-logs.mjs',
  'copilot-redeem.mjs',
  // tokenscope-project.mjs — extracted client-neutral resolver/hasher (P0-2).
  // Gated here so the vendored copilot copy can never drift from the canonical
  // plugin/scripts/ source (drift = Copilot + Claude hash the same .tokenscope
  // differently = split attribution).
  'tokenscope-project.mjs',
  'otel-headers-helper.sh',
  // otel-headers-helper.ps1 (#408 S2) — the Windows twin; same credential
  // handling, same reason to gate it.
  'otel-headers-helper.ps1',
  // emit-helper-spawn.mjs (#408 S5/S7) — which interpreter runs the helper.
  // Gated so neither client can drift into resolving it through PATH.
  'emit-helper-spawn.mjs',
  // endpoint-guard.mjs (S1) — the ONE endpoint validator. Gated the same way:
  // a second, un-gated (and therefore driftable) guard defeats the whole
  // point of having promoted it into one dependency-free file.
  'endpoint-guard.mjs',
  // argv-guard.mjs (S16a) — the shared validator for the flags handed to the
  // redeem helpers. Gated because the Copilot lane has no permission-grant
  // mechanism behind it: a drifted copy there is not a weaker control, it is
  // none.
  'argv-guard.mjs',
  // mcp-origin.mjs — the shared "where is the MCP server registered" resolver.
  // Gated so the vendored copy cannot drift: divergence means one client
  // redeems its handoff against a different host than the other.
  'mcp-origin.mjs',
  // real-home.mjs — the shared passwd-home resolver. Gated most sharply of all:
  // a drifted copy that fell back to os.homedir() would silently restore the
  // $HOME trust boundary this module exists to remove, on one client only.
  'real-home.mjs',
  // managed-telemetry.mjs (Workstream D §10.1) — the shared GitHub Copilot CLI
  // managed-`telemetry` detector. Gated so Copilot's vendored copy can never
  // drift from the canonical plugin/scripts/ source — a drift here means the
  // two clients disagree about whether a credential-valid probe is actually
  // emission-healthy.
  'managed-telemetry.mjs',
  // device-id.mjs (S16b) — the credential-free device-identity accessor both
  // setup prompts now call INSTEAD of naming ~/.claude/settings.json or
  // ~/.tokenscope/config.json. Gated so the copy that reads a credential store
  // can never drift from the reviewed source.
  'device-id.mjs',
  // claude-config-dir.mjs — device-id.mjs's resolver for the Claude Code config
  // folder; gated with it so the two clients agree on which settings file is
  // the Claude Code enrolment.
  'claude-config-dir.mjs',
  // device-store.mjs — the ONE definition of where each lane's enrolment lives
  // (config.<tool>.json / oauth-access.<tool>.json). Gated because a drifted
  // copy means the two lanes disagree about a FILENAME, and each then reads the
  // other's enrolment as absent: the exact split the module exists to end.
  'device-store.mjs',
  // trusted-git.mjs — vendored alongside the others; gated so the copy that
  // decides which `git` runs cannot drift on one client only.
  'trusted-git.mjs',
]

// Match the FULL auto-generated signature (not a bare `// SYNC NOTE:` prefix), so a
// legitimate body comment that happens to start with the prefix can't mask real drift
// by being stripped from both sides. Keep in sync with sync-copilot-plugin.mjs.
const SYNC_NOTE_SIGNATURE =
  'SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution.'

/** Strip the single auto-generated SYNC NOTE line (matched by its full signature). */
function stripSyncNote(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(SYNC_NOTE_SIGNATURE))
    .join('\n')
}

/** The vendored-copy drift check. Returns true when every pair matches. */
function checkVendoredCopies() {
  let failed = false

  for (const name of FILES) {
    const canonical = resolve(root, 'plugin/scripts', name)
    const vendored = resolve(root, 'copilot-plugin/scripts', name)

    if (!existsSync(canonical)) {
      console.error(`ERROR: canonical source missing: plugin/scripts/${name}`)
      failed = true
      continue
    }
    if (!existsSync(vendored)) {
      console.error(`ERROR: vendored copy missing: copilot-plugin/scripts/${name}`)
      console.error(`  Run: npm run sync:copilot-plugin`)
      failed = true
      continue
    }

    const canonicalNorm = stripSyncNote(readFileSync(canonical, 'utf8'))
    const vendoredNorm = stripSyncNote(readFileSync(vendored, 'utf8'))

    if (canonicalNorm !== vendoredNorm) {
      console.error(
        `DRIFT: copilot-plugin/scripts/${name} is out of sync with plugin/scripts/${name}`,
      )
      console.error(`  Run: npm run sync:copilot-plugin`)
      failed = true
    }
  }

  if (!failed) {
    console.log('✓  copilot-plugin/scripts/ is in sync with plugin/scripts/')
  }
  return !failed
}

// ── API-host consistency (PLG-9, #415) ───────────────────────────────────────

/** Extract the origin (scheme://host[:port]) of a URL string, or null. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The Claude plugin's MCP url: the server_url option, never a literal host (#415). */
export const CLAUDE_MCP_URL_TEMPLATE = '${user_config.server_url}/api/v1/mcp'

/** A `NAME = '<literal>'` string constant, or null when absent. Empty is a value. */
function literalConst(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`))
  return m ? m[1] : null
}

/** Read the host sources checkApiHosts compares out of a repository tree. */
export function readHostSources(repoRoot) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8')
  const pluginDefault = JSON.parse(read('plugin/.claude-plugin/plugin.json'))?.userConfig
    ?.server_url?.default
  return {
    claudeApiBaseDefault: literalConst(read('plugin/scripts/api-base.mjs'), 'DEFAULT_API_BASE'),
    claudeOptionDefault: typeof pluginDefault === 'string' ? pluginDefault : null,
    claudeMcpUrl: JSON.parse(read('plugin/.mcp.json'))?.mcpServers?.tokenscope?.url ?? null,
    copilotMcpUrl: JSON.parse(read('copilot-plugin/.mcp.json'))?.mcpServers?.tokenscope?.url ?? null,
    copilotEnrollDefault: literalConst(read('copilot-plugin/scripts/enroll.mjs'), 'DEFAULT_API_BASE'),
    serverBundledOrigin: literalConst(read('shared/connect.ts'), 'COPILOT_PLUGIN_BUNDLED_ORIGIN'),
    serverClaudeDefault: literalConst(read('shared/connect.ts'), 'CLAUDE_PLUGIN_DEFAULT_ORIGIN'),
  }
}

/**
 * Are the packaged hosts consistent? Pure, so the rules are testable.
 *
 *  1. Claude's .mcp.json url is exactly CLAUDE_MCP_URL_TEMPLATE. A literal host
 *     there would ignore the user's configured server; any other `${…}` could
 *     let a repository's env choose it (AG-CP-01).
 *  2. Claude's two defaults are identical, both empty included: plugin.json's
 *     `server_url.default` (what the MCP url uses when nothing is configured)
 *     and api-base.mjs's DEFAULT_API_BASE (what redeem and enrol use).
 *  2b. shared/connect.ts's CLAUDE_PLUGIN_DEFAULT_ORIGIN (what the connect dialog
 *     tells a Claude user the plugin ships with) is that default, exactly:
 *     empty in the public build, where the dialog must say there is none.
 *  3. Copilot's .mcp.json, Copilot's enroll.mjs (not vendored, so the parity
 *     check cannot see it) and shared/connect.ts's COPILOT_PLUGIN_BUNDLED_ORIGIN
 *     (what the connect dialog compares with) name one origin.
 *  4. A non-empty Claude default (the internal build) is that same origin. An
 *     empty one is the public build (tools/publish/substitutions.txt): no host.
 *
 * @returns {{ ok: boolean, errors: string[], host: string|null }}
 */
export function checkApiHosts(src) {
  const errors = []
  if (src.claudeMcpUrl !== CLAUDE_MCP_URL_TEMPLATE) {
    errors.push(
      `plugin/.mcp.json mcpServers.tokenscope.url must be exactly ${CLAUDE_MCP_URL_TEMPLATE} (got ${JSON.stringify(src.claudeMcpUrl)})`,
    )
  }
  if (src.claudeOptionDefault === null) {
    errors.push('plugin/.claude-plugin/plugin.json has no string userConfig.server_url.default')
  }
  if (src.claudeApiBaseDefault === null) {
    errors.push('could not find DEFAULT_API_BASE in plugin/scripts/api-base.mjs')
  }
  if (
    src.claudeOptionDefault !== null &&
    src.claudeApiBaseDefault !== null &&
    src.claudeOptionDefault !== src.claudeApiBaseDefault
  ) {
    errors.push(
      `Claude defaults differ: plugin.json server_url.default ${JSON.stringify(src.claudeOptionDefault)} vs api-base.mjs DEFAULT_API_BASE ${JSON.stringify(src.claudeApiBaseDefault)}`,
    )
  }
  if (src.serverClaudeDefault === null) {
    errors.push('could not find CLAUDE_PLUGIN_DEFAULT_ORIGIN in shared/connect.ts')
  } else if (src.claudeOptionDefault !== null && src.serverClaudeDefault !== src.claudeOptionDefault) {
    errors.push(
      `the connect dialog's Claude default differs from the plugin's: shared/connect.ts CLAUDE_PLUGIN_DEFAULT_ORIGIN ${JSON.stringify(src.serverClaudeDefault)} vs plugin.json server_url.default ${JSON.stringify(src.claudeOptionDefault)}`,
    )
  }
  const shared = [
    { where: 'copilot-plugin/.mcp.json (mcpServers.tokenscope.url)', host: originOf(src.copilotMcpUrl) },
    { where: 'copilot-plugin/scripts/enroll.mjs (DEFAULT_API_BASE)', host: originOf(src.copilotEnrollDefault) },
    { where: 'shared/connect.ts (COPILOT_PLUGIN_BUNDLED_ORIGIN)', host: originOf(src.serverBundledOrigin) },
  ]
  if (src.claudeApiBaseDefault) {
    shared.push({
      where: 'plugin/scripts/api-base.mjs + plugin.json server_url.default',
      host: originOf(src.claudeApiBaseDefault),
    })
  }
  for (const { where, host } of shared) {
    if (!host) errors.push(`could not extract an API host from ${where}`)
  }
  if (shared.every((s) => s.host) && new Set(shared.map((s) => s.host)).size !== 1) {
    errors.push(
      'the packaged TokenScope API host differs between:\n' +
        shared.map(({ where, host }) => `    ${host}  <-  ${where}`).join('\n') +
        '\n  A partial update silently splits the plugin (MCP at one server, redeem at another). Update all of them together.',
    )
  }
  return { ok: errors.length === 0, errors, host: shared[0].host }
}

function main() {
  let failed = !checkVendoredCopies()
  const result = checkApiHosts(readHostSources(root))
  if (!result.ok) {
    for (const e of result.errors) console.error(`DRIFT: ${e}`)
    failed = true
  } else {
    console.log(
      `✓  API host consistent: Claude defaults + server_url template, Copilot .mcp.json + enroll, shared/connect.ts (${result.host})`,
    )
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
