// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/copilot-usage.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * copilot-usage.mjs — the usage-extension core: maps the Copilot runtime's typed
 * session events to the SAME `api_request` / `usage_signal` OTLP-log records the file
 * forwarder produces, spools them under the credential dir, and posts them through
 * copilot-emit.mjs. No env vars, no span file, no daemon.
 * Design + parity evidence: docs/design/copilot-usage-extension.md.
 */
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  KV,
  safeNonNegNumber,
  resolveTimeUnixNano,
  buildCopilotOtlpPayload,
  encodeExportLogsServiceRequest,
} from './otlp-logs.mjs'
import {
  TOKENSCOPE_DIR,
  legacyForwarderActive,
  isProvisioned,
  loadConfig,
  mintBearer,
  httpsPost,
  postWithRetry,
  resolveGithubOrg,
  resolveProjectCodeHash,
} from './copilot-emit.mjs'
import { findFolderActivity } from './tokenscope-project.mjs'
import { recordLastSession } from './copilot-session.mjs'

export const EMITTER = 'extension'
export const SPOOL_DIRNAME = 'copilot-usage-spool'
const SHADOW_DIRNAME = 'copilot-usage-shadow'
const BATCH_MAX = 200
const SPOOL_MAX_AGE_MS = 7 * 24 * 3600 * 1000
// One file per session: concurrent sessions each own their verdict.
const DRIFT_DIRNAME = 'copilot-usage-drift'
const DRIFT_MAX_AGE_MS = SPOOL_MAX_AGE_MS
// Verdicts that record a known loss; only a cost comparison's verdict is ever cleared.
const STICKY_DRIFT = new Set(['contract', 'persist', 'poison'])
// A live writer touches its heartbeat this often; one silent for STALE is dead. The
// same 2.5-missed-beats threshold as the forwarder's singleton (copilot-forwarder.mjs).
export const HEARTBEAT_MS = 30_000
export const WRITER_STALE_MS = Math.max(2.5 * HEARTBEAT_MS, 150_000)
// One id per process, random, not the pid: ~/.tokenscope is shared by the host and
// its containers, whose pid namespaces differ, so a pid neither proves a writer is
// dead (kill(pid, 0) cannot see across namespaces) nor that a file is ours (two
// namespaces reuse the same small pids).
export const WRITER_ID = `w${randomBytes(6).toString('hex')}`
// Reader bound (server/azure/reader.ts): ^[A-Za-z0-9][A-Za-z0-9_-]*$, ≤128.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const hashId = (prefix, ...parts) =>
  prefix + createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)

/** The provider call id (`apiCallId` is base64 and can exceed 128 chars) → a reader-safe, stable id. */
export function usageRequestId(data, eventId) {
  const raw = data?.apiCallId || data?.providerCallId || data?.serviceRequestId || eventId
  return raw ? hashId('cu', String(raw)) : null
}

/**
 * Lane: conversation turns (main agent AND subagents — Claude's classifier also puts
 * subagents in the conversation) are 'main'; anything else (compaction, …) is its
 * own aux token. Deliberately NOT the forwarder's initiator rule, which files every
 * tool-loop continuation as aux (design §query_source).
 */
export function querySourceFor(data) {
  const t = typeof data?.interactionType === 'string' ? data.interactionType : ''
  if (t === '' || t === 'conversation-agent' || t === 'conversation-subagent') return 'main'
  return t.replace(/^conversation-/, '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'auto'
}

/** Event time → a fixed64-safe unix-nano string (the transcoder's own guard; now if unusable). */
export function isoToUnixNano(iso) {
  return resolveTimeUnixNano(typeof iso === 'string' ? iso : null)
}

/**
 * A count → an int64 string `BigInt()` accepts, or null when the value is present
 * but not a non-negative safe integer (garbage, negative, fractional — never rounded
 * into a different total — or so large that `String()` writes it as `1e+30`).
 * Absent is 0: every token field is optional.
 * The mapper writes 0 for a null (the rest of the call is still worth recording)
 * and the emitter reports it as contract drift (invalidUsageCounts).
 */
export function countInt(v) {
  if (v == null) return '0'
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? String(n) : null
}

/**
 * Whether an entry encodes. The mapper only produces encodable records; the send
 * path drops any spooled entry that does not (an older build's, or damaged on disk),
 * which would otherwise be retried forever and block every record in its batch.
 */
export function encodable(entry, surface = 'cli') {
  try {
    // Through the real batch builder, so resource attributes (hash, org, surface) are checked too.
    for (const b of buildBatches([entry], 'encodable-check', { surface })) encodeExportLogsServiceRequest(b.payload)
    return true
  } catch {
    return false
  }
}

function record(eventName, timeUnixNano, attributes) {
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: eventName },
    attributes: [KV('event.name', eventName), ...attributes],
  }
}

