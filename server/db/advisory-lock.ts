import { sql, type SQL } from 'drizzle-orm'

/**
 * Transaction-scoped advisory locks, namespaced and totally ordered.
 *
 * WHY THIS EXISTS. Both provisioning paths (`server/auth/emit-provision.ts`,
 * `server/auth/enroll-provision.ts`) serialise several different things inside
 * one transaction: a per-device dedup key, a per-principal cap, and a global
 * cap. Written ad hoc they took the SINGLE-argument
 * `pg_advisory_xact_lock(hashtext(...))`, which has two defects that only show
 * up under concurrency:
 *
 * 1. **One flat key space.** `hashtext` returns int4, so an instance id's hash
 *    can equal an unrelated teammate id's hash. Two transactions acquiring
 *    (instance, teammate) whose hashes are swapped acquire the SAME two locks
 *    in OPPOSITE order, which is a textbook deadlock. The old comment dismissed
 *    collisions as "only ever over-serializes unrelated callers — harmless",
 *    which is true of a collision WITHIN one key space and false across two.
 *
 * 2. **No stated order.** Nothing forced the paths to agree on acquisition
 *    order, so adding a third lock was a deadlock risk each time.
 *
 * The two-argument form `pg_advisory_xact_lock(classid, objid)` gives each
 * concern its own 32-bit space, so an instance key can never collide with a
 * teammate key no matter what `hashtext` returns. `LOCK_NAMESPACE` values are
 * the total order: acquire ascending, always. Within one namespace, collisions
 * remain harmless over-serialisation, which is the property the original
 * comment was reaching for.
 *
 * All locks are `_xact_` — released at COMMIT or ROLLBACK, never leaked.
 *
 * WHAT THIS MODULE DOES **NOT** COVER, and why. Postgres treats the one-argument
 * `pg_advisory_xact_lock(bigint)` and the two-argument `(int, int)` form as two
 * DISJOINT lock spaces: a key in one never excludes a key in the other. Three
 * call sites still take the single-argument form and are deliberately left there:
 *
 *   - `server/auth/emit-provision.ts` → `issueInstanceEmitCredentialTx`, keyed on
 *     the instance id. It serialises the credential rotate→issue→bind sequence.
 *   - `sessionTagXactLock` below (tag-session, worklist-bulk and the read joiner)
 *     — unrelated to provisioning. Moving it has the same rolling-deploy hazard.
 *
 * Moving the first of those into the `instance` namespace would be tidier and is
 * NOT worth it: during a rolling deploy old and new replicas would hold keys in
 * the two different spaces and stop excluding each other, reopening the exact
 * rotate/insert TOCTOU window that lock exists to close, for as long as the
 * rollout takes. A cosmetic consistency win is not worth a real (if brief) window
 * on credential rotation. Migrating it needs its own change, with the two-phase
 * "take both keys, then drop the old one" dance a lock-space move requires.
 *
 * So the ordering contract below governs the locks in THIS module, and the
 * credential lock sits outside it. That is safe today because it is acquired
 * LAST on every path that takes both (enrol: instance → principal → globalCap →
 * credential; redeem takes only the credential lock), so no cycle exists. A new
 * path that takes the credential lock BEFORE any namespaced one would create
 * one — put it last, or do the migration properly.
 *
 * ── ONE RESERVED CLASSID, HELD OUTSIDE THIS FILE ────────────────────────────
 * `classid = 100` belongs to the two BOOT steps —
 * `drizzle/provision-app-role.ts` (key 1) and `drizzle/cutover-rls-sweep.ts`
 * (key 2), both spelled in `scripts/rls-roles.ts` — which serialise themselves
 * across replicas. Neither can import this module: the runtime image copies
 * `drizzle/` and `scripts/` but NOT `server/`. So the two key spaces are kept
 * disjoint by leaving a gap rather than by anyone remembering. Do not number a
 * namespace below 100 up to it, and do not use 100 here.
 */
