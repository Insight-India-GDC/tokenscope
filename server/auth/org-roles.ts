/*
 * org-roles — capability gates derived from RELATIONSHIP rows, not
 * role-enum entries (J1, mig 0048):
 *
 *   - CC ownership: an active cou_owner row. The P&L owner is typically
 *     2-3 levels removed from developers in the org chart, so this is an
 *     explicit assignment — a teammate of ANY role can be a CC owner.
 *   - Project management: project_assignment.role = 'manager' with a
 *     currently-effective range. A PM may manage their project's budget
 *     top-ups regardless of their org role.
 *
 * Like assertProjectScope, these are the LIVE gates — RLS is inert at
 * runtime (owner DB connection) until Epic 10's non-owner role lands,
 * so every CC-owner / PM read path must call these app-side.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { GOV_PROJECTS_PM_OWN_REGION_ONLY } from '../utils/governance-settings'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Active cost-owning units the teammate owns (empty array = not an owner). */
export async function getOwnedCostCentreIds(db: Db, teammateId: string): Promise<string[]> {
  const rows = await db.execute<{ org_unit_id: string }>(sql`
    SELECT org_unit_id::text AS org_unit_id
    FROM cou_owner
    WHERE teammate_id = ${teammateId}::uuid AND revoked_at IS NULL
  `)
  return [...rows].map((r) => r.org_unit_id)
}

/**
 * True when the teammate holds a currently-effective PM assignment on the project.
 * `at` is the request clock (requestClock(event).now); omitted, SQL's now() is used.
 */
export async function isProjectManager(
  db: Db,
  teammateId: string,
  projectId: string,
  at?: string,
): Promise<boolean> {
  const instant = at === undefined ? sql`now()` : sql`${at}::timestamptz`
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT TRUE AS ok
    FROM project_assignment
    WHERE project_id = ${projectId}::uuid
      AND teammate_id = ${teammateId}::uuid
      AND role = 'manager'
      AND effective @> ${instant}
    LIMIT 1
  `)
  return [...rows].length > 0
}

/*
 * NOTE (review R1-F4): an earlier requireProjectBudgetAuthority helper
 * was removed — it admitted 'admin' without region scope, and handlers
 * need the project row anyway, so the dual gate is inlined at each call
 * site (allocations [id].get / topups.post) where the scope predicate
 * can be applied correctly. Don't reintroduce a role-only shortcut here.
 */

/** Who creates a project. Connectors (Pathway, later Helios) are reserved: no v1 caller. */
export type ProjectCreatorActor =
  | { kind: 'teammate'; teammateId: string }
  | { kind: 'connector'; connectorId: string }

export type CanCreateProjectsVerdict =
  | { ok: true }
  | { ok: false; reason: 'not-on-list' | 'outside-own-region' | 'no-placement-region' | 'connector-unsupported' }

/**
 * The teammate as a Project managers list holder: present only when they hold a
 * live grant (mig 0164) AND are an active teammate. The one definition both
 * `canCreateProjects` and GET /me/capabilities read, so the hint cannot offer
 * what the create refuses.
 */
async function activeProjectManager(db: Db, teammateId: string): Promise<{ region_id: string | null } | null> {
  const rows = await db.execute<{ region_id: string | null }>(sql`
    SELECT t.region_id::text AS region_id
    FROM teammate t
    WHERE t.id = ${teammateId}::uuid
      AND t.is_active
      AND EXISTS (SELECT 1 FROM project_manager_grant g
                   WHERE g.teammate_id = t.id AND g.revoked_at IS NULL)
  `)
  return [...rows][0] ?? null
}

/** True when the teammate is an active holder of a live PMO-list grant. */
export async function isActiveProjectManager(db: Db, teammateId: string): Promise<boolean> {
  return (await activeProjectManager(db, teammateId)) !== null
}

/** The platform value of `projects.pm_own_region_only` (A4): true = own region only. */
export async function pmOwnRegionOnly(db: Db): Promise<boolean> {
  const rows = await db.execute<{ v: string }>(sql`
    SELECT value_numeric::text AS v FROM governance_setting
    WHERE key = ${GOV_PROJECTS_PM_OWN_REGION_ONLY} AND scope_type = 'platform'
  `)
  const row = [...rows][0]
  if (!row) {
    throw new Error(`governance_setting has no platform row for '${GOV_PROJECTS_PM_OWN_REGION_ONLY}' (mig 0164)`)
  }
  return Number(row.v) === 1
}

/**
 * The one PMO-list gate (spec §1, A4): may this actor create a project in
 * `regionId` without approval? Only the PMO create path asks it — admins and
 * request approvals are gated by their own region scope. With the own-region
 * switch on, `regionId` must be the teammate's current placement
 * (teammate.region_id, the current-org lens).
 */
export async function canCreateProjects(
  db: Db,
  actor: ProjectCreatorActor,
  regionId: string,
): Promise<CanCreateProjectsVerdict> {
  if (actor.kind === 'connector') return { ok: false, reason: 'connector-unsupported' }
  const holder = await activeProjectManager(db, actor.teammateId)
  if (!holder) return { ok: false, reason: 'not-on-list' }
  if (await pmOwnRegionOnly(db)) {
    if (!holder.region_id) return { ok: false, reason: 'no-placement-region' }
    if (holder.region_id !== regionId) return { ok: false, reason: 'outside-own-region' }
  }
  return { ok: true }
}
