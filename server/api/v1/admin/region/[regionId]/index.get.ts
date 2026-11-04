/*
 * GET /api/v1/admin/region/{regionId} — Region-scoped admin landing
 * payload. Mirrors the existing /api/v1/admin/region shape but
 * scopes to the requested region. Used by the Epic 13 6-tab admin
 * page.
 *
 * Region access: caller must either be a platform-admin / admin with
 * matching region OR be assigned to the region (RLS enforced
 * downstream). The same-region constraint is enforced here so an
 * APAC admin querying region=EMEA gets a 403, not empty rows.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { HOLDING_UNIT_TYPE } from '../../../../../../shared/placement/holding-nodes'

interface CountRow extends Record<string, unknown> {
  entity: string
  count: string
}

interface RegionRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const regionId = requireUuidParam(event, 'regionId')
  await requireRegionScope(event, regionId)

  return await withRequestRls(event, async (tx) => {
    const region = await tx.execute<RegionRow>(sql`
      SELECT id::text AS id, code, display_name
      FROM region WHERE id = ${regionId}::uuid
    `)
    const regionRow = [...region][0]
    if (!regionRow) {
      throw createError({ statusCode: 404, statusMessage: 'Region not found' })
    }

    const counts = await tx.execute<CountRow>(sql`
      SELECT 'org_units' AS entity, COUNT(*)::text AS count FROM org_unit WHERE region_id = ${regionId}::uuid
      UNION ALL
      SELECT 'bus' AS entity, COUNT(*)::text AS count FROM org_unit WHERE region_id = ${regionId}::uuid AND unit_type = 'bu'
      UNION ALL
      SELECT 'teammates' AS entity, COUNT(*)::text AS count FROM teammate WHERE region_id = ${regionId}::uuid AND is_active = TRUE
      UNION ALL
      -- C6: teammates still on a HOLDING node — region known, cost centre not, so
      -- their spend reaches the region and stops there. Keyed on unit_type, not on
      -- the holding-node CODE, per shared/placement/holding-nodes.ts: a holding
      -- node is defined by BEING one, and a second holding node under a different
      -- code must still count.
      SELECT 'teammates_unplaced' AS entity, COUNT(*)::text AS count
        FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
       WHERE t.region_id = ${regionId}::uuid AND t.is_active = TRUE
         AND ou.unit_type = ${HOLDING_UNIT_TYPE}
      UNION ALL
      SELECT 'projects' AS entity, COUNT(*)::text AS count FROM project WHERE region_id = ${regionId}::uuid
      UNION ALL
      SELECT 'projects_onboarded' AS entity, COUNT(*)::text AS count FROM project WHERE region_id = ${regionId}::uuid AND is_onboarded = TRUE
      UNION ALL
      SELECT 'repos_mapped' AS entity, COUNT(*)::text AS count
        FROM repo_project_map rpm JOIN project p ON p.id = rpm.project_id
       WHERE p.region_id = ${regionId}::uuid
      UNION ALL
      SELECT 'admins' AS entity, COUNT(*)::text AS count
        FROM teammate WHERE region_id = ${regionId}::uuid AND role = 'admin' AND is_active = TRUE
      UNION ALL
      SELECT 'cous' AS entity, COUNT(*)::text AS count
        FROM org_unit WHERE region_id = ${regionId}::uuid AND is_cost_owning_unit AND retired_at IS NULL
      UNION ALL
      SELECT 'cous_with_owner' AS entity, COUNT(DISTINCT co.org_unit_id)::text AS count
        FROM cou_owner co JOIN org_unit ou ON ou.id = co.org_unit_id
       WHERE ou.region_id = ${regionId}::uuid AND ou.retired_at IS NULL AND co.revoked_at IS NULL
      UNION ALL
      SELECT 'projects_with_pm' AS entity, COUNT(DISTINCT pa.project_id)::text AS count
        FROM project_assignment pa JOIN project p ON p.id = pa.project_id
       WHERE p.region_id = ${regionId}::uuid AND pa.role = 'manager' AND pa.effective @> now()
    `)
    const counters: Record<string, number> = {}
    for (const r of counts) counters[r.entity] = Number(r.count)

    // Connector status. No finance- or HR-system connector exists, for any
    // region, so every region reports 'none'. This used to return design-time
    // pilot defaults (APAC "planned"), which the Connectors tab rendered as if
    // they were real state. When a connector table exists, read it here.
    const connector: { label: string; status: 'configured' | 'none' } = { label: 'None', status: 'none' }

    // Checklist computed from real counts (API-16 — the repos / admin-roles
    // rows previously carried fabricated literals; every figure below now
    // comes from the counts query above).
    const reposMapped = counters.repos_mapped ?? 0
    const adminCount = counters.admins ?? 0
    const totalTeammates = counters.teammates ?? 0
    const unplacedTeammates = counters.teammates_unplaced ?? 0
    const checklist = [
      {
        key: 'org-units',
        label: 'Create org-unit skeleton',
        status: (counters.org_units ?? 0) >= 4 ? 'done' : 'in_progress',
        sub: `${counters.org_units ?? 0} sub-OU / team rows created`,
      },
      {
        key: 'teammates',
        label: 'Add teammates',
        status: (counters.teammates ?? 0) >= 50 ? 'done' : 'in_progress',
        sub: `${counters.teammates ?? 0} added · CSV or per-row`,
      },
      {
        key: 'projects',
        label: 'Add projects',
        status: (counters.projects ?? 0) >= 5 ? 'done' : 'in_progress',
        sub: `${counters.projects_onboarded ?? 0} onboarded · ${Math.max(0, (counters.projects ?? 0) - (counters.projects_onboarded ?? 0))} catalogue-only`,
      },
      {
        key: 'repos',
        label: 'Bind repos to projects',
        status: reposMapped > 0 ? 'done' : 'todo',
        sub: `${reposMapped} repos mapped to projects`,
      },
      {
        key: 'admin-roles',
        label: 'Confirm bootstrap admin roles',
        status: adminCount > 0 ? 'done' : 'todo',
        sub: `${adminCount} admin${adminCount === 1 ? '' : 's'} assigned`,
      },
      // J4 (mig 0048): the org-setup journey's two relationship steps —
      // every cost-owning unit gets a P&L owner; every project gets a PM.
      {
        key: 'cou-owners',
        label: 'Assign Business Unit owners',
        status:
          (counters.cous ?? 0) > 0 && (counters.cous_with_owner ?? 0) >= (counters.cous ?? 0)
            ? 'done'
            : (counters.cous_with_owner ?? 0) > 0
              ? 'in_progress'
              : 'todo',
        sub: `${counters.cous_with_owner ?? 0} of ${counters.cous ?? 0} Business Units have an owner`,
      },
      /*
       * C6 — the largest attribution defect in the product, stated as a checklist
       * item because the Cost centres tab shows the count and offers no action
       * that changes it.
       *
       * The three states are about PEOPLE, not about whether the tree exists:
       *   done        — nobody is on the holding node. Includes a region with no
       *                 teammates at all: there is nothing to place, which is
       *                 genuinely done, not "todo".
       *   in_progress — some placed, some not.
       *   todo        — every teammate in the region is unplaced. Nothing has
       *                 started.
       * The sub-label carries both counts because "290" alone does not say
       * whether that is most of the region or a handful.
       */
      {
        key: 'teammates-placed',
        label: 'Place teammates in Business Units',
        status:
          unplacedTeammates === 0
            ? 'done'
            : unplacedTeammates >= totalTeammates
              ? 'todo'
              : 'in_progress',
        sub:
          unplacedTeammates === 0
            ? totalTeammates === 0
              ? 'No teammates in this region yet'
              : `All ${totalTeammates} teammates are in a Business Unit`
            : `${unplacedTeammates} of ${totalTeammates} teammates are not in a Business Unit — their spend reaches the region and stops there`,
      },
      {
        key: 'project-pms',
        label: 'Designate project managers',
        status:
          (counters.projects ?? 0) > 0 && (counters.projects_with_pm ?? 0) >= (counters.projects ?? 0)
            ? 'done'
            : (counters.projects_with_pm ?? 0) > 0
              ? 'in_progress'
              : 'todo',
        sub: `${counters.projects_with_pm ?? 0} of ${counters.projects ?? 0} projects have a PM`,
      },
    ]
    // Progress is computed as item-count fraction; items are NOT
    // weighted (adding teammates is harder than confirming admin
    // roles, but the macro bar reads "% of items done" — a coarser,
    // honest measure). Per-item weights land in a later slice if
    // operators ask for a more nuanced bar.
    const doneCount = checklist.filter((c) => c.status === 'done').length
    const inProgress = checklist.filter((c) => c.status === 'in_progress').length
    const todoCount = checklist.filter((c) => c.status === 'todo').length

    return {
      region: regionRow,
      counts: counters,
      connector,
      checklist: {
        items: checklist,
        progress_pct: Math.round((doneCount / checklist.length) * 100),
        done: doneCount,
        in_progress: inProgress,
        todo: todoCount,
      },
    }
  })
})
