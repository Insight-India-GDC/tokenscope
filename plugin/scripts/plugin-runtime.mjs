/*
 * plugin-runtime — shared runtime helpers for the TokenScope plugin's command +
 * hook scripts. Centralises what was drifting across status.mjs, usage.mjs,
 * session-start.mjs, read-credential.mjs (and partly backfill.mjs / tag-repo.mjs):
 *
 *   - locating the bundled scripts dir + otel-headers-helper.sh (the real emit path)
 *   - reading a settings.json `env` block (global or repo-local)
 *   - the TokenScope state dir and the emit-failure sentinel
 *   - invoking the REAL emit path and classifying the result WITHOUT ever
 *     surfacing the bearer it prints to stdout
 *
 * One module owning the emit-path contract means a change there (stdio handling,
 * the Authorization-header check, the state-dir layout) lands in exactly one
 * place — the supportability win behind this extraction.
 *
 * NOTE: backfill.mjs deliberately keeps its OWN helper invocation: it needs the
 * raw bearer VALUE to POST telemetry, whereas runEmitHelper() here only returns
 * whether a bearer was minted (never the token) — the right contract for a health
 * probe, the wrong one for a re-emitter.
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
  linkSync,
  rmSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, sep, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
// Store layout lives in device-store.mjs (synced to both plugins); re-exported
// so existing importers keep one import site.
import {
  TOOLS,
  deviceStorePath,
  accessCachePath,
  legacyStorePath,
  bearerInstance,
  attrsTool,
  attrsInstance,
  assertStoreConsistent,
  assertHelperRecord,
  settingsFilesPath,
  isolatedSettingsFilesPath,
} from './device-store.mjs'
import https from 'node:https'
import http from 'node:http'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
// Re-exported so existing importers keep one name, and so mcp-origin.mjs can
// reach it without importing this module (copilot-plugin does not vendor it).
import { realHome } from './real-home.mjs'
import { claudeConfigDir, claudeSettingsPath } from './claude-config-dir.mjs'
import { parseHelperCommand } from './env-builder.mjs'
import { assertConfinedPath } from './argv-guard.mjs'
import { emitHelperSpawn, helperScriptName } from './emit-helper-spawn.mjs'
export { realHome }
export {
  TOOLS,
  deviceStorePath,
  accessCachePath,
  legacyStorePath,
  bearerInstance,
  attrsTool,
  attrsInstance,
  assertStoreConsistent,
}

// Re-exported so every existing importer of plugin-runtime.mjs has ONE name to
// reach for (S1 fix 3) — the implementation lives in endpoint-guard.mjs, which
// stays dependency-free so it can also be vendored standalone into the Copilot
// distribution. plugin-runtime.mjs itself is NOT vendored (it imports Node
// builtins beyond what endpoint-guard needs and carries Claude-lane settings
// resolution the Copilot lane has no use for).
export { assertSafeEndpoint } from './endpoint-guard.mjs'

/**
 * POST a JSON body and resolve the parsed JSON response (dependency-free; shared
 * by the redeem helpers so a fix to the HTTP path lands in one place). Rejects on
 * a non-2xx status or a non-JSON body. NEVER logs the body — callers redeem
 * credential material through this.
 *
 * Times out by default (30s): an unresponsive endpoint must fail loud rather than
 * hang the enrolment forever while the 5-min handoff code expires.
 *
 * The URL is validated via assertSafeEndpoint (S1 fix 3) — this used to pick
 * `http` for ANY non-https URL with no complaint (the "plain-http fallback"),
 * which would silently downgrade a poisoned endpoint instead of refusing it.
 * `allowLoopback` defaults true: every caller of this helper is a plugin
 * script resolving its OWN target (via api-base.mjs, which validates itself),
 * and the documented local-dev override (`http://localhost:3450`) must keep
 * working end-to-end through this shared POST path.
 */
