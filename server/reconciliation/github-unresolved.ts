/*
 * Unresolved Copilot login discovery (identity-tail layer 3) — the engine behind the admin
 * "Unresolved Copilot users" surface (server/api/v1/admin/reconciliation/github/unresolved.get.ts).
 *
 * WHY A LIVE ROSTER READ, NOT A reconciliation_record QUERY:
 *   A github login with reconciled Copilot spend but NO teammate_identity_map row (either lane)
 *   is "unresolved". Such a login is NEVER persisted anywhere: the reconciliation adapter
 *   (github.ts pullPatBilling/pullAppMetrics) and both bill writers SKIP an unmapped login
 *   BEFORE writing reconciliation_record / actual_spend (`if (!teammateId) continue`). So the
 *   unresolved tail exists ONLY in the live provider roster — the SAME authoritative surface
 *   the reconciler and the health probe read (seats in PAT mode, the users-1-day metrics report
 *   in App mode). This module reads that roster, diffs it against teammate_identity_map (via the
 *   SAME resolveGithubRoster the reconciler uses — so "unresolved here" == "skipped there"), and
 *   returns the unmatched logins with the context the report carries.
 *
 * SAFETY: mirrors github-health.ts — this module NEVER returns or logs a PAT, App key, PEM,
 * installation token, or a raw provider error body. It returns only logins + numeric context.
 * The client + roster reader are INJECTABLE so the whole path unit-tests with mocks (no network,
 * no live GitHub). RBAC/audit live in the route + the map endpoint; this is a pure reader.
 */
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { resolveEnterpriseCredential } from './credentials'
import type { CredentialKind } from './credentials'
import { resolveGithubRoster, resolveGithubSelfOnlyLogins } from './adapters/github'
import { GithubCopilotClient } from './adapters/github-client'
import { GithubAppAuth } from './adapters/github-app-auth'
import type { GithubEnterpriseRow } from './github-health'
import { githubProbeDay } from './github-health'

// The resolver + roster reader use only db.execute(sql`…`), so this works on either the
// schema-typed getDb() handle OR the RLS-bound request tx (widened) — same as github-health.
type Db = PostgresJsDatabase<Record<string, unknown>>

/** One unresolved Copilot login + the context the live report carries (key-safe). */
export interface UnresolvedCopilotLogin {
  /** The github login, as the roster reports it (original casing). */
  login: string
  /** The seat's license org (PAT mode; from the seat roster). NULL in App mode (the metrics
   *  report carries no per-user license org). */
  licenseOrg: string | null
  /** AI-credit consumption for the probed day (App mode; from users-1-day). NULL in PAT mode
   *  (the seat roster carries no usage — pulling per-login usage would be N live calls). */
  credits: number | null
  /** The UTC day the App-mode credits figure is for (App mode only). */
  lastSeenDay: string | null
  /* SELF-ASSERTED github profile text (GET /users/{login}), for the map picker's benefit only.
   * NOT an identity source and never a basis for a bind: profile fields are user-editable, so
   * trusting them would be the claim-jacking vector the SAML-only resolver exists to avoid.
   * They spare an admin the trip to github.com to find out who a login belongs to. Null when
   * the profile is private, the field is unset, or the lookup failed - all common, all
   * non-fatal, and indistinguishable to the consumer by design (no field-level error surface
   * on a decoration). */
  profileName: string | null
  profileEmail: string | null
  /** Email of the teammate who self-claimed this login, when that is its only binding. The
   *  reconciler attributes its usage to them, but its billed overage stays Unallocated until an
   *  admin binds it. NULL for a login nobody has claimed. */
  selfClaimedBy: string | null
}

export interface UnresolvedCopilotResult {
  enterpriseId: string
  externalId: string
  credentialKind: CredentialKind
  /** The recent FINALIZED UTC day probed in App mode (today − 2). NULL in PAT mode. */
  probeDay: string | null
  /** The unresolved logins, deduped + sorted by login. */
  logins: UnresolvedCopilotLogin[]
}

/* The narrow read surface this module consumes — a subset of GithubCopilotClient, INJECTABLE
 * for tests. PAT mode: listSeats (the lane authority: login + license org). App mode: the
 * per-user users-1-day metrics report (login + ai_credits_used). Never mutates. */
export interface UnresolvedProbeClient {
  // PAT mode — the enterprise seat roster (login + license org).
  listSeats?: () => Promise<
    Array<{ assignee: { login: string }; organization?: { login: string } | null }>
  >
  // App mode — per-user daily AI-credit consumption for the whole enterprise on one day.
  getUserDailyCredits?: (day: string) => Promise<Array<{ login: string; credits: number }>>
  // Public profile decoration (optional — a client without it simply yields null hints).
  getUserProfile?: (login: string) => Promise<{ name: string | null; email: string | null } | null>
}

