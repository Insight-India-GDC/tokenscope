/*
 * PATCH /api/v1/admin/activity-types/:id — rename / reorder / (de|re)activate an
 * activity-tag vocabulary entry (docs/design/activity-tagging-attribution.md).
 *
 * Body (at least one): { label?, sort_order?, is_active? }.
 *   - label       → rename (re-checked against the per-scope unique index → 409)
 *   - sort_order  → reorder in the picker
 *   - is_active   → soft delete (false) / restore (true). getActivityTypes
 *     filters is_active = TRUE, so deactivating hides the tag from the picker.
 *
 * Authz is re-checked from the ROW's region_id (locked FOR UPDATE, mirroring
 * projects/[id].patch.ts): a region admin can edit only their own region's
 * additions; the global (region_id NULL) standard set is org-wide-roles-only.
 *
 * NOTE: activity_type has no RLS policy (mig 0020); scope is enforced here at
 * the app layer via requireRole + requireActivityScope.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { requireActivityScope } from '../../../../auth/activity-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { pgErrorCode } from '../../../../db/pg-error'
import { displayText, ACTIVITY_LABEL_MAX } from '#shared/schemas/display-text'

const Body = z
  .object({
    label: displayText(ACTIVITY_LABEL_MAX, { trim: true }).optional(),
    sort_order: z.coerce.number().int().min(0).max(100000).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid activity tag id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid activity tag id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const id = parsedId.data
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Lock the row (mirrors projects/[id].patch.ts) so a concurrent edit can't
    // race the scope check, then enforce the global-vs-region authz on the row's
    // OWN region_id.
    const existing = await tx.execute<{ region_id: string | null; label: string }>(sql`
      SELECT region_id::text AS region_id, label
        FROM activity_type WHERE id = ${id}::uuid FOR UPDATE
    `)
    const row = [...existing][0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Activity tag not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Activity tag not found',
          status: 404,
          detail: 'No activity tag matches the supplied id.',
        },
      })
    }

    await requireActivityScope(event, caller, row.region_id)

    // Build the UPDATE from the provided fields only.
    const sets: SQL[] = []
    const changed: Record<string, unknown> = {}
    if (body.label !== undefined) {
      sets.push(sql`label = ${body.label}`)
      changed.label = body.label
    }
    if (body.sort_order !== undefined) {
      sets.push(sql`sort_order = ${body.sort_order}`)
      changed.sort_order = body.sort_order
    }
    if (body.is_active !== undefined) {
      sets.push(sql`is_active = ${body.is_active}`)
      changed.is_active = body.is_active
    }

    let updatedRow: {
      id: string
      region_id: string | null
      label: string
      is_standard: boolean
      sort_order: number
      is_active: boolean
    }
    try {
      const updated = await tx.execute<{
        id: string
        region_id: string | null
        label: string
        is_standard: boolean
        sort_order: number
        is_active: boolean
      }>(sql`
        UPDATE activity_type
           SET ${sql.join(sets, sql`, `)}
         WHERE id = ${id}::uuid
        RETURNING id::text AS id, region_id::text AS region_id, label,
                  is_standard, sort_order, is_active
      `)
      updatedRow = [...updated][0]!
    } catch (err: unknown) {
      // Rename collided with the per-scope unique index → clean 409.
      if (pgErrorCode(err) === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Activity tag already exists',
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Activity tag already exists',
            status: 409,
            detail: `An activity tag '${body.label ?? row.label}' already exists in this ${row.region_id === null ? 'global' : 'region'} scope (case-insensitive).`,
          },
        })
      }
      throw err
    }

    await recordAuditEvent(tx, {
      eventType: 'activity-type-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'activity-type',
      subjectId: id,
      payload: {
        region_id: row.region_id,
        scope: row.region_id === null ? 'global' : 'region',
        changed,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: updatedRow.id,
      region_id: updatedRow.region_id,
      label: updatedRow.label,
      is_standard: updatedRow.is_standard,
      sort_order: Number(updatedRow.sort_order),
      is_active: updatedRow.is_active,
      scope: updatedRow.region_id === null ? 'global' : ('region' as 'global' | 'region'),
    }
  })
})
