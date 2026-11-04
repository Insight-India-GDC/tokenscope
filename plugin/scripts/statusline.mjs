#!/usr/bin/env node
/*
 * statusline.mjs — the TokenScope Claude Code status-line segment.
 *
 * Renders one always-visible line answering the questions a developer has
 * mid-session:
 *   1. "Is my usage actually LANDING?" → the DELIVERY-CONFIRMATION signal, read
 *      from the last-landed cache that landed-check.mjs writes from the server's
 *      per-instance /health endpoint (`last_emission` = MAX ts of a record the
 *      server CONFIRMED landed + attributed; `last_bearer_at` = the client's last
 *      bearer mint, a proxy for recent emit ACTIVITY). This is the primary health
 *      driver: auth minting a bearer is NOT proof anything landed. When the client
 *      is actively emitting (recent bearer) but the landed watermark isn't keeping
 *      up = a DEAD EXPORT (accepted by the collector, never attributed) → reads
 *      clearly not-working, never a benign colour. Crucially we compare landing to
 *      the client's OWN emit activity, not wall-clock: an IDLE client's stale
 *      `last_emission` is expected and must NOT false-alarm red.
 *      (This is the bug this file exists to fix: a week of "auth fine, nothing
 *      landing" hid behind a cyan `◎ emit-auth` that read as healthy.)
 *   2. "Is my emit AUTH healthy?" → emission auth, read from the helper's
 *      emit-failure sentinel (the SAME signal /tokenscope:status uses). Cheap
 *      local file read.
 *   3. "Can I QUERY TokenScope (my_usage / tag_session)?" → MCP-auth state, read
 *      from Claude Code's own credential store (the macOS Keychain, else
 *      <config folder>/.credentials.json → `.mcpOAuth` has a key for the TokenScope MCP
 *      server). A file read; on macOS a cached answer, refreshed in the background.
 *   4. "Which dashboard row is THIS session?" → the session id Claude passes on
 *      stdin (TokenScope's "Conversation" id). Match the prefix.
 *
 * Health states (highest-priority first):
 *   TokenScope · not configured        — no device emit config (run tokenscope-setup, dim)
 *   TokenScope ✗ emit-auth failing     — the emit credential can't mint a bearer (red)
 *   TokenScope ✗ enrolment revoked     — /health says this enrolment was revoked (red)
 *   TokenScope ✗ not landing           — DEAD EXPORT: the client is actively emitting
 *                                        (recent bearer) but the landed watermark isn't
 *                                        keeping up → nothing is being attributed (red).
 *                                        Also covers an enrolment PAST the grace window
 *                                        that has never landed anything at all.
 *   TokenScope ⚠ landed · emit-only    — delivery CONFIRMED, but MCP not connected (yellow)
 *   TokenScope ✓ landed                — delivery CONFIRMED + MCP authed (green)
 *   TokenScope ⚠ emit-only             — landing UNCONFIRMED + MCP not connected (yellow)
 *   TokenScope ◎ emit-auth             — auth fine, MCP authed, delivery UNCONFIRMED
 *                                        (/health unreachable, idle+never-landed, or a
 *                                        still-in-grace fresh enrolment — neutral, cyan)
 *
 * The `◎ emit-auth` cyan is STRICTLY the "we couldn't confirm landing" fallback
 * (health unreachable / idle client that has never landed / a fresh enrolment still
 * inside NEVER_LANDED_GRACE_MS) — it does NOT cover "landing looks dead", and since
 * 2026-09-01 it no longer covers an ACTIVE enrolment that has never landed anything
 * long past setup: that was the hole a superseded instance pin hid in for 69 minutes.
 * When the client is actively emitting, the landing state is the primary colour
 * driver; an IDLE client never trips the red dead-export state.
 *
 * The trailing (Env) tag is DERIVED from the configured emit endpoint, never
 * hardcoded — see emitEnvLabel().
 *
 * FAIL-SILENT + FAST: a status-line command must never hang or crash the UI, so
 * every read is guarded and any error prints nothing. The render itself makes NO
 * network call — it reads the /health answer from the last-landed cache. It DOES
 * fire a throttled, DETACHED (unref'd) background refresh of that cache at most
 * once every POLL_INTERVAL_MS, so a long session's landing state stays current
 * without the render ever blocking on the network (see maybeSpawnLandedRefresh).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { spawn } from 'node:child_process'
import {
  MCP_AUTH_STAMP,
  mcpAuthRefreshDue,
  mcpAuthRefreshSpawn,
  probeMcpAuth,
  readMcpAuthCache,
  readMcpAuthStamp,
} from './claude-credentials.mjs'
import {
  attrsInstance,
  claudeInstallStateDir,
  keptRepoTagEnrolment,
  readEmitDegraded,
  readEmitSentinel,
  readSettingsEnv,
  trustedGlobalSettingsEnv,
  trustedStateDir,
} from './plugin-runtime.mjs'
import { resolveRepoRoot, resolveRepoProjectCode } from './tag-repo.mjs'
import { readFolderActivity } from './tokenscope-project.mjs'
import { readSessionActivity } from './session-activity.mjs'

const C = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
}

/**
 * How recently the client must have minted a /bearer to count as LIVE ENOUGH to
 * judge landing at all (the `now - last_bearer_at` active window). Claude Code
 * re-runs otel-headers-helper (a bearer mint) at startup and every ~29 min WHILE
 * a session is open, so a bearer within ~90 min means "a session was active
 * recently". Beyond it the client is IDLE — a stale `last_emission` is expected
 * and must never read red. 90 min = the ~29-min refresh cadence plus slack.
 */
