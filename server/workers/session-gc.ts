/*
 * Session GC worker — closes abandoned sessions.
 *
 * Per api-and-connector-interfaces.md §1.3a: every 5 minutes, find rows
 * where `ts_actual_end IS NULL` AND `expires_at < NOW()`, set
 * `ts_actual_end = NOW()`, emit `audit_event` with `actor_system =
 * 'session-gc-worker'`.
 *
 * ABANDONED MEANS IDLE, NEVER OLD. `ts_expected_end` is the device's idle
 * window: every /bearer mint and every re-provision renews it, so a device in
 * use never reaches it. A device is closed only once BOTH that and its last
 * mint (or enrolment, if it never minted) plus the same window have passed. Both earlier cues
 * were ages and both closed working devices: `ts_start + 12h` (the 2026-06-06
 * attribution outage), then a `ts_expected_end` fixed at enrolment + 90d (every
 * device went red on its 90th day).
 *
 * Pure function: takes a Drizzle client + a "now" timestamp. Production
 * scheduling is BullMQ at Epic 10; the test calls runSessionGc() directly
 * with a synthetic now.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { REFRESH_TOKEN_TTL_MS, reapAbandonedOAuthClients } from '../auth/oauth'

// The idle window, measured from the last mint (or enrolment).
const DEFAULT_TTL_MS = REFRESH_TOKEN_TTL_MS
// Devices closed per transaction, and the wall-clock budget for closing before
// the run stops and leaves the rest to the next one (worker gateway ceiling ~120 s).
export const CLOSE_CHUNK = 500
const CLOSE_BUDGET_MS = 60_000

/*
 * OAuth-lifecycle sweep bounds (AUTH-5). Nothing previously deleted
 * expired/consumed oauth_auth_code or emit_handoff rows, expired/revoked
 * oauth_token rows, or abandoned oauth_client registrations — and every MCP
 * client install dynamically registers a NEW client row on the unauthenticated
 * RFC 7591 endpoint, so abandoned registrations monotonically fill the
 * MAX_OAUTH_CLIENTS cap until registration 429s forever.
 */
// Single-use artifacts (codes/handoffs, ~5 min TTL): keep a day for incident forensics.
const ARTIFACT_GC_GRACE_HOURS = 24
// Dead tokens / stale clients: keep 30 days (the grant-review / audit window).
const CREDENTIAL_GC_GRACE_DAYS = 30

export interface SessionGcResult {
  closedSessionIds: string[]
  /** True when the close budget ran out with idle devices still open. */
  closeBacklog: boolean
  /** AUTH-5 sweep counts. */
  authCodesDeleted: number
  emitHandoffsDeleted: number
  oauthTokensDeleted: number
  oauthClientsDeleted: number
  /** S6: registrations that NEVER had a token or code, reaped on the short grace. */
  abandonedClientsDeleted: number
}

/**
 * Open and idle past its window: the LATER of ts_expected_end and last sign of
 * life (last mint, else enrolment) + the window is in the past. Written as the
 * equivalent conjunction, not GREATEST, so it can use the partial index on
 * COALESCE(last_bearer_at, ts_start) over open rows (mig 0142); a
 * `timestamptz + interval` expression is not indexable. Exported so a test can
 * prove the plan uses that index.
 */
export function idleDevicePredicate(now: Date) {
  const nowIso = now.toISOString()
  const lastSignCutoff = new Date(now.getTime() - DEFAULT_TTL_MS).toISOString()
  return sql`
    ts_actual_end IS NULL
    AND COALESCE(last_bearer_at, ts_start) < ${lastSignCutoff}::timestamptz
    AND (ts_expected_end IS NULL OR ts_expected_end < ${nowIso}::timestamptz)`
}

