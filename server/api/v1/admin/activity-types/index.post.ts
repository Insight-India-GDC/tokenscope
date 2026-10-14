/*
 * POST /api/v1/admin/activity-types — add an activity-tag vocabulary entry
 * (docs/design/activity-tagging-attribution.md; ADR-0004 Amendment 1).
 *
 * Body: { region_id: uuid | null, label: string(1..64), sort_order? }.
 *   - region_id = a uuid  → a REGION addition. A region `admin` may only create
 *     in their OWN region (requireRegionScope); is_standard defaults FALSE (a
 *     region addition is non-standard, distinct from the seeded global set).
 *   - region_id = null    → a GLOBAL/standard entry. Region admins may NOT touch
 *     the global vocabulary — only platform-admin (the
 *     org-wide roles). is_standard defaults TRUE.
 *
 * Duplicate label in the same scope is guarded by the partial unique indexes
 * from migration 0020 (lower(label), per-scope). We catch Postgres 23505 and
 * surface a clean 409 rather than leaking a 500.
 *
 * NOTE: activity_type has no RLS policy (mig 0020); scope is enforced here at
 * the app layer (requireRole + requireRegionScope / the global gate below).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { requireActivityScope } from '../../../../auth/activity-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { pgErrorCode } from '../../../../db/pg-error'
import { displayText, ACTIVITY_LABEL_MAX } from '#shared/schemas/display-text'
import { activityType } from '../../../../../drizzle/schema'

const Body = z.object({
  // null = a global/standard entry (org-wide roles only).
  region_id: z.string().uuid().nullable(),
  label: displayText(ACTIVITY_LABEL_MAX, { trim: true }),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)

  // Authz: a region addition is bounded to the caller's region; a global entry
  // is org-wide-roles-only. requireActivityScope is the single split point.
  await requireActivityScope(event, caller, body.region_id)

  const isGlobal = body.region_id === null
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    let created: { id: string; label: string }
    try {
      const [row] = await tx
        .insert(activityType)
        .values({
          regionId: body.region_id,
          label: body.label,
          // A region addition is non-standard; the global set is standard.
          isStandard: isGlobal,
          ...(body.sort_order !== undefined ? { sortOrder: body.sort_order } : {}),
        })
        .returning({ id: activityType.id, label: activityType.label })
      created = row!
    } catch (err: unknown) {
      // Partial unique index (lower(label) per scope) → clean 409, not a 500.
      if (pgErrorCode(err) === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Activity tag already exists',
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Activity tag already exists',
            status: 409,
            detail: `An activity tag '${body.label}' already exists in this ${isGlobal ? 'global' : 'region'} scope (case-insensitive).`,
          },
        })
      }
      throw err
    }

    await recordAuditEvent(tx, {
      eventType: 'activity-type-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'activity-type',
      subjectId: created.id,
      payload: {
        region_id: body.region_id,
        label: body.label,
        is_standard: isGlobal,
        scope: isGlobal ? 'global' : 'region',
        ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created.id,
      region_id: body.region_id,
      label: created.label,
      is_standard: isGlobal,
      scope: isGlobal ? 'global' : ('region' as 'global' | 'region'),
    }
  })
})
