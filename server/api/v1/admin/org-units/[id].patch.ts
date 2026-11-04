/*
 * PATCH /api/v1/admin/org-units/:id — edit an org unit's descriptive
 * fields (admin org-units tab, design-notes §Screen 5).
 *
 * Fields: display_name, unit_type, is_cost_owning_unit and code. It never
 * changes parent_id; RE-PARENTING lives in POST .../org-units/:id/move.
 *
 * A code change rewrites the unit's last path label and its whole subtree's
 * paths in one statement, as Move does. Projects, owners and directory unit
 * rules point at the unit's id, so they follow it. The region's `default` unit
 * and its holding node keep their codes, and no unit takes either reserved
 * code. The new path must not be held by any other unit in the region, active
 * or retired: paths have no unique constraint and subtree queries ignore
 * retirement (docs/design/org-setup/01-second-run-fixes.md, item 3).
 *
 * Admin / platform-admin only; a region admin is bound to the unit's own
 * region (we load the unit first, then requireRegionScope to it).
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { assertHoldingNodeNotCostOwning, assertHoldingNodeTypeImmutable } from '../../../../db/org-units'
import {
  ORG_UNIT_CODE_MAX,
  ORG_UNIT_CODE_MIN,
  ORG_UNIT_CODE_PATTERN,
  RESERVED_ORG_UNIT_CODE,
  deriveLabel,
  isHoldingUnit,
  isRegionDefaultUnit,
  lockRegionUnitPaths,
  orgUnitProblem as problem,
} from '../../../../db/org-unit-create'

const Body = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    unit_type: z.string().min(1).max(40).optional(),
    is_cost_owning_unit: z.boolean().optional(),
    code: z.string().min(ORG_UNIT_CODE_MIN).max(ORG_UNIT_CODE_MAX).regex(ORG_UNIT_CODE_PATTERN, 'invalid org unit code').optional(),
  })
  .refine(
    (b) => b.display_name !== undefined || b.unit_type !== undefined || b.is_cost_owning_unit !== undefined || b.code !== undefined,
    { message: 'At least one field must be provided' },
  )

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const idParse = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParse.success) throw createError({ statusCode: 400, statusMessage: 'Invalid org unit id' })
  const unitId = idParse.data
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existingRows = await tx.execute<{
      id: string
      region_id: string
      parent_id: string | null
      path: string
      code: string
      display_name: string
      unit_type: string
      is_cost_owning_unit: boolean
    }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, parent_id::text AS parent_id, path::text AS path,
             code, display_name, unit_type, is_cost_owning_unit
      FROM org_unit WHERE id = ${unitId}::uuid LIMIT 1
    `)
    const existing = [...existingRows][0]
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })

    // Region admin is bound to the unit's region.
    await requireRegionScope(event, existing.region_id)

    /*
     * Guard rail, in TWO parts, because the effective-value check alone has a
     * bypass that defeats it:
     *
     *   1. an existing holding node's TYPE cannot be changed at all. Without
     *      this, `{ unit_type: 'team', is_cost_owning_unit: true }` produces an
     *      effective row that is no longer a holding node, so (2) passes and the
     *      node becomes a cost centre with all 290 people still on it — the exact
     *      outcome (2) exists to prevent, reached by relabelling. The two-step
     *      (retype, then enable) needs the same first step, so this refusal kills
     *      that path too.
     *   2. a holding node may never become cost-owning — evaluated against the
     *      EFFECTIVE values this PATCH would produce, not the submitted ones: a
     *      body that only sets is_cost_owning_unit leaves unit_type at its
     *      existing value, and checking the body alone would wave it through.
     */
    assertHoldingNodeTypeImmutable({
      existingUnitType: existing.unit_type,
      requestedUnitType: body.unit_type,
    })
    assertHoldingNodeNotCostOwning({
      unitType: body.unit_type ?? existing.unit_type,
      isCostOwningUnit: body.is_cost_owning_unit ?? existing.is_cost_owning_unit,
    })

    const recode = body.code !== undefined && body.code !== existing.code ? body.code : null
    let newPath: string | null = null
    if (recode !== null) {
      await lockRegionUnitPaths(tx, existing.region_id)
      // A concurrent move or code change above this unit may have re-pathed it before we locked.
      const [fresh] = [...await tx.execute<{ path: string }>(sql`
        SELECT path::text AS path FROM org_unit WHERE id = ${existing.id}::uuid`)]
      existing.path = fresh!.path
      if (isRegionDefaultUnit(existing) || isHoldingUnit(existing)) {
        throw problem(422, 'this unit\'s code cannot be changed', 'The region\'s default unit and its Unplaced holding node keep their codes.')
      }
      if (recode === RESERVED_ORG_UNIT_CODE) {
        throw problem(409, `Org unit code '${recode}' is reserved`, `The code '${recode}' is reserved for a region's root org unit.`)
      }
      const [dupe] = [...await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM org_unit
        WHERE region_id = ${existing.region_id}::uuid AND code = ${recode} LIMIT 1`)]
      if (dupe) {
        throw problem(409, `Org unit code '${recode}' already exists in this region`, `An org unit with code '${recode}' already exists in this region.`)
      }
      const labels = existing.path.split('.')
      labels[labels.length - 1] = deriveLabel(recode)
      newPath = labels.join('.')
      // Any other unit at the new path, or beneath it, would share a subtree with this one.
      const [collision] = [...await tx.execute<{ code: string }>(sql`
        SELECT code FROM org_unit
        WHERE region_id = ${existing.region_id}::uuid AND path <@ ${newPath}::ltree
          AND NOT path <@ ${existing.path}::ltree
        LIMIT 1`)]
      if (collision) {
        throw problem(
          409,
          `Org unit path '${newPath}' already exists in this region`,
          `The code '${recode}' derives LTREE path '${newPath}', which unit '${collision.code}' already holds in this region (retired units count). Choose a code that yields a distinct label.`,
        )
      }
      await tx.execute(sql`
        UPDATE org_unit
        SET path = CASE WHEN id = ${existing.id}::uuid THEN ${newPath}::ltree
                        ELSE ${newPath}::ltree || subpath(path, nlevel(${existing.path}::ltree)) END
        WHERE region_id = ${existing.region_id}::uuid AND path <@ ${existing.path}::ltree`)
    }

    // Build the dynamic SET list from only the provided fields.
    const sets: SQL[] = []
    if (recode !== null) sets.push(sql`code = ${recode}`)
    if (body.display_name !== undefined) sets.push(sql`display_name = ${body.display_name}`)
    if (body.unit_type !== undefined) sets.push(sql`unit_type = ${body.unit_type}`)
    if (body.is_cost_owning_unit !== undefined) sets.push(sql`is_cost_owning_unit = ${body.is_cost_owning_unit}`)

    const updatedRows = await tx.execute<{
      id: string
      code: string
      display_name: string
      unit_type: string
      is_cost_owning_unit: boolean
    }>(sql`
      UPDATE org_unit
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${unitId}::uuid
      RETURNING id::text AS id, code, display_name, unit_type, is_cost_owning_unit
    `)
    const updated = [...updatedRows][0]
    if (!updated) throw createError({ statusCode: 500, statusMessage: 'org unit update returned no row' })

    await recordAuditEvent(tx, {
      eventType: 'org-unit-updated',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'org-unit',
      subjectId: updated.id,
      payload: {
        code: updated.code,
        region_id: existing.region_id,
        changes: {
          ...(body.display_name !== undefined
            ? { display_name: { from: existing.display_name, to: updated.display_name } }
            : {}),
          ...(body.unit_type !== undefined
            ? { unit_type: { from: existing.unit_type, to: updated.unit_type } }
            : {}),
          ...(body.is_cost_owning_unit !== undefined
            ? { is_cost_owning_unit: { from: existing.is_cost_owning_unit, to: updated.is_cost_owning_unit } }
            : {}),
          ...(recode !== null
            ? { code: { from: existing.code, to: updated.code }, path: { from: existing.path, to: newPath } }
            : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: updated.id,
      code: updated.code,
      display_name: updated.display_name,
      unit_type: updated.unit_type,
      is_cost_owning_unit: updated.is_cost_owning_unit,
    }
  })
})