export const DEAD_EXPORT_MS = 90 * 60 * 1000

/**
 * How far the landed watermark (`last_emission`) may trail an ACTIVELY-refreshing
 * client's emit activity before we call the export DEAD. This is deliberately much
 * larger than one ingestion window, because `last_bearer_at` is a CREDENTIAL-
 * refresh heartbeat (29-min timer), NOT an emission timestamp — so within a single
 * long session the bearer keeps ticking while `last_emission` legitimately lags by
 * hours during any read/think stretch with no token usage. A gap of *hours* is
 * normal within-session idle; only a gap of ~a DAY (watermark frozen while the
 * credential keeps refreshing) proves a dead export. We reuse the server's own
 * "went silent" horizon (SILENT_AFTER_HOURS = 24h) so the client verdict can't
 * contradict the server's. Sanity: a multi-day read-path outage → gap ≫ 24h →
 * dead; a 3h within-session idle (last emission this morning) → gap < 24h → landed.
 */
export const LANDED_LAG_MS = 24 * 60 * 60 * 1000

/**
 * How long after ENROLMENT a still-never-landed active client stays neutral.
 *
 * `last_emission: null` has two meanings and only `ts_start` separates them: a
 * fresh enrolment whose first record is still in flight (normal), or an enrolment
 * that has never landed anything (a fault). Before this window we say nothing;
 * after it, an ACTIVE client that has still never landed reads as not-landing.
 *
 * 2h is ~5x the observed worst case: a record takes ~5 min through Azure Monitor
 * ingest (measured 2026-09-01: enrolment 11:33:24 → first landed row 11:39:04)
 * plus up to one ~15-min azure-monitor-read cadence, so ~20-25 min end to end.
 * The margin absorbs a reader backlog without crying wolf during setup — the case
 * the neutral fallback exists to protect.
 *
 * IDLE clients are exempt entirely (see classifyLanding): with no emission there
 * is nothing to land, so age alone must never turn an idle device red.
 *
 * Measured `last_bearer_at − ts_start`, i.e. SERVER stamp minus SERVER stamp, so
 * a skewed client clock cannot manufacture a false red. Never `now − ts_start`.
 */
export const NEVER_LANDED_GRACE_MS = 2 * 60 * 60 * 1000

