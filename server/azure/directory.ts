/*
 * Entra directory client — the people-picker behind admin teammate
 * provisioning.
 *
 * The `tokenattribution-dev` app registration already holds Microsoft Graph
 * `User.Read.All` (Application, admin-consented for Insight) and is the SAME
 * confidential client that runs OIDC sign-in. So we mint an APP-ONLY Graph
 * token via the client-credentials grant using the OIDC client id/secret that
 * Bicep already wires into the container — no new secret, no new consent.
 *
 * App-only (client-credentials) is correct here: a people-picker reads the
 * whole directory, not "the signed-in user's view", and runs server-side on
 * an admin request. The Graph token never reaches the browser.
 *
 * Modes (NUXT_GRAPH_DIRECTORY_MODE):
 *   - 'graph' → real: client-credentials token + Graph /users query. Needs the
 *               OIDC client id/secret/token-url present (sandbox/prod).
 *   - else    → deterministic MOCK directory (local dev + tests, off-Azure).
 *               Mirrors the obo.ts mock seam so the full provision flow runs
 *               without Entra.
 *
 * Security: callers MUST treat the directory as the source of truth for a
 * teammate's identity. The provision endpoint re-resolves the picked oid via
 * getDirectoryUserByOid() rather than trusting the client-supplied email /
 * display name (which would be spoofable).
 */
import { resilientFetch, DeadlinePassedError, abortReason } from '../utils/resilient-fetch'

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'

/** Per-attempt bound on the token mint and every Graph call (an unbounded fetch
 *  hangs on a black-holed endpoint). */
export const GRAPH_TIMEOUT_MS = 10_000

/** Retries a WORKER's Graph call gets (network error, 5xx, 429 + Retry-After). */
export const WORKER_GRAPH_RETRIES = 2

/**
 * How one Graph call is transported. The default — no options — is ONE attempt:
 * that is what request handlers and sign-in get, so a person waiting on a page
 * is never parked behind a backoff. Workers pass `retries` and their run
 * `deadline` (epoch ms), past which no attempt and no wait is started.
 * `signal` cancels the call outright, including its wait on the token mint.
 */
export interface GraphCallOptions {
  retries?: number
  deadline?: number
  signal?: AbortSignal
}

/** A non-2xx Graph (or token-endpoint) answer. The message keeps the `(status)`
 *  shape callers match on. */
export class GraphHttpError extends Error {
  constructor(
    readonly status: number,
    /** The Graph path, or 'token' for the client-credentials mint. */
    readonly path: string,
    message = `Graph request failed (${status}) for ${path}.`,
  ) {
    super(message)
    this.name = 'GraphHttpError'
  }
}

/**
 * A failure that says nothing about the person being looked up — retrying later
 * may succeed: a 429 or 5xx (from Graph or the token endpoint), a network error,
 * a per-attempt timeout or abort, or the caller's deadline having passed. Every
 * other failure (a 4xx, a configuration error, a bug, a failed database write)
 * is permanent as far as a retry queue is concerned.
 */
export function isTransientGraphFailure(err: unknown): boolean {
  if (err instanceof GraphHttpError) return err.status === 429 || err.status >= 500
  if (err instanceof DeadlinePassedError) return true
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  if (name === 'TimeoutError' || name === 'AbortError') return true
  // undici reports every network-layer failure as TypeError('fetch failed').
  return err instanceof TypeError && err.message === 'fetch failed'
}

// A 404 from the TOKEN endpoint is a misconfigured mint, never "this person is
// not in the directory": reading it as absence would place every identity on the
// global bucket.
const isGraphNotFound = (err: unknown): boolean =>
  err instanceof GraphHttpError && err.status === 404 && err.path !== 'token'

function transport(call: GraphCallOptions) {
  return { timeoutMs: GRAPH_TIMEOUT_MS, retries: call.retries ?? 0, deadline: call.deadline, signal: call.signal }
}

/*
 * The token mint's transport, fixed and independent of any caller. The mint is
 * shared (single-flight below): every concurrent caller awaits the one request,
 * so it must not carry the first caller's deadline or retry count. A caller's
 * signal ends only that caller's wait; the request is cancelled when no caller
 * is still waiting on it.
 */
