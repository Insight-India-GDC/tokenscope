/*
 * Telemetry reader — pulls a session's token usage from the telemetry
 * store and returns normalised UsageRecords for the read joiner.
 *
 * Claude Code emits token usage as OTel METRICS + LOG EVENTS (not spans);
 * the `api_request` event carries the four token counts + cost per API
 * call. Our injected OTEL_RESOURCE_ATTRIBUTES.tokenscope.instance_id rides
 * every record, so the join key is OURS (== instance_attestation.instance_id),
 * not Claude's internal session.id. See
 * docs/development/claude-code-telemetry-contract.md.
 *
 * Two implementations behind one interface:
 *   - LocalCollectorReader — local spike: queries the collector-fed
 *     telemetry store (tools/fake-azure-monitor), which has normalised
 *     Claude's OTLP into UsageRecords keyed on tokenscope.instance_id.
 *   - LogAnalyticsReader — sandbox (Path B): queries Log Analytics via
 *     @azure/monitor-query KQL. Implemented at the Epic-10 sandbox cut.
 * Selected by NUXT_TELEMETRY_READER (default 'local').
 */
import { z } from 'zod'
import { resilientFetch } from '../utils/resilient-fetch'
import { classifyProbeError } from '../utils/redact-probe-error'
import { canonicaliseEmail } from '../../shared/identity/email'
import { ACTIVITY_LABEL_MAX, NO_CONTROL_CHARS_RE as DISPLAY_TEXT_RE } from '../../shared/schemas/display-text'

/*
 * KQL-injection guard (ING-10): instance ids are interpolated into KQL string
 * literals. Only DB-sourced UUIDs reach getSessionUsage today, but a future
 * caller passing user input would re-open the injection buildListSessionsKql
 * already needed a guard for. Charset-only check (hex + dashes) — quotes and
 * backslashes, the only KQL string-literal break-out chars, can never pass.
 */
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i

/*
 * Outer scan bound for Log Analytics reads (see LogAnalyticsReader.resolveLookbackDays).
 * DEFAULT keeps the scheduled tick cheap; MAX is the longest retention we
 * provision (infra/modules/monitoring.bicep: 90d production, 30d elsewhere), so a
 * recovery read can reach anything still IN the workspace and nothing beyond it.
 */
const DEFAULT_LOOKBACK_DAYS = 7
const MAX_LOOKBACK_DAYS = 90

/*
 * Default healthCheck request bound. Callers with a tighter budget pass their
 * own (the ops-alert evaluator probes at 5 s per ar-H6); this default keeps the
 * interactive diagnostics page from hanging on a wedged query endpoint while
 * staying generous enough that a healthy-but-slow workspace never reads as red.
 */
const HEALTHCHECK_TIMEOUT_MS = 10_000

/**
 * ISO-8601 duration for a day count. `Durations` only aliases up to 7 days, but
 * the query API takes any ISO-8601 string — so a wider recovery read is
 * expressible; the alias table was never the limit. Uses the SDK aliases for the
 * two common values so the emitted string matches what the SDK would produce.
 */
export function isoDuration(days: number, durations: { oneDay: string; sevenDays: string }): string {
  if (days === 1) return durations.oneDay
  if (days === 7) return durations.sevenDays
  return `P${days}D`
}

/**
 * Normalise a requested `lookbackDays` to a usable whole-day scan bound.
 * NaN / -Infinity / sub-1 / fractional-below-1 all fall back to the DEFAULT
 * rather than narrowing silently (a narrower window than intended loses history
 * on a first-ever scan). +Infinity and anything above MAX clamp to MAX: a wider
 * request is a real intent that simply exceeds what retention can hold, and
 * +Infinity is its canonical spelling — matching the liveBearerHours knob in
 * azure-monitor-reader.ts, which the two resolvers previously disagreed on.
 * Exported for tests —
 * nothing else asserts on the emitted query duration, so an accidental
 * narrowing here would otherwise be invisible to CI.
 */
export function resolveLookbackDays(raw: number | undefined): number {
  // Infinity is treated as "as wide as possible" and clamps to MAX — matching
  // the liveBearerHours knob in azure-monitor-reader.ts, which argues the same
  // case. The two resolvers previously disagreed about the same input shape.
  if (raw === Number.POSITIVE_INFINITY) return MAX_LOOKBACK_DAYS
  if (!Number.isFinite(raw as number)) return DEFAULT_LOOKBACK_DAYS
  const days = Math.floor(raw as number)
  if (days < 1) return DEFAULT_LOOKBACK_DAYS
  return Math.min(days, MAX_LOOKBACK_DAYS)
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('getSessionUsage: session id must be a 36-char UUID-shaped string')
  }
}

const UsageRecordSchema = z.object({
  tokens: z.number().int().nonnegative(),
  // Normalised to rate_line.unit values: input | output | cache-read | cache-write.
  tokenType: z.string(),
  model: z.string(),
  tsEvent: z.string(),
  sourceRunId: z.string().optional(),
  // The Claude-stamped per-event organization.id — the joiner uses it to pick
  // the reconciliation lane via provider_org. Undefined for legacy/local data.
  // RAW and deliberately UNBOUNDED: it is a query PARAMETER against
  // provider_org.external_org_id and is never persisted, so the ingest bounds
  // below do not apply to it. Bounding it would change which lane an existing
  // record lands in — see `emittingOrgId`.
  organizationId: z.string().optional(),
  // The same organization.id, BOUNDED for storage as
  // attribution_record.emitting_org_id (mig 0119) — a diagnostic column, never
  // an input to any decision. Undefined when the emitter reported none, OR when
  // it reported one this ingest boundary refused to store (counted into
  // ParseCounters.rejectedOrganizationId) — in which case `organizationId`
  // above still carries the raw value and the lane is unaffected.
  emittingOrgId: z.string().optional(),
  // The emitted per-event project.code_hash from the repo's committed
  // .tokenscope (ADR-0004 "B′": project is a per-record CLAIM, membership-gated
  // at join). Records under one DEVICE_SID may carry DIFFERENT hashes (one per
  // repo). Undefined when the repo emitted no .tokenscope → stays untagged.
  projectCodeHash: z.string().optional(),
  // The folder's default activity (resource attr tokenscope.activity), decoded
  // and bounded by boundActivityLabel. A CLAIM only: the joiner stores it only
  // when it names an active activity_type, and then in the vocabulary's spelling.
  activity: z.string().optional(),
  // Claude's own per-conversation session.id (Attributes['session.id']). Distinct
  // from our tokenscope.instance_id (the device). Subagents share their parent's
  // value, so grouping on this rolls subagent spend into the parent conversation.
  // Undefined for legacy/local data.
  claudeSessionId: z.string().optional(),
  // Provenance (ADR-0005 slice 3): set when the record was re-emitted by
  // /tokenscope:backfill (resource attr tokenscope.backfill=true). The joiner
  // marks the resulting attribution_record non-reconciled / advisory (tier-2,
  // telemetry-only, metadata.backfill) — dedup ≠ authenticity. Undefined = live.
  backfill: z.boolean().optional(),
  // GitHub AI credits (Copilot only). nano_aiu = credits × 1e9.
  // Used by the joiner for Copilot cost: cost_usd = nano_aiu × 1e-11.
  // Undefined for Claude records (those use token rate cards).
  nanoAiu: z.number().optional(),
  // Claude's per-event query_source attr (mig 0045), stored RAW. It is NOT the
  // word 'main': Claude emits its own token ('repl_main_thread', 'agent:custom',
  // 'compact', …) — vocabulary + evidence in
  // docs/development/claude-code-telemetry-contract.md §Query-source vocabulary.
  // Classify with shared/usage/query-source.ts, never by equality. Undefined for
  // legacy/local data — the joiner stores NULL, which consumers treat as unknown.
  querySource: z.string().optional(),
  // Claude's own per-event cost_usd (informational, belt-and-braces). The KQL
  // mv-expand duplicates it onto every token-type row of the span; the joiner
  // carries it into metadata.law_cost_usd and v_cost_drift aggregates it MAX
  // per span against our SUMmed rate-card cost. Undefined for legacy data.
  lawCostUsd: z.number().optional(),
  // Claude's per-event user.email (mig 0119) — the EMITTING ACCOUNT, as
  // distinct from the emitting DEVICE (tokenscope.instance_id). Already
  // CANONICALISED (trim + lower, shared/identity/email.ts) by the parser, so
  // every consumer compares like for like and no caller has to remember to.
  // The joiner stamps attribution_record.billing_lane from it; it is NEVER an
  // attribution key — money binds to the instance.
  // Undefined = the emitter reported no address, OR reported one this ingest
  // boundary refused to store (counted into ParseCounters.rejectedEmittingEmail).
  emittingEmail: z.string().optional(),
})
export type UsageRecord = z.infer<typeof UsageRecordSchema>

const SessionUsage = z.object({
  session_id: z.string(),
  usage: z.array(UsageRecordSchema),
})

/**
 * One behavioural usage-signal observation (the NON-billing lane). Flattened from
 * a usage_signal log record: one SignalRecord per (span, signal_name) so the
 * landing dedups on (instance, source span, signal_name). design:
 * docs/design/copilot-usage-signals.md
 */
export interface SignalRecord {
  signalName: string
  value: number
  tsEvent: string
  sourceRunId?: string
}

// The signal lane's WIRE contract: DB signal_name → the OTLP attribute the
// transcoder emits (otlp-logs.mjs::transcodeSignalSpans). The transcoder hardcodes
// the same `sig.*` strings across the .mjs/.ts boundary (no shared module possible);
// the copilot-transcoder contract test pins emit↔parse against THIS map so a rename
// on either side fails CI instead of silently emptying the lane. Adding a signal is
// one entry here + the transcoder emit + a detector — no migration.
export const SIGNAL_WIRE_COLUMNS = {
  tool_count: 'sig.tool_count',
  mcp_count: 'sig.mcp_count',
  ctx_pct: 'sig.ctx_pct',
  turn_count: 'sig.turn_count',
} as const

// Positional fallback for parseSignalRows when a result table carries no column
// descriptors — MUST match buildSignalUsageKql's project order (_ts, _req, signals).
const SIGNAL_KQL_PROJECTION = ['_ts', '_req', ...Object.keys(SIGNAL_WIRE_COLUMNS)] as const

const SessionSummaryListSchema = z.object({
  sessions: z.array(
    z.object({
      // Claude's per-conversation session.id (the conversation key — §13).
      sessionId: z.string(),
      // The tokenscope.instance_id (device/enrolment) the conversation ran on.
      // Optional: the local store may not carry it for legacy rows.
      instanceId: z.string().optional(),
      email: z.string(),
      firstEvent: z.string(),
      lastEvent: z.string(),
      tokens: z.number(),
      costUsd: z.number(),
      models: z.array(z.string()),
    }),
  ),
})

/**
 * One observed CONVERSATION, summarised from OTel — independent of attribution.
 * Powers the "untagged sessions" worklist (retroactive tagging). Keyed on
 * Claude's own per-conversation session.id (§13 — so sibling conversations on a
 * shared instance are listed separately), carrying the instance_id alongside so
 * the UI can show which device/enrolment the conversation ran on. The owner is
 * the per-event user.email Claude stamps; resolve it to a teammate via
 * teammate.email or teammate_identity_map.
 */
export interface SessionSummary {
  /** Claude's per-conversation session.id — the conversation key. */
  sessionId: string
  /** The tokenscope.instance_id (device/enrolment) the conversation ran on. */
  instanceId?: string
  email: string
  firstEvent: string
  lastEvent: string
  tokens: number
  costUsd: number
  models: string[]
}

