/*
 * The last-PM rule (docs/design/project-requests/00-spec.md §4, amendment A5).
 *
 * Every assignment mutation that can take a PM away (remove, demote) locks the
 * project row first, so two such mutations on one project run one after the
 * other and the second sees the first's result. After its own write it counts
 * the current, open-ended PMs: if the write took a manager away and none is
 * left, a non-admin caller is refused and the transaction rolls back. A demotion
 * is judged on that after-state alone, so a last PM whose own assignment is
 * finite cannot demote themselves either. Removal ends only open-ended
 * assignments, so a removed manager was always counted before the write.
 *
 * A finite PM assignment that simply runs out is not prevented (A5).
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type Tx = PostgresJsDatabase<typeof schema>

/** SELECT … FOR UPDATE on the project row. */
export async function lockProjectRow(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM project WHERE id = ${projectId}::uuid FOR UPDATE`)
}

/**
 * Lock the project row, then return the instant the locked work is judged at:
 * the later of the request clock and the database clock read after the lock.
 *
 * A request that waited on the lock must see the change it waited for. The
 * request clock was read before the wait, and a removal ends the assignment at
 * its own, later instant (the remove route ends it at the database's now()), so
 * judged at the request clock the removed PM or member would still count.
 * GREATEST keeps a request clock a test pinned ahead of the wall clock.
 */
export async function lockProjectRowAt(tx: Tx, projectId: string, requestAt: string): Promise<string> {
  await lockProjectRow(tx, projectId)
  const [row] = await tx.execute<{ at: string }>(sql`
    SELECT to_char(GREATEST(${requestAt}::timestamptz, clock_timestamp()) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
  `)
  return row!.at
}

/** Current PMs whose assignment has no end. */
export async function countOpenEndedManagers(tx: Tx, projectId: string, at: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM project_assignment
    WHERE project_id = ${projectId}::uuid
      AND role = 'manager'
      AND effective @> ${at}::timestamptz
      AND upper_inf(effective)
  `)
  return row?.n ?? 0
}

export function lastManagerConflict() {
  return createError({
    statusCode: 409,
    statusMessage: 'This is the project’s last manager',
    data: {
      type: 'https://tokenscope.example.com/errors/last-project-manager',
      title: 'A project needs a manager',
      status: 409,
      detail:
        'This change would leave the project without a manager. Make someone else a manager first, or ask an admin.',
    },
  })
}
