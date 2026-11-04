/*
 * project-authority — what a Project Manager may do on their own project
 * (docs/design/project-requests/00-spec.md §4, amendment A1).
 *
 * Two gates, deliberately different:
 *
 *   assertProjectScopeOrManager — for routes that exist today. Passes on
 *     today's gate (assertProjectScope: region admin, in-subtree manager,
 *     platform-admin) OR on a currently-effective PM assignment on this project.
 *     Org-role managers keep the access they had and gain nothing; what they
 *     may DO with it is narrowed only by the last-PM rule, which binds every
 *     caller who is not an admin (projects/last-manager.ts).
 *
 *   assertProjectManagerOrAdmin — for NEW actions (end date, deciding budget
 *     requests). Passes for a PM of this project, a platform-admin, or a region
 *     admin of the project's region. An org-role manager who is not the PM is
 *     refused.
 *
 * Both return HOW the caller was admitted, so a route can withhold what the PM
 * arm does not carry (A2: directory provisioning) and record it in the audit row.
 *
 * `tx` must be a withRequestRls transaction for this same event.
 */
import { createError, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { requireAuth } from './rbac'
import { assertProjectScope, type ProjectScope } from './project-scope'
import { isProjectManager } from './org-roles'
import { isPlatformAdmin } from '../../shared/auth/roles'
import { requestClock } from '../utils/request-clock'
import type { Session } from '../utils/auth'

type Tx = PostgresJsDatabase<typeof schema>

export interface ProjectTarget extends ProjectScope {
  id: string
}

/** The project's id, region and Business Unit path, or null when it does not exist. */
export async function loadProjectTarget(tx: Tx, projectId: string): Promise<ProjectTarget | null> {
  const rows = await tx.execute<{ id: string; region_id: string; cou_path: string }>(sql`
    SELECT p.id::text AS id, p.region_id::text AS region_id, cou.path::text AS cou_path
    FROM project p
    JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
    WHERE p.id = ${projectId}::uuid
    LIMIT 1
  `)
  const row = [...rows][0]
  return row ? { id: row.id, regionId: row.region_id, couPath: row.cou_path } : null
}

/** Platform-admin, or a region admin whose region is the project's. */
export function isProjectAdmin(session: Session, projectRegionId: string): boolean {
  if (isPlatformAdmin(session.role)) return true
  return (
    session.role === 'admin' &&
    typeof session.regionId === 'string' &&
    session.regionId !== '' &&
    session.regionId === projectRegionId
  )
}

function notAuthorised() {
  return createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/project-authority',
      title: 'Not a manager of this project',
      status: 403,
      detail: "Only this project's managers or an admin can do this.",
    },
  })
}

export type ScopeOrManagerVia = 'scope' | 'project-manager'

/**
 * Today's gate OR PM of this project (A1, existing routes). `at` is the instant
 * PM standing is judged at, as in assertProjectManagerOrAdmin: a route that
 * locked the project passes the post-lock instant (lockProjectRowAt).
 */
export async function assertProjectScopeOrManager(
  event: H3Event,
  tx: Tx,
  project: ProjectTarget,
  at: string = requestClock(event).now,
): Promise<ScopeOrManagerVia> {
  try {
    await assertProjectScope(event, project, tx)
    return 'scope'
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode !== 403) throw err
    const session = await requireAuth(event)
    if (await isProjectManager(tx, session.teammateId, project.id, at)) {
      return 'project-manager'
    }
    throw err
  }
}

export type ManagerOrAdminVia = 'admin' | 'project-manager'

/**
 * PM of this project, or an admin in scope (A1, new actions). `at` is the
 * instant PM standing is judged at; a route that locked the project passes the
 * post-lock instant (lockProjectRowAt), otherwise the request clock is used.
 */
export async function assertProjectManagerOrAdmin(
  event: H3Event,
  tx: Tx,
  project: ProjectTarget,
  at: string = requestClock(event).now,
): Promise<ManagerOrAdminVia> {
  const session = await requireAuth(event)
  if (isProjectAdmin(session, project.regionId)) return 'admin'
  if (await isProjectManager(tx, session.teammateId, project.id, at)) {
    return 'project-manager'
  }
  throw notAuthorised()
}
