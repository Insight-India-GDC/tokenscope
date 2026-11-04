/*
 * POST /api/v1/admin/rate-cards/{id}/retire — set retired_at on a card
 * (PRD COST-5, safe half).
 *
 * Retire is the ONLY removal primitive: there is deliberately no DELETE and
 * no line mutation. Costed attribution records pin (rate_card_id,
 * rate_card_version) — COST-7 — so a card that ever priced spend must stay
 * readable forever; retiring merely takes it out of resolveRateCard's
 * candidate set for FUTURE events.
 *
 * Authority mirrors the create path: a region admin retires their own
 * region's cards; a GLOBAL card (region_id null) is platform-admin /
 * platform-admin only. Already-retired → 409 (the operation is one-shot;
 * the 409 tells a concurrent admin somebody beat them to it).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { isPlatformAdmin } from '../../../../../../shared/auth/roles'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

interface CardRow extends Record<string, unknown> {
  id: string
  scope_key: string
  region_id: string | null
  cou_id: string | null
  effective: string
  version: number
  retired_at: string | null
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'rate-card id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<CardRow>(sql`
      SELECT id::text AS id,
             scope_key,
             region_id::text AS region_id,
             cou_id::text AS cou_id,
             effective::text AS effective,
             version,
             retired_at::text AS retired_at
        FROM rate_card
       WHERE id = ${id}::uuid
       LIMIT 1
    `)
    const card = [...rows][0]
    if (!card) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Rate card not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Rate card not found',
          status: 404,
          detail: 'No rate card matches the supplied id.',
        },
      })
    }

    // Scope authority — same split as create: own region for region admins,
    // global cards only for the org-wide roles.
    if (card.region_id === null) {
      if (!(isPlatformAdmin(caller.role))) {
        throw createError({
          statusCode: 403,
          statusMessage: 'Forbidden',
          data: {
            type: 'https://tokenscope.example.com/errors/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: 'A global rate card can only be retired by an Admin.',
          },
        })
      }
    } else {
      await requireRegionScope(event, card.region_id)
    }

    if (card.retired_at !== null) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Rate card already retired',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Rate card already retired',
          status: 409,
          detail: `This card was retired at ${card.retired_at}.`,
        },
      })
    }

    // retired_at IS NULL guard: a concurrent retire between the read above
    // and this UPDATE loses cleanly (zero rows → 409) instead of silently
    // re-stamping a later timestamp.
    const updated = await tx.execute<{ retired_at: string }>(sql`
      UPDATE rate_card SET retired_at = now()
       WHERE id = ${id}::uuid AND retired_at IS NULL
       RETURNING retired_at::text AS retired_at
    `)
    const retiredAt = [...updated][0]?.retired_at
    if (!retiredAt) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Rate card already retired',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Rate card already retired',
          status: 409,
          detail: 'The card was retired concurrently.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'rate-card-retired',
      actorTeammateId: caller.teammateId,
      subjectKind: 'rate-card',
      subjectId: id,
      payload: {
        scope_key: card.scope_key,
        region_id: card.region_id,
        cou_id: card.cou_id,
        effective: card.effective,
        version: card.version,
        retired_at: retiredAt,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, retired_at: retiredAt }
  })
})