export async function runSessionGc(
  db: PostgresJsDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<SessionGcResult> {
  const nowIso = now.toISOString()

  // Open instances past their idle window: the LATER of ts_expected_end and the
  // last sign of life (last mint, else enrolment) plus the window. The second
  // term covers rows whose ts_expected_end predates renewal (fixed at enrolment)
  // but which minted recently, and legacy rows with none.
  //
  // Closed in CHUNKS, each one transaction with its audit events (a failed audit
  // rolls the chunk back for the next run, never a close nobody recorded). A
  // cohort enrolled together goes idle together, and the caps admit tens of
  // thousands of rows, so one all-or-nothing batch could outlive the worker
  // gateway ceiling, roll back, and never make progress. The subquery's FOR
  // UPDATE re-checks the predicate against each row's latest committed version
  // (READ COMMITTED), and SKIP LOCKED steps over a row a /bearer renewal holds.
  //
  // Dates are bound as ISO strings + explicit ::timestamptz cast because
  // drizzle's sql tag + postgres-js doesn't auto-serialise Date over the
  // timestamptz wire type for ad-hoc execute() calls.
  const idlePast = idleDevicePredicate(now)
  const closed: string[] = []
  const deadline = Date.now() + CLOSE_BUDGET_MS
  let closeBacklog = false
  for (;;) {
    const chunk = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ instance_id: string; teammate_id: string }>(sql`
        UPDATE instance_attestation
           SET ts_actual_end = ${nowIso}::timestamptz
         WHERE instance_id IN (
                 SELECT instance_id FROM instance_attestation
                  WHERE ${idlePast}
                  LIMIT ${CLOSE_CHUNK}
                    FOR UPDATE SKIP LOCKED
               )
        RETURNING instance_id::text AS instance_id, teammate_id::text AS teammate_id
      `)
      for (const row of rows) {
        await recordAuditEvent(tx, {
          eventType: 'session-gc-closed',
          actorTeammateId: row.teammate_id,
          actorSystem: 'session-gc-worker',
          subjectKind: 'session',
          subjectId: row.instance_id,
          payload: { reason: 'abandoned', closedAt: now.toISOString() },
        })
      }
      return [...rows].map((row) => row.instance_id)
    })
    closed.push(...chunk)
    if (chunk.length < CLOSE_CHUNK) break
    if (Date.now() > deadline) {
      closeBacklog = true // the next run continues; every closed chunk is committed
      break
    }
  }

  // ── AUTH-5: OAuth-lifecycle sweep ──────────────────────────────────────────
  // Abandoned registrations FIRST, before the deadCodes/deadTokens deletes
  // below, so "never had a token or code" is not confused with "has none left".
  const abandonedClients = await reapAbandonedOAuthClients(db, nowIso)
  // Single-use auth codes past expiry/consumption + the artifact grace. Consumed
  // codes must outlive the grace (not be dropped immediately) so replay attempts
  // inside the window still hit the consumed row's invalid_grant, not unknown-code.
  const deadCodes = await db.execute<{ id: string }>(sql`
    DELETE FROM oauth_auth_code
     WHERE COALESCE(consumed_at, expires_at) < ${nowIso}::timestamptz - (${ARTIFACT_GC_GRACE_HOURS} * INTERVAL '1 hour')
    RETURNING id::text AS id
  `)
  const deadHandoffs = await db.execute<{ id: string }>(sql`
    DELETE FROM emit_handoff
     WHERE COALESCE(consumed_at, expires_at) < ${nowIso}::timestamptz - (${ARTIFACT_GC_GRACE_HOURS} * INTERVAL '1 hour')
    RETURNING id::text AS id
  `)
  // Tokens that are revoked or whose refresh credential expired, past the
  // credential grace. Live + merely-access-expired (refresh still valid) stay.
  const deadTokens = await db.execute<{ id: string }>(sql`
    DELETE FROM oauth_token
     WHERE COALESCE(revoked_at, refresh_expires_at) < ${nowIso}::timestamptz - (${CREDENTIAL_GC_GRACE_DAYS} * INTERVAL '1 day')
    RETURNING id::text AS id
  `)
  // Clients that DID transact: had a token/code at some point, but everything
  // referencing them has now aged out of the sweeps above, and the client row
  // itself is old enough. (Clients that NEVER transacted at all were already
  // reaped by the abandonedClients sweep above, on the much shorter grace.)
  const deadClients = await db.execute<{ client_id: string }>(sql`
    DELETE FROM oauth_client c
     WHERE c.internal = false
       AND c.created_at < ${nowIso}::timestamptz - (${CREDENTIAL_GC_GRACE_DAYS} * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM oauth_token t WHERE t.client_id = c.client_id)
       AND NOT EXISTS (SELECT 1 FROM oauth_auth_code ac WHERE ac.client_id = c.client_id)
    RETURNING client_id::text AS client_id
  `)
  if (
    deadCodes.length ||
    deadHandoffs.length ||
    deadTokens.length ||
    deadClients.length ||
    abandonedClients.length
  ) {
    await recordAuditEvent(db, {
      eventType: 'oauth-gc-swept',
      actorTeammateId: null,
      actorSystem: 'session-gc-worker',
      subjectKind: 'system',
      subjectId: null,
      payload: {
        authCodesDeleted: deadCodes.length,
        emitHandoffsDeleted: deadHandoffs.length,
        oauthTokensDeleted: deadTokens.length,
        oauthClientsDeleted: deadClients.length,
        abandonedClientsDeleted: abandonedClients.length,
        sweptAt: now.toISOString(),
      },
    })
  }

  return {
    closedSessionIds: closed,
    closeBacklog,
    authCodesDeleted: deadCodes.length,
    emitHandoffsDeleted: deadHandoffs.length,
    oauthTokensDeleted: deadTokens.length,
    oauthClientsDeleted: deadClients.length,
    abandonedClientsDeleted: abandonedClients.length,
  }
}
