/*
 * PUT /api/v1/admin/governance-settings — upsert one governance dial
 * (mig 0049) at platform or region scope.
 *
 * Authority mirrors the project-lifecycle policy endpoints: the PLATFORM
 * baseline is platform-admin only; a REGION override is
 * requireRegionScope (region admin → own region; org-wide admins → any).
 * Keys are allowlisted and values bounds-checked app-side (the DB stores any
 * NUMERIC). Audited with before/after.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import {
  GOVERNANCE_PLATFORM_ONLY_KEYS,
  GOVERNANCE_SETTING_BOUNDS,
  GOVERNANCE_SWITCH_KEYS,
  isGovernanceSettingKey,
} from '../../../../utils/governance-settings'

const Body = z.object({
  key: z.string().min(1).max(120),
  scope_type: z.enum(['platform', 'region']),
  // Version-agnostic UUID shape (the require-uuid-param rationale): zod 4's
  // strict .uuid() would 400 well-formed ids the DB accepts, turning "region
  // not found" (404) into "bad request".
  region_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  value: z.number().finite(),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid governance setting',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid governance setting',
      status: 400,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Known-keys allowlist + per-key bounds (mig 0049 stores any NUMERIC —
  // sanity is app-side, like the lifecycle Body schema's min/max).
  if (!isGovernanceSettingKey(body.key)) {
    badRequest(`Unknown governance setting key '${body.key}'.`)
  }
  const bounds = GOVERNANCE_SETTING_BOUNDS[body.key]
  const aboveMin = bounds.minExclusive ? body.value > bounds.min : body.value >= bounds.min
  if (!aboveMin || body.value > bounds.max) {
    const lower = bounds.minExclusive ? `(${bounds.min}` : `[${bounds.min}`
    badRequest(`Value ${body.value} for '${body.key}' is outside ${lower}, ${bounds.max}].`)
  }
  if (GOVERNANCE_SWITCH_KEYS.includes(body.key) && body.value !== 0 && body.value !== 1) {
    badRequest(`'${body.key}' is a switch: the value must be 0 or 1.`)
  }
  if (GOVERNANCE_PLATFORM_ONLY_KEYS.includes(body.key) && body.scope_type !== 'platform') {
    badRequest(`'${body.key}' is platform-wide and cannot be overridden per region.`)
  }

  // Scope authority: the platform baseline is not a region admin's to set.
  let regionId: string | null = null
  if (body.scope_type === 'platform') {
    if (body.region_id !== undefined) {
      badRequest('region_id must be omitted for platform scope.')
    }
    if (!(isPlatformAdmin(caller.role))) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'The platform default requires an Admin.',
        },
      })
    }
  } else {
    if (!body.region_id) {
      badRequest('region_id is required for region scope.')
    }
    regionId = body.region_id
    await requireRegionScope(event, regionId)
  }

  return await withRequestRls(event, async (tx) => {
    if (regionId) {
      // Existence check (API-9 posture): without it a PUT against any UUID
      // hits the scope_id FK → 23503 → raw 500 instead of this 404.
      const regionRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM region WHERE id = ${regionId}::uuid LIMIT 1
      `)
      if (![...regionRows][0]) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Region not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Region not found',
            status: 404,
            detail: 'No region matches the supplied id.',
          },
        })
      }
    }

    // Before-image for the audit trail (null = the scope had no row yet).
    const beforeRows = await tx.execute<{ value_numeric: string }>(sql`
      SELECT value_numeric::text AS value_numeric
        FROM governance_setting
       WHERE key = ${body.key}
         AND ${regionId ? sql`scope_type = 'region' AND scope_id = ${regionId}::uuid` : sql`scope_type = 'platform'`}
       LIMIT 1
    `)
    const before = [...beforeRows][0] ? Number([...beforeRows][0]!.value_numeric) : null

    try {
      if (regionId) {
        await tx.execute(sql`
          INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric, updated_by)
          VALUES (${body.key}, 'region', ${regionId}::uuid, ${body.value}, ${caller.teammateId}::uuid)
          ON CONFLICT (key, scope_id) WHERE scope_type = 'region'
          DO UPDATE SET value_numeric = EXCLUDED.value_numeric,
                        updated_by    = EXCLUDED.updated_by,
                        updated_at    = now()
        `)
      } else {
        await tx.execute(sql`
          INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric, updated_by)
          VALUES (${body.key}, 'platform', NULL, ${body.value}, ${caller.teammateId}::uuid)
          ON CONFLICT (key) WHERE scope_type = 'platform'
          DO UPDATE SET value_numeric = EXCLUDED.value_numeric,
                        updated_by    = EXCLUDED.updated_by,
                        updated_at    = now()
        `)
      }
    } catch (err: unknown) {
      // Region hard-deleted between the check and the upsert (TOCTOU).
      translatePgConstraintError(err, {
        '23503': {
          status: 404,
          title: 'Region not found',
          detail: 'The region was deleted while saving the governance setting.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'governance-setting-changed',
      actorTeammateId: caller.teammateId,
      subjectKind: regionId ? 'region' : 'platform',
      subjectId: regionId,
      payload: {
        key: body.key,
        scope: body.scope_type,
        region_id: regionId,
        before,
        after: body.value,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      key: body.key,
      scope: body.scope_type,
      region_id: regionId,
      value: body.value,
    }
  })
})
