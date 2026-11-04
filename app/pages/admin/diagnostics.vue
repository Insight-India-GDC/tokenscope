<script setup lang="ts">
import { statsWindowLabel, analyzeLabel } from '~/utils/db-stats-labels'
/*
 * Admin → Diagnostics (Wave VI). Operational health snapshot.
 *
 * MOSTLY read-only. The probes are all reads; the exceptions are the deliberate,
 * audited operator actions this page grew because the alternative was a shell
 * nobody has: worker enable/disable (mig 0090) and the widened-read telemetry
 * recovery (mig 0093). Anything mutating here is RBAC'd, reason-carrying and
 * audited server-side. (This header used to claim "read-only, no buttons"; that
 * stopped being true with the worker toggle and is corrected rather than kept.)
 * The Refresh button re-fetches the endpoint, giving the operator a
 * quick "is it back yet" loop without a full page reload.
 *
 * Cards are individually defensive: a Postgres miss doesn't break the
 * Redis card (the endpoint already wraps each probe in try/catch).
 */

import { computed, ref } from 'vue'
import type { AbDecompositionTermName } from '#shared/usage/ab-decomposition-terms'
import type { UnhomedCause } from '#shared/usage/unhomed-causes'
// The role vocabulary, shared with the report-visibility policy pane rather than
// re-typed here — see PERSONA_LABEL below.
import { REPORT_VISIBILITY_PERSONAS } from '#shared/auth/report-visibility'
definePageMeta({ layout: 'admin', middleware: 'admin' })

/**
 * Whether one independently-fallible server-side read answered. Mirrors
 * `ReadAvailability` in server/utils/redact-probe-error.ts; `error` is a
 * classified reason code (never a driver message) and the correlation id ties
 * it to the full-fidelity server log line.
 */
interface ReadAvailability {
  available: boolean
  error?: string
  errorCorrelationId?: string
}

interface DiagResp {
  postgres: {
    reachable: boolean
    latencyMs: number
    activeMigration: string | null
    error?: string
  }
  redis: { unavailable: true; reason: string } | { reachable: boolean; latencyMs: number }
  queues:
    | { unavailable: true; reason: string }
    | Record<string, { depth: number }>
  pipeline: {
    lastUsageSeen: string | null
    lastLedgerWrite: string | null
    usageAgeMinutes: number | null
    ledgerAgeMinutes: number | null
    status: 'ok' | 'warn' | 'stale' | 'unknown'
  }
  workers: {
    worker: string
    status: string
    finishedAt: string | null
    startedAt: string | null
    durationMs: number | null
    ageMinutes: number | null
    startedAgeMinutes: number | null
    consecutiveFailures: number
    // The attribution-stall evidence from the latest run (server: index.get.ts).
    // null = the run recorded no such figure, shown as "?" (unknown), not 0.
    rowsAffected: number | null
    sessionsProcessed: number | null
    newEventsSeen: number | null
    // The ingest-side coverage verdict the stall alerts gate on + its metrics.
    sourceCoverage: string | null
    sourceRowsReceived: number | null
    sourceRowsDropped: number | null
    rag: 'ok' | 'failing' | 'stale' | 'disabled' | 'unknown'
    dispatchBudget: 'ok' | 'near' | 'over' | null
    dispatchBudgetReason: string | null
  }[]
  dispatchBudgetMs: number
  lastSync: { source: string; ts: string | null }[]
  // Per-read availability (server: index.get.ts `reads`). An empty `workers` /
  // `lastSync` and an unknown `pipeline` are the SAME bytes whether the query
  // found nothing or failed — this is the only thing that separates them, and
  // every panel below keys its "unavailable" state on it.
  reads?: {
    lastSync?: ReadAvailability
    pipeline?: ReadAvailability
    workers?: ReadAvailability
  }
  nodeEnv: string
  containerInfo: { revision: string | null }
}

// GET /api/v1/admin/diagnostics/costing — the 7-day fact-table aggregates,
// split off the snapshot so its panel can land on its own (D4).
interface DiagCostingResp {
  // migs 0045/0091: our rate-card ESTIMATE vs the provider's own figure over the
  // last 7 days (v_cost_drift), across both cost vintages — pre-cutover rows
  // where cost_usd is the estimate, and provider-priced rows where the estimate
  // rides in metadata. spansCompared=0 until comparable emission accrues.
  costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    providerPricedSpans: number
    rateCardPricedSpans: number
    worstSpan: {
      spanKey: string
      model: string
      rateCardCostUsd: string
      lawCostUsd: string
      driftUsd: string
      pricedBy: string
    } | null
  } | null
  // Present only for a region admin: v_cost_drift has no region, so the server
  // withholds the drift section and says why (costDrift is null, reads has no
  // costDrift entry).
  costDriftScopedOut?: { reason: 'platform-admin-only'; detail: string }
  // Which rung of the costing ladder priced real spend
  // (docs/design/provider-cost-precedence.md). A healthy fleet is ENTIRELY
  // provider-priced — `rateCard > 0` is an ALERT, not a statistic.
  costingRungs: {
    windowDays: number
    spans: number
    provider: number
    rateCard: number
    other: number
    // provider + rateCard — the spans the ladder priced, and the denominator of
    // rateCardPct (backfill traffic must not dilute the fallback share).
    ladderSpans: number
    rateCardPct: number | null
    fallbackModels: { model: string; spans: number }[]
  }
  // Per-read availability (server: costing.get.ts `reads`). Both shapes above
  // fall back to ZEROES on a failed query, which the cards would otherwise draw
  // as "no spans" / "no comparable spans" — a healthy-looking nothing.
  reads?: {
    costDrift?: ReadAvailability
    costingRungs?: ReadAvailability
  }
}

// GET /api/v1/admin/diagnostics/probes — the network-bound probes, each raced
// against a 5 s budget server-side; split off the snapshot for the same reason.
interface DiagProbesResp {
  // TCP reachability of each provisioned private endpoint — the same probe the
  // boot pre-flight runs (scripts/preflight.ts).
  services: {
    name: string
    critical: boolean
    status: 'ok' | 'unreachable' | 'skipped'
    target: string | null
    latencyMs: number | null
    errorClass?: string
    error?: string
    reason?: string
  }[]
  // Log Analytics query reachability (a trivial KQL via the configured reader).
  telemetryRead: { ok: boolean; kind: string; latencyMs: number | null; error?: string }
}

// Card A — Private Link / DNS validation (GET /api/v1/admin/diagnostics/network).
// Per provisioned host: does DNS resolve to a private address (zone linked) and
// is the TCP port reachable? itReport is the plain-text artefact for networking.
// Platform-admin only (region admins 403) — this returns
// infrastructure topology (private IPs, internal host:port pairs), the same
// class of exposure otel-logs.get.ts is gated on.
interface NetCheckReport {
  generatedNote: string
  vnetHint: string
  summary: { total: number; ok: number; dnsOnly: number; zoneNotLinked: number; unreachable: number; dnsFail: number; notWired: number }
  itReport: string // multi-line plain text
  records: Array<{
    service: string
    category: 'data-plane' | 'azure-monitor' | 'reference'
    host: string
    port: number
    expectedZone: string
    expectPrivate: boolean
    addresses: string[]
    resolvesPrivate: boolean
    dnsError?: string
    reachable: boolean | null
    tcpLatencyMs: number | null
    tcpError?: string
    verdict: 'ok' | 'dns-only' | 'dns-public-zone-not-linked' | 'unreachable' | 'dns-fail' | 'public-ok' | 'not-wired'
  }>
}

// Card B — OTel telemetry read path (GET /api/v1/admin/diagnostics/otel-logs).
// Platform-admin only (region admins 403). Each KQL probe carries its raw Azure
// error packet on failure — operators need the un-truncated packet.
interface OtelDiag {
  config: { telemetryReader: string | null; workspaceIdSet: boolean; miClientId: string | null; logsEndpointHost: string | null }
  hours: number
  limit: number
  duration: string
  queryEndpointNote: string
  dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }>
  queries: Array<{
    label: string
    kql: string
    ok: boolean
    status?: string
    latencyMs: number
    partialError?: Record<string, unknown>
    error?: Record<string, unknown>
    columns?: string[]
    rows?: Array<Record<string, unknown>>
  }>
  clientError?: Record<string, unknown>
  fatalError?: Record<string, unknown>
}

// The admin middleware guarantees the session before this page instantiates;
// nothing here awaits the network (docs/design/admin-nav-responsiveness.md D1).
const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})

/*
 * The §A/§B decomposition is estate-wide and its endpoint is gated to
 * platform-admin (see server/api/v1/admin/diagnostics/ab-decomposition.get.ts).
 * A region admin passes `isAdmin` but would get a deterministic 403, so the card
 * must not fetch or render for them: an empty panel with no explanation reads as
 * a broken diagnostic, which is the opposite of what a diagnostics page is for.
 */
const canSeeEstateFinance = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})

/*
 * Every read on this page is declared lazily with a `null` default and no
 * await, so navigation paints the shell at once and each panel renders exactly
 * one of skeleton / error / data keyed on `!error && data == null` — never on
 * `pending`, which only drives the refresh controls (D2). `server: false`:
 * the page is authenticated and unindexed, and SSR data would cost the same
 * seconds as TTFB on a hard reload.
 */
const { data, refresh, pending, error } = useLazyFetch<DiagResp | null>('/api/v1/admin/diagnostics', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})
const {
  data: probesData,
  refresh: refreshProbes,
  error: probesError,
} = useLazyFetch<DiagProbesResp | null>('/api/v1/admin/diagnostics/probes', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})
const {
  data: costingData,
  refresh: refreshCosting,
  error: costingError,
} = useLazyFetch<DiagCostingResp | null>('/api/v1/admin/diagnostics/costing', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

/*
 * "Nothing happened" vs "we could not find out" — the distinction every panel
 * below has to make. A read that FAILED server-side still returns its zero /
 * empty shape (so consumers keep working), so the numbers alone cannot tell the
 * two apart; `reads.<name>.available` can. Returns the operator-facing line for
 * an unavailable read, or null when the read answered.
 */
function unavailable(r: ReadAvailability | undefined): string | null {
  if (!r || r.available !== false) return null
  const id = r.errorCorrelationId ? ` · correlation ${r.errorCorrelationId}` : ''
  return `unavailable — ${r.error ?? 'unknown'}${id}`
}
const pipelineUnavailable = computed(() => unavailable(data.value?.reads?.pipeline))
const workersUnavailable = computed(() => unavailable(data.value?.reads?.workers))
const lastSyncUnavailable = computed(() => unavailable(data.value?.reads?.lastSync))
const driftUnavailable = computed(() => unavailable(costingData.value?.reads?.costDrift))
const rungsUnavailable = computed(() => unavailable(costingData.value?.reads?.costingRungs))

const pgBadge = computed(() => {
  if (!data.value?.postgres) return { kind: 'neutral' as const, label: '—' }
  return data.value.postgres.reachable
    ? { kind: 'rag-green' as const, label: 'ok' }
    : { kind: 'rag-red' as const, label: 'down' }
})

// Overall RAG for the private-endpoint reachability card: red if a boot-critical
// PE is down, amber if a non-critical PE is down, green otherwise.
const servicesBadge = computed(() => {
  const svc = probesData.value?.services ?? []
  if (!svc.length) return { kind: 'neutral' as const, label: '—' }
  if (svc.some((s) => s.critical && s.status === 'unreachable')) return { kind: 'rag-red' as const, label: 'critical down' }
  if (svc.some((s) => s.status === 'unreachable')) return { kind: 'rag-amber' as const, label: 'degraded' }
  return { kind: 'rag-green' as const, label: 'ok' }
})
function svcDetail(s: DiagProbesResp['services'][number]): string {
  if (s.status === 'ok') return `ok · ${s.latencyMs}ms`
  if (s.status === 'skipped') return 'skipped'
  return `unreachable [${s.errorClass ?? 'error'}]`
}

const redisUnavailable = computed(() =>
  data.value?.redis ? 'unavailable' in data.value.redis : true,
)

const queuesUnavailable = computed(() =>
  data.value?.queues ? 'unavailable' in data.value.queues : true,
)

function fmtTs(v: string | null): string {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

function fmtAge(min: number | null): string {
  if (min == null) return 'never'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}

const pipelineBadge = computed(() => {
  // A failed read is amber 'unavailable', never the neutral 'no data' that a
  // genuinely quiet pipeline earns.
  if (pipelineUnavailable.value) return { kind: 'rag-amber' as const, label: 'unavailable' }
  const s = data.value?.pipeline?.status
  if (s === 'ok') return { kind: 'rag-green' as const, label: 'flowing' }
  if (s === 'warn') return { kind: 'rag-amber' as const, label: 'slowing' }
  if (s === 'stale') return { kind: 'rag-red' as const, label: 'stalled' }
  return { kind: 'neutral' as const, label: 'no data' }
})

// Any worker with a trailing failure streak turns the whole Workers card
// red — this is the chip that would have shown the joiner failing while the
// freshness panel still read green.
const workersBadge = computed(() => {
  if (workersUnavailable.value) return { kind: 'rag-amber' as const, label: 'unavailable' }
  const ws = data.value?.workers ?? []
  if (!ws.length) return { kind: 'neutral' as const, label: 'no runs' }
  if (ws.some((w) => w.rag === 'failing')) return { kind: 'rag-red' as const, label: 'failing' }
  if (ws.some((w) => w.rag === 'stale')) return { kind: 'rag-amber' as const, label: 'stale' }
  return { kind: 'rag-green' as const, label: 'healthy' }
})

function workerChip(
  rag: DiagResp['workers'][number]['rag'],
): { kind: 'rag-green' | 'rag-red' | 'rag-amber' | 'neutral'; label: string } {
  if (rag === 'ok') return { kind: 'rag-green', label: '✓ ok' }
  if (rag === 'failing') return { kind: 'rag-red', label: '✗ failing' }
  // Amber for stale — consistent with the card badge (LOW-4); the per-row chip
  // previously rendered stale as neutral/grey.
  if (rag === 'stale') return { kind: 'rag-amber', label: '— stale' }
  // Admin has the worker switched off (its runs record 'skipped'): not a
  // failure, not a success — nothing ran.
  if (rag === 'disabled') return { kind: 'neutral', label: '— disabled' }
  return { kind: 'neutral', label: '? unknown' }
}

/*
 * The stall evidence, as one line under the reader's row. This is the line an
 * operator paged by attribution-stall / read-path-stale opens the page for. It
 * reads "source <verdict> (N received[, D dropped]) · reader saw M new · wrote R
 * · N selected": `source` is the ingest-coverage verdict the alert GATES on
 * (rows-arrived = the DCR received rows we did not land = the fault; no-rows =
 * idle; unknown = the probe could not measure, so the alert fell back to the
 * bearer gate); "new" (JoinResult.newEventsSeen) is the reader-side middle term;
 * "selected" is the selection size, which an idle open editor keeps at >= 1, so
 * it is context, not evidence. A null renders "?" — a run recorded before the
 * field existed, which is unknown and must not read as zero. Only the reader
 * records these, so only its row carries the line.
 */
function stallEvidence(w: DiagResp['workers'][number]): string | null {
  if (
    w.rowsAffected === null &&
    w.sessionsProcessed === null &&
    w.newEventsSeen === null &&
    w.sourceCoverage === null
  )
    return null
  const n = (v: number | null) => (v === null ? '?' : String(v))
  const received = w.sourceRowsReceived === null ? '' : ` (${w.sourceRowsReceived} received`
  const dropped = received && w.sourceRowsDropped ? `, ${w.sourceRowsDropped} dropped` : ''
  const close = received ? ')' : ''
  const cov = `source ${w.sourceCoverage ?? '?'}${received}${dropped}${close}`
  return `${cov} · reader saw ${n(w.newEventsSeen)} new · wrote ${n(w.rowsAffected)} · ${n(w.sessionsProcessed)} selected`
}

function fmtWorkerRun(durationMs: number | null, ageMinutes: number | null): string {
  const age = ageMinutes == null ? 'no run yet' : `last run ${fmtAge(ageMinutes)}`
  return durationMs == null ? age : `${age} · ${durationMs}ms`
}

// Drift RAG: <1% green (rounding noise), <5% amber (check the card),
// >=5% red (rate card is stale / mispriced).
//
// Since the provider-cost cutover this is NOT a money-accuracy alarm: for a
// provider-priced span the booked total IS the provider's number regardless of
// how far the card has drifted. What drift still governs is the per-token-type
// SLICE (the card decides how a span total is divided, never how big it is) and
// the forecasting/validation uses of the card. Amber/red therefore means "the
// card needs a rate line", not "the bill is wrong".
const driftScopedOut = computed(() => costingData.value?.costDriftScopedOut ?? null)
const driftBadge = computed(() => {
  if (driftScopedOut.value) return { kind: 'neutral' as const, label: 'scoped out' }
  if (driftUnavailable.value) return { kind: 'rag-amber' as const, label: 'unavailable' }
  const d = costingData.value?.costDrift
  if (!d || d.spansCompared === 0) return { kind: 'neutral' as const, label: 'no data' }
  const pct = d.meanAbsDriftPct ?? 0
  if (pct < 1) return { kind: 'rag-green' as const, label: 'in line' }
  if (pct < 5) return { kind: 'rag-amber' as const, label: 'drifting' }
  return { kind: 'rag-red' as const, label: 'stale rates' }
})

// Costing-rung RAG. Deliberately NOT a proportional gauge: the design's bar is
// that a healthy fleet is ENTIRELY provider-priced, so ONE rate-card-priced span
// is already an anomaly and goes straight to red. Grading it (amber under 5%,
// say) would teach operators that a bit of fallback is normal, which is exactly
// the silent mispricing this whole change exists to stop — a new model priced at
// the wrong model's rates looks like a small percentage right up until it isn't.
const costingBadge = computed(() => {
  // The alert this card carries cannot be allowed to read as a clean fleet when
  // the query behind it failed — that is the same false-green the rung counter
  // exists to prevent, one layer up.
  if (rungsUnavailable.value) return { kind: 'rag-amber' as const, label: 'unavailable' }
  const c = costingData.value?.costingRungs
  if (!c || c.spans === 0) return { kind: 'neutral' as const, label: 'no spans' }
  // Guard on ladderSpans (provider + rateCard), NOT spans (which also counts
  // `other`, i.e. backfill/telemetry-only). A window holding ONLY backfill spans
  // has nothing on the costing ladder to judge, and going green there would
  // claim a clean bill of health from no evidence — the failure this card exists
  // to prevent, inverted.
  if (c.ladderSpans === 0) return { kind: 'neutral' as const, label: 'no priced spans' }
  if (c.rateCard > 0) return { kind: 'rag-red' as const, label: 'rate-card fallback' }
  return { kind: 'rag-green' as const, label: 'provider-priced' }
})

/* --- Card: database performance (GET /api/v1/admin/diagnostics/db-performance)
 *
 * LAUNCHABLE, not on page load. This probe reads six statistics views and this
 * page is already the slowest in the product; running it on every navigation
 * would charge every operator for a question almost none of them are asking.
 * `immediate: false` + a button is the whole design decision — the panel still
 * renders exactly one of idle / skeleton / error / data per
 * docs/design/admin-nav-responsiveness.md D2, with `dbPerfHasRun` separating
 * "not asked yet" from "asked, nothing back yet" (under immediate:false the two
 * are otherwise the same `data == null`).
 *
 * Platform-admin only, like the network and RLS cards; a region admin gets a
 * calm scoped-out note rather than an empty panel.
 */
interface DbPerfStatementRow {
  query: string
  truncated: boolean
  textWithheld: boolean
  calls: number
  totalMs: number
  meanMs: number
  maxMs: number
  rows: number
}
interface DbPerfResp {
  generatedAt: string
  topN: number
  budget: { statementTimeoutMs: number; perReadMs: number; deadlineMs: number; elapsedMs: number }
  statements: {
    extension: { preloaded: boolean | null; installed: boolean | null; ready: boolean; note: string }
    rows: DbPerfStatementRow[]
  }
  statsWindow?: { databaseSince: string | null; statementsSince: string | null; available: boolean }
  sequentialScans: { table: string; seqScan: number; seqTupRead: number; idxScan: number; liveTuples: number; partitions: number; lastAnalyzed?: string | null; neverAnalyzed?: number; rowsChangedSinceAnalyze?: number }[]
  cache: { table: string; heapHit: number; heapRead: number; idxHit: number; idxRead: number; hitRatio: number | null; partitions: number }[]
  unusedIndexes: { minBytes: number; rows: { index: string; table: string; bytes: number; partitions: number }[] }
  sizes: { table: string; tableBytes: number; indexBytes: number; totalBytes: number; partitions: number }[]
  settings: { name: string; setting: string; unit: string; display: string; source: string; pendingRestart: boolean }[]
  reads?: {
    statements?: ReadAvailability
    sequentialScans?: ReadAvailability
    cache?: ReadAvailability
    unusedIndexes?: ReadAvailability
    sizes?: ReadAvailability
    settings?: ReadAvailability
  }
}
const {
  data: dbPerfData,
  refresh: runDbPerf,
  pending: dbPerfPending,
  error: dbPerfError,
} = useLazyFetch<DbPerfResp | null>('/api/v1/admin/diagnostics/db-performance', {
  server: false,
  default: () => null,
  immediate: false,
})
// "Not asked yet" vs "asked, still waiting" — under immediate:false both are
// `data == null`, and only one of them should draw a skeleton.
const dbPerfHasRun = ref(false)
function launchDbPerf() {
  dbPerfHasRun.value = true
  return runDbPerf()
}
const dbPerfStatementsUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.statements))
const dbPerfSeqUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.sequentialScans))
const dbPerfCacheUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.cache))
const dbPerfUnusedUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.unusedIndexes))
const dbPerfSizesUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.sizes))
const dbPerfSettingsUnavailable = computed(() => unavailable(dbPerfData.value?.reads?.settings))

