/*
 * applyWorklistBulk — one decision applied to a SET of needs-tagging items.
 *
 * The worklist mixes two item kinds (a conversation and a provider-recorded
 * §A day) and supports three decisions (tag / dismiss / restore); this is the
 * single primitive behind all six combinations. Design:
 * docs/design/needs-tagging-worklist.md.
 *
 * ALL-OR-NOTHING. Every id is ownership-checked up front, and the tag path
 * delegates per item to the same primitives the single-item endpoints use
 * (tagSessionTx / tagUnaccountedTx), so their membership + ended-budget gates
 * apply unchanged. Any failure throws and the caller's transaction rolls the
 * whole batch back. A partial result would leave the developer unable to tell
 * which half landed on the one surface whose entire purpose is "clear the list".
 *
 * DISMISSAL IS NOT A LEDGER WRITE. dismiss/restore only move an item in or out
 * of the queue by stamping `dismissed_at`; no cost, project or activity changes,
 * and the spend keeps counting in the unallocated total. Tagging supersedes a
 * dismissal (both tag primitives clear `dismissed_at`), and a dismissal records
 * the AMOUNT it was about so it can be handed back when the item outgrows it
 * (sweepStaleDismissals).
 *
 * TAGGED XOR DISMISSED is a DB constraint (mig 0094), not a convention. This
 * module's job is to turn the two ways a client could reach for that state — a
 * stale tab dismissing something already tagged, or a dismissal racing a tag —
 * into a clean 409 instead of a constraint violation: the same per-conversation
 * advisory lock tagSessionTx takes, then a re-read of the current decision
 * inside that lock.
 *
 * MUST run inside a transaction.
 */
import { createError } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from '../db/audit'
import { conversationKeyExpr, unallocatedConversationSpendExpr } from '../db/conversation-key'
import { sessionTagXactLock } from '../db/advisory-lock'
import { tagSessionTx } from './tag-session'
import { tagUnaccountedTx } from './tag-unaccounted'
import type { WorklistBulkBody, WorklistBulkResult } from '#shared/schemas/worklist'

type Tx = PostgresJsDatabase<Record<string, unknown>>

const ACTOR_SYSTEM = 'me-worklist-bulk'

/** A PG list literal for `IN (...)` — never called with an empty array. */
function inList(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )
}

/**
 * Ids are echoed back so the developer can see WHICH items failed, but a
 * conversation id is client-supplied free text (the MCP tool drives arbitrary
 * strings) and the detail lands in logs and error dashboards, not only in the
 * response. Show only ids that look like ids; count the rest.
 */
function safeIds(ids: string[], limit = 3): string {
  const shown = ids.slice(0, limit).map((id) => (/^[\w.:-]{1,256}$/.test(id) ? id : '(unprintable id)'))
  return shown.join(', ') + (ids.length > limit ? ', …' : '')
}

function forbidUnowned(kind: 'session' | 'day', missing: string[]): never {
  const noun = `${kind === 'session' ? 'session' : 'day'}${missing.length === 1 ? '' : 's'}`
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/not-yours',
      title: 'Some items are not yours',
      status: 403,
      detail:
        `${missing.length} selected ${noun} ${missing.length === 1 ? 'is' : 'are'} not yours or not recorded yet ` +
        `(${safeIds(missing)}). Nothing was changed — refresh and try again.`,
    },
  })
}

function conflictAlreadyTagged(kind: 'session' | 'day', ids: string[]): never {
  const noun = `${kind === 'session' ? 'session' : 'day'}${ids.length === 1 ? '' : 's'}`
  throw createError({
    statusCode: 409,
    statusMessage: 'Already tagged',
    data: {
      type: 'https://tokenscope.example.com/errors/conflict',
      title: 'Already tagged',
      status: 409,
      detail:
        `${ids.length} selected ${noun} ${ids.length === 1 ? 'has' : 'have'} already been tagged ` +
        `(${safeIds(ids)}), so ${ids.length === 1 ? 'it' : 'they'} can't be dismissed. ` +
        'Nothing was changed — refresh to see the current state.',
    },
  })
}

