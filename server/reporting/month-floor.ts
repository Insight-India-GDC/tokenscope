/*
 * The reporting month floor — the earliest month with any usage in a scope.
 *
 * WHAT IT IS FOR. Two things, both cheap consumers: the month picker's lower
 * bound, and a server-side 400 for a month below it (server/reporting/params.ts
 * resolveReportMonth). Neither needs sub-second freshness.
 *
 * WHY IT NEEDED FIXING. Three copies of this query existed — regional.ts,
 * across-regions.ts and cost-centres.ts — and every one of them scanned
 * v_complete_usage with NO DATE PREDICATE AT ALL. Alone among every query on
 * the reporting page, the floor was not bounded by the selected window, so it
 * read the entire history on every request: ~580MB of blocks against ~67MB for
 * the query that answers the user's actual question, spilling 13.8MB to disk,
 * 241ms. Because it is unbounded it gets STRICTLY SLOWER every month the
 * deployment runs, forever, while answering a question whose value changes at
 * most monthly.
 *
 * WHY A CACHE RATHER THAN A BOUND. The floor is a MIN over all history, so
 * there is no window to narrow it to without changing the answer. What makes it
 * cheap is that the answer is near-static: it moves when the first data lands,
 * when the archive worker retires the oldest month, and — the case that matters
 * — when a recovery or backfill worker inserts HISTORY EARLIER than anything
 * seen before, which lowers the floor.
 *
 * That last case is why callers must not reject a month on a cached value
 * alone. Instances do not share this cache, so after a backfill one instance
 * can hold a later floor than another for a whole TTL, and the floor is
 * enforced as a 400 — the symptom would be a request being refused a month
 * whose data has just been restored, on one instance but not its neighbour.
 * `confirmBelowFloor` exists for exactly that: it re-reads UNCACHED before a
 * rejection, which keeps the cache a pure latency optimisation and makes a
 * stale entry unable to produce a wrong answer, only a briefly-wide picker.
 *
 * The scope predicate is part of the key, deliberately: a cost-centre owner's
 * floor is not the whole company's, and sharing one global floor would let a
 * scope-below-floor month through. Semantics here are EXACTLY what the three
 * copies did; only the number of times it runs has changed.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/*
 * Five minutes. The floor changes at most when a month rolls off the archive,
 * so this is about bounding staleness, not chasing a moving value. Instances do
 * not share the cache; they do not need to, since each converges within a TTL.
 */
export const MONTH_FLOOR_TTL_MS = 5 * 60_000

/*
 * Under Vitest the default TTL is 0, i.e. no caching.
 *
 * This module holds PROCESS-GLOBAL state, and Vitest reuses workers across test
 * files, so a floor cached while one file's fixture was live would be served to
 * the next file's — a cross-test data leak that surfaces as an unrelated
 * assertion failing intermittently. Test isolation is worth more than
 * exercising the cache in integration; the caching behaviour itself is pinned
 * by unit tests that inject an explicit clock and TTL, which is the stricter
 * check anyway.
 */
const DEFAULT_TTL_MS = process.env.VITEST === 'true' ? 0 : MONTH_FLOOR_TTL_MS

/*
 * Bounded so a pathological caller cannot grow it without limit. Scopes are
 * (region × org_unit) plus a global key — order tens in practice; this is a
 * backstop, not a working limit. Oldest-inserted is evicted first.
 */
const MAX_ENTRIES = 256

interface Entry {
  value: string | null
  at: number
}
const cache = new Map<string, Entry>()

/*
 * In-flight loads, keyed the same way. Without this, N concurrent cold requests
 * for one scope each run the full unbounded scan — the exact cost the cache
 * exists to remove, at its worst precisely when the instance is busiest.
 * Cleared on settle so a rejection cannot pin a permanently-failing entry.
 */
const inflight = new Map<string, Promise<string | null>>()

/** Test seam. Never call from request paths. */
export function resetMonthFloorCache(): void {
  cache.clear()
  inflight.clear()
}

/** Test seam: how many scopes are currently cached. */
export function monthFloorCacheSize(): number {
  return cache.size
}

export interface MonthFloorScope {
  /**
   * Identifies the SCOPE, and must vary with `where`. Two different predicates
   * sharing a key would serve one scope's floor for another — which is a
   * wrong 400 on a month the caller does have data in.
   */
  key: string
  /** Scope predicate over v_usage_rollup_current (alias `u`), or null for whole-company. */
  where: SQL | null
}

/**
 * Earliest month (`YYYY-MM`) with usage in `scope`, or null when the scope has
 * none. Cached per scope for MONTH_FLOOR_TTL_MS.
 */
export async function reportMonthFloor(
  tx: Tx,
  scope: MonthFloorScope,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const hit = cache.get(scope.key)
  if (hit && now - hit.at < ttl) return hit.value

  // Join an in-flight load for the same scope rather than starting a second.
  const running = inflight.get(scope.key)
  if (running) return running

  const load = loadFloor(tx, scope)
    .then((value) => {
      // Evict before insert so the map never exceeds the cap even transiently.
      if (!cache.has(scope.key) && cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(scope.key, { value, at: now })
      return value
    })
    .finally(() => {
      inflight.delete(scope.key)
    })
  inflight.set(scope.key, load)
  return load
}

/*
 * Read off the day rollup, not the raw lane. Its content is defined as an
 * aggregate of v_complete_usage (mig 0136), so MIN(day) is the month of
 * MIN(ts_event) in UTC, and every scope predicate here is the one its headline
 * already sums the rollup with. On the raw lane a current-placement clamp cannot
 * be pushed into the arms' stamped indexes, which doubled the uncached scan; the
 * rollup's (teammate_id, day) index answers it in milliseconds.
 */
async function loadFloor(tx: Tx, scope: MonthFloorScope): Promise<string | null> {
  const rows = await tx.execute<{ floor_month: string | null }>(
    scope.where
      ? sql`SELECT to_char(MIN(day), 'YYYY-MM') AS floor_month
              FROM v_usage_rollup_current u
             WHERE ${scope.where}`
      : sql`SELECT to_char(MIN(day), 'YYYY-MM') AS floor_month
              FROM usage_rollup_daily u`,
  )
  return [...rows][0]?.floor_month ?? null
}

/**
 * Re-read the floor UNCACHED, for the one decision a stale value must never
 * make: rejecting a request.
 *
 * The floor is enforced as a 400 (server/reporting/params.ts). A backfill that
 * restores older history LOWERS the floor, and instances do not share this
 * cache — so a cached value can be later than the truth for a whole TTL, and
 * would refuse a month whose data exists, on one instance but not its
 * neighbour. Confirming before rejecting keeps the cache a pure latency
 * optimisation: a stale entry can widen the picker briefly, never deny an
 * answer. The uncached scan only runs on the rejection path, which is rare.
 */
export async function confirmBelowFloor(
  tx: Tx,
  scope: MonthFloorScope,
  month: string,
): Promise<string | null> {
  const fresh = await loadFloor(tx, scope)
  cache.set(scope.key, { value: fresh, at: Date.now() })
  return fresh && month < fresh ? fresh : null
}