/** Binary units, because that is what Postgres counts in. */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}
function fmtMs(n: number): string {
  return n >= 1000
    ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s`
    : `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}ms`
}
function fmtRatio(r: number | null): string {
  return r == null ? '—' : `${(r * 100).toFixed(1)}%`
}
/*
 * The finding this section exists to surface: a BIG table walked sequentially
 * while its indexes go unused. Tiny lookup tables legitimately seq-scan (the
 * planner prefers it under a page or two), so a row is only flagged past a
 * live-tuple floor — otherwise every reference table would read as a problem
 * and the section would train the operator to ignore it.
 */
const SEQ_SCAN_TUPLE_FLOOR = 10000
function seqScanPressure(r: { seqTupRead: number; idxScan: number; liveTuples: number }): boolean {
  return r.liveTuples >= SEQ_SCAN_TUPLE_FLOOR && r.seqTupRead > 0 && r.seqTupRead > r.idxScan
}

// --- Card A: Private Link / DNS validation -------------------------------
// Defensive: this fetch is independent of the main diagnostics fetch, so a
// failure here cannot blank the rest of the page (its own error ref is shown).
const {
  data: netData,
  refresh: refreshNet,
  pending: netPending,
  error: netError,
} = useLazyFetch<NetCheckReport | null>('/api/v1/admin/diagnostics/network', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

// Surface failures first: anything that is not clean (ok / public-ok / not-wired /
// dns-only — the verdicts verdictBadge renders green or neutral) floats up.
const netRecords = computed(() => {
  const recs = netData.value?.records ?? []
  const clean = (v: string) => (v === 'ok' || v === 'public-ok' || v === 'not-wired' || v === 'dns-only' ? 1 : 0)
  return [...recs].sort((a, b) => clean(a.verdict) - clean(b.verdict))
})

function verdictBadge(
  v: NetCheckReport['records'][number]['verdict'],
): { kind: 'rag-green' | 'rag-red' | 'neutral'; label: string } {
  // Neutral state for deliberately-unwired services (server/azure/network-check.ts).
  if (v === 'not-wired') return { kind: 'neutral', label: 'not mapped / not implemented' }
  // Resolved private, deliberately not dialled: an AMPLS member we never call.
  // Green because the DNS answer is the good one, labelled so nobody reads it
  // as a reachability result we did not measure.
  if (v === 'dns-only') return { kind: 'rag-green', label: 'dns ok · not dialled' }
  return v === 'ok' || v === 'public-ok'
    ? { kind: 'rag-green', label: v }
    : { kind: 'rag-red', label: v }
}

function privBadge(isPrivate: boolean | undefined): { kind: 'rag-green' | 'rag-red'; label: string } {
  return isPrivate ? { kind: 'rag-green', label: 'private' } : { kind: 'rag-red', label: 'public' }
}

function reachText(r: NetCheckReport['records'][number]): string {
  if (r.reachable === null) return '—'
  if (r.reachable) return `✓ ${r.tcpLatencyMs ?? '?'}ms`
  return '✗'
}

const itCopied = ref(false)
async function copyItReport() {
  const text = netData.value?.itReport
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    itCopied.value = true
    setTimeout(() => {
      itCopied.value = false
    }, 2000)
  } catch {
    itCopied.value = false
  }
}

// --- Card B: OTel telemetry (Log Analytics) ------------------------------
// Platform-admin only; a region admin gets a 403 which lands in otelError and
// is rendered as a status message rather than throwing.
const {
  data: otelData,
  refresh: refreshOtel,
  pending: otelPending,
  error: otelError,
} = useLazyFetch<OtelDiag | null>('/api/v1/admin/diagnostics/otel-logs', {
  query: { hours: 6 },
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

// --- RLS enforcement posture --------------------------------------------
// The MEASUREMENT that replaces an assumption. Enabling RLS enforcement
// (docs/design/rls-enforcement.md) needs a non-owner database role, and the plan
// for creating it rests on Azure's documentation saying the migration runner's
// admin login can. Nobody can reach the dev database from outside the VNet, so
// this card is the only place that claim can be checked. Platform-admin only; a
// 403 renders as a calm scoped-out note, like the two cards above.
// Shape mirrors scripts/preflight-rls.ts::RlsPostureReport (the page's own
// convention — see NetCheckReport above).
interface RlsPostureResp {
  measuredAt: string
  capability: {
    currentUser: string
    sessionUser: string
    isSuperuser: boolean
    canCreateRole: boolean
    canBypassRls: boolean
    azurePgAdmin: { rolePresent: boolean; isMember: boolean | null }
    createRoleViaSetRole: string[]
    canProvisionRole: boolean
    provisionBasis: 'superuser' | 'createrole' | 'set-role' | 'none'
  }
  appRole: {
    roleName: string
    exists: boolean
    canLogin: boolean | null
    inherits: boolean | null
    memberOf: string[]
    grants: {
      schemaUsage: boolean
      tablesTotal: number
      canSelect: number
      canInsert: number
      canUpdate: number
      canDelete: number
    } | null
  }
  connection: {
    currentUser: string
    lane: 'owner' | 'app-role' | 'other'
    ownedTables: number
    bypass: { superuser: boolean; bypassRls: boolean; owner: boolean }
  }
  summary: {
    tablesReported: number
    rlsEnabled: number
    rlsForced: number
    policies: number
    policiesApply: number
    bootstrapStillEnabled: string[]
  }
  tables: Array<{
    table: string
    rlsEnabled: boolean
    rlsForced: boolean
    policyCount: number
    owner: string
    currentUserOwns: boolean
    bootstrap: boolean
    policiesApply: boolean
  }>
  line: string
}
const {
  data: rlsData,
  refresh: refreshRls,
  pending: rlsPending,
  error: rlsError,
} = useLazyFetch<RlsPostureResp | null>('/api/v1/admin/diagnostics/rls-posture', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

/*
 * Reading order, top-down: the BOOTSTRAP tables first (they are step 0 of the
 * runbook — they must be DISABLED before the app switches role, or every device
 * fails to authenticate), then anything whose policies are not executing, then
 * the rest alphabetically.
 */
const rlsTables = computed(() => {
  const rows = rlsData.value?.tables ?? []
  return [...rows].sort(
    (a, b) =>
      Number(b.bootstrap) - Number(a.bootstrap) ||
      Number(a.policiesApply) - Number(b.policiesApply) ||
      a.table.localeCompare(b.table),
  )
})

// "0 of 23 enforced" is the state the design doc opens with, so it is amber
// (known, expected, not yet done) rather than red (something broke).
const rlsEnforcementBadge = computed<{ kind: 'rag-green' | 'rag-amber' | 'neutral'; label: string }>(
  () => {
    const s = rlsData.value?.summary
    if (!s || s.rlsEnabled === 0) return { kind: 'neutral', label: 'no RLS tables' }
    if (s.policiesApply === 0) return { kind: 'rag-amber', label: `0 of ${s.rlsEnabled} enforced` }
    if (s.policiesApply < s.rlsEnabled) {
      return { kind: 'rag-amber', label: `${s.policiesApply} of ${s.rlsEnabled} enforced` }
    }
    return { kind: 'rag-green', label: `${s.rlsEnabled} of ${s.rlsEnabled} enforced` }
  },
)

// --- Card C: attribution gaps (devices emitting but not attributing) ------
// The operator surface for the silent-attribution outage class. Calls the SAME
// predicate the attribution-gap worker alerts on, so this list and the alert can
// never disagree — an operator uses this to judge whether an alert is real.
interface AttributionGapInstance {
  instanceId: string
  email: string | null
  lastBearerAt: string
  lastAttributedAt: string | null
  gapHours: number
}
interface AttributionGapsResp {
  reachable: boolean
  error?: string
  count: number
  instances: AttributionGapInstance[]
}
const {
  data: gapsData,
  refresh: refreshGaps,
  pending: gapsPending,
  error: gapsError,
} = useLazyFetch<AttributionGapsResp | null>('/api/v1/admin/diagnostics/attribution-gaps', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

function gapDays(hours: number): string {
  const d = hours / 24
  return d >= 1 ? `${d.toFixed(1)}d` : `${hours.toFixed(1)}h`
}

// --- Card: §A/§B decomposition (the Workstream A gate) --------------------
// The gate has two halves. CORRECTNESS (does the delta decompose to a zero
// residual?) is settled by integration tests against synthesised data. MAGNITUDE
// (do non-Code surfaces actually dominate?) is a question about production
// numbers, and since nobody can run SQL against Dev the only way to answer it is
// to render it here. The endpoint computes the verdict rather than leaving an
// operator to eyeball a table of signed numbers and guess.
interface UnhomedCauseRow {
  cause: UnhomedCause
  usd: string
  countKind: 'teammates' | 'org-units' | 'provider-organisations'
  count: number
  secondaryCount: number | null
  secondaryKind: 'teammates' | 'regions' | null
  placementFailure: boolean
}
interface UnhomedWorklistRow {
  kind: 'teammate' | 'org-unit' | 'provider-organisation'
  label: string
  sublabel: string | null
  region: string | null
  usd: string
  headcount: number | null
}
interface UnhomedWorklist {
  cause: UnhomedCause
  rows: UnhomedWorklistRow[]
  shown: number
  total: number
  shownUsd: string
  bucketUsd: string
}
interface UnhomedMonthRow {
  month: string
  state: 'measured' | 'no-spend' | 'not-measured'
  unhomedUsd: string | null
  chargeableUsd: string | null
  sharePct: number | null
  /** null = this month's snapshot read failed. Renders "Unknown", never inferred. */
  recorded: boolean | null
  selected: boolean
  partial: boolean
}
interface UnhomedProbe {
  unhomedUsd: string
  chargeableUsd: string
  /** Chargeable SOURCE ROWS in the window — what "empty month" is decided on. Both
   *  money figures are signed sums and cancel; a row count cannot. */
  sourceRows: number
  causes: UnhomedCauseRow[]
  residualUsd: string
  reconciles: boolean
  worklists: UnhomedWorklist[]
  placementConfig: {
    activeCostOwningUnits: number
    unitsWithCostCentreCode: number
    activeOwners: number
    unitsWithActiveOwner: number
    ownersWithDirectoryIdentity: number
  } | null
  history: UnhomedMonthRow[]
  estateFirstMonth: string | null
}

interface AbDecompositionResp {
  reachable: boolean
  error?: string
  window: { from: string; to: string }
  sectionA: string
  sectionB: string
  delta: string
  terms: Record<AbDecompositionTermName, string>
  termOrder: readonly AbDecompositionTermName[]
  residual: string
  diagnostics: {
    unhomedChargeUsd: string
    quarantinedOtelUsd: string
    codingAgentInSectionAUsd: string
  }
  verdict: 'residual-non-zero' | 'no-delta' | 'non-code-dominates' | 'non-code-does-not-dominate'
  nonCodeShareOfExplained: number | null
  // The cause split behind the unhomed figure. null = the sub-probe failed and
  // the section must say "No reading" rather than render a plausible zero.
  unhomed: UnhomedProbe | null
  unhomedError: string | null
  unhomedWorklistCap: number
  unhomedHistoryMonths: number
  visibility: {
    personas: { key: string; label: string; scopes: string[] }[]
    elevated: { teammates: number; operational: number; finance: number }
  }
}

/** Default to LAST month: the current month is always partial, and a partial
 *  month reads as a spurious gap because §B lands on a monthly billing cadence
 *  while §A accrues continuously. */
function lastMonthParam(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const abMonth = ref(lastMonthParam())

const {
  data: abData,
  error: abError,
  refresh: refreshAb,
  pending: abPending,
} = useLazyFetch<AbDecompositionResp | null>('/api/v1/admin/diagnostics/ab-decomposition', {
  query: { from: abMonth },
  server: false,
  default: () => null,
  immediate: canSeeEstateFinance.value,
})

/*
 * A zero non-Code term and a small-but-present one produce the SAME
 * 'non-code-does-not-dominate' verdict and the same 0%, but they mean opposite
 * things: the first is a null result (the gate's question has nothing to bite
 * on), the second is evidence against the design. The verdict cannot carry the
 * distinction because it is a share, so the card reads the term itself.
 */
const abNonCodeIsZero = computed(
  () => Number(abData.value?.terms?.nonCodeSurfaces ?? 0) === 0,
)

/*
 * Keyed by the term UNION, not by `string`. The module goes to some trouble to
 * make the term list undriftable (adding a term is a compile error in every
 * consumer); typing these as Record<string, string> left the one surface an
 * operator actually reads as the exception, where an eleventh term would have
 * rendered its raw key and a blank hint.
 */
const AB_TERM_LABELS: Record<AbDecompositionTermName, string> = {
  nonCodeSurfaces: 'Non-Code Claude surfaces',
  licenceLanes: 'Copilot licence lanes',
  copilotAgentUsage: 'Copilot coding-agent lane',
  copilotUsageGap: 'Copilot usage grain gap',
  quarantine: 'Quarantined sessions',
  floor: 'Reconciliation floor',
  chargebackExemptUsage: 'Chargeback-exempt usage',
  populationDifference: 'Population difference',
  homingLoss: 'Homing loss',
  unreconciledApiLag: 'Reconciliation lag',
  unreconciledApiStale: 'Stale reconciliation',
}
const AB_TERM_HINTS: Record<AbDecompositionTermName, string> = {
  nonCodeSurfaces: 'Billed by Anthropic, absent from both attributed-usage arms — the design expects this to dominate.',
  licenceLanes: 'Copilot seat SKUs. A pure sum: an idle licensed seat has no attributed-usage counterpart.',
  copilotAgentUsage:
    'Coding-agent spend, billed inside the pooled Copilot invoice but invisible to the usage rollups by design: it emits no telemetry and is never taggable. A genuine completeness hole rather than a measurement artefact, so it is named here instead of being folded into the line below.',
  copilotUsageGap:
    'What remains of the pooled enterprise invoice once the coding-agent lane above is named, measured against per-user usage. Mostly the pooled-vs-per-user grain difference, but not only that: a Copilot user with no teammate mapping is skipped before any usage row is written, so their spend is billed here and invisible to attributed usage. That amount cannot be computed from stored data (it exists only in the live provider roster) — see Unresolved Copilot users for it.',
  quarantine:
    'Spend a developer disowned. Always zero here, but not by being absent from both sides: where the provider API corroborates the same day, reconciliation returns the amount to attributed usage and chargeback bills it, so it cancels; where nothing corroborates it, it enters neither. The amount is shown below.',
  floor: 'Where OTel over-reads the API, the floor keeps attributed usage high. Negative by construction.',
  chargebackExemptUsage:
    'Spend flagged chargeback-exempt. Every chargeable lane filters it out of chargeback, but nothing filters it out of attributed usage, so it is genuine usage that is deliberately not billed. Negative by construction. Not a fault — governance working as configured.',
  populationDifference: 'Spend whose teammate no longer resolves. Structurally zero today.',
  homingLoss: 'Zero at estate level by construction — see the unhomed figure below, which is not.',
  unreconciledApiLag:
    'Billed spend the reconciliation worker has not folded into attributed usage yet, so chargeback carries it and attributed usage does not. Self-healing while the day is still inside the worker\'s trailing 35-day window; an older month needs a backfill before it clears.',
  unreconciledApiStale:
    'The opposite direction: attributed usage already carries more than the API now reports, typically late telemetry arriving after a day was reconciled. Shown separately from the lag above because the two cancel if summed, and they call for different responses.',
}

function abUsd(v: string | undefined): string {
  if (v === undefined) return '—'
  const n = Number(v)
  const sign = n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/*
 * --- The unhomed cause split -------------------------------------------------
 * Same voice as AB_TERM_HINTS above: every line says what the number IS and what
 * it MEANS. A labelled table of four dollar amounts would be a regression
 * against the surface it extends.
 */
const UNHOMED_LABELS: Record<UnhomedCause, string> = {
  'no-region': 'Teammate has no region',
  'region-no-unit': 'Teammate is in a region but not in a unit',
  'no-cost-owning-ancestor': 'Unit has no Business Unit above it',
  // NAMED FOR WHAT IT MEASURES. The bucket reads the Copilot pooled bill and its
  // overage allocation and nothing else; calling it "pooled provider" promised a
  // generality the query has never had (see shared/usage/unhomed-causes.ts).
  'pooled-copilot': 'Pooled Copilot spend with no Business Unit',
}
const UNHOMED_HINTS: Record<UnhomedCause, string> = {
  'no-region':
    'The platform could not place these people in any region at all: no directory match, no manager chain, no billing region. They sit in the system-wide holding region, so their spend reaches no region’s report and no Business Unit.',
  'region-no-unit':
    'The region is known; the unit is not. They sit on their region’s holding node, which is deliberately not a Business Unit, so their spend reaches the region and stops there.',
  'no-cost-owning-ancestor':
    'These people are in a real unit, but neither it nor anything above it at any depth is both a Business Unit and active. The tree is fine; the Business Unit flag is missing, or the unit that carried it has been retired.',
  'pooled-copilot':
    'COPILOT invoice lines billed to the enterprise as a pool rather than to a person, whose provider organisation is not homed to a Business Unit. This is not a placement failure and placing people will not move it — the organisation is what needs homing. Copilot is the only pooled provider this bucket covers: another one would not appear here, it would land in the residual and suppress this whole breakdown.',
}
/*
 * ROLE NAMES COME FROM THE SHARED PERSONA LIST, never re-typed here. The scope
 * vocabulary was lifted to shared/auth/report-visibility.ts precisely so this
 * card and the policy pane cannot drift — and then the OWNER labels three lines
 * below were typed as free text ("Region admin", "Global finance"), which is a
 * second vocabulary for the same roles on the same card. Rename a persona there
 * and this panel follows.
 */
const PERSONA_LABEL = Object.fromEntries(
  REPORT_VISIBILITY_PERSONAS.map((p) => [p.key, p.label]),
) as Record<(typeof REPORT_VISIBILITY_PERSONAS)[number]['key'], string>

/** The one admin role owns every fix here, and is the one reading this page. */
const ORG_WIDE_LABEL = PERSONA_LABEL['platform-admin']

/* Each cause names its ACTION and its OWNER. */
const UNHOMED_ACTIONS: Record<UnhomedCause, { action: string; owner: string }> = {
  'no-region': {
    action:
      'Give the person a region, or add a directory region rule / region leader so the re-enrichment worker heals the whole population in bulk.',
    owner: ORG_WIDE_LABEL,
  },
  'region-no-unit': {
    action: 'Place the person into a Business Unit in their own region.',
    owner: ORG_WIDE_LABEL,
  },
  'no-cost-owning-ancestor': {
    action:
      'Mark a unit in that ancestry as a Business Unit, or un-retire the unit that carried it. (Setting a unit’s directory cost-centre code has no admin surface today — see the counters below.)',
    owner: ORG_WIDE_LABEL,
  },
  'pooled-copilot': {
    action: 'Home the provider organisation to a Business Unit, on the reconciliation surface.',
    owner: ORG_WIDE_LABEL,
  },
}
const UNHOMED_COUNT_NOUNS: Record<UnhomedCauseRow['countKind'], [string, string]> = {
  teammates: ['person', 'people'],
  'org-units': ['unit', 'units'],
  'provider-organisations': ['organisation', 'organisations'],
}
const UNHOMED_SECONDARY_NOUNS: Record<'teammates' | 'regions', [string, string]> = {
  teammates: ['person', 'people'],
  regions: ['region', 'regions'],
}

function plural(n: number, nouns: [string, string]): string {
  return `${n.toLocaleString()} ${n === 1 ? nouns[0] : nouns[1]}`
}

/** "$X, N people across R regions" — never a row count (PB-5). */
function unhomedCounts(c: UnhomedCauseRow): string {
  const primary = plural(c.count, UNHOMED_COUNT_NOUNS[c.countKind])
  if (c.secondaryKind === null || c.secondaryCount === null) return primary
  return `${primary}, ${plural(c.secondaryCount, UNHOMED_SECONDARY_NOUNS[c.secondaryKind])}`
}

const unhomedProbe = computed(() => abData.value?.unhomed ?? null)

/*
 * The one thing that makes the other five numbers trustworthy. A split that does
 * not add back to the figure it decomposes is worse than no split: it invites an
 * operator to size a remediation against a bucket that is quietly missing money.
 */
const unhomedReconciles = computed(() => unhomedProbe.value?.reconciles === true)

/*
 * A month with NOTHING TO SPLIT — "$0.00 unhomed (0%)" would be a lie.
 *
 * DECIDED ON SOURCE ROWS, NEVER ON THE SUMS. Both money figures are signed: a
 * credit note nets chargeable to $0.00 over homed money, and two unhomed rows of
 * opposite sign net BOTH figures to $0.00 with the split behind them full of
 * people. Requiring both sums to be zero caught only the first of those and still
 * printed "nothing to home" over the second — the exact money this panel exists
 * to show. A row count cannot cancel: 0 rows is the only thing that means empty.
 */
const unhomedNothingToSplit = computed(
  () => unhomedProbe.value != null && unhomedProbe.value.sourceRows === 0,
)

/*
 * Only the lists with something in them. An empty bucket has nothing to drill
 * into, and rendering its heading anyway would read as "we looked and found
 * nothing to fix" beside a bucket that is simply $0.00 — the cause table above
 * already says that, in words.
 */
const unhomedVisibleWorklists = computed<UnhomedWorklist[]>(() =>
  (unhomedProbe.value?.worklists ?? []).filter((w) => w.rows.length > 0),
)

function unhomedMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/*
 * RECORDING A MONTH FREEZES NOTHING — narrower again than this used to say, and
 * the narrowing has gone all the way to zero.
 *
 * It once claimed a close froze everything; it was corrected to "only the
 * governance VERDICTS, not homing"; and now a snapshot records what a month read
 * and locks nothing at all. Verdicts recompute on any month, the provider's bill
 * always lands, and placing someone today still moves a recorded month's figure.
 * What a snapshot buys is that the month can SAY it moved.
 */
/*
 * RECORDED / NOT RECORDED / UNKNOWN. This used to be Open / Closed, where
 * "Closed" meant the month's verdicts were FROZEN and a correction needed an
 * audited reopen or restate. Nothing freezes any more: closing records what a
 * month read, and a month that subsequently moves reports the difference. So
 * the word had to change with the thing.
 */
const snapshotConsequence: Record<'recorded' | 'not-recorded' | 'unknown', string> = {
  recorded:
    'Recorded — a snapshot of this month exists. It is not frozen: remediation you do today still moves this figure, and the month will report the difference against what was recorded.',
  'not-recorded':
    'Not recorded — no snapshot has been taken of this month. It recomputes like any other, and nothing is being compared against.',
  unknown:
    'Unknown — the snapshot read for this month failed. This is not “not recorded”: whether a record exists is unanswered.',
}

/** A failed read is its own state, never silently "not recorded". */
function snapshotKey(recorded: boolean | null): 'recorded' | 'not-recorded' | 'unknown' {
  return recorded === null ? 'unknown' : recorded ? 'recorded' : 'not-recorded'
}
const SNAPSHOT_WORD: Record<'recorded' | 'not-recorded' | 'unknown', string> = {
  recorded: 'Recorded',
  'not-recorded': 'Not recorded',
  unknown: 'Unknown',
}


// "This device is N days behind" leaves the operator with one question and no
// way to ask it: is the telemetry in ingest at all? IN-but-unattributed is ours
// (the joiner); ABSENT is the client's. The workspace is NSP-locked to the app's
// managed identity, so this can only be asked from inside the product.
interface InstanceTelemetryResp {
  instanceId: string
  windowHours: number
  known: boolean
  instance: {
    teammateEmail: string | null
    lastBearerAt: string | null
    endedAt: string | null
    // CLIENT-ASSERTED (mig 0092) — a diagnostic hint, never a basis for a
    // decision. null = this device has never reported, i.e. it is running a
    // build older than the one that reports.
    clientPluginVersion: string | null
    clientCliVersion: string | null
    clientVersionAt: string | null
    // Same trust model (mig 0150): `<os>-<arch>`, launch surface, and the mode
    // of the latest setup redeem (full | emit-only).
    clientPlatform: string | null
    clientSurface: string | null
    setupMode: string | null
  } | null
  ingest:
    | { reachable: true; records: number; usageRecords: number; firstSeen: string | null; lastSeen: string | null }
    | { reachable: false; error: string | null }
  attribution: { records: number; firstTsEvent: string | null; lastTsEvent: string | null }
  verdict: string
  side: 'client' | 'server' | 'none' | null
  interpretation: string
}

const diagnosing = ref<string | null>(null)
const diagnosis = ref<Record<string, InstanceTelemetryResp | { failed: string }>>({})

async function diagnoseInstance(instanceId: string, gapHours: number) {
  diagnosing.value = instanceId
  try {
    // Window = the gap plus a day of headroom, so the probe covers the period the
    // detector is complaining about rather than a fixed guess that could miss it
    // entirely. Bounded to the 90-day retention ceiling the API enforces.
    const hours = Math.min(Math.max(Math.ceil(gapHours) + 24, 1), 24 * 90)
    diagnosis.value = {
      ...diagnosis.value,
      [instanceId]: await $fetch<InstanceTelemetryResp>('/api/v1/admin/diagnostics/instance-telemetry', {
        query: { instanceId, hours },
      }),
    }
  } catch (err) {
    // Show the failure rather than leaving the row silent — an unrun probe must
    // never look like a conclusive answer.
    diagnosis.value = {
      ...diagnosis.value,
      [instanceId]: { failed: err instanceof Error ? err.message : String(err) },
    }
  } finally {
    diagnosing.value = null
  }
}

function telemetryVerdictBadge(verdict: string): { kind: 'rag-green' | 'rag-amber' | 'rag-red' | 'neutral'; label: string } {
  switch (verdict) {
    case 'absent-from-ingest':
      return { kind: 'rag-red', label: 'Client side' }
    case 'ingested-without-usage':
      // Also the client: exporting, but not usage events. A re-read cannot help,
      // so it must NOT read as the joiner's amber.
      return { kind: 'rag-red', label: 'Client side (no usage events)' }
    case 'ingested-not-attributed':
      return { kind: 'rag-amber', label: 'Our side (telemetry join)' }
    case 'attributed':
      return { kind: 'rag-green', label: 'Healthy window' }
    case 'attributed-beyond-ingest-window':
      return { kind: 'neutral', label: 'Window too wide' }
    default:
      // Including 'unanswerable' — an unread probe is NOT a green light and must
      // never be styled as one.
      return { kind: 'neutral', label: 'Unanswerable' }
  }
}

// --- Card C(b): the widened-read recovery lever ---------------------------
// The reader accepts a lookback up to 90 days but nothing an admin could touch
// ever passed it, so a backlog older than a week was unrecoverable from the
// product. Enqueue-only: a 90-day read cannot be served inside the ~120s worker
// gateway, so the telemetry-recovery worker drains it in resumable slices.
interface RecoveryRequestRow {
  id: string
  status: string
  lookbackDays: number
  instanceCount: number
  instancesProcessed: number
  percentComplete: number
  rowsWritten: number
  errors: number
  reason: string | null
  error: string | null
  requestedByEmail: string | null
  kind: 'operator' | 'scheduled'
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
}
const {
  data: recoveryData,
  refresh: refreshRecovery,
  pending: recoveryPending,
} = useLazyFetch<{ requests: RecoveryRequestRow[]; inFlight: boolean } | null>(
  '/api/v1/admin/diagnostics/telemetry-recovery',
  { server: false, default: () => null, immediate: isAdmin.value },
)

/*
 * The page-level Refresh re-issues every read this page declares (the
 * estate-finance decomposition only where the caller can see it — refreshing
 * a read whose card is hidden would just be a deterministic 403).
 */
function refreshAll() {
  return Promise.all([
    refresh(),
    refreshProbes(),
    refreshCosting(),
    refreshNet(),
    refreshOtel(),
    refreshRls(),
    refreshGaps(),
    refreshRecovery(),
    ...(canSeeEstateFinance.value ? [refreshAb()] : []),
  ])
}

/*
 * Enqueueing is platform-admin-only (it is not region-bounded and it spends Log
 * Analytics query budget); the Diagnose probe above is open to the wider admin
 * tier. Gate the control rather than letting a region admin press a button that
 * can only 403 — an operator mid-incident should not have to discover their own
 * permissions from an error.
 */
const canRecover = computed(() => {
  // MUST match the POST endpoint's requireRole exactly (platform-admin only).
  // This previously also allowed platform-admin, which the endpoint rejects — so
  // the button rendered and deterministically 403'd, the precise thing the note
  // above says not to do. If platform-admin should be able to enqueue a
  // recovery, widen the ENDPOINT deliberately and change both together.
  return session.value?.role === 'platform-admin'
})

const recoveryLookbackDays = ref(30)
const recoverySubmitting = ref(false)
const recoveryMessage = ref<string | null>(null)

async function requestRecovery() {
  const instanceIds = (gapsData.value?.instances ?? []).map((i) => i.instanceId)
  if (instanceIds.length === 0) return
  const reason = (
    globalThis.prompt(
      `Re-read ${instanceIds.length} device(s) at ${recoveryLookbackDays.value} days. Why? (recorded + audited):`,
    ) ?? ''
  ).trim()
  if (!reason) return
  recoverySubmitting.value = true
  recoveryMessage.value = null
  try {
    const res = await $fetch<{ id: string; instanceCount: number; note: string }>(
      '/api/v1/admin/diagnostics/telemetry-recovery',
      { method: 'POST', body: { instanceIds, lookbackDays: recoveryLookbackDays.value, reason } },
    )
    // Deliberately does NOT say "recovered". Acceptance is not completion — that
    // conflation is the bug class this whole panel exists to remove.
    recoveryMessage.value = `Queued ${res.instanceCount} device(s). ${res.note}`
    await refreshRecovery()
  } catch (err) {
    recoveryMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    recoverySubmitting.value = false
  }
}

/* --- Card D: Provider wire shape ------------------------------------------
 * What do the providers actually send? Every claim we had came from our own Zod
 * schemas, and two of the three are permissive enough to parse identically
 * whether a field arrives, arrives null, or never arrives — so they are not
 * evidence. This card reports the SHAPE of real payloads: paths, types, and how
 * often each key is present. It never renders a response body.
 *
 * NOT fetched on mount. The live mode issues real provider calls, so it is
 * button-triggered; the free stored scan is the default so a mis-click cannot
 * spend provider budget.
 */
interface WirePathStat {
  path: string
  types: string[]
  present: number
  total: number
  nulls: number
  distinctValues?: string[]
  valuesWithheld?: 'denylisted-key' | 'high-cardinality' | 'value-shape' | 'surfaced-elsewhere'
}
interface WireDrift {
  status: 'no-baseline' | 'no-data' | 'match' | 'drift' | 'inconclusive'
  note?: string
  baseline?: { provenance: 'schema-derived' | 'live-capture'; capturedAt: string | null; note: string }
  added?: string[]
  removed?: string[]
  absentOptional?: string[]
  notObserved?: string[]
  typeChanged?: { path: string; baseline: string[]; live: string[]; unexpected: string[] }[]
  presenceMoved?: { path: string; baselineRate: number; liveRate: number; present: number; total: number }[]
}
interface WireSurface {
  id: string
  label: string
  endpoint: string
  mode: 'live' | 'stored'
  status: 'not-configured' | 'errored' | 'ok'
  reason?: string
  target?: string | null
  request?: { method: string; path: string; params: [string, string][]; note: string } | null
  error?: { status: number; bodyText: string; truncated: boolean }
  summary?: { itemsPath: string; itemCount: number; paths: WirePathStat[] }
  drift?: WireDrift
  undeclared?: { kind: string; paths: string[]; note: string }
  freshness?: {
    dataRefreshedAt: string | null
    windowEndingAt: string
    coversWindow: boolean | null
    note: string
  } | null
  fetchBound?: {
    linksAvailable: number
    linksRead: number
    lineLimit: number
    linesRead: number
    linesCapped: boolean
    linesUnparseable: number
    note: string
  } | null
  scan?: {
    windowDays: number
    rowLimit: number
    rowsScanned: number
    capped: boolean
    source: string
    filter: string
    unfiltered?: {
      rowsForProvider: number
      rowsForEnterprise: number
      note: string
    }
  }
  defaultedPaths?: string[]
  unobservable?: { paths: string[]; note: string }
  durationMs?: number
}
interface WireShapeResp {
  generatedAt: string
  day: string
  mode: string
  note: string
  live: WireSurface[]
  stored: WireSurface[]
}

/*
 * MUST match the POST endpoint's requireRole exactly (platform-admin only). A
 * button that renders for a role the endpoint rejects can only 403 — the same
 * mismatch the recovery control's comment above records.
 */
const canProbeWireShape = computed(() => session.value?.role === 'platform-admin')

const wireData = ref<WireShapeResp | null>(null)
const wireRunning = ref<'stored' | 'both' | null>(null)
const wireError = ref<string | null>(null)
const wireCopied = ref(false)
const wireExpanded = ref<Record<string, boolean>>({})

async function runWireShape(mode: 'stored' | 'both') {
  if (wireRunning.value) return
  wireRunning.value = mode
  wireError.value = null
  try {
    wireData.value = await $fetch<WireShapeResp>('/api/v1/admin/diagnostics/provider-wire-shape', {
      method: 'POST',
      body: { mode },
    })
  } catch (err) {
    wireError.value = err instanceof Error ? err.message : String(err)
  } finally {
    wireRunning.value = null
  }
}

// Live surfaces first, then the stored scan of the same surfaces — the delta
// between the two is the point, so they read best adjacent.
const wireSurfaces = computed<WireSurface[]>(() => [
  ...(wireData.value?.live ?? []),
  ...(wireData.value?.stored ?? []),
])

/** Total undeclared paths across every surface — the headline number. */
const wireUndeclaredTotal = computed(() =>
  wireSurfaces.value.reduce((n, s) => n + (s.undeclared?.paths.length ?? 0), 0),
)

function wireStatusBadge(s: WireSurface): { kind: 'neutral' | 'rag-green' | 'rag-red'; label: string } {
  if (s.status === 'not-configured') return { kind: 'neutral', label: 'not configured' }
  if (s.status === 'errored') return { kind: 'rag-red', label: 'error' }
  return { kind: 'rag-green', label: 'ok' }
}

/*
 * The badge names WHAT the payload was compared against, and that is a property
 * of the baseline, not a constant: a 'schema-derived' baseline records what our
 * Zod assumes, a 'live-capture' one records what a previous run observed.
 * Hardcoding "schema" would mislabel every comparison against a capture.
 */
function wireDriftBadge(d?: WireDrift): { kind: 'neutral' | 'rag-green' | 'rag-amber' | 'rag-red'; label: string } {
  if (!d) return { kind: 'neutral', label: '—' }
  const ref = d.baseline?.provenance === 'live-capture' ? 'last capture' : 'schema'
  if (d.status === 'drift') return { kind: 'rag-red', label: `differs from ${ref}` }
  if (d.status === 'match') return { kind: 'rag-green', label: `matches ${ref}` }
  if (d.status === 'inconclusive') return { kind: 'rag-amber', label: 'inconclusive' }
  if (d.status === 'no-data') return { kind: 'neutral', label: 'no rows observed' }
  return { kind: 'neutral', label: 'no baseline' }
}

/** Presence as a percentage, or an em dash when the denominator is zero. */
function wirePct(present: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((present / total) * 100)}%`
}