/**
 * Pure: classify the DELIVERY-CONFIRMATION (landing) state from a /health cache.
 * Tested directly, independent of the network. Inputs:
 *   - cache:  the parsed last-landed.json object, or null (no cache yet). Shape:
 *             { ok, instanceId, lastEmission, lastBearer, tsStart, silent, revoked,
 *             checkedAt }. `tsStart` (the enrolment's start) may be absent against
 *             an older server — then a never-landed client stays neutral as before.
 *             `ok:true` = /health was actually REACHED on the last refresh.
 *   - instanceId: the currently-configured instance id (to reject a stale cache
 *             left by a different enrolment sharing the home dir).
 *   - now:    Date.now() (injectable for tests).
 *
 * The verdict keys off the CLIENT's recent activity (`lastBearer` = its last
 * bearer mint, a session-liveness heartbeat), NOT the wall-clock age of
 * `lastEmission` — because `lastEmission` goes naturally stale on an IDLE client
 * (nobody's emitting). We only call an export DEAD when a session is live yet the
 * landed watermark has fallen far behind (see DEAD_EXPORT_MS / LANDED_LAG_MS for
 * why the two thresholds differ — bearer freshness ≠ emission freshness).
 *
 * Returns one of:
 *   'revoked' — the enrolment was revoked server-side (clear error).
 *   'revoked' handled above. Then, for a CLIENT ACTIVE (bearer within
 *   DEAD_EXPORT_MS):
 *   'dead'    — EITHER a PRIOR landing has since gone stale (bearer − emission >
 *               LANDED_LAG_MS) → landing was working and STOPPED; OR the client has
 *               NEVER landed and kept minting bearers well past enrolment
 *               (bearer − ts_start > NEVER_LANDED_GRACE_MS) → it has never worked
 *               at all. Both mean "emissions accepted, nothing attributed", which is
 *               the one thing this beacon exists to show. Both are SERVER-stamp
 *               differences, so neither can be manufactured by a skewed local clock.
 *   'landed'  — delivery confirmed: an active client whose watermark is keeping
 *               up, OR an idle client whose last emission DID land at some point.
 *   'unknown' — /health NOT reached (cache missing/never-ok/other-instance); an
 *               ACTIVE client that has never landed but is still INSIDE the
 *               enrolment grace (first record legitimately in flight) or whose
 *               `ts_start` is absent/unparseable; or ANY idle client that has never
 *               landed. We can neither confirm nor deny → NEUTRAL, never red.
 */
