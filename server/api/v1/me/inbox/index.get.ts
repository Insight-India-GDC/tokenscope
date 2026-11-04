/*
 * GET /api/v1/me/inbox — list the authenticated dev's inbox items.
 *
 * Filters: ack_state, category, severity, limit. `ack_state=open`
 * shorthand selects unread + read + acknowledged (the unresolved
 * states); `closed` selects dismissed + resolved.
 *
 * Goes through withRequestRls so the inbox_item self-policy fires
 * once Epic 10's non-owner DB role lands.
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { allocationScopePredicate } from '../../../../auth/allocation-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { InboxListQuery } from '../../../../../shared/schemas/inbox'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'

interface InboxRow extends Record<string, unknown> {
  id: string
  category: string
  severity: string
  subject: string
  body: unknown
  related_entity_kind: string | null
  related_entity_id: string | null
  ack_state: string
  ack_at: string | null
  created_at: string
  /*
   * For items where related_entity_kind='project', this is the id of
   * the project's currently-effective baseline allocation row. The
   * drawer turns this into a /allocations/{id} link so the recipient
   * can jump straight from an alert to the live project surface
   * (consumption, top-ups, audit trail). Null for non-project entities,
   * projects with no baseline currently in effect, OR — honourable-links
   * rule — recipients who would 404 on the editor (the link is only
   * emitted when the recipient passes the editor's own dual gate).
   */
  target_allocation_id: string | null
  /*
   * For items where related_entity_kind='project', the project's CODE: the
   * drawer's "Open project →" goes to /projects/{code}. Emitted only when THIS
   * recipient passes that page's own gate (honourable-links rule): a current
   * member, an active owner of the project's Business Unit, or an admin in
   * scope of its region (platform-admin, or that region's admin), the same
   * three arms as requireProjectMembership + isProjectAdmin. Null otherwise.
   */
  target_project_code: string | null
  /*
   * Total rows matched by the filters, computed via COUNT(*) OVER ()
   * before the LIMIT clause clips the result. Use this for unread-bell
   * badges and "X of Y" pagination, NOT items.length (which is bounded
   * by query.limit).
   */
  total_matched: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (data) => InboxListQuery.parse(data))

  let ackStateFilter = sql`TRUE`
  if (query.ack_state === 'open') {
    ackStateFilter = sql`ack_state IN ('unread', 'read', 'acknowledged')`
  } else if (query.ack_state === 'closed') {
    ackStateFilter = sql`ack_state IN ('dismissed', 'resolved')`
  } else if (query.ack_state) {
    ackStateFilter = sql`ack_state = ${query.ack_state}`
  }

  const categoryFilter = query.category
    ? sql`AND category = ${query.category}`
    : sql``
  const severityFilter = query.severity
    ? sql`AND severity = ${query.severity}`
    : sql``

  // The admin arm of the project page's gate (isProjectAdmin), as SQL operands.
  const adminAnyRegion = isPlatformAdmin(session.role)
  const adminRegionId =
    session.role === 'admin' && typeof session.regionId === 'string' && session.regionId !== ''
      ? session.regionId
      : null

  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<InboxRow>(sql`
      SELECT
        i.id::text AS id, i.category, i.severity, i.subject, i.body,
        i.related_entity_kind,
        i.related_entity_id::text AS related_entity_id,
        i.ack_state, i.ack_at::text AS ack_at,
        i.created_at::text AS created_at,
        target_alloc.allocation_id AS target_allocation_id,
        target_proj.code AS target_project_code,
        COUNT(*) OVER ()::text AS total_matched
      FROM inbox_item i
      LEFT JOIN LATERAL (
        SELECT al.id::text AS allocation_id
          FROM allocation al
         WHERE al.scope_type = 'project'
           AND al.scope_id = i.related_entity_id
           AND al.allocation_kind = 'baseline'
           AND al.effective @> CURRENT_TIMESTAMP
           -- Honourable-links rule: emit the editor deep-link only when
           -- THIS recipient passes the editor's own dual gate (org-role
           -- scope OR currently-effective PM — mirrors allocations/[id]).
           -- The scope predicate is gated by the same role list the editor
           -- uses: a developer-role caller reaches the editor ONLY via the
           -- PM arm, even when the project sits in their own org subtree.
           -- A contributor who can't open the editor still gets the alert
           -- for awareness, with no dead "Add top-up" button.
           AND (
             (
               current_setting('app.user_role', true) IN ('manager', 'admin', 'global-finops')
               AND ${allocationScopePredicate('al')}
             )
             OR EXISTS (
               SELECT 1 FROM project_assignment pa
               WHERE pa.project_id = al.scope_id
                 AND pa.teammate_id = ${session.teammateId}::uuid
                 AND pa.role = 'manager'
                 AND pa.effective @> now()
             )
           )
         ORDER BY lower(al.effective) DESC
         LIMIT 1
      ) target_alloc ON i.related_entity_kind = 'project'
      LEFT JOIN LATERAL (
        SELECT p.code
          FROM project p
         WHERE p.id = i.related_entity_id
           AND (
             EXISTS (
               SELECT 1 FROM project_assignment pa
               WHERE pa.project_id = p.id
                 AND pa.teammate_id = ${session.teammateId}::uuid
                 AND pa.effective @> now()
             )
             OR EXISTS (
               SELECT 1 FROM cou_owner co
               WHERE co.org_unit_id = p.cost_owning_unit_id
                 AND co.teammate_id = ${session.teammateId}::uuid
                 AND co.revoked_at IS NULL
             )
             OR ${adminAnyRegion}::boolean
             OR p.region_id = ${adminRegionId}::uuid
           )
         LIMIT 1
      ) target_proj ON i.related_entity_kind = 'project'
      WHERE i.recipient_teammate_id = ${session.teammateId}::uuid
        AND ${ackStateFilter}
        ${categoryFilter}
        ${severityFilter}
      ORDER BY i.created_at DESC
      LIMIT ${query.limit}
    `),
  )

  const items = [...rows]
  // total_matched is the same value on every row (COUNT OVER no-partition);
  // pull it from the first row, fall back to 0 when no rows matched.
  const total = items.length === 0 ? 0 : Number(items[0]?.total_matched ?? 0)
  // Strip the helper column from the response shape so callers don't see it.
  const cleanItems = items.map(({ total_matched: _t, ...rest }) => rest)
  return { items: cleanItems, total }
})
