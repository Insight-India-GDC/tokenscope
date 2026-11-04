#!/usr/bin/env node

/**
 * sync-copilot-plugin.mjs
 *
 * Copies the shared scripts from plugin/scripts/ into copilot-plugin/scripts/,
 * prepending a one-line SYNC NOTE so maintainers know the file is auto-generated.
 *
 * This script IS the source-of-truth mechanism for the vendored copies —
 * run it before any commit that touches plugin/scripts/.
 *
 * Usage:
 *   npm run sync:copilot-plugin
 *
 * The copies are checked for drift in CI via:
 *   npm run check:copilot-plugin-sync
 */
import { readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const FILES = [
  { name: 'copilot-forwarder.mjs', type: 'js' },
  // copilot-session.mjs (#475): the last-session note both senders write and the
  // `activity` skill reads; a drifted copy would key the note differently.
  { name: 'copilot-session.mjs', type: 'js' },
  { name: 'otlp-logs.mjs', type: 'js' },
  { name: 'copilot-redeem.mjs', type: 'js' },
  // tokenscope-project.mjs — the client-neutral resolver/hasher the forwarder
  // reuses so Copilot + Claude hash an identical `.tokenscope` to the same
  // project.code_hash. MUST stay gated by check-copilot-plugin-sync.mjs: an
  // un-gated extracted module drifts silently → split attribution (P0-2).
  { name: 'tokenscope-project.mjs', type: 'js' },
  { name: 'otel-headers-helper.sh', type: 'sh' },
  // otel-headers-helper.ps1 (#408 S2) — the Windows twin of the .sh. Copilot on
  // win32 spawns it in place of /bin/sh, so the vendored copy is a credential
  // path too and must never drift. `#` comments, so it takes the sh-style note.
  { name: 'otel-headers-helper.ps1', type: 'sh' },
  // emit-helper-spawn.mjs (#408 S5/S7) — the ONE choice of interpreter + argv
  // for spawning the helper (/bin/sh, or an absolute powershell.exe on win32).
  // Copilot's mintBearer and status probe use it; a drifted copy could resolve
  // the interpreter through PATH on one client only.
  { name: 'emit-helper-spawn.mjs', type: 'js' },
  // endpoint-guard.mjs (S1) — the ONE endpoint validator (assertSafeEndpoint).
  // Dependency-free by design so it vendors verbatim; MUST stay
  // gated the same way tokenscope-project.mjs is — a second, un-gated guard
  // is exactly what this epic's opening principle forbids.
  { name: 'endpoint-guard.mjs', type: 'js' },
  // argv-guard.mjs (S16a) — the ONE validator for the flags handed to the
  // redeem helpers. Gated for the same reason endpoint-guard.mjs is, and for
  // one more: the Copilot lane has NO permission-grant mechanism to fall back
  // on, so a drifted copy there is not a weaker second control, it is no
  // control at all.
  { name: 'argv-guard.mjs', type: 'js' },
  // mcp-origin.mjs — the ONE resolver for "where is the MCP server actually
  // registered", used by BOTH redeem helpers so a handoff is always redeemed at
  // the server that minted it. Gated for the same reason endpoint-guard.mjs is:
  // a drifted second copy would send one client's single-use credential to a
  // host the other client never talked to.
  { name: 'mcp-origin.mjs', type: 'js' },
  // device-store.mjs — the ONE definition of where each lane's enrolment lives.
  // Gated for the same reason endpoint-guard.mjs is: if the two lanes ever
  // disagreed about a store filename they would each read the other's enrolment
  // as absent, which is precisely the split this module exists to end.
  { name: 'device-store.mjs', type: 'js' },
  // real-home.mjs — the ONE answer to "where is the account's home", used by
  // mcp-origin.mjs to decide which config names the redeem host and by
  // claude-redeem.mjs to decide where the durable credential is written. Gated
  // for the same reason endpoint-guard.mjs is, and more sharply: a drifted copy
  // that fell back to os.homedir() would silently restore the $HOME trust
  // boundary this module exists to remove, on one client only.
  { name: 'real-home.mjs', type: 'js' },
  // managed-telemetry.mjs (Workstream D §10.1) — the ONE detector for GitHub
  // Copilot CLI's enterprise-managed `telemetry` block (hostile/benign/none/
  // unknown). Copilot's own status/setup/enroll are the primary consumers;
  // gated the same way as the others — a drifted second copy on the Copilot
  // side is exactly the failure class this whole vendoring mechanism exists to
  // prevent, and here it would mean the two clients disagree about whether a
  // credential-valid probe is actually emission-healthy.
  { name: 'managed-telemetry.mjs', type: 'js' },
  // device-id.mjs (S16b) — the ONE credential-free device-identity accessor, so
  // neither client's setup prompt has to tell the model to open a file that
  // holds the durable emit credential. Gated for the sharpest reason on this
  // list: a drifted copy would be a second, un-reviewed reader of a credential
  // store, and the whole point of the module is that exactly one audited reader
  // exists and it prints only non-secret fields.
  { name: 'device-id.mjs', type: 'js' },
  // claude-config-dir.mjs — device-id.mjs reads the Claude Code store's
  // settings through it, so the vendored device-id needs the same resolver.
  { name: 'claude-config-dir.mjs', type: 'js' },
  // trusted-git.mjs — the ONE answer to "which git binary may we execute".
  // Gated like the rest, and for a reason specific to this lane: the Copilot
  // forwarder starts automatically with a repository as its cwd, and Windows
  // resolves a bare command name from the cwd before PATH. A drifted copy here
  // is a repository executing its own git.exe on one client only.
  { name: 'trusted-git.mjs', type: 'js' },
  // copilot-emit.mjs — the ONE credential/bearer/POST path, shared by the file
  // forwarder and the usage extension. copilot-usage.mjs — the extension core.
  { name: 'copilot-emit.mjs', type: 'js' },
  { name: 'copilot-usage.mjs', type: 'js' },
  // is-main.mjs — the ONE "launched directly?" guard. A drifted copy that went
  // back to a string compare would make the Copilot scripts exit 0 having done
  // nothing whenever their install path crosses a symlink.
  { name: 'is-main.mjs', type: 'js' },
]

// Single-line SYNC NOTE markers — the parity check strips lines starting with these.
const JS_NOTE = (name) =>
  `// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/${name}. Re-generate with: npm run sync:copilot-plugin`
const SH_NOTE = (name) =>
  `# SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/${name}. Re-generate with: npm run sync:copilot-plugin`

for (const { name, type } of FILES) {
  const src = resolve(root, 'plugin/scripts', name)
  const dst = resolve(root, 'copilot-plugin/scripts', name)

  const content = readFileSync(src, 'utf8')
  const note = type === 'sh' ? SH_NOTE(name) : JS_NOTE(name)

  // Insert the note AFTER a shebang if the file has one (a line before `#!` would
  // break it); otherwise prepend at the very top. otlp-logs.mjs has no shebang (it
  // opens with a block comment), so its note goes on line 1 rather than inside `/* */`.
  const lines = content.split('\n')
  const output = lines[0].startsWith('#!')
    ? [lines[0], note, ...lines.slice(1)].join('\n')
    : [note, ...lines].join('\n')

  writeFileSync(dst, output, { encoding: 'utf8' })

  // Preserve executable permission from source (important for .sh files).
  const srcMode = statSync(src).mode
  if (srcMode & 0o111) chmodSync(dst, srcMode)

  console.log(`  ✓  ${name}`)
}

console.log('\nDone. Run npm run check:copilot-plugin-sync to verify parity.')
