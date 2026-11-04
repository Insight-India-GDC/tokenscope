/*
 * grantReportAccess — dependency-light raw-SQL helper for inserting
 * `report_access_grant` rows (mig 0129) in integration suites.
 *
 * Mirrors how suites already hand-insert fixture rows against `TestDb['client']`
 * (a postgres.js tagged-template client — see tests/integration/helpers/db.ts) —
 * no drizzle schema import, no transaction, just the row(s) the caller asked for.
 * `granted_by` is always NULL here (system/test-fixture grant, same convention
 * mig 0129's backfill uses); tests asserting `granted_by` attribution use the
 * admin POST endpoint directly instead (see tests/integration/admin/report-access.test.ts).
 *
 * Default with NO permissions named: grant BOTH ('operational' and 'finance') —
 * the common case for a suite that just needs an org-wide persona to be fully
 * elevated, one call, no literal list to keep in sync with
 * REPORT_ACCESS_PERMISSIONS.
 */
import type { TestDb } from './db'
import { REPORT_ACCESS_PERMISSIONS, type ReportAccessPermission } from '../../../shared/auth/report-visibility'

export async function grantReportAccess(
  client: TestDb['client'],
  teammateId: string,
  ...permissions: ReportAccessPermission[]
): Promise<void> {
  const perms: ReportAccessPermission[] = permissions.length > 0 ? permissions : [...REPORT_ACCESS_PERMISSIONS]
  for (const permission of perms) {
    await client`INSERT INTO report_access_grant (teammate_id, permission, granted_by)
      VALUES (${teammateId}::uuid, ${permission}, NULL)`
  }
}
