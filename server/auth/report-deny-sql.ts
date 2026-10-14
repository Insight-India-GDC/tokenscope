/*
 * The active report-access deny ('revoke-all', mig 0130) as a SQL predicate.
 * Dependency-light on purpose: dispatch.ts imports it, and the seed and the
 * workers load dispatch.ts outside Nuxt, where report-scope.ts's session
 * imports cannot resolve.
 */
import { sql, type SQL } from 'drizzle-orm'
import { REPORT_ACCESS_REVOKE } from '../../shared/auth/report-visibility'

/** `teammateId` holds an ACTIVE report-access deny (resolveReportAccessRevoked's test). */
export function activeReportDenySql(teammateId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM report_access_grant rag
    WHERE rag.teammate_id = ${teammateId}
      AND rag.permission = ${REPORT_ACCESS_REVOKE}
      AND rag.revoked_at IS NULL
      AND (rag.expires_at IS NULL OR rag.expires_at > now()))`
}
