/*
 * placeTeammate — THE write that moves one teammate to a cost centre.
 *
 * WHY IT EXISTS. There are now two surfaces that place people: the per-row
 * select on /admin/users (PATCH /admin/users/:id/org-unit) and the bulk action
 * on the region worklist (POST /admin/users/bulk-place). They must not each
 * decide who is allowed to move whom — a second copy of the region rule is how
 * a cross-region placement gets through one door while the other holds. So the
 * authorisation, the region containment, the provenance strip and the audit row
 * live HERE, once, and both handlers call this.
 *
 * THE AUTHORISATION IS NOT PARAMETERISED, deliberately. Every caller gets:
 *   1. the teammate must exist (404);
 *   2. `requireRegionScope` against the TEAMMATE's region — a region admin
 *      cannot move another region's person;
 *   3. the target unit must be ACTIVE and in the TEAMMATE's OWN region (422).
 * (2)+(3) compose into the property the bulk endpoint needs and that neither
 * check gives alone: the target unit is in a region the caller administers.
 * There is no flag that relaxes any of it.
 *
 * WHAT *IS* PARAMETERISED is `targetPolicy`, and it is a PRODUCT rule, not a
 * safety control:
 *
 *   'any-active-unit'   — the /admin/users per-row move. Any active unit in the
 *                         region is a legal destination. This is the existing,
 *                         pinned contract (tests/integration/admin/
 *                         region-lifecycle.test.ts §7 moves a teammate onto a
 *                         plain `team` node and asserts 200) and it is not
 *                         narrowed here.
 *   'cost-owning-only'  — the bulk PLACE action. Its whole purpose is to make
 *                         spend reach a cost centre, so it refuses a target that
 *                         is not itself cost-owning. That also refuses the
 *                         `__UNPLACED__` holding node for free (holding nodes are
 *                         created is_cost_owning_unit = false), which is the one
 *                         destination that would look like progress and be none.
 *
 * The narrower policy is strictly SAFER, never laxer, so the two doors cannot
 * disagree about who may act — only about which destinations the action offers.
 *
 * ── THE CHECKS RUN UNDER LOCKS, because otherwise they are advisory ───────
 * Every one of those checks reads a row that another transaction can change
 * before this one's UPDATE lands, and READ COMMITTED gives each statement its own
 * snapshot. Unlocked, both of these are real:
 *   - a concurrent region PATCH moves the teammate to another region AFTER
 *     requireRegionScope passed against the old one → the UPDATE completes and a
 *     region admin has placed a person who is no longer theirs, with none of the
 *     revoke cascade that a cross-region move owes;
 *   - a concurrent retire (or a cost-owning un-tick) lands on the destination
 *     AFTER it validated as an active cost-owning unit → the teammate is placed
 *     into a retired bucket.
 * So the teammate row is taken FOR UPDATE and the destination unit FOR SHARE
 * before anything is validated, and both are held to commit.
 *
 * The destination is FOR SHARE rather than FOR UPDATE deliberately. We are not
 * modifying it — we require only that it cannot be retired or un-flagged under
 * us, which is exactly what a share lock buys, and share locks are mutually
 * compatible. An exclusive lock would make two bulk batches aiming at the SAME
 * cost centre serialise on it, and — because a batch holds every lock it has
 * taken until the outer transaction commits — two batches placing overlapping
 * ids in different orders would DEADLOCK. A share lock still blocks the retire.
 */
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireRegionScope } from '../auth/rbac'
import { recordAuditEvent } from './audit'
import { assertOrgUnitInRegion } from './org-units'
import { PLACEMENT_AUDIT_EVENT, stripProvenanceKeys } from '../reconciliation/placement-provenance'
import { followPlacement } from '../utils/device-lifecycle'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * Which destinations a placement write accepts. See the header — this is a
 * product rule per surface, never a relaxation of the region checks.
 */
export type PlacementTargetPolicy = 'any-active-unit' | 'cost-owning-only'

/**
 * The 400 detail for a request that still sends `rehome`. Both placement doors
 * used to accept it to rewrite a person's recorded usage onto their new unit;
 * reports now group by where people sit now, so that rewrite corrects nothing.
 * Refused rather than ignored so a stale client fails loudly.
 */
export const REHOME_REMOVED_DETAIL = 'Recorded usage no longer moves with a person: reports follow where people sit now.'