const MINT_TRANSPORT = { timeoutMs: GRAPH_TIMEOUT_MS, retries: 1 }

function graphBaseUrl(): string {
  return process.env.NUXT_GRAPH_BASE_URL?.replace(/\/$/, '') ?? 'https://graph.microsoft.com/v1.0'
}

// Read mode at call time (not module load) so tests can flip it per-case —
// same pattern as obo.ts / jit-teammate.ts.
function isRealGraph(): boolean {
  return process.env.NUXT_GRAPH_DIRECTORY_MODE === 'graph'
}

export interface DirectoryUser {
  oid: string
  email: string
  displayName: string
  // Identity PROVENANCE (issue #121): `email` collapses mail??upn, which erases
  // the distinction consumers need for same-human decisions. Entra guarantees
  // uniqueness per-namespace (UPNs among UPNs, proxy addresses among proxy
  // addresses) but NOT across them — user A's UPN may equal user B's mail. So
  // "same mailbox = same human" reasoning must compare TRUE mail to TRUE mail,
  // never the collapsed field. Both normalized lowercase; mail is null when the
  // account has no mail attribute.
  mail: string | null
  upn: string | null
  department: string | null
  jobTitle: string | null
  // Geo/entity attributes for configurable region derivation (mig 0089). Any of
  // these can drive a region rule (shared/placement/region-attributes.ts); which
  // one is region-correlated is tenant-specific (companyName at Insight).
  companyName: string | null
  country: string | null
  officeLocation: string | null
  state: string | null
  // J4: Entra employeeOrgData — the finance-side placement hints. Soft
  // dependency: whether the tenant POPULATES these is unverified (see
  // docs/design/entra-auto-placement.md), so they are suggestion-grade,
  // surfaced in the people-picker, never used for automatic placement.
  costCenter: string | null
  division: string | null
}

// ── App-only token cache (one shared token; app-level, like obo.ts) ──
const REFRESH_SKEW_MS = 5 * 60 * 1000
type MintedToken = { token: string; expiresAtMs: number }
interface InFlightMint {
  promise: Promise<MintedToken>
  controller: AbortController
  waiters: number
}
let cached: MintedToken | null = null
let inFlight: InFlightMint | null = null

/** Test seam — reset the token cache. */
export function _resetGraphTokenCache(): void {
  cached = null
  inFlight = null
}

function jwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

async function mintGraphToken(signal: AbortSignal): Promise<MintedToken> {
  const clientId = process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
  const clientSecret = process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
  const tokenUrl = process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      'Graph directory in real mode needs NUXT_OIDC_PROVIDERS_ENTRA_{CLIENT_ID,CLIENT_SECRET,TOKEN_URL}.',
    )
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  })
  const res = await resilientFetch(
    tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
    { ...MINT_TRANSPORT, signal },
  )
  if (!res.ok) {
    // Don't leak the response body (may echo client_id); surface status only.
    throw new GraphHttpError(res.status, 'token', `Graph client-credentials token mint failed (${res.status}).`)
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Graph token response had no access_token.')
  const expFromJwt = jwtExpMs(json.access_token)
  const expiresAtMs =
    expFromJwt ?? Date.now() + (json.expires_in ?? 3600) * 1000
  return { token: json.access_token, expiresAtMs }
}

async function getGraphToken(signal?: AbortSignal): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > now) return cached.token
  if (signal?.aborted) throw abortReason(signal)
  // Single-flight: collapse concurrent cold-start mints onto one request, sent
  // on MINT_TRANSPORT whoever started it.
  if (!inFlight) {
    const controller = new AbortController()
    const mint: InFlightMint = {
      controller,
      waiters: 0,
      promise: mintGraphToken(controller.signal).finally(() => {
        if (inFlight === mint) inFlight = null
      }),
    }
    // Every waiter may have left by the time it settles.
    mint.promise.catch(() => undefined)
    inFlight = mint
  }
  cached = await awaitMint(inFlight, signal)
  return cached.token
}