const USAGE_COUNT_FIELDS = ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']

/** The token fields of an `assistant.usage` present but not encodable as a count. */
export function invalidUsageCounts(data) {
  return USAGE_COUNT_FIELDS.filter((k) => countInt(data?.[k]) == null)
}

/** One `assistant.usage` event → one `api_request` record (null if unusable). */
export function mapUsageEvent(event, sessionId) {
  if (event?.type !== 'assistant.usage' || !SAFE_ID.test(String(sessionId ?? ''))) return null
  const d = event.data ?? {}
  if (safeNonNegNumber(d.inputTokens) == null && safeNonNegNumber(d.outputTokens) == null) return null
  const requestId = usageRequestId(d, event.id)
  if (!requestId) return null
  const [input, output, cacheWrite, cacheRead] = USAGE_COUNT_FIELDS.map((k) => countInt(d[k]) ?? '0')
  const attrs = [
    KV('request_id', requestId),
    KV('model', String(d.model || 'unknown').slice(0, 128)),
    KV('session.id', sessionId),
    KV('input_tokens', input, 'intValue'),
    KV('output_tokens', output, 'intValue'),
    KV('cache_creation_tokens', cacheWrite, 'intValue'),
    KV('cache_read_tokens', cacheRead, 'intValue'),
    KV('query_source', querySourceFor(d)),
  ]
  const nanoAiu = safeNonNegNumber(d.copilotUsage?.totalNanoAiu)
  if (nanoAiu != null) attrs.push(KV('github.copilot.nano_aiu', String(nanoAiu), 'doubleValue'))
  return record('api_request', isoToUnixNano(event.timestamp), attrs)
}

export function signalRecord(requestId, sessionId, timeUnixNano, signals) {
  const sig = Object.entries(signals)
    .filter(([, v]) => v != null && countInt(v) != null)
    .map(([k, v]) => KV(`sig.${k}`, countInt(v), 'intValue'))
  if (!sig.length || !SAFE_ID.test(String(sessionId ?? ''))) return null
  return record('usage_signal', timeUnixNano, [
    KV('request_id', requestId),
    KV('session.id', sessionId),
    ...sig,
  ])
}

/** Context saturation % from the latest `session.usage_info`, capped at 100. */
export function ctxPct(info) {
  const used = safeNonNegNumber(info?.currentTokens)
  const limit = safeNonNegNumber(info?.tokenLimit)
  return used != null && limit ? Math.min(100, Math.round((used / limit) * 100)) : null
}

/**
 * The forwarder owns a session started with the legacy exporter env: the extension
 * then only records what it WOULD send. (The forwarder, which cannot see the variable,
 * acts on the span file Copilot writes for exactly those sessions.)
 */
export function emitMode(env = process.env) {
  return legacyForwarderActive(env) ? 'shadow' : 'send'
}

export function surfaceOf(env = process.env) {
  return env.AI_AGENT === 'github_copilot_app_agent' ? 'app' : 'cli'
}

const heartbeatPath = (dir, writerId) => join(dir, `.hb-${writerId}`)

