#!/usr/bin/env node

/*
 * /tokenscope:backfill — transcript-replay catch-up for a short emission hiccup
 * (ADR-0005 decision 4, slice 3).
 *
 * When OTLP emission silently dropped (the silent-12h-token disaster), the spend
 * is NOT lost: every Claude turn is recorded in the local transcripts at
 * ~/.claude/projects/<slug>/<session>.jsonl. Each assistant message carries
 * `message.usage` (input_tokens / output_tokens / cache_read_input_tokens /
 * cache_creation_input_tokens), `message.model`, a top-level ISO `timestamp`,
 * `requestId`, and `sessionId`. This script re-emits those turns over the NORMAL
 * OTLP path, stamped with their ORIGINAL timestamps, so the joiner picks them up
 * and DEDUPS (idempotent — re-running is safe). It is short-hiccup catch-up
 * bounded by the Azure DCR ingestion window (~24-48h), NOT weeks-replay.
 *
 * STRIDE guardrails (non-negotiable, ADR-0005 — "capped, non-reconciled
 * provenance class"):
 *   - RATE-CAP: a max records/run (--max-records, default 5000, hard ceiling
 *     50000) AND a max window (--max-window-hours, default 48). A window past
 *     the cap is clamped; records past the cap are dropped and reported.
 *   - LIVE AUTH: emission uses the SAME live /bearer credential the headers
 *     helper mints (we invoke otel-headers-helper.sh). A revoked/ended instance
 *     401s at /bearer (E2) → the helper fails → we cannot emit. Backfill cannot
 *     outlive revocation.
 *   - PROVENANCE: every re-emitted record carries `tokenscope.backfill=true` as
 *     a resource attribute. The joiner marks the resulting attribution_record as
 *     non-reconciled / advisory (tier-2, telemetry-only, metadata.backfill).
 *   - NEVER logs token material (the Azure ingest bearer, the session/refresh
 *     tokens). The summary reports counts only.
 *   - --dry-run reports what WOULD be emitted and never POSTs.
 *
 * Flags:
 *   --since   <iso | Nh | N>   window start (ISO 8601, or "12h" / "12" = hours ago). Default 24h ago.
 *   --until   <iso | Nh | N>   window end. Default now.
 *   --max-records <n>          cap on records emitted this run (default 5000, ceiling 50000).
 *   --max-window-hours <n>     cap on the window span in hours (default 48).
 *   --projects-dir <path>      explicit transcript dir for ONE project.
 *   --all-projects             sweep EVERY project/CW transcript on the host
 *                              (loud warning — mis-attributes other CWs on a
 *                              shared host). Default scope is THIS project only
 *                              (the cwd's ~/.claude/projects/<slug> dir).
 *   --dry-run                  parse + report, emit nothing.
 *   --json                     machine-readable summary only.
 *
 * Env (the enrolled settings env block; `OTEL_RESOURCE_ATTRIBUTES` is always
 * rebuilt from trusted state, see withLaunchResourceAttrs):
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT   the Azure DCR logs ingest URL (POST target).
 *   OTEL_RESOURCE_ATTRIBUTES           tokenscope.instance_id, project.code_hash, tool.
 *   TOKENSCOPE_BEARER_ENDPOINT + (OAuth or session) creds — consumed by the helper.
 *   CLAUDE_PLUGIN_ROOT                 where otel-headers-helper.sh lives (set by Claude).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { execFileSync } from 'node:child_process'
import { encodeExportLogsServiceRequest } from './otlp-logs.mjs'
import {
  launchResourceAttrs,
  safeProcessEnv,
  trustedStateDir,
  claudeInstallStateDir,
  resolveScriptsDir,
  realHome,
} from './plugin-runtime.mjs'
import { assertConfinedPath } from './argv-guard.mjs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
import { resolveRepoRoot } from './tag-repo.mjs'
import { emitHelperSpawn, helperScriptName } from './emit-helper-spawn.mjs'
import { claudeConfigDir } from './claude-config-dir.mjs'

// Re-export so existing callers (tests, file-forwarder) can import from here.
export { encodeExportLogsServiceRequest } from './otlp-logs.mjs'

const DEFAULT_SINCE_HOURS = 24
const DEFAULT_MAX_RECORDS = 5000
const HARD_MAX_RECORDS = 50000
const DEFAULT_MAX_WINDOW_HOURS = 48

// ── arg parsing ────────────────────────────────────────────────────────────
// The transcripts root, on the passwd home: argv here is composed by a model
// under a prefix grant, so --projects-dir may only narrow inside it, never name
// a planted directory of transcripts elsewhere (argv-guard.mjs).
const defaultProjectsRoot = () => join(claudeConfigDir({ home: realHome() }), 'projects')

export function parseArgs(argv, { projectsRoot = defaultProjectsRoot() } = {}) {
  const out = {
    since: null,
    until: null,
    maxRecords: DEFAULT_MAX_RECORDS,
    maxWindowHours: DEFAULT_MAX_WINDOW_HOURS,
    projectsDir: null,
    allProjects: false,
    cwd: null,
    dryRun: false,
    json: false,
    jsonEmit: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--since':
        out.since = next()
        break
      case '--until':
        out.until = next()
        break
      case '--max-records':
        out.maxRecords = Number(next())
        break
      case '--max-window-hours':
        out.maxWindowHours = Number(next())
        break
      case '--projects-dir':
        out.projectsDir = assertConfinedPath(next() ?? '', { flag: '--projects-dir', roots: [projectsRoot] })
        break
      // Opt-in to sweeping EVERY project/CW transcript on the host. Default is
      // THIS project only (derived from cwd) — a multi-CW host has many other
      // containers' transcripts under ~/.claude/projects, and sweeping them all
      // mis-attributes their sessions to this instance (untagged). Loud warning.
      case '--all-projects':
        out.allProjects = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--json':
        out.json = true
        break
      // Debug escape hatch: POST OTLP/JSON instead of protobuf. The Azure DCR
      // rejects JSON with HTTP 415 — this exists only to repro that 415 / probe a
      // collector that accepts JSON. Default (no flag) is protobuf.
      case '--json-emit':
        out.jsonEmit = true
        break
      default:
        // tolerate stray tokens (Claude may pass an empty $ARGUMENTS)
        if (a && a.startsWith('--')) throw new Error(`unknown flag: ${a}`)
    }
  }
  return out
}

/**
 * Resolve a window bound. Accepts ISO 8601, "<N>h"/"<N>" (= N hours ago), or
 * null (= use `fallback`). Returns a Date. `now` is the reference for hours-ago.
 */