export function httpsPostJson(urlStr, body, { timeoutMs = 30_000, allowLoopback = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback })
    } catch (err) {
      // Redact at the throw site: assertSafeEndpoint's message embeds the
      // REJECTED endpoint, and this promise's rejection is printed by callers'
      // generic handlers that interpolate err.message. Rejecting the raw guard
      // error is the CodeQL js/clear-text-logging class.
      reject(unsafeEndpointError('Endpoint', err))
      return
    }
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8')
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
          }
        })
      },
    )
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`))
      })
    }
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

/*
 * CLAUDE_PLUGIN_ROOT CONFINEMENT — one implementation, every consumer.
 *
 * This variable chooses which scripts we execute and which paths we PERSIST into
 * settings for Claude Code to execute later. It arrives in the environment a
 * repo's settings `env` block is merged into, and it is absent from Claude
 * Code's published list of variables settings may not override — so the
 * precedence that protects us today is borrowed behaviour, not a guarantee.
 *
 * Accept it only when it resolves INSIDE our own install. The directory this
 * module was loaded from is, by construction, the installed bundle; sibling
 * VERSIONS under the same parent stay acceptable, because following a
 * freshly-installed version is deliberate (see tag-repo.mjs's resolveHelperPath).
 * `realpathSync` on both sides defeats `..` and symlink escapes.
 *
 * ONE implementation for every consumer: runEmitHelper, backfill's mintBearer,
 * statusline-toggle (which PERSISTS a command Claude Code later runs) and
 * tag-repo all resolve through here. See epic-mdash-remediation.md (§2.6).
 */
export function ownBundleParent() {
  // <bundle>/scripts/plugin-runtime.mjs -> <bundle> -> <versions dir>
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

/** `0.1.36` -> [0,1,36]; null for anything that is not a version segment. */
function versionTuple(segment) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(segment)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function notOlderThanOurs(candidateReal, rootReal) {
  const ours = versionTuple(basename(dirname(dirname(fileURLToPath(import.meta.url)))))
  const rel = candidateReal.slice(rootReal.length + 1).split(sep)[0]
  const theirs = versionTuple(rel)
  // Not a version-shaped layout (a dev checkout, an unexpected cache): fall back
  // to the containment test alone rather than refusing a legitimate install.
  if (!ours || !theirs) return true
  for (let i = 0; i < 3; i++) {
    if (theirs[i] > ours[i]) return true
    if (theirs[i] < ours[i]) return false
  }
  return true // same version
}

export function withinOwnInstall(candidate) {
  try {
    const root = realpathSync(ownBundleParent())
    const real = realpathSync(candidate)
    const contained = real === root || real.startsWith(root + sep)
    if (!contained) return false
    /*
     * NO DOWNGRADES. Containment alone admits every cached sibling version, so a
     * repo-set CLAUDE_PLUGIN_ROOT could select an OLDER release that still has
     * the bugs this one fixes. Newer siblings stay allowed — that is the
     * intended upgrade auto-follow.
     * See docs/security-sprint/epic-mdash-remediation.md (Wave 1).
     */
    return notOlderThanOurs(real, root)
  } catch {
    return false // unresolvable -> refuse
  }
}

/** The bundled plugin scripts dir. CLAUDE_PLUGIN_ROOT only when confined. */
export function resolveScriptsDir() {
  const own = dirname(fileURLToPath(import.meta.url))
  const claimed = process.env.CLAUDE_PLUGIN_ROOT
    ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts')
    : null
  if (claimed && existsSync(claimed) && withinOwnInstall(claimed)) return claimed
  return own
}

/** Absolute path to the bundled headers helper for `platform` (the real emit path). */
export function resolveHelperPath(platform = process.platform) {
  return join(resolveScriptsDir(), helperScriptName(platform))
}

/**
 * The TokenScope state dir (TOKENSCOPE_STATE_DIR, else this Claude install's own:
 * claudeInstallStateDir), anchored on the passwd home so it is stable across a leaked `HOME`. This dir is
 * plugin-owned (token cache, failure sentinels, landed state) — it is NOT `~/.claude`,
 * which stays on `homedir()` to match Claude Code's own settings resolution.
 *
 * The `env` parameter is accepted but deliberately UNUSED (kept only for
 * call-site compatibility — readEmitSentinel and others still pass one; JS
 * ignores an extra argument). See the S1 note inside the function body.
 */
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export function stateDir(env) {
  // The override is a PROCESS-level concern (a deployment pin / test sandbox):
  // nothing anywhere legitimately writes TOKENSCOPE_STATE_DIR to settings.json,
  // global or repo. So this reads `process.env` ONLY and ignores a passed
  // `env.TOKENSCOPE_STATE_DIR` entirely — the parameter still exists so call
  // sites need not change, it simply no longer influences the state dir.
  // Anchored on the passwd home (HOME-leak-proof).
  //
  // WHAT THIS DOES NOT BUY, stated plainly because an earlier version of this
  // comment claimed the opposite: reading `process.env` is NOT safer than
  // reading a settings-derived object. Claude Code merges a repository's
  // settings `env` block into the process environment, so on this code path
  // `process.env` IS settings-derived and a hostile repo can set this key.
  // Ignoring the passed `env` therefore closes one route and leaves the other
  // open — it is a narrowing, not a boundary.
  //
  // The boundary lives at the CALLER, which is the only layer that still knows
  // provenance: see `hookStateDir()` in plugin/hooks/session-start.mjs, which
  // asks whether a repo-local settings file named the key and replaces or drops
  // it if so. `safeProcessEnv()` cannot do that job here — it strips a COPY,
  // while this function reads the live environment.
  const override = (process.env.TOKENSCOPE_STATE_DIR ?? '').trim()
  return override || claudeInstallStateDir()
}

/**
 * The state dir with NO environment override — `~/.tokenscope` on the passwd
 * home, and nothing else.
 *
 * For the paths where a directory decides who receives a secret and the caller
 * has NOT established the provenance of `TOKENSCOPE_STATE_DIR`. `stateDir()`
 * deliberately honours that variable (a deployment pin, a test sandbox); this is
 * the answer for callers that cannot afford to.
 */
export function trustedStateDir() {
  return join(realHome(), '.tokenscope')
}

const IS_WIN = process.platform === 'win32'

/** realpath (native on Windows, case-folded there), or the resolved path when absent. */
function canonicalDir(p) {
  let out
  try {
    out = (IS_WIN ? realpathSync.native : realpathSync)(p)
  } catch {
    out = resolve(p)
  }
  return IS_WIN ? out.toLowerCase() : out
}

/**
 * The Claude lane's state dir for the Claude config folder `configDir`
 * (claude-config-dir.mjs). The store is keyed by tool only, and Claude Desktop
 * runs the same tool from its own folder, so two installs sharing one dir
 * overwrite each other's enrolment (#449). The default `<passwd home>/.claude`
 * keeps trustedStateDir() itself, so a single install never moves.
 */
export function claudeStateDir(configDir = claudeConfigDir()) {
  const dir = canonicalDir(configDir)
  if (dir === canonicalDir(join(realHome(), '.claude'))) return trustedStateDir()
  const key = createHash('sha256').update(dir).digest('hex').slice(0, 12)
  return join(trustedStateDir(), 'claude-config', key)
}

/**
 * The state dir the emit helper in `helperCommand` reads: its `--state-dir`;
 * the default dir for a helper without one (an install enrolled before #449);
 * claudeStateDir(configDir) when there is no helper yet, or its `--state-dir`
 * is outside the passwd home or inside a repository.
 */
export function helperStateDir(helperCommand, configDir) {
  const named = parseHelperCommand(helperCommand)?.stateDir
  if (named) {
    try {
      assertConfinedPath(named, { flag: '--state-dir', refuseInsideRepo: true })
      return named
    } catch {
      return claudeStateDir(configDir)
    }
  }
  return typeof helperCommand === 'string' && helperCommand.trim() ? trustedStateDir() : claudeStateDir(configDir)
}

/** helperStateDir for the helper in `configDir`'s own settings.json. */
export function claudeInstallStateDir(configDir = claudeConfigDir()) {
  let helper = null
  try {
    helper = JSON.parse(readRegularFileBounded(join(configDir, 'settings.json'), SETTINGS_MAX_BYTES) ?? 'null')?.otelHeadersHelper
  } catch {
    /* unreadable settings: no helper */
  }
  return helperStateDir(helper, configDir)
}

/**
 * The lanes that own an enrolment. The store filename is derived from this, so
 * it is a closed set rather than free text.
 */
/** Parse a store file, or null when absent/unreadable/not an object. */
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** This lane's v2 store, or null. */
export function readDeviceStore(tool, dir = trustedStateDir()) {
  return readJsonObject(deviceStorePath(tool, dir))
}

/**
 * Every Claude-lane enrolment on this machine, as instance id ->
 * { dir, bearerEndpoint }: the default store and each per-config-folder store
 * under `claude-config/` (#449). Only a complete, consistent store counts; a
 * symlinked folder is not followed.
 */
export function localClaudeEnrolments(root = trustedStateDir()) {
  const dirs = [root]
  try {
    for (const e of readdirSync(join(root, 'claude-config'), { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(join(root, 'claude-config', e.name))
    }
  } catch {
    /* no per-config-folder stores */
  }
  const out = new Map()
  for (const dir of dirs) {
    try {
      const store = assertStoreConsistent('claude-code', readDeviceStore('claude-code', dir))
      if (!out.has(store.instance_id)) out.set(store.instance_id, { dir, bearerEndpoint: store.bearer_endpoint })
    } catch {
      /* absent or incomplete: not an enrolment */
    }
  }
  return out
}

function originOf(url) {
  try {
    const o = new URL(String(url ?? '')).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/**
 * THE KEEP RULE for a repo tag's instance, shared by writeRepoTag (what the tag
 * holds) and backfill (what a replay stamps). Returns { instanceId, dir } when a
 * tag naming `tagInstance` keeps it, else null and the tag takes `ownInstance`.
 *
 * Kept only when another local Claude-lane store holds it AND that store targets
 * the deployment this install does: the same bearer-endpoint origin (scheme,
 * host, port). Records carry the tag's instance but are sent with this install's
 * credential to this install's deployment, which does not know an instance
 * enrolled elsewhere.
 */
export function keptRepoTagEnrolment(tagInstance, ownInstance, ownBearerEndpoint, root = trustedStateDir()) {
  if (!tagInstance || tagInstance === ownInstance) return null
  const own = originOf(ownBearerEndpoint)
  if (!own) return null
  const store = localClaudeEnrolments(root).get(tagInstance)
  return store && originOf(store.bearerEndpoint) === own ? { instanceId: tagInstance, dir: store.dir } : null
}

/**
 * Whether `dir` holds a complete store for `tool` whose bearer names the same
 * instance as `bearerEndpoint`. The emit helper adopts such a store whole
 * (source 1), so this, not a refresh token in settings, is what "enrolled" means.
 */
export function storeHoldsEnrolment(tool, bearerEndpoint, dir = trustedStateDir()) {
  try {
    const store = assertStoreConsistent(tool, readDeviceStore(tool, dir))
    const want = bearerInstance(String(bearerEndpoint ?? '').trim())
    return Boolean(want) && bearerInstance(store.bearer_endpoint) === want
  } catch {
    return false
  }
}

/**
 * The helper record the store in `dir` persisted, or null.
 *
 * Accepted ONLY when it names the same state dir as the command being rebuilt
 * (`stateDir`, undefined for none). The command's `--state-dir` is what says
 * which store the file belongs to; a record that disagreed with it would be a
 * different enrolment's, and rebuilding from it would drop or swap the state
 * dir — #410 in the other direction.
 */
export function readHelperRecord(tool, dir, stateDir) {
  try {
    const record = assertHelperRecord(readDeviceStore(tool, dir)?.helper, tool)
    return record.stateDir === stateDir ? record : null
  } catch {
    return null
  }
}

/** Bounded so a long-lived device cannot grow session start's work without limit. */
const SETTINGS_FILES_MAX = 32

/** The session-scoped settings files listed in `dir` (raw, UNVALIDATED), or []. */
export function readSettingsFilesList(tool, dir) {
  const files = readJsonObject(settingsFilesPath(tool, dir))?.files
  return Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f) : []
}

/**
 * Add `settingsPath` to the list in `dir`, newest last, oldest dropped past the
 * cap. The list holds paths only, never a credential; 0600 anyway, like
 * everything else in the state dir.
 */
export function recordSettingsFile(tool, dir, settingsPath) {
  return casWriteFile(settingsFilesPath(tool, dir), (raw) => {
    let files = []
    try {
      const parsed = raw === null ? null : JSON.parse(raw)
      if (Array.isArray(parsed?.files)) files = parsed.files.filter((f) => typeof f === 'string' && f)
    } catch {
      /* unreadable list: start over rather than refuse the enrolment */
    }
    const next = [...files.filter((f) => f !== settingsPath), settingsPath].slice(-SETTINGS_FILES_MAX)
    const body = `${JSON.stringify({ version: 1, tool, files: next }, null, 2)}\n`
    return body === raw ? null : body
  })
}

/** One `{ file, stateDir }` entry of the isolated index, or null when malformed. */
function isolatedEntry(e) {
  return e && typeof e === 'object' && typeof e.file === 'string' && e.file && typeof e.stateDir === 'string' && e.stateDir
    ? { file: e.file, stateDir: e.stateDir }
    : null
}

/** The isolated index in `dir` (raw, UNVALIDATED paths), or []. */
export function readIsolatedSettingsFiles(tool, dir) {
  const entries = readJsonObject(isolatedSettingsFilesPath(tool, dir))?.entries
  return Array.isArray(entries) ? entries.map(isolatedEntry).filter(Boolean) : []
}

/**
 * Add `settingsPath`, enrolled in `stateDir`, to the isolated index in `dir` (the
 * trusted default store). Paths only, never a credential. One entry per file,
 * newest last: a re-run with another state dir replaces the old pairing.
 */
export function recordIsolatedSettingsFile(tool, dir, settingsPath, stateDir) {
  return casWriteFile(isolatedSettingsFilesPath(tool, dir), (raw) => {
    let entries = []
    try {
      const parsed = raw === null ? null : JSON.parse(raw)
      if (Array.isArray(parsed?.entries)) entries = parsed.entries.map(isolatedEntry).filter(Boolean)
    } catch {
      /* unreadable index: start over rather than refuse the enrolment */
    }
    const next = [...entries.filter((e) => e.file !== settingsPath), { file: settingsPath, stateDir }].slice(
      -SETTINGS_FILES_MAX,
    )
    const body = `${JSON.stringify({ version: 1, tool, entries: next }, null, 2)}\n`
    return body === raw ? null : body
  })
}

/**
 * Read-modify-write with optimistic concurrency and bounded retry.
 *
 * `render(raw)` receives the CURRENT bytes (null when absent) and returns new
 * content, or null for "no change". It is called again on every retry, so a
 * retry can never write a value derived from bytes another writer replaced.
 *
 * NOT A LOCK, deliberately: `~/.claude` is a host bind-mount shared across
 * containers with separate PID namespaces, so a lockfile's "is the holder pid
 * alive?" recovery is meaningless here and a wedged lock would stop every
 * session on the host. A two-syscall window between the final check and the
 * rename remains; it is irreducible without a lock. Design doc, "Concurrency".
 */
export function casWriteFile(path, render, { mode = 0o600, attempts = 3 } = {}) {
  // ONLY an absent file is null. Any other read failure (EACCES, EIO) throws:
  // mapping it to null renders "fresh" over a file that is still there.
  const readNow = () => {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      throw err
    }
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = readNow()
    const next = render(raw)
    if (next == null) return { changed: false, reason: 'no-change' }
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, next, { encoding: 'utf8', mode })
      chmodSync(tmp, mode) // defeat umask
      if (readNow() !== raw) {
        // Someone else won. Drop our temp and re-derive from THEIR bytes.
        rmSync(tmp, { force: true })
        continue
      }
      renameSync(tmp, path)
      return { changed: true }
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best-effort */
      }
      throw err
    }
  }
  // Persistently contended. The callers here are all self-healing on the next
  // launch, so giving up is safer than looping until something wins.
  return { changed: false, reason: 'contended' }
}

/**
 * Write a complete v2 store for one lane, atomically, 0600.
 *
 * Temp names carry randomness, not only the PID: separate PID namespaces over
 * one shared bind-mount collide. `exclusive` creates via link (EEXIST) for
 * callers that only ever mean to create.
 */
export function writeDeviceStore(tool, fields, dir = trustedStateDir(), { exclusive = false } = {}) {
  // Validate BEFORE writing, with the same rule the helper refuses on: a writer
  // that skips this reports success while producing a permanently refused store.
  assertStoreConsistent(tool, { ...fields, version: 2, tool })
  const path = deviceStorePath(tool, dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  // Whole temp lifecycle inside the try: the temp holds the refresh token.
  try {
    // Managed envelope LAST, so a caller cannot override version/tool.
    writeFileSync(tmp, `${JSON.stringify({ ...fields, version: 2, tool }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(tmp, 0o600)
    if (exclusive) {
      // link fails with EEXIST: check and create in one operation.
      linkSync(tmp, path)
    } else {
      renameSync(tmp, path)
    }
  } finally {
    // Always: a no-op after a successful rename, a credential leak otherwise.
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort */
    }
  }
  return path
}

