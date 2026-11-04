/*
 * ensure-real-identity — when an admin ASSIGNS an existing teammate to a role that feeds the
 * manager-chain placement walk (cost-centre owner) or project membership, make sure that teammate
 * carries a REAL Entra identity, not a `bill:` placeholder.
 *
 * Why: a placeholder oid is invisible to loadActiveUnitOwners / loadActiveRegionLeaders (they filter
 * placeholder oids out of the walk's match maps), so a placeholder owner is SILENTLY non-functional
 * — the admin thinks they assigned the cost-centre manager, but nobody ever places under them.
 *
 * Mirrors the JIT bind-or-adopt (server/auth/jit-teammate.ts), and keeps its discipline:
 *  - a REAL oid → no-op.
 *  - a `bill:` placeholder (a known person from the provider bill) → resolve the real oid from the
 *    directory by email and ADOPT the row in place. The admin assignment IS the confirmation.
 *  - a `provisional:` placeholder (an emit-on-install shadow keyed on an UNVERIFIED claimed email)
 *    → 422. Like JIT, we do NOT launder an unconfirmed claim into a real identity; they must sign in.
 *  - if a real teammate already holds that oid, MERGE onto it — but only when it is the SAME human
 *    (email matches); a different email under that oid is an identity collision (409), never a
 *    silent retarget.
 * The resolved teammate is re-validated is_active (a merge must not install a deactivated
 * teammate; revoked_at is a session anchor that benign role/region changes bump, #428 —
 * so it does NOT gate assignability, else those changes would wrongly block).
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDirectoryUserByMailOrUpn, type DirectoryUser } from '../azure/directory'
import { recordAuditEvent } from '../db/audit'

type Tx = PostgresJsDatabase<Record<string, unknown>>
export type DirLookup = (email: string) => Promise<DirectoryUser | null>

export interface ResolvedIdentity {
  teammateId: string
  email: string
  displayName: string | null
  regionId: string
  /** true when a `bill:` placeholder row was upgraded in place to a real Entra oid. */
  adopted: boolean
}

// Drizzle WRAPS the postgres-js error; the real `.code` rides on `.cause` (jit-teammate.ts).
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e != null && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') return true
  }
  return false
}

interface TeammateRow extends Record<string, unknown> {
  id: string; email: string; display_name: string | null; region_id: string
  entra_oid: string; is_active: boolean; revoked_at: string | null
}
const select = sql`SELECT id::text AS id, email, display_name, region_id::text AS region_id,
  entra_oid, is_active, revoked_at::text AS revoked_at FROM teammate`

/** A resolved teammate must be assignable — gate on is_active ONLY. teammate.revoked_at is a
 *  SESSION ANCHOR (#428: benign role/region changes and revoke-sessions bump it to force a
 *  re-login), so it cannot gate assignability — a benign role change would wrongly block. A
 *  revoked-but-active teammate stays assignable; live access is independently blocked by
 *  isRevoked() and emit_revoked_at. is_active=false is the retirement axis and the guard here
 *  (a merge must not slip a deactivated row in); privileged-identity-cleanup and
 *  shadow-consolidation set it. */
function assertAssignable(row: TeammateRow): void {
  if (!row.is_active) {
    throw createError({ statusCode: 422, statusMessage: 'Teammate is not active' })
  }
}
const toResolved = (r: TeammateRow, adopted: boolean): ResolvedIdentity =>
  ({ teammateId: r.id, email: r.email, displayName: r.display_name, regionId: r.region_id, adopted })

/**
 * Resolve the real-identity teammate to use for an admin assignment. `via` labels the surface for
 * the audit; `lookup` is injectable for tests (default: the live directory). Returns the teammate_id
 * to assign (may differ from the input if it merged onto an existing real teammate) plus that
 * teammate's email/displayName/region.
 */
