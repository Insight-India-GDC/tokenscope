/*
 * POST /api/v1/admin/reconciliation/github/map — map an UNRESOLVED github Copilot login to an
 * existing teammate (identity-tail layer 3). Writes the ENTERPRISE lane of teammate_identity_map
 * (source='admin-manual', verified), so the reconciler's roster reader (resolveGithubRoster)
 * picks it up and the login's Copilot spend attributes to the chosen teammate on the next run.
 *
 * Body (zod): { enterpriseId (uuid), login, licenseOrg?, and EXACTLY ONE of teammateId (uuid)
 * | directoryOid (the Entra object id of a picked directory user) }.
 *
 * PROVISION-THEN-MAP (`directoryOid`) — why this route may create a teammate.
 * Binding to an EXISTING teammate was the only mode, which made the flow unusable for the
 * population it serves: an unresolved login is by construction one that bill-driven
 * provisioning never ran for (it is gated behind the same SAML email whose absence puts the
 * login on the list), so the person is typically absent from `teammate` entirely. See the
 * DIRECTORY FALL-THROUGH note in teammate-search.get.ts.
 *
 * It provisions through `provisionDirectoryTeammate`, the SAME service every other admin
 * directory-pick surface uses (admin/teammates.post.ts, org-units/[id]/owners.post.ts,
 * projects/[id]/assignments.post.ts), and follows their ordering exactly: re-resolve the oid
 * server-side, refuse excluded identities, clamp the region, then do ALL writes inside the one
 * request transaction.
 *
 * An earlier revision called the RESOLVER's `provisionAndPlace` instead, reasoning that a
 * hand-mapped seat should land exactly where the automatic path would have put it. That
 * reasoning was wrong in a way worth recording, because it looks right: `provisionAndPlace` is
 * a WORKER function. It owns its own writes, re-homes existing teammates, and replays owed
 * bills, so it cannot be composed into a request transaction — which forced provisioning to
 * run BEFORE the enterprise check and BEFORE both region clamps. A region-scoped admin could
 * therefore re-home a teammate and replay their bills against an enterprise that does not
 * exist, and still be refused the bind afterwards, with the mutation already committed and
 * unaudited. Matching the worker's PLACEMENT is worth less than matching the admin surface's
 * SAFETY.
 *
 * The cost of that trade, stated plainly rather than waved away: a teammate provisioned here
 * lands on the region's `__UNPLACED__` holding node and STAYS there until an admin places them.
 * The region-reenrichment worker does not pick them up — it selects `entra_oid LIKE 'bill:%'`
 * (workers/region-reenrichment.ts), and a directory pick writes a real Entra oid. So this route
 * fixes ATTRIBUTION (the seat's spend now reaches the right person, which is the goal) and
 * leaves PLACEMENT (which practice they roll up to) for the admin. That is exactly the
 * behaviour of the three sibling directory-pick surfaces, so it is a property of the shared
 * service and not a quirk of this route, but it is a real limitation and belongs in the
 * unresolved-users runbook rather than in a comment claiming a worker cleans up after us.
 *
 * IDENTITY KEY: the client sends an `oid`, never an email. `getDirectoryUserByOid` re-resolves
 * it against Entra, so the email and display name written here are directory-attested rather
 * than caller-supplied. The oid ladder inside `provisionDirectoryTeammate` also ADOPTS an
 * existing `bill:` placeholder holding that email, so mapping a seat whose cost had already
 * been provisioned upgrades that row in place rather than minting a duplicate.
 *
 * REGION: the seat's license org gives the natural home (ADR-0010 D4, GitHub org → region)
 * in SEAT mode. In APP mode there is no license org at all (the daily-credits probe has no org
 * dimension, github-unresolved.ts:184 sets it null), so the caller's own region is not an edge
 * case there but the ONLY outcome — an unbounded caller (platform-admin) homes
 * every pick into whatever region their session carries. That is survivable because the row
 * lands on `__UNPLACED__` and an admin places it, and because attribution (this route's goal)
 * does not depend on the region; it is NOT a claim that the region is correct.
 *
 * but `licenseOrg` arrives from the client, so it may not be taken on trust. It is used only
 * to CHOOSE a candidate region, which then passes `requireRegionScope` like any other region a
 * caller names. A region admin naming another region's org is refused; platform-admin and
 * platform-admin pass through, as everywhere else. An unmapped or absent org falls back to the
 * caller's own region rather than a global bucket.
 *
 * MONEY PATH — invariants (surfaced as clean statuses, never raw 500s):
 *   - enterprise must exist AND be provider='github' (else 404 / 400).
 *   - teammate must exist AND be non-provisional (a provisional shadow is not a real attribution
 *     target — mirrors the money-path guard in github-identity.ts resolveTeammateId).
 *   - login charset is constrained (same floor as me/identities.post).
 *   - the write is the ENTERPRISE lane (enterprise_slug = the slug, lowercased — canonical
 *     casing, mig 0062), on the widened unique key (system, COALESCE(enterprise_slug,''),
 *     lower(identifier)). It is IDEMPOTENT (ON CONFLICT DO UPDATE): an admin re-map cleanly
 *     re-binds (authoritative, like directory-sync). It CANNOT clobber a self-service link —
 *     that row is the NULL lane (a different COALESCE('') key). A genuine constraint race
 *     (e.g. the teammate deleted mid-write) is translated to a clean 409/404, never a 500.
 *
 * RBAC: requireRole(admin) + assertSameOrigin. INSERT + audit in ONE tx (SYS-3),
 * so a map never lands unaudited. Mirrors orgs.post.ts / me/identities.post.ts idioms.
 *
 * Region-scope: RLS is inert at runtime (owner connection, no FORCE), so requireRole alone is
 * not a region gate. This is a MONEY-PATH rebind, so BOTH ends are clamped to the caller's
 * region (platform-admin pass through, rbac.ts:55):
 *   - the TARGET teammate being mapped TO (tm.region_id) — stops routing a login's spend INTO
 *     another region.
 *   - every teammate CURRENTLY bound to this login (if any), in this enterprise's lane OR the
 *     self lane — stops a region-A admin pulling a login AWAY FROM a region-B teammate (the
 *     one-ended clamp's leak in mirror image). The self lane counts because the enterprise-lane
 *     row written here outranks it in both roster readers.
 * Both checks run after their row is resolved (404-before-403), so an unknown teammateId still
 * 404s and this endpoint never becomes an existence oracle for other regions' teammate ids.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { readValidated } from '../../../../../utils/validated-body'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { getDirectoryUserByOid, type DirectoryUser } from '../../../../../azure/directory'
import { assertDirectoryIdentityPickable, provisionDirectoryTeammate } from '../../../../../auth/provision-directory-teammate'
import { loadDirectoryExclusionPatterns } from '../../../../../utils/directory-exclusions'
import { regionForLicenseOrg } from '../../../../../reconciliation/org-region'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const Body = z
  .object({
    enterpriseId: z.string().regex(UUID_RE),
    /* EXACTLY ONE of teammateId / directoryOid (refined below).
     *   teammateId   — bind to an EXISTING teammate (the original behaviour).
     *   directoryOid — the person is in Entra but not necessarily a teammate yet; resolve them
     *                  server-side, then bind. The resolve may provision, adopt a `bill:`
     *                  placeholder, or reuse an existing row — see PROVISION-THEN-MAP above. */
    teammateId: z.string().regex(UUID_RE).optional(),
    /* An Entra OBJECT ID, not an email. The oid is the stable, non-reassignable identity key
     * the sibling admin surfaces use; an email is a mutable attribute and is re-read from the
     * directory rather than accepted from the caller.
     *
     * Bounded opaque string, NOT UUID_RE, matching admin/teammates.post.ts:55. A UUID floor
     * looks tighter and buys nothing (the value is looked up, never interpolated), while
     * breaking the local/dev mock directory outright, whose oids are `dir-oid-0001`-shaped:
     * the picker would offer candidates this route then rejected with a 400. */
    directoryOid: z.string().trim().min(1).max(200).optional(),
    // Same charset floor as me/identities.post — this value is persisted then interpolated into
    // the reconciler's login lookups; keep an attacker-controlled value off that surface.
    login: z.string().min(1).max(200).regex(/^[\w.@+-]+$/, 'invalid login characters'),
    // The seat's license org (from the unresolved list's context), when known — persisted for
    // parity with the directory-sync writer. Optional; a lowercase org-slug charset floor.
    licenseOrg: z.string().min(1).max(200).regex(/^[\w.-]+$/).nullish(),
  })
  .refine((b) => (b.teammateId ? 1 : 0) + (b.directoryOid ? 1 : 0) === 1, {
    message: 'provide exactly one of teammateId or directoryOid',
  })

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid identity map',
    data: { type: 'https://tokenscope.example.com/errors/validation', title: 'Invalid identity map', status: 400, detail },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const login = body.login.trim().toLowerCase()
  const licenseOrg = body.licenseOrg ? body.licenseOrg.trim().toLowerCase() : null

  /*
   * Directory mode: re-resolve the picked oid against Entra and refuse excluded identities
   * BEFORE the transaction — the same two steps, in the same order, as every sibling admin
   * directory-pick surface (admin/teammates.post.ts:83-99). Both are network/pure work with no
   * writes, so they belong outside the tx; everything that WRITES is inside it.
   */
  let dirUser: DirectoryUser | null = null
  if (body.directoryOid) {
    dirUser = await getDirectoryUserByOid(body.directoryOid)
    if (!dirUser) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Directory user not found',
        data: {
          type: 'https://tokenscope.example.com/errors/directory-user',
          title: 'Directory user not found',
          status: 404,
          detail: 'No Entra directory user matches that object id. Pick a person from the search results.',
        },
      })
    }
  }

  return await withRequestRls(event, async (tx) => {
    // Exclusion check inside the tx on `tx`, not before it on a second pool handle. This route
    // was the first to get it right; its three siblings (admin/teammates.post.ts,
    // admin/org-units/[id]/owners.post.ts, admin/projects/[id]/assignments.post.ts) read the
    // patterns on a second, context-less handle until the A2 conversion moved them here too, so
    // all four now share this shape. Nothing is written before this point, so a refusal here
    // still rejects with no partial effect.
    if (dirUser) {
      assertDirectoryIdentityPickable(dirUser, await loadDirectoryExclusionPatterns(tx))
    }

    // Enterprise must exist AND be a github enterprise. enterprise_slug is canonical lowercase.
    const entRows = await tx.execute<{ provider: string; external_id: string }>(sql`
      SELECT provider, external_id FROM provider_enterprise WHERE id = ${body.enterpriseId}::uuid LIMIT 1
    `)
    const ent = [...entRows][0]
    if (!ent) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Enterprise not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Enterprise not found', status: 404, detail: 'No provider_enterprise matches enterpriseId.' },
      })
    }
    if (ent.provider !== 'github') badRequest('The identity map is GitHub-only.')
    const slug = ent.external_id.toLowerCase()

    /*
     * Resolve the target teammate. Directory mode provisions HERE — after the enterprise is
     * known good and inside this transaction, so a bind that is later refused (region clamp,
     * constraint race) takes the provisioning back with it and leaves nothing behind. Every
     * guard below then runs identically for both modes, so provisioning widens WHO may be
     * picked and never WHAT may be bound.
     */
    let teammateId: string
    let provisioned = false
    let adopted = false
    if (dirUser) {
      // The license org names the natural home (ADR-0010 D4), but it came from the client, so
      // it only PROPOSES a region — requireRegionScope disposes, exactly as it does for the
      // bind target below. Unmapped or absent org → the caller's own region, which needs no
      // clamp because it is theirs by definition.
      //
      // This clamp is FAIL-FAST, not the enforcement point: a teammate homed into a region the
      // caller may not touch is caught again by the target clamp below, which is what actually
      // guarantees the outcome (verified by mutation — removing this line alone changes no test
      // result). It earns its place by refusing before the write rather than after it, and by
      // naming the region the caller asked for instead of the one they ended up in.
      // `tx`, not a fresh pool handle: a second checkout while this transaction already holds one
      // lets N concurrent maps each hold a connection waiting for another (server/db/index.ts
      // caps the pool), which deadlocks rather than queues.
      const candidateRegionId = (licenseOrg ? await regionForLicenseOrg(tx, licenseOrg) : null) ?? caller.regionId
      await requireRegionScope(event, candidateRegionId)
      const outcome = await provisionDirectoryTeammate(tx, dirUser, caller.teammateId, {
        regionId: candidateRegionId,
        // Unused by the service since S3 (it homes on the region's __UNPLACED__ node); required
        // by the interface only for its older callers.
        fallbackOrgUnitId: '',
        via: 'copilot-login-map',
      })
      teammateId = outcome.teammateId
      // Kept DISTINCT. Collapsing them would report `provisioned: true` for a bind that minted
      // nothing, and the audit trail's whole job here is to say what this call caused to exist.
      provisioned = outcome.provisioned
      adopted = outcome.adopted
    } else {
      teammateId = body.teammateId!
    }

    // Teammate must exist AND be non-provisional (a provisional shadow is never an attribution
    // target — the same money-path guard the directory-sync resolver uses).
    const tmRows = await tx.execute<{ provisional: boolean; region_id: string; is_active: boolean }>(sql`
      SELECT provisional, is_active, region_id::text AS region_id FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
    `)
    const tm = [...tmRows][0]
    if (!tm) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Teammate not found', status: 404, detail: 'No teammate matches teammateId.' },
      })
    }
    // Region-scope the TARGET (teammate.region_id is NOT NULL, mig 0001 — always resolves): a
    // region-A admin cannot route this login's Copilot spend into a region-B teammate.
    await requireRegionScope(event, tm.region_id)
    if (tm.provisional) badRequest('Cannot map to a provisional (shadow) teammate — pick a real teammate.')
    // A deactivated teammate is not an attribution target either: routing a live seat's spend
    // onto a leaver's row hides it from every surface that filters on is_active.
    if (!tm.is_active) badRequest('Cannot map to a deactivated teammate — pick an active teammate.')

    // Region-scope every teammate CURRENTLY bound to this login: this enterprise's lane, and the
    // self lane (enterprise_slug NULL), which the enterprise-lane row written below outranks in
    // both roster readers. No existing binding is the common case (an UNRESOLVED login).
    const boundRows = await tx.execute<{ region_id: string }>(sql`
      SELECT DISTINCT t.region_id::text AS region_id
      FROM teammate_identity_map tim
      JOIN teammate t ON t.id = tim.teammate_id
      WHERE tim.system = 'github'
        AND (COALESCE(tim.enterprise_slug, '') = ${slug} OR tim.enterprise_slug IS NULL)
        AND lower(tim.identifier) = ${login}
    `)
    for (const bound of boundRows) await requireRegionScope(event, bound.region_id)

    // Authoritative ENTERPRISE-lane upsert on the widened, case-insensitive key. Cannot clobber a
    // self-service link (NULL lane → different COALESCE('') key). Idempotent admin re-bind.
    let mapId: string
    try {
      mapId = await (async () => {
        const [row] = await tx.execute<{ id: string }>(sql`
          INSERT INTO teammate_identity_map (
            teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug,
            license_org, billing_relationship, source, is_pinned, is_canonical, verified_at
          ) VALUES (
            ${teammateId}::uuid, 'github', ${login}, 'username', ${login}, ${slug},
            ${licenseOrg}, 'enterprise-reconciled', 'admin-manual', false, false, now()
          )
          ON CONFLICT (system, (COALESCE(enterprise_slug, '')), (lower(identifier)))
          DO UPDATE SET
            teammate_id = EXCLUDED.teammate_id,
            github_login = EXCLUDED.github_login,
            license_org = EXCLUDED.license_org,
            billing_relationship = EXCLUDED.billing_relationship,
            source = EXCLUDED.source,
            verified_at = EXCLUDED.verified_at
          RETURNING id::text AS id
        `)
        return row!.id
      })()
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        // Teammate FK vanished mid-write, or a concurrent conflicting insert on the widened key.
        '23503': { status: 404, title: 'Teammate not found', detail: 'The teammate was deleted while mapping.' },
        '23505': { title: 'Login mapped concurrently', detail: 'That login was mapped concurrently — reload and retry.' },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'copilot-login-mapped',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: teammateId,
      payload: {
        system: 'github',
        enterprise_slug: slug,
        login,
        license_org: licenseOrg,
        source: 'admin-manual',
        // Whether this bind also MINTED (or adopted) the teammate, and from which directory
        // identity. Without it the audit shows a bind to a teammate id that did not exist
        // moments earlier, with nothing recording who caused it to exist.
        provisioned,
        adopted,
        directory_oid: body.directoryOid ?? null,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: mapId, enterpriseSlug: slug, login, teammateId, provisioned, adopted, source: 'admin-manual' }
  })
})
