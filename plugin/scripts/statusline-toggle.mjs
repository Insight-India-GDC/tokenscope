#!/usr/bin/env node
/*
 * statusline-toggle.mjs — implements `/tokenscope:statusline [on|off]`.
 *
 * Turns the TokenScope status line (emission health + session id) on or off in
 * the GLOBAL ~/.claude/settings.json. Nothing installs it at enrolment; this is
 * how a developer opts in (replacing a custom status line) or out.
 *
 *   on   — install TokenScope's status line (replaces a custom one if present)
 *   off  — remove TokenScope's status line (a non-TokenScope one is left untouched)
 *   (no arg) — report current state
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installStatusLine, removeStatusLine } from './env-builder.mjs'
import { casWriteFile, resolveScriptsDir } from './plugin-runtime.mjs'
import { claudeSettingsPath } from './claude-config-dir.mjs'

const arg = (process.argv[2] || '').trim().toLowerCase()
const settingsPath = claudeSettingsPath({ home: homedir() })
// CONFINED (MDASH follow-up): this path is WRITTEN INTO ~/.claude/settings.json
// as a statusLine command, which Claude Code then executes on every render — so
// an unconfined CLAUDE_PLUGIN_ROOT here persists repo-chosen code, outliving the
// session that planted it. The review that found the other three consumers
// missed this one; it is the worst of them.
const scriptsDir = resolveScriptsDir()
const statuslinePath = join(scriptsDir, 'statusline.mjs')

let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    // NEVER proceed with {} — saving would rewrite settings.json as just
    // {statusLine}, wiping the env block (the durable emit credential, OTel
    // endpoints), otelHeadersHelper, and permissions: silent de-enrolment.
    // Same refuse-on-unparseable contract as claude-redeem's writeClaudeSettings.
    console.error(
      `[tokenscope] Existing ${settingsPath} is not valid JSON — refusing to touch it. Fix or move it, then re-run.`,
    )
    process.exit(1)
  }
}
const hasOurs =
  settings.statusLine &&
  typeof settings.statusLine === 'object' &&
  typeof settings.statusLine.command === 'string' &&
  settings.statusLine.command.includes('statusline.mjs')

/*
 * Through casWriteFile: `apply` gets the CURRENT settings and is re-run on
 * contention. This process waited for a human between read and write, so its
 * snapshot is the stalest of any writer; a blind write-back would roll back a
 * refresh token rotated in the meantime.
 */
function save(apply) {
  let result
  try {
    result = casWriteFile(settingsPath, (raw) => {
      let current
      try {
        current = raw === null ? {} : JSON.parse(raw)
      } catch {
        // Same refuse-on-unparseable contract as the initial load: writing would
        // rewrite settings.json as just {statusLine}, wiping the env block.
        console.error(
          `[tokenscope] ${settingsPath} is not valid JSON — refusing to touch it. Fix or move it, then re-run.`,
        )
        process.exit(1)
      }
      const next = apply(current)
      return next === null ? null : JSON.stringify(next, null, 2) + '\n'
    })
  } catch (err) {
    // An unreadable or unwritable settings.json (EACCES, EIO): refuse, never
    // replace it. The message names the path only.
    console.error(
      `[tokenscope] could not update ${settingsPath} (${err?.code ?? 'error'}) — not touching it. Fix its permissions, then re-run.`,
    )
    process.exit(1)
  }
  if (result.reason === 'contended') {
    console.error(
      `[tokenscope] ${settingsPath} kept changing while this command ran — not overwriting it. Re-run the toggle.`,
    )
    process.exit(1)
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

if (arg === 'off') {
  const { removed } = removeStatusLine(settings)
  if (removed) save((current) => removeStatusLine(current).settings)
  emit({
    action: 'off',
    changed: removed,
    message: removed
      ? 'TokenScope status line turned OFF.'
      : 'No TokenScope status line was set (left any custom one untouched).',
  })
} else if (arg === 'on') {
  // Explicit opt-in: force-install, replacing a custom status line if present.
  const replacedCustom = Boolean(settings.statusLine) && !hasOurs
  save((current) => installStatusLine(current, statuslinePath, { force: true }).settings)
  emit({
    action: 'on',
    changed: true,
    replacedCustom,
    message: replacedCustom
      ? 'TokenScope status line turned ON (replaced your previous custom status line).'
      : 'TokenScope status line turned ON (emission health + session id).',
  })
} else {
  emit({
    action: 'status',
    enabled: Boolean(hasOurs),
    hasCustom: Boolean(settings.statusLine) && !hasOurs,
    message: hasOurs
      ? 'TokenScope status line is ON.'
      : settings.statusLine
        ? 'A custom (non-TokenScope) status line is set. Run `/tokenscope:statusline on` to replace it.'
        : 'TokenScope status line is OFF. Run `/tokenscope:statusline on` to enable it.',
  })
}
