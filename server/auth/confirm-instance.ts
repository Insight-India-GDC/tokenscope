/*
 * confirm-instance.ts — the confirm-on-auth merge (emit-on-install, slice 5).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 3 ("Confirm
 * identity") + §Safety properties. This is the ONLY path that promotes a
 * provisional instance to 'confirmed' and re-points it from its provisional
 * SHADOW teammate to the real, authenticated teammate.
 *
 * It is display-only — confirmation NEVER moves money (the finance gate is
 * anchored to the provider bill / `reconciled`, not to identity_state). What it
 * does is upgrade a person's pre-bill OTel usage from "provisional" to
 * "confirmed" for dashboard confidence, and fold the shadow teammate away.
 *
 * THE ANTI-LAUNDERING GATE (the whole point): a provisional instance can only be
 * confirmed by the genuine owner of the email it CLAIMED. The merge requires a
 * real human auth (requireAuth at the endpoint) AND an explicit accept, and here
 * it additionally requires `claimed_email == the authenticated teammate's email`
 * (normalized). This is what stops the laundering vector the review raised:
 *   - An attacker who enrolled a spoof claiming a coworker's email CANNOT confirm
 *     it — their own authenticated email won't match the claim → 403.
 *   - The real owner of that email is the only principal who CAN confirm it, and
 *     they do so EXPLICITLY after seeing the device in their list — so an
 *     unfamiliar device is rejected by a human, never auto-adopted. There is no
 *     email-match auto-merge and no aggregate-reconciliation merge anywhere.
 *
 * Cleanup choice (documented): the freed provisional shadow teammate is
 * MARK-REVOKED, not hard-deleted. Every provisional teammate is named as the
 * actor of its `instance-enrolled-provisional` audit row, and
 * audit_event.actor_teammate_id REFERENCES teammate(id) with NO cascade
 * (RESTRICT) — plus audit_event is append-only — so a DELETE would be refused by
 * the FK. We therefore retire the shadow (revoked_at/ended_at/is_active=false)
 * once it owns no more instances. Real (provisional=false) teammates are NEVER
 * touched.
 *
 * claimed_email choice (documented): on the confirmed row we NULL claimed_email
 * and stamp the verified identity onto principal_oid/principal_email (matching
 * the authenticated provision_emit shape, where claimed_email is NULL and
 * principal_email carries the verified email). The prior claimed_email + prior
 * shadow teammate id are preserved in the `instance-confirmed` audit payload for
 * dispute reconstruction.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from '../db/audit'
import { advisoryGlobalCapLock, advisoryXactLock } from '../db/advisory-lock'
import { maxLiveInstancesGlobal, maxLiveInstancesPerTeammate } from './emit-provision'

type Db = PostgresJsDatabase<Record<string, unknown>>

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface ConfirmInstanceInput {
  /** The authenticated, real (provisional=false) teammate doing the confirm. */
  realTeammateId: string
  /** The authenticated teammate's email — the anti-laundering gate compares it. */
  realTeammateEmail: string
  /** The provisional instance to promote. */
  instanceId: string
  /** Best-effort audit context. */
  ipAddress?: string | null
  userAgent?: string | null
}

export interface ConfirmInstanceResult {
  instanceId: string
  identityState: 'confirmed'
  /** True when the instance was ALREADY confirmed for this teammate (idempotent no-op). */
  alreadyConfirmed: boolean
  /** The provisional shadow teammate that was retired (null when none / no-op). */
  retiredShadowTeammateId: string | null
}

interface AttRow extends Record<string, unknown> {
  identity_state: string
  claimed_email: string | null
  teammate_id: string
}
interface RealRow extends Record<string, unknown> {
  entra_oid: string
  email: string
  region_id: string
  org_unit_id: string
}

/**
 * Confirm (merge) a provisional instance onto the authenticated real teammate.
 * Runs in ONE transaction: load+gate → re-point attestation → re-bind the emit
 * credential → audit → retire the freed shadow teammate. A mid-sequence failure
 * (incl. a throwing audit) rolls the whole merge back.
 *
 * Throws:
 *   - 404 if the instance does not exist, OR is already confirmed but owned by a
 *     DIFFERENT teammate (no existence leak about another person's device).
 *   - 403 if it is provisional but its claimed_email != the authenticated email
 *     (THE anti-laundering gate).
 * Idempotent: an instance already confirmed for THIS teammate returns a no-op
 * success.
 */
