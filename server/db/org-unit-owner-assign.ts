/*
 * Assign a Business Unit owner (J4, mig 0048): the validation, locks, one-BU rule
 * and audit event of POST /admin/org-units/{id}/owners, shared with
 * POST /admin/org-setup/units.
 *
 * The unit must be a cost-owning unit. The owner is either an existing teammate
 * (adopted/merged to a real identity) or a directory pick, found or provisioned
 * into the unit's region (role 'developer'; the P&L grant is independent of org
 * role). Provisioning a new person is platform-admin only.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../../drizzle/schema'
import type { Role } from '../../shared/auth/roles'
import type { DirectoryUser } from '../azure/directory'
import { advisoryXactLock } from './advisory-lock'
import { recordAuditEvent } from './audit'
import { translatePgConstraintError } from '../utils/pg-constraint-error'
import { ensureRealIdentity } from '../auth/ensure-real-identity'
import { assertDirectoryIdentityPickable, provisionDirectoryTeammate } from '../auth/provision-directory-teammate'
import { loadDirectoryExclusionPatterns } from '../utils/directory-exclusions'

type Tx = PostgresJsDatabase<typeof schema>

export const ALREADY_OWNS_A_BU_TYPE = 'https://tokenscope.example.com/errors/already-owns-a-bu'

export interface UnitOwnerAssignInput {
  orgUnitId: string
  /** A teammate id, or a directory user the caller re-resolved server-side. */
  owner: { teammateId: string } | { dir: DirectoryUser }
}

export interface UnitOwnerAssignContext {
  caller: { teammateId: string; role: Role }
  /** Throws when the caller may not act in this region. */
  assertRegionScope: (regionId: string) => Promise<void>
  ipAddress: string | null
  userAgent: string | null
}

export interface UnitOwnerAssigned {
  id: string
  teammateId: string
  email: string
  displayName: string | null
  identityAdopted: boolean
  provisioned: boolean
}