/*
 * High-water-mark lookback (read-joiner scalability fix). When the joiner has a
 * per-instance watermark (MAX(attribution_record.ts_event) for already-attributed
 * rows), it asks the reader for only events strictly newer than
 * `watermark - WATERMARK_LOOKBACK_MS`. The small overlap re-reads near-boundary
 * events so a minor out-of-order ingestion can't be skipped; the joiner's
 * onConflictDoNothing dedup (the unique index) makes the re-read a harmless
 * idempotent no-op. Net: per-tick read is bounded by actual new emission, not
 * the instance's lifetime history.
 */
export const WATERMARK_LOOKBACK_MS = 5 * 60 * 1000 // 5 minutes

export interface ReaderHealth {
  ok: boolean
  kind: 'log-analytics' | 'local'
  latencyMs: number
  /** short error/status string when !ok — never a secret. */
  error?: string
  /**
   * Ties a redacted `error` back to the full-fidelity server log line (see
   * redact-probe-error.ts). Present only when `error` came from a CAUGHT
   * EXCEPTION (a driver/network fault) — an HTTP-status or query-status
   * message (e.g. `HTTP 404`, `query status=Failure`) carries no secret and
   * needs no correlation id.
   */
  correlationId?: string
}

/*
 * Billable ingestion into the telemetry workspace over the TRAILING 24 HOURS, in
 * MB (the Usage table's Quantity unit; Azure's own queries divide by 1000 for
 * GB). Fixed text, no interpolation.
 *
 * Trailing 24 h, not "since the cap last reset": the daily cap resets at a
 * workspace-specific hour (09:00 UTC on Dev, per `quotaNextResetTime`; not
 * configurable), not at UTC midnight. The usage since the last reset is always
 * inside the trailing 24 h, so this number is always at least that usage: it can
 * warn early (yesterday's volume before the reset still counts) but never late.
 */
export const BILLABLE_INGESTION_LAST_24H_KQL =
  'Usage | where TimeGenerated > ago(24h) | where IsBillable == true | summarize sum(Quantity)'

/**
 * One reading of the trailing 24 h's billable ingestion. `megabytes` is null whenever the
 * read could not answer: a reader without a Usage table (`error: 'unsupported'`),
 * a failed or partial query, or a result with no number in it. Null is not zero,
 * and a caller must not treat it as one.
 */
export interface IngestionLast24h {
  megabytes: number | null
  kind: 'log-analytics' | 'local'
  latencyMs: number
  /** short reason when megabytes is null — never a secret. */
  error?: string
  /** As on ReaderHealth: present only when `error` came from a caught exception. */
  correlationId?: string
}

/**
 * What INGEST saw for one instance over a window — the client-vs-server
 * discriminator.
 *
 * When a device is emitting (minting bearers) but its spend is not being
 * attributed, exactly one question splits the two halves of the system: did that
 * device's telemetry reach Log Analytics at all? IN-but-unattributed is ours (the
 * joiner); ABSENT is the client's (export/transport/auth). Answering it from the
 * ledger is impossible by construction — the ledger only ever shows the joined
 * side — so it has to be asked of the ingest store directly.
 *
 * `records` counts EVERY OTelLogs row for the instance, `usageRecords` only the
 * token-carrying `api_request` ones. The pair distinguishes "nothing arrived" from
 * "records arrived but none carried usage", which are different faults.
 */
export interface InstancePresence {
  records: number
  usageRecords: number
  firstSeen: string | null
  lastSeen: string | null
}

/**
 * An event-time slice of a read, `[from, to)`. Bounds a deep read to one
 * instance-day (docs/design/bounded-daily-deep-read.md). Both ends are resolved
 * by the caller, never sampled here.
 */
export interface EventWindow {
  from: Date
  to: Date
}

/** KQL for an EventWindow; empty without one. The instants are ours, not input. */
export function eventWindowClause(window?: EventWindow): string {
  if (!window) return ''
  return `| where TimeGenerated >= datetime(${window.from.toISOString()}) and TimeGenerated < datetime(${window.to.toISOString()})`
}

/**
 * The query's outer timespan: the window itself when there is one, so a window
 * fixed earlier (a resumed recovery request) is never clipped by a lookback
 * measured from now; otherwise the reader's lookback.
 */
function queryTimespan(
  lookbackDays: number,
  durations: typeof import('@azure/monitor-query').Durations,
  window?: EventWindow,
): { duration: string } | { startTime: Date; endTime: Date } {
  if (window) return { startTime: window.from, endTime: window.to }
  return { duration: isoDuration(lookbackDays, durations) }
}

/**
 * A windowed read runs inside a recovery tick whose dispatch budget is 200 s. An
 * instance-day issues up to three queries (Claude, native GenAI, signals), so at
 * 30 s each it takes at most ~90 s; started just inside the worker's 90 s budget
 * it still ends inside the dispatch.
 */
export const WINDOWED_QUERY_TIMEOUT_S = 30

/*
 * An unwindowed read is a joiner run's watermark read (scheduled or operator). The run
 * starts no device later than 80 s after its tick started (JOINER_DEADLINE_MS,
 * measured from the registry's tick start, before the coverage probe and the
 * selection), and a device issues two queries (usage, signal), so a device
 * started just inside it has both answered or aborted by 80 + 2 x 45 = 170 s.
 * The device's writes and the end-of-tick housekeeping come after that and are
 * not bounded by it. The native-GenAI lane would add a third query; enabling it
 * must revisit these numbers (docs/design/scaling-to-1000-users.md, Phase 1 item 2).
 */
export const JOINER_QUERY_TIMEOUT_S = 40
/**
 * Client-side abort for every joiner query, windowed or not. Set past the server
 * timeout so the service normally answers first with its own error; the abort is
 * the bound when it does not answer at all.
 */
export const JOINER_QUERY_ABORT_MS = 45_000

/*
 * Built per query: AbortSignal.timeout starts counting when it is created, so a
 * signal shared across a device's queries would expire on the second one.
 */
function queryOptions(window?: EventWindow): { serverTimeoutInSeconds: number; abortSignal: AbortSignal } {
  return {
    serverTimeoutInSeconds: window ? WINDOWED_QUERY_TIMEOUT_S : JOINER_QUERY_TIMEOUT_S,
    abortSignal: AbortSignal.timeout(JOINER_QUERY_ABORT_MS),
  }
}

/** The same bound, applied to an already-fetched record's tsEvent. */
export function inEventWindow(tsEvent: string, window?: EventWindow): boolean {
  if (!window) return true
  const t = new Date(tsEvent).getTime()
  return t >= window.from.getTime() && t < window.to.getTime()
}

export interface TelemetryReader {
  /**
   * Token usage for a session, keyed on the tokenscope.instance_id we minted at
   * attest. When `sinceTsEvent` is provided the reader returns ONLY records with
   * an event timestamp strictly newer than `sinceTsEvent - WATERMARK_LOOKBACK_MS`
   * (the high-water-mark incremental read); omit it for a full-window scan
   * (first-ever scan of an instance, no prior attribution).
   *
   * `counters`, when supplied, is FILLED IN PLACE with the ingest-boundary
   * rejects this call made (see ParseCounters) — the same caller-supplied-
   * accumulator shape parseLogAnalyticsRows/parseSignalRows already use, so a
   * caller merges one shape regardless of how many internal lanes a reader
   * queries (LogAnalyticsReader's Claude + native-GenAI lanes both fold into
   * it). A reader that does no ingest-boundary parsing (LocalCollectorReader)
   * simply never touches it — never zeroed, never overwritten.
   *
   * `window`, when supplied, further bounds the read to that event-time slice.
   */
  getSessionUsage(
    sessionId: string,
    sinceTsEvent?: Date,
    counters?: ParseCounters,
    window?: EventWindow,
  ): Promise<UsageRecord[]>
  /**
   * Behavioural usage signals for a session (the NON-billing lane — Copilot
   * tool/MCP/context/turn telemetry). Same high-water-mark semantics as
   * getSessionUsage, and the same caller-supplied `counters` accumulator. OPTIONAL: a
   * reader/store that carries no signals simply omits it (the worker guards with
   * `typeof reader.getSignalUsage === 'function'`), so the runtime guard is honest
   * rather than laundering a missing required member.
   */
  getSignalUsage?(
    sessionId: string,
    sinceTsEvent?: Date,
    counters?: ParseCounters,
    window?: EventWindow,
  ): Promise<SignalRecord[]>
  /** Recent sessions emitted by any of `emails` (the user's Claude identities). */
  listSessions(emails: string[], opts?: { lookbackDays?: number; limit?: number }): Promise<SessionSummary[]>
  /**
   * INGEST-side presence for one instance over the last `hours` — the
   * client-vs-server discriminator (see InstancePresence). Deliberately does NOT
   * apply the watermark, the joinability gates, or any attribution logic: it must
   * report what INGEST holds, independently of everything the joiner does, or it
   * could not contradict the joiner. Implementations resolve (never throw a
   * partial answer); a reader that cannot answer omits the method entirely, and
   * the caller reports the question as unanswerable rather than guessing.
   */
  instancePresence?(instanceId: string, hours: number): Promise<InstancePresence>
  /**
   * Health probe of the telemetry READ path. For Log Analytics this is a
   * BOUNDED READ OF THE REAL TABLE the joiner queries (`OTelLogs | take 1`
   * over a short window) — NOT `print` (ops-alerting ar-H1: `print probe=1`
   * needs no table and passed while `PrivateLinkValidationFailedError` killed
   * every table read; the probe must fail exactly when the joiner would). It
   * therefore exercises DNS → the (AMPLS-private) query endpoint, MI token
   * acceptance AND the table-read grant. An EMPTY result is healthy — the
   * probe asserts readability, not data freshness (that is the
   * attribution-stall condition's job). Resolves (never throws); `timeoutMs`
   * bounds the request (ops-alerting ar-H6 probe budget).
   */
  healthCheck(opts?: { timeoutMs?: number }): Promise<ReaderHealth>
  /**
   * The trailing 24 h's billable ingestion into the telemetry workspace
   * (BILLABLE_INGESTION_LAST_24H_KQL), for the ops-alert telemetry-cap condition. Resolves
   * (never throws); `timeoutMs` bounds the request on both ends, as healthCheck
   * does. A reader that cannot answer returns `megabytes: null`, never 0.
   */
  billableIngestionLast24h(opts?: { timeoutMs?: number }): Promise<IngestionLast24h>
  /**
   * The OUTER scan bound this reader actually applies, in days, or undefined when
   * the concept does not apply to it (the local collector fetches the full set
   * and filters only by watermark). Reported in the joiner result as evidence of
   * what a recovery run really did — computing it a second time at the call site
   * would let the reported window and the applied window diverge, and the whole
   * point of that field is to be trustworthy when a body was silently dropped.
   */
  readonly appliedLookbackDays?: number
}

export class LocalCollectorReader implements TelemetryReader {
  constructor(private readonly endpoint: string) {}