function wireWithheldLabel(reason: WirePathStat['valuesWithheld']): string {
  if (reason === 'denylisted-key') return 'values withheld (identity or money key)'
  if (reason === 'high-cardinality') return 'values withheld (>50 distinct)'
  if (reason === 'surfaced-elsewhere') return 'not collected here (reported under freshness)'
  return 'values withheld (value looked sensitive)'
}

function toggleWireSurface(key: string) {
  wireExpanded.value[key] = !wireExpanded.value[key]
}

/*
 * Copy the whole report as JSON. This is how a baseline gets refreshed: paste a
 * surface's `summary` into server/diagnostics/baselines/<id>.json, convert the
 * counts to rates and set provenance to 'live-capture'.
 */
async function copyWireReport() {
  if (!wireData.value) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(wireData.value, null, 2))
    wireCopied.value = true
    setTimeout(() => {
      wireCopied.value = false
    }, 2000)
  } catch {
    wireCopied.value = false
  }
}

// --- Worker enable/disable (mig 0090) -------------------------------------
// Activation used to be infra-only: stopping a misbehaving scheduled worker meant
// editing bicep and redeploying. This makes it a runtime, audited admin decision.
const expandedQueries = ref<Record<string, boolean>>({})
function toggleQuery(label: string) {
  expandedQueries.value[label] = !expandedQueries.value[label]
}

function pretty(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}
</script>

