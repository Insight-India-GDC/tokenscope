/*
 * POST /api/v1/admin/org-units/:id/move — REPARENT an org unit (and its whole subtree) to a new
 * parent WITHIN THE SAME REGION. The structural move the PATCH endpoint deferred.
 *
 * Body: { new_parent_id: uuid }. null is refused: a region's only parentless units are its
 * `default` unit and its holding node, so a stray top-level unit is moved under `default` like any
 * other (docs/design/org-setup/01-second-run-fixes.md, item 1).
 *
 * It rewrites the moved subtree's LTREE paths in ONE statement —
 *   new path = <new-parent-path> || subpath(path, nlevel(old-root-path) - 1)
 * for every row with `path <@ old-root-path` — and repoints the moved root's parent_id. Within a
 * region this is collision-free: `code` is unique per region, so the moved unit's code can't clash
 * with a sibling under the new parent. Guards:
 *   - the unit + new parent must exist, be ACTIVE (retired_at IS NULL), and share the region;
 *   - cross-region moves are 400 (a separate, heavier operation — re-homes region/spend dims);
 *   - no cycle: the new parent must not be the unit itself or any of its descendants;
 *   - the region's `default` unit and its holding node never move, and nothing moves at or under
 *     the holding node.
 *
 * Admin / platform-admin; a region admin is bound to the unit's region (requireRegionScope).
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { isAtOrUnderHoldingNode, isHoldingUnit, isRegionDefaultUnit, lockRegionUnitPaths } from '../../../../../db/org-unit-create'

const Body = z.object({
  new_parent_id: z.string().uuid().nullable(),
})

function invalidMove(detail: string) {
  return createError({ statusCode: 400, statusMessage: 'Invalid move', data: { type: 'https://tokenscope.example.com/errors/validation', title: 'Invalid move', status: 400, detail } })
}

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
    // 1. The unit being moved — must exist + be active. Capture region + path + parent.
    const [unit] = [...await tx.execute<{ id: string; region_id: string; path: string; code: string; parent_id: string | null; unit_type: string }>(sql`
      SELECT ou.id::text AS id, ou.region_id::text AS region_id,
             ou.path::text AS path, ou.code, ou.parent_id::text AS parent_id, ou.unit_type
      FROM org_unit ou
      WHERE ou.id = ${unitId}::uuid AND ou.retired_at IS NULL LIMIT 1`)]
    if (!unit) throw createError({ statusCode: 404, statusMessage: 'Org unit not found (or retired)' })

    // Region admin is bound to the unit's region.
    await requireRegionScope(event, unit.region_id)

    // A concurrent move or code change above this unit may have re-pathed it before we locked.
    await lockRegionUnitPaths(tx, unit.region_id)
    const [fresh] = [...await tx.execute<{ path: string; parent_id: string | null }>(sql`
      SELECT path::text AS path, parent_id::text AS parent_id FROM org_unit WHERE id = ${unit.id}::uuid`)]
    unit.path = fresh!.path
    unit.parent_id = fresh!.parent_id

    if (isRegionDefaultUnit(unit)) throw invalidMove("the region's default unit cannot be moved")
    if (isHoldingUnit(unit)) throw invalidMove('the Unplaced holding node cannot be moved')
    if (body.new_parent_id === null) {
      throw invalidMove("a unit cannot be moved to the top level of its region; move it under the region's default unit instead")
    }

    // 2. Resolve the destination.
    const [parent] = [...await tx.execute<{ id: string; region_id: string; path: string }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, path::text AS path
      FROM org_unit WHERE id = ${body.new_parent_id}::uuid AND retired_at IS NULL LIMIT 1`)]
    if (!parent) throw createError({ statusCode: 404, statusMessage: 'New parent not found (or retired)' })
    if (parent.region_id !== unit.region_id) {
      throw invalidMove('cross-region moves are not supported — the new parent must be in the same region as the unit')
    }
    // Cycle guard: the new parent must not be the unit itself or any of its descendants.
    const [cyc] = [...await tx.execute<{ bad: boolean }>(sql`SELECT (${parent.path}::ltree <@ ${unit.path}::ltree) AS bad`)]
    if (cyc?.bad) throw invalidMove('cannot move a unit under itself or one of its own descendants')
    if (await isAtOrUnderHoldingNode(tx, unit.region_id, parent.path)) {
      throw invalidMove('nothing can be moved under the Unplaced holding node')
    }
    const newParentId = parent.id
    const newParentPath = parent.path

    // No-op: already under that parent.
    if (newParentId === unit.parent_id) {
      return { id: unit.id, code: unit.code, path: unit.path, parent_id: unit.parent_id, moved: false }
    }

    // Collision guard: `path` has NO unique constraint (only (region_id, code)), and two distinct
    // codes can FOLD to the same ltree label ('prac-1' and 'prac_1' → 'prac_1'). If ANY unit already
    // sits at the moved unit's destination path, the move would create a DUPLICATE path and corrupt
    // every subtree (<@) query. We do NOT filter retired_at: retire is soft (the row keeps its path)
    // and the authz subtree query (org-subtree.ts) is also retire-blind, so a retired occupant would
    // leak just the same. The destination = newParentPath || the unit's own last label.
    const [collision] = [...await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM org_unit
      WHERE region_id = ${unit.region_id}::uuid AND id <> ${unit.id}::uuid
        AND path = (${newParentPath}::ltree || subpath(${unit.path}::ltree, nlevel(${unit.path}::ltree) - 1))
      LIMIT 1`)]
    if (collision) {
      throw createError({ statusCode: 409, statusMessage: 'Move conflict', data: { type: 'https://tokenscope.example.com/errors/conflict', title: 'Move conflict', status: 409, detail: `the new parent already has a unit at that position (code '${collision.code}') — two codes that normalise to the same path cannot coexist` } })
    }

    // 3. Re-path the moved subtree (root + all descendants) in one statement, repoint the root.
    await tx.execute(sql`
      UPDATE org_unit
      SET path = (${newParentPath}::ltree || subpath(path, nlevel(${unit.path}::ltree) - 1)),
          parent_id = CASE WHEN id = ${unit.id}::uuid THEN ${newParentId}::uuid ELSE parent_id END
      WHERE region_id = ${unit.region_id}::uuid AND path <@ ${unit.path}::ltree`)

    const [moved] = [...await tx.execute<{ path: string }>(sql`SELECT path::text AS path FROM org_unit WHERE id = ${unit.id}::uuid`)]

    await recordAuditEvent(tx, {
      eventType: 'org-unit-moved',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'org-unit',
      subjectId: unit.id,
      payload: {
        code: unit.code,
        region_id: unit.region_id,
        from: { parent_id: unit.parent_id, path: unit.path },
        to: { parent_id: newParentId, path: moved?.path ?? null },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: unit.id, code: unit.code, path: moved?.path ?? null, parent_id: newParentId, moved: true }
  })
})
