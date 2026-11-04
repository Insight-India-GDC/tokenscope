/*
 * POST /api/v1/admin/project-managers — add a teammate to the PMO list
 * (mig 0164). Platform-admin only (A3). The teammate must already exist, be
 * active and confirmed. A second live grant is a 409 (partial unique index).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { readValidated } from '../../../../utils/validated-body'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { displayText } from '#shared/schemas/display-text'

const Body = z.object({
  teammate_id: z.string().uuid(),
  note: displayText(500).optional(),
})

const ALREADY = {
  title: 'Already a Project Manager',
  detail: 'This teammate is already on the Project managers list.',
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const targetRows = await tx.execute<{ email: string; is_active: boolean; provisional: boolean }>(sql`
      SELECT email, is_active, provisional FROM teammate WHERE id = ${body.teammate_id}::uuid LIMIT 1
    `)
    const target = [...targetRows][0]
    if (!target) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Teammate not found',
          status: 404,
          detail: 'No teammate matches that id.',
        },
      })
    }
    if (!target.is_active || target.provisional) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Teammate not eligible',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Teammate not eligible',
          status: 422,
          detail: 'Only an active, confirmed teammate can be added to the Project managers list.',
        },
      })
    }

    let id: string | undefined
    try {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO project_manager_grant (teammate_id, granted_by, note)
        VALUES (${body.teammate_id}::uuid, ${caller.teammateId}::uuid, ${body.note ?? null})
        ON CONFLICT (teammate_id) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id::text AS id
      `)
      id = [...rows][0]?.id
    } catch (err: unknown) {
      translatePgConstraintError(err, { '23505': ALREADY })
    }
    if (!id) {
      throw createError({
        statusCode: 409,
        statusMessage: ALREADY.title,
        data: { type: 'https://tokenscope.example.com/errors/conflict', title: ALREADY.title, status: 409, detail: ALREADY.detail },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'project-manager-granted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: body.teammate_id,
      payload: { grant_id: id, email: target.email, note: body.note ?? null },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, teammate_id: body.teammate_id }
  })
})
