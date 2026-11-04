/*
 * otlp-logs — shared OTLP/logs encoder + Copilot transcoder.
 *
 * Exports:
 *   encodeExportLogsServiceRequest(payload) — serialize the JSON-shaped OTLP
 *     logs payload into a protobuf ExportLogsServiceRequest Buffer, as required
 *     by the Azure Monitor DCR ingest endpoint (rejects JSON with HTTP 415).
 *     Extracted from backfill.mjs; imported by both backfill.mjs and the
 *     Copilot file-forwarder. No external deps (ships into user space).
 *
 *   transcodeChatSpans(spans, opts) — map Copilot OTel trace spans to the
 *     api_request OTLP-logs shape the existing reader/joiner already consumes.
 *     Accepts BOTH the file-exporter shape (flat JSON-lines) AND the OTLP/HTTP
 *     JSON wire shape (attributes as [{key,value:{stringValue}}]). Filters to
 *     `gen_ai.operation.name == "chat"` ONLY — the parent invoke_agent span
 *     carries the same token totals; counting both is a 2× silent overspend
 *     (locked decision §3.3, VERIFIED). See docs/build/copilot-client-support.md §4.
 *
 * protobuf schema subset (field numbers from opentelemetry/proto/*.proto):
 *   ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
 *   ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
 *   Resource     { repeated KeyValue attributes = 1; }
 *   ScopeLogs    { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
 *   LogRecord    { fixed64 time_unix_nano = 1; SeverityNumber severity_number = 2;
 *                  AnyValue body = 5; repeated KeyValue attributes = 6;
 *                  fixed64 observed_time_unix_nano = 11; }
 *   KeyValue     { string key = 1; AnyValue value = 2; }
 *   AnyValue     { oneof { string string_value = 1; bool bool_value = 2;
 *                          int64 int_value = 3; double double_value = 4; } }
 */

// ── protobuf primitives ────────────────────────────────────────────────────

/** varint (base-128, LSB-first). Accepts JS number or BigInt; non-negative. */
function encodeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  if (v < 0n) throw new Error('encodeVarint: negative value')
  const bytes = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) byte |= 0x80
    bytes.push(byte)
  } while (v > 0n)
  return Buffer.from(bytes)
}

/** field tag = (fieldNumber << 3) | wireType, encoded as a varint. */
function tag(fieldNumber, wireType) {
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType))
}

/** wireType 2: length-delimited. */
function lenDelim(fieldNumber, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(buf.length), buf])
}

/** wireType 0: varint scalar. */
function varintField(fieldNumber, value) {
  return Buffer.concat([tag(fieldNumber, 0), encodeVarint(value)])
}

/** wireType 1: 64-bit fixed, little-endian (fixed64 time + double). */
function fixed64Field(fieldNumber, writeInto) {
  const b = Buffer.alloc(8)
  writeInto(b)
  return Buffer.concat([tag(fieldNumber, 1), b])
}

/** AnyValue { string=1, bool=2, int64=3, double=4 } — encode by JS payload shape. */
function encodeAnyValue(value) {
  if (value == null || typeof value !== 'object') {
    throw new Error('encodeAnyValue: expected an AnyValue object')
  }
  if (typeof value.stringValue === 'string') {
    return lenDelim(1, Buffer.from(value.stringValue, 'utf8'))
  }
  if (typeof value.boolValue === 'boolean') {
    return varintField(2, value.boolValue ? 1 : 0)
  }
  if (value.intValue !== undefined && value.intValue !== null) {
    // intValue arrives as a string (matching the JSON OTLP convention) or number.
    return varintField(3, BigInt(value.intValue))
  }
  if (value.doubleValue !== undefined && value.doubleValue !== null) {
    return fixed64Field(4, (b) => b.writeDoubleLE(Number(value.doubleValue), 0))
  }
  throw new Error(`encodeAnyValue: unsupported AnyValue ${JSON.stringify(value)}`)
}

/** KeyValue { string key = 1; AnyValue value = 2; } */
function encodeKeyValue(kv) {
  return Buffer.concat([
    lenDelim(1, Buffer.from(String(kv.key), 'utf8')),
    lenDelim(2, encodeAnyValue(kv.value)),
  ])
}

