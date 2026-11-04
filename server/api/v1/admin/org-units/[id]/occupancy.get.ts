/*
 * GET /api/v1/admin/org-units/{id}/occupancy — who is in this unit that does not
 * belong to it, and whose team they are (spec C9).
 *
 * The org-unit tree already renders the COUNTS inline; this is the list behind
 * them. It exists as its own request because the clusters are unbounded — a
 * region president owning `(default)` can catch hundreds of people across dozens
 * of managers — and putting that in the tree payload would make every render of
 * every region pay for a panel most admins have not opened.
 *
 * Both build their SQL from server/db/default-unit-occupancy.ts, so "12 of 340
 * are not direct reports" on the row and the clusters inside it are the same
 * question asked once.
 *
 * ── DEFAULT UNITS ONLY, AND IT ENFORCES IT ────────────────────────────────────
 * Every number below is catch-all arithmetic: "occupants who are not the owner's
 * direct reports" only means "landed here because no nearer owner exists" on the
 * unit the walk falls back TO, and `placement.default_unit_warn_threshold` is a
 * span-of-control dial for that unit. On an ordinary cost centre the same counts
 * are a different question with a different answer, and the threshold is nobody's
 * dial. Returning `is_default` while happily computing all of it for any unit made
 * the flag decoration; a non-default unit is refused instead. (The spec's
 * "generalises beyond default" stays a later change, with semantics of its own —
 * not an accident of an unenforced flag.)
 *
 * ── WHY THE THRESHOLD IS READ HERE AND NOT WRITTEN DOWN ───────────────────────
 * `placement.default_unit_warn_threshold` is a governance dial (mig 0049
 * precedence: a region override beats the platform baseline). Span of control
 * differs by organisation, so a constant would be one tenant's shape shipped as a
 * product rule. It is returned alongside the counts so the client renders the
 * verdict the server reached rather than re-deciding it with a number of its own.
 *
 * RBAC: admin / platform-admin, then requireRegionScope against the UNIT's region —
 * the occupants are that region's teammates.
 */
