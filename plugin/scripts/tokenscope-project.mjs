/*
 * tokenscope-project — the CLIENT-NEUTRAL per-repo project resolver + hasher.
 *
 * This module is the single SOURCE-OF-TRUTH for the four functions both clients
 * (Claude Code and Copilot CLI) must agree on so a committed `.tokenscope`
 * derives the SAME `project.code_hash` regardless of which client reads it:
 *
 *   - findTokenscopeFile(startDir) — walk up from cwd to the nearest `.tokenscope`.
 *   - parseTokenscope(filePath)    — parse the tiny YAML schema.
 *   - computeCodeHash(code)        — sha256(code) hex == the server's code_hash.
 *   - resolveRepoProjectCode({arg, cwd}) — arg or committed `.tokenscope` → code.
 *
 * It is DELIBERATELY self-contained (Node built-ins only, NO project imports) so
 * it can be vendored verbatim into copilot-plugin/scripts/ by
 * scripts/sync-copilot-plugin.mjs and gated by scripts/check-copilot-plugin-sync.mjs.
 * Drift between the two client copies = split attribution (the identical repo
 * derives different hashes on Claude vs Copilot). The Claude-coupled helpers
 * (writeRepoTag/mergeClaudeSettings/buildRepoResourceAttrs/writeTokenscopeFile)
 * stay in tag-repo.mjs — they pull on ~/.claude settings and must NOT ship here.
 *
 * YAML parser scope: we only need a flat `key: value` + a nested `project:` block
 * with three string fields. Avoiding the `yaml` npm dep keeps the plugin footprint
 * small (both plugins ship into user space).
 */
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Walk up from `startDir` looking for a committed `.tokenscope`. Returns the
 * absolute path of the nearest one, or null if none is found up to the fs root.
 * A regular file only: the walk from any repo under the home reaches
 * `~/.tokenscope`, which is this plugin's state DIRECTORY, not a tag.
 */
export function findTokenscopeFile(startDir) {
  let dir = resolve(startDir)
  const root = resolve('/')
  while (true) {
    const candidate = join(dir, '.tokenscope')
    if (isFile(candidate)) return candidate
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Parse a `.tokenscope` file. Returns
 *   { project: { code?, id?, name? }, optional: { client?, practice?, engagement_type?, pm? } }.
 *
 * `project.*` fields are read ONLY from lines indented under a `project:` block;
 * `optional.*` fields are read from TOP-LEVEL keys.
 *
 * The bare one-liner (the file's only line is the code itself, e.g.
 * `TokenScope-MVP`) is what the MCP `project` prompt wrote for a long time, so it
 * is read as `project.code` too (#485): repos tagged that way were silently
 * untagged. Only a lone line with no `key:` shape that passes the same
 * SAFE_PROJECT_CODE check counts; anything else is not a code.
 */
export function parseTokenscope(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const out = { project: {}, optional: {} }
  let inProject = false
  const meaningful = []

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '')
    if (line.trim() === '') continue
    meaningful.push(line.trim())
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line)) {
      const key = line.split(':')[0]
      inProject = key === 'project'
      continue
    }
    const m = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):\s*"?([^"]*?)"?\s*$/.exec(line)
    if (!m) continue
    const [, indent, key, value] = m
    if (indent.length > 0 && inProject) {
      if (key === 'code' || key === 'id' || key === 'name') {
        out.project[key] = value
      }
    } else if (indent.length === 0) {
      inProject = false
      if (key === 'client' || key === 'practice' || key === 'engagement_type' || key === 'pm') {
        out.optional[key] = value
      }
    }
  }

  if (meaningful.length === 1 && !meaningful[0].includes(':') && isSafeProjectCode(meaningful[0])) {
    out.project.code = meaningful[0]
  }
  return out
}

/** sha256(code) plain hex — matches the server's project.code_hash exactly
 * (server: createHash('sha256').update(code).digest('hex')). The SINGLE shared
 * derivation is the only way Claude + Copilot agree on a repo's hash server-side.
 * MUST NOT CHANGE (S1 fix 5) — determinism across client and server is a hard
 * requirement; salting would silently split attribution against every stored
 * code_hash. */