export async function assignUnitOwner(
  tx: Tx,
  input: UnitOwnerAssignInput,
  ctx: UnitOwnerAssignContext,
): Promise<UnitOwnerAssigned> {
  const id = input.orgUnitId
  const dir = 'dir' in input.owner ? input.owner.dir : null
  // Before any write, so the refusal costs nothing.
  if (dir) assertDirectoryIdentityPickable(dir, await loadDirectoryExclusionPatterns(tx))
  const ouRows = await tx.execute<{ region_id: string; is_cost_owning_unit: boolean; display_name: string }>(sql`
    SELECT region_id::text AS region_id, is_cost_owning_unit, display_name
    FROM org_unit
    WHERE id = ${id}::uuid AND retired_at IS NULL
    LIMIT 1
  `)
  const ou = [...ouRows][0]
  if (!ou) throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })
  await ctx.assertRegionScope(ou.region_id)
  if (!ou.is_cost_owning_unit) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Not a Business Unit',
      data: {
        type: 'https://tokenscope.example.com/errors/not-cost-owning',
        title: 'Not a Business Unit',
        status: 422,
        detail: 'Owners can only be assigned to Business Units. Mark the unit as a Business Unit first.',
      },
    })
  }

  // R1 F5: a REGION admin must not grant cross-region P&L visibility.
  const callerIsGlobal = ctx.caller.role === 'platform-admin'
  const crossRegionOwner = () =>
    createError({
      statusCode: 422,
      statusMessage: 'Cross-region owner',
      data: {
        type: 'https://tokenscope.example.com/errors/cross-region-owner',
        title: 'Cross-region owner',
        status: 422,
        detail:
          'This teammate belongs to another region. Only an Admin may assign cross-region Business Unit owners.',
      },
    })

  let ownerTeammateId: string
  let ownerRegionId: string
  let ownerEmail: string
  let ownerDisplayName: string | null
  let adopted: boolean
  let provisioned = false

  if (dir) {
    // May resolve to an EXISTING teammate (other live identity of the same
    // mailbox, or an adopted bill: placeholder — issue #121), so the result is
    // not necessarily homed in ou.region_id.
    const tm = await provisionDirectoryTeammate(tx, dir, ctx.caller.teammateId, {
      regionId: ou.region_id,
      fallbackOrgUnitId: id,
      via: 'cou-owner-assign',
    })
    // An owner is an estate-wide manager-walk target: a new person is a
    // platform-admin pick, like region leaders. The throw rolls back the provisioning.
    if (tm.provisioned && !callerIsGlobal) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Owner is not a teammate yet',
        data: {
          type: 'https://tokenscope.example.com/errors/owner-not-teammate',
          title: 'Owner is not a teammate yet',
          status: 403,
          detail:
            'This person is not a TokenScope teammate yet. Only an Admin can make someone new a unit owner: an owner\'s unplaced reports in every region are placed into the unit.',
        },
      })
    }
    ownerTeammateId = tm.teammateId
    ownerRegionId = tm.regionId
    ownerEmail = tm.email
    ownerDisplayName = tm.displayName
    provisioned = tm.provisioned
    adopted = tm.adopted
  } else {
    const teammateId = (input.owner as { teammateId: string }).teammateId
    // Before ensureRealIdentity, which calls Graph and answers with that teammate's email.
    if (!callerIsGlobal) {
      const [pre] = await tx.execute<{ region_id: string }>(sql`
        SELECT region_id::text AS region_id FROM teammate WHERE id = ${teammateId}::uuid
      `)
      if (pre && pre.region_id !== ou.region_id) throw crossRegionOwner()
    }
    // The owner oid is the manager-chain match key, so a placeholder identity
    // would be invisible to the placement walk.
    const owner = await ensureRealIdentity(tx, teammateId, ctx.caller.teammateId, 'cou-owner-assign')
    ownerTeammateId = owner.teammateId
    ownerRegionId = owner.regionId
    ownerEmail = owner.email
    ownerDisplayName = owner.displayName
    adopted = owner.adopted
  }

  // Either body shape can resolve to an EXISTING cross-region teammate (#121).
  if (!callerIsGlobal && ownerRegionId !== ou.region_id) throw crossRegionOwner()

  /*
   * ONE OWNER, ONE BUSINESS UNIT (owner ruling, 2026-08-10). The placement walk
   * skips an owner of more than one unit as ambiguous. Enforced here, not by an
   * index, because Dev already holds violations. Serialised on the teammate: the
   * count and the insert are two statements.
   */
  await tx.execute(advisoryXactLock('principal', ownerTeammateId))

  // Counted across regions via the SECURITY DEFINER aggregate (mig 0111); a
  // direct cou_owner read is filtered by RLS for a region admin.
  const [ownedElsewhere] = [
    ...(await tx.execute<{ n: string }>(sql`
      SELECT COALESCE(c.unit_count, 0)::text AS n
        FROM teammate t
        LEFT JOIN owner_active_unit_counts() c ON c.owner_oid = t.entra_oid
       WHERE t.id = ${ownerTeammateId}::uuid`)),
  ]
  // A re-grant of this same unit is the unique index's own 409 below.
  const [alreadyHere] = [
    ...(await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM cou_owner
       WHERE teammate_id = ${ownerTeammateId}::uuid
         AND org_unit_id = ${id}::uuid AND revoked_at IS NULL`)),
  ]
  if (Number(ownedElsewhere?.n ?? 0) - Number(alreadyHere?.n ?? 0) > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Already owns a Business Unit',
      data: {
        type: ALREADY_OWNS_A_BU_TYPE,
        title: 'Already owns a Business Unit',
        status: 409,
        // Not named: it can be in a region this caller may not see.
        detail:
          'This teammate already owns a Business Unit. A person may own at most one — revoke the existing ownership first. If you cannot see it, it is in another region; ask a global administrator.',
      },
    })
  }

  let created: { id: string } | undefined
  try {
    ;[created] = await tx
      .insert(schema.couOwner)
      .values({ orgUnitId: id, teammateId: ownerTeammateId, assignedBy: ctx.caller.teammateId })
      .returning({ id: schema.couOwner.id })
  } catch (err: unknown) {
    translatePgConstraintError(err, {
      '23505': {
        title: 'Already an owner',
        detail: 'This teammate already actively owns this Business Unit.',
      },
    })
  }

  await recordAuditEvent(tx, {
    eventType: 'cou-owner-assigned',
    actorTeammateId: ctx.caller.teammateId,
    subjectKind: 'org_unit',
    subjectId: id,
    payload: {
      teammate_id: ownerTeammateId,
      email: ownerEmail,
      org_unit_name: ou.display_name,
      identity_adopted: adopted,
      provisioned_from_directory: provisioned,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })

  return {
    id: created!.id,
    teammateId: ownerTeammateId,
    email: ownerEmail,
    displayName: ownerDisplayName,
    identityAdopted: adopted,
    provisioned,
  }
}