export interface PlaceTeammateOpts {
  teammateId: string
  orgUnitId: string
  targetPolicy: PlacementTargetPolicy
  caller: { teammateId: string }
  /** Correlates the rows written by one bulk action. null for a single move. */
  batchId?: string | null
  /** Extra audit payload keys from the caller (placement-check: source, step, provenance). */
  auditContext?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * The 'cost-owning-only' target rule, as ONE function with ONE message per
 * refusal.
 *
 * Called TWICE per bulk request on purpose, and that is not a duplicated rule:
 * the bulk handler calls it once up front so a wrong target is one legible 422
 * instead of forty identical per-id failures, and placeTeammate calls it per id
 * because placeTeammate is where the placement rule lives and a caller that
 * skipped the pre-flight must not get a laxer write. Because both call THIS
 * function, changing the rule changes both — there is no copy to drift.
 *
 * A retired unit and a non-cost-owning unit get DIFFERENT sentences: they are
 * different mistakes with different fixes, and "invalid target" tells an admin
 * neither. The holding node lands on the second one, which is the message
 * someone clearing the Unplaced worklist actually needs to read.
 */
export async function assertCostOwningTarget(tx: Tx, orgUnitId: string): Promise<void> {
  const rows = await tx.execute<{ is_cost_owning_unit: boolean; retired: boolean }>(sql`
    SELECT is_cost_owning_unit, (retired_at IS NOT NULL) AS retired
    FROM org_unit WHERE id = ${orgUnitId}::uuid LIMIT 1
  `)
  const unit = [...rows][0]
  if (unit && !unit.retired && unit.is_cost_owning_unit) return
  const detail =
    unit && unit.retired
      ? 'That Business Unit is retired — pick an active one.'
      : 'Placement targets must be Business Units — spend homed anywhere else still reaches no Business Unit.'
  throw createError({
    statusCode: 422,
    statusMessage: detail,
    data: {
      type: 'https://tokenscope.example.com/errors/unprocessable',
      title: 'Unprocessable',
      status: 422,
      detail,
    },
  })
}

export interface PlaceTeammateResult {
  id: string
  email: string
  regionId: string
  previousOrgUnitId: string
  orgUnitId: string
  /**
   * 'noop' — they were ALREADY in this unit, so nothing was written. See the
   * same-unit branch below for why that is a distinct outcome and not a success.
   */
  outcome: 'placed' | 'noop'
}

/**
 * Move ONE teammate to `orgUnitId`, with the full guard set above, an audit row,
 * and the manager-chain provenance stripped.
 *
 * Throws h3 errors (404 / 403 / 422) — the bulk caller turns those, and ONLY
 * those, into per-id outcomes, so a single bad id cannot discard the batch.
 *
 * Runs entirely on the `tx` it is handed: the audit row and the UPDATE commit
 * together or not at all (the single-move endpoint's existing property, kept).
 */
export async function placeTeammate(
  event: H3Event,
  tx: Tx,
  opts: PlaceTeammateOpts,
): Promise<PlaceTeammateResult> {
  /*
   * Locked, so `region_id` cannot change between the authorisation check
   * below and the UPDATE at the bottom. Without it a concurrent region PATCH
   * makes requireRegionScope a statement about a region this teammate has since
   * left. Also serialises two placements of the same person, and a placement
   * with a provision or confirmation (#417).
   *
   * FOR NO KEY UPDATE: it blocks every other writer of this row, and unlike FOR
   * UPDATE it does not conflict with the FOR KEY SHARE a device-first path takes
   * on it (session-gc's audit insert). This move locks the teammate's devices
   * next (followPlacement), so a conflict there would be a deadlock.
   */
  const targetRows = await tx.execute<{
    id: string
    region_id: string
    org_unit_id: string
    email: string
    provisional: boolean
  }>(sql`
    SELECT id::text AS id, region_id::text AS region_id, org_unit_id::text AS org_unit_id, email, provisional
    FROM teammate WHERE id = ${opts.teammateId}::uuid LIMIT 1
    FOR NO KEY UPDATE
  `)
  const target = [...targetRows][0]
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })

  // Region admin is bound to the TEAMMATE's region.
  await requireRegionScope(event, target.region_id)

  // After the scope check, so an admin of another region gets the scope error,
  // not this one. A provisional (shadow) teammate is placed by identity confirmation, which
  // also places its devices; an admin move would leave them behind (#417).
  if (target.provisional) {
    throw createError({ statusCode: 422, statusMessage: 'A provisional teammate is placed when their device is confirmed, not by a placement move' })
  }

  /*
   * Pin the destination BEFORE validating it (header: FOR SHARE, not FOR
   * UPDATE). Everything the two asserts below read — region_id, retired_at,
   * is_cost_owning_unit — is now stable to commit, so "active cost-owning unit
   * in the teammate's region" is a fact about the row this placement lands on,
   * not about the row as it was a moment ago. A missing row locks nothing and
   * falls through to the 422 the asserts already raise.
   */
  await tx.execute(sql`SELECT 1 FROM org_unit WHERE id = ${opts.orgUnitId}::uuid FOR SHARE`)

  // Target unit must be active and in the teammate's own region. Combined with
  // the scope check above, this is what stops a region admin placing their own
  // people into another region's unit.
  await assertOrgUnitInRegion(tx, {
    orgUnitId: opts.orgUnitId,
    regionId: target.region_id,
    mustBeActive: true,
    statusMessage: 'org_unit is not an active unit in the teammate region',
    data: {
      type: 'https://tokenscope.example.com/errors/unprocessable',
      title: 'Unprocessable',
      status: 422,
      detail: 'org_unit_id must reference an active org unit in the teammate\'s region.',
    },
  })

  if (opts.targetPolicy === 'cost-owning-only') await assertCostOwningTarget(tx, opts.orgUnitId)

  /*
   * ALREADY THERE → write NOTHING, and say so.
   *
   * The bulk action is reachable from the All and the Placed views, so
   * re-placing someone into the unit they are already in is a normal mis-click,
   * not an exotic one. Falling through would audit a placement that did not
   * happen AND strip placedVia/placedOwnerOid — freezing a manager-chain
   * placement into a manual override and taking that person out of
   * re-enrichment for good. The person does not move either way; the difference
   * is whether they keep being re-derived when their Entra manager changes. So
   * this is a distinct outcome, not a quiet success.
   *
   * AFTER the guards, deliberately: re-placing someone into a target they are
   * already on but which is now retired, or is the holding node, is still a
   * refusal. "Nothing to do" must never be the reason an illegal destination
   * goes unreported.
   */
  if (target.org_unit_id === opts.orgUnitId) {
    return {
      id: target.id,
      email: target.email,
      regionId: target.region_id,
      previousOrgUnitId: target.org_unit_id,
      orgUnitId: opts.orgUnitId,
      outcome: 'noop',
    }
  }

  /*
   * Intra-region move: org_unit_id only. Do NOT touch revoked_at — the teammate's
   * region scope and org_path-derived visibility are unchanged, so their live
   * sessions stay valid (unlike the region PATCH, which must force a re-login).
   *
   * The DERIVED placement provenance is CLEARED: an admin move overrides the
   * derivation, so neither region-reenrichment nor the region re-resolve may
   * re-derive this teammate straight back onto the chain's (or a rule's) unit.
   * This is the property that makes a bulk placement survive the next worker tick.
   *
   * The key list comes from server/reconciliation/placement-provenance.ts, the
   * same list the writer builds from — a key written there and not stripped here
   * would leave an admin placement looking derived, and re-derivable.
   */
  await tx.execute(sql`
    UPDATE teammate
    SET org_unit_id = ${opts.orgUnitId}::uuid,
        metadata = (coalesce(metadata, '{}'::jsonb) ${stripProvenanceKeys()})
    WHERE id = ${target.id}::uuid
  `)

  // The teammate's live devices move with them, so new spend lands on the new
  // unit (#417; owner ruling: a move within a region counts). Recorded spend
  // does not move: reports group by where people sit now, not by the stamp.
  const rehomedInstanceIds = await followPlacement(tx as never, target.id)

  await recordAuditEvent(tx, {
    eventType: PLACEMENT_AUDIT_EVENT,
    actorTeammateId: opts.caller.teammateId,
    actorSystem: 'admin-ui',
    subjectKind: 'teammate',
    subjectId: target.id,
    payload: {
      targetEmail: target.email,
      region_id: target.region_id,
      previousOrgUnitId: target.org_unit_id,
      newOrgUnitId: opts.orgUnitId,
      sessionsRevoked: false,
      // Present only on a bulk action, so one batch is reviewable as a unit.
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      ...opts.auditContext,
      // Present only when the teammate had live devices to move.
      ...(rehomedInstanceIds.length > 0 ? { rehomedInstanceIds } : {}),
    },
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  })

  return {
    id: target.id,
    email: target.email,
    regionId: target.region_id,
    previousOrgUnitId: target.org_unit_id,
    orgUnitId: opts.orgUnitId,
    outcome: 'placed',
  }
}