export type UnresolvedClientFactory = (args: {
  externalId: string
  kind: CredentialKind
  /** PAT value (PAT mode) or base64 PEM (App mode) — NEVER logged/returned by this module. */
  value: string
  appId?: string
}) => UnresolvedProbeClient

const realUnresolvedClient: UnresolvedClientFactory = ({ externalId, kind, value, appId }) => {
  if (kind === 'github-app') {
    return GithubCopilotClient.withApp(externalId, new GithubAppAuth(appId!, value)) as UnresolvedProbeClient
  }
  return GithubCopilotClient.withPat(externalId, value) as UnresolvedProbeClient
}

export class UnresolvedProbeError extends Error {
  constructor(
    /** A FIXED, key-safe reason bucket — never a provider body. */
    readonly reason: 'no-credential' | 'roster-unavailable' | 'probe-error',
    message: string,
  ) {
    super(message)
    this.name = 'UnresolvedProbeError'
  }
}

/* Max live profile lookups per probe (see the decoration pass). Bounds the page load on a
 * badly-unmapped enterprise; rows past it render without hints. */
const PROFILE_HINT_LIMIT = 25
/* In-flight profile lookups. Small: the enterprise credential is shared with the reconciler and
 * the profile API is rate-limited, so latency is bought a few calls at a time, not all at once. */
const PROFILE_HINT_CONCURRENCY = 5
/* Whole-pass budget for hint decoration. Past it the list returns with whatever it has. */
const PROFILE_HINT_DEADLINE_MS = 4_000

export interface ListUnresolvedOpts {
  now?: Date
  resolveCredential?: typeof resolveEnterpriseCredential
  buildClient?: UnresolvedClientFactory
  /** login(lowercased) → teammateId roster. Defaults to resolveGithubRoster (the SAME reader
   *  the reconciler uses, so the diff is exactly "who the reconciler would skip"). */
  resolveRoster?: (db: Db, enterpriseRef: string) => Promise<Map<string, string>>
}

/*
 * List the UNRESOLVED github Copilot logins for one enterprise: those the live roster reports
 * with Copilot spend/seats but which resolveGithubRoster (both lanes) does NOT map to a
 * teammate, plus those it maps only through an unverified self-claim. Throws UnresolvedProbeError (a FIXED reason bucket) on a credential/roster/upstream
 * failure so the route can surface a clean, key-safe status — it NEVER returns a partial/empty
 * list that would read as "no unresolved users" when the probe actually failed.
 */
