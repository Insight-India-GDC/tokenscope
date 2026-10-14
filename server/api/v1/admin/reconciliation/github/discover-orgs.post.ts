/*
 * POST /api/v1/admin/reconciliation/github/discover-orgs — onboarding helper that,
 * given a GitHub enterprise, uses its credential to enumerate that enterprise's orgs and
 * AUTO-CREATES the provider_org rows for them. The admin should NOT hand-type (and guess)
 * org slugs when the credential already lists them — this is the GitHub counterpart of
 * the Anthropic `discover` probe.
 *
 * Body (zod): { enterpriseId }.
 *
 * DISCOVERY SOURCE IS PER CREDENTIAL KIND (UF-19), because the two credentials can read
 * different surfaces — and they answer subtly different questions, which the response
 * states rather than hides:
 *   - PAT mode: the ENTERPRISE seat roster's license-orgs (the orgs that actually hold
 *     Copilot seats = the orgs with cost). Unchanged.
 *   - App mode: `installable_organizations` — the orgs the enterprise OWNS. The
 *     enterprise seats endpoint presents a Bearer PAT header, which a withApp() client
 *     does not have (it 401'd), and the per-org seats endpoint cannot be the discovery
 *     source because it needs the org list this route exists to produce. The census is
 *     also the more useful answer at cutover: it names orgs the App is not yet installed
 *     on, which are precisely the ones an admin has to act on. It is NOT filtered to
 *     seat-bearing orgs — `listOrgCopilotSeats` returns [] for an org the App is not
 *     installed on, so filtering would discover nothing on a freshly-App'd enterprise.
 *
 * Each distinct org is UPSERTED as a github provider_org linked to this enterprise
 * (reconciliation_mode='reconciled', billing='tracked'), idempotently — an existing org
 * is left as-is (its region/notes are preserved) but linked to the enterprise if it
 * wasn't. The admin then just sets each org's region.
 *
 * Response 200: { discovered, created, linked, alreadyLinked, credentialKind, capped,
 * orgs: [{login, status}] }. `capped` means the source list was a PREFIX (the provider
 * pagination cap, or this route's own per-call org bound) — discovery is additive, so a
 * prefix is safe, but "discovered N" must not read as "the enterprise has N orgs".
 * A credential failure returns 422 with a SAFE { reason, credentialKind } (no key, no raw
 * provider text — the credential is never echoed or logged). `credentialKind` rides on the
 * failure body too, because the SAME status means different remediations per mode (a 403
 * is "the PAT needs manage_billing" or "the App needs Enterprise organization
 * installations: read") and the caller must not have to assume one.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited (per created/linked org).
 */
import { defineEventHandler, createError, readValidatedBody, getRequestIP, getHeader, setResponseStatus } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { resolveEnterpriseCredential, MissingGithubAppKeyError } from '../../../../../reconciliation/credentials'
import { GithubCopilotClient } from '../../../../../reconciliation/adapters/github-client'
import { GithubAppAuth } from '../../../../../reconciliation/adapters/github-app-auth'
import { seatLicenseOrg } from '../../../../../reconciliation/adapters/github'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Body = z.object({ enterpriseId: z.string().regex(UUID_RE) })

/*
 * Per-call bound on how many discovered orgs this route will upsert. The App-mode census
 * is the enterprise's WHOLE org estate (bounded only by the client's own 10,000-org
 * pagination cap), and every org here costs 1-3 statements inside ONE RLS request
 * transaction — an unbounded write loop over a large estate is a request timeout holding
 * locks on provider_org. Mirrors coverage's MAX_ORG_PROBES_PER_PASS. Exceeding it sets
 * `capped` rather than silently truncating; a second run makes no further progress on its
 * own, so a capped result is a signal to onboard the remainder another way, not a retry
 * prompt. PAT mode is bounded by seat-bearing orgs and realistically never reaches it.
 */
const MAX_DISCOVER_ORGS = 500

/* Classify a thrown GitHub-client error into the SAFE discover vocabulary (mirrors the
 * anthropic discover reasons). The client throws a 502 createError carrying the upstream
 * status in detail like "seats returned HTTP 401" (PAT mode) or
 * "enterprises/{ent}/apps/installable_organizations returned HTTP 403" / the no-install
 * 404 (App mode); map that without echoing the key. The buckets are credential-NEUTRAL
 * on purpose — the same status means different remediations per mode, and the mode rides
 * back on `credentialKind` so the caller renders the right one rather than assuming a PAT. */
function classifyGithubError(err: unknown): string {
  const detail = (err as { data?: { detail?: string } } | null)?.data?.detail ?? ''
  if (/HTTP 401/.test(detail)) return '401-unauthorized'
  if (/HTTP 403/.test(detail)) return '403-forbidden-scope'
  if (/HTTP 404/.test(detail)) return '404-wrong-endpoint'
  if (/HTTP 429/.test(detail)) return '429-rate-limited'
  return 'connect-failed'
}

