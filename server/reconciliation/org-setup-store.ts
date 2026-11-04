/*
 * Org setup storage (docs/design/org-setup/00-spec.md): the single settings row and
 * the state of the current directory read. Routes and the placement-check worker
 * share these.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { READ_CADENCES, type OrgSetupRead, type OrgSetupSettings, type ReadCadence } from '../../shared/org-setup/contract'
import { countPlacementCheckFailed, countPlacementCheckRemaining, currentPlacementCycle } from './placement-check-store'

type Db = PostgresJsDatabase<typeof schema>

export async function loadOrgSetupSettings(db: Pick<Db, 'execute'>): Promise<OrgSetupSettings> {
  const rows = await db.execute<{
    top_oid: string | null
    top_name: string | null
    top_email: string | null
    read_cadence: string
    updated_at: string | null
  }>(sql`
    SELECT top_oid, top_name, top_email, read_cadence,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM org_setup_setting WHERE id`)
  const r = [...rows][0]
  const cadence = (READ_CADENCES as readonly string[]).includes(r?.read_cadence ?? '') ? (r!.read_cadence as ReadCadence) : 'month'
  return {
    top: r?.top_oid ? { oid: r.top_oid, name: r.top_name, email: r.top_email } : null,
    readCadence: cadence,
    updatedAt: r?.updated_at ?? null,
  }
}

export async function loadOrgSetupRead(db: Pick<Db, 'execute'>): Promise<OrgSetupRead> {
  const cycle = await currentPlacementCycle(db)
  const [remaining, failed] = await Promise.all([
    countPlacementCheckRemaining(db, cycle?.id ?? null),
    countPlacementCheckFailed(db, cycle?.id ?? null),
  ])
  return {
    cycleId: cycle?.id ?? null,
    startedAt: cycle?.startedAt ?? null,
    remaining,
    failed,
    complete: cycle != null && remaining === 0,
  }
}

/** Start of the cadence window containing `now` (UTC): the 1st of the month, or the
 *  Monday of the ISO week. A cycle started before it is due for a re-read. */
export function cadenceWindowStart(cadence: ReadCadence, now: Date): Date {
  if (cadence === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)))
}