export function classifyLanding(cache, instanceId, now = Date.now()) {
  // No cache, or the last refresh never reached /health → nothing confirmed.
  if (!cache || typeof cache !== 'object' || cache.ok !== true) return 'unknown'
  // A cache left by a DIFFERENT enrolment (shared home dir) tells us nothing.
  if (instanceId && cache.instanceId && cache.instanceId !== instanceId) return 'unknown'
  if (cache.revoked === true) return 'revoked'

  const emission = parseTs(cache.lastEmission)
  const bearer = parseTs(cache.lastBearer)

  // CLIENT ACTIVE — minted a bearer within the active window, so a session is live
  // and we CAN judge landing. 'dead' requires a PRIOR landing that has since gone
  // stale (>LANDED_LAG_MS while the credential keeps refreshing = a real read-path
  // outage — the actual incident); an hours-long within-session idle stays 'landed'.
  // A client that has NEVER landed is judged by ENROLMENT AGE, not treated as
  // permanently unknowable: inside NEVER_LANDED_GRACE_MS it is a fresh enrolment
  // whose first record hasn't landed yet, so report the honest neutral 'unknown'
  // and never a false red while the user is verifying setup; beyond it, nothing has
  // EVER landed for this device and that is a fault worth showing. (Systemic
  // fleet-wide never-lands remain the SERVER read-path-health alert's job; this is
  // the per-device beacon for the device in front of you.)
  // SKEW blind spot (documented, fails SAFE): a client clock running >DEAD_EXPORT_MS
  // AHEAD of the server-stamped last_bearer_at makes `now - bearer` exceed the
  // window → misjudged IDLE → a real dead export can read green. This never yields
  // a false RED, so we accept it as a known limitation rather than trust the clock.
  if (bearer !== null && now - bearer <= DEAD_EXPORT_MS) {
    if (emission === null) {
      // NEVER landed. Age the ENROLMENT to tell "first record still in flight"
      // (normal, stay neutral) from "enrolled long ago, nothing has ever landed"
      // (a fault — the shape of the 2026-09-01 superseded-instance-pin incident,
      // where a whole session emitted against an instance the device no longer
      // claimed and this read benign cyan for 69 minutes). No `ts_start` (an
      // older server, or an unparseable stamp) → unchanged neutral behaviour.
      //
      // Measured BEARER-to-ENROLMENT, never `now`-to-enrolment: both stamps come
      // from the SERVER, so a skewed client clock cancels out. Using the local
      // `now` here would let a clock running AHEAD inflate the age, cross the
      // grace early and paint a false RED — the one outcome the skew note above
      // promises this function never produces. (It also reads as the truer
      // statement: the client was still minting bearers this long after
      // enrolling, and nothing had landed by then.) Same server-to-server shape
      // as the `bearer - emission` comparison below.
      const enrolled = parseTs(cache.tsStart)
      if (enrolled !== null && bearer - enrolled > NEVER_LANDED_GRACE_MS) return 'dead'
      return 'unknown'
    }
    if (bearer - emission > LANDED_LAG_MS) return 'dead'
    return 'landed'
  }

  // CLIENT IDLE — no recent bearer (or `lastBearer` absent from an old-format
  // cache: treat as idle, the safe default → never a false red). A stale
  // `lastEmission` is EXPECTED here, so never 'dead'. If their last emission ever
  // landed, that's a confirmed 'landed'; if nothing ever landed, we simply don't
  // know (idle + never-landed is indistinguishable from a fresh enrolment).
  return emission !== null ? 'landed' : 'unknown'
}

/**
 * Parse the server's `last_emission` / `last_bearer_at`. They arrive in TWO shapes
 * across the stack: ISO-8601 (`2026-06-22T08:14:03Z`) and the Postgres text cast
 * (`2026-06-30 21:38:58.933+00`, space-separated, no `T`, and a SHORT `+00`
 * offset). `Date.parse` rejects both the space form and the 2-digit `+00` offset
 * (→ NaN) across V8, so normalise: space→`T`, and a trailing `±HH` offset →
 * `±HH:00`.
 *
 * REFUSE to guess local time: a NAIVE timestamp (no `Z`, no `±HH:MM` offset) would
 * otherwise be parsed by Date.parse against the machine's LOCAL zone → a wrong
 * epoch (not null), skewing the staleness maths silently. The server always stamps
 * UTC today, so this is latent — but rather than trust that forever, an
 * offset-less string returns null (treated upstream as absent/never-landed, the
 * safe neutral). Returns epoch ms, or null when unparseable / naive / absent.
 */
