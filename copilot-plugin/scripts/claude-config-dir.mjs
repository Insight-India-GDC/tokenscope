// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/claude-config-dir.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * The Claude Code config folder this session belongs to: `CLAUDE_CONFIG_DIR`
 * when the user's own environment set it to a folder of theirs, else
 * `<home>/.claude`. Every script that reads or writes Claude Code's OWN files
 * (settings.json, .credentials.json, projects/) resolves the folder here.
 *
 * Claude Desktop sets CLAUDE_CONFIG_DIR for its sessions when the app has its
 * own install (verified on Linux, 2026-10-10: ~/.claude-desktop), and people
 * running several Claude setups set it in their shell. Writing ~/.claude there
 * gives the credential to the wrong install and leaves the running one silent.
 *
 * The variable also reaches hook and tool processes from a repository's
 * settings `env`, and this folder decides where a durable credential is
 * written and which server_url a handoff code is posted to. So it is honoured
 * only when it is absolute, resolves inside the passwd home (not the home
 * itself), is not inside a git work tree, and no project settings file
 * reachable from `cwd` names it. The residual is projectSetsEntrypoint's: a
 * project that removed the key after the session loaded it.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertConfinedPath } from './argv-guard.mjs'
import { realHome } from './real-home.mjs'

export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR'

/** A settings file is a few KB; anything past this is not one. */
const SETTINGS_MAX_BYTES = 1024 * 1024

/**
 * A settings file's `env` object; {} when the file is absent; null when it is
 * present but cannot be inspected (not a regular file, oversized, unreadable or
 * not JSON). Null fails CLOSED in projectSetsEnvKey: a padded or odd project
 * file must not hide the key from the gate. Self-contained (no plugin-runtime
 * import) because this module is vendored into the Copilot plugin with
 * device-id.mjs.
 */
function readEnvBlock(path) {
  let fd
  try {
    // O_NONBLOCK: a repository can make the path a FIFO, which would block a
    // plain open (plugin-runtime.mjs readRegularFileBounded, same reason).
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (err) {
    return err && err.code === 'ENOENT' ? {} : null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > SETTINGS_MAX_BYTES) return null
    const buf = Buffer.alloc(st.size)
    readSync(fd, buf, 0, st.size, 0)
    const s = JSON.parse(buf.toString('utf8'))
    if (!s || typeof s !== 'object') return null
    return typeof s.env === 'object' && s.env ? s.env : {}
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** realpath of `p`, or of its nearest existing ancestor with the rest appended. */
function canonical(p) {
  const tail = []
  let cur = resolve(p)
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(cur), ...tail)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      tail.unshift(cur.slice(parent.length).replace(/^[\\/]/, ''))
      cur = parent
    }
  }
  return resolve(p)
}

/**
 * Whether a PROJECT settings file (`.claude/settings.json` or
 * `settings.local.json`, from `cwd` up to the root) names `key` in its `env`.
 * A file `readEnv` cannot inspect (null) counts as naming it.
 * `userFiles` are the user's own settings files, which are not project files.
 */
export function projectSetsEnvKey(key, cwd = process.cwd(), { userFiles = [], readEnv = readEnvBlock } = {}) {
  // Canonical on both sides, so a home reached through a symlink still
  // recognises the user's own file.
  const mine = new Set(userFiles.flatMap((f) => [resolve(f), canonical(f)]))
  for (let dir = canonical(cwd); ; dir = dirname(dir)) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const path = join(dir, '.claude', f)
      if (mine.has(path) || mine.has(canonical(path))) continue
      const env = readEnv(path)
      if (env === null || Object.hasOwn(env, key)) return true
    }
    if (dirname(dir) === dir) return false
  }
}

/**
 * `{ dir, source, refused }`: `source` is 'env' when CLAUDE_CONFIG_DIR was
 * honoured, else 'default'; `refused` names why a set value was not
 * (`{ reason, value }`), or is null.
 *
 * `home` is the default's base: callers that follow HOME for "what Claude Code
 * reads" pass homedir(); the default is the passwd home. The gate always uses
 * the passwd home.
 */
export function resolveClaudeConfigDir({
  env = process.env,
  cwd = process.cwd(),
  home = realHome(),
  trustedHome = realHome(),
  readEnv = readEnvBlock,
} = {}) {
  const fallback = (refused) => ({ dir: join(home, '.claude'), source: 'default', refused })
  const raw = typeof env[CONFIG_DIR_VAR] === 'string' ? env[CONFIG_DIR_VAR].trim() : ''
  if (!raw) return fallback(null)
  const refuse = (reason) => fallback({ reason, value: raw.slice(0, 200) })
  if (!isAbsolute(raw)) return refuse('not-absolute')
  const userFiles = [join(trustedHome, '.claude', 'settings.json')]
  if (projectSetsEnvKey(CONFIG_DIR_VAR, cwd, { userFiles, readEnv })) return refuse('set-by-project')
  let real
  try {
    real = assertConfinedPath(raw, { flag: CONFIG_DIR_VAR, roots: [trustedHome], refuseInsideRepo: true })
  } catch (err) {
    return refuse(err?.reason || 'outside-home')
  }
  let homeReal
  try {
    homeReal = assertConfinedPath(trustedHome, { flag: 'home', roots: [trustedHome] })
  } catch {
    homeReal = resolve(trustedHome)
  }
  if (real === homeReal) return refuse('is-home')
  // A folder that does not exist yet is fine (Claude Code creates it); an
  // existing file, FIFO or socket is not a config folder.
  let st = null
  try {
    st = statSync(real)
  } catch {
    /* absent */
  }
  if (st && !st.isDirectory()) return refuse('not-a-directory')
  return { dir: real, source: 'env', refused: null }
}

/** The folder alone. */
export function claudeConfigDir(opts) {
  return resolveClaudeConfigDir(opts).dir
}

/** `<config folder>/settings.json`. */
export function claudeSettingsPath(opts) {
  return join(claudeConfigDir(opts), 'settings.json')
}
