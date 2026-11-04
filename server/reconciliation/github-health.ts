/*
 * GitHub Copilot reconciliation health — the engine behind the admin GitHub health
 * route (server/api/v1/admin/reconciliation/github/health.get.ts). The GitHub twin of
 * server/anthropic/org-health.ts: a live, classified, KEY-SAFE probe that tells an admin
 * exactly WHERE a Copilot enterprise's reconciliation pipeline breaks — egress vs auth vs
 * metrics-empty vs no-teammate-match — because the worker logs are NSP-locked (inaccessible).
 *
 * The probe decomposes the pipeline into STAGES, each caught + classified independently:
 *   credential → roster → (App mode) appAuth → licenses → metrics → verdict.
 *
 * SAFETY CONTRACT (non-negotiable, mirrors org-health.ts):
 *   This module NEVER returns or logs the App private key, the decoded PEM, the App JWT,
 *   an installation token, the PAT, or any raw provider error body. It returns only:
 *     - booleans + counts (licenseCount, recordCount, rosterMatched, matchedRecords),
 *     - reasons/verdicts drawn from a FIXED enum vocabulary.
 *   NOTE on the client's error detail: for most surfaces data.detail is just
 *   "<surface> returned HTTP <status>", but the users-1-day surface APPENDS a ≤200-char
 *   sanitized BODY SNIPPET (github-client.ts getUserDailyCredits). classifyGithubHealthError
 *   therefore only ever pattern-MATCHES detail and RETURNS enum values — it never copies
 *   detail (or any error text) into the result, so a body snippet can never reach the
 *   response.
 *
 * Client-INJECTABLE (probeClient factory) + roster-INJECTABLE so the whole ladder unit-tests
 * with mocks (no network, no DB). Both default to the real client + shared roster reader.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { resolveEnterpriseCredential, MissingGithubAppKeyError } from './credentials'
import { GithubCopilotClient } from './adapters/github-client'
import { GithubAppAuth, type FetchLike } from './adapters/github-app-auth'
import { resolveGithubRoster, resolveGithubSelfOnlyLogins } from './adapters/github'
import { resilientFetch, type ResilientFetchOptions } from '../utils/resilient-fetch'
import type { CredentialKind } from './credentials'
import { loadPersistedEnterpriseCoverage } from './coverage-store'

// The resolver + roster reader use only db.execute(sql`…`) (the raw escape hatch), so this
// works on either the schema-typed getDb() handle OR the RLS-bound request tx (widened).
type Db = PostgresJsDatabase<Record<string, unknown>>

/** The provider_enterprise fields the health computation needs (loaded by the route). */
export interface GithubEnterpriseRow {
  /** provider_enterprise.id (uuid text) — echoed back for the UI. */
  enterpriseId: string
  /** provider_enterprise.external_id (the enterprise slug, lowercase per mig 0062). */
  externalId: string
  /** provider_enterprise.github_app_id — non-null ⇒ App mode INTENDED (mig 0078). */
  githubAppId: string | null
}

export type HealthColor = 'green' | 'amber' | 'red'

/*
 * The fixed, SAFE classified vocabulary — the same buckets across every stage so the UI
 * renders one label map. Every value is derived from a STATUS CODE, a node error CODE, or
 * a KNOWN client fail-surface pattern — never copied from a provider body.
 */
export type StageReason =
  | 'no-credential' // credential absent (no PAT / App key wired, or malformed secret name)
  | 'key-malformed' // App mode: base64 PEM won't decode / JWT can't be built (fail-loud)
  | 'not-installed' // App mode ONLY: installation lookup 404 / "no install"
  | 'no-license-orgs' // App mode ONLY: App wired but no license org onboarded (provider_org) — config gap, amber
  | 'auth-failed' // 401/403 (and PAT-mode 404 — GitHub 404s PATs lacking scope/SSO)
  | 'egress-blocked' // ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/getaddrinfo/TLS/socket/fetch-timeout — can't reach GitHub
  | 'rate-limited' // 429 — GitHub secondary rate limit (transient)
  | 'not-ready' // the day's users-1-day report isn't generated yet / report_day mismatch (transient)
  | 'upstream-error' // 5xx or an unparseable response (HTML error page / schema drift) — transient
  | 'probe-window-exceeded' // the stage-deadline BACKSTOP fired — pathological slowness, NOT proven egress
  | 'probe-internal-error' // OUR side failed (DB read, resolver crash) — says nothing about the pipeline

/** The overall verdict — the synthesis of the stages (see synthesiseVerdict). */
export type GithubVerdict =
  | 'healthy'
  | 'no-teammate-match'
  | 'metrics-empty'
  | 'upstream-transient' // GitHub rate-limited / 5xx / report-not-ready — retry later (H1)
  | 'probe-error' // the PROBE failed internally — never impersonates a pipeline/config verdict (M3)
  | 'no-license-orgs' // App mode: no license org onboarded (provider_org) — actionable config gap (amber)
  | 'auth-failed'
  | 'egress-blocked'
  | 'not-installed'
  | 'key-malformed'
  | 'no-credential'

/*
 * A FIXED, key-safe actionable-remediation hint attached to a failing stage. Like every
 * other value this module returns, it is a CLOSED enum resolved to human text CLIENT-side —
 * never a copy of an upstream body/error string (SAFETY CONTRACT).
 *   - org-admin-read-denied: App mode, the per-org externalIdentities ENDPOINT itself returned
 *     401/403 (the org installation token WAS minted to reach it) → the App installation on
 *     that org is very likely missing "organization_administration: read". The fix is an
 *     external GitHub grant + org-install re-approval, so we surface it verbatim to the admin.
 *     (Replaces the old "admin-read-denied"/Enterprise-administration hint: App-mode identity
 *     no longer reads the App-blocked enterprise consumed-licenses endpoint.)
 */
export type StageHint = 'org-admin-read-denied'

