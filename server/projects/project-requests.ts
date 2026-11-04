/*
 * Project requests (mig 0164, docs/design/project-requests/00-spec.md §3):
 * reads, the duplicate-name hint, and the inbox side of a request's life.
 *
 * The admin list page is the work queue; the inbox only notifies (A10). So
 * notifying never decides anything, and a decision closes every recipient's
 * copy of the request item.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../utils/sql-like'

type Tx = PostgresJsDatabase<typeof schema>

export type ProjectRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

interface RowFields {
  id: string
  status: ProjectRequestStatus
  source: string
  requester_teammate_id: string
  requester_name: string | null
  requester_email: string
  suggested_code: string | null
  display_name: string
  type: 'billable' | 'pursuit' | 'internal'
  region_id: string
  region_code: string
  region_name: string
  cost_owning_unit_id: string
  unit_name: string
  wbs_code: string | null
  end_date: Date | null
  proposed_pm_teammate_id: string
  pm_name: string | null
  pm_email: string
  budget_usd: string
  budget_from: Date
  budget_to: Date
  justification: string
  created_at: Date
  decided_by_name: string | null
  decided_at: Date | null
  decision_note: string | null
  created_project_id: string | null
  /** The project approval created, as it is NOW (the admin may have changed the proposal). */
  created_project_code: string | null
  created_project_name: string | null
}

// The index signature lets db.execute accept it; Omit<> must see RowFields
// alone, or every key widens to unknown.
type Row = RowFields & Record<string, unknown>

