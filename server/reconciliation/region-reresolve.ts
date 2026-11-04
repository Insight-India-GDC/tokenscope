/*
 * region-reresolve — apply the CURRENT placement configuration to the people who
 * already exist, scoped to ONE region, with a preview.
 *
 * WHY IT EXISTS. Adding a cost-centre owner, or a unit rule, changes what the
 * derivation WOULD decide — and nothing re-decides it. `region-reenrichment` does
 * re-derive, but it is a global cron worker reachable only from /admin/workers, a
 * platform-admin surface, so the region admin who just changed the configuration
 * cannot apply it. This is that same derivation, made callable from the region
 * page where the change was made.
 *
 * IT IS NOT A SECOND PLACEMENT ENGINE. The candidate safety predicate is
 * rehome-safety.ts (shared with the worker and the bill lane), the derivation is
 * region-derivation.ts's `derivePlacement` (shared with both workers), and the
 * writes are the same PlacementStore methods. What this module owns is the SCOPE
 * and the PREVIEW.
 *
 * ── THE TARGET POLICY IS DELIBERATELY NARROWER THAN THE WORKER'S ──────────────
 * The cron worker may re-home someone into another region's holding node, and may
 * DE-PLACE a stale unit placement to the global bucket. A region admin's action
 * may do neither. It only ever moves a teammate ONTO a cost-owning unit IN THE
 * REGION IT WAS INVOKED FOR. Three consequences, all intentional:
 *
 *   - It can never eject a teammate from the region the caller administers, which
 *     is the same line `POST /admin/users/bulk-place` holds: a cross-region move
 *     owes the revoke cascade, and that is the region PATCH's job.
 *   - A teammate whose chain resolves into ANOTHER region is reported as
 *     `outOfRegion` and left alone, rather than moved by a caller with no
 *     authority over the destination.
 *   - There is no path here that writes the GLOBAL holding bucket, so a
 *     derivation that comes back empty is always "no change", never a
 *     de-placement. Under FORCE RLS a region admin cannot read another region's
 *     owners at all, so an empty derivation would otherwise have meant "I cannot
 *     see your owner, so I will take your placement away".
 *
 * ── THE SAFETY PREDICATE IS NOT RELAXED ──────────────────────────────────────
 * Same `rehomeSafePredicate` as the worker: never-adopted `bill:` placeholders
 * with no live emit instance and no live OAuth token. A teammate with a live
 * session would need the revoke cascade, and this action does not run one.
 *
 * ── THE ORDERING TRAP ────────────────────────────────────────────────────────
 * Re-resolving re-derives against CURRENT configuration. If no unit route exists
 * yet, every candidate derives back to exactly where they are and the admin
 * concludes the feature is broken. So the run FIRST asks whether any unit route
 * is viable — an unambiguous cost-centre owner, or a unit rule pointing into this
 * region — and if none is, it returns that verdict WITHOUT walking a single
 * manager chain. Saying "fix the configuration first" is cheaper and more useful
 * than proving it one Graph call at a time.
 *
 * The viability verdict is computed from the SAME loaded maps the derivation will
 * use (and the walk's own `resolvesToSingleUnit` predicate), never from a second
 * query describing the same thing — so it cannot promise a route the run then
 * fails to take.
 *
 * ── A PASS ADVANCES, IT DOES NOT RE-READ ─────────────────────────────────────
 * Candidates come oldest-`last_sync_at`-first, so the cursor only moves if the
 * pass STAMPS what it looked at. A committing pass therefore stamps every row it
 * considered — moved or not — because the rows it did NOT move (unresolved,
 * errored, out-of-region, already correct) are exactly the ones that would
 * otherwise pin themselves to the head of the ordering and starve the tail while
 * `remaining` kept asking for another pass.
 *
 * ── THE DECISION IS RE-ASSERTED AT WRITE TIME ────────────────────────────────
 * Choosing a candidate and writing it are separated by a directory lookup and a
 * manager-chain walk. The safety predicate, the teammate's region and the
 * destination's validity are all writable by someone else in that window, so the
 * final UPDATE carries them as conditions and reports whether it fired
 * (`homeTeammateIfStillDerivable`). A row that did not move is `skipped`, never
 * `moved`.
 */