export interface StageResult {
  ok: boolean
  reason?: StageReason
}
export interface LicensesStage extends StageResult {
  /** Consumed licenses (App) / seats (PAT) returned, when ok. */
  count?: number
  /** How many of those logins map to a teammate through a VERIFIED binding (directory sync or
   *  an admin) for this enterprise. Self-claimed logins are not counted here (#451). */
  rosterMatched?: number
  /** How many of those logins map to a teammate ONLY through the teammate's own unverified
   *  claim. Their billed overage stays Unallocated until an admin binds them. */
  selfClaimed?: number
  /** App-mode-only, key-safe remediation hint when the per-org externalIdentities endpoint is
   *  auth-denied (the org token minted but the ENDPOINT 401/403'd — organization_administration
   *  read likely missing). */
  hint?: StageHint
}
export interface MetricsStage extends StageResult {
  /** Per-user records (App) / usage items for the probed login (PAT) returned, when ok. */
  recordCount?: number
  /** How many of those returned records map to a teammate through a verified binding. */
  matchedRecords?: number
  /** True when the stage was NOT attempted (no roster-matched login to read, or the
   *  licenses stage already failed with a doomed egress/rate-limit reason — L5). */
  skipped?: boolean
}

export interface GithubEnterpriseHealth {
  enterpriseId: string
  externalId: string
  credentialKind: CredentialKind
  keyPresent: boolean
  /** The recent FINALIZED UTC day we probed metrics for (today − 2). */
  probeDay: string
  stages: {
    credential: StageResult
    /** App mode only (installation-token mint). Absent on the PAT path. */
    appAuth?: StageResult
    licenses: LicensesStage
    metrics: MetricsStage
  }
  verdict: GithubVerdict
  color: HealthColor
  /*
   * Coverage stage (Workstream D, design §6/§8.4: "wire coverage into the Verify
   * ladder"). Deliberately reads the PERSISTED latest observation
   * (coverage-store.ts) rather than recomputing live — a live pull (paginated census
   * + one installation probe per org) does not fit the ladder's tight per-attempt
   * fetch budget/deadline (PROBE_FETCH_OPTS/STAGE_DEADLINE_MS above), which is sized
   * for the four fixed, single-call stages this probe already makes. An admin who
   * wants a FRESH read uses the dedicated recheck action (coverage-recheck.post.ts),
   * which is exactly what the "clear remediation path" requirement asks the UI to
   * surface, not a second, slower Verify. Always populated for every branch below
   * (even a probe that failed at an earlier stage still gets a coverage read) —
   * coverage is independent of whether the REST of the ladder succeeded.
   */
  coverage: CoverageStage
}

/** The Verify-ladder's coverage stage — a thin, cheap read of the persisted latest
 *  observation (never a live recompute; see the field doc above). */
export interface CoverageStage {
  available: boolean
  capped: boolean
  reason: string | null
  /** Null whenever no honest "N of M" claim can be made (unavailable/capped/stale). */
  denominator: number | null
  connected: number
  /** Count of every non-connected state, summed — the ladder/banner trigger. */
  nonConnected: number
  /** True when the persisted observation itself has expired (requirement 5: an
   *  expired reading is never presented as still-current). */
  stale: boolean
  /** ISO timestamp of the last observation, or null if never swept/rechecked. */
  observedAt: string | null
}

/*
 * Classify a THROWN error into the SAFE stage vocabulary. Error shapes that reach here:
 *   1. The GitHub client / app-auth throw a createError whose data.detail carries
 *      "<surface> returned HTTP <status>" (+ on the users-1-day surface, possibly a ≤200-char
 *      body snippet). We PATTERN-MATCH the detail and read the status out of it — the SAME
 *      technique discover-orgs.post uses — but never copy detail into the result.
 *   2. resilientFetch re-throws a raw transport error on a network-layer failure: a node
 *      error carrying `.code` (ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/…), a getaddrinfo/TLS/socket
 *      message, or — under the probe's tight per-attempt budget — the AbortSignal.timeout
 *      DOMException (name 'TimeoutError'). Those are the egress signatures.
 *   3. res.json()/Zod parse throws (GitHub answered with an HTML error page or a drifted
 *      shape) — a SyntaxError / ZodError. Transient upstream, NOT an egress verdict.
 *   4. the probe's own stage-deadline backstop sentinel (code PROBE_WINDOW_EXCEEDED) —
 *      transient (probe-window-exceeded), never an egress claim.
 *
 * Order matters:
 *   a. fail-loud config errors (missing App key / malformed PEM) — exact types/prefixes;
 *   b. the probe's own stage-deadline BACKSTOP sentinel (code PROBE_WINDOW_EXCEEDED) —
 *      distinct from egress: with the tight per-attempt fetch budget a REAL black hole
 *      surfaces as a genuine transport timeout well before the backstop, so a backstop hit
 *      means pathological slowness, not proven egress (round-2 NEW-M1);
 *   c. parse errors (SyntaxError/ZodError) BEFORE the egress regex — their messages carry
 *      arbitrary response-derived text that must never accidentally match an egress signature;
 *   d. the client's LITERAL "report not ready" / "report_day … != requested" fail surfaces
 *      BEFORE the status parse — they carry "HTTP 200" (github-client.ts), which no status
 *      bucket must swallow into a false red (M1);
 *   e. egress signatures — node error codes/messages AND the AbortSignal.timeout abort
 *      (undici rejects with a DOMException named 'TimeoutError'; a plain abort is
 *      'AbortError'). Genuine transport-level failures ONLY, never an HTTP response;
 *   f. the REAL upstream status parsed from detail — the client wraps EVERYTHING in a 502
 *      createError envelope (data.status=502), so detail's "HTTP <n>" is authoritative and
 *      data.status only the fallback. 404 is MODE-AWARE (M2): in App mode it means the App
 *      isn't installed; in PAT mode GitHub 404s PATs lacking scope/SSO → auth-failed;
 *   g. default → upstream-error (transient), NEVER an egress/auth claim (H1).
 *
 * `mode` is REQUIRED (round-2 NEW-L3): a call site must state whose semantics it wants —
 * a silent 'github-app' default would hand App semantics (404 = not-installed) to a PAT
 * enterprise.
 */