/** Mark this process's spool writer live (best-effort; a failure only risks an early adoption, which dedups). */
export function touchHeartbeat(dir, writerId = WRITER_ID) {
  try {
    ensureDir(dir)
    fs.writeFileSync(heartbeatPath(dir, writerId), '', { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

/**
 * Is the writer of `file` (token = the writer id, or a legacy numeric pid) still
 * appending? Writer ids answer from their heartbeat; legacy pid-named files, which
 * have none, from their own last write.
 */
function writerLive(dir, token, fileMtimeMs, now) {
  if (/^\d+$/.test(token)) return now - fileMtimeMs < WRITER_STALE_MS
  try {
    return now - fs.statSync(heartbeatPath(dir, token)).mtimeMs < WRITER_STALE_MS
  } catch {
    return false
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * A read error THROWS, so the caller keeps the file: an empty result would be retained
 * as "all delivered" and deleted. An unparseable line (a torn final append, or damage)
 * can never be sent: it is dropped and COUNTED, so the caller reports the loss.
 */
function readLines(path) {
  const entries = []
  let dropped = 0
  for (const l of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!l) continue
    try {
      entries.push(JSON.parse(l))
    } catch {
      dropped += 1
    }
  }
  return { entries, dropped }
}

/**
 * The device's unresolved drift, across sessions: the latest verdict plus how many
 * sessions have one, or null. Verdicts older than the spool bound are ignored (the
 * session that wrote them is long gone and can no longer clear them).
 */
export function readUsageDrift(stateDir = TOKENSCOPE_DIR, now = Date.now()) {
  const dir = join(stateDir, DRIFT_DIRNAME)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let latest = null
  let sessions = 0
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const d = JSON.parse(fs.readFileSync(join(dir, n), 'utf8'))
      const t = Date.parse(d?.ts)
      if (!Number.isFinite(t) || now - t > DRIFT_MAX_AGE_MS) continue
      sessions += 1
      if (!latest || t > Date.parse(latest.ts)) latest = d
    } catch {
      /* cleared or torn mid-read */
    }
  }
  return latest ? { ...latest, sessions } : null
}

/**
 * Durable spool: every record is appended (0600) BEFORE any send, so a crash, an
 * offline laptop or a killed process loses nothing; the next session adopts files
 * whose writer's heartbeat is stale. One entry = { r: record, h: codeHash|null,
 * o: org|null, a: folder activity|null, s: surface }.
 */
export function createSpool({ stateDir = TOKENSCOPE_DIR, sessionId, writerId = WRITER_ID, now = Date.now } = {}) {
  const dir = join(stateDir, SPOOL_DIRNAME)
  const own = join(dir, `${sessionId}.${writerId}.jsonl`)
  return {
    dir,
    path: own,
    append(entries) {
      if (!entries.length) return
      ensureDir(dir)
      fs.appendFileSync(own, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
    },
    /**
     * Take files to send: the own file and dead writers' files, each renamed first so
     * appends made during the send land in a fresh file, and two claimers cannot both win.
     */
    claim() {
      let names
      try {
        names = fs.readdirSync(dir)
      } catch (err) {
        if (err?.code === 'ENOENT') return []
        throw err // not "nothing to send": the flush fails and is retried
      }
      const files = []
      for (const name of names) {
        const full = join(dir, name)
        if (name.startsWith('.hb-')) {
          // A heartbeat nobody has touched for the spool age is a long-dead writer's.
          try {
            if (now() - fs.statSync(full).mtimeMs > SPOOL_MAX_AGE_MS) fs.rmSync(full, { force: true })
          } catch {
            /* raced with its writer or another pruner */
          }
          continue
        }
        const m = name.match(/^(.+)\.(\d+|w[0-9a-f]+)\.jsonl$/)
        if (!m) continue
        // Ours: the live file and leftovers of our earlier failed sends (one flush at a time).
        const mine = m[2] === writerId
        if (!mine) {
          let st
          try {
            st = fs.statSync(full)
          } catch {
            continue
          }
          if (writerLive(dir, m[2], st.mtimeMs, now())) continue
          if (now() - st.mtimeMs > SPOOL_MAX_AGE_MS) {
            fs.rmSync(full, { force: true })
            continue
          }
        }
        const base = m[1].replace(/\.claimed-[0-9a-f]+$/, '')
        const adopted = join(dir, `${base}.claimed-${randomBytes(4).toString('hex')}.${writerId}.jsonl`)
        try {
          fs.renameSync(full, adopted)
          files.push(adopted)
        } catch {
          /* another adopter won */
        }
      }
      return files
    },
    read: readLines,
    /**
     * Keep only entries not yet delivered. Rewrites via rename so a crash never
     * truncates, keeping the file's mtime: its age is how long these records have
     * waited (the 7-day bound, the status's stuck-backlog check).
     */
    retain(path, entries) {
      if (!entries.length) {
        fs.rmSync(path, { force: true })
        return
      }
      const { atime, mtime } = fs.statSync(path)
      const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
      fs.utimesSync(tmp, atime, mtime)
      fs.renameSync(tmp, path)
    },
  }
}

/** The `session.id` attribute of a spooled log record, or null. */
const recordSession = (r) => (r?.attributes ?? []).find((a) => a?.key === 'session.id')?.value?.stringValue ?? null

const groupKey = (e, surface) => `${e.h ?? ''}\u0000${e.o ?? ''}\u0000${e.s ?? surface}\u0000${e.a ?? ''}`

/**
 * Build one encoded OTLP request per (codeHash, org, surface) group. The surface is
 * the producing process's (`s`, spooled with the record), so a CLI session adopting
 * an App's leftovers does not relabel them; `surface` covers entries spooled without
 * one. instance_id comes from the store at send time only — never from an event or
 * the spool (§3.8 invariant).
 */
export function buildBatches(entries, instanceId, { surface = 'cli' } = {}) {
  const groups = new Map()
  for (const e of entries) {
    const k = groupKey(e, surface)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const out = []
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += BATCH_MAX) {
      const slice = group.slice(i, i + BATCH_MAX)
      const payload = buildCopilotOtlpPayload(
        slice.map((e) => e.r),
        instanceId,
        slice[0].h,
        // #475: the folder's default activity, spooled with the record (`a`).
        { githubOrg: slice[0].o, activity: slice[0].a ?? null },
      )
      payload.resourceLogs[0].resource.attributes.push(
        KV('tokenscope.emitter', EMITTER),
        KV('copilot.surface', slice[0].s ?? surface),
      )
      out.push({ entries: slice, payload })
    }
  }
  return out
}

/**
 * The per-session emitter. `onEvent` takes every session event; records are spooled
 * immediately and sent on a debounce, on idle, and on close. In shadow mode they go to
 * <stateDir>/copilot-usage-shadow/<sessionId>.jsonl instead and are never sent.
 */
export function createUsageEmitter(opts = {}) {
  const env = opts.env ?? process.env
  const stateDir = opts.stateDir ?? TOKENSCOPE_DIR
  const mode = opts.mode ?? emitMode(env)
  const surface = opts.surface ?? surfaceOf(env)
  const log = opts.log ?? (() => {})
  const provisioned = opts.isProvisioned ?? isProvisioned
  const load = opts.loadConfig ?? loadConfig
  const post = opts.post ?? httpsPost
  const mint = opts.mint ?? mintBearer
  const resolveHash = opts.resolveProjectCodeHash ?? ((cwd) => resolveProjectCodeHash(null, { cwd }))
  const resolveOrg = opts.resolveGithubOrg ?? ((cwd) => resolveGithubOrg({ cwd }))
  const resolveActivity = opts.resolveFolderActivity ?? ((cwd) => findFolderActivity(cwd))
  const noteSession = opts.recordLastSession ?? ((id, dir) => recordLastSession(id, dir, stateDir))
  const debounceMs = opts.debounceMs ?? 5_000
  const retryMaxMs = opts.retryMaxMs ?? 5 * 60_000
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const writerId = opts.writerId ?? WRITER_ID
  const nowFn = opts.now ?? Date.now

  let sessionId = opts.sessionId ?? null
  let cwd = opts.cwd ?? process.cwd()
  let stamp = null
  let spool = null
  let lastInfo = null
  let turns = 0
  let mcpCount = null
  let timer = null
  let inflight = null
  let retries = 0
  let closed = false
  let shadowPruned = false
  let driftPruned = false
  let heartbeat = null
  // Drift: cost Copilot reports between checkpoints vs the cost this process recorded.
  let lastCheckpointNano = null
  let recordedNanoSinceCheckpoint = 0

  const stamps = () => (stamp ??= { h: resolveHash(cwd) ?? null, o: resolveOrg(cwd) ?? null, a: resolveActivity(cwd) ?? null })

  // Not enrolled → nothing is captured, same as the forwarder (and nothing accrues unbounded).
  function persist(records) {
    if (!records.length || !sessionId || !provisioned()) return
    const { h, o, a } = stamps()
    const entries = records.map((r) => ({ r, h, o, a, s: surface }))
    if (mode === 'shadow') {
      const dir = join(stateDir, SHADOW_DIRNAME)
      ensureDir(dir)
      if (!shadowPruned) {
        // Parity evidence, not delivery: keep the spool's 7 days, so it cannot grow unbounded.
        shadowPruned = true
        for (const n of fs.readdirSync(dir)) {
          try {
            if (nowFn() - fs.statSync(join(dir, n)).mtimeMs > SPOOL_MAX_AGE_MS) fs.rmSync(join(dir, n), { force: true })
          } catch {
            /* raced with another pruner */
          }
        }
      }
      fs.appendFileSync(
        join(dir, `${sessionId}.jsonl`),
        entries.map((e) => JSON.stringify({ ...e, surface: e.s })).join('\n') + '\n',
        { mode: 0o600 },
      )
      return
    }
    spool ??= createSpool({ stateDir, sessionId, writerId, now: nowFn })
    startHeartbeat()
    spool.append(entries)
    schedule()
  }

  // Only once there is a spool to protect, so an unenrolled device grows no files.
  function startHeartbeat() {
    if (heartbeat || !spool) return
    touchHeartbeat(spool.dir, writerId)
    heartbeat = setInterval(() => touchHeartbeat(spool.dir, writerId), heartbeatMs)
    heartbeat.unref?.()
  }

  /**
   * The session's drift verdict, on disk, which status reports. A known loss
   * (`contract`, `persist`, `poison`) is sticky across processes: a resumed session
   * starts a new process, so stickiness lives in the file, not in memory. A checkpoint
   * clears only a cost-only verdict (`shortfall`, `excess`), and a cost-only verdict
   * never replaces a known loss (a later known loss does: either one is unhealthy).
   */
  function recordDrift(drift) {
    const dir = join(stateDir, DRIFT_DIRNAME)
    const own = SAFE_ID.test(String(sessionId ?? '')) ? sessionId : 'pending'
    const path = join(dir, `${own}.json`)
    let prior = null
    try {
      prior = JSON.parse(fs.readFileSync(path, 'utf8'))
    } catch {
      /* none yet, or unreadable: nothing known to keep */
    }
    const priorSticky = STICKY_DRIFT.has(prior?.kind)
    try {
      if (!drift) {
        if (prior && !priorSticky) fs.rmSync(path, { force: true })
        return
      }
      if (priorSticky && !STICKY_DRIFT.has(drift.kind)) return
      ensureDir(dir)
      if (!driftPruned) {
        // Verdicts past the bound are ignored by readUsageDrift; delete them too.
        driftPruned = true
        for (const n of fs.readdirSync(dir)) {
          try {
            if (nowFn() - fs.statSync(join(dir, n)).mtimeMs > DRIFT_MAX_AGE_MS) fs.rmSync(join(dir, n), { force: true })
          } catch {
            /* raced with another pruner */
          }
        }
      }
      // By rename, so status never reads a half-written verdict as "none".
      const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
      fs.writeFileSync(tmp, JSON.stringify({ ts: new Date(nowFn()).toISOString(), session: sessionId, ...drift }) + '\n', {
        mode: 0o600,
      })
      fs.renameSync(tmp, path)
      log(`usage drift: ${JSON.stringify(drift)}`)
    } catch {
      /* diagnostics only */
    }
  }

  /**
   * `session.usage_checkpoint.totalNanoAiu` is Copilot's own cumulative cost for the
   * session. Between two checkpoints it must equal the cost of the `assistant.usage`
   * events recorded in between: a shortfall means calls are being missed (e.g. the
   * event contract changed), an excess that calls are recorded twice. The FIRST
   * checkpoint only sets the baseline: a resumed session's total already includes
   * usage from before this process joined.
   */
  function onCheckpoint(d) {
    const total = safeNonNegNumber(d.totalNanoAiu)
    if (total == null) return
    // An unchanged total is still an interval: anything recorded in it is an excess.
    // Only a decreasing total (a reset) starts a new baseline.
    if (lastCheckpointNano != null && total >= lastCheckpointNano) {
      const expected = total - lastCheckpointNano
      const recorded = recordedNanoSinceCheckpoint
      if (recorded < expected * 0.99) {
        recordDrift({ kind: 'shortfall', expected_nano_aiu: expected, recorded_nano_aiu: recorded })
      } else if (recorded > expected * 1.01) {
        recordDrift({ kind: 'excess', expected_nano_aiu: expected, recorded_nano_aiu: recorded })
      } else {
        recordDrift(null)
      }
    }
    lastCheckpointNano = total
    recordedNanoSinceCheckpoint = 0
  }

  function schedule(delayMs = debounceMs) {
    if (timer || closed || mode !== 'send') return
    timer = setTimeout(() => {
      timer = null
      flush().catch(() => {})
    }, delayMs)
    timer.unref?.()
  }

  // What was kept is retried with capped exponential backoff, without waiting for new usage.
  function afterFlush(failed) {
    if (!failed) {
      retries = 0
      return
    }
    retries += 1
    schedule(Math.min(debounceMs * 2 ** retries, retryMaxMs))
  }

  async function sendAll() {
    if (!provisioned()) return { sent: 0, kept: 0 }
    spool ??= createSpool({ stateDir, sessionId: sessionId ?? 'pending', writerId, now: nowFn })
    startHeartbeat()
    const cfg = load()
    let sent = 0
    let ownSent = false
    let kept = 0
    for (const path of spool.claim()) {
      let read
      try {
        read = spool.read(path)
      } catch (err) {
        log(`spool read failed, kept: ${err?.message ?? String(err)}`)
        kept += 1
        continue
      }
      // Unparseable lines, or entries written by an older build or damaged on disk:
      // sending them can never succeed.
      const pending = read.entries.filter((e) => encodable(e, surface))
      const lost = read.dropped + read.entries.length - pending.length
      if (lost) {
        log(`dropped ${lost} spooled record(s) that cannot be sent`)
        recordDrift({ kind: 'poison', dropped: lost })
      }
      const failed = []
      for (const batch of buildBatches(pending, cfg.instance_id, { surface })) {
        try {
          const res = await postWithRetry(
            cfg.logs_endpoint,
            encodeExportLogsServiceRequest(batch.payload),
            mint,
            post,
          )
          if (res.status >= 200 && res.status < 300) {
            sent += batch.entries.length
            // Adopted leftovers belong to other sessions: only a batch that
            // carries THIS session's own records proves TokenScope has it.
            if (!ownSent && batch.entries.some((e) => recordSession(e.r) === sessionId)) ownSent = true
          } else {
            log(`post rejected: HTTP ${res.status}`)
            failed.push(...batch.entries)
          }
        } catch (err) {
          log(`post failed: ${err?.message ?? String(err)}`)
          failed.push(...batch.entries)
        }
      }
      kept += failed.length
      spool.retain(path, failed)
    }
    // #475: this session just sent its own usage from this folder (copilot-session.mjs).
    if (ownSent && sessionId) noteSession(sessionId, cwd)
    return { sent, kept }
  }

  // Every flush (debounce, idle, extension start) retries what it kept.
  function flush() {
    if (mode !== 'send') return Promise.resolve({ sent: 0, kept: 0 })
    inflight ??= sendAll()
      .finally(() => {
        inflight = null
      })
      .then(
        (r) => {
          afterFlush(r.kept > 0)
          return r
        },
        (err) => {
          afterFlush(true)
          throw err
        },
      )
    return inflight
  }

  function onEvent(event) {
    if (!event || typeof event.type !== 'string') return
    const d = event.data ?? {}
    switch (event.type) {
      case 'session.context_changed':
        if (typeof d.cwd === 'string' && d.cwd && d.cwd !== cwd) {
          cwd = d.cwd
          stamp = null
        }
        return
      case 'session.usage_info':
        lastInfo = d
        return
      case 'session.usage_checkpoint':
        onCheckpoint(d)
        return
      case 'session.mcp_servers_loaded':
        if (Array.isArray(d.servers)) mcpCount = d.servers.filter((s) => s?.status === 'connected').length
        return
      case 'assistant.turn_start':
        turns += 1
        return
      case 'assistant.usage': {
        const r = mapUsageEvent(event, sessionId)
        if (!r) {
          log('assistant.usage without token counts or ids — event contract changed? not recorded')
          recordDrift({ kind: 'contract', event_keys: Object.keys(d).slice(0, 40) })
          return
        }

        const invalid = invalidUsageCounts(d)
        if (invalid.length) {
          // Recorded with those fields as 0: the tokens are missing (a sticky verdict).
          recordDrift({ kind: 'contract', invalid })
        }
        const out = [r]
        const pct = event.agentId ? null : ctxPct(lastInfo)
        const reqId = r.attributes.find((a) => a.key === 'request_id').value.stringValue
        const s = signalRecord(`${reqId}-ctx`, sessionId, r.timeUnixNano, { ctx_pct: pct })
        if (s) out.push(s)
        try {
          persist(out)
        } catch (err) {
          // Lost before it reached the spool: never counted as recorded (a sticky verdict).
          recordDrift({ kind: 'persist', error: String(err?.code ?? err?.message ?? err).slice(0, 80) })
          throw err
        }
        recordedNanoSinceCheckpoint += safeNonNegNumber(d.copilotUsage?.totalNanoAiu) ?? 0
        return
      }
      case 'session.idle': {
        if (turns > 0) {
          const s = signalRecord(
            hashId('ct', sessionId, event.id ?? event.timestamp ?? ''),
            sessionId,
            isoToUnixNano(event.timestamp),
            { turn_count: turns, mcp_count: mcpCount },
          )
          // Reset either way: a failed append may still have written the record, so
          // keeping the count could send it twice. A failure is a known loss instead.
          turns = 0
          try {
            if (s) persist([s])
          } catch (err) {
            recordDrift({ kind: 'persist', error: String(err?.code ?? err?.message ?? err).slice(0, 80) })
          }
        }
        flush().catch(() => {})
        return
      }
    }
  }

  return {
    get mode() {
      return mode
    },
    attach(id) {
      sessionId = id
    },
    onEvent,
    flush,
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      try {
        // A send claims its files first, so records appended while it runs (during an
        // earlier send, or this one) land in a fresh own file: flush again while one
        // exists. Bounded: a session still producing usage at shutdown cannot pin it.
        let sent = 0
        let last = { sent: 0, kept: 0 }
        for (let pass = 0; pass < 3; pass++) {
          last = await flush().catch(() => ({ sent: 0, kept: 0 }))
          sent += last.sent
          if (!spool || !fs.existsSync(spool.path)) break
        }
        return { sent, kept: last.kept }
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        // This writer is gone: whatever it could not send is adoptable at once.
        if (spool) fs.rmSync(heartbeatPath(spool.dir, writerId), { force: true })
      }
    },
  }
}