import { consola } from 'consola'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { makePlacementStore } from './placement-store'
import {
  derivePlacement,
  makeChainCaches,
  resolvesToSingleUnit,
  type GetManager,
  type OwnedUnit,
  type RegionRuleSet,
} from './region-derivation'
import { rehomeSafePredicate } from './rehome-safety'
import {
  DERIVED_PLACEMENT_VIAS,
  PLACED_VIA_ATTRIBUTE_RULE,
  PLACED_VIA_MANAGER_CHAIN,
  type PlacementProvenance,
} from './placement-provenance'
import type { PlacementDerivation } from './placement-service'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'
import { getUserManager, getDirectoryUserByMailOrUpn, type DirectoryUser } from '../azure/directory'

/* The request's RLS transaction, or a worker's pooled handle — both are this
 * type, which is why the endpoint can run this INSIDE withRequestRls rather than
 * reaching for getDb(). */
type Db = PostgresJsDatabase<typeof schema>

/** Whether the configuration can currently place ANYONE into this region. */
export interface UnitRouteViability {
  /** Owners of a cost-owning unit in this region that the chain walk can use —
   *  i.e. NOT ambiguous (`resolvesToSingleUnit`). An ambiguous owner places
   *  nobody, so counting them here would promise a route that does not exist. */
  unambiguousOwners: number
  /** Curated attribute rules whose unit target sits in this region. */
  unitRules: number
  /** Either route exists. False ⇒ a run would move nobody, by construction. */
  viable: boolean
}

export interface ReresolveMove {
  teammateId: string
  email: string
  displayName: string | null
  fromOrgUnitId: string
  fromDisplayName: string
  toOrgUnitId: string
  toDisplayName: string
  /** 'unit' = the manager chain; 'unit-rule' = a curated attribute rule. */
  via: 'unit' | 'unit-rule'
}

export interface ReresolveResult {
  regionId: string
  dryRun: boolean
  routes: UnitRouteViability
  /** Candidates in this region at all (ignores the batch limit). */
  candidates: number
  /** Candidates this pass actually looked at. */
  considered: number
  /** Moved (or, on a dry run, WOULD move). */
  moved: number
  /** Derived to the unit they are already in — nothing to do. */
  alreadyCorrect: number
  /** No directory match, or no unit route resolved → left where they are. */
  unresolved: number
  /** Resolved to a unit in ANOTHER region → left where they are, on purpose. */
  outOfRegion: number
  /** Identities whose derivation threw (transient Graph) — retried next pass. */
  errors: number
  /**
   * Decided to move, then the write refused because a precondition had changed
   * under it — a session started, the destination was retired or un-flagged, the
   * teammate left the region. NOT counted as moved: the row did not move.
   */
  skipped: number
  /** Display-only snapshot writes that failed. Never a missed placement. */
  snapshotErrors: number
  /** Candidates beyond this batch. > 0 ⇒ another pass is needed. */
  remaining: number
  moves: ReresolveMove[]
}

export interface ReresolveOpts {
  regionId: string
  /** Derive and report, write nothing. */
  dryRun?: boolean
  limit?: number
  lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
  getManager?: GetManager
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  org_unit_id: string
  org_unit_display_name: string
}

/**
 * Re-derive this region's derivable teammates against current configuration.
 *
 * Batched: `limit` bounds both the Graph traffic and the request duration (the
 * run-worker HTTP path has a ~120s gateway ceiling, and this one is reachable
 * from a page). `remaining` tells the caller whether another pass is needed.
 */