function parseTs(v) {
  if (!v || typeof v !== 'string') return null
  let iso = v.includes('T') ? v : v.replace(' ', 'T')
  // A bare `±HH` offset (Postgres `+00`) is not valid ISO — pad it to `±HH:00`.
  iso = iso.replace(/([+-]\d{2})$/, '$1:00')
  // Reject a naive (zoneless) timestamp rather than let Date.parse assume local.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * Pure: render the line from resolved state. Tested directly.
 *   - configured: device has emit config (instance attrs present)
 *   - emitting:   configured AND no failure sentinel (i.e. the LAST /bearer mint
 *                 succeeded — emit AUTH is healthy). If this is false the credential
 *                 itself is broken (red `✗ emit-auth failing`) — the root problem,
 *                 so it outranks any landing signal.
 *   - landing:    the DELIVERY-CONFIRMATION state from classifyLanding():
 *                 'landed' (green ✓) | 'dead' (red ✗ not landing) |
 *                 'revoked' (red ✗ enrolment revoked) | 'unknown' (neutral fallback).
 *                 When /health is reachable (landed/dead/revoked) this is the PRIMARY
 *                 colour driver. When it's 'unknown' we fall back to the MCP-auth
 *                 split below — cyan `◎ emit-auth` for the unconfirmed-but-fine case
 *                 (NEVER green, so "unconfirmed" is visually distinct from "landed").
 *   - mcpAuthed:  the TokenScope MCP server is OAuth-authed in Claude's store.
 */
export function formatStatusLine({
  configured,
  emitting,
  mcpAuthed,
  landing = 'unknown',
  sessionId,
  envLabel = null,
  color = true,
  degraded = false,
  project = null,
  activity = null,
}) {
  const paint = (c, s) => (color ? `${c}${s}${C.reset}` : s)
  if (!configured) return paint(C.dim, 'TokenScope · not configured')
  const sid = sessionId ? ` ${paint(C.dim, `#${String(sessionId).slice(0, 8)}`)}` : ''
  const tag = envLabel ? ` ${paint(C.dim, `(${envLabel})`)}` : ''
  // #475: what the work is, after the health label (nothing when unset).
  const what = [project, activity]
    .filter((v) => typeof v === 'string' && v.trim())
    // eslint-disable-next-line no-control-regex -- a label is display text: drop control characters
    .map((v) => ` · ${v.replace(/[\u0000-\u001f\u007f]/g, '').trim()}`)
    .join('')
  const line = (c, label) => `${paint(c, `TokenScope ${label}`)}${what}${sid}${tag}`
  // 1. Auth itself broken — can't even mint a bearer. Root cause; outranks all.
  if (!emitting) return line(C.red, '✗ emit-auth failing')
  // 1b. Emitting on the CACHED bearer because TokenScope is unreachable (#409):
  //     nothing verified the credential, and /health is unreachable too, so
  //     landing below cannot be trusted either. Amber, before landing.
  if (degraded) return line(C.yellow, '⚠ emit-auth degraded')
  // 2-3. /health reachable: landing is the primary driver. A dead/revoked export
  //      is the WORST news and reads clearly not-working (red), regardless of MCP.
  if (landing === 'revoked') return line(C.red, '✗ enrolment revoked')
  if (landing === 'dead') return line(C.red, '✗ not landing')
  // 4. Delivery CONFIRMED. Green when you can also query it; yellow when MCP isn't
  //    connected yet (records land, but my_usage / tag_session aren't wired).
  if (landing === 'landed')
    return mcpAuthed ? line(C.green, '✓ landed') : line(C.yellow, '⚠ landed · emit-only')
  // 5. 'unknown' — /health unreachable: we can neither confirm nor deny landing.
  //    NEVER red (no false dead-export alarm). Cyan `◎ emit-auth` is the neutral
  //    "auth fine, delivery unconfirmed" fallback — visually distinct from green.
  if (!mcpAuthed) return line(C.yellow, '⚠ emit-only')
  return line(C.cyan, '◎ emit-auth')
}

/**
 * Environment label DERIVED from the live emit config — NEVER hardcoded. Reads
 * BOTH the OTLP logs endpoint (where OTel is sent) and the bearer endpoint (the
 * deployment origin) — they describe the SAME deployment. We classify from
 * whichever names the env, because the app/bearer host reliably carries
 * `tokenscope-<env>` (tokenscope.example.com, ep-tokenscope-sandbox-aue-…)
 * whereas the OTLP DCE host carries it for some envs (dev: dce-tokenscope-dev-…)
 * but NOT all (sandbox's DCE is dce-tokenscope-otlp-…). Unrecognised deployments
 * return their bare host, so the tag never guesses. Null when nothing configured.
 */
export function emitEnvLabel(env) {
  const hostOf = (u) => {
    try {
      return new URL((u || '').trim()).host.toLowerCase()
    } catch {
      return ''
    }
  }
  const bearer = hostOf(env?.TOKENSCOPE_BEARER_ENDPOINT)
  const otlp = hostOf(env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  if (!bearer && !otlp) return null
  // Match the bounded product token `tokenscope-<env>` in EITHER host. Both \b
  // anchors matter: the right rejects tokenscope-development, the left rejects
  // mytokenscope-dev. The space join keeps a token from spanning the two hosts.
  const m = `${bearer} ${otlp}`.match(/\btokenscope-(dev|sandbox|staging|production|prod)\b/)
  if (m) {
    const name = m[1] === 'production' ? 'prod' : m[1]
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  const isLocal = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(h)
  if (isLocal(bearer) || isLocal(otlp)) return 'Local'
  // Unrecognised deployment — prefer the app/bearer host (cleaner than the DCE).
  return bearer || otlp
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

/** Configured = the global device env carries our instance resource attr. */
function isConfigured(env) {
  const attrs = env?.OTEL_RESOURCE_ATTRIBUTES
  return typeof attrs === 'string' && attrs.includes('tokenscope.instance_id')
}

/**
 * MCP authed = Claude's credential store has an `.mcpOAuth` entry for the
 * TokenScope plugin MCP server (claude-credentials.mjs). Off macOS that store is
 * a file, so it is read directly. On macOS it is the Keychain, which costs a
 * process and can stall on a prompt: this render reads the cached answer and,
 * when it is stale, starts a throttled, detached refresh for the next render.
 * Fail-defensive → false.
 */
function isMcpAuthed() {
  if (process.platform !== 'darwin') return probeMcpAuth()
  const dir = trustedStateDir()
  const cache = readMcpAuthCache(dir)
  maybeSpawnMcpAuthRefresh(dir, cache)
  return cache?.authed === true
}

function maybeSpawnMcpAuthRefresh(dir, cache) {
  try {
    if (!mcpAuthRefreshDue(cache, readMcpAuthStamp(dir))) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, MCP_AUTH_STAMP), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600 })
    } catch {
      /* stamp is best-effort; a failed write just means the throttle can't engage */
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), 'claude-credentials.mjs')
    const { file, args, options } = mcpAuthRefreshSpawn(script)
    const child = spawn(file, args, options)
    child.on('error', () => {})
    child.unref()
  } catch {
    /* never let a refresh attempt break the render */
  }
}

