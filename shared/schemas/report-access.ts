import { z } from 'zod'
import { REPORT_ACCESS_PERMISSIONS } from '../auth/report-visibility'

/*
 * POST /api/v1/admin/report-access body — write ONE report-access grant for ONE
 * teammate, optionally time-boxed. `permission` is validated against the ONE
 * source of truth (REPORT_ACCESS_PERMISSIONS in shared/auth/report-visibility.ts),
 * so the API can never accept a value the enforcement layer or the DB CHECK
 * doesn't understand. snake_case keys per admin API convention.
 *
 * The readonly literal tuple is passed to `z.enum` UNCAST so
 * `ReportAccessGrantBody['permission']` infers the literal union; a cast to
 * `[string, ...string[]]` would widen it to plain `string`.
 */
export const ReportAccessGrantBody = z.object({
  teammate_id: z.string().uuid(),
  permission: z.enum(REPORT_ACCESS_PERMISSIONS),
  expires_at: z.string().datetime({ offset: true }).optional(),
})
export type ReportAccessGrantBody = z.infer<typeof ReportAccessGrantBody>