import { defineEventHandler, createError } from 'h3'
import { getValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import {
  defaultUnitManagerClustersSql,
  defaultUnitOccupancyJsonSql,
  isDefaultUnitSql,
  type DefaultUnitOccupancyCounts,
} from '../../../../../db/default-unit-occupancy'
import {
  GOV_DEFAULT_UNIT_WARN_THRESHOLD,
  resolveGovernanceSetting,
} from '../../../../../utils/governance-settings'
import { placementUsableOwnerOidsSql } from '../../../../../reconciliation/unit-owner-eligibility'

/** Enough clusters to work through; the tail is a long thin list of ones. */
const MAX_CLUSTERS = 50

const Query = z.object({
  clusters: z.coerce.number().int().positive().max(MAX_CLUSTERS).default(25),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const orgUnitId = requireUuidParam(event, 'id')
  const query = await getValidated(event, Query)

  const unit = await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{
      id: string
      region_id: string
      code: string
      display_name: string
      is_default: boolean
    }>(sql`
      SELECT ou.id::text AS id, ou.region_id::text AS region_id, ou.code, ou.display_name,
             ${isDefaultUnitSql(sql`ou`)} AS is_default
      FROM org_unit ou WHERE ou.id = ${orgUnitId}::uuid LIMIT 1
    `)
    return [...rows][0] ?? null
  })
  if (!unit) throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })
  await requireRegionScope(event, unit.region_id)
  if (!unit.is_default) {
    const detail =
      'Occupancy is the catch-all report: it counts the people a fallback unit CAUGHT, and its threshold is that unit’s span-of-control dial. Neither means anything on an ordinary Business Unit.'
    throw createError({
      statusCode: 422,
      statusMessage: detail,
      data: {
        type: 'https://tokenscope.example.com/errors/unprocessable',
        title: 'Unprocessable',
        status: 422,
        detail,
      },
    })
  }

  return await withRequestRls(event, async (tx) => {
    const unitIdSql = sql`${orgUnitId}::uuid`
    const countRows = await tx.execute<{ counts: DefaultUnitOccupancyCounts }>(sql`
      SELECT ${defaultUnitOccupancyJsonSql(unitIdSql)} AS counts
    `)
    const counts = [...countRows][0]?.counts ?? {
      occupants: 0,
      direct_reports: 0,
      not_direct_reports: 0,
      manager_unknown: 0,
    }

    /*
     * limit + 1, so "there is more" is OBSERVED rather than inferred. Asking for
     * exactly `limit` and flagging `>= limit` claims a hidden tail whenever the
     * clusters happen to land on a round number — the commonest case being a unit
     * with exactly as many managers as the default page size, where the panel says
     * "showing the largest only" over a complete list. The extra row is fetched,
     * counted, and thrown away.
     */
    const clusterRows = await tx.execute<{
      manager_oid: string | null
      manager_email: string | null
      manager_display_name: string | null
      manager_owns_unit_count: string
      people: string
    }>(defaultUnitManagerClustersSql(unitIdSql, query.clusters + 1))
    const clusterPage = [...clusterRows]
    const clustersTruncated = clusterPage.length > query.clusters
    if (clustersTruncated) clusterPage.length = query.clusters

    /*
     * The owners narrative, tagged with whether the WALK can actually place
     * through each one.
     *
     * Listing every unrevoked cou_owner while direct_reports is computed from
     * the placement-usable, unambiguous definition made the response
     * self-contradicting: an owner appeared in the narrative while none of their
     * reports could ever be counted as theirs, and the reader had no way to see
     * why. Same defect class as the counting bug this endpoint already fixed —
     * two definitions of "owner" in one payload — so it is closed the same way,
     * against the same predicate rather than a second one shaped like it.
     *
     * The row still appears: an ineligible owner is a real accountability
     * assignment and hiding it would be a different lie. It is flagged, not
     * dropped.
     */
    const owners = await tx.execute<{
      teammate_id: string
      display_name: string | null
      email: string
      places_through: boolean
    }>(sql`
      SELECT t.id::text AS teammate_id, t.display_name, t.email,
             (t.entra_oid IN ${placementUsableOwnerOidsSql(sql`${orgUnitId}::uuid`)}) AS places_through
      FROM cou_owner co JOIN teammate t ON t.id = co.teammate_id
      WHERE co.org_unit_id = ${orgUnitId}::uuid AND co.revoked_at IS NULL
      ORDER BY t.display_name NULLS LAST
    `)

    const threshold = await resolveGovernanceSetting(
      tx,
      GOV_DEFAULT_UNIT_WARN_THRESHOLD,
      unit.region_id,
    )

    const clusters = clusterPage.map((c) => ({
      manager_oid: c.manager_oid,
      // A cluster has to be nameable to be actionable. Preference order: the
      // teammate record (if this caller can see them), the email captured with
      // the oid, then an explicit "no manager" — never a bare oid.
      manager_label:
        c.manager_display_name ??
        c.manager_email ??
        (c.manager_oid ? c.manager_oid : 'No manager (top of the chart)'),
      people: Number(c.people),
      /*
       * How many active cost-owning units this manager ALREADY owns. The action
       * this row exists to prompt — "make them an owner" — turns a manager who
       * already owns one into an AMBIGUOUS owner of two, and an ambiguous owner
       * places nobody on either unit. The client offers the action only where
       * this is 0; where it is not, it says why instead.
       */
      manager_owns_unit_count: Number(c.manager_owns_unit_count ?? 0),
    }))

    return {
      org_unit: {
        id: unit.id,
        region_id: unit.region_id,
        code: unit.code,
        display_name: unit.display_name,
        is_default: unit.is_default,
      },
      owners: [...owners],
      threshold,
      occupants: Number(counts.occupants),
      direct_reports: Number(counts.direct_reports),
      not_direct_reports: Number(counts.not_direct_reports),
      /** Never looked up — shrinks by running a placement pass, not by placing. */
      manager_unknown: Number(counts.manager_unknown),
      /*
       * The verdict, on the count we can PROVE. `manager_unknown` deliberately
       * does not raise it: an estate that has never run a placement pass would
       * otherwise warn loudest while knowing least, and no amount of assigning
       * owners would bring the number down.
       */
      warn: Number(counts.not_direct_reports) > threshold,
      clusters,
      /** A further cluster EXISTS beyond the ones returned (limit + 1 came back). */
      clusters_truncated: clustersTruncated,
    }
  })
})