export async function applyWorklistBulk(
  tx: Tx,
  teammateId: string,
  body: WorklistBulkBody,
): Promise<WorklistBulkResult> {
  // The same id twice is one item, not two — a double-click on "select all"
  // must not double-count the result or double-audit the decision.
  const sessions = [...new Set(body.sessions)]
  const unaccounted = [...new Set(body.unaccounted)]

  // TWO LANES, TWO LOCKS, ONE GUARANTEE. A conversation has no row of its own
  // until it is decided about (session_assignment rows are created BY the
  // decision), so there is nothing to `FOR UPDATE` — its serialisation is the
  // advisory lock keyed on (conversation, teammate), exactly the one
  // tagSessionTx takes. A provider-recorded day is an existing row, so its
  // serialisation is that row's lock (taken in the ownership read below). Both
  // are taken in sorted order, up front, for EVERY action — do not "fix" one
  // lane by copying the other's mechanism; they are different because the
  // things being locked are different.
  for (const sid of [...sessions].sort()) {
    await tx.execute(sessionTagXactLock(sid, teammateId))
  }

  // ── Ownership pre-flight (both kinds, before any write) ───────────────────
  // Sessions are matched on the SAME conversation key the worklist renders
  // (claude_session_id, falling back to instance_id for legacy pre-0016 rows),
  // so an id the card offered is always an id this check accepts.
  if (sessions.length > 0) {
    const owned = await tx.execute<{ k: string }>(sql`
      SELECT DISTINCT ${conversationKeyExpr('ar')} AS k
        FROM attribution_record ar
       WHERE ar.teammate_id = ${teammateId}::uuid
         AND ${conversationKeyExpr('ar')} IN (${inList(sessions)})
    `)
    const found = new Set([...owned].map((r) => r.k))
    const missing = sessions.filter((s) => !found.has(s))
    if (missing.length > 0) forbidUnowned('session', missing)
  }
  // The day lane has no conversation key to hang an advisory lock on, so its
  // serialisation is the ROW lock — taken here, in id order, for EVERY action
  // rather than per-branch. tagUnaccountedTx takes the same FOR UPDATE per row,
  // so once these are held in a total order a concurrent bulk (in any order) or
  // single-item tag waits instead of racing, and two overlapping batches cannot
  // deadlock. Doing it once here is also what stops the next branch added to
  // this function from quietly missing the treatment.
  const dayState = new Map<string, boolean>()
  if (unaccounted.length > 0) {
    const owned = await tx.execute<{ id: string; decided: boolean }>(sql`
      SELECT id::text AS id,
             (project_id IS NOT NULL OR activity IS NOT NULL) AS decided
        FROM unaccounted_usage
       WHERE teammate_id = ${teammateId}::uuid AND id IN (${inList(unaccounted)})
       ORDER BY id
       FOR UPDATE
    `)
    for (const r of owned) dayState.set(r.id, r.decided)
    const missing = unaccounted.filter((id) => !dayState.has(id))
    if (missing.length > 0) forbidUnowned('day', missing)
  }

  if (body.action === 'tag') {
    // Per-item, through the single-item primitives: same gates, same ledger
    // semantics (boundary preservation, advisory lock), same per-item audit —
    // with actor_system marking the bulk path. Deliberately not one blanket
    // UPDATE: tagging a conversation is not a one-statement operation.
    const axes = {
      setProject: body.project_id !== undefined,
      projectVal: body.project_id ?? null,
      setActivity: body.activity !== undefined,
      activityVal: body.activity ?? null,
    }
    for (const sid of sessions) {
      await tagSessionTx(tx, teammateId, sid, axes, { actorSystem: ACTOR_SYSTEM })
    }
    for (const id of [...unaccounted].sort()) {
      await tagUnaccountedTx(tx, teammateId, id, axes, { actorSystem: ACTOR_SYSTEM })
    }
    return {
      action: 'tag',
      sessions: sessions.length,
      unaccounted: unaccounted.length,
      total: sessions.length + unaccounted.length,
    }
  }

  if (body.action === 'dismiss') {
    // Only an UNDECIDED item can be dismissed. Re-read the current state inside
    // the advisory lock so a tag that landed between the client's render and
    // this call is a clean 409, not a CHECK violation surfacing as a 500.
    if (sessions.length > 0) {
      const tagged = await tx.execute<{ k: string }>(sql`
        SELECT claude_session_id AS k FROM session_assignment
         WHERE teammate_id = ${teammateId}::uuid
           AND claude_session_id IN (${inList(sessions)})
           AND (project_id IS NOT NULL OR activity IS NOT NULL)
      `)
      const taggedIds = [...tagged].map((r) => r.k)
      if (taggedIds.length > 0) conflictAlreadyTagged('session', taggedIds)

      // session_assignment is the per-(conversation, teammate) decision record;
      // a dismissal-only row (both axes NULL) is legal since mig 0094. The
      // snapshot is the conversation's CURRENT unallocated spend — what the
      // developer was actually looking at when they decided — taken with the
      // SAME expression sweepStaleDismissals compares against. Keying it on
      // claude_session_id alone would snapshot a legacy instance-keyed
      // conversation at $0, and the very next sweep would judge that dismissal
      // stale and undo it.
      const values = sql.join(
        sessions.map((s) => sql`(${s})`),
        sql`, `,
      )
      const snapshotExpr = unallocatedConversationSpendExpr(sql.raw('v.sid'), sql`${teammateId}::uuid`)
      await tx.execute(sql`
        INSERT INTO session_assignment (claude_session_id, teammate_id, dismissed_at, dismissed_cost_usd, source)
        SELECT v.sid, ${teammateId}::uuid, now(), ${snapshotExpr}, 'manual'
          FROM (VALUES ${values}) AS v(sid)
        ON CONFLICT (claude_session_id, teammate_id) DO UPDATE SET
          dismissed_at = now(), dismissed_cost_usd = EXCLUDED.dismissed_cost_usd
      `)
    }
    if (unaccounted.length > 0) {
      // Read under the row lock taken above, so a tag landing between the check
      // and the write waits instead of racing it into the tagged-XOR-dismissed
      // CHECK (which would surface as a 500, not the 409 this path promises).
      const taggedIds = unaccounted.filter((id) => dayState.get(id))
      if (taggedIds.length > 0) conflictAlreadyTagged('day', taggedIds)

      await tx.execute(sql`
        UPDATE unaccounted_usage SET dismissed_at = now(), dismissed_cost_usd = cost_usd
         WHERE teammate_id = ${teammateId}::uuid AND id IN (${inList(unaccounted)})
      `)
    }
  } else {
    // restore — back into the queue.
    if (sessions.length > 0) {
      // A dismissal-only row has nothing left to say once the dismissal is
      // lifted, and the CHECK (project OR activity OR dismissed_at) forbids
      // leaving it behind empty. Deleting the row IS the restore; a row that
      // carries a tag axis cannot also be dismissed (the XOR constraint), so
      // there is no second case to handle.
      await tx.execute(sql`
        DELETE FROM session_assignment
         WHERE teammate_id = ${teammateId}::uuid
           AND claude_session_id IN (${inList(sessions)})
           AND dismissed_at IS NOT NULL
      `)
    }
    if (unaccounted.length > 0) {
      await tx.execute(sql`
        UPDATE unaccounted_usage SET dismissed_at = NULL, dismissed_cost_usd = NULL
         WHERE teammate_id = ${teammateId}::uuid AND id IN (${inList(unaccounted)})
      `)
    }
  }

  // One audit row per BATCH for dismiss/restore: the decision is the batch (the
  // tag path audits per item inside the primitives). Ids are recorded so the
  // action is reconstructable — the batch is capped, so the payload is bounded.
  await recordAuditEvent(tx, {
    eventType: body.action === 'dismiss' ? 'worklist-dismissed' : 'worklist-restored',
    actorTeammateId: teammateId,
    actorSystem: ACTOR_SYSTEM,
    subjectKind: 'worklist',
    subjectId: null,
    payload: {
      sessions,
      unaccounted,
      session_count: sessions.length,
      unaccounted_count: unaccounted.length,
    },
  })

  return {
    action: body.action,
    sessions: sessions.length,
    unaccounted: unaccounted.length,
    total: sessions.length + unaccounted.length,
  }
}
