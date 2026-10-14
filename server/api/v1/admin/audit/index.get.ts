/*
 * GET /api/v1/admin/audit — paginated audit-event reader for the
 * Wave-VI Admin → Audit sub-page.
 *
 * RBAC:
 *   - requireRole(admin) at the edge
 *   - withRequestRls so the audit_event RLS policy
 *     (audit_event_admin_only — `app.user_role` IN admin / global-finops)
 *     applies. RLS denial → empty rows; never 5xx.
 *
 * Region scoping: audit_event has no region_id column — actors flow
 * through actor_teammate_id → teammate.region_id. An admin caller is
 * filtered to events whose actor belongs to their home region, OR
 * whose subject is a teammate in their region, so they see the
 * footprint their region's admins generated. platform-admin sees the
 * full audit. The filter is explicit SQL on top of the RLS policy
 * (which is admin-broad, not region-scoped).
 *
 * Filters: eventType / actorTeammateId / subjectKind / since / until.
 * Pagination: limit (default 50, max 200) + offset.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'

const Query = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  eventType: z.string().max(120).optional(),
  actorTeammateId: z.string().uuid().optional(),
  subjectKind: z.string().max(60).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  event_type: string
  actor_teammate_id: string | null
  actor_email: string | null
  actor_system: string | null
  impersonator_oid: string | null
  subject_kind: string | null
  subject_id: string | null
  payload: unknown
  ts_recorded: string
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const query = await getValidated(event, Query)

  const eventTypeClause = query.eventType
    ? sql`AND ae.event_type = ${query.eventType}`
    : sql``
  const actorClause = query.actorTeammateId
    ? sql`AND ae.actor_teammate_id = ${query.actorTeammateId}::uuid`
    : sql``
  const subjectKindClause = query.subjectKind
    ? sql`AND ae.subject_kind = ${query.subjectKind}`
    : sql``
  const sinceClause = query.since
    ? sql`AND ae.ts_recorded >= ${query.since}::timestamptz`
    : sql``
  const untilClause = query.until
    ? sql`AND ae.ts_recorded < ${query.until}::timestamptz`
    : sql``
  // admin → region scope; platform-admin → full audit. The check uses
  // the caller's home region (session.regionId) so a region-A admin
  // never sees region-B's mutation trail even though the RLS policy
  // would let them. The OR-by-subject branch keeps role-change events
  // visible to the admin whose subject is in their region even if the
  // actor was a platform-admin (cross-region steward).
  const regionScopeClause =
    session.role === 'admin'
      ? sql`AND (
            EXISTS (
              SELECT 1 FROM teammate ta
              WHERE ta.id = ae.actor_teammate_id
                AND ta.region_id = ${session.regionId}::uuid
            )
            OR (
              ae.subject_kind = 'teammate' AND EXISTS (
                SELECT 1 FROM teammate ts
                WHERE ts.id = ae.subject_id
                  AND ts.region_id = ${session.regionId}::uuid
              )
            )
          )`
      : sql``

  // R2 F1: run data + COUNT inside ONE withRequestRls tx — avoids the
  // race between two separate GUC setups (a teammate.region_id change
  // mid-flight could otherwise make COUNT and rows disagree) and
  // amortises the connection / RLS-context overhead.
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT ae.id::text AS id,
             ae.event_type,
             ae.actor_teammate_id::text AS actor_teammate_id,
             ta.email AS actor_email,
             ae.actor_system,
             ae.impersonator_oid,
             ae.subject_kind,
             ae.subject_id::text AS subject_id,
             ae.payload,
             ae.ts_recorded
      FROM audit_event ae
      LEFT JOIN teammate ta ON ta.id = ae.actor_teammate_id
      WHERE TRUE
        ${eventTypeClause}
        ${actorClause}
        ${subjectKindClause}
        ${sinceClause}
        ${untilClause}
        ${regionScopeClause}
      ORDER BY ae.ts_recorded DESC, ae.id DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const countRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM audit_event ae
      WHERE TRUE
        ${eventTypeClause}
        ${actorClause}
        ${subjectKindClause}
        ${sinceClause}
        ${untilClause}
        ${regionScopeClause}
    `)
    return {
      rows: [...dataRows],
      total: Number([...countRows][0]?.total ?? 0),
    }
  })

  return {
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      actorTeammateId: r.actor_teammate_id,
      actorEmail: r.actor_email,
      actorSystem: r.actor_system,
      // The admin acting through persona override when this row was written
      // (mig 0154); the actor fields then name the persona. null otherwise.
      impersonatorOid: r.impersonator_oid,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      payload: r.payload,
      tsRecorded: r.ts_recorded,
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