export function classifyGithubHealthError(err: unknown, mode: CredentialKind): StageReason {
  const e = err as {
    code?: string
    message?: string
    name?: string
    issues?: unknown
    data?: { status?: number; detail?: string; type?: string }
  } | null

  // a. Fail-loud config errors (thrown synchronously by credentials.ts / app-auth ctor).
  if (err instanceof MissingGithubAppKeyError) return 'no-credential'
  const msg = String(e?.message ?? '')
  if (/^github-app-auth:/.test(msg)) return 'key-malformed'

  // a2. App-mode SAML externalIdentities PERMISSION denial (MEDIUM-1). The externalIdentities
  //     GraphQL POST answers 200 but carries GraphQL errors (FORBIDDEN / INSUFFICIENT_SCOPES) —
  //     the REAL shape of a missing "organization_administration: read" on the org install. The
  //     client stamps that a FIXED `github-saml` type; classify it the SAME as an HTTP 401/403
  //     (auth-failed, red + actionable) purely from that TYPE, never a body. This is safe against
  //     transient misclassification: a 429/5xx/egress on the same call is a NON-OK HTTP (a
  //     `github-upstream` envelope with an "HTTP <n>" status) or a raw transport throw — NOT a
  //     `github-saml` type — so those still fall through to their own transient buckets below.
  if (e?.data?.type === GITHUB_SAML_TYPE) return 'auth-failed'

  // b. The stage-deadline backstop sentinel (withDeadline). NOT an egress claim — see the
  //    doc block; the tight fetch budget catches real black holes first.
  if (String(e?.code ?? '') === 'PROBE_WINDOW_EXCEEDED') return 'probe-window-exceeded'

  // c. Parse failures: res.json() on an HTML error page → SyntaxError; a drifted shape →
  //    ZodError. Checked BEFORE the egress regex (their messages carry arbitrary text).
  if (err instanceof SyntaxError || e?.name === 'ZodError' || Array.isArray(e?.issues)) {
    return 'upstream-error'
  }

  // d. The client's literal not-ready / report_day-mismatch fail surfaces. Both are thrown
  //    with the REQUEST's "HTTP 200" in detail — a transient generation gap, not an error
  //    status; matched BEFORE the status parse so 200 never lands in a wrong bucket (M1).
  const detail = String(e?.data?.detail ?? '')
  if (/report not ready|report_day .* != requested/.test(detail)) return 'not-ready'

  // e. EGRESS signatures — a network-layer throw never carries an HTTP status. The tight
  //    per-attempt budget's AbortSignal.timeout rejects with a DOMException named
  //    'TimeoutError' (verified: undici fetch rejects with the signal's abort reason);
  //    a plain abort is 'AbortError'. Both are genuine transport-level failures. Also
  //    inspect the node error code AND the message (undici wraps the cause;
  //    getaddrinfo/TLS land in text).
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'egress-blocked'
  const code = String(e?.code ?? '')
  const surface = `${code} ${msg}`
  if (/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|getaddrinfo|socket hang up|network|TLS|certificate|self[- ]signed|timed? ?out|aborted/i.test(surface)) {
    return 'egress-blocked'
  }

  // f. HTTP status. The GitHub client wraps EVERY upstream failure as a 502 createError whose
  //    data.status is 502 (the envelope) and whose data.detail carries "…returned HTTP <real>"
  //    — so the REAL upstream status must be parsed from detail FIRST; data.status (502) is
  //    only the fallback when detail has no "HTTP <n>" (a non-client error path).
  let status = NaN
  const m = /HTTP (\d{3})/.exec(detail)
  if (m) status = Number(m[1])
  if (!Number.isFinite(status) && typeof e?.data?.status === 'number') status = e.data.status
  if (Number.isFinite(status)) {
    if (status === 404) {
      // MODE-AWARE (M2): only an App has an "installation" to be missing. A PAT-mode 404 is
      // GitHub's way of hiding a resource from a PAT lacking scope/SSO authorisation.
      return mode === 'github-app' ? 'not-installed' : 'auth-failed'
    }
    if (status === 401 || status === 403) return 'auth-failed'
    if (status === 429) return 'rate-limited'
    if (status >= 500) return 'upstream-error'
  }
  // "no install" can also arrive without a parseable status (App mode only — a PAT-mode
  // client never calls the installation-lookup surface).
  if (mode === 'github-app' && /no install|not accessible/i.test(detail)) return 'not-installed'
  // g. Unclassifiable → transient upstream. NEVER default to an egress/auth claim (H1).
  return 'upstream-error'
}

// The createError `data.type`s the github-CLIENT stamps on a data-endpoint failure
// (github-client.ts fail() → github-upstream; the SAML GraphQL error → github-saml). The
// App-AUTH layer (install-lookup / token-mint) stamps a DIFFERENT type (…/github-app-upstream,
// github-app-auth.ts), so the two origins are distinguishable without ever reading a body.
const GITHUB_UPSTREAM_TYPE = 'https://tokenscope.example.com/errors/github-upstream'
const GITHUB_SAML_TYPE = 'https://tokenscope.example.com/errors/github-saml'

/*
 * Did this throw originate from the per-org externalIdentities ENDPOINT itself (a github-client
 * failure AFTER the ORG installation token was minted to reach the GraphQL call), as opposed to
 * the App-auth layer (install-lookup / token-mint, which throw a …/github-app-upstream envelope
 * or the 'installation (no install)' 404)?
 *
 * POSITIVE detection (fail-safe): true ONLY when we can PROVE the GraphQL endpoint was reached —
 * either a github-client `github-upstream` envelope whose surface is the externalIdentities call
 * (a non-OK HTTP on the POST), or a `github-saml` envelope (a 200 carrying GraphQL errors:
 * FORBIDDEN / INSUFFICIENT_SCOPES). Both are thrown only after the org installation token minted.
 * Everything we can't prove (an app-auth-typed error, a raw egress throw with no envelope, a parse
 * error, the no-install 404) stays false, so appAuth is only ever ✓ when the token demonstrably
 * minted. Couples to the fixed type/surface strings in github-client.ts; if renamed, the appAuth
 * line falls back to the safe ✗.
 */