export const LOCK_NAMESPACE = {
  /** A single device/enrolment row. Keyed on instance id or a device hash. */
  instance: 1,
  /** One human. Keyed on teammate id (authenticated) or email (enrol). */
  principal: 2,
  /**
   * The deployment-wide instance caps. A single fixed key: the global count is
   * a read of the WHOLE table, so per-principal locks cannot serialise it —
   * concurrent creates by DIFFERENT principals each hold a different principal
   * lock, read the same pre-insert count, and all insert past the cap.
   */
  globalCap: 3,
  /**
   * One `reporting_snapshot` row, keyed on `period_month` (YYYY-MM-01).
   * Serialises taking a month's snapshot against a concurrent governance
   * recompute scoped to that month, so a snapshot can never record a
   * half-recomputed set of verdicts. Combined with `SELECT ... FOR UPDATE` on
   * the row itself (belt + braces: the advisory lock serialises even the "row
   * does not exist yet" case, which a row-level lock cannot cover).
   *
   * ORDINAL 4 IS DELIBERATELY UNCHANGED across the finance_period rename
   * (mig 0128). The lock id derives from the ordinal, not the property name, so
   * old and new replicas contend on the same lock space during a rolling
   * deploy — and the documented total order over namespaces is untouched.
   */
  reportingSnapshot: 4,
  /**
   * The single `governance_cutover_state` row (id=1). Serialises
   * preflight/activate/rollback against each other — these are rare,
   * operator-invoked, whole-system-state transitions, so ONE fixed key
   * (like globalCap) rather than a per-caller key is correct: any two callers
   * racing to change cutover state MUST serialise, full stop.
   */
  governanceCutover: 5,
  /**
   * One `(provider_enterprise, month)` pair — the Copilot pooled-bill /
   * overage-allocation grain (Workstream C, design §5.4/§8.4: "Persist
   * allocations... under the same enterprise/month advisory lock as bill
   * refresh"). Keyed on `${providerEnterpriseId}:${monthStart}`. Serialises:
   *   - the copilot-pool-bill worker's per-(enterprise, month) DELETE+INSERT
   *     rewrite of `copilot_pool_bill` (server/workers/copilot-pool-bill.ts),
   *   - the admin-triggered historical bill re-pull for the SAME
   *     (enterprise, month) (server/api/v1/admin/reconciliation/enterprises/
   *     [id]/copilot-bill-repull.post.ts), which reuses the same worker path,
   *   - the overage-allocation compute+persist that follows the bill rewrite,
   *     in the SAME transaction (server/governance/copilot-overage-allocation.ts).
   * Acquired alongside the `reportingSnapshot` lock (ascending order: reportingSnapshot
   * THEN this) so a concurrent close/reopen/restate for the same month can
   * never race a bill/allocation rewrite — mirrors the "billing-edit inline
   * recompute" pattern documented on `reportingSnapshot` above.
   */
  copilotOverageAllocation: 6,
  /**
   * One teammate/tool personal-subscription declaration. Serialises a
   * detector's check-then-prompt sequence against the teammate declaring the
   * same tool, including the no-row-yet case that a row lock cannot cover.
   */
  personalSubscription: 7,
  /**
   * One `directory_region_rule` upsert key — `(attribute, match_value)`.
   *
   * The rule write AUTHORISES against the row it would replace: a region admin
   * may overwrite a unit rule they administer and never an org-wide region rule.
   * `SELECT … FOR UPDATE` makes that a statement about an EXISTING row and locks
   * NOTHING when there is none — a row lock is not a key-range lock. Two regions
   * both observe absence, both pass the (vacuous) check, and the loser's
   * `ON CONFLICT DO UPDATE` re-points the winner's brand-new rule at its own cost
   * centre without ever having been authorised against it.
   *
   * So the key itself is locked before the read, which is the only thing that
   * covers the no-row-yet case.
   */
  directoryRule: 8,
  /**
   * One provider-transform OWNERSHIP DOMAIN — the `(provider_org, surface)` pair,
   * keyed on `actual_spend.source`, which encodes exactly that pair
   * (`anthropic-analytics-api:<externalOrgId>`, analytics-poller.ts:147-149).
   *
   * KEYED ON THE DOMAIN, NOT THE WINDOW, and that distinction is the whole
   * point (target-state-data-architecture.md §6): the transform owns the entire
   * `provider_usage_fact` set for a source, and its upsert-then-prune converges
   * that set. A window-keyed lock would let two OVERLAPPING windows run
   * concurrently under different keys and interleave their upserts and prunes —
   * the later run's prune deleting rows the earlier one had just re-asserted.
   *
   * Acquired LAST and ALONE: the transform's transaction takes no other
   * namespaced lock, so the ascending-order rule is satisfied trivially today.
   * The highest ordinal is also the safest place for it — a future path
   * composing this with any existing lock still acquires ascending. A path that
   * needs to take a LOWER-numbered lock while holding this one must take that
   * one first.
   */
  providerTransform: 9,
  /**
   * One project's top-up pool, keyed on the project id. Serialises the
   * count-then-insert in `POST /allocations/{id}/topups` so concurrent top-ups
   * cannot all read the same pre-insert count and land past the per-project
   * cap. Acquired alone; that transaction takes no other namespaced lock.
   */
  allocationTopup: 10,
} as const

