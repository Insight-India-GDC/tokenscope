/*
 * POST /api/v1/admin/regions/{id}/leaders — assign a region leader
 * (region derivation, mig 0068). platform-admin only.
 *
 * The leader is the manager-walk fallback target for unplaced users: an
 * unplaced user's manager chain is walked up to the nearest ancestor that
 * is a leader, and that leader's region homes the user. We key on the
 * leader's Entra oid (stable + unspoofable; the /manager hop returns the
 * manager's id) — leader_oid/leader_email come from the directory
 * people-picker (GET /admin/directory/search). The partial-unique index on
 * leader_oid WHERE revoked_at IS NULL means one ACTIVE leader maps to one
 * region; a duplicate active oid 409s.
 *
 * platform-admin only, like the other region-derivation inputs
 * (directory-region-rules): the manager walk is estate-wide,
 * so a leader named for one region homes people from every region's chain.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'
import { regionLeader } from '../../../../../../drizzle/schema'

const Body = z.object({
  leader_oid: z.string().trim().min(1).max(200),
  leader_email: z.string().trim().min(1).max(320),
  kind: z.enum(['region-svp', 'shared-function-global']),
  display_name: z.string().trim().max(200).optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'region id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const regionRows = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${id}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) {
      throw createError({ statusCode: 404, statusMessage: 'Region not found' })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(regionLeader)
        .values({
          regionId: id,
          leaderOid: body.leader_oid,
          leaderEmail: body.leader_email.toLowerCase(),
          kind: body.kind,
          displayName: body.display_name ?? null,
          addedBy: caller.teammateId,
        })
        .returning({ id: regionLeader.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        // Partial-unique on leader_oid WHERE revoked_at IS NULL.
        '23505': {
          title: 'Leader already maps to a region',
          detail:
            'This person is already an active leader for a region. Revoke the existing mapping first, then re-assign.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'region-leader-assigned',
      actorTeammateId: caller.teammateId,
      subjectKind: 'region',
      subjectId: id,
      payload: {
        leader_id: created!.id,
        leader_oid: body.leader_oid,
        leader_email: body.leader_email.toLowerCase(),
        kind: body.kind,
        region_code: regionRow.code,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      leader_oid: body.leader_oid,
      leader_email: body.leader_email.toLowerCase(),
      kind: body.kind,
      display_name: body.display_name ?? null,
    }
  })
})
