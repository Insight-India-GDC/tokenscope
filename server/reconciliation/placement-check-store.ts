/*
 * Storage for the placement check (docs/design/placement-check/00-spec.md P4):
 * cycles, the per-pass queue, and the evidence rows. The worker writes through the
 * worker lane; the routes read and start cycles on the request lane.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import type { ChainLink, WalkEnd } from '../../shared/placement/placement-check'
import type { ReadCadence } from '../../shared/org-setup/contract'
import { recordAuditEvent } from '../db/audit'
import { makePlacementStore } from './placement-store'
import { MAX_CHAIN_HOPS, directoryAttributesOf, type PlacementConfig, type PlacementEvidence } from './region-derivation'

type Db = PostgresJsDatabase<typeof schema>

/** People one pass considers at most. */
export const PLACEMENT_CHECK_PASS_LIMIT = 150

/** Seeded demo teammates (drizzle/seed.ts, DEMO_PERSONAS) carry this email prefix and
 *  exist in no directory. */
const DEMO_EMAIL_PREFIX = 'demo-'

const FAILED_WALK_ENDS: readonly WalkEnd[] = ['graph-error', 'not-in-directory']

/** Who the check covers: active, real (not a provisional shadow), not demo data.
 *  `t` is the teammate alias. Shared by the queue, `remaining` and the read side. */
export function placementCheckPopulationSql(t: SQL): SQL {
  return sql`(${t}.is_active AND NOT ${t}.provisional
    AND ${t}.entra_oid NOT LIKE 'provisional:%'
    AND lower(${t}.email) NOT LIKE ${`${DEMO_EMAIL_PREFIX}%`})`
}

export interface PlacementCycle {
  id: string
  startedAt: string
}

export async function currentPlacementCycle(db: Pick<Db, 'execute'>): Promise<PlacementCycle | null> {
  const rows = await db.execute<{ id: string; started_at: string }>(sql`
    SELECT id::text AS id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
    FROM placement_check_cycle
    ORDER BY started_at DESC, id DESC
    LIMIT 1`)
  const r = [...rows][0]
  return r ? { id: r.id, startedAt: r.started_at } : null
}

export async function startPlacementCycle(db: Pick<Db, 'execute'>, startedBy: string | null): Promise<PlacementCycle> {
  const rows = await db.execute<{ id: string; started_at: string }>(sql`
    INSERT INTO placement_check_cycle (started_by) VALUES (${startedBy}::uuid)
    RETURNING id::text AS id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at`)
  const r = [...rows][0]!
  return { id: r.id, startedAt: r.started_at }
}

/**
 * Start a system cycle unless one started at or after `since` already exists; null
 * when one does. The check and the insert are one statement under a SHARE ROW
 * EXCLUSIVE table lock, which an admin's plain INSERT (cycle.post.ts) conflicts
 * with: a cycle the admin is committing is waited for and then seen, and an admin
 * starting one while this runs waits for it, so neither side supersedes the other.
 *
 * The `placement-check-started` audit row is written in the same transaction as the
 * cycle (as cycle.post.ts does for an admin's): an audit failure rolls the cycle
 * back, so the next run starts it again rather than leaving one with no record.
 */