export async function confirmProvisionalInstance(
  db: Db,
  input: ConfirmInstanceInput,
): Promise<ConfirmInstanceResult> {
  const realEmail = normalizeEmail(input.realTeammateEmail)

  return db.transaction(async (tx) => {
    // LOCK ORDER, the same as provisionEmit's: teammate row, then the principal
    // and global-cap advisory keys (ascending namespace order), then the device
    // row. The advisory keys before the DEVICE row: provisionEmit holds them
    // while it writes instance_attestation, so taking the device first would
    // deadlock against it. They also make the cap reads below serialise against
    // the create door, the only way a count-then-write can hold. See
    // server/db/advisory-lock.ts.
    //
    // Load the real teammate's authoritative placement + verified identity,
    // LOCKED, first (#417): FOR NO KEY UPDATE makes a concurrent placement move
    // wait, so the placement read here is current, and teammate-before-device is
    // the order every move uses. Then the principal and global-cap keys, the same
    // order provisionEmit takes them in (teammate, principal, global cap, rows),
    // so waiting on a busy teammate never holds the shared cap key.
    // The NOT provisional guard makes it impossible to re-point onto another shadow.
    const realRows = await tx.execute<RealRow>(sql`
      SELECT entra_oid,
             email,
             region_id::text  AS region_id,
             org_unit_id::text AS org_unit_id
        FROM teammate
       WHERE id = ${input.realTeammateId}::uuid
         AND NOT provisional
       LIMIT 1
         FOR NO KEY UPDATE
    `)
    await tx.execute(advisoryXactLock('principal', input.realTeammateId))
    await tx.execute(advisoryGlobalCapLock('confirmed'))

    // Lock the attestation row for the life of the merge.
    const attRows = await tx.execute<AttRow>(sql`
      SELECT identity_state,
             claimed_email,
             teammate_id::text AS teammate_id
        FROM instance_attestation
       WHERE instance_id = ${input.instanceId}::uuid
       FOR UPDATE
    `)
    const att = [...attRows][0]
    if (!att) {
      throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
    }

    // Idempotency: already confirmed.
    if (att.identity_state === 'confirmed') {
      if (att.teammate_id === input.realTeammateId) {
        return {
          instanceId: input.instanceId,
          identityState: 'confirmed' as const,
          alreadyConfirmed: true,
          retiredShadowTeammateId: null,
        }
      }
      // Confirmed for someone else — not this caller's to confirm. 404 (no leak).
      throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
    }

    // From here it is provisional. THE ANTI-LAUNDERING GATE: the claimed email
    // MUST equal the authenticated real teammate's email (case-insensitive).
    if (!att.claimed_email || normalizeEmail(att.claimed_email) !== realEmail) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'This device claimed a different email; only the claimed owner can confirm it.',
        },
      })
    }

    const real = [...realRows][0]
    if (!real) {
      throw createError({ statusCode: 404, statusMessage: 'Confirming teammate not found' })
    }

    // Confirmation is the THIRD door into the confirmed population, and it was
    // the only one that never counted. The other two both cap themselves:
    // provisionEmit caps creates, and the enrol door caps its own provisional
    // population. This transition moves a row OUT of the second and INTO the
    // first, and enforced neither. Two distinct escapes follow from that:
    //
    //   - The per-teammate cap. A provisional row is bound to its own SHADOW
    //     teammate, so it never counted against the real one. Enrol N devices
    //     claiming your own address, confirm all N, and the real teammate ends
    //     up with N live instances no matter what the cap says. That leg is
    //     pre-existing.
    //   - The global confirmed cap. Making that count exclude provisional rows
    //     is what turned this flip into an increment, so that leg arrived with
    //     the preceding commit and is mine.
    //
    // Enforce both with the SAME predicates the create door uses, so the three
    // doors cannot drift apart. Neither count includes the row being confirmed
    // (it is still provisional, and still bound to the shadow), so `>=` is the
    // correct comparison in both — identical to provisionEmit's.
    const teammateLive = await tx.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM instance_attestation
       WHERE teammate_id = ${input.realTeammateId}::uuid
         AND ts_actual_end IS NULL AND ts_purged IS NULL
    `)
    if (Number([...teammateLive][0]?.count ?? 0) >= maxLiveInstancesPerTeammate()) {
      throw createError({
        statusCode: 429,
        statusMessage: 'Device capacity reached',
        data: {
          type: 'https://tokenscope.example.com/errors/capacity-reached',
          title: 'Device capacity reached',
          status: 429,
          detail:
            'You already have the maximum number of live devices. Revoke one, then confirm this device.',
        },
      })
    }
    const confirmedLive = await tx.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM instance_attestation
       WHERE identity_state = 'confirmed'
         AND ts_actual_end IS NULL AND ts_purged IS NULL
    `)
    if (Number([...confirmedLive][0]?.count ?? 0) >= maxLiveInstancesGlobal()) {
      throw createError({
        statusCode: 429,
        statusMessage: 'Enrollment capacity reached',
        data: {
          type: 'https://tokenscope.example.com/errors/capacity-reached',
          title: 'Enrollment capacity reached',
          status: 429,
          detail: 'This deployment is at its device limit. Contact your TokenScope administrator.',
        },
      })
    }

    const priorShadowTeammateId = att.teammate_id
    const priorClaimedEmail = att.claimed_email

    // 1. Re-point the attestation to the real teammate + flip to confirmed.
    //    Re-place region/org_unit from the real teammate, stamp the verified
    //    identity onto principal_oid/principal_email, and NULL claimed_email
    //    (the audit row below preserves it for dispute reconstruction).
    await tx.execute(sql`
      UPDATE instance_attestation
         SET teammate_id    = ${input.realTeammateId}::uuid,
             identity_state = 'confirmed',
             claimed_email  = NULL,
             principal_oid  = ${real.entra_oid},
             principal_email = ${real.email},
             region_id      = ${real.region_id}::uuid,
             org_unit_id    = ${real.org_unit_id}::uuid
       WHERE instance_id = ${input.instanceId}::uuid
    `)

    // 2. Re-bind the live emit credential: it was bound to the SHADOW teammate;
    //    after the merge it must answer to the real teammate so /bearer ownership
    //    + the ADR-0005 E2 revocation cascade key off the right identity.
    await tx.execute(sql`
      UPDATE oauth_token
         SET teammate_id = ${input.realTeammateId}::uuid
       WHERE instance_id = ${input.instanceId}::uuid
         AND revoked_at IS NULL
         AND scope = 'tokenscope.emit'
    `)

    // 2b. Backfill the already-written attribution history (PR #87 FIX 2). Rows
    //     emitted while the instance was provisional were stamped with the SHADOW
    //     teammate + identity_state='provisional' + the shadow's default placement.
    //     Confirmation must UPGRADE that history so every downstream surface (incl.
    //     the owner-scoped me/instances + finance views) sees the real teammate's
    //     confirmed spend — otherwise the pre-confirm spend stays orphaned on the
    //     retired shadow. Re-point teammate_id + identity_state and re-stamp the
    //     denormalized dimensions to the real teammate's, mirroring the attestation
    //     re-point above. cost_owning_unit_id is only re-homed where it still equals
    //     the row's org_unit_id (the untagged-spill default) so an explicit
    //     project-tagged CC is preserved (PG evaluates every SET against the row's
    //     pre-update values, so the CASE sees the OLD org_unit_id).
    //     ts_recorded = now() MUST ride the same UPDATE: every ledger mutation
    //     bumps the write instant (the tag-session.ts:181-200 precedent), and the
    //     usage-rollup source-write signal keys its recompute set on it — without
    //     the bump this historical rewrite is invisible to the rollup once the
    //     trailing window narrows (performance-observability-baseline.md O5,
    //     dr-H4; usage-rollup-lane.md R4).
    await tx.execute(sql`
      UPDATE attribution_record
         SET teammate_id         = ${input.realTeammateId}::uuid,
             identity_state      = 'confirmed',
             region_id           = ${real.region_id}::uuid,
             cost_owning_unit_id = CASE
               WHEN cost_owning_unit_id IS NOT DISTINCT FROM org_unit_id
                 THEN ${real.org_unit_id}::uuid
               ELSE cost_owning_unit_id
             END,
             org_unit_id         = ${real.org_unit_id}::uuid,
             ts_recorded         = now()
       WHERE instance_id = ${input.instanceId}::uuid
         AND teammate_id = ${priorShadowTeammateId}::uuid
    `)

    // 3. Audit (actor = the real teammate; subject = the instance). Carry the
    //    prior shadow teammate id + claimed email for dispute reconstruction.
    await recordAuditEvent(tx as never, {
      eventType: 'instance-confirmed',
      actorTeammateId: input.realTeammateId,
      actorSystem: 'me',
      subjectKind: 'instance',
      subjectId: input.instanceId,
      payload: {
        prior_provisional_teammate_id: priorShadowTeammateId,
        claimed_email: priorClaimedEmail,
        confirmed_email: real.email,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    })

    // 4. Retire the freed shadow teammate IFF it now owns no instances AND is
    //    provisional (NEVER touch a real teammate). Mark-revoke rather than
    //    delete: the enroll audit row RESTRICTs deletion (see file header).
    let retiredShadowTeammateId: string | null = null
    const remainingRows = await tx.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n
        FROM instance_attestation
       WHERE teammate_id = ${priorShadowTeammateId}::uuid
    `)
    const remaining = Number([...remainingRows][0]?.n ?? 0)
    if (remaining === 0) {
      const retired = await tx.execute<{ id: string }>(sql`
        UPDATE teammate
           SET revoked_at = now(),
               emit_revoked_at = now(),
               ended_at   = now(),
               is_active  = false
         WHERE id = ${priorShadowTeammateId}::uuid
           AND provisional = true
        RETURNING id::text AS id
      `)
      retiredShadowTeammateId = [...retired][0]?.id ?? null
    }

    return {
      instanceId: input.instanceId,
      identityState: 'confirmed' as const,
      alreadyConfirmed: false,
      retiredShadowTeammateId,
    }
  })
}