export default defineEventHandler(async (event) => {
  // Re-links provider_org rows of every region (no region term), so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // 1. Resolve the enterprise — must exist + be github.
    const entRows = await tx.execute<{ external_id: string; provider: string; github_app_id: string | null }>(sql`
      SELECT external_id, provider, github_app_id FROM provider_enterprise WHERE id = ${body.enterpriseId}::uuid LIMIT 1
    `)
    const ent = [...entRows][0]
    if (!ent) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Enterprise not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Enterprise not found', status: 404, detail: 'No provider_enterprise matches enterpriseId.' },
      })
    }
    if (ent.provider !== 'github') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Not a GitHub enterprise',
        data: { type: 'https://tokenscope.example.com/errors/validation', title: 'Not a GitHub enterprise', status: 400, detail: 'Org discovery is GitHub-only; Anthropic uses the per-org Discover probe.' },
      })
    }

    /*
     * 2. The enterprise credential (presence only — the value builds the client and is
     * never returned). `credentialKind` is derived from github_app_id, the SAME App-mode
     * signal github-health.ts / github-unresolved.ts read, so it is available even on the
     * no-key path where there is no resolved credential to ask. It always agrees with the
     * resolved credential.kind (resolveEnterpriseCredential derives both from that column),
     * and the client construction below still branches on credential.kind per S9.
     *
     * An App-opted enterprise with an unwired key makes resolveEnterpriseCredential THROW
     * (MissingGithubAppKeyError, fail-loud by design). Uncaught, that is a 500 on the very
     * onboarding screen an admin uses mid-cutover; it is the same operator condition as a
     * missing PAT, so it answers with the same 422 { reason: 'no-key' }.
     */
    const credentialKind = ent.github_app_id?.trim() ? 'github-app' : 'github-pat'
    let credential
    try {
      credential = await resolveEnterpriseCredential(tx, { provider: 'github', externalId: ent.external_id })
    } catch (err) {
      if (!(err instanceof MissingGithubAppKeyError)) throw err
      credential = null
    }
    if (!credential) {
      setResponseStatus(event, 422)
      return { reason: 'no-key', credentialKind }
    }

    // 3. Enumerate the enterprise's orgs with the surface THIS credential can read
    //    (see the header) → distinct logins, lowercased (canonical per mig 0064).
    //    S9: branch on the resolved credential kind exactly as the five correct sibling
    //    call sites do (copilot-pool-bill.ts:593-594 is the model) — this was the SECOND
    //    unbranched site that flattened credential.value and fed the GitHub App private
    //    key to withPat as a Bearer token whenever the enterprise was App-mode.
    //    UF-19: the same branch now also selects the DATA path, because branching only at
    //    construction left App mode calling a PAT-only endpoint with an empty bearer.
    let orgs: string[]
    // Assigned in every non-throwing path below; the catch returns before reading it.
    let capped: boolean
    try {
      const set = new Set<string>()
      if (credential.kind === 'github-app') {
        const census = await GithubCopilotClient.withApp(
          ent.external_id,
          new GithubAppAuth(credential.appId!, credential.value),
        ).listInstallableOrganizations()
        // A capped census is a PREFIX of the estate — reported, never presented as the whole.
        capped = census.pagesCapped
        for (const org of census.organizations) set.add(org.login.trim().toLowerCase())
      } else {
        // listSeatsWithDiagnostics (not listSeats) purely so a truncated roster is
        // REPORTED: `discovered` would otherwise understate the estate with no signal.
        const pull = await GithubCopilotClient.withPat(ent.external_id, credential.value).listSeatsWithDiagnostics()
        capped = pull.pagesCapped
        for (const seat of pull.seats) {
          const org = seatLicenseOrg(seat)
          if (org) set.add(org.trim().toLowerCase())
        }
      }
      const all = [...set].filter((o) => o.length > 0).sort()
      if (all.length > MAX_DISCOVER_ORGS) capped = true
      orgs = all.slice(0, MAX_DISCOVER_ORGS)
    } catch (err) {
      setResponseStatus(event, 422)
      return { reason: classifyGithubError(err), credentialKind }
    }

    // 4. Upsert each org as a github provider_org linked to this enterprise. Idempotent:
    //    a brand-new org is created; an existing one is linked to the enterprise if it
    //    wasn't (its region/notes are NEVER overwritten).
    const out: Array<{ login: string; status: 'created' | 'linked' | 'already' }> = []
    let created = 0
    let linked = 0
    let alreadyLinked = 0
    for (const login of orgs) {
      const existing = await tx.execute<{ id: string; provider_enterprise_id: string | null }>(sql`
        SELECT id::text AS id, provider_enterprise_id::text AS provider_enterprise_id
        FROM provider_org WHERE provider = 'github' AND lower(external_org_id) = lower(${login}) LIMIT 1
      `)
      const row = [...existing][0]
      if (!row) {
        const ins = await tx.execute<{ id: string }>(sql`
          INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, provider_enterprise_id)
          VALUES ('github', ${login}, ${login}, 'reconciled', 'tracked', ${body.enterpriseId}::uuid)
          RETURNING id::text AS id
        `)
        created += 1
        out.push({ login, status: 'created' })
        await recordAuditEvent(tx, {
          eventType: 'provider-org-discovered',
          actorTeammateId: caller.teammateId,
          subjectKind: 'provider-org',
          subjectId: [...ins][0]!.id,
          payload: { provider: 'github', external_org_id: login, provider_enterprise_id: body.enterpriseId, via: 'github-discover-orgs' },
          ipAddress: ip,
          userAgent: ua,
        })
      } else if (row.provider_enterprise_id !== body.enterpriseId) {
        // Link an existing org to this enterprise (it had none, or a stale one). Region/notes untouched.
        await tx.execute(sql`
          UPDATE provider_org SET provider_enterprise_id = ${body.enterpriseId}::uuid WHERE id = ${row.id}::uuid
        `)
        linked += 1
        out.push({ login, status: 'linked' })
        await recordAuditEvent(tx, {
          eventType: 'provider-org-discovered',
          actorTeammateId: caller.teammateId,
          subjectKind: 'provider-org',
          subjectId: row.id,
          payload: { provider: 'github', external_org_id: login, provider_enterprise_id: body.enterpriseId, via: 'github-discover-orgs', linked: true },
          ipAddress: ip,
          userAgent: ua,
        })
      } else {
        alreadyLinked += 1
        out.push({ login, status: 'already' })
      }
    }

    return { discovered: orgs.length, created, linked, alreadyLinked, credentialKind, capped, orgs: out }
  })
})