export function computeCodeHash(code) {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * S1 fix 5 — the strict charset/length a `.tokenscope`-sourced project code
 * must match. `.tokenscope` is a REPO-CONTROLLED file — in a hostile repo,
 * `project.code` is chosen by the repo's author, not the developer who
 * cloned it — so validate it at the PARSE boundary (here) rather than
 * trusting it downstream into a hash, a server request, or (session-start.mjs)
 * a developer-facing warning message that used to also reach the MODEL's
 * context via additionalContext. Admits `/` deliberately: real project codes
 * look like "1000012345/450000001" (see plugin/README.md's `.tokenscope`
 * example) — but excludes whitespace, quotes, backticks, and shell/markdown-
 * special characters that would be unsafe to interpolate into a message, a
 * URL query param, or a rendered warning.
 */
const SAFE_PROJECT_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/

/**
 * #475: the folder's default activity, `tokenscope.activity` in
 * `<dir>/.claude/settings.local.json` (the uncommitted, per-developer file; never
 * the committed `.tokenscope` or `.claude/settings.json`). It rides telemetry as
 * the `tokenscope.activity` resource attribute and the SERVER accepts it only
 * when it names one of the region's standard activity types, so a client or bid
 * name typed here is dropped there. This shape check only keeps it a plain
 * label (letters, digits, spaces and `_ - & / . ( ) +`, as admin-made activity
 * types use, at most 64 characters); `,` and `=` would break the attribute string.
 */
const SAFE_ACTIVITY = /^[A-Za-z0-9][A-Za-z0-9 _&/.()+-]{0,63}$/

/** The folder's default activity label, or null (absent, unreadable or not a plain label). */
export function readFolderActivity(dir) {
  const file = join(dir, '.claude', 'settings.local.json')
  try {
    // A regular file only: a committed symlink or FIFO is not read (same rule as the repo tag).
    if (!lstatSync(file).isFile()) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))?.tokenscope?.activity
    if (typeof value !== 'string') return null
    const label = value.trim()
    return SAFE_ACTIVITY.test(label) ? label : null
  } catch {
    return null
  }
}

/**
 * The default activity of the nearest folder, walking up from `startDir`, that
 * has a `.claude/settings.local.json` (a Copilot session can start in a
 * subfolder of the project). Null when that file names none.
 */
export function findFolderActivity(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 256; i++) {
    try {
      lstatSync(join(dir, '.claude', 'settings.local.json'))
      return readFolderActivity(dir)
    } catch {
      /* no file here: keep walking */
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** True if `code` is a `.tokenscope`-safe project code (see SAFE_PROJECT_CODE). */
export function isSafeProjectCode(code) {
  return typeof code === 'string' && SAFE_PROJECT_CODE.test(code)
}

/**
 * Resolve the repo's project CODE from an explicit arg or the committed
 * `.tokenscope` (walked up from cwd). Returns { code, source, tokenscopePath }.
 * Throws if no code can be resolved. No server call — the code is taken at face
 * value (the project is a membership-gated claim, validated server-side later).
 *
 * A `.tokenscope`-sourced code failing the SAFE_PROJECT_CODE charset (S1 fix 5)
 * is treated IDENTICALLY to having no project.code at all — the existing
 * silent no-tag path — never carried forward. `arg` is NOT charset-constrained:
 * it is never repo-controlled (the project MCP prompt passes a server-
 * validated code the user picked from their own membership list; every
 * hook-context caller passes `arg: ''`).
 */
export function resolveRepoProjectCode({ arg, cwd }) {
  if (arg && arg.trim()) {
    return { code: arg.trim(), source: 'arg', tokenscopePath: null }
  }
  const tsPath = findTokenscopeFile(cwd)
  if (tsPath) {
    const fileData = parseTokenscope(tsPath)
    if (fileData?.project?.code && isSafeProjectCode(fileData.project.code)) {
      return { code: fileData.project.code, source: 'tokenscope', tokenscopePath: tsPath }
    }
    // MISSING and PRESENT-BUT-UNSAFE are different problems and need different
    // instructions: "add one" is useless advice to someone who already added
    // one. The rejected value is NOT echoed — a .tokenscope is repo-controlled
    // and this message reaches a log, so the charset rule is stated instead.
    if (fileData?.project?.code) {
      throw new Error(
        `.tokenscope at ${tsPath} has a project.code that is not usable as a project code — ` +
          'it must start alphanumeric and contain only letters, digits, dot, underscore, hyphen or ' +
          'slash (max 64 chars). Fix the value; the repo stays untagged until then.',
      )
    }
    throw new Error(
      `.tokenscope at ${tsPath} has no project.code — add one (the canonical project code).`,
    )
  }
  throw new Error(
    'Could not resolve a project code — bind the repo via the project MCP prompt, or add a committed .tokenscope with project.code at the repo root.',
  )
}