export function resolveBound(value, fallback, now) {
  if (value == null || value === '') return fallback
  const s = String(value).trim()
  const hoursMatch = /^(\d+(?:\.\d+)?)h?$/i.exec(s)
  if (hoursMatch) {
    return new Date(now.getTime() - Number(hoursMatch[1]) * 60 * 60 * 1000)
  }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date/duration: '${value}'`)
  return d
}

/**
 * Compute the effective [since, until] window, applying the max-window cap.
 * Pure + exported for tests. Returns { since, until, windowClamped }.
 */
export function resolveWindow(opts, now = new Date()) {
  const until = resolveBound(opts.until, now, now)
  let since = resolveBound(
    opts.since,
    new Date(now.getTime() - DEFAULT_SINCE_HOURS * 60 * 60 * 1000),
    now,
  )
  if (since.getTime() > until.getTime()) {
    throw new Error('--since is after --until')
  }
  const maxWindowMs = Math.max(1, opts.maxWindowHours) * 60 * 60 * 1000
  let windowClamped = false
  if (until.getTime() - since.getTime() > maxWindowMs) {
    // Clamp the FAR end (oldest) — we keep the most recent maxWindow hours, the
    // part most likely still inside the Azure DCR ingestion window.
    since = new Date(until.getTime() - maxWindowMs)
    windowClamped = true
  }
  return { since, until, windowClamped }
}

// ── transcript parsing ─────────────────────────────────────────────────────
/**
 * Map a transcript assistant line to OTLP api_request usage records (one per
 * non-zero token type), or null if the line carries no usage. Pure + exported.
 *
 * The transcript's per-message usage field names differ from the OTLP event's:
 *   transcript usage.cache_read_input_tokens  → OTLP cache_read_tokens
 *   transcript usage.cache_creation_input_tokens → OTLP cache_creation_tokens
 * We carry the four counts under the OTLP attribute names the joiner reads.
 */
export function recordFromTranscriptLine(line) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || obj.type !== 'assistant') return null
  const msg = obj.message
  if (!msg || typeof msg !== 'object') return null
  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const ts = obj.timestamp
  if (typeof ts !== 'string') return null
  const tsDate = new Date(ts)
  if (Number.isNaN(tsDate.getTime())) return null

  const input = Number(usage.input_tokens ?? 0) || 0
  const output = Number(usage.output_tokens ?? 0) || 0
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0) || 0
  if (input + output + cacheRead + cacheCreation <= 0) return null

  return {
    ts: tsDate.toISOString(),
    tsMs: tsDate.getTime(),
    model: typeof msg.model === 'string' ? msg.model : 'unknown',
    requestId: typeof obj.requestId === 'string' ? obj.requestId : (msg.id ?? null),
    claudeSessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    // cost is advisory; newer transcripts omit it. Carried when present.
    costUsd: typeof obj.costUSD === 'number' ? obj.costUSD : null,
    tokens: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
    },
  }
}

/**
 * Claude Code stores transcripts under ~/.claude/projects/<slug>/<session>.jsonl,
 * where <slug> is the working directory with '/' and '.' folded to '-'
 * (/workspace → -workspace). Derive THIS cw's own project dir so the DEFAULT
 * backfill scope is the current project, not every container on a shared host.
 */
export function cwdProjectSlug(cwd) {
  // Match Claude Code's dir-naming: fold EVERY non-alphanumeric to '-' (not just
  // '/' and '.'), else a cwd with '_'/space/'@' derives a wrong slug → a
  // false-negative "no transcript dir" (R3 LOW).
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/** List the *.jsonl transcript files under projectsDir (recursive, one level of project dirs). */
export function listTranscriptFiles(projectsDir) {
  if (!existsSync(projectsDir)) return []
  const files = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    const full = join(projectsDir, entry.name)
    if (entry.isDirectory()) {
      // One unreadable project subdir (permission-denied on a shared host with
      // --all-projects) must skip, not abort the whole backfill run.
      let names
      try {
        names = readdirSync(full)
      } catch (err) {
        process.stderr.write(
          `[tokenscope] skipping unreadable transcript dir ${full}: ${err?.code ?? err}\n`,
        )
        continue
      }
      for (const f of names) {
        if (f.endsWith('.jsonl')) files.push(join(full, f))
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full)
    }
  }
  return files
}

/**
 * Scan transcripts for usage records inside [since, until]. Returns
 * { selected, found, capped, filesScanned }. `selected` is sorted ascending by
 * timestamp and truncated to `maxRecords`; `capped` is how many in-window
 * records were dropped by the cap. Pure over the filesystem (no network).
 */
export function collectRecords(files, since, until, maxRecords) {
  const sinceMs = since.getTime()
  const untilMs = until.getTime()
  const inWindow = []
  let filesScanned = 0
  for (const file of files) {
    let text
    try {
      // Skip obviously-untouched files to bound IO on large transcript stores:
      // a file last modified before the window starts can't contain in-window
      // events (transcripts are append-only). mtime is a cheap pre-filter.
      const st = statSync(file)
      if (st.mtimeMs < sinceMs) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    filesScanned++
    for (const line of text.split('\n')) {
      if (!line) continue
      const rec = recordFromTranscriptLine(line)
      if (!rec) continue
      if (rec.tsMs < sinceMs || rec.tsMs > untilMs) continue
      inWindow.push(rec)
    }
  }
  inWindow.sort((a, b) => a.tsMs - b.tsMs)
  const selected = inWindow.slice(0, maxRecords)
  return {
    selected,
    found: inWindow.length,
    capped: Math.max(0, inWindow.length - selected.length),
    filesScanned,
  }
}

// ── OTLP payload ───────────────────────────────────────────────────────────
/** Parse `OTEL_RESOURCE_ATTRIBUTES` (k=v,k=v) into a plain object. */
export function parseResourceAttrs(raw) {
  const out = {}
  if (typeof raw !== 'string') return out
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function kvList(attrs) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }))
}

/**
 * Build the OTLP/HTTP-JSON logs payload mirroring what Claude Code emits for an
 * api_request event. One log record per usage record. Resource attrs carry the
 * enrolment identity PLUS tokenscope.backfill=true (provenance). Pure + exported.
 *
 * Token attrs use the OTLP event field names the joiner/KQL reads
 * (input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens).
 */
export function buildOtlpLogsPayload(records, resourceAttrs) {
  const resource = { attributes: kvList({ ...resourceAttrs, 'tokenscope.backfill': 'true' }) }
  const logRecords = records.map((r) => {
    const nanos = String(BigInt(r.tsMs) * 1000000n)
    const attributes = [
      { key: 'event.name', value: { stringValue: 'api_request' } },
      { key: 'model', value: { stringValue: r.model } },
      { key: 'input_tokens', value: { intValue: String(r.tokens.input_tokens) } },
      { key: 'output_tokens', value: { intValue: String(r.tokens.output_tokens) } },
      { key: 'cache_read_tokens', value: { intValue: String(r.tokens.cache_read_tokens) } },
      { key: 'cache_creation_tokens', value: { intValue: String(r.tokens.cache_creation_tokens) } },
    ]
    if (r.requestId) attributes.push({ key: 'request_id', value: { stringValue: r.requestId } })
    if (r.claudeSessionId)
      attributes.push({ key: 'session.id', value: { stringValue: r.claudeSessionId } })
    if (r.costUsd != null) attributes.push({ key: 'cost_usd', value: { doubleValue: r.costUsd } })
    return {
      timeUnixNano: nanos,
      observedTimeUnixNano: nanos,
      severityNumber: 9, // INFO
      severityText: 'INFO',
      body: { stringValue: 'api_request' },
      attributes,
    }
  })
  return {
    resourceLogs: [
      {
        resource,
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords }],
      },
    ],
  }
}

// ── OTLP/protobuf wire encoder ──────────────────────────────────────────────
// Extracted to plugin/scripts/otlp-logs.mjs (shared with the Copilot forwarder).
// encodeExportLogsServiceRequest is re-exported from there at the top of this file.

// ── bearer (live /bearer via the helper) ───────────────────────────────────
/**
 * Mint the Azure ingest bearer the SAME way otel-headers-helper.sh does, by
 * invoking it. The helper prints `{"Authorization":"Bearer <token>"}` to stdout
 * on success (exit 0) and fails loud on a non-200 /bearer (revoked instance →
 * E2 401 → helper exits non-zero → we throw). The token is NEVER logged.
 *
 * S1 fix 2: `env` is passed EXPLICITLY (the caller's safeProcessEnv()) rather
 * than letting execFileSync inherit raw `process.env` — a repo-tagged
 * session's process.env may carry a repo-supplied TOKENSCOPE_BEARER_ENDPOINT
 * / _STATE_DIR / _API_BASE, and the safe env is what closes that.
 */
function mintBearer(pluginRoot, env, stateDirOverride = undefined, toolDirOverride = undefined) {
  const helper = join(pluginRoot, 'scripts', helperScriptName(process.platform))
  if (!existsSync(helper)) {
    throw new Error(`${helperScriptName(process.platform)} not found at ${helper} (is CLAUDE_PLUGIN_ROOT set?)`)
  }
  // A test must never drive the real state dir (same guard as
  // writeSharedCredentialStore). Covers in-process imports only; callers pass a
  // sandbox dir, this is the net beneath that.
  const underVitest =
    typeof globalThis.__vitest_worker__ === 'object' && globalThis.__vitest_worker__ !== null
  const stateDir = stateDirOverride ?? claudeInstallStateDir()
  if (underVitest && (stateDir === trustedStateDir() || stateDir.startsWith(trustedStateDir() + sep))) {
    throw new Error(
      'refusing to run the emit helper against the REAL state dir from a test — pass an explicit stateDir',
    )
  }
  // State dir as an ARGUMENT and the interpreter absolute (`/bin/sh`, or
  // powershell.exe on Windows) — the helper no longer reads
  // TOKENSCOPE_STATE_DIR, and a bare name would be resolved through a PATH a
  // repository can set. See emit-helper-spawn.mjs.
  const spawn = emitHelperSpawn({ helper, stateDir, tool: 'claude-code', env })
  if (!spawn) throw new Error('Windows PowerShell (powershell.exe) not found — cannot run the headers helper')
  // --tool-dir is trusted by the same argument as --state-dir; tests use it
  // to stub the passwd lookup. The .sh's seam only: the .ps1 refuses it.
  if (toolDirOverride && process.platform !== 'win32') spawn.args.push('--tool-dir', toolDirOverride)
  let stdout
  try {
    stdout = execFileSync(spawn.file, spawn.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env,
      windowsHide: true,
    })
  } catch {
    // The helper already printed a loud, sanitised reason to stderr.
    throw new Error(
      'emission auth failed — /bearer did not return a token (instance may be revoked/expired). Run /tokenscope:status.',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('headers helper returned an unparseable bearer payload')
  }
  const auth = parsed && parsed.Authorization
  if (typeof auth !== 'string' || !auth)
    throw new Error('headers helper returned no Authorization header')
  return auth
}

// ── main ───────────────────────────────────────────────────────────────────
async function run(opts, env, now = new Date()) {
  // `opts.stateDir` exists so a test can sandbox the emit helper: mintBearer
  // otherwise resolves claudeInstallStateDir(), which TOKENSCOPE_STATE_DIR cannot
  // redirect by design.
  if (!Number.isFinite(opts.maxRecords) || opts.maxRecords <= 0) {
    throw new Error('--max-records must be a positive number')
  }
  const maxRecords = Math.min(Math.floor(opts.maxRecords), HARD_MAX_RECORDS)
  const maxRecordsClamped = Math.floor(opts.maxRecords) > HARD_MAX_RECORDS
  if (!Number.isFinite(opts.maxWindowHours) || opts.maxWindowHours <= 0) {
    throw new Error('--max-window-hours must be a positive number')
  }

  const { since, until, windowClamped } = resolveWindow(opts, now)

  // SCOPE GUARD (dogfood-found): default to THIS cw's own project dir, NOT the
  // host-wide root. A shared host has many CWs' transcripts under
  // ~/.claude/projects; sweeping them all re-emits other containers' sessions
  // under this instance (untagged). Explicit --projects-dir or --all-projects
  // (loud) to widen; never silently sweep the host.
  const projectsRoot = join(claudeConfigDir({ home: homedir() }), 'projects')
  let projectsDir, scope
  if (opts.projectsDir) {
    projectsDir = opts.projectsDir
    scope = `explicit:${projectsDir}`
  } else if (opts.allProjects) {
    projectsDir = projectsRoot
    scope = 'ALL-PROJECTS'
    process.stderr.write(
      "WARNING: --all-projects backfills EVERY project/CW transcript on this host under THIS instance. On a multi-CW host that mis-attributes other containers' sessions (untagged). Prefer the default (this project only) or --projects-dir.\n",
    )
  } else {
    const cwd = opts.cwd || process.cwd()
    projectsDir = join(projectsRoot, cwdProjectSlug(cwd))
    scope = `this-project:${cwd}`
    if (!existsSync(projectsDir)) {
      throw new Error(
        `No transcript dir for the current project (${projectsDir}). Pass --projects-dir <dir> for a specific project, or --all-projects to sweep every CW on this host (not recommended on a shared host).`,
      )
    }
  }
  const files = listTranscriptFiles(projectsDir)
  const { selected, found, capped, filesScanned } = collectRecords(files, since, until, maxRecords)

  const resourceAttrs = parseResourceAttrs(env.OTEL_RESOURCE_ATTRIBUTES)
  const instanceId = resourceAttrs['tokenscope.instance_id'] ?? null

  const summary = {
    ok: true,
    dry_run: Boolean(opts.dryRun),
    window: { since: since.toISOString(), until: until.toISOString(), clamped: windowClamped },
    scope,
    instance_id: instanceId,
    project_tagged: Boolean(resourceAttrs['project.code_hash']),
    files_scanned: filesScanned,
    records_found: found,
    records_selected: selected.length,
    records_capped: capped,
    max_records: maxRecords,
    max_records_clamped: maxRecordsClamped,
    records_emitted: 0,
    provenance: 'tokenscope.backfill=true (non-reconciled / advisory: tier-2, telemetry-only)',
  }

  if (selected.length === 0) {
    summary.note = 'No api_request usage records in the window — nothing to backfill.'
    return summary
  }
  if (opts.dryRun) {
    summary.note = 'Dry run — nothing emitted. Re-run without --dry-run to backfill.'
    return summary
  }

  // Real emit requires the ingest endpoint + the live bearer (auth gate).
  const endpoint = (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '').trim()
  if (!endpoint) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT not set — provision emit via the tokenscope-setup MCP prompt and bind the repo via the project MCP prompt first.',
    )
  }
  // S1 fix 3: validate BEFORE the first POST. Loopback is allowed (a local
  // ingest stub in development).
  try {
    assertSafeEndpoint(endpoint, { allowLoopback: true })
  } catch (err) {
    // Redact: this throw is caught by the top-level handler below, which prints
    // `err.message` into the JSON summary on stdout. The endpoint comes from
    // OTEL_EXPORTER_OTLP_ENDPOINT, so it is not necessarily a value the reader
    // supplied. Reason code only.
    throw unsafeEndpointError('OTLP endpoint', err)
  }
  if (!instanceId) {
    throw new Error('tokenscope.instance_id missing from OTEL_RESOURCE_ATTRIBUTES — not enrolled.')
  }
  // CONFINED (MDASH follow-up): mintBearer executes the helper at this path with
  // /bin/sh while trusted emit credentials sit in `env`. Reading the raw variable
  // here let a repo choose that binary, independently of tag-repo's confinement.
  const pluginRoot = dirname(resolveScriptsDir())
  const authorization = mintBearer(pluginRoot, env, opts.stateDir, opts.toolDir) // throws (loud) if the instance is revoked/expired

  // Default transport: OTLP/protobuf (application/x-protobuf). The Azure DCR
  // rejects OTLP/JSON with HTTP 415 (verified live) — protobuf is the only
  // accepted encoding on the Claude ingest path. --json-emit is a debug escape
  // hatch that re-posts JSON (to repro the 415 / hit a JSON-accepting collector).
  const encoding = opts.jsonEmit ? 'otlp/json' : 'otlp/protobuf'
  summary.encoding = encoding

  // BATCH under Azure's hard 1 MB per-POST limit (HTTP 413 ContentLengthLimit).
  // ~300 bytes/record observed; 500/batch (~150 KB) is comfortably safe even
  // with several-x record-size variance. Bearer is minted once + reused across
  // batches (valid ~29 min). Stop LOUD on the first failed batch and report the
  // partial count (idempotent — re-running resumes; the joiner dedups).
  const BATCH = 500
  let emitted = 0
  for (let i = 0; i < selected.length; i += BATCH) {
    const slice = selected.slice(i, i + BATCH)
    const payload = buildOtlpLogsPayload(slice, resourceAttrs)
    const body = opts.jsonEmit ? JSON.stringify(payload) : encodeExportLogsServiceRequest(payload)
    const contentType = opts.jsonEmit ? 'application/json' : 'application/x-protobuf'
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': contentType, authorization },
      body, // Buffer/string → fetch sets explicit Content-Length (avoids MissingContentLengthHeader)
      // A black-holed endpoint must fail this batch loud, not hang the whole
      // backfill forever (the batch is retried on re-run; the joiner dedups).
      signal: AbortSignal.timeout(30_000),
      // Never follow: the scheme guard checked only this URL (curl/PowerShell lanes agree).
      redirect: 'error',
    })
    if (res.status >= 200 && res.status < 300) {
      emitted += slice.length
      continue
    }
    // Batch failed — report partial + the reason (never echo auth).
    const bodyText = await res.text().catch(() => '')
    summary.ok = false
    summary.http_status = res.status
    summary.records_emitted = emitted
    summary.error =
      res.status === 415
        ? `Ingest endpoint rejected ${encoding} (HTTP 415) — the Azure DCR accepts OTLP protobuf only.${opts.jsonEmit ? ' Drop --json-emit to send protobuf.' : ''} Emitted ${emitted}/${selected.length} before this batch.`
        : `Ingest POST failed (HTTP ${res.status}) on batch at offset ${i}. ${bodyText.slice(0, 200)} Emitted ${emitted}/${selected.length}.`
    return summary
  }

  summary.records_emitted = emitted
  summary.http_status = 204
  summary.note = `Re-emitted ${emitted} record(s) over OTLP (${encoding}) in ${Math.ceil(selected.length / BATCH)} batch(es). The joiner dedups, so this is idempotent. Backfilled spend is marked non-reconciled (advisory). Allow ~4-5 min for ingestion.`
  return summary
}

/**
 * `env` with `OTEL_RESOURCE_ATTRIBUTES` ALWAYS rebuilt by `launchResourceAttrs`
 * for the repository containing `cwd`: the instance a live session there emits
 * under (keptRepoTagEnrolment) and the project tag from the repo root's
 * settings.local.json. An
 * inherited value is discarded, because a repo-tagged session's process.env
 * is repo-merged (see safeProcessEnv), and a Bash-tool shell has none at all.
 */
export function withLaunchResourceAttrs(env, cwd, resolve = launchResourceAttrs) {
  return { ...env, OTEL_RESOURCE_ATTRIBUTES: resolve(resolveRepoRoot(cwd) ?? cwd) }
}

// CLI entry (guarded so tests can import the pure helpers without running).
const isMain = isMainModule(import.meta.url)
if (isMain) {
  ;(async () => {
    try {
      const opts = parseArgs(process.argv.slice(2))
      // S1 fix 2: the safe env, not raw process.env — see mintBearer's doc.
      const env = withLaunchResourceAttrs(safeProcessEnv(), opts.cwd || process.cwd())
      const summary = await run(opts, env)
      if (opts.json) {
        console.log(JSON.stringify(summary))
      } else {
        console.log(JSON.stringify(summary, null, 2))
      }
      process.exit(summary.ok ? 0 : 1)
    } catch (err) {
      console.log(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      process.exit(1)
    }
  })()
}

export { run }