export type LockNamespace = keyof typeof LOCK_NAMESPACE

/**
 * Acquire one transaction-scoped advisory lock.
 *
 * Callers MUST acquire in ascending `LOCK_NAMESPACE` order. `pg_advisory_xact_lock`
 * is re-entrant within a transaction, so re-taking a key already held is free.
 */
export function advisoryXactLock(ns: LockNamespace, key: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE[ns]}::int, hashtext(${key})::int)`
}

/**
 * The non-blocking form of advisoryXactLock: the SAME key derivation, so it
 * contends with it exactly. Returns one row, `{ locked: boolean }`: true when the
 * lock is now held (until COMMIT or ROLLBACK, like advisoryXactLock), false when
 * another transaction holds it — never a wait. The ascending-order rule still
 * applies to whatever the caller takes after it.
 */
export function advisoryXactTryLock(ns: LockNamespace, key: string): SQL {
  return sql`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE[ns]}::int, hashtext(${key})::int) AS locked`
}

/**
 * The two global caps count DISJOINT populations: `confirmed` is the
 * authenticated self-provision path (emit-provision), `provisional` is the
 * unauthenticated enrol path (enroll-provision). Each cap's count filters to
 * its own `identity_state`, so a create on one path cannot change the other's
 * total and the two need not serialise against each other.
 *
 * Giving them one shared key would make every enrolment deployment-wide queue
 * behind every unrelated self-provision for no correctness benefit. Distinct
 * keys within the SAME namespace keep the ordering contract intact (a
 * transaction takes at most one of them) while removing the false contention.
 */
export const GLOBAL_CAP_KEY = {
  /** Authenticated self-provision — counts identity_state='confirmed'. */
  confirmed: 0,
  /** Unauthenticated enrol — counts identity_state='provisional'. */
  provisional: 1,
} as const

export type GlobalCapDomain = keyof typeof GLOBAL_CAP_KEY

/**
 * Acquire the global-cap lock for ONE cap domain. Takes no free-form key: the
 * whole point is that every caller counting the same population contends on the
 * same fixed one, because the count reads the whole (filtered) table.
 */
export function advisoryGlobalCapLock(domain: GlobalCapDomain): SQL {
  return sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.globalCap}::int, ${GLOBAL_CAP_KEY[domain]}::int)`
}

/**
 * The lock serialising writes to ONE (conversation, teammate) session's tags:
 * tagSessionTx, the bulk worklist, and the read joiner's inserts (#475), so a
 * tag commits either before a join reads it or after the joined rows exist.
 * Single-argument form, deliberately outside LOCK_NAMESPACE: see the module
 * comment. Take several in sorted order.
 */
export function sessionTagXactLock(conversationId: string, teammateId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${conversationId} || '|' || ${teammateId}::text))`
}
