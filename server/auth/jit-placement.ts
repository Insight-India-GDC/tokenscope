/*
 * Where a first sign-in is homed when no bill row was adopted (spec P9).
 *
 * The person is looked up by oid and their manager chain walked under one
 * end-to-end budget that also bounds the Graph token mint. When it expires every
 * outstanding call is aborted, and the person lands on the default region's
 * Unplaced node as before. Only directory failures fall back: the config loads and
 * the holding-node writes are database calls and throw.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { consola } from 'consola'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import {
  getDirectoryUserByOidStrict,
  getUserManager,
  type DirectoryUser,
  type GraphCallOptions,
} from '../azure/directory'
import { makePlacementStore } from '../reconciliation/placement-store'
import type { PlacementDerivation } from '../reconciliation/placement-service'
import {
  PLACED_VIA_ATTRIBUTE_RULE,
  PLACED_VIA_JIT_DEFAULT,
  PLACED_VIA_JIT_DIRECTORY,
  PLACED_VIA_MANAGER_CHAIN,
} from '../reconciliation/placement-provenance'
import { derivePlacement, makeChainCaches, type ManagerEdge } from '../reconciliation/region-derivation'
import { resolveDefaultRegionId, unplacedOrgUnitIdForRegion } from './placement-home'
import { DeadlinePassedError } from '../utils/resilient-fetch'

/** Covers the token mint, the user lookup and every manager hop. */
export const JIT_DIRECTORY_BUDGET_MS = 3_000

export interface JitDirectory {
  getUser(oid: string, call: GraphCallOptions): Promise<DirectoryUser | null>
  getManager(oid: string, call: GraphCallOptions): Promise<ManagerEdge | null>
}

const graphDirectory: JitDirectory = {
  getUser: (oid, call) => getDirectoryUserByOidStrict(oid, call),
  getManager: (oid, call) => getUserManager(oid, call),
}

export interface JitPlacementOptions {
  directory?: JitDirectory
  budgetMs?: number
}

export type JitDefaultReason = 'not-in-directory' | 'no-placement' | 'timeout' | 'directory-error'

export interface JitPlacement {
  regionId: string
  orgUnitId: string
  /** The provenance keys to write (placedAt is stamped by the insert). */
  provenance: Record<string, string>
  /** For the audit row. */
  outcome:
    | { placed: 'directory'; step: NonNullable<PlacementDerivation['via']> }
    | { placed: 'default'; reason: JitDefaultReason }
}

type Db = PostgresJsDatabase<typeof schema>
type GenericDb = PostgresJsDatabase<Record<string, unknown>>

export async function resolveJitPlacement(db: Db, oid: string, opts: JitPlacementOptions = {}): Promise<JitPlacement> {
  const genericDb = db as unknown as GenericDb
  const store = makePlacementStore(db)
  const [rules, leaderMap, unitOwnerMap] = await Promise.all([
    store.loadDirectoryRegionRules(),
    store.loadActiveRegionLeaders(),
    store.loadActiveUnitOwners(),
  ])
  const directory = opts.directory ?? graphDirectory

  const looked = await withBudget(opts.budgetMs ?? JIT_DIRECTORY_BUDGET_MS, async (call) => {
    const dir = await directory.getUser(oid, call)
    if (!dir) return null
    return await derivePlacement(dir, {
      rules,
      leaderMap,
      unitOwnerMap,
      getManager: (managerOid) => directory.getManager(managerOid, call),
      caches: makeChainCaches(),
    })
  })

  if (looked.ok && looked.value?.regionId && looked.value.via) {
    const der = looked.value
    const orgUnitId = der.orgUnitId ?? (await unplacedOrgUnitIdForRegion(genericDb, der.regionId!))
    return {
      regionId: der.regionId!,
      orgUnitId,
      provenance: provenanceFor(der),
      outcome: { placed: 'directory', step: der.via! },
    }
  }

  const reason: JitDefaultReason = !looked.ok
    ? looked.timedOut
      ? 'timeout'
      : 'directory-error'
    : looked.value === null
      ? 'not-in-directory'
      : 'no-placement'
  if (!looked.ok) {
    consola.warn('[auth] JIT directory placement fell back to the default region', {
      oid,
      reason,
      error: looked.error instanceof Error ? looked.error.message : String(looked.error),
    })
  }
  const regionId = await resolveDefaultRegionId(genericDb)
  if (!regionId) {
    throw new Error(
      'JIT teammate creation failed: no region rows. Seed the DB (npm run db:seed) before first Entra sign-in.',
    )
  }
  return {
    regionId,
    orgUnitId: await unplacedOrgUnitIdForRegion(genericDb, regionId),
    provenance: { placedVia: PLACED_VIA_JIT_DEFAULT },
    outcome: { placed: 'default', reason },
  }
}

