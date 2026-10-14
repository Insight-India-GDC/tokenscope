/*
 * GET /api/v1/admin/reconciliation/github/teammate-search?q=<name-or-email> — a minimal
 * teammate typeahead for the "Unresolved Copilot users" map picker.
 *
 * DIRECTORY FALL-THROUGH — why this endpoint reads Entra as well as `teammate`.
 * Searching `teammate` ALONE made this picker structurally empty for its own population.
 * The DOMINANT door is the resolver finding no SAML email for the login (github-identity.ts,
 * the `carriedNoEmail` branch). That failure is CAUSALLY LINKED to the picker being empty, not
 * merely correlated: ADR-0010 rule 1 bill-driven-provisioning is gated behind the very SAML
 * email whose absence puts the login on the list, so the person provisioning would have created
 * is exactly the person it never ran for.
 *
 * It is not the ONLY door. `carriedNoTeammate` (github-identity.ts:256) also lands a login here
 * when the SAML email WAS present but the provisioning call threw — that path retries next run,
 * so it is transient, but a login sitting in it is findable by the teammate search only if some
 * other path created the row. So: a `teammate`-only picker searches a table this population is
 * USUALLY missing from. Usually, not always — an
 * independent path (an Entra placement sync, a Claude Code enrolment, the Anthropic resolver)
 * can have created the row anyway, which is why this endpoint still returns teammate matches
 * first and why the fall-through supplements them rather than replacing them. Confirmed on Dev: an
 * unfederated NFR org (members joined by direct assignment, so the org has no
 * externalIdentities entry for them) produced four unresolved logins, none findable here,
 * while all four resolve in Entra.
 *
 * So this endpoint ALSO searches the directory, and returns the hits under a SEPARATE
 * `directory` key. Separate, never merged, because the two carry different authority: a
 * `teammates` hit is an existing attribution target; a `directory` hit is a person who must be
 * provisioned first (POST /map's `directoryOid` mode does that). The UI must keep them
 * visually distinct for the same reason.
 *
 * The fall-through is UNCONDITIONAL, not empty-only. An earlier revision only searched the
 * directory when the teammate search returned nothing, to avoid offering a directory candidate
 * for someone who already exists. That rule reintroduced the very bug this endpoint exists to
 * fix: the teammate search is a substring ILIKE, so ONE unrelated partial match (an admin
 * typing "ann" matching an existing "Annabel") suppressed the directory entirely and made the
 * picker useless for that query again. The duplicate concern is answered precisely instead of
 * bluntly: directory hits whose email already belongs to a returned teammate are dropped here,
 * and POST /map keys on the Entra oid, whose ladder adopts an existing `bill:` placeholder for
 * that email rather than minting a second row.
 *
 * That drop compares against THIS PAGE of teammate results only (they share a `limit`, and the
 * teammate side is region-clamped while the directory side is not), so it is a de-duplication
 * courtesy and NOT a guarantee that a directory hit is not already a teammate somewhere. The
 * UI wording must not promise otherwise, and the real protection stays where it belongs: the
 * oid ladder in POST /map, which cannot create a duplicate whatever this endpoint offers.
 *
 * The admin/teammates list is region-scoped (requireRegionScope), but mapping a Copilot login
 * is a platform-admin/admin action — a REGION admin still may not know the teammate's org unit a
 * priori, so this stays a name/email search rather than the org-tree browse. It returns only
 * ACTIVE, NON-PROVISIONAL teammates (the only valid attribution targets — the map POST rejects a
 * provisional shadow) with id + email + display name. No secrets, capped result set.
 *
 * REGION CLAMP: a region-scoped `admin` sees only teammates in their own region — platform-admin /
 * platform-admin see the whole estate. The `directory` fall-through is NOT region-clamped: Entra
 * is org-wide and carries no TokenScope region, so there is nothing to clamp ON — the same
 * reasoning as /api/v1/admin/directory/search, which also defers the clamp to provision time.
 * The clamp that matters is enforced where the money moves: POST /map region-scopes the teammate
 * it binds, provisioned or pre-existing, so a region-A admin still cannot route a login's spend
 * into region B. Offering a directory hit is not a grant.
 *
 * That picker clamp is HALF of an invariant shared with
 * `POST /api/v1/admin/reconciliation/github/map` (owned by a different story): that route ALSO
 * clamps the teammate currently bound to the (system, enterprise_slug, login) tuple, which this
 * picker cannot reflect (it doesn't know which login the admin is about to re-map). So "the picker
 * only offers targets map.post will accept" is NOT true in general — a region-A admin can select a
 * legitimately-offered region-A teammate and still get a 403 from map.post if that login happens to
 * be currently bound to another region. Both clamp on the SAME population (an admin's own region),
 * which is the invariant that must hold; the residual false-positive-pick case is a UX gap for
 * map.post's error response to disambiguate, not a security gap.
 *
 * RBAC: requireRole(admin) — same guard as github/map.post (both region-clamped below).
 * GET (read-only) → no assertSameOrigin.
 *
 * LANES (docs/design/rls-enforcement.md §2): both DB reads — the teammate picker
 * query and the exclusion-pattern load — run in the request lane. The Entra
 * directory call between them stays OUTSIDE that transaction: holding a request
 * transaction across third-party HTTP is the anti-pattern §2 names. The explicit
 * `regionClause` remains the live gate; it is not replaced by RLS.
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { consola } from 'consola'
import { requireRole } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { searchDirectory } from '../../../../../azure/directory'
import { isExcludedUpn, loadDirectoryExclusionPatterns } from '../../../../../utils/directory-exclusions'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../../../utils/sql-like'

const Query = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().positive().max(25).default(10),
})

interface Row extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  region_code: string | null
  org_unit_code: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const query = await getValidatedQuery(event, (data) => {
    const parsed = Query.safeParse(data)
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'invalid query parameter' })
    return parsed.data
  })
  const like = `%${escapeLikeLiteral(query.q)}%`
  // Region-scoped `admin` only searches their own region; platform-admin /
  // platform-admin keep the estate-wide picker (RLS on `teammate` is not
  // relied on here — same reasoning as every other explicit clamp in this
  // sprint: the app connection bypasses it).
  const regionClause = session.role === 'admin' ? sql`AND t.region_id = ${session.regionId}::uuid` : sql``
  const { rows, patterns } = await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<Row>(sql`
    SELECT t.id::text AS id,
           t.email,
           t.display_name,
           rg.code AS region_code,
           ou.code AS org_unit_code
    FROM teammate t
    LEFT JOIN region rg ON rg.id = t.region_id
    LEFT JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.is_active = TRUE
      AND NOT t.provisional
      AND (t.display_name ILIKE ${like} ESCAPE ${LIKE_ESCAPE} OR t.email ILIKE ${like} ESCAPE ${LIKE_ESCAPE})
      ${regionClause}
    ORDER BY t.display_name NULLS LAST, t.email
    LIMIT ${query.limit}
  `)
    // Loaded in the SAME transaction as the picker query — it is only consumed
    // after the directory call below, but reading it here keeps every DB
    // statement in this handler inside one RLS-bearing transaction and the HTTP
    // call outside it.
    const patterns = await loadDirectoryExclusionPatterns(tx)
    return { rows, patterns }
  })

  const teammates = [...rows].map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    regionCode: r.region_code,
    orgUnitCode: r.org_unit_code,
  }))
  /*
   * Search Entra too (see the DIRECTORY FALL-THROUGH note in the header for why a hit here is
   * the COMMON case for this picker, not the edge case).
   *
   * A directory outage must NOT turn the picker into an error page: the teammate search above
   * already succeeded, and "no teammate matched" is a complete, honest answer on its own. So a
   * failure degrades to the pre-existing behaviour and reports itself via `directoryError`,
   * which the UI shows instead of the silent "no matches" that would otherwise imply the person
   * genuinely is not in the directory. Silence here is the one outcome that misleads.
   */
  let directory: Array<{ oid: string; email: string; displayName: string | null; department: string | null; jobTitle: string | null }> = []
  let directoryError: string | null = null
  const knownEmails = new Set(teammates.map((t) => t.email.toLowerCase()))
  try {
    const rawHits = await searchDirectory(query.q, Math.min(query.limit * 2, 50))
    directory = rawHits
      // Excluded here AND asserted again in POST /map: this filter is a UX courtesy (do not
      // offer what cannot be picked), never the enforcement point.
      .filter((h) => !isExcludedUpn(h.upn, patterns))
      .filter((h) => !!h.email && !!h.oid)
      // Already a teammate above — offering them again would invite provisioning a duplicate.
      .filter((h) => !knownEmails.has(h.email.toLowerCase()))
      .slice(0, query.limit)
      .map((h) => ({
        // The oid is what POST /map binds on; email and name are display only.
        oid: h.oid,
        email: h.email,
        displayName: h.displayName,
        department: h.department,
        jobTitle: h.jobTitle,
      }))
  } catch (err) {
    directoryError = 'unavailable'
    consola.warn(
      '[teammate-search] directory fall-through failed; returning teammate-only results',
      { error: String(err) },
    )
  }

  return { teammates, directory, directoryError }
})
