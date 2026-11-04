/*
 * Which audit events an admin caller may read.
 *
 * audit_event has no region_id: an event belongs to a region through its
 * actor (actor_teammate_id → teammate.region_id) or, for events about a
 * teammate, through its subject. A region admin sees the events whose actor OR
 * teammate subject is in their home region; a platform-admin sees everything.
 * The RLS policy on audit_event is admin-broad, so this clause is the region
 * boundary. Shared by the event list and its filter facets so the two can never
 * disagree about what the caller may see.
 *
 * The SQL expects the audit table aliased as `ae`.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { Role } from '../../shared/auth/roles'

export function auditRegionScopeClause(session: { role: Role; regionId: string }): SQL {
  if (session.role !== 'admin') return sql``
  return sql`AND (
      EXISTS (
        SELECT 1 FROM teammate ta_scope
        WHERE ta_scope.id = ae.actor_teammate_id
          AND ta_scope.region_id = ${session.regionId}::uuid
      )
      OR (
        ae.subject_kind = 'teammate' AND EXISTS (
          SELECT 1 FROM teammate ts_scope
          WHERE ts_scope.id = ae.subject_id
            AND ts_scope.region_id = ${session.regionId}::uuid
        )
      )
    )`
}