<template>
  <div
    v-if="isAdmin"
    class="max-w-[1600px] mx-auto px-10 py-8 pb-20"
    data-testid="admin-diagnostics"
    data-admin-page="/admin/diagnostics"
  >
    <UiPageHead
      eyebrow="Administration"
      title="Diagnostics"
      sub="Health probes, plus the audited operator actions that follow from them, such as telemetry recovery. Workers are turned on and off on Worker controls."
    >
      <template #actions>
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="pending"
          data-testid="admin-diagnostics-refresh"
          @click="refreshAll()"
        >
          {{ pending ? 'Refreshing…' : 'Refresh' }}
        </UiButton>
      </template>
    </UiPageHead>

    <UiFetchErrorBanner :error="error" label="the health snapshot" @retry="refresh" />
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <!-- The DB-only snapshot (GET /diagnostics). Skeleton while its data is
           ABSENT, never a spinner over stale figures (D2). -->
      <div v-if="!error && data == null" class="lg:col-span-2" data-testid="admin-diag-snapshot-skeleton">
        <AdminPageSkeleton :rows="4" :toolbar="false" />
      </div>
      <template v-if="data">
      <!-- Pipeline freshness (emit -> gather). The signal that flags a silent
           emission outage: 'last usage seen' going stale while the joiner runs. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-pipeline">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Attribution pipeline</UiEyebrow>
          <UiBadge :kind="pipelineBadge.kind" data-testid="admin-diag-pipeline-badge">{{ pipelineBadge.label }}</UiBadge>
        </div>
        <!-- The read failed. "never" in both figures would be an idle pipeline,
             which is a completely different operational conclusion. -->
        <template v-if="pipelineUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Freshness could not be read</h2>
          <p class="mt-1 text-xs text-brand-hunger font-mono" data-testid="admin-diag-pipeline-unavailable">
            {{ pipelineUnavailable }}
          </p>
          <p class="text-xs text-carbon-3 mt-1">
            The query behind this card failed, so nothing here is known — this is not
            "no usage seen". Retry with Refresh; the correlation id above finds the full
            error in the server log.
          </p>
        </template>
        <template v-else>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-last-usage">
              {{ fmtAge(data.pipeline?.usageAgeMinutes ?? null) }}
            </h2>
            <p class="text-xs text-carbon-3 mt-1">
              Last <strong>usage seen</strong> (max ts_event) — {{ fmtTs(data.pipeline?.lastUsageSeen ?? null) }}.
              Stale here means clients stopped emitting or the ingest path is dropping.
            </p>
          </div>
          <div>
            <h2 class="text-lg font-bold text-carbon">{{ fmtAge(data.pipeline?.ledgerAgeMinutes ?? null) }}</h2>
            <p class="text-xs text-carbon-3 mt-1">
              Last <strong>ledger write</strong> (max ts_recorded) — {{ fmtTs(data.pipeline?.lastLedgerWrite ?? null) }}.
              When this keeps moving but usage is stale, the break is upstream in emit/ingest.
            </p>
          </div>
        </div>
        <p v-if="data.pipeline?.status === 'stale'" class="mt-3 text-xs text-brand-hunger">
          No usage seen in over 6 hours. If devs are active, check the client emit path
          (a 401 from /bearer silently drops telemetry).
        </p>
        </template>
      </UiCard>

      <!-- Worker execution health. The card the freshness panel CANNOT be:
           a worker cron failing every run while ts_recorded still advances.
           This is the card that would have shown the joiner red. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-workers">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Worker execution health</UiEyebrow>
          <UiBadge :kind="workersBadge.kind" data-testid="admin-diag-workers-badge">{{ workersBadge.label }}</UiBadge>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Outcome of each scheduled worker dispatch. A worker can be
          <strong>failing every run</strong> while the pipeline above still
          reads green — a partial run advances data recency. This is the signal
          that catches a silently-failing cron.
        </p>
        <!-- An empty list is what a failed read returns too, and it draws as the
             reassuring "no runs yet" below. Say which one this is. -->
        <div v-if="workersUnavailable">
          <p class="text-sm font-bold text-carbon-2">Worker health could not be read</p>
          <p class="mt-1 text-xs text-brand-hunger font-mono" data-testid="admin-diag-workers-unavailable">
            {{ workersUnavailable }}
          </p>
          <p class="text-xs text-carbon-3 mt-1">
            No conclusion can be drawn about the workers from this page right now — in
            particular, this is NOT "nothing has run".
          </p>
        </div>
        <ul v-else-if="data.workers?.length" class="divide-y divide-calm-2">
          <li
            v-for="w in data.workers"
            :key="w.worker"
            class="py-2"
            :data-testid="`admin-diag-worker-${w.worker}`"
          >
            <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <UiBadge :kind="workerChip(w.rag).kind">{{ workerChip(w.rag).label }}</UiBadge>
              <span class="font-mono text-sm text-carbon truncate">{{ w.worker }}</span>
              <!-- The ledger and the platform can disagree: a run that OVERRUNS the
                   dispatch budget finishes and records success here, while the cron
                   trigger gives up waiting and the platform reports a FAILED
                   execution and retries it. Without this chip that worker reads
                   'ok' on this card and red in Azure, and only someone holding both
                   views can tell. -->
              <UiBadge
                v-if="w.dispatchBudget === 'over' || w.dispatchBudget === 'near'"
                :kind="w.dispatchBudget === 'over' ? 'rag-red' : 'rag-amber'"
                :data-testid="`admin-diag-worker-${w.worker}-budget`"
              >
                {{ w.dispatchBudget === 'over' ? 'over dispatch budget' : 'near dispatch budget' }}
              </UiBadge>
            </div>
            <div class="text-right">
              <div class="text-xs text-carbon-3">{{ fmtWorkerRun(w.durationMs, w.ageMinutes) }}</div>
              <div
                v-if="w.consecutiveFailures > 0"
                class="text-[11px] font-bold text-brand-hunger"
                :data-testid="`admin-diag-worker-${w.worker}-fails`"
              >
                {{ w.consecutiveFailures }} consecutive failure{{ w.consecutiveFailures === 1 ? '' : 's' }}
              </div>
            </div>
            </div>
            <p
              v-if="w.dispatchBudgetReason"
              class="mt-1 text-[11px] text-brand-hunger max-w-3xl"
              :data-testid="`admin-diag-worker-${w.worker}-budget-reason`"
            >
              {{ w.dispatchBudgetReason }}
            </p>
            <!-- The stall evidence (ingest coverage · reader saw new · wrote ·
                 selected). Only the reader records it, so only its row shows it. -->
            <p
              v-if="stallEvidence(w)"
              class="mt-1 text-[11px] font-mono text-carbon-3"
              :data-testid="`admin-diag-worker-${w.worker}-evidence`"
            >
              {{ stallEvidence(w) }}
            </p>
          </li>
        </ul>
        <p v-else class="text-sm text-carbon-3 italic">
          No worker runs recorded yet. Runs appear once the scheduler dispatches a worker.
        </p>
      </UiCard>

      <!-- Turning a worker on/off is an ACTION and lives on its own Operations
           page; this page observes. The link stays because the two questions are
           adjacent: you disable a worker because its health here is bad. -->
      <p class="lg:col-span-2 text-xs text-carbon-3 -mt-1">
        To turn a worker off, go to
        <NuxtLink to="/admin/workers" class="text-brand-harmony underline" data-testid="link-worker-controls">
          Worker controls
        </NuxtLink>. A disabled worker keeps recording a
        <span class="font-mono">skipped</span> run above, so it never looks like a silent gap.
      </p>

      </template>

      <!-- 7-day costing aggregates (GET /diagnostics/costing): its own read, its
           own skeleton, so the snapshot above never waits on a fact-table scan. -->
      <div v-if="costingError" class="lg:col-span-2">
        <UiFetchErrorBanner :error="costingError" label="the costing aggregates" @retry="refreshCosting" />
      </div>
      <div v-else-if="costingData == null" class="lg:col-span-2" data-testid="admin-diag-costing-skeleton">
        <AdminPageSkeleton :rows="3" :toolbar="false" />
      </div>
      <template v-else>
      <!-- Costing rungs. The ladder is: 1) the provider's reported cost,
           2) the rate card, 3) skip the span. A healthy fleet is ENTIRELY
           provider-priced, so any rate-card-priced span is an ALERT state, not
           a statistic — a model the provider stopped pricing is billed from our
           own table and stays wrong until someone writes a rate line. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-costing-rungs">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Costing rungs (who priced the span)</UiEyebrow>
          <UiBadge :kind="costingBadge.kind" data-testid="admin-diag-costing-badge">{{ costingBadge.label }}</UiBadge>
        </div>

        <!-- A failed rungs read returns all-zero, which the "No Claude spans in
             the window" branch below draws as a quiet, healthy fleet. That is the
             false green this whole card exists to prevent, so it gets its own
             state rather than sharing the empty one. -->
        <template v-if="rungsUnavailable">
          <h2 class="text-lg font-bold text-carbon-2" data-testid="admin-diag-costing-headline">
            Costing rungs could not be read
          </h2>
          <p class="mt-2 text-xs text-brand-hunger font-mono" data-testid="admin-diag-costing-unavailable">
            {{ rungsUnavailable }}
          </p>
          <p class="text-xs text-carbon-3 mt-1">
            Whether any span fell back to the rate card is UNKNOWN right now. Do not read
            this as a provider-priced fleet.
          </p>
        </template>
        <template v-else-if="costingData.costingRungs?.spans > 0">
          <!-- The alert state comes FIRST and loudest when it is live. -->
          <template v-if="costingData.costingRungs.rateCard > 0">
            <h2 class="text-lg font-bold text-brand-hunger" data-testid="admin-diag-costing-headline">
              {{ costingData.costingRungs.rateCard.toLocaleString() }}
              span{{ costingData.costingRungs.rateCard === 1 ? '' : 's' }} fell back to the rate card
              <!-- The share is OF THE LADDER-PRICED SPANS (provider + rate-card),
                   not of every span in the window: backfill traffic lands in
                   `other` and must not be able to dilute a real fallback rate. -->
              <span class="text-sm font-medium text-carbon-3">
                — {{ costingData.costingRungs.rateCardPct ?? 0 }}% of
                {{ costingData.costingRungs.ladderSpans.toLocaleString() }} priced
                ({{ costingData.costingRungs.windowDays }}d)
              </span>
            </h2>
            <p class="text-xs text-brand-hunger mt-2">
              The provider reported no cost for these spans, so they were priced from our own
              rate card. That is not a costing mechanism — it is the exception that raises this
              alert. Expect the figure to be wrong for any model without a current rate line.
            </p>
            <div
              v-if="costingData.costingRungs.fallbackModels.length"
              class="mt-3"
              data-testid="admin-diag-costing-fallback"
            >
              <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">
                Models falling back
              </div>
              <ul class="divide-y divide-calm-2">
                <li
                  v-for="m in costingData.costingRungs.fallbackModels"
                  :key="m.model"
                  class="flex items-center justify-between py-1.5 text-sm"
                  :data-testid="`admin-diag-costing-fallback-${m.model}`"
                >
                  <span class="font-mono text-carbon truncate">{{ m.model }}</span>
                  <span class="text-xs text-brand-hunger font-bold">
                    {{ m.spans.toLocaleString() }} span{{ m.spans === 1 ? '' : 's' }}
                  </span>
                </li>
              </ul>
            </div>
          </template>
          <!-- Nothing on the ladder: say so rather than report a vacuous all-clear. -->
          <template v-else-if="costingData.costingRungs.ladderSpans === 0">
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-costing-headline">
              No spans were priced in the last {{ costingData.costingRungs.windowDays }} days
            </h2>
            <p class="text-xs text-carbon-3 mt-2">
              The window holds only backfill / telemetry-only spans, so there is nothing to
              judge. This is not a clean bill of health.
            </p>
          </template>
          <template v-else>
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-costing-headline">
              All {{ costingData.costingRungs.provider.toLocaleString() }} priced spans came from the provider
              <span class="text-sm font-medium text-carbon-3">
                (last {{ costingData.costingRungs.windowDays }} days)
              </span>
            </h2>
            <p class="text-xs text-carbon-3 mt-2">
              The provider states what each span cost and we record it. Nothing was re-derived from
              our rate card, so a newly-released model is priced correctly the day it appears.
            </p>
          </template>

          <!-- Every span in the window is accounted for, so the numbers add up
               and no bucket can hide. `other` is the backfill / telemetry-only
               provenance lane — neither rung, and not an alert. -->
          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="admin-diag-costing-counts">
            <UiBadge :kind="costingData.costingRungs.provider > 0 ? 'rag-green' : 'neutral'">
              provider {{ costingData.costingRungs.provider.toLocaleString() }}
            </UiBadge>
            <UiBadge :kind="costingData.costingRungs.rateCard > 0 ? 'rag-red' : 'neutral'">
              rate card {{ costingData.costingRungs.rateCard.toLocaleString() }}
            </UiBadge>
            <UiBadge kind="neutral">other {{ costingData.costingRungs.other.toLocaleString() }}</UiBadge>
          </div>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon-2">No Claude spans in the window</h2>
          <p class="text-xs text-carbon-3 mt-1">
            Nothing to rung. Spans appear here as usage lands in the last
            {{ costingData.costingRungs?.windowDays ?? 7 }} days. Copilot is excluded — it is priced from
            AI credits and never used a rate card.
          </p>
        </template>
      </UiCard>

      <!-- Cost drift (migs 0045/0091): our rate-card ESTIMATE vs the provider's
           own figure per span, last 7 days, across both cost vintages. Since the
           cutover this no longer governs the booked total (that IS the provider's
           number) — it governs the per-token-type SLICE and tells us when the
           card needs a rate line. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-cost-drift">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Cost drift (rate card vs provider)</UiEyebrow>
          <UiBadge :kind="driftBadge.kind" data-testid="admin-diag-drift-badge">{{ driftBadge.label }}</UiBadge>
        </div>
        <p v-if="driftScopedOut" class="text-sm text-carbon-3" data-testid="admin-diag-drift-scoped">
          Scoped out — cost drift is estate-wide (it has no region), so only an Admin can
          read it. Nothing is wrong; the costing-rung card above still covers your region.
        </p>
        <template v-else-if="driftUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Drift could not be read</h2>
          <p class="mt-2 text-xs text-brand-hunger font-mono" data-testid="admin-diag-drift-unavailable">
            {{ driftUnavailable }}
          </p>
          <p class="text-xs text-carbon-3 mt-1">
            A pre-0045 database has no <span class="font-mono">v_cost_drift</span>; anything
            else here is a genuine failure. Either way this is not "no comparable spans".
          </p>
        </template>
        <template v-else-if="costingData.costDrift && costingData.costDrift.spansCompared > 0">
          <h2 class="text-lg font-bold text-carbon">
            {{ costingData.costDrift.meanAbsDriftPct ?? 0 }}% mean drift
            <span class="text-sm font-medium text-carbon-3">across {{ costingData.costDrift.spansCompared.toLocaleString() }} spans (7d)</span>
          </h2>
          <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-drift-vintages">
            <span class="font-bold">{{ costingData.costDrift.providerPricedSpans.toLocaleString() }}</span>
            provider-priced ·
            <span class="font-bold">{{ costingData.costDrift.rateCardPricedSpans.toLocaleString() }}</span>
            rate-card-priced. Both vintages are compared the same way — our estimate against the
            provider's figure — so the number stays meaningful as history ages out.
          </p>
          <p v-if="costingData.costDrift.worstSpan" class="text-xs text-carbon-3 mt-2">
            Worst span: <span class="font-mono">{{ costingData.costDrift.worstSpan.model }}</span>
            (<span class="font-mono">{{ costingData.costDrift.worstSpan.pricedBy }}</span>) —
            rate-card ${{ costingData.costDrift.worstSpan.rateCardCostUsd }} vs provider ${{ costingData.costDrift.worstSpan.lawCostUsd }}
            (Δ ${{ costingData.costDrift.worstSpan.driftUsd }}).
          </p>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon-2">No comparable spans yet</h2>
          <p class="text-xs text-carbon-3 mt-1">
            A span is comparable once BOTH numbers exist for it: the provider's
            <span class="font-mono">law_cost_usd</span> and our rate-card estimate (which for a
            provider-priced span is persisted as
            <span class="font-mono">metadata.rate_card_cost_usd</span>). Spans missing either are
            left out rather than compared against themselves.
          </p>
        </template>
      </UiCard>
      </template>

      <template v-if="data">
      <!-- Postgres -->
      <UiCard accent="harmony" data-testid="admin-diag-postgres">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Postgres</UiEyebrow>
          <UiBadge :kind="pgBadge.kind">{{ pgBadge.label }}</UiBadge>
        </div>
        <h2 class="text-lg font-bold text-carbon">{{ data.postgres.latencyMs }}ms</h2>
        <p class="text-xs text-carbon-3 mt-1">SELECT 1 round-trip via withRequestRls.</p>
        <dl class="mt-4 space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Active migration</dt>
            <dd class="font-mono text-[11px] text-carbon break-all max-w-[60%] text-right">
              {{ data.postgres.activeMigration ?? '—' }}
            </dd>
          </div>
        </dl>
        <p v-if="data.postgres.error" class="mt-3 text-xs text-brand-hunger font-mono">
          {{ data.postgres.error }}
        </p>
      </UiCard>

      <!-- Redis -->
      <UiCard accent="vision" data-testid="admin-diag-redis">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Redis</UiEyebrow>
          <UiBadge :kind="redisUnavailable ? 'neutral' : 'rag-green'">
            {{ redisUnavailable ? 'unavailable' : 'ok' }}
          </UiBadge>
        </div>
        <template v-if="redisUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Not wired</h2>
          <p class="text-xs text-carbon-3 mt-1">
            {{ ('unavailable' in (data.redis ?? {})) ? (data.redis as { reason: string }).reason : 'Redis client not yet installed in MVP-Final.' }}
          </p>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon">
            {{ (data.redis as { latencyMs: number }).latencyMs }}ms
          </h2>
        </template>
      </UiCard>

      </template>

      <!-- Database performance — LAUNCHABLE. Not fetched on page load: it reads
           six statistics views and this page is already the slowest in the
           product. `aria-busy` rides the card region while the read is in
           flight (D2's loading-state contract). -->
      <UiCard
        accent="harmony"
        class="lg:col-span-2"
        data-testid="admin-diag-db-performance"
        :aria-busy="dbPerfPending ? 'true' : 'false'"
      >
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Database performance</UiEyebrow>
          <UiButton
            kind="secondary"
            size="sm"
            :disabled="dbPerfPending"
            data-testid="admin-diag-db-performance-run"
            @click="launchDbPerf()"
          >
            {{ dbPerfPending ? 'Running…' : dbPerfHasRun ? 'Run database check again' : 'Run database check' }}
          </UiButton>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          The database's own statistics views, read by the app's connection —
          slowest statements, sequential-scan pressure, cache behaviour, unused
          indexes, sizes and the server settings that govern them. Read-only and
          bounded; nothing here resets a counter. Every row rolls partitions up to
          their parent table.
        </p>

        <!-- 403: platform-admin only, like the network and RLS cards. -->
        <p
          v-if="dbPerfError && dbPerfError.statusCode === 403"
          class="text-sm text-carbon-3"
          data-testid="admin-diag-db-performance-scoped"
        >
          Scoped out — this probe names every table, index and server setting in the
          estate, so it is Admin only. The rest of this page is unaffected.
        </p>
        <!-- Wrapped rather than testid'd directly: a fallthrough `data-testid`
             would REPLACE the banner's own `fetch-error-banner` marker. -->
        <div v-else-if="dbPerfError" data-testid="admin-diag-db-performance-error">
          <UiFetchErrorBanner
            :error="dbPerfError"
            label="the database performance probe"
            @retry="launchDbPerf"
          />
        </div>

        <!-- Idle: asked for nothing yet. Distinct from the skeleton below. -->
        <p
          v-else-if="!dbPerfHasRun"
          class="text-sm text-carbon-2"
          data-testid="admin-diag-db-performance-idle"
        >
          Not run. This check is launched on demand, not on page load.
        </p>

        <!-- Asked, nothing back yet. -->
        <div v-else-if="dbPerfData == null" data-testid="admin-diag-db-performance-skeleton">
          <AdminPageSkeleton :rows="4" :toolbar="false" />
        </div>

        <template v-else>
          <p class="text-[11px] text-carbon-3 font-mono mb-4">
            {{ dbPerfData.generatedAt.slice(0, 19) }}Z · top {{ dbPerfData.topN }} ·
            {{ dbPerfData.budget.elapsedMs }}ms of a {{ dbPerfData.budget.deadlineMs }}ms budget ·
            statement timeout {{ dbPerfData.budget.statementTimeoutMs }}ms
          </p>

          <!-- 1. Slowest statements -->
          <div class="mb-5">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-bold text-carbon">Slowest statements (total time)</h3>
              <UiBadge :kind="dbPerfData.statements.extension.ready ? 'rag-green' : 'neutral'">
                {{ dbPerfData.statements.extension.ready ? 'pg_stat_statements loaded' : 'pg_stat_statements not loaded' }}
              </UiBadge>
            </div>
            <p
              v-if="dbPerfStatementsUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-statements-unavailable"
            >
              {{ dbPerfStatementsUnavailable }}
            </p>
            <template v-else>
              <p
                v-if="!dbPerfData.statements.extension.ready"
                class="text-xs text-carbon-3"
                data-testid="admin-diag-db-performance-statements-note"
              >
                {{ dbPerfData.statements.extension.note }}
              </p>
              <template v-else>
                <p class="text-[11px] text-carbon-3 mb-2">
                  {{ dbPerfData.statements.extension.note }}
                </p>
                <ul
                  v-if="dbPerfData.statements.rows.length"
                  class="divide-y divide-calm-2"
                  data-testid="admin-diag-db-performance-statements"
                >
                  <li v-for="(s, i) in dbPerfData.statements.rows" :key="i" class="py-2">
                    <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono text-carbon-2">
                      <span class="font-bold text-carbon">{{ fmtMs(s.totalMs) }} total</span>
                      <span>{{ s.calls.toLocaleString() }} calls</span>
                      <span>mean {{ fmtMs(s.meanMs) }}</span>
                      <span>max {{ fmtMs(s.maxMs) }}</span>
                      <span>{{ s.rows.toLocaleString() }} rows</span>
                    </div>
                    <p class="mt-1 text-[11px] font-mono text-carbon-3 break-all">
                      {{ s.query }}<span v-if="s.truncated">…</span>
                    </p>
                  </li>
                </ul>
                <p v-else class="text-xs text-carbon-3">
                  No statements recorded yet for this database.
                </p>
              </template>
            </template>
          </div>

          <!-- 2. Sequential-scan pressure -->
          <div class="mb-5">
            <h3 class="text-sm font-bold text-carbon mb-2">Sequential-scan pressure</h3>
            <p
              v-if="dbPerfSeqUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-seq-unavailable"
            >
              {{ dbPerfSeqUnavailable }}
            </p>
            <template v-else>
              <p class="text-[11px] text-carbon-3 mb-2">
                Highlighted when a table over {{ SEQ_SCAN_TUPLE_FLOOR.toLocaleString() }} live rows is
                read sequentially more than it is read by index. A small lookup table
                seq-scanning is the planner being right, not a finding.
                <span class="font-mono" data-testid="admin-diag-db-performance-stats-window">
                  {{ statsWindowLabel(dbPerfData.statsWindow, dbPerfData.generatedAt) }}
                  A major-version upgrade resets them, and a single table or index can be reset on
                  its own without moving that date.
                </span>
              </p>
              <ul
                v-if="dbPerfData.sequentialScans.length"
                class="divide-y divide-calm-2"
                data-testid="admin-diag-db-performance-seq"
              >
                <li
                  v-for="t in dbPerfData.sequentialScans"
                  :key="t.table"
                  class="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] font-mono"
                  :data-testid="`admin-diag-db-performance-seq-${t.table}`"
                >
                  <span :class="seqScanPressure(t) ? 'text-brand-hunger font-bold' : 'text-carbon-2'">
                    {{ t.table }}<span v-if="t.partitions" class="text-carbon-3"> ({{ t.partitions }} partitions)</span>
                  </span>
                  <span class="text-carbon-3">
                    seq {{ t.seqScan.toLocaleString() }} · rows read {{ t.seqTupRead.toLocaleString() }} ·
                    idx {{ t.idxScan.toLocaleString() }} · live {{ t.liveTuples.toLocaleString() }}
                    <span
                      v-if="analyzeLabel(t, dbPerfData.generatedAt)"
                      class="text-carbon-3"
                      :data-testid="`admin-diag-db-performance-analyze-${t.table}`"
                    >· {{ analyzeLabel(t, dbPerfData.generatedAt) }}</span>
                  </span>
                </li>
              </ul>
              <p v-else class="text-xs text-carbon-3">No user tables reported.</p>
            </template>
          </div>

          <!-- 3. Cache behaviour -->
          <div class="mb-5">
            <h3 class="text-sm font-bold text-carbon mb-2">Cache behaviour (block hits vs reads)</h3>
            <p
              v-if="dbPerfCacheUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-cache-unavailable"
            >
              {{ dbPerfCacheUnavailable }}
            </p>
            <ul
              v-else-if="dbPerfData.cache.length"
              class="divide-y divide-calm-2"
              data-testid="admin-diag-db-performance-cache"
            >
              <li
                v-for="t in dbPerfData.cache"
                :key="t.table"
                class="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] font-mono"
              >
                <span class="text-carbon-2">
                  {{ t.table }}<span v-if="t.partitions" class="text-carbon-3"> ({{ t.partitions }} partitions)</span>
                </span>
                <span class="text-carbon-3">
                  hit ratio <span class="text-carbon font-bold">{{ fmtRatio(t.hitRatio) }}</span> ·
                  heap {{ t.heapHit.toLocaleString() }}/{{ t.heapRead.toLocaleString() }} ·
                  idx {{ t.idxHit.toLocaleString() }}/{{ t.idxRead.toLocaleString() }}
                </span>
              </li>
            </ul>
            <p v-else class="text-xs text-carbon-3">No I/O statistics reported.</p>
          </div>

          <!-- 4. Unused indexes -->
          <div class="mb-5">
            <h3 class="text-sm font-bold text-carbon mb-2">Unused indexes</h3>
            <p
              v-if="dbPerfUnusedUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-unused-unavailable"
            >
              {{ dbPerfUnusedUnavailable }}
            </p>
            <template v-else>
              <p class="text-[11px] text-carbon-3 mb-2">
                Never scanned and at least {{ fmtBytes(dbPerfData.unusedIndexes.minBytes) }}. They cost
                every write and their storage for nothing. Unique, primary-key AND
                exclusion-constraint indexes are excluded — they back a constraint, and an
                exclusion index is enforced on write rather than scanned.
                <span class="font-mono" data-testid="admin-diag-db-performance-unused-caveat">
                  "Never" reaches back no earlier than the last database-wide reset, and an
                  individual index may have been reset more recently.
                  {{ statsWindowLabel(dbPerfData.statsWindow, dbPerfData.generatedAt) }}
                  Over a short window an index used weekly looks identical to a dead one, so do
                  not drop on this alone.
                </span>
              </p>
              <ul
                v-if="dbPerfData.unusedIndexes.rows.length"
                class="divide-y divide-calm-2"
                data-testid="admin-diag-db-performance-unused"
              >
                <li
                  v-for="ix in dbPerfData.unusedIndexes.rows"
                  :key="ix.index"
                  class="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] font-mono"
                  :data-testid="`admin-diag-db-performance-unused-${ix.index}`"
                >
                  <span class="text-carbon-2">{{ ix.index }} <span class="text-carbon-3">on {{ ix.table }}</span></span>
                  <span class="text-carbon font-bold">{{ fmtBytes(ix.bytes) }}</span>
                </li>
              </ul>
              <p v-else class="text-xs text-carbon-3">
                None — every index over the floor has been scanned at least once.
              </p>
            </template>
          </div>

          <!-- 5. Sizes -->
          <div class="mb-5">
            <h3 class="text-sm font-bold text-carbon mb-2">Largest tables</h3>
            <p
              v-if="dbPerfSizesUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-sizes-unavailable"
            >
              {{ dbPerfSizesUnavailable }}
            </p>
            <ul
              v-else-if="dbPerfData.sizes.length"
              class="divide-y divide-calm-2"
              data-testid="admin-diag-db-performance-sizes"
            >
              <li
                v-for="t in dbPerfData.sizes"
                :key="t.table"
                class="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] font-mono"
                :data-testid="`admin-diag-db-performance-size-${t.table}`"
              >
                <span class="text-carbon-2">
                  {{ t.table }}<span v-if="t.partitions" class="text-carbon-3"> ({{ t.partitions }} partitions)</span>
                </span>
                <span class="text-carbon-3">
                  <span class="text-carbon font-bold">{{ fmtBytes(t.totalBytes) }}</span> total ·
                  table {{ fmtBytes(t.tableBytes) }} · indexes {{ fmtBytes(t.indexBytes) }}
                </span>
              </li>
            </ul>
            <p v-else class="text-xs text-carbon-3">No user tables reported.</p>
          </div>

          <!-- 6. Server settings -->
          <div>
            <h3 class="text-sm font-bold text-carbon mb-2">Server settings</h3>
            <p
              v-if="dbPerfSettingsUnavailable"
              class="text-xs text-brand-hunger font-mono"
              data-testid="admin-diag-db-performance-settings-unavailable"
            >
              {{ dbPerfSettingsUnavailable }}
            </p>
            <ul
              v-else-if="dbPerfData.settings.length"
              class="divide-y divide-calm-2"
              data-testid="admin-diag-db-performance-settings"
            >
              <li
                v-for="st in dbPerfData.settings"
                :key="st.name"
                class="flex flex-wrap items-center justify-between gap-2 py-2 text-[11px] font-mono"
                :data-testid="`admin-diag-db-performance-setting-${st.name}`"
              >
                <span class="text-carbon-2">{{ st.name }}</span>
                <span class="text-carbon-3">
                  <span class="text-carbon font-bold">{{ st.display || '(empty)' }}</span>
                  · {{ st.source }}
                  <span v-if="st.pendingRestart" class="text-brand-hunger">· restart pending</span>
                </span>
              </li>
            </ul>
            <p v-else class="text-xs text-carbon-3">No settings reported.</p>
          </div>
        </template>
      </UiCard>

      <!-- Network-bound probes (GET /diagnostics/probes): each raced against a
           5 s budget server-side; its own read and skeleton here. -->
      <div v-if="probesError" class="lg:col-span-2">
        <UiFetchErrorBanner :error="probesError" label="the reachability probes" @retry="refreshProbes" />
      </div>
      <div v-else-if="probesData == null" class="lg:col-span-2" data-testid="admin-diag-probes-skeleton">
        <AdminPageSkeleton :rows="3" :toolbar="false" />
      </div>
      <template v-else>
      <!-- Private-endpoint reachability (same TCP probe the boot pre-flight runs) -->
      <UiCard accent="harmony" data-testid="admin-diag-services">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Private endpoints</UiEyebrow>
          <UiBadge :kind="servicesBadge.kind">{{ servicesBadge.label }}</UiBadge>
        </div>
        <p class="text-xs text-carbon-3 mt-1">
          TCP reachability of each provisioned PE — the same probe run at boot. <span class="text-brand-hunger">*</span> = boot-critical.
        </p>
        <ul v-if="probesData.services?.length" class="mt-3 divide-y divide-calm-2">
          <li
            v-for="s in probesData.services"
            :key="s.name"
            class="flex items-center justify-between py-2 text-sm"
            :data-testid="`admin-diag-service-${s.name}`"
          >
            <span class="text-carbon-2">
              {{ s.name }}<span v-if="s.critical" class="text-brand-hunger" title="boot-critical"> *</span>
            </span>
            <span
              class="font-mono text-[11px]"
              :class="s.status === 'unreachable' ? 'text-brand-hunger' : s.status === 'skipped' ? 'text-carbon-3' : 'text-carbon'"
            >
              {{ svcDetail(s) }}
            </span>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-carbon-2">No probes reported.</p>
      </UiCard>

      <!-- Telemetry read path (Log Analytics query, incl. the AMPLS private endpoint) -->
      <UiCard accent="vision" data-testid="admin-diag-telemetry-read">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Telemetry read (LAW)</UiEyebrow>
          <UiBadge :kind="probesData.telemetryRead?.ok ? 'rag-green' : 'rag-red'">
            {{ probesData.telemetryRead?.ok ? 'ok' : 'unreachable' }}
          </UiBadge>
        </div>
        <h2 v-if="probesData.telemetryRead?.ok" class="text-lg font-bold text-carbon">{{ probesData.telemetryRead.latencyMs }}ms</h2>
        <h2 v-else class="text-lg font-bold text-carbon-2">No read</h2>
        <p class="text-xs text-carbon-3 mt-1">
          Trivial KQL via the {{ probesData.telemetryRead?.kind ?? 'configured' }} reader — DNS → the (private) query endpoint + token.
        </p>
        <p
          v-if="probesData.telemetryRead && !probesData.telemetryRead.ok && probesData.telemetryRead.error"
          class="mt-3 text-xs text-brand-hunger font-mono break-all"
        >
          {{ probesData.telemetryRead.error }}
        </p>
      </UiCard>
      </template>

      <template v-if="data">
      <!-- Queues -->
      <UiCard accent="zeal" data-testid="admin-diag-queues">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Queues</UiEyebrow>
          <UiBadge :kind="queuesUnavailable ? 'neutral' : 'rag-green'">
            {{ queuesUnavailable ? 'unavailable' : 'live' }}
          </UiBadge>
        </div>
        <template v-if="queuesUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Not wired</h2>
          <p class="text-xs text-carbon-3 mt-1">
            BullMQ workers land in a later slice. No queue surface to probe.
          </p>
        </template>
        <template v-else>
          <dl class="space-y-2 text-sm">
            <div
              v-for="(v, name) in (data.queues as Record<string, { depth: number }>)"
              :key="name"
              class="flex items-center justify-between"
            >
              <dt class="text-carbon-2 font-mono">{{ name }}</dt>
              <dd class="font-mono text-xs text-carbon">depth: {{ v.depth }}</dd>
            </div>
          </dl>
        </template>
      </UiCard>

      <!-- Last sync -->
      <UiCard accent="hunger" data-testid="admin-diag-last-sync">
        <UiEyebrow>Last sync</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-3">Per-source recency</h2>
        <div v-if="lastSyncUnavailable">
          <p class="text-xs text-brand-hunger font-mono" data-testid="admin-diag-last-sync-unavailable">
            {{ lastSyncUnavailable }}
          </p>
          <p class="text-xs text-carbon-3 mt-1">
            The per-source recency query failed — not the same thing as a manual-mode
            region with no sync rows.
          </p>
        </div>
        <dl v-else-if="data.lastSync.length" class="space-y-2 text-sm">
          <div v-for="s in data.lastSync" :key="s.source" class="flex items-center justify-between">
            <dt class="text-carbon-2 font-mono">{{ s.source }}</dt>
            <dd class="font-mono text-xs text-carbon">{{ fmtTs(s.ts) }}</dd>
          </div>
        </dl>
        <p v-else class="text-sm text-carbon-3 italic">No sync rows yet. Manual-mode region.</p>
      </UiCard>

      <!-- Environment -->
      <UiCard data-testid="admin-diag-env">
        <UiEyebrow>Environment</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-3">Runtime</h2>
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">NODE_ENV</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.nodeEnv }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Container revision</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.containerInfo.revision ?? '—' }}</dd>
          </div>
        </dl>
      </UiCard>
      </template>
    </div>

    <!-- Dev-troubleshooting cards. Independent of the main /diagnostics fetch:
         each owns its own fetch + error state so one failing (or a 403) cannot
         blank the other card or the rest of the page. -->
    <div class="grid grid-cols-1 gap-5 mt-5">
      <!-- Card A — Private Link / DNS validation. Per provisioned host: does DNS
           resolve to a private address (zone linked) and is the port reachable?
           The "Copy IT report" button hands a plain-text artefact to networking. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-network">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Private Link / DNS validation</UiEyebrow>
          <div class="flex items-center gap-2">
            <UiButton
              kind="secondary"
              size="sm"
              :disabled="netPending"
              data-testid="admin-diag-network-refresh"
              @click="refreshNet()"
            >
              {{ netPending ? 'Refreshing…' : 'Refresh' }}
            </UiButton>
            <UiButton
              v-if="netData"
              kind="primary"
              size="sm"
              data-testid="admin-diag-network-copy-it"
              @click="copyItReport()"
            >
              {{ itCopied ? 'Copied ✓' : 'Copy IT report' }}
            </UiButton>
          </div>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>Admin</strong>.
          Resolves every private-link host the app depends on, and TCP-dials
          the ones it actually calls — the other AMPLS members share that private
          endpoint, so their DNS answer is the evidence, not a dial.
        </p>

        <!-- A 403 here is EXPECTED for a region admin (this
             probe is now platform-admin-only, matching the OTel card) —
             render it as a calm scoped-out note, not an alarming error.
             Genuine failures (500 / network) keep the red treatment. -->
        <p v-if="netError && netError.statusCode === 403" class="text-sm text-carbon-3" data-testid="admin-diag-network-scoped">
          Scoped out — this probe is Admin only, so your role can't read private-link/DNS
          validation. Nothing is wrong; every other card above still applies to your region.
        </p>
        <UiFetchErrorBanner
          v-else-if="netError"
          :error="netError"
          label="network validation"
          data-testid="admin-diag-network-error"
          @retry="refreshNet"
        />
        <template v-else-if="netData">
          <p class="text-xs text-carbon-3">
            {{ netData.generatedNote }} <span class="font-mono">{{ netData.vnetHint }}</span>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="admin-diag-network-summary">
            <UiBadge kind="neutral">total {{ netData.summary.total }}</UiBadge>
            <UiBadge :kind="netData.summary.ok > 0 ? 'rag-green' : 'neutral'">ok {{ netData.summary.ok }}</UiBadge>
            <UiBadge v-if="netData.summary.dnsOnly > 0" kind="neutral">dns-only {{ netData.summary.dnsOnly }}</UiBadge>
            <UiBadge :kind="netData.summary.zoneNotLinked > 0 ? 'rag-red' : 'neutral'">zone-not-linked {{ netData.summary.zoneNotLinked }}</UiBadge>
            <UiBadge :kind="netData.summary.unreachable > 0 ? 'rag-red' : 'neutral'">unreachable {{ netData.summary.unreachable }}</UiBadge>
            <UiBadge :kind="netData.summary.dnsFail > 0 ? 'rag-red' : 'neutral'">dns-fail {{ netData.summary.dnsFail }}</UiBadge>
            <UiBadge v-if="netData.summary.notWired > 0" kind="neutral">not-wired {{ netData.summary.notWired }}</UiBadge>
          </div>

          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Service</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Host</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Resolved IP(s)</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">DNS</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Reachable</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Expected zone</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr
                  v-for="r in netRecords"
                  :key="`${r.service}-${r.host}-${r.port}`"
                  class="hover:bg-brand-harmony-sheer/30 align-top"
                  :data-testid="`admin-diag-network-row-${r.service}`"
                >
                  <td class="px-3 py-2 text-carbon">
                    {{ r.service }}
                    <div class="text-[10px] uppercase tracking-[0.5px] text-carbon-3">{{ r.category }}</div>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">{{ r.host }}:{{ r.port }}</td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">
                    <span v-if="r.addresses.length">{{ r.addresses.join(', ') }}</span>
                    <span v-else class="text-carbon-3">—</span>
                    <div v-if="r.dnsError" class="text-[10px] text-brand-hunger break-all">{{ r.dnsError }}</div>
                  </td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="privBadge(r.resolvesPrivate).kind">{{ privBadge(r.resolvesPrivate).label }}</UiBadge>
                  </td>
                  <td
                    class="px-3 py-2 font-mono text-[11px]"
                    :class="r.reachable === false ? 'text-brand-hunger' : 'text-carbon'"
                  >
                    {{ reachText(r) }}
                    <div v-if="r.tcpError" class="text-[10px] text-brand-hunger break-all">{{ r.tcpError }}</div>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon-2 break-all">{{ r.expectedZone }}</td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="verdictBadge(r.verdict).kind">{{ verdictBadge(r.verdict).label }}</UiBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <AdminPageSkeleton v-else :rows="3" :toolbar="false" />
      </UiCard>

      <!-- Card B — OTel telemetry (Log Analytics). Platform-admin only; a region
           admin gets a 403 which renders as a status message. Failed KQL probes
           show the raw, un-truncated Azure error packet for the operator. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-otel">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>OTel telemetry (Log Analytics)</UiEyebrow>
          <UiButton
            kind="secondary"
            size="sm"
            :disabled="otelPending"
            data-testid="admin-diag-otel-refresh"
            @click="refreshOtel()"
          >
            {{ otelPending ? 'Refreshing…' : 'Refresh' }}
          </UiButton>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>Admin</strong>. Probes the
          Log Analytics query path the worker reads telemetry from.
        </p>

        <!-- A 403 here is EXPECTED for a region admin (platform-admin-only
             probe) — render it as a calm scoped-out note, not an alarming
             error. Genuine failures (500 / network) keep the red treatment. -->
        <p v-if="otelError && otelError.statusCode === 403" class="text-sm text-carbon-3" data-testid="admin-diag-otel-scoped">
          Scoped out — this probe is Admin only, so your role can't read the Log Analytics
          query path. Nothing is wrong; every other card above still applies to your region.
        </p>
        <UiFetchErrorBanner
          v-else-if="otelError"
          :error="otelError"
          label="OTel diagnostics"
          data-testid="admin-diag-otel-error"
          @retry="refreshOtel"
        />
        <template v-else-if="otelData">
          <!-- config + queryEndpointNote key/value block -->
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Telemetry reader</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.telemetryReader ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Workspace id set</dt>
              <dd class="font-mono text-[11px] text-carbon">{{ otelData.config.workspaceIdSet ? 'yes' : 'no' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">MI client id</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.miClientId ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Logs endpoint host</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.logsEndpointHost ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Window</dt>
              <dd class="font-mono text-[11px] text-carbon">{{ otelData.hours }}h · limit {{ otelData.limit }} · {{ otelData.duration }}</dd>
            </div>
          </dl>
          <p class="text-xs text-carbon-3 mt-2">{{ otelData.queryEndpointNote }}</p>

          <!-- DNS rows -->
          <div v-if="otelData.dns?.length" class="mt-4">
            <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">DNS</div>
            <ul class="divide-y divide-calm-2">
              <li v-for="d in otelData.dns" :key="d.host" class="flex items-center justify-between gap-3 py-2 text-sm">
                <span class="font-mono text-[11px] text-carbon break-all">{{ d.host }}</span>
                <span class="flex items-center gap-2 min-w-0">
                  <span class="font-mono text-[11px] text-carbon-2 break-all text-right">
                    {{ d.error ? d.error : (d.addresses?.join(', ') || '—') }}
                  </span>
                  <UiBadge v-if="!d.error" :kind="privBadge(d.resolvesPrivate).kind">{{ privBadge(d.resolvesPrivate).label }}</UiBadge>
                  <UiBadge v-else kind="rag-red">dns-fail</UiBadge>
                </span>
              </li>
            </ul>
          </div>

          <!-- Per-query collapsible rows -->
          <div class="mt-4">
            <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">Queries</div>
            <ul class="divide-y divide-calm-2">
              <li v-for="q in otelData.queries" :key="q.label" class="py-2" :data-testid="`admin-diag-otel-query-${q.label}`">
                <button
                  type="button"
                  class="w-full flex items-center justify-between gap-3 text-left"
                  @click="toggleQuery(q.label)"
                >
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="font-mono text-[10px] text-carbon-3">{{ expandedQueries[q.label] ? '▾' : '▸' }}</span>
                    <span class="text-sm text-carbon truncate">{{ q.label }}</span>
                  </span>
                  <span class="flex items-center gap-2 shrink-0">
                    <span class="text-[11px] text-carbon-3">{{ q.latencyMs }}ms</span>
                    <UiBadge :kind="q.ok ? 'rag-green' : 'rag-red'">{{ q.ok ? 'ok' : (q.status ?? 'error') }}</UiBadge>
                  </span>
                </button>
                <div v-if="expandedQueries[q.label]" class="mt-2">
                  <pre class="text-[10px] text-carbon-3 font-mono whitespace-pre-wrap break-all bg-calm-2/40 rounded-md p-2">{{ q.kql }}</pre>
                  <!-- success: compact table of rows -->
                  <div v-if="q.ok && q.columns?.length" class="mt-2 overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
                          <th
                            v-for="c in q.columns"
                            :key="c"
                            class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2"
                          >
                            {{ c }}
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-calm-2">
                        <tr v-for="(row, idx) in (q.rows ?? [])" :key="idx" class="hover:bg-brand-harmony-sheer/30">
                          <td
                            v-for="c in q.columns"
                            :key="c"
                            class="px-3 py-2 font-mono text-[11px] text-carbon break-all"
                          >
                            {{ row[c] ?? '—' }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p v-if="!(q.rows?.length)" class="text-xs text-carbon-3 italic mt-1">No rows in window.</p>
                  </div>
                  <!-- failure: raw Azure error packet, un-truncated -->
                  <div v-else-if="!q.ok && (q.error || q.partialError)" class="mt-2">
                    <p class="text-xs text-brand-hunger mb-1">
                      <span v-if="q.error?.code" class="font-mono">code: {{ q.error.code }}</span>
                      <span v-if="q.error?.statusCode" class="font-mono ml-2">status: {{ q.error.statusCode }}</span>
                    </p>
                    <pre class="text-[10px] text-brand-heart font-mono whitespace-pre-wrap break-all bg-brand-hunger-lite/40 rounded-md p-2">{{ pretty(q.error ?? q.partialError) }}</pre>
                  </div>
                </div>
              </li>
            </ul>
          </div>

          <!-- top-level client / fatal error packets -->
          <div v-if="otelData.clientError || otelData.fatalError" class="mt-3">
            <pre class="text-[10px] text-brand-heart font-mono whitespace-pre-wrap break-all bg-brand-hunger-lite/40 rounded-md p-2">{{ pretty(otelData.fatalError ?? otelData.clientError) }}</pre>
          </div>
        </template>
        <AdminPageSkeleton v-else :rows="3" :toolbar="false" />
      </UiCard>

      <!-- RLS enforcement posture. The measurement that replaces "Azure docs say
           the admin login can create roles": can THIS connection provision the
           non-owner app role, does that role exist yet, and how much of the
           policy set actually executes. Read-only — the probe runs catalog
           SELECTs only and changes nothing. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-rls">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>RLS enforcement posture</UiEyebrow>
          <UiButton
            kind="secondary"
            size="sm"
            :disabled="rlsPending"
            data-testid="admin-diag-rls-refresh"
            @click="refreshRls()"
          >
            {{ rlsPending ? 'Refreshing…' : 'Refresh' }}
          </UiButton>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>Admin</strong>.
          Read-only: catalog queries only — no role is created and no table is changed.
        </p>

        <p v-if="rlsError && rlsError.statusCode === 403" class="text-sm text-carbon-3" data-testid="admin-diag-rls-scoped">
          Scoped out — this probe is Admin only, so your role can't read database-role
          capability. Nothing is wrong; every other card above still applies to your region.
        </p>
        <UiFetchErrorBanner
          v-else-if="rlsError"
          :error="rlsError"
          label="RLS posture"
          data-testid="admin-diag-rls-error"
          @retry="refreshRls"
        />
        <template v-else-if="rlsData">
          <pre
            class="text-[11px] font-mono text-carbon-2 bg-calm-1/60 rounded-md p-2 whitespace-pre-wrap break-all"
            data-testid="admin-diag-rls-line"
          >{{ rlsData.line }}</pre>

          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="admin-diag-rls-summary">
            <UiBadge :kind="rlsData.connection.lane === 'app-role' ? 'rag-green' : 'neutral'">
              {{ rlsData.connection.lane }} connection
            </UiBadge>
            <UiBadge :kind="rlsEnforcementBadge.kind">{{ rlsEnforcementBadge.label }}</UiBadge>
            <UiBadge kind="neutral">{{ rlsData.summary.rlsForced }} forced</UiBadge>
            <UiBadge kind="neutral">{{ rlsData.summary.policies }} policies</UiBadge>
            <UiBadge :kind="rlsData.appRole.exists ? 'rag-green' : 'rag-amber'">
              app role {{ rlsData.appRole.roleName }}: {{ rlsData.appRole.exists ? 'present' : 'absent' }}
            </UiBadge>
            <UiBadge :kind="rlsData.capability.canProvisionRole ? 'rag-green' : 'rag-red'">
              can create role: {{ rlsData.capability.canProvisionRole ? 'yes' : 'no' }}
            </UiBadge>
          </div>

          <!-- The provisioning question, spelled out. This is the story: whether
               the deploy pipeline can create the role itself, or whether the org
               needs a database administrator it does not have. -->
          <dl
            class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs"
            data-testid="admin-diag-rls-capability"
          >
            <div>
              <dt class="text-carbon-3 uppercase tracking-[0.5px] text-[10px]">Connected as</dt>
              <dd class="font-mono text-carbon break-all">{{ rlsData.capability.currentUser }}</dd>
            </div>
            <div>
              <dt class="text-carbon-3 uppercase tracking-[0.5px] text-[10px]">Basis</dt>
              <dd class="font-mono text-carbon">{{ rlsData.capability.provisionBasis }}</dd>
            </div>
            <div>
              <dt class="text-carbon-3 uppercase tracking-[0.5px] text-[10px]">CREATEROLE / SUPERUSER</dt>
              <dd class="font-mono text-carbon">
                {{ rlsData.capability.canCreateRole ? 'yes' : 'no' }} /
                {{ rlsData.capability.isSuperuser ? 'yes' : 'no' }}
              </dd>
            </div>
            <div>
              <dt class="text-carbon-3 uppercase tracking-[0.5px] text-[10px]">azure_pg_admin</dt>
              <dd class="font-mono text-carbon">
                <span v-if="!rlsData.capability.azurePgAdmin.rolePresent">role not on this server</span>
                <span v-else>member: {{ rlsData.capability.azurePgAdmin.isMember ? 'yes' : 'no' }}</span>
              </dd>
            </div>
          </dl>
          <p
            v-if="rlsData.capability.createRoleViaSetRole.length"
            class="mt-2 text-xs text-carbon-3"
            data-testid="admin-diag-rls-setrole"
          >
            CREATEROLE is reachable only via <span class="font-mono">SET ROLE</span>:
            <span class="font-mono">{{ rlsData.capability.createRoleViaSetRole.join(', ') }}</span>
            — Postgres does not inherit role attributes through membership.
          </p>
          <p
            v-if="rlsData.appRole.grants"
            class="mt-2 text-xs text-carbon-3"
            data-testid="admin-diag-rls-grants"
          >
            Grants on <span class="font-mono">{{ rlsData.appRole.roleName }}</span>: schema usage
            {{ rlsData.appRole.grants.schemaUsage ? 'yes' : 'no' }}; of
            {{ rlsData.appRole.grants.tablesTotal }} tables it can SELECT
            {{ rlsData.appRole.grants.canSelect }}, INSERT {{ rlsData.appRole.grants.canInsert }},
            UPDATE {{ rlsData.appRole.grants.canUpdate }}, DELETE
            {{ rlsData.appRole.grants.canDelete }}.
          </p>
          <p
            v-if="rlsData.summary.bootstrapStillEnabled.length"
            class="mt-2 text-xs text-carbon-3"
            data-testid="admin-diag-rls-bootstrap-note"
          >
            <strong>{{ rlsData.summary.bootstrapStillEnabled.length }}</strong> bootstrap table(s)
            still have RLS enabled. Harmless on the owner connection; on the app role these are the
            reads that happen before any identity exists, so they must be disabled first.
          </p>

          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Table</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">RLS</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">FORCE</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Policies</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Executes here</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Owner</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr
                  v-for="row in rlsTables"
                  :key="row.table"
                  class="hover:bg-brand-harmony-sheer/30 align-top"
                  :data-testid="`admin-diag-rls-row-${row.table}`"
                >
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">
                    {{ row.table }}
                    <UiBadge v-if="row.bootstrap" kind="harmony" class="ml-1">bootstrap</UiBadge>
                  </td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="row.rlsEnabled ? 'rag-green' : 'neutral'">
                      {{ row.rlsEnabled ? 'enabled' : 'disabled' }}
                    </UiBadge>
                  </td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="row.rlsForced ? 'rag-green' : 'neutral'">
                      {{ row.rlsForced ? 'forced' : '—' }}
                    </UiBadge>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon">{{ row.policyCount }}</td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="row.policiesApply ? 'rag-green' : 'rag-amber'">
                      {{ row.policiesApply ? 'yes' : 'no' }}
                    </UiBadge>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon-2 break-all">
                    {{ row.owner }}<span v-if="row.currentUserOwns"> (this connection)</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <AdminPageSkeleton v-else :rows="3" :toolbar="false" />
      </UiCard>

      <!--
        Attribution gaps — devices that ARE emitting while their spend is not
        being attributed. This is the outage class that hid for 19 days: emit
        auth green, Azure accepting exports (204), nothing landing. Same
        predicate the attribution-gap worker alerts on.
      -->
      <!--
        §A/§B decomposition — the Workstream A gate.

        A single "chargeable exceeds attributed by $X" number invites the wrong
        conclusion (money is leaking). It usually is not: most of the gap is
        surfaces Claude Code never emits for. The card's job is to show the gap
        already ACCOUNTED FOR, term by term, and to state whether the residual
        closes. A non-zero residual is the only figure here that means something
        is actually wrong.
      -->
      <UiCard
        v-if="canSeeEstateFinance"
        accent="vision"
        class="lg:col-span-2"
        data-testid="admin-diag-ab-decomposition"
      >
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 class="text-sm font-bold text-carbon">Chargeable vs attributed</h2>
            <p class="text-xs text-carbon-3 mt-0.5">
              Why billed spend does not equal attributed spend, decomposed into named terms. The
              residual is the part no term explains — it should be zero.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model="abMonth"
              type="month"
              class="text-xs border border-calm rounded px-2 py-1 bg-white"
              data-testid="admin-diag-ab-month"
            >
            <UiButton kind="secondary" size="sm" :disabled="abPending" @click="refreshAb()">
              {{ abPending ? 'Computing…' : 'Refresh' }}
            </UiButton>
          </div>
        </div>

        <UiFetchErrorBanner v-if="abError" :error="abError" label="the decomposition" @retry="refreshAb" />
        <template v-else-if="abData">
          <p v-if="!abData.reachable" class="text-sm text-brand-hunger">
            Probe failed: {{ abData.error }}
          </p>
          <template v-else>
            <div class="flex flex-wrap gap-6 mb-3">
              <div>
                <p class="text-xs text-carbon-3">Attributed</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-section-a">
                  {{ abUsd(abData.sectionA) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-carbon-3">Chargeable</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-section-b">
                  {{ abUsd(abData.sectionB) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-carbon-3">Delta</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-delta">
                  {{ abUsd(abData.delta) }}
                </p>
              </div>
            </div>

            <table class="w-full text-xs mb-3">
              <thead>
                <tr class="text-carbon-3 text-left">
                  <th class="py-1 pr-3 font-medium">Term</th>
                  <th class="py-1 pr-3 font-medium text-right">Amount</th>
                  <th class="py-1 font-medium">What it is</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="term in abData.termOrder"
                  :key="term"
                  class="border-t border-calm-2"
                  :data-testid="`admin-diag-ab-term-${term}`"
                >
                  <td class="py-1 pr-3">{{ AB_TERM_LABELS[term] ?? term }}</td>
                  <td class="py-1 pr-3 text-right font-mono">{{ abUsd(abData.terms[term]) }}</td>
                  <td class="py-1 text-carbon-3">{{ AB_TERM_HINTS[term] }}</td>
                </tr>
                <tr class="border-t-2 border-calm font-bold">
                  <td class="py-1 pr-3">Residual (unexplained)</td>
                  <td
                    class="py-1 pr-3 text-right font-mono"
                    :class="abData.verdict === 'residual-non-zero' ? 'text-brand-hunger' : 'text-brand-harmony'"
                    data-testid="admin-diag-ab-residual"
                  >
                    {{ abUsd(abData.residual) }}
                  </td>
                  <td class="py-1 text-carbon-3 font-normal">
                    Anything other than zero means a term is missing or wrong.
                  </td>
                </tr>
              </tbody>
            </table>

            <p
              v-if="abData.verdict === 'residual-non-zero'"
              class="text-sm text-brand-hunger"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>Residual is not zero.</strong> The decomposition is no longer exhaustive
              against real data, so no claim about which term dominates can be trusted. Workstream A
              must not ship on this reading.
            </p>
            <p
              v-else-if="abData.verdict === 'no-delta'"
              class="text-sm text-carbon-3"
              data-testid="admin-diag-ab-verdict"
            >
              No gap in this period — chargeable and attributed agree.
            </p>
            <p
              v-else-if="abData.verdict === 'non-code-dominates'"
              class="text-sm text-brand-harmony"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>Non-Code surfaces dominate</strong>
              ({{ Math.round((abData.nonCodeShareOfExplained ?? 0) * 100) }}% of the summed size of
              all terms, ignoring their signs — not a share of the net gap, which offsetting terms
              can make far smaller than the money moving through them). This is the design's premise
              holding: most of the money moving between the two sides is spend on surfaces Claude
              Code never emits for, not attribution failing.
            </p>
            <p
              v-else-if="abNonCodeIsZero"
              class="text-sm text-carbon-3"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>No reading.</strong> This estate carries no non-Code spend at all, so the
              question the gate asks has nothing to bite on. The residual closes, which says the
              arithmetic is sound; the 0% share says nothing either way and is not evidence
              against the design. Run this against an estate with non-Code surfaces present
              before treating the gate as answered.
            </p>
            <p v-else class="text-sm text-brand-hunger" data-testid="admin-diag-ab-verdict">
              <strong>Non-Code surfaces do NOT dominate</strong>
              (only {{ Math.round((abData.nonCodeShareOfExplained ?? 0) * 100) }}% of the summed
              size of all terms, ignoring their signs — not a share of the net gap, which
              offsetting terms can make far smaller than the money moving through them). Non-Code
              spend is present but outweighed. The residual closes, so the arithmetic is sound —
              the design's central premise does not hold for this estate, and the largest term
              should be understood before Workstream A ships.
            </p>

            <!--
              Unconditional, for the same reason as the unhomed line below: the
              quarantine row above points here, and a pointer that disappears
              exactly when the value is zero is a dangling reference in the most
              common case.
            -->
            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-quarantined">
              <template v-if="Number(abData.diagnostics.quarantinedOtelUsd) !== 0">
                {{ abUsd(abData.diagnostics.quarantinedOtelUsd) }} of telemetry was quarantined as
                uncorroborated. It changes neither side of the gap: where the provider confirms
                the same day it returns to attributed usage through reconciliation and chargeback bills it, and where
                nothing confirms it, it enters neither. But a large figure means devices are
                emitting spend the provider will not confirm.
              </template>
              <template v-else>
                No telemetry was quarantined in this window: nothing was disowned as
                uncorroborated, so no attributed spend was dropped.
              </template>
            </p>

            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-coding-agent">
              <template v-if="Number(abData.diagnostics.codingAgentInSectionAUsd) !== 0">
                {{ abUsd(abData.diagnostics.codingAgentInSectionAUsd) }} of coding-agent spend is
                now visible to attributed usage. The coding-agent term above is a pure sum of the provider
                figure and does not net this off, so that money is being counted twice. The
                residual will NOT show it: the usage grain gap below is computed as a remainder,
                so it falls by the same amount and the two offset. This line is the only signal
                that fires, and it needs a code change, not an operator action.
              </template>
              <template v-else>
                Coding-agent spend remains invisible to attributed usage, as designed, so the coding-agent term
                above counts it once. This line turns into a warning if that ever changes.
              </template>
            </p>

            <!--
              Rendered UNCONDITIONALLY, including at zero. The homing-loss row above tells the
              operator its own $0.00 is uninformative and points here; hiding this line when it
              happens to be zero turns that pointer into a dangling reference in the exact case
              it is most likely to fire. A zero here is also a real answer: every chargeable
              dollar homes to a cost-owning unit.
            -->
            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-unhomed">
              <template v-if="Number(abData.diagnostics.unhomedChargeUsd) !== 0">
                {{ abUsd(abData.diagnostics.unhomedChargeUsd) }} of chargeable spend has no
                Business Unit. It is inside the chargeable total above, so it does not affect the
                residual, but it disappears from every per-Business Unit view.
              </template>
              <template v-else>
                No chargeable spend is unhomed: every billed dollar resolves to a Business Unit,
                so the per-Business Unit views account for all of chargeback.
              </template>
            </p>

            <!--
              THE CAUSE SPLIT of the figure immediately above. Exactly ONE
              unhomed total is rendered on this card — the line above — and
              everything below decomposes it. Both come from ONE definition
              (unhomedByMonthSql), but they are TWO statements: the headline is
              computed with §B, the split with its own buckets. On a quiescent
              estate they are byte-identical and the suite pins that; a placement
              committed between the two reads moves one and not the other, and no
              residual on this card can see it. The copy below says so — an
              earlier version of this comment claimed there was "no second query
              that could disagree", which was not true.

              The split's own arithmetic is held to the same bar as the card's:
              it must add back to the total the split itself measured, and a
              non-zero residual suppresses the breakdown rather than presenting
              four plausible numbers that do not add up.
            -->
            <div class="mt-4 pt-3 border-t border-calm-2" data-testid="admin-diag-unhomed-causes">
              <h3 class="text-sm font-bold text-carbon">Why this spend has no Business Unit</h3>
              <p class="text-xs text-carbon-3 mt-0.5 mb-2">
                The figure above, split by the reason the money could not reach a Business Unit.
                Every unhomed dollar is in exactly one cause. The causes must add back to the total
                the split itself measured; whatever they do not explain is the residual, and it
                should be zero. The line above is the same definition read a moment earlier, in a
                separate query — if placement changes while this page loads, the two can differ by
                that change and the residual will not show it.
              </p>

              <p
                v-if="!unhomedProbe"
                class="text-sm text-carbon-3"
                data-state="no-reading"
                data-testid="admin-diag-unhomed-state"
              >
                <strong>No reading.</strong> The cause split could not be computed<template
                  v-if="abData.unhomedError"
                > ({{ abData.unhomedError }})</template>. Nothing below should be read as “no spend
                reached this cause” — the question was not answered. The unhomed total above is
                unaffected.
              </p>

              <!--
                An EMPTY month is decided by COUNTING SOURCE ROWS, never by two
                sums netting to zero. Chargeable spend is signed, so a credit note
                can net a month to $0.00 with real billed rows inside it, and the
                sentence below would then hide the money the panel exists to show.
                A zero row count is the only thing that actually means "nothing
                arrived". Keep the predicate and this sentence saying the SAME
                thing — they drifted apart once already.
              -->
              <p
                v-else-if="unhomedNothingToSplit"
                class="text-sm text-carbon-3"
                data-state="not-applicable"
                data-testid="admin-diag-unhomed-state"
              >
                No billed rows reached this month at all, so there is nothing to home and
                nothing to split. This is not a clean bill of health — it is an empty month.
                A month that billed something and netted to zero is not this case, and is
                reported above with its figures.
              </p>

              <template v-else>
                <p
                  v-if="!unhomedReconciles"
                  class="text-sm text-brand-hunger mb-2"
                  data-state="unknown"
                  data-testid="admin-diag-unhomed-state"
                >
                  <strong>The split is incomplete.</strong>
                  {{ abUsd(unhomedProbe.residualUsd) }} of unhomed spend is there for a reason none
                  of the causes describes, so the breakdown is suppressed: it must not be used to
                  size any bucket. This is the same bar the residual above is held to — a split
                  that does not add back to the figure it decomposes is not evidence.
                </p>

                <template v-else>
                  <table class="w-full text-xs mb-2">
                    <thead>
                      <tr class="text-carbon-3 text-left">
                        <th class="py-1 pr-3 font-medium">Cause</th>
                        <th class="py-1 pr-3 font-medium text-right">Amount</th>
                        <th class="py-1 pr-3 font-medium">Behind it</th>
                        <th class="py-1 font-medium">What it is · who fixes it</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="c in unhomedProbe.causes.filter((x) => x.placementFailure)"
                        :key="c.cause"
                        class="border-t border-calm-2"
                        :data-state="Number(c.usd) === 0 ? 'zero' : 'measured'"
                        :data-testid="`admin-diag-unhomed-cause-${c.cause}`"
                      >
                        <td class="py-1 pr-3">{{ UNHOMED_LABELS[c.cause] }}</td>
                        <td class="py-1 pr-3 text-right font-mono">{{ abUsd(c.usd) }}</td>
                        <td class="py-1 pr-3 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">none</template>
                          <template v-else>{{ unhomedCounts(c) }}</template>
                        </td>
                        <td class="py-1 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">
                            No spend reached this cause this month.
                          </template>
                          <template v-else>
                            {{ UNHOMED_HINTS[c.cause] }}
                            <span class="block mt-0.5 text-carbon-2">
                              Fix: {{ UNHOMED_ACTIONS[c.cause].action }}
                              <strong>Owner: {{ UNHOMED_ACTIONS[c.cause].owner }}.</strong>
                            </span>
                          </template>
                        </td>
                      </tr>
                    </tbody>
                    <!--
                      Separated on purpose (not a fifth row of the same list):
                      pooled money is a DESIGNED residual, not a placement
                      failure. Presented as a peer, a large percentage reads as
                      one problem with one fix, and an operator would size a
                      placement campaign against money no amount of placing can
                      move. It still counts toward the same reconciled total.
                    -->
                    <tbody class="border-t-2 border-calm">
                      <tr
                        v-for="c in unhomedProbe.causes.filter((x) => !x.placementFailure)"
                        :key="c.cause"
                        :data-state="Number(c.usd) === 0 ? 'zero' : 'measured'"
                        :data-testid="`admin-diag-unhomed-cause-${c.cause}`"
                      >
                        <td class="py-1 pr-3">
                          {{ UNHOMED_LABELS[c.cause] }}
                          <span class="block text-[10px] text-carbon-3">not a placement failure</span>
                        </td>
                        <td class="py-1 pr-3 text-right font-mono">{{ abUsd(c.usd) }}</td>
                        <td class="py-1 pr-3 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">none</template>
                          <template v-else>{{ unhomedCounts(c) }}</template>
                        </td>
                        <td class="py-1 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">
                            No spend reached this cause this month.
                          </template>
                          <template v-else>
                            {{ UNHOMED_HINTS[c.cause] }}
                            <span class="block mt-0.5 text-carbon-2">
                              <!--
                                NO REMEDIATION LINK. This card is a read-only
                                probe and says so; a "Fix org homing →" button
                                inside it was an action on a surface that states
                                it has none. The fix is NAMED above and lives on
                                the reconciliation surface, which is where it is
                                done.
                              -->
                              Fix: {{ UNHOMED_ACTIONS[c.cause].action }}
                              <strong>Owner: {{ UNHOMED_ACTIONS[c.cause].owner }}.</strong>
                            </span>
                          </template>
                        </td>
                      </tr>
                      <tr class="border-t-2 border-calm font-bold">
                        <td class="py-1 pr-3">Unexplained (residual)</td>
                        <td
                          class="py-1 pr-3 text-right font-mono text-brand-harmony"
                          data-state="zero"
                          data-testid="admin-diag-unhomed-residual"
                        >
                          {{ abUsd(unhomedProbe.residualUsd) }}
                        </td>
                        <td class="py-1 pr-3" />
                        <!--
                          SAYS EXACTLY WHAT THIS PROVES, and no more. The residual
                          is total − Σ(causes): it detects money that is in the
                          total and in NO cause. Two things it CANNOT detect, both
                          of which an earlier draft of this copy claimed it could:
                          money in the WRONG cause (moving a dollar between two
                          causes leaves the sum unchanged — the card's own
                          absorption sweep found four such moves with the residual
                          at zero throughout), and a dollar dropped from one cause
                          alongside a dollar double-counted in another, because
                          those cancel inside a single equation over signed sums.
                          Presenting $0.00 as proof the split is complete and
                          un-doubled would be an overstatement on a governance
                          surface. Say only that the causes sum.
                        -->
                        <td class="py-1 text-carbon-3 font-normal">
                          Should be $0.00. Anything else means a dollar is unhomed for a reason
                          none of the causes above describes. The split is then incomplete and must
                          not be used to size any of them.
                          <span class="block mt-0.5">
                            $0.00 means the causes SUM to the figure above, and nothing more than
                            that. It is one equation over signed sums, so it cannot see a dollar
                            dropped from one cause and a dollar double-counted in another — those
                            cancel and it still reads zero. It also does <strong>not</strong> mean
                            every dollar is in the right cause: moving money between two causes
                            leaves the sum unchanged. Read the counts and the worklist below to
                            judge whether a cause is the right one.
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <!--
                    THE WORKLIST. Row type follows the CAUSE, because the thing
                    you would actually fix differs per cause: the two
                    holding-node causes put every teammate on the same one or two
                    nodes, so a unit-keyed row there would name something no
                    admin surface can act on. Every list is capped and SAYS SO,
                    with the money shown against the money in the bucket — a
                    truncated list must never read as the whole bucket.
                  -->
                  <div
                    v-for="w in unhomedVisibleWorklists"
                    :key="`wl-${w.cause}`"
                    class="mb-3"
                    :data-testid="`admin-diag-unhomed-worklist-${w.cause}`"
                  >
                    <p class="text-[11px] font-medium text-carbon-3 mb-1">
                      {{ UNHOMED_LABELS[w.cause] }} —
                      <template v-if="w.shown < w.total">
                        top {{ w.shown }} of {{ w.total }} ·
                        {{ abUsd(w.shownUsd) }} of {{ abUsd(w.bucketUsd) }} shown
                      </template>
                      <template v-else>
                        all {{ w.total }} ·
                        {{ abUsd(w.shownUsd) }} of {{ abUsd(w.bucketUsd) }} shown
                      </template>
                    </p>
                    <table class="w-full text-[11px]">
                      <tbody>
                        <tr
                          v-for="(row, i) in w.rows"
                          :key="`${w.cause}-${i}`"
                          class="border-t border-calm-2"
                        >
                          <td class="py-1 pr-3">
                            {{ row.label }}
                            <span v-if="row.sublabel" class="text-carbon-3"> · {{ row.sublabel }}</span>
                          </td>
                          <td class="py-1 pr-3 text-carbon-3">{{ row.region ?? '' }}</td>
                          <td class="py-1 pr-3 text-carbon-3">
                            <template v-if="row.headcount !== null">
                              {{ plural(row.headcount, ['person', 'people']) }}
                            </template>
                          </td>
                          <td class="py-1 text-right font-mono">{{ abUsd(row.usd) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>

                <!--
                  What is NOT in the figure. Stops an operator chasing a
                  discrepancy between this number and the unallocated dollars on
                  the reconciliation surface, and stops them concluding the split
                  is wrong when it is merely scoped.
                -->
                <p class="text-[11px] text-carbon-3 mb-3" data-testid="admin-diag-unhomed-scope">
                  This figure covers CHARGEABLE spend only. Unclassified provider bill lines and
                  chargeback-exempt spend can also carry no Business Unit; both are outside this
                  number by design and are reported elsewhere.
                </p>

                <!-- ── Can automatic placement work at all? ─────────────────── -->
                <div class="mb-3" data-testid="admin-diag-unhomed-config">
                  <h4 class="text-xs font-bold text-carbon mb-1">Can automatic placement work at all?</h4>
                  <template v-if="!unhomedProbe.placementConfig">
                    <p class="text-[11px] text-carbon-3" data-state="unknown">
                      <strong>Coverage unknown.</strong> The placement configuration could not be
                      read, so this says nothing about whether placement is configured — it is not
                      a zero.
                    </p>
                  </template>
                  <template v-else>
                    <p
                      class="text-[11px] text-carbon-3"
                      :data-state="unhomedProbe.placementConfig.activeCostOwningUnits === 0
                        ? 'not-applicable'
                        : unhomedProbe.placementConfig.unitsWithCostCentreCode === 0 ? 'zero' : 'measured'"
                      data-testid="admin-diag-unhomed-config-codes"
                    >
                      <template v-if="unhomedProbe.placementConfig.activeCostOwningUnits === 0">
                        <strong>No active Business Units exist at all.</strong> Nothing can be
                        placed, so no NEW spend can home. Existing rows are not necessarily
                        unhomed: a row keeps whichever Business Unit it was stamped with, and a
                        unit that has since been retired still counts as homed here. Read the
                        figure above rather than inferring it from this line.
                      </template>
                      <template v-else-if="unhomedProbe.placementConfig.unitsWithCostCentreCode === 0">
                        <strong>None of the
                          {{ unhomedProbe.placementConfig.activeCostOwningUnits }} active
                          Business Units carries a directory cost-centre code</strong>, so
                        the DIRECT match on that code can never fire. That is one of two automatic
                        routes: the manager-chain walk below needs no codes and may still place
                        people. If both are unavailable, every bill-driven person lands on a
                        holding node.
                      </template>
                      <template v-else>
                        <strong>{{ unhomedProbe.placementConfig.unitsWithCostCentreCode }} of
                          {{ unhomedProbe.placementConfig.activeCostOwningUnits }} active
                          Business Units carry a directory cost-centre code.</strong>
                        A person is placed automatically only when their directory cost centre
                        matches one of these codes — a unit without a code can never be matched,
                        however correct the rest of the tree is.
                      </template>
                    </p>
                    <p
                      class="text-[11px] text-carbon-3 mt-1"
                      :data-state="unhomedProbe.placementConfig.activeOwners === 0 ? 'zero' : 'measured'"
                      data-testid="admin-diag-unhomed-config-owners"
                    >
                      <strong>{{ unhomedProbe.placementConfig.activeOwners }} active Business Unit
                        owners across {{ unhomedProbe.placementConfig.unitsWithActiveOwner }}
                        units.</strong>
                      An owner is the person accountable for a unit’s spend, and ownership is also
                      the signal that places someone by their manager chain when
                      their directory cost-centre code does not match. With no owners, neither the accountability nor that placement
                      path exists.
                      <template v-if="unhomedProbe.placementConfig.activeOwners > 0">
                        {{ unhomedProbe.placementConfig.ownersWithDirectoryIdentity }} of them carry
                        a directory identity the manager chain can match on; the rest are counted
                        for accountability but cannot drive placement.
                      </template>
                    </p>
                  </template>
                </div>

                <!-- ── Who can see Business Unit reporting right now ──────────── -->
                <div class="mb-3" data-testid="admin-diag-unhomed-visibility">
                  <h4 class="text-xs font-bold text-carbon mb-1">Who can see Business Unit reporting right now</h4>
                  <p class="text-[11px] text-carbon-3 mb-1">
                    This is the <strong>baseline capability matrix</strong> — what each role WOULD be
                    granted with NO report-access grant at all, computed from the policy, not from this
                    estate. It does not inspect who actually holds those roles, owns a Business Unit, or
                    reads these reports, so it tells you which roles could notice this spend going
                    missing, never how many people that is or whether anyone occupies them.
                    {{ abData.visibility.elevated.teammates }} teammates hold elevated grants
                    ({{ abData.visibility.elevated.operational }} operational,
                    {{ abData.visibility.elevated.finance }} finance) — on top of this baseline.
                    <NuxtLink
                      to="/admin/policies/report-access"
                      class="text-brand-harmony hover:underline"
                    >Manage report access →</NuxtLink>
                  </p>
                  <table class="w-full text-[11px]">
                    <tbody>
                      <tr
                        v-for="p in abData.visibility.personas"
                        :key="p.key"
                        class="border-t border-calm-2"
                      >
                        <td class="py-1 pr-3 w-40">{{ p.label }}</td>
                        <td class="py-1 text-carbon-3">
                          {{ p.scopes.length ? p.scopes.join(' · ') : 'No reporting scopes' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- ── Is this getting worse? ───────────────────────────────── -->
                <div data-testid="admin-diag-unhomed-history">
                  <h4 class="text-xs font-bold text-carbon mb-1">Is this getting worse?</h4>
                  <!--
                    No "could not be read" branch: the trend's money comes out of
                    the SAME statement as the figure above it, so a history that
                    could not be read is a probe that could not be read, and the
                    section-level "No reading" above already says so. What CAN
                    fail on its own is a month's finance period, and that is a
                    per-month "Unknown" rather than a blanked trend.
                  -->
                  <p class="text-[11px] text-carbon-3 mb-1">
                    Unhomed chargeable spend by month, against total chargeable spend for the same
                    month. The series is <strong>half live, half snapshot</strong>. Per-teammate
                    spend is re-homed from today’s org tree on every read, so placing someone moves
                    their whole history at once, closed months included. Pooled provider spend is
                    not: each bill row carries the Business Unit it was stamped with when that
                    month was pulled, so re-pointing a provider organisation changes nothing here
                    until that month is re-pulled. A step in this trend can therefore be a
                    placement change, a re-pull, or a real event — the three are not
                    distinguishable from this chart alone.
                  </p>
                  <table class="w-full text-[11px]">
                    <tbody>
                      <tr
                        v-for="h in unhomedProbe.history"
                        :key="h.month"
                        class="border-t border-calm-2"
                        :class="h.selected ? 'font-bold' : ''"
                        :data-state="h.state"
                        :data-testid="`admin-diag-unhomed-history-${h.month}`"
                      >
                        <td class="py-1 pr-3 w-40">
                          {{ unhomedMonthLabel(h.month) }}
                          <span v-if="h.selected" class="text-brand-harmony">· selected</span>
                        </td>
                        <td class="py-1 pr-3">
                          <template v-if="h.state === 'measured'">
                            {{ abUsd(h.unhomedUsd ?? undefined) }} unhomed of
                            {{ abUsd(h.chargeableUsd ?? undefined) }}
                            <!--
                              A month whose chargeable NETS to $0.00 (a credit
                              note, a negative reconciliation) still has real
                              unhomed dollars inside it, and its share is
                              UNDEFINED — not 0%, not Infinity%. Printing an
                              invented percentage here would replace one false
                              statement with another.
                            -->
                            <template v-if="h.sharePct !== null">({{ h.sharePct.toFixed(1) }}%)</template>
                            <template v-else>· share undefined: this month’s chargeable nets to $0.00</template>
                            <span v-if="h.partial" class="text-carbon-3">· month still in progress</span>
                          </template>
                          <template v-else-if="h.state === 'no-spend'">
                            No chargeable spend in this month, and none unhomed either
                          </template>
                          <template v-else>
                            Not measured — before this estate carried any billed data
                          </template>
                        </td>
                        <td
                          class="py-1 text-carbon-3"
                          :title="snapshotConsequence[snapshotKey(h.recorded)]"
                          :data-period-state="snapshotKey(h.recorded)"
                        >
                          {{ SNAPSHOT_WORD[snapshotKey(h.recorded)] }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p class="text-[11px] text-carbon-3 mt-1" data-testid="admin-diag-unhomed-period-note">
                    {{ snapshotConsequence.recorded }}
                    {{ snapshotConsequence['not-recorded'] }}
                    A month with no stored snapshot has simply never been recorded — absence is not a state.
                    {{ snapshotConsequence.unknown }}
                  </p>
                </div>
              </template>
            </div>
          </template>
        </template>
        <AdminPageSkeleton v-else :rows="4" :toolbar="false" />
      </UiCard>

      <UiCard accent="hunger" class="lg:col-span-2" data-testid="admin-diag-attribution-gaps">
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 class="text-sm font-bold text-carbon">Attribution gaps</h2>
            <p class="text-xs text-carbon-3 mt-0.5">
              Devices minting ingest credentials (so they are emitting) whose attributed spend has
              fallen days behind. Azure accepting an export does not mean it was attributed.
            </p>
          </div>
          <UiButton kind="secondary" size="sm" :disabled="gapsPending" @click="refreshGaps()">
            {{ gapsPending ? 'Checking…' : 'Re-check' }}
          </UiButton>
        </div>

        <UiFetchErrorBanner v-if="gapsError" :error="gapsError" label="attribution gaps" @retry="refreshGaps" />
        <template v-else-if="gapsData">
          <p v-if="!gapsData.reachable" class="text-sm text-brand-hunger">
            Probe failed: {{ gapsData.error }}
          </p>
          <p v-else-if="gapsData.count === 0" class="text-sm text-brand-harmony">
            No gaps — every live device has attributed spend within the window.
          </p>
          <div v-else>
            <p class="text-sm font-bold text-brand-hunger mb-2">
              {{ gapsData.count }} device{{ gapsData.count === 1 ? '' : 's' }} emitting without attribution
            </p>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-carbon-3 text-left">
                  <th class="py-1 pr-3 font-medium">Teammate</th>
                  <th class="py-1 pr-3 font-medium">Device</th>
                  <th class="py-1 pr-3 font-medium">Last emitted</th>
                  <th class="py-1 pr-3 font-medium">Last attributed</th>
                  <th class="py-1 pr-3 font-medium">Behind by</th>
                  <th class="py-1 font-medium">Client vs server</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="i in gapsData.instances" :key="i.instanceId">
                  <tr class="border-t border-calm-2">
                    <td class="py-1 pr-3">{{ i.email ?? '—' }}</td>
                    <td class="py-1 pr-3 font-mono">{{ i.instanceId.slice(0, 8) }}</td>
                    <td class="py-1 pr-3">{{ i.lastBearerAt?.slice(0, 16) }}</td>
                    <td class="py-1 pr-3">{{ i.lastAttributedAt?.slice(0, 16) ?? 'never' }}</td>
                    <td class="py-1 pr-3 font-bold text-brand-hunger">{{ gapDays(i.gapHours) }}</td>
                    <td class="py-1">
                      <UiButton
                        kind="secondary"
                        size="sm"
                        :disabled="diagnosing === i.instanceId"
                        :data-testid="`admin-diag-diagnose-${i.instanceId}`"
                        @click="diagnoseInstance(i.instanceId, i.gapHours)"
                      >
                        {{ diagnosing === i.instanceId ? 'Checking ingest…' : 'Diagnose' }}
                      </UiButton>
                    </td>
                  </tr>
                  <!--
                    The answer to the ONE question that splits the outage in half:
                    is this device's telemetry in ingest at all for the gap window?
                    Rendered under the row it belongs to so the evidence and the
                    verdict are never read apart.
                  -->
                  <tr v-if="diagnosis[i.instanceId]" class="border-t border-calm-2 bg-calm-1/40">
                    <td colspan="6" class="py-2 px-2">
                      <template v-if="'failed' in diagnosis[i.instanceId]!">
                        <p class="text-xs text-brand-hunger">
                          Probe failed — this is NOT evidence about the device:
                          {{ (diagnosis[i.instanceId] as { failed: string }).failed }}
                        </p>
                      </template>
                      <template v-else>
                        <div class="flex items-center gap-2 mb-1">
                          <UiBadge :kind="telemetryVerdictBadge((diagnosis[i.instanceId] as InstanceTelemetryResp).verdict).kind">
                            {{ telemetryVerdictBadge((diagnosis[i.instanceId] as InstanceTelemetryResp).verdict).label }}
                          </UiBadge>
                          <span class="text-[11px] text-carbon-3">
                            window {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).windowHours }}h
                          </span>
                        </div>
                        <p class="text-xs text-carbon-2 mb-1">
                          {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).interpretation }}
                        </p>
                        <p class="text-[11px] text-carbon-3 font-mono">
                          ingest:
                          <template v-if="(diagnosis[i.instanceId] as InstanceTelemetryResp).ingest.reachable">
                            {{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { records: number }).records }} record(s),
                            {{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { usageRecords: number }).usageRecords }} usage
                          </template>
                          <template v-else>
                            unreadable ({{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { error: string | null }).error }})
                          </template>
                          &nbsp;·&nbsp; ledger: {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).attribution.records }} record(s)
                        </p>
                        <!--
                          Client-asserted (mig 0092, 0150). Shown because it is the first
                          thing you want once the verdict says "client side" — and
                          "not reported" is itself the answer: the device is on a
                          build older than the one that reports its version.
                        -->
                        <p class="text-[11px] text-carbon-3 mt-1">
                          client claims — plugin
                          <strong>{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientPluginVersion ?? 'not reported' }}</strong>,
                          CLI
                          <strong>{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientCliVersion ?? 'not reported' }}</strong>,
                          platform
                          <strong data-testid="client-platform">{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientPlatform ?? 'not reported' }}</strong>,
                          surface
                          <strong data-testid="client-surface">{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientSurface ?? 'not reported' }}</strong>
                          <template v-if="(diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientVersionAt">
                            (as of {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance!.clientVersionAt!.slice(0, 16) }})
                          </template>
                          · last setup
                          <strong data-testid="setup-mode">{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.setupMode ?? 'not reported' }}</strong>
                          — self-reported, not attested.
                        </p>
                      </template>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>

            <!--
              The recovery lever. The reader has always accepted a lookback up to
              90 days; nothing an admin could touch ever passed it, so a backlog
              older than a week was unrecoverable from the product. Enqueue-only:
              a 90-day read cannot be served inside the ~120s worker gateway.
            -->
            <div class="mt-4 pt-3 border-t border-calm-2" data-testid="admin-diag-recovery">
              <div v-if="canRecover" class="flex flex-wrap items-center gap-3">
                <div>
                  <label class="text-xs text-carbon-3 mr-2" for="recovery-lookback">Re-read window (days)</label>
                  <input
                    id="recovery-lookback"
                    v-model.number="recoveryLookbackDays"
                    type="number"
                    min="1"
                    max="90"
                    class="w-20 text-xs border border-calm rounded px-2 py-1"
                  >
                </div>
                <UiButton
                  kind="primary"
                  size="sm"
                  :disabled="recoverySubmitting || recoveryData?.inFlight || gapsData.count === 0"
                  data-testid="admin-diag-recovery-submit"
                  @click="requestRecovery()"
                >
                  {{ recoverySubmitting ? 'Queueing…' : `Re-read these ${gapsData.count} device(s)` }}
                </UiButton>
                <p v-if="recoveryData?.inFlight" class="text-xs text-carbon-3">
                  An operator recovery is already in flight. They run one at a time; the
                  daily pass yields to them between ticks.
                </p>
              </div>
              <p v-else class="text-xs text-carbon-3">
                Requesting a re-read needs the Admin role — it is not region-bounded and
                it spends Log Analytics query budget. Diagnose above is available to you; the
                progress below is read-only.
              </p>
              <p class="text-[11px] text-carbon-3 mt-2">
                Re-reads the listed devices at a wider ingest window with a full re-scan, so
                already-ingested spend older than the usual 7-day window can be joined.
                Queued and drained in slices — <strong>accepted is not recovered</strong>; the
                progress below is what says whether anything was actually written.
              </p>
              <p v-if="recoveryMessage" class="text-xs text-carbon-2 mt-2">{{ recoveryMessage }}</p>

              <div v-if="recoveryData?.requests?.length" class="mt-3">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-medium text-carbon-3">Recent recoveries</span>
                  <UiButton kind="secondary" size="sm" :disabled="recoveryPending" @click="refreshRecovery()">
                    {{ recoveryPending ? 'Refreshing…' : 'Refresh' }}
                  </UiButton>
                </div>
                <table class="w-full text-[11px]">
                  <thead>
                    <tr class="text-carbon-3 text-left">
                      <th class="py-1 pr-3 font-medium">Requested</th>
                      <th class="py-1 pr-3 font-medium">Window</th>
                      <th class="py-1 pr-3 font-medium">Status</th>
                      <th class="py-1 pr-3 font-medium">Progress</th>
                      <th class="py-1 pr-3 font-medium">Rows written</th>
                      <th class="py-1 font-medium">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in recoveryData.requests" :key="r.id" class="border-t border-calm-2">
                      <td class="py-1 pr-3">{{ r.requestedAt?.slice(0, 16) }}</td>
                      <td class="py-1 pr-3">{{ r.lookbackDays }}d<span v-if="r.kind === 'scheduled'"> · daily pass</span></td>
                      <td class="py-1 pr-3">{{ r.status }}<span v-if="r.error"> — {{ r.error }}</span></td>
                      <td class="py-1 pr-3">{{ r.instancesProcessed }}/{{ r.instanceCount }} ({{ r.percentComplete }}%)</td>
                      <!-- Kept visually distinct from progress: 100% processed with
                           zero rows is a real, informative outcome, not a failure. -->
                      <td class="py-1 pr-3 font-bold">{{ r.rowsWritten }}</td>
                      <td class="py-1">{{ r.errors }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </template>
        <AdminPageSkeleton v-else :rows="3" :toolbar="false" />
      </UiCard>

      <!-- Card D — Provider wire shape. Platform-admin only; button-triggered
           because the live mode issues real provider calls. Shape only: a
           successful response body is never rendered. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-wire-shape">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Provider wire shape</UiEyebrow>
          <div v-if="canProbeWireShape" class="flex items-center gap-2">
            <UiButton
              kind="secondary"
              size="sm"
              :disabled="wireRunning !== null"
              data-testid="admin-diag-wire-scan-stored"
              @click="runWireShape('stored')"
            >
              {{ wireRunning === 'stored' ? 'Scanning…' : 'Scan stored payloads' }}
            </UiButton>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="wireRunning !== null"
              data-testid="admin-diag-wire-run-live"
              @click="runWireShape('both')"
            >
              {{ wireRunning === 'both' ? 'Probing…' : 'Run live probe' }}
            </UiButton>
            <UiButton
              v-if="wireData"
              kind="secondary"
              size="sm"
              data-testid="admin-diag-wire-copy"
              @click="copyWireReport()"
            >
              {{ wireCopied ? 'Copied ✓' : 'Copy report JSON' }}
            </UiButton>
          </div>
        </div>

        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>Admin</strong>. Reports the <strong>shape</strong> of provider
          payloads — key paths, types and how often each key is present. A successful response body
          is never shown, stored or logged.
          <strong>Scan stored payloads</strong> reads what the pollers already saved: no provider
          call, no credential, no cost. <strong>Run live probe</strong> additionally issues one page
          of each configured provider call for a single recent day.
        </p>

        <p
          v-if="!canProbeWireShape"
          class="text-sm text-carbon-3"
          data-testid="admin-diag-wire-scoped"
        >
          Scoped out — this probe is Admin only. Nothing is wrong; every other card on this
          page still applies to your role.
        </p>

        <template v-else>
          <p v-if="wireError" class="text-sm text-brand-hunger font-mono" data-testid="admin-diag-wire-error">
            {{ wireError }}
          </p>

          <template v-if="wireData">
            <p class="text-xs text-carbon-3">
              {{ wireData.generatedAt.slice(0, 19) }}Z · mode <span class="font-mono">{{ wireData.mode }}</span>
              · live day <span class="font-mono">{{ wireData.day }}</span>
            </p>
            <p class="text-xs text-carbon-3 mt-1">{{ wireData.note }}</p>

            <!-- The headline result. These are key paths the payload carries and
                 our Zod schema does not declare — fields TokenScope receives and
                 ignores. This is the defect class the whole card exists for, so
                 it renders above the per-surface detail, never inside it. -->
            <div class="mt-4" data-testid="admin-diag-wire-undeclared">
              <div class="flex items-center gap-2 mb-2">
                <h2 class="text-sm font-bold text-carbon">Received but not declared by our schema</h2>
                <UiBadge :kind="wireUndeclaredTotal > 0 ? 'rag-red' : 'rag-green'">
                  {{ wireUndeclaredTotal }} path{{ wireUndeclaredTotal === 1 ? '' : 's' }}
                </UiBadge>
              </div>
              <p v-if="wireUndeclaredTotal === 0" class="text-xs text-carbon-3">
                No undeclared key paths were observed on any surface reported above. Surfaces that are
                not configured, errored, or returned no rows cannot contribute here — check their
                individual status before reading this as a clean result.
              </p>
              <div v-else class="space-y-2">
                <div
                  v-for="s in wireSurfaces.filter((x) => (x.undeclared?.paths.length ?? 0) > 0)"
                  :key="`undeclared-${s.mode}-${s.id}`"
                  class="border border-calm-2 rounded p-3"
                  :data-testid="`admin-diag-wire-undeclared-${s.mode}-${s.id}`"
                >
                  <div class="text-xs font-bold text-carbon">{{ s.label }} <span class="text-carbon-3">({{ s.mode }})</span></div>
                  <p class="text-[11px] text-carbon-3 mb-1">{{ s.undeclared?.note }}</p>
                  <div class="flex flex-wrap gap-1">
                    <code
                      v-for="p in s.undeclared?.paths"
                      :key="p"
                      class="text-[11px] font-mono bg-brand-hunger-sheer/40 text-carbon px-1.5 py-0.5 rounded"
                    >{{ p }}</code>
                  </div>
                </div>
              </div>
            </div>

            <!-- Per-surface detail. -->
            <div class="mt-5 space-y-3">
              <div
                v-for="s in wireSurfaces"
                :key="`${s.mode}-${s.id}`"
                class="border border-calm-2 rounded p-3"
                :data-testid="`admin-diag-wire-surface-${s.mode}-${s.id}`"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-bold text-carbon">{{ s.label }}</span>
                  <UiBadge kind="neutral">{{ s.mode }}</UiBadge>
                  <UiBadge :kind="wireStatusBadge(s).kind">{{ wireStatusBadge(s).label }}</UiBadge>
                  <UiBadge v-if="s.status === 'ok'" :kind="wireDriftBadge(s.drift).kind">
                    {{ wireDriftBadge(s.drift).label }}
                  </UiBadge>
                  <span v-if="s.status === 'ok'" class="text-xs text-carbon-3">
                    {{ s.summary?.itemCount }} row{{ s.summary?.itemCount === 1 ? '' : 's' }} observed
                  </span>
                </div>
                <div class="text-[11px] font-mono text-carbon-3 break-all mt-1">{{ s.endpoint }}</div>

                <!-- Not configured is a NEUTRAL expected state, not a failure:
                     an environment wired to one Anthropic variant legitimately
                     has no org for the other. -->
                <p v-if="s.status === 'not-configured'" class="text-xs text-carbon-2 mt-2">
                  {{ s.reason }}
                </p>

                <template v-else-if="s.status === 'errored'">
                  <p class="text-xs text-carbon-2 mt-2">
                    HTTP <span class="font-mono font-bold">{{ s.error?.status }}</span>
                    <span v-if="s.error?.status === 0"> — no response received (transport failure)</span>
                  </p>
                  <!-- Raw provider error text, deliberately: a classified reason
                       hides the cause. Credentials are removed; long bodies cut. -->
                  <pre class="mt-1 text-[11px] font-mono bg-calm-1 text-carbon p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">{{ s.error?.bodyText }}</pre>
                  <p v-if="s.error?.truncated" class="text-[11px] text-carbon-3">Body truncated.</p>
                </template>

                <template v-else-if="s.status === 'ok'">
                  <div v-if="s.request" class="mt-2 text-[11px] text-carbon-3">
                    <span class="font-mono">{{ s.request.method }} {{ s.request.path }}</span>
                    <div class="flex flex-wrap gap-1 mt-1">
                      <code
                        v-for="(pair, i) in s.request.params"
                        :key="`${pair[0]}-${i}`"
                        class="font-mono bg-calm-1 px-1.5 py-0.5 rounded"
                      >{{ pair[0] }}={{ pair[1] }}</code>
                    </div>
                    <div class="mt-1">{{ s.request.note }}</div>
                  </div>

                  <!-- Bound AND scope of the stored scan, stated rather than silently
                       applied: which rows were read is as load-bearing as how many. -->
                  <p v-if="s.scan" class="mt-2 text-[11px] text-carbon-3">
                    Scanned <strong>{{ s.scan.rowsScanned }}</strong> of at most {{ s.scan.rowLimit }}
                    <span class="font-mono">{{ s.scan.source }}</span> rows from the last
                    {{ s.scan.windowDays }} days, where <span class="font-mono">{{ s.scan.filter }}</span>.
                    <span v-if="s.scan.capped" class="text-brand-hunger font-bold">
                      More rows exist beyond the cap — this is a prefix of the window, not all of it.
                    </span>
                  </p>

                  <!-- Zero rows scanned is at least three different facts, and they
                       demand different actions. The unfiltered counts are what tells
                       "nothing was written" apart from "rows exist, none matched". -->
                  <p
                    v-if="s.scan?.unfiltered"
                    class="mt-1 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-unfiltered-${s.mode}-${s.id}`"
                  >
                    Same window before these filters:
                    <strong>{{ s.scan.unfiltered.rowsForProvider }}</strong> row(s) for this provider,
                    <strong>{{ s.scan.unfiltered.rowsForEnterprise }}</strong> of them on the probed
                    enterprise.
                    <span class="block text-carbon-3">{{ s.scan.unfiltered.note }}</span>
                  </p>

                  <!-- A two-step read (report envelope + one signed NDJSON file).
                       The bound is stated for the same reason the stored scan states
                       its row cap: a silent cap reads as "we looked at everything". -->
                  <p
                    v-if="s.fetchBound"
                    class="mt-2 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-fetch-bound-${s.mode}-${s.id}`"
                  >
                    Read <strong>{{ s.fetchBound.linksRead }}</strong> of
                    <strong>{{ s.fetchBound.linksAvailable }}</strong> download link(s), and
                    <strong>{{ s.fetchBound.linesRead }}</strong> line(s) of that file (cap
                    {{ s.fetchBound.lineLimit }}).
                    <span v-if="s.fetchBound.linesCapped" class="text-brand-hunger font-bold">
                      The file held more lines than the cap — these records are a prefix of it.
                    </span>
                    <span v-if="s.fetchBound.linesUnparseable > 0">
                      {{ s.fetchBound.linesUnparseable }} line(s) were not JSON and were skipped.
                    </span>
                    <span class="block text-carbon-3">{{ s.fetchBound.note }}</span>
                  </p>

                  <!-- The stored mode reads PARSED payloads, so a stripping Zod object
                       hides anything nested inside it. Say so, or "no undeclared
                       fields here" reads as evidence of absence. -->
                  <p
                    v-if="s.unobservable?.paths.length"
                    class="mt-2 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-unobservable-${s.mode}-${s.id}`"
                  >
                    <strong class="text-brand-hunger">Not observable in this mode:</strong>
                    <span class="font-mono">{{ s.unobservable.paths.join(', ') }}</span>
                    — {{ s.unobservable.note }}
                  </p>

                  <!-- data_refreshed_at: we parse it on both Enterprise reports
                       and have never read it. Rows after it are an incomplete tail. -->
                  <p v-if="s.freshness" class="mt-2 text-[11px] text-carbon-2">
                    <strong>data_refreshed_at:</strong>
                    <span class="font-mono">{{ s.freshness.dataRefreshedAt ?? 'absent' }}</span>
                    · window ends <span class="font-mono">{{ s.freshness.windowEndingAt }}</span>
                    <UiBadge
                      class="ml-1"
                      :kind="s.freshness.coversWindow === true ? 'rag-green' : s.freshness.coversWindow === false ? 'rag-amber' : 'neutral'"
                    >
                      {{ s.freshness.coversWindow === true ? 'covers the window' : s.freshness.coversWindow === false ? 'window not yet refreshed' : 'unknown' }}
                    </UiBadge>
                    <span class="block text-carbon-3">{{ s.freshness.note }}</span>
                  </p>

                  <p v-if="s.defaultedPaths?.length" class="mt-2 text-[11px] text-carbon-3">
                    {{ s.defaultedPaths.length }} observed path(s) are supplied by a Zod
                    <span class="font-mono">.default()</span>, so their presence here is 100% by
                    construction and is <strong>not</strong> evidence the provider sent them:
                    <span class="font-mono">{{ s.defaultedPaths.join(', ') }}</span>
                  </p>

                  <p v-if="s.drift?.status === 'no-data'" class="mt-2 text-[11px] text-carbon-2">
                    {{ s.drift.note }}
                  </p>

                  <div v-if="s.drift?.status === 'drift' || s.drift?.status === 'inconclusive'" class="mt-2 text-[11px] space-y-1">
                    <div v-if="s.drift.removed?.length">
                      <span class="font-bold text-brand-hunger">Declared but absent:</span>
                      <span class="font-mono">{{ s.drift.removed.join(', ') }}</span>
                    </div>
                    <div v-if="s.drift.presenceMoved?.length">
                      <span class="font-bold text-brand-hunger">Presence moved:</span>
                      <span
                        v-for="m in s.drift.presenceMoved"
                        :key="m.path"
                        class="font-mono mr-2"
                      >{{ m.path }} {{ Math.round(m.baselineRate * 100) }}% → {{ Math.round(m.liveRate * 100) }}% ({{ m.present }}/{{ m.total }})</span>
                    </div>
                    <div v-if="s.drift.typeChanged?.length">
                      <span class="font-bold text-brand-hunger">Unexpected types:</span>
                      <span
                        v-for="t in s.drift.typeChanged"
                        :key="t.path"
                        class="font-mono mr-2"
                      >{{ t.path }} +{{ t.unexpected.join('|') }}</span>
                    </div>
                    <div v-if="s.drift.notObserved?.length" class="text-carbon-3">
                      <span class="font-bold">Container never appeared, nothing concluded:</span>
                      <span class="font-mono">{{ s.drift.notObserved.join(', ') }}</span>
                    </div>
                  </div>

                  <!-- Absent AND optional. Reported, but not as drift: our schema
                       makes no presence claim for these, so calling their absence
                       a change would put a red badge on every run. -->
                  <p
                    v-if="s.drift?.absentOptional?.length"
                    class="mt-2 text-[11px] text-carbon-3"
                    :data-testid="`admin-diag-wire-absent-optional-${s.mode}-${s.id}`"
                  >
                    <span class="font-bold">Optional in our schema and absent here:</span>
                    <span class="font-mono">{{ s.drift.absentOptional.join(', ') }}</span>
                    — our schema declares these optional, so their absence is not drift and does not
                    change the badge above.
                  </p>

                  <UiButton
                    kind="secondary"
                    size="sm"
                    class="mt-2"
                    :data-testid="`admin-diag-wire-paths-toggle-${s.mode}-${s.id}`"
                    @click="toggleWireSurface(`${s.mode}-${s.id}`)"
                  >
                    {{ wireExpanded[`${s.mode}-${s.id}`] ? 'Hide' : 'Show' }} {{ s.summary?.paths.length }} key paths
                  </UiButton>

                  <div v-if="wireExpanded[`${s.mode}-${s.id}`]" class="mt-2 overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="bg-brand-vision-sheer/40 border-b border-calm-2">
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Key path</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Types</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Present</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Null</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Distinct values</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-calm-2">
                        <tr v-for="p in s.summary?.paths" :key="p.path" class="hover:bg-brand-vision-sheer/30 align-top">
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">{{ p.path }}</td>
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon-2">{{ p.types.join('|') }}</td>
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon">
                            {{ p.present }}/{{ p.total }} ({{ wirePct(p.present, p.total) }})
                          </td>
                          <td class="px-3 py-2 font-mono text-[11px]" :class="p.nulls > 0 ? 'text-brand-hunger' : 'text-carbon-3'">{{ p.nulls }}</td>
                          <td class="px-3 py-2 text-[11px] text-carbon-2 break-all">
                            <span v-if="p.distinctValues" class="font-mono">{{ p.distinctValues.join(', ') }}</span>
                            <span v-else-if="p.valuesWithheld" class="text-carbon-3 italic">{{ wireWithheldLabel(p.valuesWithheld) }}</span>
                            <span v-else class="text-carbon-3">—</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <p v-else-if="wireRunning" class="text-sm text-carbon-3 italic">Running…</p>
          <p v-else class="text-sm text-carbon-3 italic">
            Not run yet — this card never probes on page load.
          </p>
        </template>
      </UiCard>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/diagnostics">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