/** LogRecord { fixed64 time=1; sev=2; string severity_text=3; AnyValue body=5; repeated KeyValue attrs=6; fixed64 observed_time=11; } */
function encodeLogRecord(lr) {
  const parts = []
  parts.push(fixed64Field(1, (b) => b.writeBigUInt64LE(BigInt(lr.timeUnixNano), 0)))
  if (lr.severityNumber != null) parts.push(varintField(2, lr.severityNumber))
  // L9 fix: encode severityText (protobuf field 3, string) — was silently dropped.
  if (lr.severityText) parts.push(lenDelim(3, Buffer.from(lr.severityText, 'utf8')))
  if (lr.body != null) parts.push(lenDelim(5, encodeAnyValue(lr.body)))
  for (const attr of lr.attributes ?? []) parts.push(lenDelim(6, encodeKeyValue(attr)))
  if (lr.observedTimeUnixNano != null) {
    parts.push(fixed64Field(11, (b) => b.writeBigUInt64LE(BigInt(lr.observedTimeUnixNano), 0)))
  }
  return Buffer.concat(parts)
}

/** ScopeLogs { InstrumentationScope scope=1; repeated LogRecord log_records=2; }
 *  InstrumentationScope { string name = 1; } */
function encodeScopeLogs(sl) {
  const parts = []
  // PLG-10 fix: actually encode the declared scope (was silently dropped — both
  // payload builders set scope.name but it never reached the wire, so any KQL
  // filter on scope name would invisibly match nothing).
  if (sl.scope && typeof sl.scope.name === 'string' && sl.scope.name) {
    parts.push(lenDelim(1, lenDelim(1, Buffer.from(sl.scope.name, 'utf8'))))
  }
  for (const lr of sl.logRecords ?? []) parts.push(lenDelim(2, encodeLogRecord(lr)))
  return Buffer.concat(parts)
}

/** Resource { repeated KeyValue attributes = 1; } */
function encodeResource(resource) {
  const parts = []
  for (const attr of resource.attributes ?? []) parts.push(lenDelim(1, encodeKeyValue(attr)))
  return Buffer.concat(parts)
}

/** ResourceLogs { Resource resource=1; repeated ScopeLogs scope_logs=2; } */
function encodeResourceLogs(rl) {
  const parts = []
  if (rl.resource) parts.push(lenDelim(1, encodeResource(rl.resource)))
  for (const sl of rl.scopeLogs ?? []) parts.push(lenDelim(2, encodeScopeLogs(sl)))
  return Buffer.concat(parts)
}

/**
 * Encode the JSON-shaped OTLP logs payload into an ExportLogsServiceRequest
 * protobuf Buffer. Pure + exported for tests.
 *
 * ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
 *
 * Type choices match what Claude Code's own protobuf exporter emits and what the
 * joiner's KQL parses out of the OTelLogs table (server/azure/reader.ts):
 *   - token counts  → int_value (KQL `tolong(Attributes['input_tokens'])`)
 *   - cost_usd      → double_value (KQL `todouble(Attributes['cost_usd'])`)
 *   - nano_aiu      → double_value (KQL `todouble(Attributes['github.copilot.nano_aiu'])`)
 *   - event.name / model / request_id / session.id / body → string_value
 *   - resource attrs → string_value (KQL `tostring(...)`)
 *   - time_unix_nano → fixed64; Azure sets TimeGenerated from it.
 */
/*
 * MUST encode every resourceLogs entry it is given. A size cap that DROPS
 * entries silently loses telemetry: callers put a whole batch in ONE entry, POST
 * whatever comes back, and commit their offset on a 2xx. Any bound here has to
 * chunk and return the encoded count instead.
 * See docs/security-sprint/epic-mdash-remediation.md (W2.5).
 */
export function encodeExportLogsServiceRequest(payload) {
  const parts = []
  for (const rl of payload.resourceLogs ?? []) parts.push(lenDelim(1, encodeResourceLogs(rl)))
  return Buffer.concat(parts)
}

// ── Copilot transcoder ─────────────────────────────────────────────────────

/** Build a KV pair with the given value type. */
export function KV(k, v, t = 'stringValue') {
  return { key: k, value: { [t]: v } }
}

/**
 * Resolve an attribute value from a span, tolerating BOTH input shapes:
 *   - File-exporter shape: plain key→value object (sp.attributes['gen_ai.operation.name'])
 *   - OTLP/HTTP wire shape: [{key, value:{stringValue|intValue|doubleValue}}] array
 *
 * Returns the raw value (string/number/bigint) or undefined if not found.
 */