/** The currently-configured instance id, from the emit resource attrs (or null). */
function instanceIdOf(env) {
  return (env?.OTEL_RESOURCE_ATTRIBUTES || '').match(/tokenscope\.instance_id=([^,]+)/)?.[1] || null
}

/**
 * Read the last-landed cache (`<state>/last-landed.claude-code.json`) — the parsed
 * object, or null on any failure. landed-check.mjs writes it from the server
 * /health response; the always-on statusline only READS it here (never a
 * synchronous network call). classifyLanding() turns it into the render state.
 *
 * Until the first refresh after an upgrade only the old shared name exists, so it
 * is read as a fallback (#453). It may hold the Copilot plugin's record; that is
 * safe because classifyLanding() rejects a cache naming another instance.
 */
export function readLandedCache(dir = claudeInstallStateDir()) {
  for (const name of ['last-landed.claude-code.json', 'last-landed.json']) {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      /* try the next name */
    }
  }
  return null
}

/**
 * The landing state of the instance a session in `cwd` emits under.
 *
 * The session's own resource attributes are not readable here: Claude Code
 * 2.1.300 starts the status-line command without the `OTEL_*` settings env
 * (other settings env keys do reach it). So the repo tag's CURRENT instance
 * stands in for the one the session froze at startup:
 *   - none, or this install's own: this install's cache.
 *   - another local install's, kept by keptRepoTagEnrolment: that install's
 *     cache, which this process does not refresh (`tagged`), so one older than
 *     NEVER_LANDED_GRACE_MS reads 'unknown'.
 *   - any other: 'unknown'. Session start replaces it, or refuses a git-tracked
 *     file, and either way the session may be emitting under it.
 * A tag session start rewrote after this session read it is not visible here;
 * session start warns about that case itself.
 */
