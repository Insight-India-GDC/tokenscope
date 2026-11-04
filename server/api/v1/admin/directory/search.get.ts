/*
 * GET /api/v1/admin/directory/search?q=… — Entra directory people-picker.
 *
 * Backs "Add a teammate" on the admin Users page. Searches the org directory
 * (Microsoft Graph, app-only via the OIDC app registration's User.Read.All)
 * by name or email so an admin can pick a real person and provision them with
 * a resolved entra_oid — instead of pre-staging an email and hoping the JIT
 * path matches on first login.
 *
 * The directory is org-wide (not region-scoped) by nature; the region clamp
 * applies at PROVISION time (POST /admin/teammates or POST
 * /admin/projects/{id}/assignments), not here. We annotate each hit with
 * whether they're ALREADY a teammate (so the UI can disable "add" and show
 * their current placement) — joined by entra_oid.
 *
 * manager / admin / platform-admin. `manager` (a PM) is
 * included so the project-member dialog can pick ANY directory person to add
 * to a project they scope (POST assignments already allows manager). This is an
 * org-wide people-picker READ — it returns per-person directory hints
 * (display_name, email, department, job_title, cost_center, division) plus the
 * existing_region_code of anyone already provisioned. No
 * placement is minted here; the write path (assignments.post →
 * provisionDirectoryTeammate) is the mutation and stays project-scoped
 * (assertProjectScope). Acceptable per the feature spec.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { eq, inArray, sql, and, notLike } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { searchDirectory } from '../../../../azure/directory'
import { isExcludedUpn, loadDirectoryExclusionPatterns } from '../../../../utils/directory-exclusions'
import { teammate, region } from '../../../../../drizzle/schema'

const Query = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(15),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  const { q, limit } = await getValidated(event, Query)

  // Over-fetch a little so dropping admin-excluded (privileged/service) accounts
  // doesn't shrink the visible list below `limit` — same intent as the #EXT#
  // guest filter, but data-driven (#121). Fresh install has no patterns.
  const rawHits = await searchDirectory(q, Math.min(limit * 2, 50))

  // The exclusion-pattern read moved INSIDE withRequestRls: it was the entire
  // residual platform-pool read in this handler (docs/design/rls-enforcement.md — the
  // pattern-load class). `directory_exclusion_pattern` is RLS-enabled with a
  // USING(true) read policy, so it is satisfied by any context, but under FORCE
  // it needs SOME context — which the bare pool does not have.
  //
  // The directory search itself stays OUTSIDE: it is a Microsoft Graph HTTP
  // call, and holding a request transaction across third-party HTTP is the
  // anti-pattern design §2 names.
  const { hits, existing, byEmail } = await withRequestRls(event, async (tx) => {
    const patterns = await loadDirectoryExclusionPatterns(tx)
    const hits = rawHits.filter((h) => !isExcludedUpn(h.upn, patterns)).slice(0, limit)
    if (hits.length === 0) {
      return { hits, existing: new Map<string, { entraOid: string; regionCode: string }>(), byEmail: new Map<string, string>() }
    }

    // Annotate already-provisioned people by oid so the UI can show "Already a
    // teammate" + where they sit, rather than letting the admin re-add them.
    const oids = hits.map((h) => h.oid)
    const emails = [...new Set(hits.map((h) => h.email).filter(Boolean))]
    const rows = await tx
      .select({ entraOid: teammate.entraOid, regionCode: region.code })
      .from(teammate)
      .innerJoin(region, eq(region.id, teammate.regionId))
      .where(inArray(teammate.entraOid, oids))
    // #121: a dual-identity person's OTHER account may hold the teammate row —
    // an oid-only join shows their primary identity as "not a teammate" and
    // invites a doomed-looking pick. Annotate the EMAIL axis too (real rows
    // only; placeholders are not "a teammate" in the picker's sense).
    const emailRows = emails.length
      ? await tx
          .select({ email: sql<string>`lower(${teammate.email})`, entraOid: teammate.entraOid })
          .from(teammate)
          .where(
            and(
              inArray(sql`lower(${teammate.email})`, emails),
              sql`NOT ${teammate.provisional}`,
              notLike(teammate.entraOid, 'bill:%'),
            ),
          )
      : []
    return {
      hits,
      existing: new Map(rows.map((r) => [r.entraOid, r])),
      byEmail: new Map(emailRows.map((r) => [r.email, r.entraOid])),
    }
  })

  if (hits.length === 0) return { results: [] }

  return {
    results: hits.map((h) => {
      const e = existing.get(h.oid)
      const emailHolderOid = byEmail.get(h.email)
      return {
        oid: h.oid,
        email: h.email,
        display_name: h.displayName,
        department: h.department,
        job_title: h.jobTitle,
        // J4: Entra employeeOrgData placement hints — suggestion-grade only
        // (tenant population unverified; see docs/design/entra-auto-placement.md).
        cost_center: h.costCenter,
        division: h.division,
        already_member: !!e,
        existing_region_code: e?.regionCode ?? null,
        // True when this person IS a teammate but the row is bound to their
        // OTHER Entra identity (same email, different oid). Assign flows
        // converge on that row; the picker can hint instead of implying "new".
        teammate_via_other_identity: !e && emailHolderOid != null && emailHolderOid !== h.oid,
      }
    }),
  }
})