function resolveAttr(attrs, key) {
  if (!attrs) return undefined
  if (Array.isArray(attrs)) {
    // OTLP/HTTP JSON wire shape: [{key, value:{stringValue|intValue|doubleValue}}]
    // Filter to OBJECT entries first (MDASH F310): a non-object element makes
    // `a.key` a property read on a string/number/null, and `null` throws
    // outright. One guard covers every array-shaped attribute, not just events.
    const kv = attrs.find((a) => a && typeof a === 'object' && a.key === key)
    if (!kv) return undefined
    const v = kv.value
    if (v == null) return undefined
    if (v.stringValue !== undefined) return v.stringValue
    if (v.intValue !== undefined) return v.intValue
    if (v.doubleValue !== undefined) return v.doubleValue
    return undefined
  }
  // File-exporter shape: plain key→value object
  return attrs[key]
}

// ── numeric safety: ONE chokepoint for every numeric emit path ──────────────
// Copilot span attributes are untrusted free-form input. A garbage numeric value
// ("NaN", "abc", "1.5e3", "-5") must NEVER throw inside transcodeChatSpans:
// readNewSpans has already advanced the file offset, so an unhandled throw loses
// the whole flush batch. Every numeric attribute — token counts, nano_aiu, and
// timestamps (resolveTimeUnixNano) — routes through these helpers. Close the
// class, not the instance: a new numeric attribute added later inherits the guard
// for free by using safeIntString / safeNonNegNumber.

/**
 * Parse a value to a non-negative integer STRING for OTLP intValue encoding.
 * Returns '0' for missing/garbage/negative input. Never throws.
 *   - Pure integer string: BigInt directly (avoids Number() precision loss above 2^53,
 *     e.g. Number('9007199254740993') rounds).
 *   - Anything else (floats, numbers, BigInt): Math.round(Number()), then guard —
 *     BigInt(NaN)/BigInt(Infinity) throw and negatives are invalid → '0'.
 */
/*
 * A digit STRING is bounded before BigInt sees it (MDASH F127).
 *
 * BigInt('9'.repeat(n)) is superlinear in n, and these values arrive from
 * telemetry attributes rather than from us. 40 digits is far past any real token
 * count (2^128 has 39) and far short of anything expensive. Out-of-range reads
 * as 0, which is what every other unparseable value here does.
 */
const MAX_INT_DIGITS = 40
// Timestamps get their own cap: the value may be an ISO 8601 instant, which is
// not digits-only, so MAX_INT_DIGITS would reject legitimate input.
const MAX_TS_CHARS = 64

export function safeIntString(v) {
  if (v == null) return '0'
  if (typeof v === 'string') {
    // LENGTH FIRST, and length ONLY: trimming and regex-testing a megabyte
    // string IS the unbounded work this bound exists to avoid. Length only,
    // because the non-digit fall-through below is load-bearing — "24278.0" is a
    // real attribute and must still become 24278.
    if (v.length > MAX_INT_DIGITS + 2) return '0' // +2 tolerates surrounding space
    const t = v.trim()
    if (/^\d+$/.test(t)) return String(BigInt(t))
  }
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 0 ? String(BigInt(n)) : '0'
}

/**
 * Parse a value to a finite, non-negative JS number, or null if missing/garbage/
 * negative. For double-encoded attrs (nano_aiu): the server treats an ABSENT attr
 * as "skip", so a garbage value is DROPPED (attr omitted) rather than shipped as a
 * NaN double that would poison the server-side cost computation.
 */
