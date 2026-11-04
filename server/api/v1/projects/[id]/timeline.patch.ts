/*
 * PATCH /api/v1/projects/{id}/timeline — change a project's end date
 * (docs/design/project-requests/00-spec.md §4, amendments A1, A8).
 *
 * Gate: a current PM of this project, or an admin in scope (platform-admin, or
 * the region admin of the project's region). An org-role manager who is not the
 * project's PM is refused. Only `end_date` is writable here; the rest of the
 * project stays with the admin PATCH.
 *
 * Same value, same write as the admin PATCH (ProjectEndDateSchema,
 * endDateAssignment), audited as `project-updated` with before and after.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { assertProjectManagerOrAdmin, loadProjectTarget } from '../../../../auth/project-authority'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { readValidated } from '../../../../utils/validated-body'
import { endDateAssignment } from '../../../../projects/end-date'
import { lockProjectRowAt } from '../../../../projects/last-manager'
import { requestClock } from '../../../../utils/request-clock'
import { ProjectTimelineBody } from '../../../../../shared/schemas/project-budget'

export default defineEventHandler(async (event) => {
  const caller = await requireAuth(event)
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const body = await readValidated(event, ProjectTimelineBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const proj = await loadProjectTarget(tx, id)
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    // Lock before the gate, and judge the caller's PM standing at the post-lock
    // instant: a removal through the remove route that this request waited on is seen.
    const lockedAt = await lockProjectRowAt(tx, id, requestClock(event).now)
    const via = await assertProjectManagerOrAdmin(event, tx, proj, lockedAt)

    const [before] = await tx.execute<{ end_date: string | null }>(sql`
      SELECT end_date::text AS end_date FROM project WHERE id = ${id}::uuid
    `)
    const [updated] = await tx.execute<{ id: string; code: string; end_date: string | null }>(sql`
      UPDATE project SET ${endDateAssignment(body.end_date)}
      WHERE id = ${id}::uuid
      RETURNING id::text AS id, code, end_date::text AS end_date
    `)

    await recordAuditEvent(tx, {
      eventType: 'project-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: id,
      payload: {
        region_id: proj.regionId,
        changed: { end_date: body.end_date },
        before: { end_date: before?.end_date ?? null },
        context: { via, surface: 'project-timeline' },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: updated!.id, code: updated!.code, end_date: updated!.end_date }
  })
})
