/*
 * reassignTeammateRegion — THE write that moves one teammate to another region.
 * Callers: the region PATCH and placement-check apply. Authorisation is the
 * caller's (platform-admin only); this owns the cascade.
 *
 * Re-scoping a teammate changes what they can see, so `revoked_at` is bumped
 * (their cookie 401s on its next request and they re-login into the new scope)
 * and their interactive credentials die. Devices keep emitting and move with
 * them (#414, #417). Placement provenance is stripped: an admin move overrides
 * the derivation, so no worker may re-derive them back.
 *
 * With no `orgUnitId` the teammate lands on the target region's `__UNPLACED__`
 * holding node (S3), never the region root, whose subtree is the whole region.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { recordAuditEvent } from './audit'
import { unplacedOrgUnitIdForRegion } from '../auth/placement-home'
import { revokeInteractiveCredentialsOf } from '../auth/emit-revocation'
import { followPlacement } from '../utils/device-lifecycle'
import { stripProvenanceKeys } from '../reconciliation/placement-provenance'
import { REGION_AUDIT_EVENT } from '../reconciliation/placement-manual'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface ReassignTeammateRegionOpts {
  teammateId: string
  regionId: string
  /** Must be in `regionId`; omitted = that region's holding node. */
  orgUnitId?: string
  caller: { teammateId: string }
  /** Correlates the audit rows of one batch. */
  batchId?: string | null
  /** Extra audit payload keys from the caller (placement-check: source, step, provenance). */
  auditContext?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

export interface ReassignTeammateRegionResult {
  previousRegionId: string
  newRegionId: string
  orgUnitId: string
  rehomedInstanceIds: string[]
}

/** Throws h3 404 (no teammate) / 422 (provisional, unknown region, unit not in region). */
export async function reassignTeammateRegion(
  tx: Tx,
  opts: ReassignTeammateRegionOpts,
): Promise<ReassignTeammateRegionResult> {
  // Locked first: a concurrent provision or confirmation takes this row the same
  // way before writing a device's placement (#417). NO KEY UPDATE so it does not
  // conflict with the FOR KEY SHARE a device-first path takes (session-gc's audit
  // insert), which would deadlock against followPlacement below.
  const targetRows = await tx.execute<{ id: string; region_id: string; email: string; provisional: boolean }>(sql`
    SELECT id::text AS id, region_id::text AS region_id, email, provisional
    FROM teammate WHERE id = ${opts.teammateId}::uuid LIMIT 1
    FOR NO KEY UPDATE
  `)
  const target = [...targetRows][0]
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })
  // A provisional teammate is placed by identity confirmation, which also places
  // its devices; an admin move would leave them behind (#417).
  if (target.provisional) {
    throw createError({ statusCode: 422, statusMessage: 'A provisional teammate is placed when their device is confirmed, not by a placement move' })
  }

  const regionRows = await tx.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM region WHERE id = ${opts.regionId}::uuid LIMIT 1`,
  )
  if ([...regionRows].length === 0) throw createError({ statusCode: 422, statusMessage: 'Unknown region' })

  let orgUnitId = opts.orgUnitId
  if (orgUnitId) {
    const ouRows = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM org_unit WHERE id = ${orgUnitId}::uuid AND region_id = ${opts.regionId}::uuid LIMIT 1
    `)
    if ([...ouRows].length === 0) throw createError({ statusCode: 422, statusMessage: 'org_unit not in target region' })
  } else {
    orgUnitId = await unplacedOrgUnitIdForRegion(tx, opts.regionId)
  }

  await tx.execute(sql`
    UPDATE teammate
    SET region_id = ${opts.regionId}::uuid, org_unit_id = ${orgUnitId}::uuid, revoked_at = NOW(),
        metadata = (coalesce(metadata, '{}'::jsonb) ${stripProvenanceKeys()})
    WHERE id = ${target.id}::uuid
  `)
  // Live devices follow; ended devices and attributed history keep the placement
  // they were emitted under. Lock order: teammate, devices, oauth_token.
  const rehomedInstanceIds = await followPlacement(tx as never, target.id)
  await revokeInteractiveCredentialsOf(tx as never, target.id)

  await recordAuditEvent(tx, {
    eventType: REGION_AUDIT_EVENT,
    actorTeammateId: opts.caller.teammateId,
    actorSystem: 'admin-ui',
    subjectKind: 'teammate',
    subjectId: target.id,
    payload: {
      previousRegionId: target.region_id,
      newRegionId: opts.regionId,
      newOrgUnitId: orgUnitId,
      targetEmail: target.email,
      sessionsRevoked: true,
      rehomedInstanceIds,
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      ...opts.auditContext,
    },
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  })
  return { previousRegionId: target.region_id, newRegionId: opts.regionId, orgUnitId, rehomedInstanceIds }
}