export function safeNonNegNumber(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Resolve a numeric token count from a span attribute.
 * Accepts multiple key forms (CLI flat vs VS Code nested).
 * Always returns a non-negative integer string (for the intValue OTLP encoding).
 */
function resolveTokenCount(attrs, ...keys) {
  for (const k of keys) {
    const v = resolveAttr(attrs, k)
    if (v != null) return safeIntString(v)
  }
  return '0'
}

/**
 * Extract the operation name from a span (handles both input shapes).
 */
function getOperationName(span) {
  // File-exporter shape: attributes is a plain object; span.name is "chat claude-sonnet-4.6"
  // OTLP wire shape: attributes is [{key, value}] array
  const attrs = span.attributes
  const fromAttr = resolveAttr(attrs, 'gen_ai.operation.name')
  if (fromAttr) return String(fromAttr)
  // Fallback: parse the operation from the span name (e.g. "chat claude-sonnet-4.6")
  const name = span.name ?? ''
  return name.split(' ')[0] ?? ''
}

/**
 * Convert a span timestamp to unix nanoseconds as a BigInt string.
 * Handles both file-exporter shape ([sec, nsec] array or ISO string)
 * and OTLP wire shape (nanosecond string e.g. "1780825137573805196").
 */
/*
 * EVERY branch below goes through fixed64OrNow. timeUnixNano is encoded with
 * Buffer.writeBigUInt64LE, which THROWS above 2^64-1 and takes the whole batch
 * down with it — so an out-of-range instant is not a wrong number, it is a lost
 * export. Each branch can reach that range from ordinary-looking input: a
 * far-future ISO date (year 275760 is 8.6e21 ns), a long digit string, an
 * unbounded [sec, nsec] tuple, or a large ms number.
 */
const MAX_UINT64 = 18446744073709551615n

export function resolveTimeUnixNano(ts) {
  const nowNano = () => String(BigInt(Date.now()) * 1000000n)
  const fixed64OrNow = (v) => (v > 0n && v <= MAX_UINT64 ? String(v) : nowNano())
  if (ts == null) return nowNano()

  // OTLP/HTTP wire shape: nanosecond count as a string
  if (typeof ts === 'string') {
    // LENGTH FIRST, on the RAW value, before trim/Date.parse/regex touch it. This
    // string is a span ATTRIBUTE, so its length is chosen by the emitter, and a
    // cap placed after the scans bounds nothing — every superlinear step has
    // already run by then. 64 leaves room for the longest real shape (an ISO
    // 8601 instant with fractional seconds and an offset is ~35).
    if (ts.length > MAX_TS_CHARS) return nowNano()
    const s = ts.trim()
    // ISO 8601 date string. Guard ms >= 0: Date.parse('-100') yields a NEGATIVE ms
    // (a pre-1970 date) which would produce a negative timeUnixNano; reject it.
    const ms = Date.parse(s)
    if (!Number.isNaN(ms) && ms >= 0) return fixed64OrNow(BigInt(ms) * 1000000n)
    // Raw nanosecond string (OTLP wire) — DIGITS ONLY. BigInt('abc'/'NaN') throws,
    // which would abort transcodeChatSpans and lose the whole batch; guard first.
    // The digit cap is SEMANTIC and separate from the length bound above: a real
    // nanosecond instant is 19 digits, so a 40+ digit value is not a timestamp
    // and must fall back rather than become a garbage far-future one.
    if (/^\d+$/.test(s) && s.length <= MAX_INT_DIGITS) {
      return fixed64OrNow(BigInt(s))
    }
    return nowNano()
  }

  // File-exporter shape: [seconds, nanoseconds] tuple
  if (Array.isArray(ts) && ts.length === 2) {
    const sec = Number(ts[0])
    const nsec = Number(ts[1])
    if (Number.isFinite(sec) && sec >= 0 && Number.isFinite(nsec) && nsec >= 0) {
      return fixed64OrNow(BigInt(Math.round(sec)) * 1000000000n + BigInt(Math.round(nsec)))
    }
    return nowNano()
  }

  // Number (ms)
  if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) {
    return fixed64OrNow(BigInt(Math.round(ts)) * 1000000n)
  }

  return nowNano()
}

/**
 * transcodeChatSpans — the load-bearing Copilot → api_request translation.
 *
 * Maps Copilot OTel trace spans to the api_request OTLP-logs JSON shape that
 * encodeExportLogsServiceRequest() can encode. ONLY `chat` spans are kept;
 * `invoke_agent` is EXCLUDED (it carries the same token totals → double-count).
 *
 * Accepts EITHER input shape (the parser handles both; only the first is used in v1):
 *   - File-exporter: { type:"span", name, attributes:{k:v}, ... } — the v1 client path.
 *   - OTLP/HTTP wire: resourceSpans[].scopeSpans[].spans[] (attributes as [{key,value}]).
 *     No v1 caller feeds this shape; it is covered by unit tests and used only if a
 *     server-side OTLP receive route (deferred) is built later.
 *
 * @param {Array} spans — raw span objects (flat or wire shape)
 * @param {object} opts
 *   @param {string} opts.instanceId — the attested instance UUID (from ~/.tokenscope; never trusted from span)
 *   @param {string|null} [opts.projectCodeHash] — resolved project.code_hash (or null → untagged)
 *   @returns {Array} OTLP-logs JSON logRecords (for encodeExportLogsServiceRequest)
 */
