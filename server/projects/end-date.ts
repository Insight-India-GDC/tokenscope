/*
 * A project's end_date write, shared by the admin PATCH /admin/projects/{id} and
 * the PM's PATCH /projects/{id}/timeline so both store the same value the same
 * way. Validation is ProjectEndDateSchema (shared/schemas/project-budget.ts).
 *
 * Moving the end date has no side effect at write time: the joiner reads it per
 * event, so spend recorded after end_date + grace goes to unallocated, and moving
 * the date later does not re-attribute what already spilled
 * (docs/design/project-lifecycle.md D2).
 */
import { sql, type SQL } from 'drizzle-orm'

/** The SET fragment for `UPDATE project SET …`. */
export function endDateAssignment(endDate: string | null): SQL {
  return endDate === null ? sql`end_date = NULL` : sql`end_date = ${endDate}::timestamptz`
}