export type ProjectRequestView = Omit<RowFields, 'end_date' | 'budget_from' | 'budget_to' | 'created_at' | 'decided_at'> & {
  end_date: string | null
  budget_from: string
  budget_to: string
  created_at: string
  decided_at: string | null
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

function toView(r: Row): ProjectRequestView {
  return {
    ...r,
    end_date: iso(r.end_date),
    budget_from: iso(r.budget_from)!,
    budget_to: iso(r.budget_to)!,
    created_at: iso(r.created_at)!,
    decided_at: iso(r.decided_at),
  }
}

export interface ProjectRequestPage {
  requests: ProjectRequestView[]
  /** Every request matching `where`, not only the ones on this page. */
  total: number
  offset: number
  limit: number
  /** More matches follow this page (fetch `offset + limit`). */
  has_more: boolean
}

/**
 * Requests matching `where` (a predicate on alias `pr`): pending first, the
 * OLDEST pending first (the admin queue works from the front), then decided
 * ones newest first; `pr.id` breaks ties so pages never overlap or skip.
 * `total` is counted separately so a page past the end still reports it.
 */
export async function listProjectRequestsPage(tx: Tx, where: SQL, limit = 200, offset = 0): Promise<ProjectRequestPage> {
  const rows = await tx.execute<Row>(sql`
    SELECT pr.id::text AS id, pr.status, pr.source,
           pr.requester_teammate_id::text AS requester_teammate_id,
           rq.display_name AS requester_name, rq.email AS requester_email,
           pr.suggested_code, pr.display_name, pr.type,
           pr.region_id::text AS region_id, r.code AS region_code, r.display_name AS region_name,
           pr.cost_owning_unit_id::text AS cost_owning_unit_id, ou.display_name AS unit_name,
           pr.wbs_code, pr.end_date,
           pr.proposed_pm_teammate_id::text AS proposed_pm_teammate_id,
           pm.display_name AS pm_name, pm.email AS pm_email,
           pr.budget_usd::text AS budget_usd, pr.budget_from, pr.budget_to,
           pr.justification, pr.created_at,
           COALESCE(db.display_name, db.email) AS decided_by_name,
           pr.decided_at, pr.decision_note,
           pr.created_project_id::text AS created_project_id, p.code AS created_project_code,
           p.display_name AS created_project_name
    FROM project_request pr
    JOIN teammate rq ON rq.id = pr.requester_teammate_id
    JOIN teammate pm ON pm.id = pr.proposed_pm_teammate_id
    JOIN region r ON r.id = pr.region_id
    JOIN org_unit ou ON ou.id = pr.cost_owning_unit_id
    LEFT JOIN teammate db ON db.id = pr.decided_by
    LEFT JOIN project p ON p.id = pr.created_project_id
    WHERE ${where}
    ORDER BY (pr.status = 'pending') DESC,
             CASE WHEN pr.status = 'pending' THEN pr.created_at END ASC,
             COALESCE(pr.decided_at, pr.created_at) DESC,
             pr.id
    LIMIT ${limit} OFFSET ${offset}
  `)
  const [counted] = await tx.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM project_request pr WHERE ${where}`)
  const total = Number(counted?.n ?? 0)
  const list = [...rows]
  return {
    requests: list.map((r) => toView(r)),
    total,
    offset,
    limit,
    has_more: offset + list.length < total,
  }
}

/** Open requests one person may hold at once, so My projects can list them all. */
export const MAX_PENDING_PER_REQUESTER = 20

/** {@link listProjectRequestsPage}, the rows only. */
export async function listProjectRequests(tx: Tx, where: SQL, limit = 200): Promise<ProjectRequestView[]> {
  return (await listProjectRequestsPage(tx, where, limit)).requests
}

export async function loadProjectRequest(tx: Tx, id: string): Promise<ProjectRequestView | null> {
  return (await listProjectRequests(tx, sql`pr.id = ${id}::uuid`, 1))[0] ?? null
}

/**
 * Existing projects whose code or name shares a word (3+ characters) with
 * `name`, most shared words first — the duplicate hint on the request form.
 */
export async function findSimilarProjects(
  tx: Tx,
  name: string,
  limit = 8,
): Promise<{ id: string; code: string; display_name: string; region_code: string }[]> {
  const words = [...new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 6)
  if (words.length === 0) return []
  const score = sql.join(
    words.map((w) => {
      const like = `%${escapeLikeLiteral(w)}%`
      return sql`(CASE WHEN p.display_name ILIKE ${like} ESCAPE ${LIKE_ESCAPE} OR p.code ILIKE ${like} ESCAPE ${LIKE_ESCAPE} THEN 1 ELSE 0 END)`
    }),
    sql` + `,
  )
  const rows = await tx.execute<{ id: string; code: string; display_name: string; region_code: string }>(sql`
    SELECT id, code, display_name, region_code FROM (
      SELECT p.id::text AS id, p.code, p.display_name, r.code AS region_code, (${score}) AS score
      FROM project p JOIN region r ON r.id = p.region_id
    ) s
    WHERE score > 0
    ORDER BY score DESC, display_name
    LIMIT ${limit}
  `)
  return [...rows]
}

/** Tell the admins of the request's region (and platform-admins) a request is waiting. */
export async function notifyRequestSubmitted(tx: Tx, req: ProjectRequestView): Promise<void> {
  await dispatchInbox(tx, {
    category: 'project-request',
    subject: `Project request: ${req.display_name}`,
    regionId: req.region_id,
    relatedEntityKind: 'project_request',
    relatedEntityId: req.id,
    body: {
      requestId: req.id,
      displayName: req.display_name,
      requesterName: req.requester_name ?? req.requester_email,
      regionCode: req.region_code,
      unitName: req.unit_name,
      budgetUsd: req.budget_usd,
      actionHref: `/admin/project-requests/${req.id}`,
    },
  })
}

/** Close every open copy of the request's inbox item, whoever received it (A10). */
export async function closeRequestInboxItems(tx: Tx, requestId: string, byTeammateId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved', ack_at = now(), ack_by = ${byTeammateId}::uuid
     WHERE category = 'project-request'
       AND related_entity_id = ${requestId}::uuid
       AND ack_state NOT IN ('resolved', 'dismissed')
  `)
}

/** Tell the requester their request was approved or rejected. */
export async function notifyRequestDecided(
  tx: Tx,
  req: ProjectRequestView,
  decision: {
    status: 'approved' | 'rejected'
    note: string | null
    projectCode: string | null
    projectName: string | null
  },
): Promise<void> {
  await dispatchInbox(tx, {
    category: 'project-request-decided',
    severity: 'info',
    subject:
      decision.status === 'approved'
        ? `Project request approved: ${req.display_name}`
        : `Project request not approved: ${req.display_name}`,
    recipientTeammateIdHint: req.requester_teammate_id,
    relatedEntityKind: 'project_request',
    relatedEntityId: req.id,
    body: {
      requestId: req.id,
      displayName: req.display_name,
      decision: decision.status,
      note: decision.note,
      projectCode: decision.projectCode,
      projectName: decision.projectName,
      actionHref: decision.projectCode ? `/projects/${encodeURIComponent(decision.projectCode)}` : '/projects',
    },
  })
}