export function sessionLanding(
  env,
  cwd = process.cwd(),
  { now = Date.now(), ownDir = claudeInstallStateDir(), storeRoot = trustedStateDir() } = {},
) {
  const own = instanceIdOf(env)
  const repoRoot = resolveRepoRoot(cwd)
  const tagInstance = repoRoot
    ? attrsInstance(readSettingsEnv(join(repoRoot, '.claude', 'settings.local.json')).OTEL_RESOURCE_ATTRIBUTES)
    : ''
  if (!tagInstance || tagInstance === own) {
    const cache = readLandedCache(ownDir)
    return { landing: classifyLanding(cache, own, now), cache, tagged: false }
  }
  const kept = keptRepoTagEnrolment(tagInstance, own, env?.TOKENSCOPE_BEARER_ENDPOINT, storeRoot)
  if (!kept) return { landing: 'unknown', cache: readLandedCache(ownDir), tagged: false }
  const cache = readLandedCache(kept.dir)
  const checked = parseTs(cache?.checkedAt)
  const fresh = checked !== null && now - checked <= NEVER_LANDED_GRACE_MS
  return { landing: fresh ? classifyLanding(cache, kept.instanceId, now) : 'unknown', cache, tagged: true }
}

/**
 * Throttle: refresh the /health cache at most once per POLL_INTERVAL_MS. The
 * status line renders on EVERY prompt, so we must NOT poll each render — we gate
 * on the cache's `checkedAt` PLUS a `landed-poll.stamp` file bumped on every
 * spawn attempt (so a slow/in-flight refresh, which hasn't rewritten checkedAt
 * yet, doesn't make us re-spawn on the next few renders). 5 min matches the OTLP
 * export batch cadence — polling faster can't surface a landing sooner.
 */
export const POLL_INTERVAL_MS = 5 * 60 * 1000

/** The last spawn-attempt timestamp from the poll stamp file (or null). */
function readPollStamp() {
  try {
    return JSON.parse(readFileSync(join(claudeInstallStateDir(), 'landed-poll.stamp'), 'utf8'))?.at ?? null
  } catch {
    return null
  }
}

/**
 * Pure (given `stampAt`): a refresh is due only when the cache is older than the
 * interval AND no recent spawn attempt is still in flight. Tested directly.
 */
export function landedRefreshDue(cache, now = Date.now(), stampAt = readPollStamp()) {
  const freshEnough = (ts) => {
    const t = ts ? Date.parse(ts) : NaN
    return Number.isFinite(t) && now - t < POLL_INTERVAL_MS
  }
  if (cache && freshEnough(cache.checkedAt)) return false // cache still fresh
  return !freshEnough(stampAt) // else: due, unless a recent attempt is in flight
}

/**
 * Fire a THROTTLED, DETACHED background refresh of the /health cache. Never blocks
 * the render: we spawn landed-check.mjs unref'd (its own ~4s network timeout lives
 * in that process) and return immediately, so the NEXT render reads a fresh answer.
 * The stamp is written BEFORE the spawn so rapid renders during the network window
 * don't each spawn a duplicate. All best-effort — any failure is swallowed.
 */
