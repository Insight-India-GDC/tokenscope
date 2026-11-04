/*
 * The instance lifecycle gate the emit-credential routes share: the instance
 * row with its owner's revocation state, and the checks that decide whether it
 * is live. Moved out of /bearer (where every comment below was written) so the
 * session report route (#494) applies exactly the same gate.
 */
import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { schema } from '../db'

/**
 * Ended OR purged. Soft-purge used to select by age alone, so a historical row
 * can be purged without ever being ended; mig 0141 revoked its credentials, and
 * every lifecycle reading here must treat it as ended, not as a live device
 * whose credential is failing.
 */
export function deviceEnded(row: Pick<InstanceRow, 'tsActualEnd' | 'tsPurged'>): boolean {
  return row.tsActualEnd !== null || row.tsPurged !== null
}

/**
 * True when the 401's silence would be EXPECTED (lifecycle), not the disaster.
 *
 * Carries the SAME three arms as assertInstanceLive, and has to: this predicate
 * decides whether a 401 opens a "your emit credential failed" inbox item, so a
 * refusal reason that appears in the gate but not here is a guaranteed false
 * alarm on every poll of an intentionally-retired device.
 */
export function instanceLifecycleSilent(row: InstanceRow): boolean {
  if (deviceEnded(row)) return true
  // Deactivated owner: retiring an account is a deliberate act, so its device
  // going silent is the intended outcome, not an incident. Same LEFT JOIN
  // nuance as assertInstanceLive — `=== false`, never `!== true`.
  if (row.teammateId !== null && row.teammateIsActive === false) return true
  return Boolean(
    row.teammateEmitRevokedAt && row.tsStart && row.teammateEmitRevokedAt.getTime() > row.tsStart.getTime(),
  )
}

export interface InstanceRow {
  instanceId: string
  principalOid: string
  teammateId: string | null
  tsActualEnd: Date | null
  tsPurged: Date | null
  tsStart: Date | null
  teammateEmitRevokedAt: Date | null
  /** NULL when the LEFT JOIN found no owner at all — not the same as `false`. */
  teammateIsActive: boolean | null
}

/**
 * The instance + its owner's revocation state (one row or null).
 *
 * Takes a bare `PostgresJsDatabase` rather than `ReturnType<typeof getDb>` so it
 * accepts BOTH lanes: the platform pool (the 401 catch path, which has no
 * identity) and a `withMachineRls` transaction (the authenticated path). A
 * transaction handle has no `$client`, which is what the pool type demands.
 */
export async function loadInstance(
  db: PostgresJsDatabase<typeof schema>,
  sid: string,
  opts: { lock?: boolean } = {},
): Promise<InstanceRow | null> {
  const query = db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      principalOid: schema.instanceAttestation.principalOid,
      teammateId: schema.instanceAttestation.teammateId,
      tsActualEnd: schema.instanceAttestation.tsActualEnd,
      tsPurged: schema.instanceAttestation.tsPurged,
      tsStart: schema.instanceAttestation.tsStart,
      // E2 (ADR-0005): the emit-path analogue of isRevoked(). The DEVICE anchor
      // (mig 0152, #414) — revoke-sessions and retirement bump it, a role or
      // region change does not, so a benign admin action leaves the device live.
      teammateEmitRevokedAt: schema.teammate.emitRevokedAt,
      // Deactivation — the OTHER axis. See assertInstanceLive.
      teammateIsActive: schema.teammate.isActive,
    })
    .from(schema.instanceAttestation)
    .leftJoin(schema.teammate, eq(schema.teammate.id, schema.instanceAttestation.teammateId))
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)
  const [row] = await (opts.lock ? query.for('update', { of: schema.instanceAttestation }) : query)
  return row ?? null
}

/**
 * Shared lifecycle gate (ts_actual_end + teammate deactivation + E2
 * teammate.emit_revoked_at).
 *
 * THE DEACTIVATION ARM HERE IS DEFENCE IN DEPTH, AND ONLY THAT — said plainly
 * so nobody reads a live control into it. `requireOAuthBearer` already refuses a
 * deactivated teammate on the TOKEN's teammate_id, and it runs before this, so
 * the ordinary path cannot reach this arm: by the time we are here the caller's
 * own teammate is necessarily active. What it does cover is the case the two
 * gates read DIFFERENT columns for — a token owned by one teammate bound to an
 * instance owned by another — and the day someone reorders or narrows the gate
 * above.
 *
 * The arm that IS reachable is the twin in `instanceLifecycleSilent`. That
 * predicate runs in the 401 CATCH path, after requireOAuthBearer has refused,
 * and decides whether the refusal opens a "your emit credential failed" health
 * signal. Without a deactivation arm there, every poll from an intentionally
 * retired teammate's device raises a false alarm about a credential that is
 * working exactly as designed. See the test in
 * tests/integration/instances/bearer-deactivated-teammate.test.ts.
 *
 * Both arms exist because `emit_revoked_at` and `is_active` are INDEPENDENT axes
 * (ADR-0005 §E2 versus the retirement worker), and a function calling itself the
 * lifecycle gate while reasoning on only one of them is precisely how the emit
 * path came to miss deactivation in the first place: privileged-identity-cleanup
 * only ever sets `is_active = FALSE`, so the E2 comparison below can never fire
 * for a cleaned account.
 */
export function assertInstanceLive(row: InstanceRow): void {
  if (deviceEnded(row)) {
    throw createError({ statusCode: 401, statusMessage: 'Session ended' })
  }
  // Durable state, no timestamp comparison — a retired account has no "after" to
  // be on the right side of.
  //
  // Predicated on the instance HAVING an owner, and deliberately not written as
  // `!== true`: `teammate` is LEFT-joined, so a NULL here means the join found no
  // owner row, NOT that an owner is deactivated (mig 0001 declares the column
  // NOT NULL DEFAULT TRUE, so a real owner can never be NULL). Failing closed on
  // that NULL would 401 an owner-less instance on a NEW axis, which is a
  // lifecycle change smuggled in under a security fix. The teammate that matters
  // for authorisation has already been checked as `is_active` by
  // requireOAuthBearer, on the token's OWN teammate_id, before this runs.
  if (row.teammateId !== null && row.teammateIsActive === false) {
    throw createError({ statusCode: 401, statusMessage: 'Session revoked' })
  }
  // E2: a teammate revoked AFTER this instance was enrolled (emit_revoked_at >
  // ts_start) must stop emitting immediately — retirement / force-revoke. A
  // re-scope does not bump it (#414). An instance enrolled AFTER a revocation
  // (re-enrol) is fine.
  if (row.teammateEmitRevokedAt && row.tsStart && row.teammateEmitRevokedAt.getTime() > row.tsStart.getTime()) {
    throw createError({ statusCode: 401, statusMessage: 'Session revoked' })
  }
}