/** Wait on the shared mint until `signal` aborts; the last waiter to leave cancels it. */
function awaitMint(mint: InFlightMint, signal?: AbortSignal): Promise<MintedToken> {
  mint.waiters++
  return new Promise<MintedToken>((resolve, reject) => {
    let left = false
    const onAbort = () => {
      left = true
      if (--mint.waiters === 0) {
        mint.controller.abort(signal!.reason)
        if (inFlight === mint) inFlight = null
      }
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = () => {
      signal?.removeEventListener('abort', onAbort)
      if (!left) mint.waiters--
    }
    mint.promise.then(
      (v) => {
        settle()
        resolve(v)
      },
      (err: unknown) => {
        settle()
        reject(err)
      },
    )
  })
}

async function graphGet<T>(
  path: string,
  search: URLSearchParams,
  advanced = false,
  call: GraphCallOptions = {},
): Promise<T> {
  const token = await getGraphToken(call.signal)
  const url = `${graphBaseUrl()}${path}?${search.toString()}`
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  // $search / $count on /users are advanced queries → ConsistencyLevel: eventual.
  if (advanced) headers['ConsistencyLevel'] = 'eventual'
  const res = await resilientFetch(url, { headers }, transport(call))
  if (!res.ok) throw new GraphHttpError(res.status, path)
  return (await res.json()) as T
}

interface GraphUser {
  id: string
  displayName: string | null
  mail: string | null
  userPrincipalName: string | null
  department: string | null
  jobTitle: string | null
  // Geo/entity attributes for region derivation — all standard v1.0 `User`
  // properties under the existing User.Read.All (no new scope).
  companyName: string | null
  country: string | null
  officeLocation: string | null
  state: string | null
  employeeOrgData?: { costCenter: string | null; division: string | null } | null
}

// The 4 geo/entity attributes ride the base select — they are standard, widely
// populated User props (unlike employeeOrgData). Per-field $select degradation
// (drop only an offending field vs the all-or-nothing latch below) is a noted
// fast-follow; risk is low because these are base User properties.
const SELECT_BASE =
  'id,displayName,mail,userPrincipalName,department,jobTitle,companyName,country,officeLocation,state'
// employeeOrgData (costCenter/division) rides User.Read.All on v1.0, but
// tenant population is unverified — and a tenant policy could reject the
// property in $select. Degrade once per process rather than failing the
// picker (see orgDataUnavailable below).
const SELECT_EXT = `${SELECT_BASE},employeeOrgData`
let orgDataUnavailable = false

/** Test seam — reset the employeeOrgData degradation latch. */
export function _resetOrgDataLatch(): void {
  orgDataUnavailable = false
}

/*
 * The employeeOrgData degradation every user read shares: a 400 while the
 * extended select is active is retried once on the base select, and the latch
 * is set only when that retry SUCCEEDS — that is what proves the property was
 * the problem. A 400 the base select also gets (a malformed filter, say) is the
 * request's own fault: it is rethrown and the latch stays unset, so one bad
 * request cannot strip the hints for the process lifetime. Transient errors
 * (throttle, 5xx, network) are never retried here and never latch. Without the
 * degradation a tenant that rejects the property would make every strict
 * (worker) lookup throw on every run.
 */
async function withSelectDegradation<T>(run: (select: string) => Promise<T>): Promise<T> {
  if (orgDataUnavailable) return await run(SELECT_BASE)
  try {
    return await run(SELECT_EXT)
  } catch (err) {
    if (!(err instanceof GraphHttpError) || err.status !== 400) throw err
    const out = await run(SELECT_BASE)
    orgDataUnavailable = true
    return out
  }
}

function toDirectoryUser(u: GraphUser): DirectoryUser {
  return {
    oid: u.id,
    // mail can be null for some accounts; UPN is the durable fallback.
    email: (u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
    mail: u.mail?.toLowerCase() ?? null,
    upn: u.userPrincipalName?.toLowerCase() ?? null,
    displayName: u.displayName ?? u.mail ?? u.userPrincipalName ?? u.id,
    department: u.department ?? null,
    jobTitle: u.jobTitle ?? null,
    companyName: u.companyName ?? null,
    country: u.country ?? null,
    officeLocation: u.officeLocation ?? null,
    state: u.state ?? null,
    costCenter: u.employeeOrgData?.costCenter ?? null,
    division: u.employeeOrgData?.division ?? null,
  }
}

// ── Mock directory (local dev + tests) ──────────────────────────────────
// A small deterministic roster so the picker + provision flow run off-Azure.
// Distinct from the 4 demo login personas so it's obvious these come from
// "the directory", not the seed.
//
// `userPrincipalName` mirrors the real Graph field so the #EXT# guest guard
// (searchDirectory / getDirectoryUserByMailOrUpn / getDirectoryUserByOid) is
// exercised in mock mode too — a B2B guest must be un-pickable everywhere.
type MockDirectoryUser = DirectoryUser & { userPrincipalName: string }
const MOCK_DIRECTORY: MockDirectoryUser[] = [
  { oid: 'dir-oid-0001', email: 'sasha.kumar@example.com', mail: 'sasha.kumar@example.com', upn: 'sasha.kumar@example.com', userPrincipalName: 'sasha.kumar@example.com', displayName: 'Sasha Kumar', department: 'APAC Digital', jobTitle: 'Senior Engineer', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  { oid: 'dir-oid-0002', email: 'tom.becker@example.com', mail: 'tom.becker@example.com', upn: 'tom.becker@example.com', userPrincipalName: 'tom.becker@example.com', displayName: 'Tom Becker', department: 'EMEA Data & AI', jobTitle: 'Engineer', companyName: 'Insight United Kingdom', country: 'United Kingdom', officeLocation: 'UK-London', state: null, costCenter: 'CC-2210 Data EMEA', division: 'Services' },
  { oid: 'dir-oid-0003', email: 'mei.lin@example.com', mail: 'mei.lin@example.com', upn: 'mei.lin@example.com', userPrincipalName: 'mei.lin@example.com', displayName: 'Mei Lin', department: 'APAC Digital', jobTitle: 'Practice Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  { oid: 'dir-oid-0004', email: 'carlos.ferreira@example.com', mail: 'carlos.ferreira@example.com', upn: 'carlos.ferreira@example.com', userPrincipalName: 'carlos.ferreira@example.com', displayName: 'Carlos Ferreira', department: 'US Cloud', jobTitle: 'Architect', companyName: 'Insight USA', country: 'United States', officeLocation: 'US-Chicago', state: null, costCenter: null, division: null },
  { oid: 'dir-oid-0005', email: 'nadia.haddad@example.com', mail: 'nadia.haddad@example.com', upn: 'nadia.haddad@example.com', userPrincipalName: 'nadia.haddad@example.com', displayName: 'Nadia Haddad', department: 'EMEA Data & AI', jobTitle: 'Engineering Manager', companyName: 'Insight United Kingdom', country: 'United Kingdom', officeLocation: 'UK-London', state: null, costCenter: 'CC-2210 Data EMEA', division: 'Services' },
  { oid: 'dir-oid-0006', email: 'james.oconnor@example.com', mail: 'james.oconnor@example.com', upn: 'james.oconnor@example.com', userPrincipalName: 'james.oconnor@example.com', displayName: "James O'Connor", department: 'APAC Digital', jobTitle: 'Engineer', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  // DUAL-IDENTITY PAIR (issue #121, the Rob O'Connor shape): one human with a
  // standard `@example.com` account (dir-oid-0007) AND a privileged/CLD account
  // (dir-oid-0007-cld) whose UPN is on the tenant `*.onmicrosoft.com` domain.
  // The CLD account is NOT spend-bearing; the directory-exclusion policy
  // (mig 0083) is what keeps it un-pickable — when an admin configures a pattern
  // like `*@contoso.onmicrosoft.com`. Out of the box (no patterns) BOTH
  // are pickable (fail-open). Exercised by the exclusion tests.
  { oid: 'dir-oid-0007', email: 'rio.tanaka@example.com', mail: 'rio.tanaka@example.com', upn: 'rio.tanaka@example.com', userPrincipalName: 'rio.tanaka@example.com', displayName: 'Rio Tanaka', department: 'APAC Cyber Security', jobTitle: 'Security Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4520 Cyber APAC', division: 'Services' },
  { oid: 'dir-oid-0007-cld', email: 'rtanaka-cld@contoso.onmicrosoft.com', mail: null, upn: 'rtanaka-cld@contoso.onmicrosoft.com', userPrincipalName: 'rtanaka-cld@contoso.onmicrosoft.com', displayName: 'Rio Tanaka (CLD)', department: 'APAC Cyber Security', jobTitle: 'Security Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4520 Cyber APAC', division: 'Services' },
  // A genuinely cloud-only real user whose ONLY identity is on the onmicrosoft
  // domain (no `@example.com` twin). Proves the portable default is EMPTY: with
  // no exclusion pattern configured this user stays pickable; a blanket
  // `*@*.onmicrosoft.com` default would wrongly exclude them (why we don't ship one).
  { oid: 'dir-oid-0008', email: 'kai.wong@contoso.onmicrosoft.com', mail: null, upn: 'kwong@contoso.onmicrosoft.com', userPrincipalName: 'kwong@contoso.onmicrosoft.com', displayName: 'Kai Wong', department: 'APAC Digital', jobTitle: 'Consultant', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: null, division: null },
  // A B2B GUEST (partner/client/vendor invited into the tenant): #EXT# UPN.
  // Must NEVER be pickable/provisionable as a teammate.
  { oid: 'dir-oid-9001', email: 'partner@vendor.example', mail: 'partner@vendor.example', upn: 'partner_vendor.example#ext#@contoso.onmicrosoft.com', userPrincipalName: 'partner_vendor.example#EXT#@contoso.onmicrosoft.com', displayName: 'Partner Guest', department: null, jobTitle: null, companyName: null, country: null, officeLocation: null, state: null, costCenter: null, division: null },
]

const isGuestUpn = (upn: string | null | undefined): boolean => (upn ?? '').toUpperCase().includes('#EXT#')

function mockSearch(query: string, limit: number): DirectoryUser[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return MOCK_DIRECTORY.filter(
    (u) => !isGuestUpn(u.userPrincipalName) && (u.displayName.toLowerCase().includes(q) || u.email.includes(q)),
  ).slice(0, limit)
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Search the directory by name or email. Returns up to `limit` matches.
 * Empty/blank query → []. The query is treated as a free-text prefix/substring;
 * in real mode it drives Graph $search over displayName + mail.
 */
export async function searchDirectory(query: string, limit = 15): Promise<DirectoryUser[]> {
  const q = query.trim()
  if (!q) return []
  if (!isRealGraph()) return mockSearch(q, limit)

  // $search wants quoted phrases; strip embedded quotes and backslashes (Graph's
  // escape character, so a trailing one would escape the closing quote) so the
  // term cannot break out of the search expression.
  const safe = q.replace(/["\\]/g, '')
  const mkParams = (select: string) =>
    new URLSearchParams({
      $search: `"displayName:${safe}" OR "mail:${safe}"`,
      $select: select,
      $top: String(Math.min(Math.max(limit, 1), 50)),
    })
  // Exclude B2B GUEST accounts (#EXT# UPNs). The people-picker assigns Insight
  // region leaders / cost-centre owners / teammates — all EMPLOYEES — so a
  // partner/client/vendor guest invited into the tenant directory must never be
  // pickable. Mirrors the guest guard in getDirectoryUserByMailOrUpn (M1).
  const employeesOnly = (rows: GraphUser[]) =>
    rows.filter((u) => !(u.userPrincipalName ?? '').toUpperCase().includes('#EXT#'))
  // employeeOrgData being REJECTED (a 400 — tenant policy / property not
  // permitted in $select) must not break the picker; see withSelectDegradation.
  const json = await withSelectDegradation((select) =>
    graphGet<{ value: GraphUser[] }>('/users', mkParams(select), true),
  )
  return employeesOnly(json.value ?? []).map(toDirectoryUser)
}

/**
 * Resolve a single directory user by EXACT email / UPN — for bill-driven placement,
 * which has an email (the provider-attested bill identity) but no oid. Requires
 * EXACTLY ONE non-guest match (M1, adversarial review): a fuzzy `searchDirectory`
 * could bind a bill (and someone's spend) to an alias / a guest (`#EXT#`) / a
 * displayName substring. 0 or >1 hits, or only a guest → null (caller leaves the
 * user unplaced, enriched only by the bill email — never a guessed identity).
 */
/**
 * Sample up to `limit` directory users for the region-attribute field-distribution
 * diagnostic. BEST-EFFORT, re-runnable, NOT a guaranteed-random sample — Graph
 * returns its default ordering, so on a large tenant the first page may skew.
 * Employees only (guests excluded). One page (no nextLink paging) — the diagnostic
 * is a directional "which attribute correlates to region", not a census.
 * TODO(fast-follow): per-field $select degradation.
 */
export async function sampleDirectoryUsers(limit = 200): Promise<DirectoryUser[]> {
  const top = Math.min(Math.max(limit, 1), 999)
  const notGuest = (u: GraphUser | MockDirectoryUser) =>
    !((u as { userPrincipalName?: string | null }).userPrincipalName ?? '').toUpperCase().includes('#EXT#')
  if (!isRealGraph()) return MOCK_DIRECTORY.filter(notGuest).slice(0, top)
  const json = await withSelectDegradation((select) =>
    graphGet<{ value: GraphUser[] }>('/users', new URLSearchParams({ $select: select, $top: String(top) })),
  )
  return (json.value ?? []).filter(notGuest).map(toDirectoryUser)
}

export async function getDirectoryUserByMailOrUpn(email: string): Promise<DirectoryUser | null> {
  // LENIENT: any Graph failure reads as "no match". Request handlers and sign-in
  // rely on that; a worker must use the strict variant below, where a failure is
  // not an absence.
  try {
    return await getDirectoryUserByMailOrUpnStrict(email)
  } catch {
    return null
  }
}

/**
 * The same lookup and the same decision, STRICT about failure: null only for a
 * real absence — a 404, or a 200 with zero, more than one, or only guest matches —
 * and a THROW on every other HTTP status and on a network error or timeout. For
 * workers, where reading a throttled Graph as "not in the directory" would place a
 * person on the global bucket.
 */
export async function getDirectoryUserByMailOrUpnStrict(
  email: string,
  call: GraphCallOptions = {},
): Promise<DirectoryUser | null> {
  const e = email.trim().toLowerCase()
  if (!e || !e.includes('@')) return null
  if (!isRealGraph()) {
    const hits = MOCK_DIRECTORY.filter((u) => u.email.toLowerCase() === e && !isGuestUpn(u.userPrincipalName))
    return hits.length === 1 ? hits[0]! : null
  }
  // Escape single quotes for the OData string literal (' → '').
  const lit = e.replace(/'/g, "''")
  const mkParams = (select: string) =>
    new URLSearchParams({
      $filter: `mail eq '${lit}' or userPrincipalName eq '${lit}'`,
      $select: select,
      $top: '2', // we only ever accept exactly 1; 2 lets us DETECT ambiguity
    })
  let json: { value: GraphUser[] }
  try {
    json = await withSelectDegradation((select) =>
      graphGet<{ value: GraphUser[] }>('/users', mkParams(select), true, call),
    )
  } catch (err) {
    if (isGraphNotFound(err)) return null
    throw err
  }
  const rows = (json.value ?? []).filter((u) => !(u.userPrincipalName ?? '').toUpperCase().includes('#EXT#'))
  return rows.length === 1 ? toDirectoryUser(rows[0]!) : null
}

// Mock manager edges (local dev + tests off-Azure): a small chain over MOCK_DIRECTORY
// so the manager-walk fallback can run without Entra. Sasha → Mei (lead) → Nadia (EM);
// James → Mei. Others have no manager (top of chart → null).
const MOCK_MANAGER_EDGES: Record<string, { oid: string; email: string }> = {
  'dir-oid-0001': { oid: 'dir-oid-0003', email: 'mei.lin@example.com' },
  'dir-oid-0006': { oid: 'dir-oid-0003', email: 'mei.lin@example.com' },
  'dir-oid-0003': { oid: 'dir-oid-0005', email: 'nadia.haddad@example.com' },
}

/**
 * Resolve a user's manager (mig 0068 region-derivation fallback): the `/users/{id}/manager`
 * navigation. Returns `{ oid, email, name }` or null at the top of the org chart / when the user
 * has no manager. Rides the SAME app-only `User.Read.All` (proven app-only on the Insight
 * tenant by AEUF). 404 → null (terminate the walk cleanly); ANY OTHER error PROPAGATES so
 * the caller aborts and retries next tick — a transient miss must never be cached as a
 * real top-of-chart null.
 */
export async function getUserManager(
  oid: string,
  call: GraphCallOptions = {},
): Promise<{ oid: string; email: string | null; name: string | null } | null> {
  if (!isRealGraph()) {
    const edge = MOCK_MANAGER_EDGES[oid]
    return edge ? { ...edge, name: null } : null
  }
  const search = new URLSearchParams({ $select: 'id,mail,userPrincipalName,displayName' })
  try {
    const u = await graphGet<{ id?: string; mail?: string | null; userPrincipalName?: string | null; displayName?: string | null }>(
      `/users/${encodeURIComponent(oid)}/manager`,
      search,
      false,
      call,
    )
    if (!u || !u.id) return null
    const email = (u.mail ?? u.userPrincipalName ?? '').toLowerCase() || null
    return { oid: u.id, email, name: u.displayName || null }
  } catch (err) {
    // 404 = no manager (top of chart) or user-not-found → null. Throttle / 5xx / network
    // PROPAGATE (per-user worker isolation retries) and are NEVER cached as a real miss.
    if (isGraphNotFound(err)) return null
    throw err
  }
}

/**
 * Resolve a single directory user by their Entra object id (oid). Returns null
 * if the oid isn't found. This is the SERVER-SIDE source of truth used when
 * provisioning a teammate — never trust a client-supplied email/displayName.
 *
 * Rejects B2B GUEST accounts (#EXT# UPNs) → null: a partner/client/vendor guest
 * invited into the tenant directory must never be pickable/provisionable as an
 * Insight teammate. Mirrors the guest guard in searchDirectory /
 * getDirectoryUserByMailOrUpn (M1), closing the oid→provision path too.
 */
export async function getDirectoryUserByOid(oid: string): Promise<DirectoryUser | null> {
  // LENIENT: a 404 (unknown oid) and a transient error both surface as null, so
  // the request handlers return a clean 404/422 rather than a 500.
  try {
    return await getDirectoryUserByOidStrict(oid)
  } catch {
    return null
  }
}

/**
 * The same lookup and the same decision, STRICT about failure: null only for a
 * 404 or a guest account; every other HTTP status, network error or timeout
 * THROWS. For workers, where "not in the directory" must never be a Graph outage.
 */
export async function getDirectoryUserByOidStrict(
  oid: string,
  call: GraphCallOptions = {},
): Promise<DirectoryUser | null> {
  if (!isRealGraph()) {
    const hit = MOCK_DIRECTORY.find((u) => u.oid === oid) ?? null
    return hit && !isGuestUpn(hit.userPrincipalName) ? hit : null
  }
  let u: GraphUser
  try {
    u = await withSelectDegradation((select) =>
      graphGet<GraphUser>(`/users/${encodeURIComponent(oid)}`, new URLSearchParams({ $select: select }), false, call),
    )
  } catch (err) {
    if (isGraphNotFound(err)) return null
    throw err
  }
  if (!u || !u.id) return null
  // Guest guard: treat an #EXT# UPN as not-found (callers 404/handle null).
  if (isGuestUpn(u.userPrincipalName)) return null
  return toDirectoryUser(u)
}