export async function listUnresolvedCopilotLogins(
  db: Db,
  ent: GithubEnterpriseRow,
  opts: ListUnresolvedOpts = {},
): Promise<UnresolvedCopilotResult> {
  const now = opts.now ?? new Date()
  const resolveCredential = opts.resolveCredential ?? resolveEnterpriseCredential
  const buildClient = opts.buildClient ?? realUnresolvedClient
  const rosterReader = opts.resolveRoster ?? resolveGithubRoster

  const appMode = !!ent.githubAppId?.trim()
  const credentialKind: CredentialKind = appMode ? 'github-app' : 'github-pat'

  // 1. Credential → client. A malformed App key throws in the GithubAppAuth ctor; classify it
  //    as probe-error (config-ish, but key-safe — never surface the decode error text).
  let client: UnresolvedProbeClient
  let credential
  try {
    credential = await resolveCredential(db, { provider: 'github', externalId: ent.externalId })
  } catch (err) {
    throw new UnresolvedProbeError('no-credential', `credential resolve failed: ${String(err)}`)
  }
  if (!credential) throw new UnresolvedProbeError('no-credential', 'no credential wired')
  try {
    client = buildClient({ externalId: ent.externalId, kind: credentialKind, value: credential.value, appId: credential.appId })
  } catch {
    // Never echo the decode error (it can carry key material) — a fixed bucket only.
    throw new UnresolvedProbeError('probe-error', 'client build failed')
  }

  // 2. Roster (the identity-map DB read). A failure here is OUR side — surface probe-error
  //    rather than an empty roster that would fabricate "everyone is unresolved". A login the
  //    roster resolves only through a self-claim stays listed, flagged with its claimant.
  let roster: Map<string, string>
  let selfOnly: Map<string, string>
  try {
    roster = await rosterReader(db, ent.externalId)
    selfOnly = await resolveGithubSelfOnlyLogins(db, ent.externalId)
  } catch {
    throw new UnresolvedProbeError('roster-unavailable', 'identity roster read failed')
  }
  const isResolved = (key: string) => roster.has(key) && !selfOnly.has(key)

  // 3. Live roster → diff. Dedup per lowercased login (a login can hold seats in >1 org);
  //    keep the FIRST-seen context. Sorted by login for a stable UI.
  const byLogin = new Map<string, UnresolvedCopilotLogin>()
  const probeDay = appMode ? githubProbeDay(now) : null

  try {
    if (appMode) {
      const rows = await client.getUserDailyCredits!(probeDay!)
      for (const { login, credits } of rows) {
        if (!login) continue
        const key = login.toLowerCase()
        if (isResolved(key) || byLogin.has(key)) continue
        byLogin.set(key, { login, licenseOrg: null, credits: Number.isFinite(credits) ? credits : 0, lastSeenDay: probeDay, profileName: null, profileEmail: null, selfClaimedBy: selfOnly.get(key) ?? null })
      }
    } else {
      const seats = await client.listSeats!()
      for (const seat of seats) {
        const login = seat.assignee?.login
        if (!login) continue
        const key = login.toLowerCase()
        if (isResolved(key) || byLogin.has(key)) continue
        byLogin.set(key, { login, licenseOrg: seat.organization?.login ?? null, credits: null, lastSeenDay: null, profileName: null, profileEmail: null, selfClaimedBy: selfOnly.get(key) ?? null })
      }
    }
  } catch (err) {
    // The provider call failed (auth / egress / rate-limit / not-ready). Surface a fixed bucket —
    // never a partial list (which would read as "no more unresolved users") and never a body.
    throw new UnresolvedProbeError('probe-error', `roster fetch failed: ${String(err)}`)
  }

  const logins = [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login))

  /*
   * 4. DECORATE with the public profile (name + public email). Strictly best-effort: this is a
   * display hint for the human doing the mapping, so a failure must degrade to a null hint and
   * NEVER convert a good list into a probe error. That is why this sits after the sort, outside
   * the try that guards the roster fetch, and swallows per-login failures individually.
   *
   * CAPPED because it is the only part of this probe that costs one live call PER ROW rather
   * than one per enterprise. The cap bounds a page load on a badly-unmapped enterprise; beyond
   * it the remaining rows simply render without hints, which is the pre-existing experience.
   *
   * The cap bounds the CALL COUNT; a serial loop would still make page latency the SUM of 25
   * round trips against a slow provider, so the lookups run with bounded concurrency. Bounded
   * rather than unbounded because these are authenticated calls against a rate-limited API and
   * the enterprise credential is shared with the reconciler.
   *
   * A whole-pass DEADLINE on top of both, because neither bounds TIME: a profile API that hangs
   * rather than fails would hold a list that is already complete and correct. When it expires
   * the rows decorated so far keep their hints and the rest render without, which is the same
   * degradation as exceeding the cap. "Best-effort" has to mean the list never waits on it.
   */
  if (client.getUserProfile && logins.length > 0) {
    const fetchProfile = client.getUserProfile.bind(client)
    const queue = logins.slice(0, PROFILE_HINT_LIMIT)
    let next = 0
    let deadlineExpired = false
    const worker = async () => {
      for (;;) {
        // Checked per iteration, not just raced against: without this the workers keep
        // dequeuing and calling the provider after the response has been sent, which turns a
        // response-latency bound into no bound on provider load at all.
        if (deadlineExpired) return
        const i = next++
        const row = queue[i]
        if (!row) return
        try {
          const profile = await fetchProfile(row.login)
          if (!profile) continue
          row.profileName = profile.name
          row.profileEmail = profile.email
        } catch {
          // A decoration failure is not a probe failure. Nothing is logged per row: on a wholly
          // unreachable profile API this would be one warn per unresolved login, which buries
          // the real signal without telling an operator anything the null hint doesn't show.
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => { deadlineExpired = true; resolve() }, PROFILE_HINT_DEADLINE_MS)
      // Do not hold the event loop open on a short-lived process (a worker run, a test).
      timer.unref?.()
    })
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(PROFILE_HINT_CONCURRENCY, queue.length) }, worker)),
        deadline,
      ])
    } finally {
      // Always cleared, including on the fast path: an uncleared timer fires long after the
      // response has gone out, and on a busy server that is one stray timer per request.
      if (timer) clearTimeout(timer)
    }
    if (deadlineExpired) {
      // One warn for the PASS (not per row): an operator needs to know hints were truncated by
      // a slow provider, and one line says it without burying the log.
      consola.warn('[github-unresolved] profile hint pass hit its deadline; some rows render without hints', {
        enterprise: ent.externalId,
      })
    }
  }

  return { enterpriseId: ent.enterpriseId, externalId: ent.externalId, credentialKind, probeDay, logins }
}
