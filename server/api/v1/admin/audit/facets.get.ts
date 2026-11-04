/*
 * GET /api/v1/admin/audit/facets — the options for the Audit log's filters.
 *
 * The event-type filter used to be built from the 50 events on screen, so a
 * type absent from the current page could not be chosen at all. This returns
 * every event type, every teammate actor and every system actor that occurs in
 * the audit the caller may read, so each filter offers the full set.
 *
 * Same RBAC and region scope as the list (index.get.ts): requireRole(admin),
 * withRequestRls, and auditRegionScopeClause, so a region admin is never offered
 * an option drawn from events they cannot see.
 *
 * `actors` are teammates (filter with actorTeammateId); `systems` are actors
 * with no teammate (filter with actorSystem). Both are capped at ACTOR_CAP; the
 * response says when a list was cut, so the page can say so rather than
 * presenting a partial list as complete.
 *
 * COST: each list is a DISTINCT over every audit row the caller may read, with
 * no time bound, run once per Audit log visit (admins only). That is deliberate:
 * a time window would hide a type or actor whose events are older than it, the
 * same "can't choose what isn't on screen" defect this replaces. The type and
 * teammate lists read through audit_event_type_ts / audit_event_actor_ts (0001).
 * If the table grows to where this is slow, bound it to a window the page names.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { auditRegionScopeClause } from '../../../../utils/audit-scope'

const ACTOR_CAP = 500

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const scope = auditRegionScopeClause(session)

  return withRequestRls(event, async (tx) => {
    const types = await tx.execute<{ event_type: string }>(sql`
      SELECT DISTINCT ae.event_type
      FROM audit_event ae
      WHERE TRUE ${scope}
      ORDER BY ae.event_type
    `)
    const actors = await tx.execute<{ id: string; email: string | null }>(sql`
      SELECT DISTINCT ae.actor_teammate_id::text AS id, ta.email
      FROM audit_event ae
      JOIN teammate ta ON ta.id = ae.actor_teammate_id
      WHERE TRUE ${scope}
      ORDER BY ta.email, id
      LIMIT ${ACTOR_CAP + 1}
    `)
    const systems = await tx.execute<{ actor_system: string }>(sql`
      SELECT DISTINCT ae.actor_system
      FROM audit_event ae
      WHERE ae.actor_teammate_id IS NULL AND ae.actor_system IS NOT NULL ${scope}
      ORDER BY ae.actor_system
      LIMIT ${ACTOR_CAP + 1}
    `)
    const actorRows = [...actors]
    const systemRows = [...systems]
    return {
      eventTypes: [...types].map((r) => r.event_type),
      actors: actorRows.slice(0, ACTOR_CAP).map((r) => ({ teammateId: r.id, email: r.email })),
      systems: systemRows.slice(0, ACTOR_CAP).map((r) => r.actor_system),
      truncated: actorRows.length > ACTOR_CAP || systemRows.length > ACTOR_CAP,
    }
  })
})
