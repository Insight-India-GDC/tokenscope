/*
 * stale-install — is this script running from the TokenScope plugin that Claude
 * Code has installed now, or from an older copy a long-lived session still points
 * at (#456)?
 *
 * A session that stays open across a plugin update keeps serving the
 * /tokenscope:setup text of the version it started with, with
 * ${CLAUDE_PLUGIN_ROOT} already expanded to that version's cache folder. If that
 * folder still exists, setup runs the OLD helpers, which can undo what a newer
 * version changed (0.1.39's redeem wrote the refresh token into settings.json).
 * The redeem calls this before it spends the one-time handoff code.
 *
 * The source of truth is Claude Code's own record of what is installed,
 * `<config dir>/plugins/installed_plugins.json` (`plugins["tokenscope@<marketplace>"]`
 * → `[{ installPath, version }]`). The verdict is "stale" ONLY when all of these
 * hold, so an unfamiliar layout never blocks setup:
 *   - this script runs from under `<config dir>/plugins/cache/` (a marketplace
 *     install; a directory-marketplace checkout runs in place and is not judged);
 *   - the record is readable and lists at least one TokenScope install path that
 *     exists on disk;
 *   - none of those paths is the folder this script runs from;
 *   - every recorded install is a NEWER version than this one. The server's
 *     redeem_command picks the highest cached version, so after a downgrade or a
 *     pin the newest folder can run while an older one is installed: refusing
 *     there would fail setup on every retry, and that redeem is the newer code.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** [major, minor, patch] of a plain x.y.z version, or null. */
function semver(v) {
  const m = typeof v === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
/** True when version `a` is strictly greater than `b` (a null `a` is not). */
function newer(a, b) {
  if (!a) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * @param {{ pluginRoot: string, configDir: string }} opts
 * @returns {null | { running: string, runningVersion: string|null, installed: { path: string, version: string|null }[] }}
 */
export function staleInstall({ pluginRoot, configDir }) {
  const root = real(pluginRoot)
  const cache = real(join(configDir, 'plugins', 'cache'))
  if (!root || !cache || !root.startsWith(cache + sep)) return null

  let record
  try {
    record = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
  } catch {
    return null
  }
  const plugins = record && typeof record === 'object' ? record.plugins : null
  if (!plugins || typeof plugins !== 'object') return null

  const installed = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith('tokenscope@') || !Array.isArray(entries)) continue
    for (const e of entries) {
      const p = e && typeof e.installPath === 'string' ? real(e.installPath) : null
      if (p && existsSync(p)) installed.push({ path: p, version: typeof e.version === 'string' ? e.version : null })
    }
  }
  if (!installed.length || installed.some((i) => i.path === root)) return null

  let runningVersion
  try {
    runningVersion = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null
  } catch {
    return null // cannot show this copy is older
  }
  const run = semver(runningVersion)
  if (!run || !installed.every((i) => newer(semver(i.version), run))) return null
  return { running: root, runningVersion, installed }
}

/** The refusal, in the user's words: what happened and the one thing to do. */
export function staleInstallMessage(v) {
  const now = v.installed.map((i) => i.version).filter(Boolean)
  return (
    `[tokenscope] This session is running TokenScope ${v.runningVersion ?? 'from an older install'}` +
    `${now.length ? `, but ${now.join(', ')} is installed now` : ', but a different TokenScope install is active now'}. ` +
    'Setup was stopped before it changed anything, and your one-time code was not used. ' +
    'Quit and restart Claude Code, then run /tokenscope:setup again.'
  )
}
