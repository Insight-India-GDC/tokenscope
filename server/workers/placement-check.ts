/*
 * placement-check — one pass of the placement check (docs/design/placement-check/
 * 00-spec.md P4): gather directory evidence for the next people in the current
 * cycle and store it. Decides nothing; verdicts are computed at read time.
 *
 * Two triggers. The admin page runs passes through dispatchWorker. The hourly
 * schedule (run-worker endpoint, `opts.scheduled`) runs runScheduledPlacementCheck:
 * it starts a cycle when the Org setup cadence says one is due, runs one pass, and once
 * the cycle is read, looks up each active unit owner and region leader once
 * (docs/design/org-setup/00-spec.md). Every person considered is stamped, a failed
 * lookup included (walk_end graph-error / not-in-directory), so the queue always
 * advances; "Retry failed" re-gathers only those rows.
 */
import { consola } from 'consola'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import {
  directoryAttributesOf,
  gatherPlacementEvidence,
  type GetManager,
  type ManagerEdge,
  type PlacementEvidence,
} from '../reconciliation/region-derivation'
import {
  PLACEMENT_CHECK_PASS_LIMIT,
  countPlacementCheckRemaining,
  currentPlacementCycle,
  selectPlacementCheckQueue,
  startPlacementCycleIfNoneSince,
  upsertPlacementEvidence,
} from '../reconciliation/placement-check-store'
import { makePlacementStore } from '../reconciliation/placement-store'
import { cadenceWindowStart, loadOrgSetupSettings } from '../reconciliation/org-setup-store'
import {
  getDirectoryUserByMailOrUpnStrict,
  getDirectoryUserByOidStrict,
  getUserManager,
  WORKER_GRAPH_RETRIES,
  type DirectoryUser,
  type GraphCallOptions,
} from '../azure/directory'

type Db = PostgresJsDatabase<typeof schema>

/** No new person is started after this. The page's request sits behind the front door,
 *  and Dev's WAF answers 504 at about 60 s; the page loops passes, so short is cheap. */
export const PLACEMENT_CHECK_BUDGET_MS = 25_000

/** No Graph attempt starts after this (a started one is bounded by GRAPH_TIMEOUT_MS), so the
 *  directory reads end by about 45 s. Database waits are not bounded; the page waits out a
 *  pass that outlives the front door. */
const GRAPH_DEADLINE_MS = 35_000

export interface PlacementCheckResult {
  cycleId: string | null
  retryFailed: boolean
  /** People whose evidence was written this pass. */
  checked: number
  /** People whose lookup failed (stored as graph-error / not-in-directory) or whose
   *  evidence could not be written. */
  errors: number
  /** Population members not yet gathered in the cycle, after this pass. */
  remaining: number
  deadlineHit: boolean
}