export function isSamlEndpointError(err: unknown): boolean {
  const e = err as { data?: { type?: string; detail?: string } } | null
  const type = e?.data?.type
  if (type === GITHUB_SAML_TYPE) return true
  if (type === GITHUB_UPSTREAM_TYPE) return /externalIdentities/.test(String(e?.data?.detail ?? ''))
  return false
}

/*
 * The recent FINALIZED UTC probe day = today − 2 days. The current + prior UTC day may be
 * "not ready" (the App users-1-day report is generated asynchronously; the PAT ai_credit
 * day may still be settling), so we probe two days back where the day is reliably complete.
 */
export function githubProbeDay(now: Date): string {
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() - 2)
  return d.toISOString().slice(0, 10)
}

/*
 * Probe time budget (M4 / round-2 NEW-M1) — the TIGHTENED-BUDGET design:
 *
 *   1. PROBE_FETCH_OPTS — the probe's clients get a TIGHT per-attempt fetch budget
 *      (8 s timeout, 0 retries), threaded through GithubCopilotClient/GithubAppAuth's
 *      injectable fetch options. So:
 *        (a) a REAL silent-drop / black-holed egress fails FAST with a genuine transport
 *            error (AbortSignal.timeout → DOMException 'TimeoutError') → egress-blocked RED
 *            — the NSP headline case stays a fast, honest red;
 *        (b) a 429 surfaces IMMEDIATELY as HTTP 429 (retries=0 ⇒ no retry-after sleep to
 *            race) → rate-limited → upstream-transient AMBER — a long retry-after can no
 *            longer be misread as "egress blocked".
 *   2. STAGE_DEADLINE_MS — a 20 s per-stage BACKSTOP kept only for pathological cases
 *      (e.g. a huge multi-page externalIdentities / seats crawl). Because the tight budget already
 *      catches real black holes in ≤8 s, a backstop hit does NOT imply egress — it is
 *      classified 'probe-window-exceeded' → upstream-transient AMBER, never egress RED.
 *
 * The backstop abandons (does not abort) the underlying call — with the tight per-attempt
 * budget the abandoned socket dies within ~8 s anyway, so the churn is bounded (round-2
 * NEW-L2 acknowledged). Worst case: 2 network stages × 20 s ≪ the ~120 s gateway ceiling
 * (and L5 skips the second stage when the first failed egress-blocked/rate-limited).
 */
export const PROBE_FETCH_OPTS: ResilientFetchOptions = { timeoutMs: 8_000, retries: 0 }
const STAGE_DEADLINE_MS = 20_000

