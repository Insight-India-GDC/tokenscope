/*
 * placement-sync — drains the owed-bill placement queue (the out-of-band half of
 * bill-driven placement; design docs/design/org-tree-and-bill-driven-placement.md).
 *
 * The money pollers ENQUEUE unknown-email bills into pending_placement (no Graph in
 * the money loop). This worker, on its own cadence, takes each distinct unplaced
 * identity and provisions+places the teammate (Entra-enriched) + replays its owed
 * bills into actual_spend — so a user who never logs in / emits still lands in their
 * cost-centre report. Graph faults are isolated here, never touching the poll.
 *
 * GRAPH FAILURE IS NOT ABSENCE. The directory lookups are the STRICT variants: a
 * throttle, 5xx or timeout throws before anything is written, so the identity is
 * skipped this run (counted in `errors`, its bills stay queued) — never provisioned
 * onto the global bucket as a "directory miss".
 *
 * DEADLINE. No new identity is started after PLACEMENT_SYNC_BUDGET_MS, and every
 * directory lookup carries the same deadline (the shared token mint has its own
 * fixed bound, ~21 s), so a throttle burst cannot hold the run
 * (and its single-flight lock) for hours. An identity not reached keeps its bills
 * unplaced, which is exactly what the selection below reads: the next run picks it
 * up, oldest-first, behind nothing newer.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from '../reconciliation/placement-store'
import { provisionAndPlace, type PlacementDerivation } from '../reconciliation/placement-service'
import { derivePlacement, makeChainCaches, type GetManager } from '../reconciliation/region-derivation'
import {
  getUserManager,
  getDirectoryUserByMailOrUpnStrict,
  WORKER_GRAPH_RETRIES,
  type DirectoryUser,
  type GraphCallOptions,
} from '../azure/directory'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

/** No new identity is started after this much of the run (the dispatch budget is
 *  200 s; Graph calls in flight are bounded by the same deadline). */
export const PLACEMENT_SYNC_BUDGET_MS = 150_000

export interface PlacementSyncResult {
  emailsConsidered: number
  provisioned: number
  placed: number
  errors: number
  // Placement-derivation coverage — counted on actual placements (created or re-homed).
  // viaUnit = a real practice (cost-owning unit, chargeable); viaAttribute (a directory
  // rule) / viaManager / viaBillingRegion = a region holding node; fellToGlobal = the
  // global bucket. `byAttribute` breaks viaAttribute down by which directory attribute
  // matched — the "which signal is placing people" coverage. `conflicts` counts placements
  // where a lower-precedence attribute matched a DIFFERENT TARGET — another region, or
  // another cost centre — which is a rule misconfig to fix; it is counted on UNIT-rule
  // placements too, because "two rules name two different cost centres for this person"
  // is the divergence that decides where their spend charges.
  // Watch the ratio before trusting the signal / running the one-shot backfill.
  viaCostCentre: number
  viaUnit: number
  /** A curated attribute rule naming a cost-owning UNIT (mig 0112). A real
   *  placement, like viaUnit, kept apart so a rule placing everybody is visible. */
  viaUnitRule: number
  viaAttribute: number
  byAttribute: Record<string, number>
  viaManager: number
  viaBillingRegion: number
  fellToGlobal: number
  conflicts: number
  /** The run stopped starting new identities at PLACEMENT_SYNC_BUDGET_MS; the
   *  rest stay queued for the next run. */
  deadlineHit: boolean
}

/** Provision+place every distinct identity with un-replayed owed bills. Idempotent:
 *  re-running re-homes + re-replays (replay is a no-op once placed). */
