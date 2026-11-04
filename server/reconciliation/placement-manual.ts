/*
 * Whether a teammate's CURRENT home was set by a person. Shared by the placement
 * check's verdicts and its apply guard, which must agree.
 *
 * A derived home carries `metadata.placedVia`; a manual move strips it. Rows
 * created at sign-in before it recorded provenance carry none either, so absence
 * alone is not "manual": the latest placement audit row for the teammate must
 * also have a teammate actor (workers write none).
 */
import { sql, type SQL } from 'drizzle-orm'
import { PLACEMENT_AUDIT_EVENT } from './placement-provenance'

export const REGION_AUDIT_EVENT = 'teammate-region-reassigned'

/*
 * Provisioning events. They count only when the payload records the region and
 * unit the admin chose (POST /admin/teammates); the project and owner doors
 * (provisionDirectoryTeammate, ensureRealIdentity) write them with no
 * `org_unit_id`, landing the person on Unplaced or keeping the bill lane's home.
 */
export const TEAMMATE_PROVISIONED_EVENT = 'teammate-provisioned'
export const TEAMMATE_DIRECTORY_ADOPTED_EVENT = 'teammate-directory-adopted'

/** Boolean SQL over teammate alias `t`. */
export function manualPlacementSql(t: SQL): SQL {
  return sql`(NOT COALESCE(${t}.metadata ? 'placedVia', false) AND COALESCE((
    SELECT a.actor_teammate_id IS NOT NULL
    FROM audit_event a
    WHERE a.subject_kind = 'teammate' AND a.subject_id = ${t}.id
      AND (a.event_type IN (${PLACEMENT_AUDIT_EVENT}, ${REGION_AUDIT_EVENT})
        OR (a.event_type IN (${TEAMMATE_PROVISIONED_EVENT}, ${TEAMMATE_DIRECTORY_ADOPTED_EVENT})
            AND a.payload ? 'org_unit_id'))
    ORDER BY a.ts_recorded DESC
    LIMIT 1
  ), false))`
}