export function transcodeChatSpans(spans, opts = {}) {
  const { instanceId } = opts
  if (!instanceId) throw new Error('transcodeChatSpans: instanceId is required')

  const logRecords = []

  for (const span of spans) {
    const opName = getOperationName(span)
    // GUARD: only `chat` spans — invoke_agent carries identical token totals
    // and counting both is a 2× silent overspend (locked decision §3.3).
    if (opName !== 'chat') continue

    const attrs = span.attributes
    const model = String(
      resolveAttr(attrs, 'gen_ai.request.model') ??
        resolveAttr(attrs, 'gen_ai.response.model') ??
        'unknown',
    )
    const sessionId = String(resolveAttr(attrs, 'gen_ai.conversation.id') ?? '')
    const spanId = String(span.spanId ?? '')

    // Token counts — tolerant of CLI-flat AND VS-Code-nested key forms.
    // cache_creation_input_tokens: CLI uses flat underscore (verified); VS Code nested.
    // cache_read_input_tokens: inferred (UNVERIFIED — see telemetry contract).
    const inputTokens = resolveTokenCount(attrs, 'gen_ai.usage.input_tokens')
    const outputTokens = resolveTokenCount(attrs, 'gen_ai.usage.output_tokens')
    const cacheCreationTokens = resolveTokenCount(
      attrs,
      'gen_ai.usage.cache_creation_input_tokens', // CLI flat (VERIFIED)
      'gen_ai.usage.cache_creation.input_tokens', // VS Code nested
    )
    const cacheReadTokens = resolveTokenCount(
      attrs,
      'gen_ai.usage.cache_read_input_tokens', // CLI flat (INFERRED — VERIFY)
      'gen_ai.usage.cache_read.input_tokens', // VS Code nested
    )

    // AI credit value — carry for server-side pricing (never convert on client).
    // safeNonNegNumber drops a garbage/NaN/negative nano_aiu to null → the attr is
    // OMITTED below rather than shipped as a NaN double (which the server's todouble
    // would read as a NaN cost). Server treats an absent nano_aiu as "skip pricing".
    const nanoAiu = safeNonNegNumber(resolveAttr(attrs, 'github.copilot.nano_aiu'))

    // query_source — main-vs-aux lane, the SAME wire attr Claude emits
    // (`Attributes['query_source']`, projected as `_qsrc` by server/azure/reader.ts).
    // Server-side classification is `shared/usage/query-source.ts`, which accepts
    // the literal 'main' emitted here; NULL is excluded from both sides of the
    // aux-overhead detector. Claude's OWN values are different tokens entirely
    // (docs/development/claude-code-telemetry-contract.md §Query-source
    // vocabulary) — do not copy Claude's spellings here.
    //
    // Copilot's signal is `github.copilot.initiator` on the `chat` span (the
    // ONLY main-vs-aux discriminator in the forwarded data; verified present as
    // 'user' in docs/background/copilot-otel-spike/s1-file-exporter.jsonl):
    //   'user' → interactive turn         → 'main'
    //   anything else (e.g. 'auto')       → system/background lane → 'auto' (aux)
    //   absent                            → default 'main' (tolerant)
    // Defaulting to 'main' when the signal is absent keeps the record in the
    // conversation lane rather than silently missing the field.
    const initiator = resolveAttr(attrs, 'github.copilot.initiator')
    const querySource = initiator == null || String(initiator) === 'user' ? 'main' : 'auto'

    // Timestamp: use span endTime (∥ startTime ∥ now) → unix nanos.
    // Using endTime ensures re-forwards produce the SAME ts_event → the
    // joiner's dedup key reproduces → ON CONFLICT DO NOTHING is idempotent.
    const endTime = span.endTime ?? span.endTimeUnixNano
    const startTime = span.startTime ?? span.startTimeUnixNano
    const timeNano = resolveTimeUnixNano(endTime ?? startTime ?? null)

    const logAttrs = [
      KV('event.name', 'api_request'),
      KV('request_id', spanId), // stable span id → dedup key
      KV('model', model),
      KV('session.id', sessionId),
      KV('input_tokens', inputTokens, 'intValue'),
      KV('output_tokens', outputTokens, 'intValue'),
      KV('cache_creation_tokens', cacheCreationTokens, 'intValue'),
      KV('cache_read_tokens', cacheReadTokens, 'intValue'),
      // Same wire attr Claude emits → reader.ts `_qsrc` → attribution_aggregate
      // → aux-overhead detector. Always present (defaults 'main') so the schema
      // matches Claude and the detector never sees a missing field.
      KV('query_source', querySource),
    ]

    // Carry AI credits for server-side cost computation (Slice 4).
    // Do NOT convert to USD on the client (locked decision §3.7).
    if (nanoAiu != null) {
      logAttrs.push(KV('github.copilot.nano_aiu', String(nanoAiu), 'doubleValue'))
    }

    logRecords.push({
      timeUnixNano: timeNano,
      observedTimeUnixNano: timeNano,
      severityNumber: 9, // INFO
      severityText: 'INFO',
      body: { stringValue: 'api_request' },
      attributes: logAttrs,
    })
  }

  return logRecords
}