export async function ensureRealIdentity(
  tx: Tx,
  teammateId: string,
  actorTeammateId: string,
  via: string,
  lookup: DirLookup = getDirectoryUserByMailOrUpn,
): Promise<ResolvedIdentity> {
  const t = [...(await tx.execute<TeammateRow>(sql`${select} WHERE id = ${teammateId}::uuid LIMIT 1`))][0]
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })
  assertAssignable(t)

  if (!t.entra_oid.startsWith('bill:') && !t.entra_oid.startsWith('provisional:')) {
    return toResolved(t, false) // already a real identity — no-op
  }
  if (t.entra_oid.startsWith('provisional:')) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Unconfirmed identity',
      data: {
        type: 'https://tokenscope.example.com/errors/unconfirmed-identity',
        title: 'Unconfirmed identity',
        status: 422,
        detail: `${t.email} is an unconfirmed install-shadow (their email was claimed, not verified). They must sign in once before they can be assigned to a role that drives placement.`,
      },
    })
  }

  // bill: placeholder — resolve the real Entra identity by email.
  const dir = await lookup(t.email)
  if (!dir) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Directory identity not found',
      data: {
        type: 'https://tokenscope.example.com/errors/directory-identity',
        title: 'Directory identity not found',
        status: 422,
        detail: `No single Entra directory user matches ${t.email}. This person can't be assigned to a role that drives placement until their identity is confirmed (they appear in the directory, or sign in once).`,
      },
    })
  }

  // A real teammate may already hold this oid (they signed in separately). Merge onto it — but ONLY
  // if it's the same human (email matches); a different email under that oid is a collision, not a
  // silent retarget to someone the admin never picked.
  const existing = [...(await tx.execute<TeammateRow>(sql`${select} WHERE entra_oid = ${dir.oid} LIMIT 1`))][0]
  if (existing && existing.id !== t.id) {
    if (existing.email.toLowerCase() !== t.email.toLowerCase()) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Identity collision',
        data: {
          type: 'https://tokenscope.example.com/errors/identity-collision',
          title: 'Identity collision',
          status: 409,
          detail: `The directory identity for ${t.email} is already held by a different teammate. Resolve the duplicate before assigning.`,
        },
      })
    }
    assertAssignable(existing)
    await recordAuditEvent(tx, {
      eventType: 'teammate-identity-merged', actorTeammateId, subjectKind: 'teammate', subjectId: existing.id,
      payload: { oid: dir.oid, email: t.email, merged_from: t.id, via },
    })
    return toResolved(existing, false)
  }

  // Adopt the bill: placeholder in place: real oid, mark directory-sourced.
  // SAVEPOINT-wrapped (nested tx): this runs inside the caller's RLS
  // transaction, where a caught 23505 without a savepoint aborts the tx —
  // every query in the recovery branch below would then fail 25P02. The
  // nested tx rolls back to the savepoint instead, keeping the outer tx
  // (and the recovery reads) usable.
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(sql`
        UPDATE teammate SET entra_oid = ${dir.oid}, source = 'directory',
          display_name = COALESCE(display_name, ${dir.displayName}), last_sync_at = now()
        WHERE id = ${t.id}::uuid`)
    })
  } catch (err) {
    // The UPDATE only changes entra_oid, so the sole unique it can hit is the entra_oid index — a
    // concurrent adopt/login grabbed this oid between the check above and here. Merge onto that row
    // if it's the same human; else surface the collision (don't retarget to someone else).
    if (isUniqueViolation(err)) {
      const racer = [...(await tx.execute<TeammateRow>(sql`${select} WHERE entra_oid = ${dir.oid} LIMIT 1`))][0]
      if (racer && racer.id !== t.id && racer.email.toLowerCase() === t.email.toLowerCase()) {
        assertAssignable(racer)
        await recordAuditEvent(tx, {
          eventType: 'teammate-identity-merged', actorTeammateId, subjectKind: 'teammate', subjectId: racer.id,
          payload: { oid: dir.oid, email: t.email, merged_from: t.id, via, reason: 'race' },
        })
        return toResolved(racer, false)
      }
    }
    throw err
  }

  await recordAuditEvent(tx, {
    eventType: 'teammate-directory-adopted', actorTeammateId, subjectKind: 'teammate', subjectId: t.id,
    payload: { oid: dir.oid, email: t.email, via },
  })
  return { teammateId: t.id, email: t.email, displayName: t.display_name ?? dir.displayName, regionId: t.region_id, adopted: true }
}