export async function runPlacementSync(
  db: Db,
  opts?: {
    lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
    /** Injected in tests; defaults to the real Graph manager hop. */
    getManager?: GetManager
    limit?: number
    /** Test seams for the deadline. */
    budgetMs?: number
    now?: () => number
  },
): Promise<PlacementSyncResult> {
  const limit = opts?.limit ?? 500
  const now = opts?.now ?? Date.now
  const deadline = now() + (opts?.budgetMs ?? PLACEMENT_SYNC_BUDGET_MS)
  // Drain OLDEST-FIRST (by each identity's earliest un-replayed bill), matching the
  // pending_placement_unplaced index on first_seen_at and the migration's stated
  // "oldest-first" intent. Ordering alphabetically by email under a sustained backlog
  // (> the LIMIT) would let late-alphabet identities starve indefinitely.
  const rows = await db.execute<{ email: string }>(sql`
    SELECT lower(identity_email) AS email
    FROM pending_placement
    WHERE placed_at IS NULL
    GROUP BY lower(identity_email)
    ORDER BY min(first_seen_at)
    LIMIT ${limit}`)

  const store = makePlacementStore(db)

  // Build the region-derivation closure ONCE per run (mig 0068): load the curated maps and
  // create the manager/region caches a single time so they are SHARED across every user in
  // this run (AEUF's cross-user walk optimisation — a per-user cache would be dead).
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const caches = makeChainCaches()
  // Worker transport: retries on throttle / 5xx / network, never past the run deadline.
  const graph: GraphCallOptions = { retries: WORKER_GRAPH_RETRIES, deadline }
  const getManager: GetManager = opts?.getManager ?? ((oid) => getUserManager(oid, graph))
  const lookupDirectory =
    opts?.lookupDirectory ?? ((email: string) => getDirectoryUserByMailOrUpnStrict(email, graph))
  const derivePlacementForRun = (dir: DirectoryUser): Promise<PlacementDerivation> =>
    derivePlacement(dir, { rules, unitOwnerMap, leaderMap, getManager, caches })

  const result: PlacementSyncResult = {
    emailsConsidered: rows.length,
    provisioned: 0,
    placed: 0,
    errors: 0,
    viaCostCentre: 0,
    viaUnit: 0,
    viaUnitRule: 0,
    viaAttribute: 0,
    byAttribute: {},
    viaManager: 0,
    viaBillingRegion: 0,
    fellToGlobal: 0,
    conflicts: 0,
    deadlineHit: false,
  }
  for (const { email } of rows) {
    if (now() >= deadline) {
      result.deadlineHit = true
      break
    }
    try {
      const r = await provisionAndPlace(email, {
        store,
        lookupDirectory,
        derivePlacement: derivePlacementForRun,
      })
      if (r.created) result.provisioned += 1
      if (r.placed) result.placed += 1
      // Coverage: count how the home was determined, but only on an ACTUAL placement
      // (created or re-homed) — a left-in-place teammate's `placedVia` is hypothetical.
      if (r.homed) {
        if (r.placedVia === 'cost-centre') result.viaCostCentre += 1
        else if (r.placedVia === 'unit') result.viaUnit += 1
        else if (r.placedVia === 'unit-rule') {
          // Its OWN bucket, not viaUnit's: "which signal placed these people" is the
          // question this breakdown answers, and a rule placing everybody (or
          // nobody) is invisible folded into the chain walk's count. It was landing
          // in `fellToGlobal` — the one bucket that means the opposite of what a
          // unit-rule placement is.
          result.viaUnitRule += 1
          if (r.placedAttribute) result.byAttribute[r.placedAttribute] = (result.byAttribute[r.placedAttribute] ?? 0) + 1
          // A divergent lower-precedence rule naming a DIFFERENT cost centre is the
          // misconfiguration that decides whose P&L this spend lands on. Counting it
          // only on region-rule placements left the finer, costlier case unreported.
          if (r.placedConflict) result.conflicts += 1
        } else if (r.placedVia === 'attribute') {
          result.viaAttribute += 1
          if (r.placedAttribute) result.byAttribute[r.placedAttribute] = (result.byAttribute[r.placedAttribute] ?? 0) + 1
          if (r.placedConflict) result.conflicts += 1
        } else if (r.placedVia === 'manager') result.viaManager += 1
        else if (r.placedVia === 'billing-region') result.viaBillingRegion += 1
        else result.fellToGlobal += 1
      }
    } catch (err) {
      // Isolate a single bad identity — retried next tick. A Graph throttle / outage
      // throws from the lookup or the chain walk, before provisionAndPlace writes.
      result.errors += 1
      console.warn(`[placement-sync] ${email}: ${describeError(err)}`)
    }
  }
  return result
}
