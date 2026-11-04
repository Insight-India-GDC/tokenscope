/*
 * GET /api/v1/projects/{id}/consumption — month-to-date consumption
 * total for a project, irrespective of the caller's assignment.
 *
 * Used by the allocator editor's ConsumptionCard so managers viewing
 * a project they aren't assigned to still see real numbers (rather
 * than $0 from a /me-scoped fetch).
 *
 * ONE LANE. The figure comes from `completeProjectSpend`
 * (server/usage/complete-spend.ts) — the same call, window and
 * `excludeProvisional` option the project page and the budget alert make.
 * It used to be a bespoke `SUM(attribution_record.cost_usd)` here, which
 * meant "Manage budget →" walked the PM from the project page's number to a
 * DIFFERENT one at the exact moment they decided whether to extend, and both
 * were blind to the reconciled (arm 2) spend that the alert already counted.
 *
 * Spec A1/A15: a current PM of THIS project is also admitted, whatever their
 * org role, so a developer-role PM sees their own project's totals. That arm is
 * tried first and reads real numbers; every other caller goes through the
 * unchanged gate below.
 *
 * Scope: managers see consumption only for projects whose
 * cost_owning_unit is within their org subtree (app.user_org_path); a
 * region `admin` is bounded to the project's region via
 * requireRegionScope (API-1 — the same requireRegionScope pattern the
 * admin/* endpoints apply); platform-admin /
 * platform-admin are unbounded. This app-level clamp is the ONLY gate: RLS is
 * dormant by decision, so the attribution_record policy cannot be leaned on.
 * Same rationale as server/auth/allocation-scope.ts. An out-of-subtree project
 * id returns 0 (no row) for a manager, never another org's sum.
 *
 * S3: the in-query clause is orgSubtreeScopePredicate('cou') — the SAME
 * region-clamp + placedBelowRegionRootPredicate() gate every other
 * subtree-scoped surface uses, replacing a hand-rolled `role IN
 * ('admin','platform-admin') OR cou.path <@ …` that carried NO region term
 * (org_unit paths are only unique per-region, so a manager's path could
 * collide with a foreign region's) and never checked the manager's OWN
 * placement was a genuine, non-root home.
 *
 * The clamp is now an ADMISSION query (does this caller see this project at
 * all?) run before the spend read, rather than a LEFT JOIN inside it. Same
 * predicate, same gate, same "0 for an out-of-subtree id" behaviour — it just
 * no longer forces the spend sum to be a second, bespoke definition.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth, requireRegionScope } from '../../../../auth/rbac'
import { isProjectManager } from '../../../../auth/org-roles'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { requestClock } from '../../../../utils/request-clock'
import { orgSubtreeScopePredicate } from '../../../../auth/org-subtree-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { monthToDateWindow } from '../../../../utils/period'
import { completeOneProjectSpend } from '../../../../usage/complete-spend'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const hasOrgRole =
    isPlatformAdmin(session.role) || session.role === 'manager' || session.role === 'admin'

  // MONTH TO DATE — ends at now, not at the month end (server/utils/period.ts).
  const window = monthToDateWindow()

  // The project's region lookup moved INSIDE the RLS transaction. It reads
  // `project`, which is in the design's PHASE-1 FORCE set (§Rollout) — on the bare
  // pool that SELECT returns zero rows under FORCE and every caller gets a 404
  // for a project that exists. Silent, and on the money path.
  return await withRequestRls(event, async (tx) => {
    // The PM arm, before the project lookup: a caller with no org role who is
    // not this project's PM gets the same 403 whether or not the id exists.
    const isPm = await isProjectManager(tx, session.teammateId, id, requestClock(event).now)
    if (!isPm && !hasOrgRole) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: "Only this project's managers, a manager in scope, or an admin can read its consumption.",
        },
      })
    }
    if (!isPm) {
      // Region-bound the admin to the PROJECT's region before reading any spend
      // (API-1): without this, a region-scoped admin could read any project's
      // consumption cross-region by id — the breakdown/export endpoints close the
      // identical hole via requireRegionScope. Managers are NOT region-gated here
      // (requireRegionScope would deny them outright); their bound is the
      // org-subtree predicate in the admission query below.
      const projRows = await tx.execute<{ region_id: string }>(sql`
        SELECT region_id::text AS region_id FROM project WHERE id = ${id}::uuid LIMIT 1
      `)
      const proj = [...projRows][0]
      if (!proj) {
        throw createError({ statusCode: 404, statusMessage: 'Project not found' })
      }
      if (session.role !== 'manager') {
        await requireRegionScope(event, proj.region_id)
      }

      // Admission: the org-subtree clamp, unchanged. No row = out of scope, which
      // returns the same zero payload it always did (never another org's sum).
      const admitted = await tx.execute<{ ok: number }>(sql`
        SELECT 1 AS ok
          FROM project p
          JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
         WHERE p.id = ${id}::uuid
           AND ${orgSubtreeScopePredicate('cou')}
         LIMIT 1
      `)
      if ([...admitted].length === 0) {
        return { project_id: id, total_cost_usd: '0.00', total_tokens: 0, reconciled_cost_usd: '0.00' }
      }
    }

    const spend = await completeOneProjectSpend(tx, id, window, { excludeProvisional: true })
    return {
      project_id: id,
      total_cost_usd: spend.costUsd.toFixed(2),
      total_tokens: spend.tokens,
      // The share with no model axis and no presence in `attribution_aggregate`
      // — surfaced so the editor can say where the number came from rather than
      // let a PM assume it is all emitted telemetry.
      reconciled_cost_usd: spend.reconciledUsd.toFixed(2),
    }
  })
})