export async function runRegionReresolve(db: Db, opts: ReresolveOpts): Promise<ReresolveResult> {
  const limit = opts.limit ?? 50
  const dryRun = opts.dryRun ?? false
  const store = makePlacementStore(db)
  const rules = await store.loadDirectoryRegionRules()
  const leaderMap = await store.loadActiveRegionLeaders()
  const unitOwnerMap = await store.loadActiveUnitOwners()
  const routes = assessUnitRoutes(opts.regionId, unitOwnerMap, rules)

  const result: ReresolveResult = {
    regionId: opts.regionId,
    dryRun,
    routes,
    candidates: 0,
    considered: 0,
    moved: 0,
    alreadyCorrect: 0,
    unresolved: 0,
    outOfRegion: 0,
    errors: 0,
    skipped: 0,
    snapshotErrors: 0,
    remaining: 0,
    moves: [],
  }

  // The candidate population, counted whether or not we go on to walk it — an
  // admin told "no route is configured" still needs to know how many people are
  // waiting on that configuration.
  const countRows = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM teammate t
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.region_id = ${opts.regionId}::uuid
      AND t.is_active = TRUE
      AND (ou.unit_type = ${HOLDING_UNIT_TYPE} OR t.metadata->>'placedVia' IN ${[...DERIVED_PLACEMENT_VIAS]})
      AND ${rehomeSafePredicate(sql`t`)}
  `)
  result.candidates = Number([...countRows][0]?.n ?? 0)

  // THE ORDERING TRAP, answered before spending anything. With no viable route
  // every candidate would derive straight back to where it already is.
  if (!routes.viable) {
    result.remaining = result.candidates
    return result
  }

  const rows = await db.execute<CandidateRow>(sql`
    SELECT t.id::text AS id, t.email, t.display_name,
           t.org_unit_id::text AS org_unit_id,
           ou.display_name AS org_unit_display_name
    FROM teammate t
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.region_id = ${opts.regionId}::uuid
      AND t.is_active = TRUE
      AND (ou.unit_type = ${HOLDING_UNIT_TYPE} OR t.metadata->>'placedVia' IN ${[...DERIVED_PLACEMENT_VIAS]})
      AND ${rehomeSafePredicate(sql`t`)}
    -- Oldest-attempt first, and a COMMITTING pass stamps everything it looks at
    -- (see the stamp after the write loop) so this is a cursor rather than a
    -- permanent front of the queue.
    ORDER BY t.last_sync_at NULLS FIRST, t.id
    LIMIT ${limit}
  `)
  const candidateRows = [...rows]
  result.considered = candidateRows.length
  result.remaining = Math.max(0, result.candidates - candidateRows.length)

  // Names for the destinations, so the preview says "→ EMEA Solutions Core"
  // rather than a uuid. One query, after the loop, keyed on what was decided.
  const targetNames = new Map<string, string>()
  const caches = makeChainCaches()
  const getManager = opts.getManager ?? getUserManager
  const lookup = opts.lookupDirectory ?? getDirectoryUserByMailOrUpn
  const pending: Array<{ row: CandidateRow; orgUnitId: string; via: 'unit' | 'unit-rule'; provenance: PlacementProvenance | null }> = []

  for (const row of candidateRows) {
    try {
      const dir = await lookup(row.email)
      if (!dir) {
        result.unresolved += 1
        continue
      }

      let der: PlacementDerivation | null = null
      let derivationError: unknown = null
      try {
        der = await derivePlacement(dir, { rules, unitOwnerMap, leaderMap, getManager, caches })
      } catch (err) {
        derivationError = err
      }

      // The display snapshot — including the manager C9 clusters by — from the
      // record already fetched. Skipped entirely on a dry run: a preview writes
      // nothing, and an admin who previews and then walks away must not have
      // changed the database. Fenced, like every other snapshot write.
      if (!dryRun) {
        try {
          await store.captureDirectorySnapshot(row.id, {
            department: dir.department,
            companyName: dir.companyName,
            ...(der?.manager ? { manager: der.manager } : {}),
          })
        } catch (err) {
          result.snapshotErrors += 1
          consola.warn('[region-reresolve] directory snapshot failed', {
            regionId: opts.regionId,
            email: row.email,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (derivationError !== null) throw derivationError
      const derived = der!

      if (derived.regionId && derived.regionId !== opts.regionId) {
        // Derived into another region (a unit, or region-only): a cross-region
        // change this caller may not make.
        result.outOfRegion += 1
        continue
      }
      if (derived.via !== 'unit' && derived.via !== 'unit-rule') {
        // No unit route for this person. NOT a de-placement: a region-scoped
        // re-resolve only ever adds a Business Unit home, never removes one.
        result.unresolved += 1
        continue
      }
      if (derived.orgUnitId === row.org_unit_id) {
        result.alreadyCorrect += 1
        continue
      }

      pending.push({
        row,
        orgUnitId: derived.orgUnitId!,
        via: derived.via,
        provenance:
          derived.via === 'unit'
            ? derived.ownerOid
              ? { via: PLACED_VIA_MANAGER_CHAIN, ownerOid: derived.ownerOid }
              : null
            : derived.attribute
              ? { via: PLACED_VIA_ATTRIBUTE_RULE, attribute: derived.attribute }
              : null,
      })
    } catch (err) {
      // Isolate one bad identity (a transient Graph hit) — retried next pass.
      result.errors += 1
      consola.warn('[region-reresolve] identity failed', {
        regionId: opts.regionId,
        email: row.email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (pending.length > 0) {
    const ids = [...new Set(pending.map((p) => p.orgUnitId))]
    const nameRows = await db.execute<{ id: string; display_name: string }>(sql`
      SELECT id::text AS id, display_name FROM org_unit
      WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    `)
    for (const n of nameRows) targetNames.set(n.id, n.display_name)
  }

  for (const p of pending) {
    if (!dryRun) {
      /*
       * THE WRITE RE-ASSERTS WHAT THE DECISION ASSUMED. Everything above ran across
       * a directory lookup and a manager-chain walk, and in that window someone can
       * start a session (which the safety predicate exists to protect), retire or
       * un-flag the destination, or move either party to another region. So the
       * UPDATE carries those conditions itself and reports whether it fired; a row
       * that did not move is counted as skipped and reported as such, never as a
       * placement, and its provenance is left alone rather than stamped to describe
       * a move that did not happen.
       */
      const written = await store.homeTeammateIfStillDerivable(p.row.id, p.orgUnitId, opts.regionId)
      if (!written) {
        result.skipped += 1
        consola.warn('[region-reresolve] move skipped — a precondition changed under it', {
          regionId: opts.regionId,
          email: p.row.email,
          toOrgUnitId: p.orgUnitId,
        })
        continue
      }
      await store.setPlacementProvenance(p.row.id, p.provenance)
    }
    result.moved += 1
    result.moves.push({
      teammateId: p.row.id,
      email: p.row.email,
      displayName: p.row.display_name,
      fromOrgUnitId: p.row.org_unit_id,
      fromDisplayName: p.row.org_unit_display_name,
      toOrgUnitId: p.orgUnitId,
      toDisplayName: targetNames.get(p.orgUnitId) ?? 'that Business Unit',
      via: p.via,
    })
  }

  /*
   * THE CONTINUATION CURSOR. Every row this pass LOOKED AT is stamped, moved or
   * not — the unresolved, the errored, the out-of-region and the already-correct
   * included. Without it those rows keep their old `last_sync_at`, sit at the head
   * of `ORDER BY last_sync_at NULLS FIRST` for ever, and every limited pass
   * re-reads exactly the same batch while `remaining` keeps telling the admin to
   * run again: the tail is never reached and the action never finishes.
   *
   * A dry run stamps nothing, like every other write on this path — a preview that
   * advanced the cursor would move the worklist under an admin who only looked.
   */
  if (!dryRun) await store.stampPlacementAttempt(candidateRows.map((r) => r.id))

  return result
}

/**
 * Can the CURRENT configuration place anyone into this region at all?
 *
 * Derived from the maps the run itself will use, so the answer cannot promise a
 * route the run then fails to take — and from `resolvesToSingleUnit`, the walk's
 * own ambiguity rule, so an owner who owns two units counts as the nothing they
 * actually are.
 */
export function assessUnitRoutes(
  regionId: string,
  unitOwnerMap: Map<string, OwnedUnit[]>,
  rules: RegionRuleSet,
): UnitRouteViability {
  let unambiguousOwners = 0
  for (const owned of unitOwnerMap.values()) {
    if (resolvesToSingleUnit(owned) && owned[0].regionId === regionId) unambiguousOwners += 1
  }
  let unitRules = 0
  for (const byValue of rules.exact.values()) {
    for (const target of byValue.values()) {
      if (target.orgUnitId && target.regionId === regionId) unitRules += 1
    }
  }
  for (const p of rules.prefix) {
    if (p.target.orgUnitId && p.target.regionId === regionId) unitRules += 1
  }
  return { unambiguousOwners, unitRules, viable: unambiguousOwners > 0 || unitRules > 0 }
}