export async function startPlacementCycleIfNoneSince(
  db: Pick<Db, 'transaction'>,
  since: Date,
  audit: { readCadence: ReadCadence },
): Promise<PlacementCycle | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE placement_check_cycle IN SHARE ROW EXCLUSIVE MODE`)
    const rows = await tx.execute<{ id: string; started_at: string }>(sql`
      INSERT INTO placement_check_cycle (started_by)
      SELECT NULL::uuid
      WHERE NOT EXISTS (SELECT 1 FROM placement_check_cycle WHERE started_at >= ${since.toISOString()}::timestamptz)
      RETURNING id::text AS id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at`)
    const r = [...rows][0]
    if (!r) return null
    await recordAuditEvent(tx, {
      eventType: 'placement-check-started',
      actorSystem: 'placement-check',
      subjectKind: 'placement_check_cycle',
      subjectId: r.id,
      payload: { cycle_id: r.id, trigger: 'schedule', read_cadence: audit.readCadence },
    })
    return { id: r.id, startedAt: r.started_at }
  })
}

export interface PlacementCheckQueueRow {
  id: string
  entraOid: string
  email: string
}

/**
 * The next people to gather, oldest evidence first. Normally: everyone not yet
 * gathered in `cycleId`. With `retryFailed`: only people whose evidence in `cycleId`
 * is a failed lookup.
 */
export async function selectPlacementCheckQueue(
  db: Pick<Db, 'execute'>,
  opts: { cycleId: string; retryFailed: boolean; limit: number },
): Promise<PlacementCheckQueueRow[]> {
  const pending = opts.retryFailed
    ? failedInCycleSql(opts.cycleId)
    : sql`(pe.teammate_id IS NULL OR pe.cycle_id <> ${opts.cycleId}::uuid)`
  const rows = await db.execute<{ id: string; entra_oid: string; email: string }>(sql`
    SELECT t.id::text AS id, t.entra_oid, t.email
    FROM teammate t
    LEFT JOIN placement_evidence pe ON pe.teammate_id = t.id
    WHERE ${placementCheckPopulationSql(sql`t`)} AND ${pending}
    ORDER BY pe.gathered_at ASC NULLS FIRST, t.id
    LIMIT ${opts.limit}`)
  return [...rows].map((r) => ({ id: r.id, entraOid: r.entra_oid, email: r.email }))
}

/** Evidence alias `pe` failed in `cycleId`: what "Retry failed" re-gathers. */
function failedInCycleSql(cycleId: string): SQL {
  return sql`(pe.cycle_id = ${cycleId}::uuid AND pe.walk_end IN ${[...FAILED_WALK_ENDS]})`
}

/** Population members a retry pass would re-gather; 0 when no check has started. */
export async function countPlacementCheckFailed(db: Pick<Db, 'execute'>, cycleId: string | null): Promise<number> {
  if (!cycleId) return 0
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM teammate t JOIN placement_evidence pe ON pe.teammate_id = t.id
    WHERE ${placementCheckPopulationSql(sql`t`)} AND ${failedInCycleSql(cycleId)}`)
  return Number([...rows][0]?.n ?? 0)
}

/** Population members with no evidence in `cycleId`; 0 when no check has started. */
export async function countPlacementCheckRemaining(db: Pick<Db, 'execute'>, cycleId: string | null): Promise<number> {
  if (!cycleId) return 0
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM teammate t
    WHERE ${placementCheckPopulationSql(sql`t`)}
      AND NOT EXISTS (
        SELECT 1 FROM placement_evidence pe WHERE pe.teammate_id = t.id AND pe.cycle_id = ${cycleId}::uuid
      )`)
  return Number([...rows][0]?.n ?? 0)
}

export async function upsertPlacementEvidence(
  db: Pick<Db, 'execute'>,
  row: { teammateId: string; cycleId: string; lookup: 'oid' | 'email'; evidence: PlacementEvidence },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO placement_evidence (teammate_id, gathered_at, cycle_id, lookup, attributes, chain, walk_end)
    VALUES (${row.teammateId}::uuid, clock_timestamp(), ${row.cycleId}::uuid, ${row.lookup},
            ${JSON.stringify(row.evidence.attributes)}::jsonb, ${JSON.stringify(row.evidence.chain)}::jsonb,
            ${row.evidence.walkEnd})
    ON CONFLICT (teammate_id) DO UPDATE SET
      gathered_at = EXCLUDED.gathered_at, cycle_id = EXCLUDED.cycle_id, lookup = EXCLUDED.lookup,
      attributes = EXCLUDED.attributes, chain = EXCLUDED.chain, walk_end = EXCLUDED.walk_end`)
}

/** The live rules, region leaders and unit owners, as every placement lane loads them. */
export async function loadPlacementConfig(db: Db): Promise<PlacementConfig> {
  const store = makePlacementStore(db)
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  return { rules, leaderMap, unitOwnerMap, maxHops: MAX_CHAIN_HOPS }
}

/** Stored jsonb back to evidence. Unknown attribute keys are dropped; missing ones
 *  read as null. */
export function evidenceFromRow(row: { attributes: unknown; chain: unknown; walk_end: string }): PlacementEvidence {
  const attrs = (row.attributes ?? {}) as Record<string, string | null | undefined>
  const base = directoryAttributesOf(null)
  for (const key of Object.keys(base) as Array<keyof typeof base>) base[key] = attrs[key] ?? null
  const chain = Array.isArray(row.chain) ? (row.chain as ChainLink[]) : []
  return { attributes: base, chain, walkEnd: row.walk_end as WalkEnd }
}