/**
 * The derived unit can be retired or un-flagged during the directory lookup.
 * Call inside the insert's transaction: pins the unit FOR SHARE, or homes the
 * person on its region's Unplaced node when it is no longer a valid home.
 */
export async function pinJitHome(tx: Db, p: JitPlacement): Promise<JitPlacement> {
  const via = p.provenance.placedVia
  if (via !== PLACED_VIA_MANAGER_CHAIN && via !== PLACED_VIA_ATTRIBUTE_RULE) return p
  const [row] = await tx.execute<{ ok: boolean }>(sql`
    SELECT (retired_at IS NULL AND is_cost_owning_unit AND region_id = ${p.regionId}::uuid) AS ok
    FROM org_unit WHERE id = ${p.orgUnitId}::uuid FOR SHARE`)
  if (row?.ok) return p
  return {
    ...p,
    orgUnitId: await unplacedOrgUnitIdForRegion(tx as unknown as GenericDb, p.regionId),
    provenance: { placedVia: PLACED_VIA_JIT_DIRECTORY },
  }
}

function provenanceFor(der: PlacementDerivation): Record<string, string> {
  if (der.via === 'unit' && der.ownerOid) return { placedVia: PLACED_VIA_MANAGER_CHAIN, placedOwnerOid: der.ownerOid }
  if (der.via === 'unit-rule' && der.attribute) return { placedVia: PLACED_VIA_ATTRIBUTE_RULE, placedAttribute: der.attribute }
  if (der.via === 'attribute' && der.attribute) return { placedVia: PLACED_VIA_JIT_DIRECTORY, placedAttribute: der.attribute }
  return { placedVia: PLACED_VIA_JIT_DIRECTORY }
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DeadlinePassedError) return true
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError'
}

type Budgeted<T> = { ok: true; value: T } | { ok: false; timedOut: boolean; error: unknown }

/**
 * Run `work` with a signal and deadline that expire after `ms`. On expiry the
 * signal aborts (cancelling whatever is in flight) and this resolves at once,
 * whether or not `work` honours the signal.
 */
async function withBudget<T>(ms: number, work: (call: GraphCallOptions) => Promise<T>): Promise<Budgeted<T>> {
  const controller = new AbortController()
  const deadline = Date.now() + ms
  const call: GraphCallOptions = { signal: controller.signal, deadline }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<Budgeted<T>>((resolve) => {
    timer = setTimeout(() => {
      const reason = new DOMException(`JIT directory lookup exceeded ${ms} ms`, 'TimeoutError')
      controller.abort(reason)
      resolve({ ok: false, timedOut: true, error: reason })
    }, ms)
  })
  // A per-attempt timeout is cut to the budget, so it can fire just before the timer.
  const run = work(call).then(
    (value): Budgeted<T> => ({ ok: true, value }),
    (error: unknown): Budgeted<T> => ({
      ok: false,
      timedOut: controller.signal.aborted || (Date.now() >= deadline && isTimeoutError(error)),
      error,
    }),
  )
  try {
    return await Promise.race([run, expired])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