  async healthCheck(opts: { timeoutMs?: number } = {}): Promise<ReaderHealth> {
    // Local collector (dev/test) — confirm the endpoint answers at all.
    const start = Date.now()
    try {
      const res = await resilientFetch(
        `${this.endpoint}/v1/health`,
        {},
        // Caller-bounded probe (ops-alerting ar-H6). Default behaviour when no
        // timeout is passed is unchanged (resilientFetch's own defaults).
        opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs, retries: 0 } : {},
      )
      return { ok: res.ok, kind: 'local', latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` }
    } catch (err) {
      // S8 found + fixed the THROWING path's caller (diagnostics/index.get.ts);
      // this is the SUCCESS-path leak S8 could not fix from that file — this
      // reader RESOLVES with the raw error in its own `error` field, so the
      // caller's try/catch redaction never runs. Same helper, same reason:
      // a raw fetch/network error can carry a host/port an unauthenticated-
      // adjacent admin probe must not leak (feedback_classified_errors_mask_raw_cause
      // — the raw message still goes to the server log, tagged with the
      // correlation id, so nothing is lost to an operator with log access).
      const { reason, correlationId } = classifyProbeError(err, 'telemetry-reader:local-collector')
      return { ok: false, kind: 'local', latencyMs: Date.now() - start, error: reason, correlationId }
    }
  }

  async billableIngestionLast24h(): Promise<IngestionLast24h> {
    // The local collector has no Usage table and no daily cap: unsupported,
    // which the caller reads as "unknown", not as zero ingestion.
    return { megabytes: null, kind: 'local', latencyMs: 0, error: 'unsupported' }
  }

  async getSessionUsage(
    sessionId: string,
    sinceTsEvent?: Date,
    _counters?: ParseCounters,
    window?: EventWindow,
  ): Promise<UsageRecord[]> {
    assertSafeSessionId(sessionId)
    const res = await resilientFetch(
      `${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/usage`,
    )
    if (!res.ok) {
      throw new Error(`telemetry store GET usage HTTP ${res.status}`)
    }
    const usage = SessionUsage.parse(await res.json()).usage.filter((u) => inEventWindow(u.tsEvent, window))
    // High-water-mark incremental read: the local store returns the full usage
    // set, so filter client-side to events strictly newer than the watermark
    // minus the lookback. Without a watermark this is the full set (unchanged).
    if (!sinceTsEvent) return usage
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return usage.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }

  async getSignalUsage(_sessionId: string, _sinceTsEvent?: Date): Promise<SignalRecord[]> {
    // The local collector store does not carry Copilot behavioural signals; the
    // signal lane is exercised only against Log Analytics (dev/sandbox). Returning
    // [] keeps the worker's per-instance signal read a harmless no-op locally.
    return []
  }

  async instancePresence(instanceId: string, hours: number): Promise<InstancePresence> {
    // The local store has no ingest/attribution split to discriminate BETWEEN —
    // there is one collector-fed store and the joiner reads it directly. So this
    // answers the same question the LAW implementation does, from the only source
    // that exists here: the full (un-watermarked) usage set, windowed. It exists
    // so local/dev exercises the same code path rather than a stub, NOT because
    // the local answer carries the same diagnostic weight.
    assertSafeSessionId(instanceId)
    const usage = await this.getSessionUsage(instanceId)
    const cutoff = Date.now() - Math.max(Math.floor(hours), 1) * 3600_000
    const inWindow = usage.filter((u) => {
      const t = new Date(u.tsEvent).getTime()
      return Number.isFinite(t) && t >= cutoff
    })
    const times = inWindow.map((u) => new Date(u.tsEvent).getTime()).sort((a, b) => a - b)
    return {
      records: inWindow.length,
      // Every record the local store returns IS a usage record (it only carries
      // token rows), so the two counts coincide here by construction.
      usageRecords: inWindow.length,
      firstSeen: times.length ? new Date(times[0]!).toISOString() : null,
      lastSeen: times.length ? new Date(times[times.length - 1]!).toISOString() : null,
    }
  }

  async listSessions(
    emails: string[],
    opts: { lookbackDays?: number; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    if (emails.length === 0) return []
    const params = new URLSearchParams()
    for (const e of emails) params.append('email', e)
    if (opts.lookbackDays) params.set('lookbackDays', String(opts.lookbackDays))
    if (opts.limit) params.set('limit', String(opts.limit))
    const res = await resilientFetch(`${this.endpoint}/v1/sessions?${params.toString()}`)
    if (!res.ok) throw new Error(`telemetry store GET sessions HTTP ${res.status}`)
    return SessionSummaryListSchema.parse(await res.json()).sessions
  }
}

/*
 * Sandbox (ADR-0003): Claude emits OTLP DIRECTLY to the Azure Monitor
 * OTLP-preview endpoint (DCE-fronted) — NO collector on the Claude path —
 * landing in Log Analytics; we query the workspace via @azure/monitor-query
 * KQL, authenticated by the container app's user-assigned MI (@azure/identity
 * DefaultAzureCredential). The SDK is dynamically imported so local dev /
 * tests never load the Azure SDK. (Only Copilot uses a tenant bridge;
 * collector-fronting is the ADR's documented fallback, not the Claude path.)
 *
 * The KQL below is VERIFIED against the live sandbox (2026-06-01; see the
 * "Verified OTLP → Azure Monitor ingestion recipe" in
 * docs/development/claude-code-telemetry-contract.md): Claude's OTLP
 * api_request log event lands in the OTelLogs table with our injected
 * resource attributes in the `ResourceAttributes` dynamic column and the
 * per-event token fields in the `Attributes` dynamic column. The stream
 * segment on the ingest URL is the service-managed `Microsoft-OTLP-Logs`.
 * The KQL projects a fixed column set (one row per token type), and
 * parseLogAnalyticsRows() maps that set to UsageRecords — that mapping is
 * pure + unit-tested independent of Azure.
 */
// SINGLE source of truth for the final `| project` columns: the KQL clause is
// GENERATED from this map (name → expression), and the key order doubles as
// the positional fallback when a result table carries no column descriptors.
// The two can no longer drift — the previous hand-mirrored list silently
// omitted ClaudeSessionId, misaligning Backfill/NanoAiu on the fallback path.
export const KQL_PROJECTED_COLUMNS = {
  TokenscopeSessionId: '_sid',
  Model: '_model',
  TokenType: 'TokenType',
  Tokens: 'tolong(Tokens)',
  TsEvent: '_ts',
  SourceRunId: '_req',
  OrganizationId: '_org',
  ProjectCodeHash: '_proj',
  Activity: '_act',
  ClaudeSessionId: '_csid',
  Backfill: '_backfill',
  NanoAiu: '_nano_aiu',
  QuerySource: '_qsrc',
  LawCostUsd: '_law_cost',
  // Claude's per-event `user.email` (mig 0119) — WHICH ACCOUNT was signed in,
  // as opposed to which device emitted. The joiner compares it against the
  // teammate's enterprise address set to stamp attribution_record.billing_lane.
  // It is NEVER an attribution key: money binds to tokenscope.instance_id.
  UserEmail: '_uemail',
} as const

const KQL_PROJECTION = Object.keys(KQL_PROJECTED_COLUMNS)

function kqlFinalProjectClause(): string {
  return Object.entries(KQL_PROJECTED_COLUMNS)
    .map(([name, expr]) => (name === expr ? name : `${name} = ${expr}`))
    .join(', ')
}

// Exported for tests ONLY — mirroring buildSessionUsageKqlGenAI below. The
// final `| project` is generated from KQL_PROJECTED_COLUMNS, but the
// INTERMEDIATE `| project` that has to carry each alias through is hand-written,
// so the two can still drift; a dropped alias is a query-time failure that no
// stubbed-reader test can reach. tests/unit/server/log-analytics-parser.test.ts
// pins the two against each other.
export function buildSessionUsageKql(sessionId: string, sinceTsEvent?: Date, window?: EventWindow): string {
  // VERIFIED landing shape (live sandbox, OTelLogs table):
  //   - our resource attrs (tokenscope.instance_id, project.code_hash, tool)
  //     → ResourceAttributes dynamic column
  //   - api_request event name → Attributes['event.name'] (Body also carries it)
  //   - the four token counts + model/request_id → Attributes
  // sessionId is our minted join key (== instance_attestation.instance_id).
  //
  // High-water-mark incremental read: when a watermark is supplied, bound on
  // TimeGenerated (the event timestamp we project as TsEvent) strictly newer
  // than watermark - WATERMARK_LOOKBACK_MS, so the per-tick scan is bounded by
  // new emission instead of the instance's lifetime history. The lookback +
  // the joiner's onConflictDoNothing dedup absorb minor out-of-order ingestion.
  // The cutoff is an ISO-8601 instant we control (not user input) — safe to
  // interpolate into datetime().
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  return `
    OTelLogs
    | where tostring(Attributes['event.name']) == 'api_request' or Body == 'api_request'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    ${eventWindowClause(window)}
    | extend _model = tostring(Attributes['model']),
             _req = tostring(Attributes['request_id']),
             _org = tostring(Attributes['organization.id']),
             _proj = tostring(ResourceAttributes['project.code_hash']),
             _act = tostring(ResourceAttributes['tokenscope.activity']),
             _csid = tostring(Attributes['session.id']),
             _backfill = tostring(ResourceAttributes['tokenscope.backfill']),
             _nano_aiu = todouble(Attributes['github.copilot.nano_aiu']),
             _qsrc = tostring(Attributes['query_source']),
             _law_cost = todouble(Attributes['cost_usd']),
             // mig 0119 — the EMITTING ACCOUNT. Absent/toggled-off emission
             // yields '' here, which the parser reads as "no address" and the
             // joiner stamps billing_lane='unknown' (== today's behaviour).
             _uemail = tostring(Attributes['user.email']),
             _ts = TimeGenerated
    | project _sid = tostring(ResourceAttributes['tokenscope.instance_id']), _model, _req, _org, _proj, _act, _csid, _backfill, _ts, _nano_aiu, _qsrc, _law_cost, _uemail,
              _input = tolong(Attributes['input_tokens']),
              _output = tolong(Attributes['output_tokens']),
              _cread = tolong(Attributes['cache_read_tokens']),
              _ccreate = tolong(Attributes['cache_creation_tokens'])
    | mv-expand TokenType = dynamic(['input','output','cache-read','cache-write']) to typeof(string),
                Tokens = pack_array(_input, _output, _cread, _ccreate) to typeof(long)
    | where Tokens > 0
    | project ${kqlFinalProjectClause()}
  `.trim()
}

/*
 * ── NATIVE GitHub Copilot OTel (GenAI semantic conventions) — read-side ──────
 *
 * GitHub shipped enterprise-managed OTLP export for Copilot Chat (VS Code) +
 * Copilot CLI (2026-07-08). It emits GenAI-semantic-convention telemetry
 * (gen_ai.usage.*, gen_ai.request.model) natively — no client forwarder,
 * transcoder, or bearer shim. The renewed design (docs/decisions/
 * 0009-...-addendum) is: native managed OTLP → Azure LAW ingestion DIRECTLY,
 * joined on OUR injected `tokenscope.instance_id` resource attribute (the SAME
 * key Claude uses), so one instance's Claude + Copilot usage unify through the
 * existing joiner + attribution_record — no new identity primitive.
 *
 * This is the READ-SIDE only, gated OFF by default (NUXT_COPILOT_NATIVE_OTEL).
 * It is DORMANT until the durable-auth + landing-shape spike (SPK-COPILOT-OTEL,
 * docs/build/copilot-native-otel-spike.md) confirms the two live-gated
 * assumptions marked SPIKE-CONFIRM below. Nothing here touches the live path.
 *
 * §A/§B: this is USAGE (§A) — tokens + model. Native GenAI carries NO AI
 * credits (nano_aiu) and no authoritative $, so cost stays §B (the pooled
 * bill). These rows carry tokens only; costing is deliberately unchanged.
 */

// The gen_ai.usage.* → rate_line unit mapping. SINGLE source of truth for both
// the KQL projection and the tests. `reasoning.output_tokens` is DELIBERATELY
// absent: per the GenAI convention it is a SUBSET of output_tokens (the
// "thinking" portion), so emitting it as a separate row would double-count.
// SPIKE-CONFIRM: whether cache_read is a subset of input_tokens (double-count
// risk) — modelled 1:1 here, mirroring Claude's proven 4-count api_request
// shape; confirm against live Copilot→LAW data before enabling.
export const GENAI_TOKEN_UNIT_MAP: ReadonlyArray<{ unit: string; attr: string }> = [
  { unit: 'input', attr: 'gen_ai.usage.input_tokens' },
  { unit: 'output', attr: 'gen_ai.usage.output_tokens' },
  { unit: 'cache-read', attr: 'gen_ai.usage.cache_read.input_tokens' },
  { unit: 'cache-write', attr: 'gen_ai.usage.cache_creation.input_tokens' },
]

// SPIKE-CONFIRM (SPK-COPILOT-OTEL): the LAW table native GenAI spans land in.
// Defaulted to OTelLogs (the verified Claude landing table) on the assumption
// Azure Monitor OTLP ingestion lands them there as log records; the live spike
// must confirm this vs a traces table. If it differs, ONLY this const + the
// attribute-column names change — the projected columns + parseLogAnalyticsRows
// + the whole downstream pipeline are unchanged.
const GENAI_LAW_TABLE = 'OTelLogs'
// SPIKE-CONFIRM: the operation carrying the authoritative token counts. We
// filter to the LLM `chat` call so agent/tool spans don't double-count the
// same turn's tokens (the guard the client transcoder needed for chat vs
// invoke_agent).
const GENAI_OPERATION = 'chat'

/** True when the native-Copilot GenAI read-side is enabled (default OFF). Read
 *  at call time so tests + a runtime flip don't need a restart. */
export function copilotNativeOtelEnabled(): boolean {
  return process.env.NUXT_COPILOT_NATIVE_OTEL === 'true'
}

/**
 * KQL for a session's native GenAI token usage, projected into the EXACT SAME
 * columns as buildSessionUsageKql so parseLogAnalyticsRows is reused unchanged.
 * Join key is our `tokenscope.instance_id` resource attribute (same as Claude).
 * GenAI-absent fields (org id, nano_aiu, cost, backfill, query_source) project
 * empty. sessionId is our minted join key; same charset guard + watermark.
 */
export function buildSessionUsageKqlGenAI(sessionId: string, sinceTsEvent?: Date, window?: EventWindow): string {
  // Defense-in-depth (ING-10): self-guard the interpolated id even though the
  // sole caller pre-validates — this builder is exported, so a future direct
  // caller must not be able to reopen the KQL-injection hole.
  assertSafeSessionId(sessionId)
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  // Build the mv-expand token-type + value arrays FROM the single-source map,
  // so the mapping can't drift from the tests.
  const tokenTypes = GENAI_TOKEN_UNIT_MAP.map((m) => `'${m.unit}'`).join(',')
  const tokenExtracts = GENAI_TOKEN_UNIT_MAP.map((m, i) => `_t${i} = tolong(Attributes['${m.attr}'])`).join(',\n             ')
  const tokenArray = GENAI_TOKEN_UNIT_MAP.map((_, i) => `_t${i}`).join(', ')
  return `
    ${GENAI_LAW_TABLE}
    | where tostring(Attributes['gen_ai.operation.name']) == '${GENAI_OPERATION}'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    ${eventWindowClause(window)}
    | extend _model = coalesce(tostring(Attributes['gen_ai.response.model']), tostring(Attributes['gen_ai.request.model'])),
             _req = tostring(Attributes['gen_ai.response.id']),
             _org = '',
             _proj = tostring(ResourceAttributes['project.code_hash']),
             _act = tostring(ResourceAttributes['tokenscope.activity']),
             _csid = tostring(Attributes['gen_ai.conversation.id']),
             _backfill = '',
             _nano_aiu = todouble(''),
             _qsrc = '',
             _law_cost = todouble(''),
             _uemail = '',
             _ts = TimeGenerated,
             ${tokenExtracts}
    | project _sid = tostring(ResourceAttributes['tokenscope.instance_id']), _model, _req, _org, _proj, _act, _csid, _backfill, _ts, _nano_aiu, _qsrc, _law_cost, _uemail, ${tokenArray}
    | mv-expand TokenType = dynamic([${tokenTypes}]) to typeof(string),
                Tokens = pack_array(${tokenArray}) to typeof(long)
    | where Tokens > 0
    | project ${kqlFinalProjectClause()}
  `.trim()
}

/*
 * ── Ingest bounds — what the emitter controls, bounded before it reaches a
 *    text column that participates in an index ──────────────────────────────
 *
 * claude_session_id, model and source_run_id all participate in
 * attribution_record's unique index (migrations 0011+0017+0035, restated at
 * 0055_attribution_partition.sql:101-102 as `(instance_id,
 * COALESCE(claude_session_id,''), ts_event, token_type, model,
 * COALESCE(source_run_id,''))`; claude_session_id alone participates in FOUR
 * indexes total — 0055:101-102,103,109,112). project.code_hash is on no
 * attribution_record index, but is bounded for the same underlying reason
 * every emitter-controlled string is: an untrusted emit credential
 * (heartbeat-coverage.ts's documented threat model) can put ANY string into a
 * `text` column, and an oversized one is either an index-tuple write failure
 * waiting to wedge a session's attribution (ING-6 retries the SAME poisoned
 * row every tick) or an admin-surface rendering hazard.
 *
 * Modelled on client-version.ts:40-74 — a MAX length constant, length checked
 * BEFORE the regex, and REJECT rather than truncate ("a truncated value reads
 * as a real wrong value, which is worse than not reported").
 *
 * THE MAX CONSTANTS ARE SIZED FROM WHAT THE VALUE IS, NOT FROM POSTGRES'S
 * 2704. That number is btree BTMaxItemSize for the WHOLE INDEX TUPLE (six
 * columns share it), not a per-column budget — using it here would be
 * borrowing an unrelated invariant. Each bound below is justified by the
 * value's own shape, with generous headroom:
 */
/** Claude's session.id is a UUID (36 chars); generous headroom for a future format. */
export const MAX_CLAUDE_SESSION_ID_LENGTH = 128
/** A request/run identifier — the same identifier class as claudeSessionId. */
export const MAX_SOURCE_RUN_ID_LENGTH = 128
/** A vendor model string — a few dozen chars today (e.g. `claude-opus-4-8`); ample. */
export const MAX_MODEL_LENGTH = 256
/** A hex SHA-256 digest is 64 chars; headroom for a future hash algorithm. */
export const MAX_PROJECT_CODE_HASH_LENGTH = 128
/**
 * RFC 5321's maximum forward-path is 256 including the angle brackets, i.e. 254
 * addressable characters; 320 (64 local + @ + 255 domain) is the commonly-cited
 * upper bound and is the generous one, so use it. Sized from what the value IS,
 * per the note above — not from an index budget: emitting_email is on no index.
 */
export const MAX_EMITTING_EMAIL_LENGTH = 320
/**
 * A provider organization id — Anthropic's is UUID-shaped today. Same
 * identifier class as sourceRunId, so the same bound.
 */
export const MAX_ORGANIZATION_ID_LENGTH = 128

/*
 * Percent-encoded UTF-8 is at most 12 characters per code point ("%F0%9F%98%80"),
 * so anything longer cannot decode to a label within ACTIVITY_LABEL_MAX: reject
 * it before decoding.
 */
const MAX_ACTIVITY_RAW_LENGTH = ACTIVITY_LABEL_MAX * 12

/**
 * Bound the emitted tokenscope.activity. OTEL_RESOURCE_ATTRIBUTES values are
 * percent-encoded; an SDK normally decodes them, so `%xx` is decoded only when
 * present. Surrounding whitespace is trimmed; a blank value is absent (''), not
 * a reject. Returns null to REJECT (bad encoding, too long, control characters).
 */
export function boundActivityLabel(raw: string): string | null {
  if (raw.length > MAX_ACTIVITY_RAW_LENGTH) return null
  let decoded = raw
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return null
    }
  }
  const label = decoded.trim()
  if ([...label].length > ACTIVITY_LABEL_MAX) return null
  if (!DISPLAY_TEXT_RE.test(label)) return null
  return label
}

/*
 * claudeSessionId / sourceRunId are OUR OWN identifier shapes (Claude's
 * session.id / request_id) — a conservative charset: alphanumeric plus the
 * identifier punctuation actually observed (hyphen for UUIDs, underscore for
 * req_/resp_-prefixed ids).
 */
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/*
 * model / projectCodeHash are VENDOR strings — a model name, a repo's
 * committed .tokenscope hash — whose future shape is not ours to constrain.
 * Bound only length + control characters: the things that could let a
 * claimed "model" render as something else in an operator console / CSV /
 * admin table. Unicode, punctuation and spaces all pass through unchanged.
 * Excludes C0 controls (0x00-0x1F) and DEL (0x7F).
 */
// eslint-disable-next-line no-control-regex -- INTENTIONAL, see the doc above: the whole point is to detect/exclude control characters.
const NO_CONTROL_CHARS_RE = /^[^\x00-\x1F\x7F]*$/

/** Bound one emitter-controlled string. Returns null to REJECT — never truncates. */
function boundIdentifier(raw: string, maxLen: number, charset: RegExp): string | null {
  // Length checked BEFORE the regex (client-version.ts's stated order): keeps
  // a pathological value cheap to reject regardless of the regex's cost.
  if (raw.length > maxLen) return null
  if (!charset.test(raw)) return null
  return raw
}

/**
 * Per-call counts of what the ingest boundary rejected — the counter side of
 * the bounds above, and the non-negotiable half of this story: bounds WITHOUT
 * a counter that reaches the caller are strictly worse than no bounds at all,
 * because a too-strict regex then drops real spend with no signal anywhere.
 *
 * `skippedNoTimestamp` predates this story (ING-9). The four `rejected*`
 * fields count an OPTIONAL field dropped from an otherwise-kept record
 * (claudeSessionId, sourceRunId, projectCodeHash — the record is still
 * written, just as if the emitter had not reported that field) versus
 * `rejectedModel`, which counts a WHOLE ROW skipped: model is REQUIRED
 * (attribution_record.model NOT NULL, and part of the unique index), so an
 * unsafe value cannot be safely stored at all and the row is dropped exactly
 * like a missing timestamp — under-reporting beats writing a mangled value.
 *
 * Exported + shared by BOTH parsers (parseLogAnalyticsRows, parseSignalRows)
 * and by TelemetryReader.getSessionUsage/getSignalUsage's caller-supplied
 * `counters` parameter, so ALL lanes (Claude, native-GenAI, signals) fold
 * into the one shape the joiner surfaces on JoinResult.
 */
export interface ParseCounters {
  skippedNoTimestamp: number
  rejectedClaudeSessionId: number
  rejectedModel: number
  rejectedProjectCodeHash: number
  /** An optional-field drop: tokenscope.activity failed boundActivityLabel. */
  rejectedActivity: number
  rejectedSourceRunId: number
  /**
   * mig 0119. An OPTIONAL-field drop (the record is still written, with
   * emitting_email NULL → billing_lane 'unknown' → today's behaviour). It is
   * NOT the `model` shape: a lane we cannot decide is a lane we say we cannot
   * decide, never a reason to drop spend.
   */
  rejectedEmittingEmail: number
  /**
   * mig 0119. Counts an organization.id too long / too unsafe to STORE as
   * attribution_record.emitting_org_id, so `UsageRecord.emittingOrgId` is
   * dropped.
   *
   * NO KNOCK-ON TO THE LANE. `UsageRecord.organizationId` keeps the raw value
   * and the org-lane decision still reads that, so a rejection here costs the
   * diagnostic column and nothing else. An earlier revision of this comment
   * claimed the record "falls to tier-2 / telemetry-only and raises
   * attribution-org-unclassified"; it was wrong in both directions — with the
   * field dropped the joiner's `if (!isCopilot && orgId)` never fires, so
   * nothing is audited and the record keeps the tier-1/estimated DEFAULT, which
   * would have PROMOTED an `indicative` org's spend into reconciliation.
   */
  rejectedOrganizationId: number
}

export function emptyParseCounters(): ParseCounters {
  return {
    skippedNoTimestamp: 0,
    rejectedClaudeSessionId: 0,
    rejectedModel: 0,
    rejectedProjectCodeHash: 0,
    rejectedActivity: 0,
    rejectedSourceRunId: 0,
    rejectedEmittingEmail: 0,
    rejectedOrganizationId: 0,
  }
}

/** Fold `source` into `target` in place — merges a lane's local counters into the one the caller (the joiner) surfaces on JoinResult. */
export function mergeParseCounters(target: ParseCounters, source: ParseCounters): void {
  target.skippedNoTimestamp += source.skippedNoTimestamp
  target.rejectedClaudeSessionId += source.rejectedClaudeSessionId
  target.rejectedModel += source.rejectedModel
  target.rejectedProjectCodeHash += source.rejectedProjectCodeHash
  target.rejectedActivity += source.rejectedActivity
  target.rejectedSourceRunId += source.rejectedSourceRunId
  target.rejectedEmittingEmail += source.rejectedEmittingEmail
  target.rejectedOrganizationId += source.rejectedOrganizationId
}

/**
 * Pure mapper: a Log Analytics result table (column names + rows) →
 * UsageRecords. Column-name keyed so projection order doesn't matter.
 * Skips rows missing a token type or with non-positive tokens.
 *
 * Rows with a missing/unparseable TsEvent are SKIPPED and counted into
 * `counters.skippedNoTimestamp` (ING-9). Fabricating `now()` here gave such a
 * row a DIFFERENT synthetic timestamp every tick, so the dedup index
 * (instance_id, claude_session_id, ts_event, token_type, model, source_run_id)
 * never matched and the same event was re-attributed every read.
 *
 * An unsafe model (over-length or a control character) SKIPS the row the same
 * way, counted into `counters.rejectedModel` — see ParseCounters. An unsafe
 * claudeSessionId/sourceRunId/projectCodeHash/activity DROPS ONLY THAT FIELD (the
 * record is still written, as if the emitter had not reported it), counted
 * into the matching `counters.rejected*`.
 */
export function parseLogAnalyticsRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  counters?: ParseCounters,
): UsageRecord[] {
  const idx = (name: string) => columnNames.indexOf(name)
  const iType = idx('TokenType')
  const iTokens = idx('Tokens')
  const iModel = idx('Model')
  const iTs = idx('TsEvent')
  const iRun = idx('SourceRunId')
  const iOrg = idx('OrganizationId')
  const iProj = idx('ProjectCodeHash')
  const iAct = idx('Activity')
  const iCsid = idx('ClaudeSessionId')
  const iBackfill = idx('Backfill')
  const iNanoAiu = idx('NanoAiu')
  const iQuerySource = idx('QuerySource')
  const iLawCost = idx('LawCostUsd')
  const iUserEmail = idx('UserEmail')
  const out: UsageRecord[] = []
  for (const row of rows) {
    const tokenType = iType >= 0 ? String(row[iType] ?? '') : ''
    const tokens = iTokens >= 0 ? Number(row[iTokens] ?? 0) : 0
    if (!tokenType || !Number.isFinite(tokens) || tokens <= 0) continue
    const tsRaw = iTs >= 0 ? row[iTs] : null
    let tsEvent: string
    if (tsRaw instanceof Date && Number.isFinite(tsRaw.getTime())) {
      tsEvent = tsRaw.toISOString()
    } else if (tsRaw != null && String(tsRaw) && Number.isFinite(new Date(String(tsRaw)).getTime())) {
      tsEvent = String(tsRaw)
    } else {
      // No parseable event timestamp → skip + count, never fabricate one (ING-9).
      if (counters) counters.skippedNoTimestamp += 1
      continue
    }
    // model is REQUIRED — see ParseCounters's doc on why an unsafe value skips
    // the whole row rather than dropping just this field.
    const modelRaw = iModel >= 0 ? String(row[iModel] ?? 'unknown') : 'unknown'
    const model = boundIdentifier(modelRaw, MAX_MODEL_LENGTH, NO_CONTROL_CHARS_RE)
    if (model === null) {
      if (counters) counters.rejectedModel += 1
      continue
    }
    const rec: UsageRecord = {
      tokens: Math.trunc(tokens),
      tokenType,
      model,
      tsEvent,
    }
    const run = iRun >= 0 ? row[iRun] : null
    if (run != null && String(run)) {
      const bounded = boundIdentifier(String(run), MAX_SOURCE_RUN_ID_LENGTH, SAFE_IDENTIFIER_RE)
      if (bounded !== null) rec.sourceRunId = bounded
      else if (counters) counters.rejectedSourceRunId += 1
    }
    /*
     * TWO FIELDS FROM ONE VALUE, and the split is the point.
     *
     * organizationId sits OUTSIDE the bound surface, exactly as it did before
     * mig 0119, because it decides the reconciliation LANE via provider_org and
     * is never stored — it is a query parameter, not a column. Bounding it would
     * silently move an existing record's lane: an over-long-but-harmless org id
     * would stop matching its registered provider_org, and an `indicative` org's
     * spend would be PROMOTED to tier-1/estimated by the joiner's default. A new
     * diagnostic column's storage bound must not change a reconciliation figure.
     *
     * emittingOrgId is the value that IS persisted
     * (attribution_record.emitting_org_id), so it takes the bound. Optional-field
     * shape — an unsafe value drops the FIELD and keeps the row, and because the
     * lane reads the raw field the drop costs nothing but the diagnostic.
     */
    const org = iOrg >= 0 ? row[iOrg] : null
    if (org != null && String(org)) {
      rec.organizationId = String(org)
      const bounded = boundIdentifier(String(org), MAX_ORGANIZATION_ID_LENGTH, NO_CONTROL_CHARS_RE)
      if (bounded !== null) rec.emittingOrgId = bounded
      else if (counters) counters.rejectedOrganizationId += 1
    }
    const proj = iProj >= 0 ? row[iProj] : null
    if (proj != null && String(proj)) {
      const bounded = boundIdentifier(String(proj), MAX_PROJECT_CODE_HASH_LENGTH, NO_CONTROL_CHARS_RE)
      if (bounded !== null) rec.projectCodeHash = bounded
      else if (counters) counters.rejectedProjectCodeHash += 1
    }
    const act = iAct >= 0 ? row[iAct] : null
    if (act != null && String(act)) {
      const label = boundActivityLabel(String(act))
      if (label === null) {
        if (counters) counters.rejectedActivity += 1
      } else if (label) {
        rec.activity = label
      }
    }
    const csid = iCsid >= 0 ? row[iCsid] : null
    if (csid != null && String(csid)) {
      const bounded = boundIdentifier(String(csid), MAX_CLAUDE_SESSION_ID_LENGTH, SAFE_IDENTIFIER_RE)
      if (bounded !== null) rec.claudeSessionId = bounded
      else if (counters) counters.rejectedClaudeSessionId += 1
    }
    const backfill = iBackfill >= 0 ? row[iBackfill] : null
    if (backfill != null && String(backfill).toLowerCase() === 'true') rec.backfill = true
    const nanoAiu = iNanoAiu >= 0 ? row[iNanoAiu] : null
    if (nanoAiu != null && nanoAiu !== '' && Number.isFinite(Number(nanoAiu))) {
      rec.nanoAiu = Number(nanoAiu)
    }
    const qsrc = iQuerySource >= 0 ? row[iQuerySource] : null
    if (qsrc != null && String(qsrc)) rec.querySource = String(qsrc)
    const lawCost = iLawCost >= 0 ? row[iLawCost] : null
    if (lawCost != null && lawCost !== '' && Number.isFinite(Number(lawCost))) {
      rec.lawCostUsd = Number(lawCost)
    }
    /*
     * The EMITTING ACCOUNT (mig 0119). Optional-field shape, deliberately:
     * an unsafe address drops the FIELD and keeps the row, so the joiner stamps
     * billing_lane='unknown' and the record behaves exactly as it did before
     * this column existed. The `model` shape (drop the whole row) would be
     * wrong here — model is NOT NULL and inside the dedup index, this is
     * neither, and losing spend to protect a classification would be a strictly
     * worse trade than declining to classify.
     *
     * CANONICALISED AT STORAGE, not at comparison alone: canon() is applied on
     * BOTH sides of the membership test (§2), and doing it once here means no
     * downstream consumer can forget. Bound BEFORE canonicalising so the length
     * check sees what the emitter actually sent.
     *
     * A value that canonicalises to '' (all whitespace) is treated as absent,
     * not as an address that failed to match — the two mean different things.
     */
    const uemail = iUserEmail >= 0 ? row[iUserEmail] : null
    if (uemail != null && String(uemail)) {
      const bounded = boundIdentifier(String(uemail), MAX_EMITTING_EMAIL_LENGTH, NO_CONTROL_CHARS_RE)
      if (bounded === null) {
        if (counters) counters.rejectedEmittingEmail += 1
      } else {
        const canon = canonicaliseEmail(bounded)
        if (canon) rec.emittingEmail = canon
      }
    }
    out.push(rec)
  }
  return out
}

/**
 * KQL: a session's behavioural usage-signal records (event.name='usage_signal').
 * DISJOINT from the token query (which filters api_request + Tokens>0) — a signal
 * record carries NO token attrs, so the two streams never overlap. Projects one
 * row per usage_signal span with the sig.* columns; parseSignalRows flattens each
 * to one SignalRecord per present signal. sessionId == tokenscope.instance_id;
 * same charset guard + watermark-lookback as buildSessionUsageKql.
 */
export function buildSignalUsageKql(sessionId: string, sinceTsEvent?: Date, window?: EventWindow): string {
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  const sigProject = Object.entries(SIGNAL_WIRE_COLUMNS)
    .map(([name, wire]) => `${name} = todouble(Attributes['${wire}'])`)
    .join(',\n             ')
  return `
    OTelLogs
    | where tostring(Attributes['event.name']) == 'usage_signal' or Body == 'usage_signal'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    ${eventWindowClause(window)}
    | project _ts = TimeGenerated,
             _req = tostring(Attributes['request_id']),
             ${sigProject}
  `.trim()
}

/**
 * Pure mapper: a Log Analytics usage_signal table → SignalRecord[]. Column-keyed,
 * so projection order doesn't matter. Each row (one span) yields one SignalRecord
 * per PRESENT signal — a null/NaN/absent sig column is simply skipped (a chat span
 * has no mcp_count, an invoke_agent span no ctx_pct). Rows with no parseable
 * timestamp are skipped + counted (ING-9 parity with parseLogAnalyticsRows).
 *
 * SIBLING of parseLogAnalyticsRows: takes the SAME `counters` shape (ParseCounters)
 * and applies the SAME bound to sourceRunId (an identical identifier class to
 * parseLogAnalyticsRows's — dropped from the record, counted, never rejects the
 * row, since sourceRunId is optional here too).
 */
export function parseSignalRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  counters?: ParseCounters,
): SignalRecord[] {
  const idx = (n: string) => columnNames.indexOf(n)
  const iTs = idx('_ts')
  const iReq = idx('_req')
  const signalIdx = Object.keys(SIGNAL_WIRE_COLUMNS).map((name) => [name, idx(name)] as const)
  const out: SignalRecord[] = []
  for (const row of rows) {
    const tsRaw = iTs >= 0 ? row[iTs] : null
    let tsEvent: string
    if (tsRaw instanceof Date && Number.isFinite(tsRaw.getTime())) {
      tsEvent = tsRaw.toISOString()
    } else if (tsRaw != null && String(tsRaw) && Number.isFinite(new Date(String(tsRaw)).getTime())) {
      tsEvent = String(tsRaw)
    } else {
      if (counters) counters.skippedNoTimestamp += 1
      continue
    }
    const runRaw = iReq >= 0 ? row[iReq] : null
    let sourceRunId: string | undefined
    if (runRaw != null && String(runRaw)) {
      const bounded = boundIdentifier(String(runRaw), MAX_SOURCE_RUN_ID_LENGTH, SAFE_IDENTIFIER_RE)
      if (bounded !== null) sourceRunId = bounded
      else if (counters) counters.rejectedSourceRunId += 1
    }
    for (const [name, ci] of signalIdx) {
      if (ci < 0) continue
      const raw = row[ci]
      if (raw == null || raw === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) continue
      out.push({ signalName: name, value, tsEvent, ...(sourceRunId ? { sourceRunId } : {}) })
    }
  }
  return out
}

/*
 * ── The client-vs-server discriminator ───────────────────────────────────────
 *
 * KQL for "what did INGEST see for this instance over the last N hours". No
 * event-name filter on the outer count (the question is whether ANYTHING arrived)
 * and no watermark (the question is about ingest, not about our read cursor).
 *
 * `summarize` with no `by` is a scalar aggregation, so it returns exactly one row
 * even when the input is empty — Records=0, FirstSeen/LastSeen null. That matters:
 * an empty RESULT TABLE and a row of zeroes must not be conflated, because the
 * former can also mean the query failed to run.
 *
 * instanceId is charset-guarded by the caller (assertSafeSessionId) before it is
 * interpolated; hours is clamped to an integer. No caller-supplied KQL.
 */
export function buildInstancePresenceKql(instanceId: string, hours: number): string {
  const h = Math.min(Math.max(Math.floor(hours), 1), 24 * 90)
  return `
    OTelLogs
    | where TimeGenerated > ago(${h}h)
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${instanceId}'
    | summarize Records = count(),
                UsageRecords = countif(tostring(Attributes['event.name']) == 'api_request' or tostring(Body) == 'api_request'),
                FirstSeen = min(TimeGenerated),
                LastSeen = max(TimeGenerated)
  `.trim()
}

/**
 * Pure mapper: the single-row presence table → InstancePresence. Column-keyed, so
 * projection order does not matter. Returns all-zero/null for an empty table —
 * the caller decides whether that is "nothing arrived" or "the query returned
 * nothing usable", because only it knows whether the query succeeded.
 */
export function parseInstancePresenceRow(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): InstancePresence {
  const row = rows[0]
  const idx = (n: string) => columnNames.indexOf(n)
  const num = (n: string): number => {
    const i = idx(n)
    if (!row || i < 0) return 0
    const v = Number(row[i] ?? 0)
    return Number.isFinite(v) ? Math.trunc(v) : 0
  }
  const iso = (n: string): string | null => {
    const i = idx(n)
    if (!row || i < 0) return null
    const v = row[i]
    if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString()
    if (v != null && String(v) && Number.isFinite(new Date(String(v)).getTime())) return String(v)
    return null
  }
  return {
    records: num('Records'),
    usageRecords: num('UsageRecords'),
    firstSeen: iso('FirstSeen'),
    lastSeen: iso('LastSeen'),
  }
}

/**
 * Positional fallback for parseInstancePresenceRow, used when a result table
 * carries no column descriptors. MUST match buildInstancePresenceKql's summarize
 * order. Exported so a contract test can pin the two together: the sibling
 * KQL_PROJECTED_COLUMNS list drifted from its query exactly this way once (a
 * hand-mirrored list silently omitted a column and misaligned every field after
 * it), and here a misalignment would swap the record COUNT for a TIMESTAMP and
 * hand the operator a fabricated verdict.
 */
export const PRESENCE_KQL_PROJECTION = ['Records', 'UsageRecords', 'FirstSeen', 'LastSeen'] as const

/** KQL: summarise OTel sessions emitted by any of `emails` (per-event user.email). */
function buildListSessionsKql(emails: string[], lookbackDays: number, limit: number): string {
  // R3 (defense-in-depth): drop any email carrying a quote or backslash — those
  // can't be a valid email and are the only KQL string-literal break-out chars.
  // Identities are charset-constrained at write time; this guards the remaining
  // teammate.email (Entra-asserted) path too.
  const inList = emails
    .filter((e) => !/['\\]/.test(e))
    .map((e) => `'${e}'`)
    .join(', ')
  // §13: group by Claude's own per-conversation session.id (Attributes), NOT the
  // tokenscope.instance_id (ResourceAttributes), so sibling conversations on one
  // shared instance are summarised SEPARATELY. The instance id is carried
  // alongside (take_any — a conversation belongs to one instance) so the worklist
  // can show which device the conversation ran on. Fall back to the instance id
  // when the conversation id is absent (legacy emissions pre-claude_session_id).
  return `
    OTelLogs
    | where TimeGenerated > ago(${lookbackDays}d)
    | where tostring(Attributes['event.name']) == 'api_request'
    | where tostring(Attributes['user.email']) in~ (${inList})
    | extend _inst = tostring(ResourceAttributes['tokenscope.instance_id']),
             _csid = tostring(Attributes['session.id']),
             _email = tostring(Attributes['user.email'])
    | where isnotempty(_inst)
    | extend _conv = iff(isnotempty(_csid), _csid, _inst)
    | summarize FirstEvent = min(TimeGenerated), LastEvent = max(TimeGenerated),
                Tokens = sum(tolong(Attributes['input_tokens']) + tolong(Attributes['output_tokens'])
                           + tolong(Attributes['cache_read_tokens']) + tolong(Attributes['cache_creation_tokens'])),
                CostUsd = sum(todouble(Attributes['cost_usd'])),
                Models = make_set(tostring(Attributes['model'])),
                InstanceId = take_any(_inst)
      by SessionId = _conv, Email = _email
    | top ${limit} by LastEvent desc
  `.trim()
}

/** Pure mapper: a Log Analytics session-summary table → SessionSummary[]. Column-keyed. */
export function parseSessionSummaryRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): SessionSummary[] {
  const idx = (n: string) => columnNames.indexOf(n)
  const iSid = idx('SessionId'), iEmail = idx('Email'), iFirst = idx('FirstEvent')
  const iLast = idx('LastEvent'), iTok = idx('Tokens'), iCost = idx('CostUsd'), iModels = idx('Models')
  const iInst = idx('InstanceId')
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''))
  const out: SessionSummary[] = []
  for (const row of rows) {
    const sessionId = iSid >= 0 ? String(row[iSid] ?? '') : ''
    if (!sessionId) continue
    let models: string[] = []
    const raw = iModels >= 0 ? row[iModels] : null
    if (Array.isArray(raw)) models = raw.map(String)
    else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) models = p.map(String) } catch { /* ignore */ } }
    const instRaw = iInst >= 0 ? row[iInst] : null
    out.push({
      sessionId,
      ...(instRaw != null && String(instRaw) ? { instanceId: String(instRaw) } : {}),
      email: iEmail >= 0 ? String(row[iEmail] ?? '') : '',
      firstEvent: iso(iFirst >= 0 ? row[iFirst] : null),
      lastEvent: iso(iLast >= 0 ? row[iLast] : null),
      tokens: iTok >= 0 ? Math.trunc(Number(row[iTok] ?? 0)) : 0,
      costUsd: iCost >= 0 ? Number(row[iCost] ?? 0) : 0,
      models,
    })
  }
  return out
}

/*
 * Column names from an Azure Logs table, or null when they are not USABLE.
 *
 * `table.columnDescriptors` can be present but carry missing/empty `name`s.
 * The old guard was `names.length ? names : POSITIONAL`, which only caught the
 * EMPTY-array case: a descriptor list of blank names has length > 0, so it was
 * treated as valid, every column lookup missed, and every row parsed as
 * null/zero — a silent all-zeros read that looks exactly like "no telemetry".
 * Require every name to be a non-empty string, or fall back to the positional
 * projection we sent.
 */
function usableColumnNames(
  descriptors: ReadonlyArray<{ name?: string | null }> | undefined,
): string[] | null {
  if (!descriptors || descriptors.length === 0) return null
  const names = descriptors.map((c) => c.name ?? '')
  return names.every((n) => n.length > 0) ? names : null
}

export class LogAnalyticsReader implements TelemetryReader {
  // Memoized SDK handle (ING-11): `new DefaultAzureCredential()` per call threw
  // away the SDK token cache, re-running the managed-identity chain for up to
  // ~500 instance reads per tick. Built once per reader instance instead.
  private clientPromise: Promise<{
    client: import('@azure/monitor-query').LogsQueryClient
    LogsQueryResultStatus: typeof import('@azure/monitor-query').LogsQueryResultStatus
    Durations: typeof import('@azure/monitor-query').Durations
  }> | null = null

  constructor(
    private readonly workspaceId: string,
    private readonly opts: { miClientId?: string; lookbackDays?: number; queryEndpoint?: string } = {},
  ) {}

  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // Dynamic import keeps the Azure SDK out of local dev / the test bundle.
        const { LogsQueryClient, LogsQueryResultStatus, Durations } = await import('@azure/monitor-query')
        const { DefaultAzureCredential } = await import('@azure/identity')
        const credential = new DefaultAzureCredential(
          this.opts.miClientId ? { managedIdentityClientId: this.opts.miClientId } : {},
        )
        // Log Analytics QUERY endpoint. The SDK default is `api.loganalytics.io`.
        // On the AMPLS/private-query workspace that hostname resolves to the SAME
        // private-endpoint IP as api.monitor.azure.com, so the SDK DEFAULT already
        // reaches the private query path. Do NOT override to
        // `https://api.monitor.azure.com`: that host does NOT serve the LA query API
        // path and returns 404 PathNotFoundError (even for `print`). queryEndpoint
        // stays an escape hatch but MUST be left empty on dev/sandbox — the earlier
        // "use api.monitor.azure.com" guidance was wrong (it 404s). See
        // docs/design/telemetry-query-network-posture.md.
        const client = this.opts.queryEndpoint
          ? new LogsQueryClient(credential, { endpoint: this.opts.queryEndpoint })
          : new LogsQueryClient(credential)
        return { client, LogsQueryResultStatus, Durations }
      })()
      // A failed build must not be cached forever (a transient MI hiccup would
      // otherwise poison every subsequent read on this instance).
      this.clientPromise.catch(() => {
        this.clientPromise = null
      })
    }
    return this.clientPromise
  }

  /**
   * The OUTER scan bound, in days, for this reader's Log Analytics queries.
   *
   * This used to be `opts.lookbackDays === 1 ? 1 : 7` — which silently CLAMPED
   * every wider value to 7, so a caller asking for 30 got 7 and never knew. That
   * turned an app-side constant into an apparent data-loss boundary: after the
   * joiner dead-zone outage, spend older than 7d looked unrecoverable when it was
   * still sitting in the workspace (retention is 30d dev/sandbox, 90d production
   * — infra/modules/monitoring.bicep). The cap is ours, not Azure's.
   *
   * Now any positive integer is honoured, bounded by MAX_LOOKBACK_DAYS (the
   * longest retention we provision — asking beyond it can only scan empty range
   * and cost query time). Default stays 7 so steady-state tick cost is unchanged;
   * a one-off recovery read passes a wider value explicitly.
   */
  private resolveLookbackDays(): number {
    return resolveLookbackDays(this.opts.lookbackDays)
  }

  /** The window this reader applies — the value every query below is built with. */
  get appliedLookbackDays(): number {
    return this.resolveLookbackDays()
  }

  async getSessionUsage(
    sessionId: string,
    sinceTsEvent?: Date,
    callerCounters?: ParseCounters,
    window?: EventWindow,
  ): Promise<UsageRecord[]> {
    assertSafeSessionId(sessionId)
    const { client, LogsQueryResultStatus, Durations } = await this.getClient()
    const lookbackDays = this.resolveLookbackDays()
    if (!sinceTsEvent && !window) {
      // ING-12: a first-ever scan (no watermark) is silently capped by the outer
      // query duration — events older than the cap are never read. Surface it.
      console.warn(
        `[log-analytics-reader] no-watermark scan for ${sessionId} capped at ${lookbackDays}d — older events are not read`,
      )
    }
    const result = await client.queryWorkspace(
      this.workspaceId,
      buildSessionUsageKql(sessionId, sinceTsEvent, window),
      // The query timespan is the OUTER bound (caps the scan range); the KQL
      // TimeGenerated filter (from the watermark) narrows WITHIN it.
      queryTimespan(lookbackDays, Durations, window),
      queryOptions(window),
    )
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics query did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    // Own LOCAL counters for the console.warn diagnostics below (per-lane
    // detail, unchanged) — merged into the caller-supplied accumulator at the
    // end of the method (see ParseCounters/mergeParseCounters), which is the
    // channel that actually reaches JoinResult. The console.warns stay — they
    // are useful — but they are not the counter.
    const counters = emptyParseCounters()
    if (!table) {
      if (callerCounters) mergeParseCounters(callerCounters, counters)
      return []
    }
    const names = usableColumnNames(table.columnDescriptors)
    const records = parseLogAnalyticsRows(
      names ?? [...KQL_PROJECTION],
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
      counters,
    )
    if (counters.skippedNoTimestamp > 0) {
      console.warn(
        `[log-analytics-reader] ${counters.skippedNoTimestamp} row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`,
      )
    }
    // Native Copilot GenAI usage (default OFF; DORMANT until SPK-COPILOT-OTEL).
    // A second query on the SAME instance_id unions native-Copilot token rows
    // into this instance's usage — one device's Claude + Copilot usage converge
    // through the existing joiner. Projected columns are identical, so
    // parseLogAnalyticsRows is reused. Isolated try/catch: a GenAI-shape query
    // failure (e.g. the table doesn't exist pre-spike) must NEVER break the
    // proven Claude read.
    if (copilotNativeOtelEnabled()) {
      try {
        const genai = await client.queryWorkspace(this.workspaceId, buildSessionUsageKqlGenAI(sessionId, sinceTsEvent, window),
          queryTimespan(lookbackDays, Durations, window),
          queryOptions(window),
        )
        if (genai.status !== LogsQueryResultStatus.Success) {
          // Fail-open (isolation) but NOT silent — a partial/failed GenAI query
          // must surface, or a persistent native-side outage looks like "no
          // Copilot usage" indistinguishably from a genuine zero.
          console.warn(`[log-analytics-reader] native-GenAI query non-success (status=${genai.status}) for ${sessionId}; Claude read unaffected`)
        } else if (genai.tables[0]) {
          const gnames = genai.tables[0].columnDescriptors.map((c) => c.name ?? '')
          // Own LOCAL counters — sharing the Claude counter would let GenAI
          // ING-9 skips increment a total that was ALREADY logged above,
          // silently defeating the skip diagnostic for the new path. Merged
          // into `counters` (and so into `callerCounters`) below regardless.
          const gCounters = emptyParseCounters()
          records.push(
            ...parseLogAnalyticsRows(
              gnames.length ? gnames : [...KQL_PROJECTION],
              genai.tables[0].rows as ReadonlyArray<ReadonlyArray<unknown>>,
              gCounters,
            ),
          )
          if (gCounters.skippedNoTimestamp > 0) {
            console.warn(`[log-analytics-reader] ${gCounters.skippedNoTimestamp} native-GenAI row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`)
          }
          mergeParseCounters(counters, gCounters)
        }
      } catch (err) {
        console.warn(
          `[log-analytics-reader] native-GenAI query failed for ${sessionId}; Claude read unaffected: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Merge this call's (Claude + GenAI) counters into the caller-supplied
    // accumulator LAST, unconditionally — including when `records` ends up
    // empty, so a session whose rows were ALL rejected still reports the
    // reject rather than silently vanishing (the "cannot evaluate ≠ nothing
    // to report" failure mode this story exists to close).
    if (callerCounters) mergeParseCounters(callerCounters, counters)
    return records
  }

  async getSignalUsage(
    sessionId: string,
    sinceTsEvent?: Date,
    callerCounters?: ParseCounters,
    window?: EventWindow,
  ): Promise<SignalRecord[]> {
    assertSafeSessionId(sessionId)
    const { client, LogsQueryResultStatus, Durations } = await this.getClient()
    const lookbackDays = this.resolveLookbackDays()
    const result = await client.queryWorkspace(
      this.workspaceId,
      buildSignalUsageKql(sessionId, sinceTsEvent, window),
      queryTimespan(lookbackDays, Durations, window),
      queryOptions(window),
    )
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics signal query did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    // Third of the "three local counter objects" this story merges into one
    // (the other two are the Claude + native-GenAI lanes inside
    // getSessionUsage above) — same pattern: own local counters for the
    // diagnostic console.warn, merged into the caller's accumulator.
    const counters = emptyParseCounters()
    if (!table) {
      if (callerCounters) mergeParseCounters(callerCounters, counters)
      return []
    }
    const names = usableColumnNames(table.columnDescriptors)
    const records = parseSignalRows(
      names ?? [...SIGNAL_KQL_PROJECTION],
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
      counters,
    )
    if (counters.skippedNoTimestamp > 0) {
      console.warn(
        `[log-analytics-reader] ${counters.skippedNoTimestamp} signal row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`,
      )
    }
    if (callerCounters) mergeParseCounters(callerCounters, counters)
    return records
  }

  async instancePresence(instanceId: string, hours: number): Promise<InstancePresence> {
    assertSafeSessionId(instanceId)
    const { client, LogsQueryResultStatus } = await this.getClient()
    const h = Math.min(Math.max(Math.floor(hours), 1), 24 * 90)
    const result = await client.queryWorkspace(this.workspaceId, buildInstancePresenceKql(instanceId, h), {
      // The query duration must cover the whole window the KQL asks for, or the
      // outer bound silently truncates it and an absent-from-ingest verdict would
      // be an artefact of OUR clamp rather than a fact about the device — the
      // exact silent-narrowing that made a recoverable backlog look unrecoverable.
      duration: `PT${h}H`,
    })
    if (result.status !== LogsQueryResultStatus.Success) {
      // A non-success MUST throw rather than degrade to zeroes: "the query did not
      // run" and "nothing arrived" produce identical numbers but OPPOSITE
      // verdicts, and this probe exists precisely to tell a client fault from a
      // server fault. The caller renders the throw as "unanswerable".
      throw new Error(`Log Analytics instance-presence query did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    // No table at all is likewise not evidence of absence.
    if (!table) throw new Error('Log Analytics instance-presence query returned no result table')
    const names = usableColumnNames(table.columnDescriptors)
    // Fall back on USABILITY, not on length. Descriptors that exist but carry no
    // usable names (all `undefined`) would otherwise pass the length check, every
    // column lookup would miss, and the probe would report zeroes — rendering as a
    // confident 'absent-from-ingest' verdict that blames the device for a
    // deserialisation quirk on our side. For this probe a zero IS a verdict, so
    // "named columns present" has to mean the names we actually need.
    // Names must be usable AND contain the column we actually need — a valid
    // but unexpected shape falls back rather than parsing to a silent zero.
    const usable = names !== null && names.includes('Records')
    return parseInstancePresenceRow(
      usable ? names! : [...PRESENCE_KQL_PROJECTION],
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
    )
  }

  async listSessions(
    emails: string[],
    opts: { lookbackDays?: number; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    if (emails.length === 0) return []
    const { client, LogsQueryResultStatus } = await this.getClient()
    const lookback = opts.lookbackDays ?? 30
    const kql = buildListSessionsKql(emails, lookback, opts.limit ?? 100)
    const result = await client.queryWorkspace(this.workspaceId, kql, { duration: `P${lookback}D` })
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics listSessions did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    if (!table) return []
    const names = usableColumnNames(table.columnDescriptors)
    // This path has no positional projection to fall back to, so keep the
    // pre-existing behaviour (raw descriptor names) rather than invent one.
    return parseSessionSummaryRows(
      names ?? table.columnDescriptors.map((c) => c.name ?? ''),
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
    )
  }

  async healthCheck(opts: { timeoutMs?: number } = {}): Promise<ReaderHealth> {
    const start = Date.now()
    const timeoutMs = opts.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS
    try {
      const { client, LogsQueryResultStatus } = await this.getClient()
      // A bounded read of the SAME table the joiner queries (buildSessionUsageKql
      // reads OTelLogs). ops-alerting ar-H1: the previous `print probe=1` needed
      // no table and stayed green through the 2026-08 AMPLS incident while
      // PrivateLinkValidationFailedError killed every real read — the probe must
      // fail exactly when the joiner would, which means touching the table (and
      // with it the Reader-role grant). `take 1` + the 1h window bound the scan;
      // an empty result is HEALTHY (readable-but-quiet — freshness is the
      // attribution-stall condition's concern, not this probe's).
      const result = await client.queryWorkspace(
        this.workspaceId,
        'OTelLogs | where TimeGenerated > ago(1h) | take 1',
        { duration: 'PT1H' },
        {
          // Request-bounded on BOTH ends (ar-H6): the client aborts at timeoutMs
          // and the service is told the same budget, so a wedged query can never
          // hold the probe's caller.
          abortSignal: AbortSignal.timeout(timeoutMs),
          serverTimeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        },
      )
      const ok = result.status === LogsQueryResultStatus.Success
      return {
        ok,
        kind: 'log-analytics',
        latencyMs: Date.now() - start,
        error: ok ? undefined : `query status=${result.status}`,
      }
    } catch (err) {
      // Same leak as LocalCollectorReader.healthCheck (see its comment): this
      // is a RESOLVED value, not a throw, so a caller's own try/catch
      // redaction (S8's fix in diagnostics/index.get.ts) never runs — an
      // Azure SDK error can carry the workspace id / query endpoint, which an
      // unauthenticated-adjacent admin probe must not leak.
      const { reason, correlationId } = classifyProbeError(err, 'telemetry-reader:log-analytics')
      return {
        ok: false,
        kind: 'log-analytics',
        latencyMs: Date.now() - start,
        error: reason,
        correlationId,
      }
    }
  }

  async billableIngestionLast24h(opts: { timeoutMs?: number } = {}): Promise<IngestionLast24h> {
    const start = Date.now()
    const timeoutMs = opts.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS
    try {
      const { client, LogsQueryResultStatus } = await this.getClient()
      // P1D is the same trailing 24 h the KQL predicate states.
      const result = await client.queryWorkspace(this.workspaceId, BILLABLE_INGESTION_LAST_24H_KQL, { duration: 'P1D' }, {
        // Bounded on both ends, exactly as healthCheck is (ar-H6).
        abortSignal: AbortSignal.timeout(timeoutMs),
        serverTimeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      })
      if (result.status !== LogsQueryResultStatus.Success) {
        // A partial result is not a total: report no number at all.
        return { megabytes: null, kind: 'log-analytics', latencyMs: Date.now() - start, error: `query status=${result.status}` }
      }
      const raw = result.tables[0]?.rows[0]?.[0]
      const megabytes = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
      if (!Number.isFinite(megabytes) || megabytes < 0) {
        return { megabytes: null, kind: 'log-analytics', latencyMs: Date.now() - start, error: 'no-value' }
      }
      return { megabytes, kind: 'log-analytics', latencyMs: Date.now() - start }
    } catch (err) {
      // Resolved, not thrown, so the redaction happens here (see healthCheck).
      const { reason, correlationId } = classifyProbeError(err, 'telemetry-reader:billable-ingestion')
      return { megabytes: null, kind: 'log-analytics', latencyMs: Date.now() - start, error: reason, correlationId }
    }
  }

  /**
   * Admin diagnostic — runs a fixed battery of read-only OTelLogs queries and
   * returns the RAW result/error packets per query. The dev workspace is
   * NSP-locked (in-VNet only), so the app MI is the ONLY identity that can query
   * it; laptops, Cloud Shell, and CI runners all hit the NSP deny. This surfaces
   * "is telemetry actually landing?" — and, crucially, the EXACT failure (Azure
   * error code, the inner NspValidationFailedError, partial errors, status) —
   * to a platform-admin without opening the perimeter.
   *
   * FIXED queries parameterised ONLY by clamped integers (no caller-supplied KQL
   * → no injection surface). Never throws: each query is captured independently
   * so one failure still returns the others' raw packets.
   */
  async diagnosticOtelLogs(opts: { hours?: number; limit?: number } = {}): Promise<DiagnosticOtelLogs> {
    const hours = Math.min(Math.max(Math.floor(opts.hours ?? 24), 1), 168)
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100)
    const duration = `PT${hours}H`
    const queries: Array<{ label: string; kql: string }> = [
      { label: 'reachability', kql: 'print probe=1' },
      { label: 'all-tables', kql: `union withsource=T * | where TimeGenerated > ago(${hours}h) | summarize n=count() by T | order by n desc` },
      {
        label: 'by-instance',
        // `last` is a KQL reserved word — using it as a bare summarize alias is a
        // SYN0002 parse error (400 BadArgumentError), so this probe failed on
        // syntax regardless of whether data was present. Use `lastSeen`.
        kql:
          `OTelLogs | where TimeGenerated > ago(${hours}h) ` +
          `| summarize records=count(), lastSeen=max(TimeGenerated) ` +
          `by instance=tostring(ResourceAttributes['tokenscope.instance_id']), tool=tostring(ResourceAttributes['tool']) ` +
          `| order by records desc`,
      },
      {
        label: 'recent-rows',
        kql:
          `OTelLogs | where TimeGenerated > ago(${hours}h) ` +
          `| project TimeGenerated, instance=tostring(ResourceAttributes['tokenscope.instance_id']), ` +
          `body=substring(tostring(Body), 0, 200) ` +
          `| order by TimeGenerated desc | take ${limit}`,
      },
    ]

    // DNS PROOF — resolve the query endpoints FROM INSIDE the app. The SDK's
    // LogsQueryClient default endpoint is https://api.loganalytics.io. If that
    // resolves to a PUBLIC ip while the AMPLS-covered hosts (api.monitor.azure.com,
    // <wsid>.oms.opinsights.azure.com) resolve PRIVATE (10.x), the query egresses
    // public and the workspace denies it — the gap is the endpoint we query, not
    // the private DNS. This is evidence, not an assertion.
    const dnsPromises = (await import('node:dns')).promises
    const isPrivateIp = (ip: string) =>
      /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    // Every FQDN from the AMPLS DNS request, so we can see per-record which
    // privatelink zone is actually linked (resolves to the PE) vs missing
    // (resolves public). The PE is IT's central one, outside our VNet, so the
    // linked case is any RFC1918 address. api.loganalytics.io is the SDK default
    // and resolves private too on an AMPLS env — it is listed first because a
    // PUBLIC answer there while the rest are private is the exact shape of a
    // query egressing outside the perimeter.
    const dnsTargets = [
      'api.loganalytics.io',
      `${this.workspaceId}.oms.opinsights.azure.com`,
      `${this.workspaceId}.ods.opinsights.azure.com`,
      `${this.workspaceId}.agentsvc.azure-automation.net`,
      'api.monitor.azure.com',
      'global.in.ai.monitor.azure.com',
      'profiler.monitor.azure.com',
      'live.monitor.azure.com',
      'diagservices-query.monitor.azure.com',
      'snapshot.monitor.azure.com',
      'scadvisorcontentpl.blob.core.windows.net',
      'global.handler.control.monitor.azure.com',
    ]
    const dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }> = []
    for (const host of dnsTargets) {
      try {
        const addrs = await dnsPromises.lookup(host, { all: true })
        const ips = addrs.map((a) => a.address)
        dns.push({ host, addresses: ips, resolvesPrivate: ips.some(isPrivateIp) })
      } catch (err) {
        dns.push({ host, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const base = {
      hours,
      limit,
      workspaceId: this.workspaceId,
      duration,
      queryEndpointNote: this.opts.queryEndpoint
        ? `LogsQueryClient endpoint override = ${this.opts.queryEndpoint}`
        : 'LogsQueryClient uses its default endpoint https://api.loganalytics.io (no override configured)',
      dns,
    }
    let handle: Awaited<ReturnType<LogAnalyticsReader['getClient']>>
    try {
      handle = await this.getClient()
    } catch (err) {
      // Couldn't even build the credential/client — return that raw.
      return { ...base, clientError: serializeQueryError(err), queries: [] }
    }
    const { client, LogsQueryResultStatus } = handle

    const results: DiagnosticQueryResult[] = []
    for (const q of queries) {
      const started = Date.now()
      try {
        const res = await client.queryWorkspace(this.workspaceId, q.kql, { duration })
        // `LogsQueryResult` is a union — `.tables` exists only on the Success
        // variant; PartialFailure carries `partialTables` + `partialError`.
        let columns: string[] = []
        let rows: Array<Record<string, unknown>> = []
        if (res.status === LogsQueryResultStatus.Success) {
          const table = res.tables[0]
          if (table) {
            columns = table.columnDescriptors.map((c) => c.name ?? '')
            const tableRows = table.rows as ReadonlyArray<ReadonlyArray<unknown>>
            rows = tableRows.map((row) => {
              const obj: Record<string, unknown> = {}
              columns.forEach((n, i) => {
                obj[n] = row[i]
              })
              return obj
            })
          }
        }
        const partialError = (res as { partialError?: unknown }).partialError
        results.push({
          label: q.label,
          kql: q.kql,
          ok: res.status === LogsQueryResultStatus.Success,
          status: String(res.status),
          latencyMs: Date.now() - started,
          partialError: partialError ? serializeQueryError(partialError) : undefined,
          columns,
          rows,
        })
      } catch (err) {
        results.push({
          label: q.label,
          kql: q.kql,
          ok: false,
          latencyMs: Date.now() - started,
          error: serializeQueryError(err),
        })
      }
    }
    return { ...base, queries: results }
  }
}

export interface DiagnosticQueryResult {
  label: string
  kql: string
  ok: boolean
  status?: string
  latencyMs: number
  partialError?: Record<string, unknown>
  error?: Record<string, unknown>
  columns?: string[]
  rows?: Array<Record<string, unknown>>
}

export interface DiagnosticOtelLogs {
  hours: number
  limit: number
  workspaceId: string
  duration: string
  queryEndpointNote: string
  dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }>
  clientError?: Record<string, unknown>
  queries: DiagnosticQueryResult[]
}

/**
 * Serialize an Azure SDK / generic error into a RAW but SAFE shape for the
 * platform-admin diagnostic. Includes the Azure error code/status + the inner
 * structured error (e.g. NspValidationFailedError) so the operator sees the
 * exact failure — but deliberately EXCLUDES `request`/`response` objects, which
 * carry the `Authorization: Bearer …` header. Stack is capped to a few frames.
 */
export function serializeQueryError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) }
  const e = err as Error & {
    code?: unknown
    statusCode?: unknown
    details?: unknown
    innererror?: unknown
  }
  const out: Record<string, unknown> = { name: e.name, message: e.message }
  if (e.code !== undefined) out.code = e.code
  if (e.statusCode !== undefined) out.statusCode = e.statusCode
  for (const k of ['details', 'innererror'] as const) {
    if (e[k] !== undefined) {
      try {
        out[k] = JSON.parse(JSON.stringify(e[k]))
      } catch {
        out[k] = String(e[k])
      }
    }
  }
  if (e.stack) out.stack = e.stack.split('\n').slice(0, 6).join('\n')
  return out
}

/**
 * The configured telemetry reader.
 *
 * `lookbackDays` widens the OUTER scan bound past the 7-day default (up to
 * MAX_LOOKBACK_DAYS). It exists for one-off RECOVERY: after the joiner dead-zone
 * incident, weeks of already-ingested spend needed re-joining, and a reader
 * pinned at 7 days would have silently recovered only the last week while
 * reporting success. Callers that pass it MUST also be scoped (explicit
 * sessionIds), because the wider window costs query time per instance.
 */
export function getTelemetryReader(opts: { lookbackDays?: number } = {}): TelemetryReader {
  if (process.env.NUXT_TELEMETRY_READER === 'log-analytics') {
    const workspaceId = process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID
    if (!workspaceId) {
      throw new Error('NUXT_LOG_ANALYTICS_WORKSPACE_ID not set — LogAnalyticsReader has no workspace')
    }
    const readerOpts = {
      lookbackDays: opts.lookbackDays,
      miClientId: process.env.NUXT_AZURE_MI_CLIENT_ID,
      // Private-link envs set this to https://api.monitor.azure.com (the LA query
      // endpoint over AMPLS). Empty = SDK default api.loganalytics.io.
      queryEndpoint: process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT,
    }
    return memoisedReader(
      ['log-analytics', workspaceId, readerOpts.miClientId, readerOpts.queryEndpoint, readerOpts.lookbackDays],
      () => new LogAnalyticsReader(workspaceId, readerOpts),
    )
  }
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!endpoint) {
    throw new Error('NUXT_AZURE_MONITOR_ENDPOINT not set — local telemetry reader has no source')
  }
  return memoisedReader(['local', endpoint], () => new LocalCollectorReader(endpoint))
}

/*
 * One reader per resolved config, for the life of the process. The
 * credential/client memo (ING-11) lives on the LogAnalyticsReader INSTANCE, so
 * a factory that built a new instance per call discarded it on every request
 * and re-ran the managed-identity chain each time
 * (docs/design/admin-nav-responsiveness.md D4). Keyed on everything the
 * constructor reads — workspace, MI client id, query endpoint, lookback — so
 * a widened recovery reader and the steady-state one are distinct entries and
 * a changed env resolves to a new reader rather than a stale one. The set of
 * distinct configs a process ever sees is a handful, so the map is unbounded.
 */
const readerCache = new Map<string, TelemetryReader>()

function memoisedReader(key: ReadonlyArray<string | number | undefined>, build: () => TelemetryReader): TelemetryReader {
  const k = JSON.stringify(key)
  let reader = readerCache.get(k)
  if (!reader) {
    reader = build()
    readerCache.set(k, reader)
  }
  return reader
}

/** Tests only: forget every memoised reader (a mocked SDK or a changed env must not see a reader built under the previous one). */
export function resetTelemetryReaderCache(): void {
  readerCache.clear()
}
