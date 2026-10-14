/*
 * Trust-class lint for the plugins' scripts. A checked-out repository can set
 * environment variables for the session (its .claude/settings.json `env`), so
 * plugin code must not let HOME or SystemRoot decide a path, a binary or a
 * credential destination. The repo's primitives are realHome() (real-home.mjs)
 * and windowsPowerShellPath() / windowsSystem32Path() (emit-helper-spawn.mjs).
 *
 * A RATCHET, not a sweep: the call sites below were in the tree when this gate
 * was added (2026-10-08, after a review found new code reading SystemRoot and
 * homedir() for a privileged write). Any NEW one fails unless its line says
 * `// homedir-ok: <why>` (for example, reading a file Claude Code itself reads
 * through HOME). Lower a count when you remove one; never raise it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const DIRS = ['plugin/scripts', 'plugin/hooks', 'copilot-plugin/scripts', 'copilot-plugin/hooks', 'copilot-plugin/extensions']

/** homedir(), and HOME / USERPROFILE read from any env object, dotted or bracketed. */
export const HOME_READ = /homedir\(\)|\benv\s*(?:\.\s*(?:HOME|USERPROFILE)\b|\[\s*['"`](?:HOME|USERPROFILE)['"`]\s*\])/
/** SystemRoot in any spelling Windows accepts (env names are case-insensitive there). */
export const SYSTEM_ROOT = /\bsystemroot\b/i
/**
 * Reviewed SystemRoot reads: windowsPowerShellPath's one validated fallback
 * line, in the plugin and its vendored copy. A ratchet like HOME_BASELINE: a
 * second read in the same file fails too.
 */
const SYSTEM_ROOT_BASELINE: Record<string, number> = {
  'plugin/scripts/emit-helper-spawn.mjs': 1,
  'copilot-plugin/scripts/emit-helper-spawn.mjs': 1,
}

/** Reviewed HOME-following call sites present when the gate was added. */
const HOME_BASELINE: Record<string, number> = {
  'copilot-plugin/scripts/copilot-emit.mjs': 2,
  'copilot-plugin/scripts/copilot-forwarder.mjs': 1,
  'copilot-plugin/scripts/copilot-redeem.mjs': 4,
  'copilot-plugin/scripts/device-id.mjs': 1,
  'copilot-plugin/scripts/enroll.mjs': 2,
  'copilot-plugin/scripts/real-home.mjs': 1,
  'plugin/hooks/session-start.mjs': 2,
  'plugin/scripts/backfill.mjs': 1,
  'plugin/scripts/claude-redeem.mjs': 2,
  'plugin/scripts/copilot-emit.mjs': 2,
  'plugin/scripts/copilot-forwarder.mjs': 1,
  'plugin/scripts/copilot-redeem.mjs': 4,
  'plugin/scripts/device-id.mjs': 1,
  'plugin/scripts/enroll.mjs': 3,
  'plugin/scripts/plugin-runtime.mjs': 1,
  'plugin/scripts/real-home.mjs': 1,
  'plugin/scripts/statusline-toggle.mjs': 1,
  'plugin/scripts/tag-repo.mjs': 1,
}

function sources(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(mjs|js|cjs)$/.test(n)) out.push(p)
    }
  }
  for (const d of DIRS) walk(join(ROOT, d))
  return out.sort()
}

/** Code lines (comment-only lines and trailing // comments dropped), with their text. */
function codeLines(file: string) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((raw, i) => ({ raw, line: i + 1, code: /^\s*(\*|\/\/|\/\*)/.test(raw) ? '' : raw.replace(/\/\/.*$/, '') }))
}

describe('plugin trust-class lint', () => {
  it('the detectors catch every spelling they promise to', () => {
    for (const code of [
      'homedir()',
      'os.homedir()',
      'process.env.HOME',
      'env.USERPROFILE',
      "process.env['HOME']",
      'env["USERPROFILE"]',
      'env[ `HOME` ]',
    ]) {
      expect(HOME_READ.test(code), code).toBe(true)
    }
    for (const code of ['process.env.SystemRoot', "env['SystemRoot']", 'env.SYSTEMROOT', 'env.systemroot']) {
      expect(SYSTEM_ROOT.test(code), code).toBe(true)
    }
    expect(HOME_READ.test('env.HOMEPAGE')).toBe(false)
    expect(HOME_READ.test('realHome()')).toBe(false)
  })

  it('SystemRoot is read only by the reviewed resolver line', () => {
    const over = sources().flatMap((f) => {
      const rel = relative(ROOT, f).split('\\').join('/')
      const n = codeLines(f).filter((l) => SYSTEM_ROOT.test(l.code)).length
      return n > (SYSTEM_ROOT_BASELINE[rel] ?? 0) ? [`${rel}: ${n} SystemRoot reads, baseline ${SYSTEM_ROOT_BASELINE[rel] ?? 0}`] : []
    })
    expect(over, 'use windowsSystem32Path() from emit-helper-spawn.mjs').toEqual([])
  })

  it('no new HOME-following call without a homedir-ok note (use realHome() for anything privileged)', () => {
    const over: string[] = []
    for (const f of sources()) {
      const rel = relative(ROOT, f).split('\\').join('/')
      // A homedir-ok note on the line or the line above justifies that call.
      const lines = codeLines(f)
      const n = lines.filter((l, i) => HOME_READ.test(l.code) && !/homedir-ok:/.test(l.raw + (lines[i - 1]?.raw ?? ''))).length
      const allowed = HOME_BASELINE[rel] ?? 0
      if (n > allowed) over.push(`${rel}: ${n} unannotated, baseline ${allowed}`)
    }
    expect(over).toEqual([])
  })
})