async function withDeadline<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gate = new Promise<never>((_, reject) => {
    // A DISTINCT sentinel (code, and a message that deliberately avoids the egress
    // signatures) — classifyGithubHealthError maps it to 'probe-window-exceeded' (amber),
    // NOT egress-blocked: with the tight fetch budget, real egress fails long before this.
    timer = setTimeout(
      () => reject(Object.assign(new Error(`github health probe: ${stage} exceeded the ${ms} ms probe window (backstop)`), { code: 'PROBE_WINDOW_EXCEEDED' })),
      ms,
    )
  })
  try {
    return await Promise.race([p, gate])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/*
 * The narrow read surface the health probe consumes. App mode uses listSamlIdentities for ONE
 * representative license org (the licenses stage) + getUserDailyCredits (metrics). PAT mode uses
 * listSeats (licenses) + getAiCreditUsage (metrics). Both are subsets of GithubCopilotClient —
 * the probe never mutates and never touches a billing WRITE.
 */
export interface HealthProbeClient {
  // App mode — identity via the per-org SAML externalIdentities read for ONE representative
  // license org (the App-blocked enterprise consumed-licenses endpoint is no longer probed).
  listSamlIdentities?: (org: string) => Promise<Array<{ login: string }>>
  // App mode — per-org Copilot seat-holders, used ONLY to pick a MEANINGFUL representative org
  // (a SEAT-BEARING one) for the externalIdentities read, never for the verdict itself (M2).
  listOrgCopilotSeats?: (org: string) => Promise<Array<{ login: string }>>
  getUserDailyCredits?: (day: string) => Promise<Array<{ login: string }>>
  // PAT mode
  listSeats?: () => Promise<Array<{ assignee: { login: string } }>>
  getAiCreditUsage?: (
    login: string,
    date: { year: number; month: number; day: number },
  ) => Promise<{ usageItems?: unknown[] }>
}

/** Build the real client for a resolved credential (App vs PAT). Overridable in tests. */
export type ProbeClientFactory = (args: {
  externalId: string
  kind: CredentialKind
  /** PAT value (PAT mode) or base64 PEM (App mode) — NEVER logged/returned by this module. */
  value: string
  appId?: string
}) => HealthProbeClient

const realProbeClient: ProbeClientFactory = ({ externalId, kind, value, appId }) => {
  if (kind === 'github-app') {
    // The GithubAppAuth ctor base64-decodes + asserts the PEM (fail-loud) — a bad key throws
    // here and is classified 'key-malformed' by the credential stage's catch. Its App-auth
    // calls (installation lookup + token mint) get the SAME tight budget via the injectable
    // fetch, so a black-holed auth surface also fails fast.
    const probeFetch: FetchLike = (url, init) => resilientFetch(url, init, PROBE_FETCH_OPTS)
    return GithubCopilotClient.withApp(
      externalId,
      new GithubAppAuth(appId!, value, probeFetch),
      PROBE_FETCH_OPTS,
    ) as HealthProbeClient
  }
  return GithubCopilotClient.withPat(externalId, value, PROBE_FETCH_OPTS) as HealthProbeClient
}

/*
 * App mode: ALL onboarded license orgs (provider_org, joined to its enterprise), deterministically
 * ordered. Empty ⇒ no license org onboarded yet (a legible amber config gap, not a hard failure).
 * The licenses stage picks a MEANINGFUL representative from this list (see
 * chooseRepresentativeLicenseOrg) rather than blindly probing the alphabetically-first — which on
 * some enterprises is a seatless test org (e.g. Insight-DI-NA-Test) whose empty externalIdentities
 * read can mask a real seat-bearing org silently dropping (M2). No LIMIT: the list is bounded by
 * the enterprise's onboarded orgs and consumed only on the on-demand Verify path.
 */
async function listOnboardedLicenseOrgs(db: Db, enterpriseRef: string): Promise<string[]> {
  const rows = await db.execute<{ org: string }>(sql`
    SELECT po.external_org_id AS org
    FROM provider_org po
    JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    WHERE po.provider = 'github' AND lower(pe.external_id) = lower(${enterpriseRef})
    ORDER BY po.external_org_id
  `)
  return rows.map((r) => r.org)
}

/*
 * App mode: choose the MEANINGFUL representative license org for the externalIdentities probe (M2).
 * `orgs` is the onboarded license orgs, already ORDER BY external_org_id, and is NON-EMPTY (the
 * caller renders no-license-orgs before calling here). Prefer a SEAT-BEARING org — iterate and
 * return the FIRST whose listOrgCopilotSeats is non-empty — so the probe reads an org that actually
 * has Copilot users, NOT a seatless test org that would silently read [] and mask a real drop.
 * Fallbacks preserve today's states:
 *   - a single onboarded org (or no per-org seat surface on the client) → that org directly, with
 *     NO extra call (the common single-org enterprise behaves exactly as before);
 *   - orgs onboarded but NONE seat-bearing (or none installed — listOrgCopilotSeats returns [] for
 *     an org the App isn't installed on) → the FIRST onboarded org, so a not-installed / count-0
 *     signal still surfaces on the licenses stage.
 * A per-org seat call that THROWS (egress / auth / the slow-backstop) is treated as NOT-confirmed-
 * seat-bearing and skipped; any genuine, systemic error re-surfaces on the CHOSEN org's classified
 * externalIdentities read, so the licenses stage stays the single source of the verdict. KEY-SAFE:
 * it reads only seat logins/counts and returns an org slug — never a secret. Bounded: each seat
 * call rides the tight per-attempt fetch budget + the per-stage deadline backstop.
 */
async function chooseRepresentativeLicenseOrg(
  client: HealthProbeClient,
  orgs: string[],
  deadlineMs: number,
  stage: string,
): Promise<string> {
  const first = orgs[0]! // caller guarantees a non-empty list
  if (orgs.length === 1 || !client.listOrgCopilotSeats) return first
  for (const org of orgs) {
    try {
      const seats = await withDeadline(client.listOrgCopilotSeats(org), deadlineMs, stage)
      if (seats.length > 0) return org
    } catch {
      // Not confirmed seat-bearing — skip this org. A real systemic failure (egress/auth) will
      // re-surface on the chosen org's externalIdentities read below and classify there.
    }
  }
  return first // none seat-bearing → the first onboarded org (count-0 / not-installed still surface)
}

export interface ComputeGithubHealthOpts {
  /** Reference clock for the probe day. Defaults to now. */
  now?: Date
  /** Resolve the enterprise credential. Defaults to resolveEnterpriseCredential. */
  resolveCredential?: typeof resolveEnterpriseCredential
  /** Build the probe client. Defaults to the real App/PAT client. */
  probeClient?: ProbeClientFactory
  /** login(lowercased) → teammateId roster. Defaults to resolveGithubRoster. */
  resolveRoster?: (db: Db, enterpriseRef: string) => Promise<Map<string, string>>
  /** login(lowercased) → claimant email, for logins bound ONLY by a self-claim. Defaults to
   *  resolveGithubSelfOnlyLogins (the same read the Unresolved Copilot users queue uses). */
  resolveSelfOnly?: (db: Db, enterpriseRef: string) => Promise<Map<string, string>>
  /** App mode: resolve ALL onboarded license orgs (provider_org), deterministically ordered. The
   *  licenses stage picks a seat-bearing representative from these (chooseRepresentativeLicenseOrg)
   *  for its externalIdentities read. Defaults to the provider_org query. Empty ⇒ no orgs onboarded. */
  resolveLicenseOrgs?: (db: Db, enterpriseRef: string) => Promise<string[]>
  /** Per-network-stage deadline in ms (M4). Defaults to STAGE_DEADLINE_MS. */
  stageDeadlineMs?: number
}

/*
 * Compute health for ONE github enterprise. NEVER throws (every stage is caught) and NEVER
 * leaks a secret. The stage ladder:
 *
 *   1. credential  — resolveEnterpriseCredential. Absent / App key missing → no-credential.
 *                    App mode: the client build (GithubAppAuth ctor) base64-decodes + asserts
 *                    the PEM; a malformed key throws here → key-malformed. Any OTHER throw
 *                    (e.g. the DB read died) is OUR infrastructure, not the pipeline →
 *                    probe-error (M3b — infra must never impersonate a config verdict).
 *   2. roster      — the identity-map DB read. A failure here → probe-error (M3a — an empty
 *                    map would fabricate a 'no-teammate-match').
 *   3. appAuth     — (App mode only) exercised by the licenses call's installation lookup +
 *                    token mint; its verdict is derived from that attempt.
 *   4. licenses    — App: listSamlIdentities for ONE representative onboarded license org
 *                    (externalIdentities); PAT: listSeats. ok → count + rosterMatched. App mode
 *                    with NO license org onboarded (provider_org) → no-license-orgs (amber gap).
 *   5. metrics     — getUserDailyCredits(probeDay) (App) / getAiCreditUsage(login, day) for
 *                    ONE roster-matched login (PAT). SKIPPED — marked, never faked (L2) —
 *                    when there is no matched login to read, or when licenses already failed
 *                    with a doomed egress/rate-limit reason (L5).
 *   6. verdict     — synthesised (see synthesiseVerdict).
 */
export async function computeGithubEnterpriseHealthStages(
  db: Db,
  ent: GithubEnterpriseRow,
  opts: ComputeGithubHealthOpts = {},
): Promise<Omit<GithubEnterpriseHealth, 'coverage'>> {
  const now = opts.now ?? new Date()
  const resolveCredential = opts.resolveCredential ?? resolveEnterpriseCredential
  const buildClient = opts.probeClient ?? realProbeClient
  const rosterReader = opts.resolveRoster ?? resolveGithubRoster
  const selfOnlyReader = opts.resolveSelfOnly ?? resolveGithubSelfOnlyLogins
  const licenseOrgsReader = opts.resolveLicenseOrgs ?? listOnboardedLicenseOrgs
  const deadlineMs = opts.stageDeadlineMs ?? STAGE_DEADLINE_MS
  const probeDay = githubProbeDay(now)

  // A non-App enterprise is PAT-kind unless it opts into App mode (github_app_id set).
  const appMode = !!ent.githubAppId?.trim()
  const credentialKind: CredentialKind = appMode ? 'github-app' : 'github-pat'
  const classify = (err: unknown) => classifyGithubHealthError(err, credentialKind)

  const base = {
    enterpriseId: ent.enterpriseId,
    externalId: ent.externalId,
    credentialKind,
    probeDay,
  }
  /*
   * Pre-probe short-circuit. `credentialOk` (round-2 NEW-L1) attributes the failure to the
   * CORRECT stage: a roster/infra failure AFTER the credential resolved must not paint the
   * credential stage ✗ — the modal's failure marker lands where the failure actually was.
   */
  const preProbe = (reason: StageReason, keyPresent: boolean, credentialOk = false): Omit<GithubEnterpriseHealth, 'coverage'> => {
    const verdict = verdictForReason(reason)
    return {
      ...base,
      keyPresent,
      stages: {
        credential: credentialOk ? { ok: true } : { ok: false, reason },
        licenses: { ok: false, reason },
        metrics: { ok: false, reason },
      },
      verdict,
      color: colorFor(verdict),
    }
  }

  // ── Stage 1: credential ─────────────────────────────────────────────────────
  let client: HealthProbeClient
  try {
    const credential = await resolveCredential(db, { provider: 'github', externalId: ent.externalId })
    if (!credential) return preProbe('no-credential', false)
    // Build the client. In App mode the GithubAppAuth ctor decodes + asserts the PEM, so a
    // malformed key throws HERE — caught below and classified key-malformed.
    client = buildClient({ externalId: ent.externalId, kind: credentialKind, value: credential.value, appId: credential.appId })
  } catch (err) {
    // Distinguish the three stage-1 failure classes EXPLICITLY (M3b):
    //   - MissingGithubAppKeyError: App mode intended, key not wired → no-credential (config).
    //   - 'github-app-auth: …': the wired key won't decode/parse → key-malformed (config;
    //     the key WAS present — it resolved — so keyPresent true).
    //   - anything else (e.g. the DB read died): OUR infrastructure → probe-error. It must
    //     NOT impersonate a config verdict; keyPresent is unknown → reported false alongside
    //     the DISTINCT probe-error verdict so it can't read as "key missing".
    if (err instanceof MissingGithubAppKeyError) return preProbe('no-credential', false)
    if (/^github-app-auth:/.test(String((err as Error)?.message ?? ''))) return preProbe('key-malformed', true)
    return preProbe('probe-internal-error', false)
  }

  // ── Stage 2: roster (identity-map DB read) ──────────────────────────────────
  // A failure here is OUR side, not the provider's. Swallowing it to an empty map would
  // fabricate a 'no-teammate-match' verdict (M3a) — return a distinct probe-error instead.
  // credentialOk=true (NEW-L1): the credential DID resolve — the ✗ belongs to the later
  // stages, not the credential line.
  let roster: Map<string, string>
  let selfOnly: Map<string, string>
  try {
    roster = await rosterReader(db, ent.externalId)
    selfOnly = await selfOnlyReader(db, ent.externalId)
  } catch {
    return preProbe('probe-internal-error', true, true)
  }
  // "Matched" means verified (#451): a login the roster resolves only through the teammate's own
  // claim is not trusted for the billed split, so it is reported separately, never as matched.
  // The full roster still picks the PAT metrics probe login: any bound login proves the read.
  const verified = new Map([...roster].filter(([login]) => !selfOnly.has(login)))

  const stages: GithubEnterpriseHealth['stages'] = {
    credential: { ok: true },
    licenses: { ok: false },
    metrics: { ok: false },
  }
  if (appMode) stages.appAuth = { ok: false }

  // ── Stage 4: licenses (App: per-org externalIdentities; PAT: seats) ─────────
  // The first authenticated call also EXERCISES appAuth (App mode). On FAILURE we attribute by
  // error ORIGIN rather than folding the licenses failure onto appAuth: a github-client endpoint
  // error (the externalIdentities GraphQL was reached) proves the ORG installation token WAS
  // minted → appAuth ✓, the ✗ lands ONLY on licenses; a genuine App-auth failure (install-lookup
  // / token-mint / no-install 404) → appAuth ✗.
  let matchedLogins: string[] = []
  if (appMode) {
    // App-mode identity is now the per-org SAML externalIdentities read (the disproven enterprise
    // consumed-licenses endpoint is App-blocked for install tokens). Probe ONE representative
    // onboarded license org — the same surface the identity resolver bridges per org.
    let orgs: string[] = []
    let orgReadFailed = false
    try {
      orgs = await licenseOrgsReader(db, ent.externalId)
    } catch {
      orgReadFailed = true // OUR provider_org read died → infra, not the pipeline (M3)
    }
    if (orgReadFailed) {
      stages.appAuth = { ok: false, reason: 'probe-internal-error' }
      stages.licenses = { ok: false, reason: 'probe-internal-error' }
    } else if (orgs.length === 0) {
      // App wired but no license org onboarded (provider_org) — an actionable AMBER config gap,
      // not a hard red: nothing is broken, the admin just needs to onboard a license org.
      stages.appAuth = { ok: false, reason: 'no-license-orgs' }
      stages.licenses = { ok: false, reason: 'no-license-orgs' }
    } else {
      // Pick a MEANINGFUL representative — a SEAT-BEARING org where possible — not the
      // alphabetically-first, which may be a seatless test org that masks a real drop (M2).
      const probeOrg = await chooseRepresentativeLicenseOrg(client, orgs, deadlineMs, 'org-seats')
      try {
        const logins = (await withDeadline(client.listSamlIdentities!(probeOrg), deadlineMs, 'externalIdentities')).map((i) => i.login)
        stages.appAuth = { ok: true }
        stages.licenses = { ok: true, count: logins.length, rosterMatched: countMatched(logins, verified), selfClaimed: countMatched(logins, selfOnly) }
        matchedLogins = logins.filter((l) => roster.has(l.toLowerCase()))
      } catch (err) {
        const reason = classify(err)
        const endpointReached = isSamlEndpointError(err)
        stages.appAuth = endpointReached ? { ok: true } : { ok: false, reason }
        stages.licenses = { ok: false, reason }
        // Actionable, key-safe remediation: an App-mode externalIdentities ENDPOINT auth denial is
        // the org "organization_administration: read" gap. Endpoint-only (an app-auth 403 is not an
        // org-admin-read gap).
        if (endpointReached && reason === 'auth-failed') stages.licenses.hint = 'org-admin-read-denied'
      }
    }
  } else {
    try {
      const logins = (await withDeadline(client.listSeats!(), deadlineMs, 'seats')).map((s) => s.assignee.login)
      stages.licenses = { ok: true, count: logins.length, rosterMatched: countMatched(logins, verified), selfClaimed: countMatched(logins, selfOnly) }
      matchedLogins = logins.filter((l) => roster.has(l.toLowerCase()))
    } catch (err) {
      stages.licenses = { ok: false, reason: classify(err) }
    }
  }

  // ── Stage 5: metrics (App: users-1-day; PAT: ai_credit/usage for one matched login) ──
  // Probe a RECENT FINALIZED day (today − 2). App mode returns per-user records for the whole
  // enterprise in one call; PAT mode reads ONE roster-matched login's day — recordCount is
  // what the read ACTUALLY returned (usageItems length), matchedRecords the same (every item
  // belongs to the roster-matched probe login). A single-login PAT probe is a deliberately
  // WEAK-but-cheap signal (round-2 NEW-L4 acknowledged): it proves the billing surface is
  // reachable+authed, not that every seat's usage flows — an idle probe login reads as
  // metrics-empty amber, which is honest for "nothing to attribute that day".
  const date = { year: Number(probeDay.slice(0, 4)), month: Number(probeDay.slice(5, 7)), day: Number(probeDay.slice(8, 10)) }
  if (
    !stages.licenses.ok &&
    (stages.licenses.reason === 'egress-blocked' ||
      stages.licenses.reason === 'rate-limited' ||
      stages.licenses.reason === 'no-license-orgs' ||
      stages.licenses.reason === 'probe-internal-error')
  ) {
    // Skip metrics — marked, never faked (L2/L5):
    //   - egress-blocked / rate-limited: the metrics call rides the same connection/rate budget,
    //     so it is doomed; don't fire a second call that can only burn the rate limit / park on
    //     the same black hole.
    //   - no-license-orgs / probe-internal-error: structural/infra breaks BEFORE any GitHub
    //     identity read — the metrics correlation is meaningless, so don't fire it.
    stages.metrics = { ok: false, skipped: true, reason: stages.licenses.reason }
  } else {
    try {
      if (appMode) {
        const rows = await withDeadline(client.getUserDailyCredits!(probeDay), deadlineMs, 'users-1-day')
        const logins = rows.map((r) => r.login)
        stages.metrics = { ok: true, recordCount: logins.length, matchedRecords: countMatched(logins, verified) }
      } else {
        // A verified login first, so matchedRecords counts only what a verified binding attributes.
        const probeLogin = matchedLogins.find((l) => verified.has(l.toLowerCase())) ?? matchedLogins[0]
        if (probeLogin) {
          const usage = await withDeadline(client.getAiCreditUsage!(probeLogin, date), deadlineMs, 'ai_credit/usage')
          // Honest counts (L2): what the read ACTUALLY returned for the probed (login, day).
          // Zero items = the probed login had no usage that day → metrics-empty (amber).
          const n = Array.isArray(usage?.usageItems) ? usage.usageItems.length : 0
          stages.metrics = { ok: true, recordCount: n, matchedRecords: verified.has(probeLogin.toLowerCase()) ? n : 0 }
        } else {
          // No roster-matched login to read → SKIPPED, never a fabricated read (L2). The
          // verdict synthesis derives no-teammate-match/metrics-empty from licenses instead.
          stages.metrics = { ok: stages.licenses.ok, skipped: true, reason: stages.licenses.ok ? undefined : stages.licenses.reason }
        }
      }
    } catch (err) {
      stages.metrics = { ok: false, reason: classify(err) }
    }
  }

  const verdict = synthesiseVerdict(stages)
  return { ...base, keyPresent: true, stages, verdict, color: colorFor(verdict) }
}

/** A stage-level result whose coverage read itself failed (a bug in this module, not
 *  the pipeline) — never impersonates a real coverage claim. */
const COVERAGE_STAGE_UNREADABLE: CoverageStage = {
  available: false,
  capped: false,
  reason: null,
  denominator: null,
  connected: 0,
  nonConnected: 0,
  stale: false,
  observedAt: null,
}

/** Read the persisted coverage observation and project it into the Verify-ladder's
 *  cheap CoverageStage shape. Never throws — a read failure degrades to the
 *  unreadable sentinel above rather than crashing the whole Verify probe over a
 *  problem in an ADDITIONAL, independent stage. */
async function loadCoverageStage(db: Db, enterpriseId: string): Promise<CoverageStage> {
  try {
    const persisted = await loadPersistedEnterpriseCoverage(db, enterpriseId)
    const nonConnectedCount = persisted.orgs.filter((o) => o.state !== 'connected').length
    const connectedCount = persisted.orgs.filter((o) => o.state === 'connected').length
    return {
      available: persisted.census.available,
      capped: persisted.census.capped,
      reason: persisted.census.reason,
      denominator: persisted.census.available && !persisted.census.capped ? persisted.census.orgCount : null,
      connected: connectedCount,
      nonConnected: nonConnectedCount,
      stale: persisted.census.stale,
      observedAt: persisted.census.observedAt,
    }
  } catch {
    return COVERAGE_STAGE_UNREADABLE
  }
}

/*
 * Compute health for ONE github enterprise, INCLUDING the coverage stage (Workstream
 * D). Thin wrapper over computeGithubEnterpriseHealthStages (the original ladder,
 * unchanged) — attaches a cheap, persisted-only coverage read (loadCoverageStage)
 * uniformly to EVERY outcome, including a probe that failed at an earlier stage:
 * coverage is an independent signal from whether the rest of the ladder succeeded, so
 * a credential/egress failure must not hide it (or vice versa).
 */
export async function computeGithubEnterpriseHealth(
  db: Db,
  ent: GithubEnterpriseRow,
  opts: ComputeGithubHealthOpts = {},
): Promise<GithubEnterpriseHealth> {
  const [stages, coverage] = await Promise.all([
    computeGithubEnterpriseHealthStages(db, ent, opts),
    loadCoverageStage(db, ent.enterpriseId),
  ])
  return { ...stages, coverage }
}

/** How many of `logins` (case-insensitively) map to a teammate in the roster. */
function countMatched(logins: string[], roster: Map<string, string>): number {
  let n = 0
  for (const l of logins) if (roster.has(l.toLowerCase())) n++
  return n
}

/** Map a failing stage's reason to the overall verdict (shared by every stage). */
function verdictForReason(reason: StageReason | undefined): GithubVerdict {
  switch (reason) {
    case 'no-credential':
      return 'no-credential'
    case 'key-malformed':
      return 'key-malformed'
    case 'not-installed':
      return 'not-installed'
    case 'auth-failed':
      return 'auth-failed'
    case 'egress-blocked':
      return 'egress-blocked'
    case 'no-license-orgs':
      return 'no-license-orgs'
    case 'probe-internal-error':
      return 'probe-error'
    default:
      // rate-limited / not-ready / upstream-error / probe-window-exceeded / unclassifiable:
      // GitHub is answering (or half-answering / pathologically slow) — a TRANSIENT upstream
      // state, NEVER an egress/auth claim (H1; backstop re-pointing per round-2 NEW-M1).
      return 'upstream-transient'
  }
}

/*
 * Synthesise the overall verdict from the classified stages. Order (most-specific first):
 *   - a failure in an EARLY stage names the break point (no-credential / key-malformed /
 *     not-installed / auth-failed / egress-blocked / probe-error / upstream-transient);
 *   - metrics ok + records + matches → healthy;
 *   - metrics ok + records + NO matches → no-teammate-match (the identity map is the gap);
 *   - metrics ok + zero records → metrics-empty (reachable + authed, but nothing came back);
 *   - metrics SKIPPED-but-ok (PAT, no roster-matched login): derive the same two verdicts
 *     from the licenses stage (seats>0 + none matched → no-teammate-match; no seats →
 *     metrics-empty).
 */
export function synthesiseVerdict(stages: GithubEnterpriseHealth['stages']): GithubVerdict {
  // Early structural breaks (credential → appAuth → licenses) name the break point.
  for (const s of [stages.credential, stages.appAuth, stages.licenses]) {
    if (s && !s.ok) return verdictForReason(s.reason)
  }
  const m = stages.metrics
  if (!m.ok) return verdictForReason(m.reason)
  if (m.skipped) {
    const lic = stages.licenses
    if ((lic.count ?? 0) > 0 && (lic.rosterMatched ?? 0) === 0) return 'no-teammate-match'
    return 'metrics-empty'
  }
  if ((m.recordCount ?? 0) === 0) return 'metrics-empty'
  if ((m.matchedRecords ?? 0) === 0) return 'no-teammate-match'
  return 'healthy'
}

/*
 * Verdict → RAG colour.
 *   green : healthy.
 *   amber : NOT a confirmed pipeline break —
 *           - metrics-empty / no-teammate-match: reachable + authed but incomplete
 *             (actionable data/identity gaps);
 *           - no-license-orgs: App mode wired but no license org onboarded (provider_org) —
 *             an actionable config gap, nothing is broken;
 *           - upstream-transient: GitHub is rate-limiting / 5xx-ing / report-not-ready /
 *             pathologically slow (probe-window backstop) — retry later; nothing on OUR
 *             side is proven broken (H1 / NEW-M1);
 *           - probe-error: the PROBE itself failed (our DB/infra) — retry / check the app;
 *             says nothing about the reconciliation pipeline (M3).
 *   red   : a hard, structural break — no-credential / key-malformed / not-installed /
 *           auth-failed / egress-blocked.
 */
export function colorFor(verdict: GithubVerdict): HealthColor {
  if (verdict === 'healthy') return 'green'
  if (
    verdict === 'metrics-empty' ||
    verdict === 'no-teammate-match' ||
    verdict === 'no-license-orgs' ||
    verdict === 'upstream-transient' ||
    verdict === 'probe-error'
  ) {
    return 'amber'
  }
  return 'red'
}