/*
 * SELF-HEAL: promote a legacy shared store into THIS lane's own v2 store, from
 * `trustedGlobalSettingsEnv()` only — never the ambient environment. Writes
 * `config.claude-code.json`; the legacy file is read-only from the split on.
 * Best-effort and idempotent. Design doc, "Migration".
 */
export function migrateStoredEndpoints(dir = trustedStateDir(), settingsEnv = null) {
  try {
    // Already split: this lane has its own complete store, nothing to repair.
    if (existsSync(deviceStorePath('claude-code', dir))) return false
    const global = settingsEnv ?? trustedGlobalSettingsEnv()
    const settingsBearer = (global.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
    const settingsToken = (global.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim()

    // A device with a complete enrolment in its own settings mints its store
    // from there; nothing new is trusted.
    const settingsRefresh = (global.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim()
    if (settingsRefresh && settingsBearer && settingsToken) {
      assertSafeEndpoint(settingsBearer, { allowLoopback: true })
      assertSafeEndpoint(settingsToken, { allowLoopback: true })
      // The BEARER names the instance. Settings attributes can be stale (the
      // design doc's Copilot-then-Claude state); preferring them here wrote a
      // store whose instance_id disagreed with its own bearer, which the helper
      // then refused — and no later migration retried, because the file existed.
      const id = bearerInstance(settingsBearer)
      if (!id) return false
      const attrs = `tokenscope.instance_id=${id},tool=claude-code`
      writeDeviceStore(
        'claude-code',
        {
          instance_id: id,
          bearer_endpoint: settingsBearer,
          oauth_token_endpoint: settingsToken,
          oauth_client_id: global.TOKENSCOPE_OAUTH_CLIENT_ID ?? '',
          logs_endpoint: global.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '',
          oauth_refresh_token: settingsRefresh,
          otel_resource_attributes: attrs,
        },
        dir,
        { exclusive: true },
      )
      return true
    }

    const legacy = readJsonObject(legacyStorePath(dir))
    if (!legacy) return false
    if (!legacy.oauth_refresh_token) return false // nothing stored to protect

    // Ownership by correlation against settings, never by the tool= marker
    // (design doc, Migration). A named endpoint must match; an unnamed one is
    // supplied from settings and is therefore ours.
    // The claim REQUIRES a non-empty legacy bearer that matches settings. A
    // token-only legacy file cannot be proven to be this lane's; promoting its
    // credential on the strength of settings' endpoint would pair a possibly
    // foreign token with our destination. Leave it unclaimed; re-enrol.
    const legacyBearer = (legacy.bearer_endpoint ?? '').trim()
    const a = bearerInstance(legacyBearer)
    if (!a || a !== bearerInstance(settingsBearer)) return false

    const bearerEndpoint = legacyBearer
    const tokenEndpoint = (legacy.oauth_token_endpoint ?? '').trim() || settingsToken
    if (!bearerEndpoint || !tokenEndpoint) return false
    assertSafeEndpoint(bearerEndpoint, { allowLoopback: true })
    assertSafeEndpoint(tokenEndpoint, { allowLoopback: true })

    // Ownership was just proved by matching the BEARER against settings, so the
    // bearer names the instance. Legacy attributes may be stale; never copy them.
    const instanceId = bearerInstance(bearerEndpoint)
    if (!instanceId) return false
    writeDeviceStore(
      'claude-code',
      {
        instance_id: instanceId,
        bearer_endpoint: bearerEndpoint,
        oauth_token_endpoint: tokenEndpoint,
        oauth_client_id: legacy.oauth_client_id ?? global.TOKENSCOPE_OAUTH_CLIENT_ID ?? '',
        logs_endpoint: legacy.logs_endpoint ?? global.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '',
        oauth_refresh_token: legacy.oauth_refresh_token,
        otel_resource_attributes: `tokenscope.instance_id=${instanceId},tool=claude-code`,
      },
      dir,
      { exclusive: true },
    )
    return true
  } catch {
    return false
  }
}

/** Read a settings.json's `env` block (or {} on any failure). */
export function readSettingsEnv(path) {
  const text = readRegularFileBounded(path, SETTINGS_MAX_BYTES)
  if (text === null) return {}
  try {
    const s = JSON.parse(text)
    return s && typeof s.env === 'object' && s.env ? s.env : {}
  } catch {
    return {}
  }
}

/** A settings file is a few KB; anything past this is not one. */
const SETTINGS_MAX_BYTES = 1024 * 1024

/**
 * `path`'s text if it is a REGULAR file of at most `maxBytes`, else null.
 * Repo-local settings are repo-controlled: a checkout can make the path a FIFO
 * (which blocks a plain read) or a symlink to /dev/zero (which never ends).
 * O_NONBLOCK makes the open itself return for a FIFO, and the type and size are
 * judged on the OPEN descriptor, so nothing can be swapped in between. A
 * symlink to a regular file is still followed: dotfile managers link
 * ~/.claude/settings.json on purpose.
 */
export function readRegularFileBounded(path, maxBytes) {
  let fd
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return null
    const buf = Buffer.alloc(st.size)
    const n = readSync(fd, buf, 0, st.size, 0)
    return buf.toString('utf8', 0, n)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The GLOBAL settings.json `env` block of this install's config folder
 * (claude-config-dir.mjs: a gated CLAUDE_CONFIG_DIR, else ~/.claude), resolved
 * the way CLAUDE CODE resolves it — through `homedir()`, which honours `HOME`.
 *
 * Correct for "what will Claude Code read?", and safe inside the SessionStart
 * hook, where `neutraliseRepoHome` has already replaced a repo-CLAIMED `HOME`
 * (and deliberately kept a legitimate one — a container, CI). It is NOT safe
 * anywhere that has not done that repair: see the trusted sibling below.
 */
export function globalSettingsEnv() {
  return readSettingsEnv(claudeSettingsPath({ home: homedir() }))
}

/**
 * The same block on the PASSWD home, immune to a moved `HOME`.
 *
 * For callers where this file DECIDES WHERE A CREDENTIAL GOES. `realHome`'s own
 * header draws the line: reading a file to learn what Claude Code will read
 * belongs on `homedir()`; choosing the host a secret is posted to does not.
 * Every plugin CLI is on the wrong side of that line, because
 * `neutraliseRepoHome` runs only inside the hook — so a repo that sets `HOME`
 * and commits its own `<repo>/fakehome/.claude/settings.json` was supplying the
 * "global" configuration for `statusline`, `landed-check` and `status`
 * (MDASH F313/F312/F116). The endpoint in that file receives the device's real
 * cached access token as a Bearer.
 *
 * Mirrors `stateDir()` / `trustedStateDir()` above — same split, same reason:
 * one honours the environment, one refuses to.
 */
export function trustedGlobalSettingsEnv() {
  return readSettingsEnv(claudeSettingsPath({ home: realHome() }))
}

/**
 * S1 fix (1) — the POSITIVE ALLOWLIST for a repo-local settings merge. Takes
 * `OTEL_RESOURCE_ATTRIBUTES` from the repo-local env and NOTHING else; every
 * other key comes from `globalEnv`. This replaces the `{...global, ...repo}`
 * shape that used to sit at five call sites in session-start.mjs: an
 * additive spread lets a repo committed into any cloned repository override
 * ANY single key — most dangerously the endpoint the credential is POSTed
 * to, while the credential itself still comes from the trusted global file.
 *
 * A DENY-list would miss `TOKENSCOPE_STATE_DIR`, which is credential-bearing:
 * `otel-headers-helper.sh` writes the freshly-minted emit ACCESS TOKEN into
 * it, so a repo-steered state dir drops a live token inside the attacker's
 * working tree with NO network call at all — an exfil path an endpoint
 * validator can never catch. An allowlist closes it structurally: nothing a
 * repo sets other than the resource attrs can ever reach the merged env.
 *
 * @param {Record<string,string>} globalEnv
 * @param {Record<string,string>} repoEnv
 * @returns {Record<string,string>}
 */
export function repoTagEnv(globalEnv, repoEnv) {
  const out = { ...(globalEnv && typeof globalEnv === 'object' ? globalEnv : {}) }
  const attrs =
    repoEnv && typeof repoEnv === 'object' ? repoEnv.OTEL_RESOURCE_ATTRIBUTES : undefined
  if (typeof attrs === 'string') out.OTEL_RESOURCE_ATTRIBUTES = attrs
  return out
}

/**
 * The `OTEL_RESOURCE_ATTRIBUTES` a script run from a Bash tool should emit
 * under. Claude Code starts those shells WITHOUT the `OTEL_*` settings env, so
 * the session's own value is not there to read.
 *
 * Device identity (`tokenscope.instance_id`, `tool`) comes from the trusted
 * global enrolment, the same device the bearer is minted for. The repo-local
 * `settings.local.json` is repo-controlled and contributes a well-formed
 * `project.code_hash` (sha256 hex, `computeCodeHash`), plus its instance only
 * when keptRepoTagEnrolment keeps it: the instance a live session in the repo
 * emits under, so a replay matches it.
 *
 * @param {string} cwd
 * @param {Record<string,string>} [globalEnv]
 * @param {string} [storeRoot]
 * @returns {string}
 */
export function launchResourceAttrs(cwd, globalEnv = trustedGlobalSettingsEnv(), storeRoot = trustedStateDir()) {
  const trusted =
    typeof globalEnv?.OTEL_RESOURCE_ATTRIBUTES === 'string' ? globalEnv.OTEL_RESOURCE_ATTRIBUTES : ''
  const repo = readSettingsEnv(join(cwd, '.claude', 'settings.local.json')).OTEL_RESOURCE_ATTRIBUTES
  // A repo with no attrs of its own inherits the global tag, as at launch.
  if (typeof repo !== 'string') return trusted
  const tag = /(?:^|,)project\.code_hash=([0-9a-f]{64})(?=,|$)/.exec(repo)?.[1]
  const own = attrsInstance(trusted)
  const kept = own ? keptRepoTagEnrolment(attrsInstance(repo), own, globalEnv?.TOKENSCOPE_BEARER_ENDPOINT, storeRoot) : null
  // #475: the folder's default activity, as the repo tag wrote it: encodeURIComponent
  // output, which leaves `. ! ~ * ' ( )` unescaped besides letters, digits, `-` and `_`.
  const activity = /(?:^|,)tokenscope\.activity=([A-Za-z0-9%_.!~*'()-]{1,200})(?=,|$)/.exec(repo)?.[1]
  const attrs = trusted
    .split(',')
    .filter((kv) => kv && !kv.startsWith('project.code_hash=') && !kv.startsWith('tokenscope.activity='))
    .map((kv) => (kept && kv.trim().startsWith('tokenscope.instance_id=') ? `tokenscope.instance_id=${kept.instanceId}` : kv))
  if (tag) attrs.push(`project.code_hash=${tag}`)
  if (activity) attrs.push(`tokenscope.activity=${activity}`)
  return attrs.join(',')
}

/**
 * S1 fix (2) — the safe env for scripts that read LIVE `process.env` directly
 * (status.mjs, backfill.mjs). Claude Code itself has already applied a
 * TAGGED repo's `settings.local.json` onto `process.env` by REPLACEMENT
 * before spawning this process (ADR-0006 §2), so `process.env` may be
 * entirely repo-controlled by the time these scripts run — `repoTagEnv`
 * above cannot help here, because there is no separate "repo env" object to
 * allowlist against; Claude has already merged the two.
 *
 * STRIP FIRST, THEN LAYER THE GLOBAL ON TOP. The earlier shape here was
 * `{...env, ...globalSettingsEnv()}` — the global wins for every key it
 * actually CONTAINS, which is only the enrolled-device case. On a device with
 * no `~/.claude/settings.json`, or one enrolled before a key existed, there is
 * nothing to "win" and the repo-supplied value survives the spread untouched.
 * That is precisely the un-enrolled or partially-enrolled developer — the
 * person most likely to be opening an unfamiliar repository — so the weakest
 * device got the weakest protection.
 *
 * CI proved it: with no global settings file, the hostile-repo fixture's
 * `TOKENSCOPE_BEARER_ENDPOINT` reached the assertion intact, while the same
 * test passed on an enrolled workstation. A control whose strength depends on
 * unrelated local state is not a control.
 *
 * Deleting first makes absence FAIL-SAFE instead of fail-open: a key the
 * global does not supply is simply absent, and every consumer already falls
 * back to its compiled default (`api-base.mjs`'s `DEFAULT_API_BASE`, the
 * helper's `$HOME/.tokenscope`). A repo can no longer contribute any of these
 * values whether or not the device is enrolled.
 *
 * `TOKENSCOPE_STATE_DIR` and `TOKENSCOPE_API_BASE` stay deleted UNCONDITIONALLY
 * — not restored from the global either — because `stateDir()` reads
 * `process.env` directly by design and the API base has a compiled default; a
 * genuine process-level override still reaches them by the documented path.
 *
 * @param {Record<string,string>} [env]
 * @returns {Record<string,string>}
 */
/**
 * Keys a repo-local `settings.local.json` must never contribute: each one
 * either steers a credential-presenting network call or names where a minted
 * credential is written. Restored from the GLOBAL file when it has them.
 */
export const REPO_UNTRUSTED_ENV_KEYS = Object.freeze([
  'TOKENSCOPE_BEARER_ENDPOINT',
  'TOKENSCOPE_OAUTH_TOKEN_ENDPOINT',
  'TOKENSCOPE_OAUTH_CLIENT_ID',
  'TOKENSCOPE_OAUTH_REFRESH_TOKEN',
  'TOKENSCOPE_READ_CLIENT_ID',
  'TOKENSCOPE_READ_REFRESH_TOKEN',
  'TOKENSCOPE_SESSION_TOKEN',
  'TOKENSCOPE_DCE_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
])

/** Deleted outright and never restored — see safeProcessEnv's doc. */
const REPO_UNTRUSTED_ENV_KEYS_NO_RESTORE = Object.freeze([
  'TOKENSCOPE_STATE_DIR',
  'TOKENSCOPE_API_BASE',
])

export function safeProcessEnv(env = process.env) {
  const out = { ...env }
  for (const k of REPO_UNTRUSTED_ENV_KEYS) delete out[k]
  for (const k of REPO_UNTRUSTED_ENV_KEYS_NO_RESTORE) delete out[k]
  // The device's OWN global config may legitimately supply the restorable keys.
  // TRUSTED read: this function's entire purpose is producing an env safe to
  // hand a child process, so it must not restore those keys from a settings
  // file a repo-moved HOME chose.
  const global = trustedGlobalSettingsEnv()
  for (const k of REPO_UNTRUSTED_ENV_KEYS) {
    if (typeof global[k] === 'string') out[k] = global[k]
  }
  return out
}

/**
 * Read the helper's emit-failure sentinel (or null).
 *
 * `dir` is explicit for the same reason `runEmitHelper` takes one: the sentinel
 * says whether emission is HEALTHY, so a caller that resolves its directory from
 * an environment a repository can steer lets that repository decide what the
 * health indicator reports. Callers holding a sanitised env (safeProcessEnv
 * drops TOKENSCOPE_STATE_DIR) or a dir they resolved themselves are already
 * safe; a caller reading ambient process.env must pass trustedStateDir().
 */
export function readEmitSentinel(env = process.env, dir = stateDir(env), tool = 'claude-code') {
  try {
    return JSON.parse(readFileSync(join(dir, emitSentinelName(tool)), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The helper's failure sentinel for one emit lane (`otel-headers-helper.sh`
 * SENTINEL). Per tool, like the store, so one lane's failure never reads as
 * another's.
 */
export function emitSentinelName(tool) {
  return `emit-failure.${tool}.json`
}

/**
 * The helper's "emitting on the cached Azure bearer" marker (#409): TokenScope
 * was unreachable on the helper's last run, so it handed back the bearer it had
 * cached and the credential was NOT verified. Written on every such run and
 * cleared by the next clean mint, so a marker present right after an exit-0 run
 * is fresh, never stale. Separate from the failure sentinel because emission
 * continues. Shape: { ts, reason, expires_at } (expires_at 0 = unknown).
 */
export function emitDegradedName(tool) {
  return `emit-degraded.${tool}.json`
}

/** Read the degraded marker (or null). Same directory rules as readEmitSentinel. */
export function readEmitDegraded(env = process.env, dir = stateDir(env), tool = 'claude-code') {
  try {
    return JSON.parse(readFileSync(join(dir, emitDegradedName(tool)), 'utf8'))
  } catch {
    return null
  }
}

/**
 * One phrase for the degraded marker's expiry, shared by every reader so the
 * status, the status line and the session-start notice never disagree.
 */
export function degradedExpiryNote(degraded, nowSec = Math.floor(Date.now() / 1000)) {
  const exp = Number(degraded && degraded.expires_at)
  if (!Number.isFinite(exp) || exp <= 0) return 'cached bearer expiry unknown'
  const iso = new Date(exp * 1000).toISOString()
  return exp <= nowSec
    ? `cached bearer EXPIRED at ${iso} — exports are probably being refused`
    : `cached bearer valid until ${iso}`
}

/**
 * Invoke the REAL emit path (otel-headers-helper.sh) and classify the result
 * WITHOUT surfacing the bearer it prints. Returns { ran, status, hasAuth }:
 *   - ran:     false if the helper binary is missing (nothing executed)
 *   - status:  the helper's exit code (0 = a bearer was minted)
 *   - hasAuth: stdout parsed to a JSON object carrying an Authorization header
 * The helper itself writes/clears the emit-failure sentinel as a side effect.
 *
 * THE STATE DIR TRAVELS AS AN ARGUMENT, not in `env`. The helper stopped reading
 * `TOKENSCOPE_STATE_DIR` because Claude Code invokes it directly with a
 * repo-merged environment (see the header of otel-headers-helper.sh and the
 * capture it cites), so passing it here is what keeps THIS invocation writing
 * its token cache where the caller resolved rather than wherever the ambient
 * environment says. Defaults to `stateDir()` — the same value the helper's own
 * passwd-home fallback would compute when nothing is pinned.
 *
 * `/bin/sh`, not `sh`: the interpreter is resolved by the OS from PATH when the
 * command is a bare name, and PATH is one of the variables a repository can set
 * (same capture). An absolute path is not steerable. On Windows the .ps1 runs
 * under an absolute powershell.exe for the same reason (emit-helper-spawn.mjs);
 * if none is found the helper is reported as not run (`ran: false`).
 *
 * THE DEFAULT IS `trustedStateDir()`, NOT `stateDir()`. `stateDir()` honours a
 * `TOKENSCOPE_STATE_DIR` process-level pin, which is right for a deployment or
 * test sandbox — but this function MINTS A CREDENTIAL, and on the Claude lane
 * that variable is repo-settable (the settings merge; see the capture doc). The
 * callers that legitimately pin — the SessionStart hook, which has established
 * provenance — pass `stateDir` explicitly. The callers that do NOT pass one
 * (`status.mjs`, and any added later) get the passwd home rather than silently
 * inheriting whatever the ambient environment says, which is the safe default
 * for a function whose side effect is writing a token cache.
 *
 * @param {{env?: Record<string,string>, timeoutMs?: number, stateDir?: string}} [opts]
 */
/*
 * `helperPath` is an explicit ARGUMENT, never an environment override. The tests
 * need to reach a stub helper, and before the confinement above they got there by
 * setting CLAUDE_PLUGIN_ROOT — i.e. the suite was exercising the very channel the
 * attacker uses, which is why the hole survived a test suite this size. A
 * function argument is safe for the same reason `--state-dir` is: anyone able to
 * pass one is already executing our code.
 */
/*
 * `platform` and `powershell` are arguments for the same reason: tests inject
 * win32 (and `pwsh` in place of powershell.exe) to drive the Windows branch on
 * Linux. On win32 the .ps1 runs under Windows PowerShell; see emit-helper-spawn.mjs.
 */
export function runEmitHelper({
  env = process.env,
  timeoutMs,
  stateDir: dir,
  helperPath,
  tool = 'claude-code',
  platform = process.platform,
  powershell,
} = {}) {
  const helper = helperPath ?? resolveHelperPath(platform)
  if (!existsSync(helper)) return { ran: false, status: null, hasAuth: false }
  const spawn = emitHelperSpawn({ helper, stateDir: dir ?? trustedStateDir(), tool, platform, env, powershell })
  if (!spawn) return { ran: false, status: null, hasAuth: false }
  const res = spawnSync(spawn.file, spawn.args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  let hasAuth = false
  try {
    hasAuth = Boolean(JSON.parse(res.stdout || '{}').Authorization)
  } catch {
    // Unparseable helper output → treat as no auth; `hasAuth` stays false.
  }
  return { ran: true, status: res.status, hasAuth }
}
