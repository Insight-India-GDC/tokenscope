// fake-azure-monitor — local stand-in for the sandbox telemetry path
// (Path B: Claude → OTel Collector → Log Analytics → KQL). Locally it
// plays BOTH the collector and the queryable store: it RECEIVES Claude
// Code's real OTLP/HTTP and NORMALISES it into UsageRecords keyed on the
// `tokenscope.instance_id` resource attribute (legacy `tokenscope.session_id`
// still accepted), then serves them to the
// read joiner. See docs/development/claude-code-telemetry-contract.md.
//
// Endpoints:
//   GET  /, /v1/health                  — health (the reader's probe hits /v1/health)
//   POST /v1/logs                       — OTLP/HTTP logs, protobuf or JSON, optionally gzip [REAL path]
//   POST /v1/metrics, /v1/traces        — accepted + ignored (events are the source of truth)
//   POST /admin/ingest                  — simulated UsageRecords {session_id, usage|spans:[...]}
//   GET  /v1/sessions/:sid/usage        — UsageRecords for a session (the reader's query)
//   POST /admin/reset                   — test isolation
//
// In-memory; survives process lifetime only.
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { decodeExportLogsServiceRequest } from './otlp-protobuf.js'

const port = Number(process.env.PORT || 8080)

/** @typedef {{tokens:number, tokenType:string, model:string, tsEvent:string, sourceRunId?:string, organizationId?:string, projectCodeHash?:string, activity?:string, claudeSessionId?:string, nanoAiu?:number, querySource?:string, lawCostUsd?:number}} UsageRecord */
/** @type {Map<string, UsageRecord[]>} */
const usageBySession = new Map()
// CONVERSATION KEY (Claude's session.id, falling back to the instance id when a
// record carries no session.id) → { email, firstEvent, lastEvent, costUsd,
// models:Set, instanceId } — the per-conversation summary metadata for
// GET /v1/sessions (the untagged-conversation worklist, §13). Keying on the
// conversation (not the instance) lists sibling conversations on a shared
// instance separately; instanceId is carried alongside.
const sessionMeta = new Map()
let lastBearerSeen = null