// ── behavioural usage signals (NON-billing lane) ────────────────────────────

/**
 * Count elements of a JSON-array-string attribute (gen_ai.tool.definitions,
 * github.copilot.context.mcp_server_names ship as JSON strings). Returns a
 * non-negative integer, or null if absent/unparseable. Never throws (JSON.parse
 * is guarded — a garbage value must not abort the flush batch, cf. the numeric
 * safety helpers above).
 */
/*
 * Reject an oversized string BEFORE parsing it (MDASH F124). We only want the
 * LENGTH of an array; parsing megabytes of attacker-shaped JSON to learn a
 * number is work we never needed to do.
 */
const MAX_JSON_ATTR_BYTES = 64 * 1024

export function jsonArrayLength(v) {
  if (v == null) return null
  if (Array.isArray(v)) return v.length
  if (typeof v !== 'string') return null
  if (v.length > MAX_JSON_ATTR_BYTES) return null
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

/**
 * Resolve an attribute from a NAMED span event (Copilot's
 * github.copilot.session.usage_info event carries token_limit/current_tokens).
 * Tolerates both file-exporter (events[].attributes plain object) and OTLP wire
 * shapes via resolveAttr. Returns undefined if the event/key is absent.
 */
function resolveEventAttr(span, eventName, key) {
  const events = span?.events
  if (!Array.isArray(events)) return undefined
  for (const ev of events) {
    if (ev?.name !== eventName) continue
    const v = resolveAttr(ev.attributes, key)
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * transcodeSignalSpans — emit behavioural usage-signal records, a lane kept
 * deliberately SEPARATE from the token path (transcodeChatSpans is untouched, so
 * billing carries zero risk from this code). design: docs/design/copilot-usage-signals.md
 *
 * Each record is `event.name='usage_signal'` with NO token attributes, so the
 * token reader (event.name='api_request' + Tokens>0) never sees them and the
 * signal reader (event.name='usage_signal') never sees token records.
 *
 * Signal → source span is 1:1 so nothing double-counts: tool_count + ctx_pct from
 * the `chat` span; mcp_count + turn_count from the `invoke_agent` span (which the
 * token path drops for the §3.3 double-count guard, but which is the turn-level
 * source of truth for these). ctx_pct is the per-record saturation ratio derived
 * HERE because the aggregate stores per-signal (min,sum,max) and
 * max(used)/max(limit) != max(used/limit) — a ratio, not USD, so client-side
 * derivation does not breach §3.7. A span with no signals emits no record.
 *
 * @param {Array} spans — raw span objects (flat or wire shape)
 * @param {object} opts
 *   @param {string} opts.instanceId — attested instance UUID (mirrors transcodeChatSpans; resource attrs ride at payload level)
 * @returns {Array} OTLP-logs JSON logRecords (event.name='usage_signal')
 */
export function transcodeSignalSpans(spans, opts = {}) {
  const { instanceId } = opts
  if (!instanceId) throw new Error('transcodeSignalSpans: instanceId is required')

  const logRecords = []

  for (const span of spans) {
    const opName = getOperationName(span)
    const attrs = span.attributes
    const sigAttrs = []

    if (opName === 'chat') {
      const toolCount = jsonArrayLength(resolveAttr(attrs, 'gen_ai.tool.definitions'))
      if (toolCount != null) sigAttrs.push(KV('sig.tool_count', String(toolCount), 'intValue'))

      const used = safeNonNegNumber(
        resolveEventAttr(
          span,
          'github.copilot.session.usage_info',
          'github.copilot.current_tokens',
        ),
      )
      const limit = safeNonNegNumber(
        resolveEventAttr(span, 'github.copilot.session.usage_info', 'github.copilot.token_limit'),
      )
      if (used != null && limit != null && limit > 0) {
        // Saturation %, capped at 100 (the window cannot hold more than its limit).
        const pct = Math.min(100, Math.round((used / limit) * 100))
        sigAttrs.push(KV('sig.ctx_pct', String(pct), 'intValue'))
      }
    } else if (opName === 'invoke_agent') {
      const mcpCount = jsonArrayLength(
        resolveAttr(attrs, 'github.copilot.context.mcp_server_names'),
      )
      if (mcpCount != null) sigAttrs.push(KV('sig.mcp_count', String(mcpCount), 'intValue'))

      const turnCount = safeNonNegNumber(resolveAttr(attrs, 'github.copilot.turn_count'))
      if (turnCount != null) {
        sigAttrs.push(KV('sig.turn_count', String(Math.round(turnCount)), 'intValue'))
      }
    } else {
      continue
    }

    if (sigAttrs.length === 0) continue // no signals on this span → no record

    const spanId = String(span.spanId ?? '')
    const sessionId = String(resolveAttr(attrs, 'gen_ai.conversation.id') ?? '')
    const endTime = span.endTime ?? span.endTimeUnixNano
    const startTime = span.startTime ?? span.startTimeUnixNano
    const timeNano = resolveTimeUnixNano(endTime ?? startTime ?? null)

    logRecords.push({
      timeUnixNano: timeNano,
      observedTimeUnixNano: timeNano,
      severityNumber: 9, // INFO
      severityText: 'INFO',
      body: { stringValue: 'usage_signal' },
      attributes: [
        KV('event.name', 'usage_signal'),
        KV('request_id', spanId), // stable span id → dedup source_run_id
        KV('session.id', sessionId),
        ...sigAttrs,
      ],
    })
  }

  return logRecords
}

/**
 * Build the full OTLP-logs payload (resourceLogs envelope) from transcoded logRecords.
 * The instanceId is the security-critical resource attr — always the server-attested
 * UUID from ~/.tokenscope; NEVER the free-text label from the span (security invariant).
 *
 * The GitHub ORG (opts.githubOrg) is stamped as a resource attribute for F2
 * org→enterprise keying — derived client-side from the project's git remote (with a
 * span-attr fallback) by the forwarder. It is NOT an identity factor (Copilot OTel
 * carries no usable per-user identity; teammate attribution is directory-sourced via
 * SAML SSO). Null → the org attrs are OMITTED (untagged-enterprise is acceptable).
 *
 * @param {Array} logRecords — output of transcodeChatSpans()
 * @param {string} instanceId — attested instance UUID
 * @param {string|null} projectCodeHash — resolved project.code_hash (null → untagged)
 * @param {object} [opts]
 *   @param {string|null} [opts.githubOrg] — lowercased GitHub org for F2 keying.
 *   @param {string|null} [opts.activity] — the folder's default activity (#475;
 *     readFolderActivity), sent as `tokenscope.activity`. The server keeps it only
 *     when it names a standard activity type.
 * @returns OTLP logs payload object suitable for encodeExportLogsServiceRequest()
 */
export function buildCopilotOtlpPayload(logRecords, instanceId, projectCodeHash, opts = {}) {
  const resourceAttrs = [KV('tokenscope.instance_id', instanceId), KV('tool', 'copilot-cli')]
  if (projectCodeHash) resourceAttrs.push(KV('project.code_hash', projectCodeHash))
  if (opts.activity) resourceAttrs.push(KV('tokenscope.activity', opts.activity))
  // Org stamp for F2 org→enterprise keying. Emitted as `github.org`; mirror it as
  // `github.repository` (the value is the org, the closest field name the joiner can
  // key on without a per-repo slug) so a KQL filter on either name resolves the org.
  const githubOrg = opts.githubOrg
  if (githubOrg) {
    resourceAttrs.push(KV('github.org', githubOrg))
    resourceAttrs.push(KV('github.repository', githubOrg))
  }

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: 'com.github.copilot' },
            logRecords,
          },
        ],
      },
    ],
  }
}