export async function runPlacementCheck(
  db: Db,
  opts?: {
    retryFailed?: boolean
    lookupByOid?: (oid: string) => Promise<DirectoryUser | null>
    lookupByEmail?: (email: string) => Promise<DirectoryUser | null>
    getManager?: GetManager
    limit?: number
    budgetMs?: number
    now?: () => number
  },
): Promise<PlacementCheckResult> {
  const retryFailed = opts?.retryFailed === true
  const now = opts?.now ?? Date.now
  const startedAt = now()
  const stopStartingAt = startedAt + (opts?.budgetMs ?? PLACEMENT_CHECK_BUDGET_MS)
  const graph: GraphCallOptions = { retries: WORKER_GRAPH_RETRIES, deadline: startedAt + GRAPH_DEADLINE_MS }
  const lookupByOid = opts?.lookupByOid ?? ((oid: string) => getDirectoryUserByOidStrict(oid, graph))
  const lookupByEmail = opts?.lookupByEmail ?? ((email: string) => getDirectoryUserByMailOrUpnStrict(email, graph))
  const getManager: GetManager = opts?.getManager ?? ((oid) => getUserManager(oid, graph))

  const result: PlacementCheckResult = {
    cycleId: null,
    retryFailed,
    checked: 0,
    errors: 0,
    remaining: 0,
    deadlineHit: false,
  }
  const cycle = await currentPlacementCycle(db)
  if (!cycle) return result
  result.cycleId = cycle.id

  const queue = await selectPlacementCheckQueue(db, {
    cycleId: cycle.id,
    retryFailed,
    limit: opts?.limit ?? PLACEMENT_CHECK_PASS_LIMIT,
  })
  const managerCache = new Map<string, ManagerEdge | null>()

  for (const row of queue) {
    if (now() >= stopStartingAt) {
      result.deadlineHit = true
      break
    }
    const lookup = row.entraOid.startsWith('bill:') ? 'email' : 'oid'
    let evidence: PlacementEvidence
    try {
      const dir = lookup === 'email' ? await lookupByEmail(row.email) : await lookupByOid(row.entraOid)
      evidence = await gatherPlacementEvidence(dir, { getManager, managerCache })
    } catch (err) {
      consola.warn('[placement-check] directory lookup failed', {
        teammateId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      evidence = { attributes: directoryAttributesOf(null), chain: [], walkEnd: 'graph-error' }
    }
    let failed = evidence.walkEnd === 'graph-error' || evidence.walkEnd === 'not-in-directory'
    try {
      await upsertPlacementEvidence(db, { teammateId: row.id, cycleId: cycle.id, lookup, evidence })
      result.checked += 1
    } catch (err) {
      failed = true
      consola.warn('[placement-check] evidence write failed', {
        teammateId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (failed) result.errors += 1
  }

  result.remaining = await countPlacementCheckRemaining(db, cycle.id)
  return result
}

export interface ScheduledPlacementCheckResult {
  /** 'no-top' when Org setup has no top person: nothing is read. */
  skipped: 'no-top' | null
  cycleStarted: boolean
  pass: PlacementCheckResult | null
  principals: {
    /** Active owners and leaders looked up this run. */
    checked: number
    notFound: number
    /** Graph errors: no row written, retried next run. */
    errors: number
    /** Still to look up in this cycle after this run. */
    remaining: number
  }
}

/** Real directory object ids of every active unit owner and region leader. */
async function activePrincipalOids(db: Db): Promise<string[]> {
  const store = makePlacementStore(db)
  const [leaders, owners] = await Promise.all([store.loadActiveRegionLeaders(), store.loadActiveUnitOwners()])
  const oids = new Set([...leaders.keys(), ...owners.keys()])
  return [...oids].filter((o) => !o.startsWith('bill:') && !o.startsWith('provisional:')).sort()
}

export async function runScheduledPlacementCheck(
  db: Db,
  opts?: Omit<NonNullable<Parameters<typeof runPlacementCheck>[1]>, 'retryFailed'>,
): Promise<ScheduledPlacementCheckResult> {
  const now = opts?.now ?? Date.now
  const startedAt = now()
  const stopStartingAt = startedAt + (opts?.budgetMs ?? PLACEMENT_CHECK_BUDGET_MS)
  const graph: GraphCallOptions = { retries: WORKER_GRAPH_RETRIES, deadline: startedAt + GRAPH_DEADLINE_MS }
  const lookupByOid = opts?.lookupByOid ?? ((oid: string) => getDirectoryUserByOidStrict(oid, graph))
  const result: ScheduledPlacementCheckResult = {
    skipped: null,
    cycleStarted: false,
    pass: null,
    principals: { checked: 0, notFound: 0, errors: 0, remaining: 0 },
  }

  const settings = await loadOrgSetupSettings(db)
  if (!settings.top) {
    result.skipped = 'no-top'
    return result
  }
  // One conditional insert, not read-then-insert: an admin starting a cycle between
  // the two would have been superseded by this one (and their passes with it). The
  // cycle and its audit row commit together.
  const cycle = await startPlacementCycleIfNoneSince(db, cadenceWindowStart(settings.readCadence, new Date(startedAt)), {
    readCadence: settings.readCadence,
  })
  if (cycle) result.cycleStarted = true

  // The pass and the principal lookups share one budget.
  result.pass = await runPlacementCheck(db, { ...opts, lookupByOid, now, budgetMs: Math.max(0, stopStartingAt - now()) })
  const cycleId = result.pass.cycleId
  if (!cycleId || result.pass.remaining > 0) return result

  const principals = await activePrincipalOids(db)
  const doneRows = await db.execute<{ oid: string }>(sql`
    SELECT oid FROM placement_principal_check WHERE cycle_id = ${cycleId}::uuid`)
  const done = new Set([...doneRows].map((r) => r.oid))
  const due = principals.filter((o) => !done.has(o))
  for (const oid of due) {
    if (now() >= stopStartingAt) break
    let found: boolean
    try {
      found = (await lookupByOid(oid)) != null
    } catch (err) {
      result.principals.errors += 1
      consola.warn('[placement-check] principal lookup failed', {
        oid,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    await db.execute(sql`
      INSERT INTO placement_principal_check (oid, cycle_id, checked_at, found)
      VALUES (${oid}, ${cycleId}::uuid, clock_timestamp(), ${found})
      ON CONFLICT (oid) DO UPDATE SET
        cycle_id = EXCLUDED.cycle_id, checked_at = EXCLUDED.checked_at, found = EXCLUDED.found`)
    result.principals.checked += 1
    if (!found) result.principals.notFound += 1
  }
  result.principals.remaining = due.length - result.principals.checked
  return result
}