function maybeSpawnLandedRefresh(env, cache) {
  try {
    if (!landedRefreshDue(cache)) return
    /*
     * claudeInstallStateDir() for this lane's files, reads included. stateDir()
     * honours TOKENSCOPE_STATE_DIR, which a repository's settings env can set —
     * so a repo could choose where this stamp is written AND pre-seed the
     * delivery cache that landedRefreshDue() consults, making the status line
     * report healthy delivery while suppressing the refresh that would discover
     * otherwise. landed-check.mjs defaults to the same trusted directory, so
     * reader and writer stay on one store: this install's own
     * (claudeInstallStateDir), which no environment variable chooses.
     */
    const dir = claudeInstallStateDir()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'landed-poll.stamp'),
        `${JSON.stringify({ at: new Date().toISOString() })}\n`,
        {
          mode: 0o600,
        },
      )
    } catch {
      /* stamp is best-effort; a failed write just means the throttle can't engage */
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), 'landed-check.mjs')
    // landed-check reads OTEL_RESOURCE_ATTRIBUTES + TOKENSCOPE_BEARER_ENDPOINT from
    // its env, so pass the settings env merged over ours. It reads the emit access
    // token from this lane's oauth-access.claude-code.json cache — no secret is passed on argv.
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* never let a refresh attempt break the render */
  }
}

/**
 * #475: the project and activity this session's work is tagged with, as far as
 * this install knows: what /tokenscope:activity recorded for the session, else
 * the repo's `.tokenscope` code and the folder's default activity. Never throws.
 * Exported for tests.
 */
export function sessionWork(sessionId, cwd, stateDir = claudeInstallStateDir()) {
  const out = { project: null, activity: null }
  try {
    const set = sessionId ? readSessionActivity(sessionId, stateDir) : null
    let code = null
    try {
      code = resolveRepoProjectCode({ arg: '', cwd }).code
    } catch {
      /* untagged repo */
    }
    const root = resolveRepoRoot(cwd)
    out.project = set?.project ?? code ?? null
    out.activity = set?.activity ?? (root ? readFolderActivity(root) : null)
  } catch {
    /* never break the render */
  }
  return out
}

function main() {
  let out = ''
  try {
    const input = readStdinJson()
    // TRUSTED read (F313): this env supplies TOKENSCOPE_BEARER_ENDPOINT, and
    // maybeSpawnLandedRefresh below posts the real access token to it.
    const env = trustedGlobalSettingsEnv()
    const configured = isConfigured(env)
    let landing = 'unknown'
    if (configured) {
      const s = sessionLanding(env)
      landing = s.landing
      // Keep the /health cache fresh for the NEXT render — throttled + detached, so
      // this render never blocks on the network. Only when we have a live endpoint.
      if (!s.tagged && (env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()) maybeSpawnLandedRefresh(env, s.cache)
    }
    out = formatStatusLine({
      configured,
      // Emitting = configured AND no live failure sentinel (no sentinel = healthy).
      // claudeInstallStateDir(): this call used the ambient process.env, so a repo-set
      // TOKENSCOPE_STATE_DIR chose which directory was searched for the failure
      // sentinel — point it at an empty one and "no sentinel" reads as healthy
      // emission. Same forgery as the delivery cache above, on the other input.
      emitting: configured && !readEmitSentinel(process.env, claudeInstallStateDir()),
      // Degraded = the helper is handing back its CACHED bearer because TokenScope
      // is unreachable (#409). Same trusted directory, same forgery argument.
      degraded: configured && Boolean(readEmitDegraded(process.env, claudeInstallStateDir())),
      mcpAuthed: isMcpAuthed(),
      // Landing = the delivery-confirmation state derived from the cached /health.
      landing,
      sessionId: input.session_id ?? null,
      // Where this client emits OTel — derived from the configured endpoint.
      envLabel: configured ? emitEnvLabel(env) : null,
      ...sessionWork(input.session_id ?? null, process.cwd()),
    })
  } catch {
    // Never break the UI — `out` stays '' from the initializer.
  }
  process.stdout.write(out)
}

// Only run when invoked directly (not when imported by the unit test).
// isMainModule (the guard every runnable script here uses): a raw string compare
// silently mismatches when the path percent-encodes or crosses a symlink → main()
// never runs, status line blank, zero diagnostics.
if (isMainModule(import.meta.url)) {
  main()
}