// Claude api_request token attr → rate_line.unit name.
const TOKEN_FIELD_TO_UNIT = {
  input_tokens: 'input',
  output_tokens: 'output',
  cache_read_tokens: 'cache-read',
  cache_creation_tokens: 'cache-write',
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === null ? '' : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function addUsage(sid, rec) {
  const list = usageBySession.get(sid) ?? []
  list.push(rec)
  usageBySession.set(sid, list)
}

// OTLP attribute list → plain object. Values: {stringValue|intValue|doubleValue|boolValue}.
function attrsToObject(attrs) {
  const out = {}
  for (const a of attrs ?? []) {
    const v = a.value ?? {}
    out[a.key] =
      v.stringValue ??
      (v.intValue !== undefined ? Number(v.intValue) : undefined) ??
      v.doubleValue ??
      v.boolValue
  }
  return out
}

// Normalise an OTLP/HTTP logs payload (Claude api_request events) into UsageRecords.
function ingestOtlpLogs(payload) {
  let recordsAdded = 0
  for (const rl of payload.resourceLogs ?? []) {
    const resource = attrsToObject(rl.resource?.attributes)
    // `tokenscope.instance_id` is the CURRENT wire attribute; every live client
    // emits it. `tokenscope.session_id` is the pre-migration name, still read so
    // an old capture replayed against this stub keeps working. Reading only the
    // retired name made the stub drop 100% of real OTLP traffic in silence: the
    // POST still returned 200 with records_normalised: 0, so a local stack
    // looked healthy and simply never produced attribution.
    const sid = resource['tokenscope.instance_id'] ?? resource['tokenscope.session_id']
    if (!sid) continue // not one of ours — skip
    // ADR-0004 "B′": project.code_hash is a per-RESOURCE attribute (one per repo).
    // The same DEVICE_SID may appear across resourceLogs carrying different hashes.
    const projectCodeHash = resource['project.code_hash']
    // The folder's default activity (#475): raw here, like the LAW column; the
    // joiner keeps it only when it names an active activity_type.
    const activity = resource['tokenscope.activity'] || undefined
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const a = attrsToObject(lr.attributes)
        if (a['event.name'] !== 'api_request') continue
        const model = a['model'] || 'unknown'
        const ts =
          a['event.timestamp'] ||
          (lr.timeUnixNano
            ? new Date(Number(BigInt(lr.timeUnixNano) / 1000000n)).toISOString()
            : new Date().toISOString())
        const runId = a['request_id'] || a['prompt.id']
        // §13: the conversation key is Claude's own session.id, NOT the instance
        // (sid). Subagents share their parent's session.id, so they roll into one
        // conversation. Fall back to the instance id when no session.id is emitted.
        const convKey = a['session.id'] || sid
        // Per-conversation summary metadata (per-event user.email is the owner).
        const meta = sessionMeta.get(convKey) ?? {
          email: '',
          firstEvent: ts,
          lastEvent: ts,
          costUsd: 0,
          models: new Set(),
          instanceId: sid,
          tokens: 0,
        }
        if (a['user.email']) meta.email = a['user.email']
        if (ts < meta.firstEvent) meta.firstEvent = ts
        if (ts > meta.lastEvent) meta.lastEvent = ts
        meta.costUsd += Number(a['cost_usd'] ?? 0)
        meta.models.add(model)
        meta.instanceId = sid
        sessionMeta.set(convKey, meta)
        // github.copilot.nano_aiu: present on Copilot-transcoded api_request events.
        const nanoAiu =
          a['github.copilot.nano_aiu'] != null ? Number(a['github.copilot.nano_aiu']) : undefined
        // mig 0045 capture: per-event query_source lane + Claude's own cost_usd
        // (duplicated onto each token-type row, like the sandbox KQL mv-expand).
        const querySource = a['query_source'] || undefined
        const lawCostUsd =
          a['cost_usd'] != null && Number.isFinite(Number(a['cost_usd']))
            ? Number(a['cost_usd'])
            : undefined
        for (const [field, unit] of Object.entries(TOKEN_FIELD_TO_UNIT)) {
          const tokens = Number(a[field] ?? 0)
          if (!Number.isFinite(tokens) || tokens <= 0) continue
          addUsage(sid, {
            tokens,
            tokenType: unit,
            model,
            tsEvent: ts,
            sourceRunId: runId,
            organizationId: a['organization.id'],
            projectCodeHash,
            activity,
            claudeSessionId: a['session.id'],
            nanoAiu,
            querySource,
            lawCostUsd,
          })
          meta.tokens += tokens
          recordsAdded += 1
        }
      }
    }
  }
  return recordsAdded
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const method = req.method ?? 'GET'
  if (req.headers['authorization'])
    lastBearerSeen = String(req.headers['authorization']).slice(0, 24)

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/v1/health')) {
    return send(res, 200, {
      service: 'fake-azure-monitor',
      status: 'ok',
      sessions_with_usage: usageBySession.size,
      last_bearer_prefix: lastBearerSeen,
    })
  }

  // ── REAL path: OTLP/HTTP from Claude Code (or a collector) ──────────
  if (method === 'POST' && url.pathname === '/v1/logs') {
    try {
      let body = await readBody(req)
      if (String(req.headers['content-encoding'] ?? '').includes('gzip')) body = gunzipSync(body)
      const type = String(req.headers['content-type'] ?? '')
      const payload = !body.length
        ? {}
        : type.includes('protobuf')
          ? decodeExportLogsServiceRequest(body)
          : JSON.parse(body.toString('utf8'))
      const n = ingestOtlpLogs(payload)
      return send(res, 200, { partialSuccess: {}, records_normalised: n })
    } catch (err) {
      // Detail goes to THIS process's stderr, not into the HTTP response.
      // Even in a dev stub, echoing a thrown error back to the caller ships
      // internals (parser internals, paths, stack frames) to whoever POSTed
      // (CodeQL js/stack-trace-exposure #4). stderr keeps the debug value —
      // it is right there in the dev-stack logs — without the exposure.
      console.error('[fake-azure-monitor] /v1/logs rejected:', err)
      return send(res, 400, { error: 'bad otlp logs' })
    }
  }
  // Metrics/traces accepted + ignored — api_request events are the source of truth.
  if (method === 'POST' && (url.pathname === '/v1/metrics' || url.pathname === '/v1/traces')) {
    await readBody(req)
    return send(res, 200, { partialSuccess: {} })
  }

  // ── Simulated path: direct UsageRecords (emit-data / journey-emit) ──
  if (method === 'POST' && url.pathname === '/admin/ingest') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const sid = body.session_id
      if (typeof sid !== 'string' || !sid) return send(res, 400, { error: 'session_id required' })
      const incoming = Array.isArray(body.usage)
        ? body.usage
        : Array.isArray(body.spans)
          ? body.spans
          : []
      for (const r of incoming) addUsage(sid, r)
      return send(res, 201, {
        session_id: sid,
        total_usage: (usageBySession.get(sid) ?? []).length,
      })
    } catch (err) {
      console.error('[fake-azure-monitor] /admin/ingest rejected:', err)
      return send(res, 400, { error: 'invalid body' })
    }
  }

  // ── Read path: the joiner's query ──────────────────────────────────
  // Session summaries (the reader's listSessions), optionally filtered by email.
  if (method === 'GET' && url.pathname === '/v1/sessions') {
    const emails = url.searchParams.getAll('email')
    const out = []
    for (const [convKey, meta] of sessionMeta) {
      if (emails.length && !emails.includes(meta.email)) continue
      out.push({
        // §13: sessionId is the CONVERSATION key (Claude's session.id),
        // instanceId is the device/enrolment it ran on.
        sessionId: convKey,
        instanceId: meta.instanceId,
        email: meta.email,
        firstEvent: meta.firstEvent,
        lastEvent: meta.lastEvent,
        tokens: meta.tokens ?? 0,
        costUsd: meta.costUsd,
        models: [...meta.models],
      })
    }
    out.sort((a, b) => String(b.lastEvent).localeCompare(String(a.lastEvent)))
    return send(res, 200, { sessions: out })
  }

  const m = /^\/v1\/sessions\/([^/]+)\/usage$/.exec(url.pathname)
  if (method === 'GET' && m) {
    return send(res, 200, { session_id: m[1], usage: usageBySession.get(m[1]) ?? [] })
  }

  if (method === 'POST' && url.pathname === '/admin/reset') {
    usageBySession.clear()
    sessionMeta.clear()
    return send(res, 204, null)
  }

  send(res, 404, { error: 'not found', path: url.pathname })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`fake-azure-monitor (OTLP telemetry store) listening on :${port}`)
})
