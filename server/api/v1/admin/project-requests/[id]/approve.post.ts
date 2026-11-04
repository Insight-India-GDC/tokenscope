/*
 * POST /api/v1/admin/project-requests/{id}/approve — an admin approves a
 * pending request, setting the final project code and optionally overriding any
 * proposed field (docs/design/project-requests/00-spec.md §3, A10, A11).
 *
 * The decision is a conditional update on status = 'pending', in the same
 * transaction as createProject: a second decision or a racing withdraw gets 409,
 * and a refused create (taken code, retired Business Unit) rolls the decision
 * back. A region admin must be in scope of the request's region AND of the final
 * region; createProject re-validates the final Business Unit against it.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { readValidated } from '../../../../../utils/validated-body'
import { requireRole, requireRegionScope, requireRegionScopeOrNotFound } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { createProject, type CreateProjectInput } from '../../../../../projects/create-project'
import { ApproveProjectRequestBody } from '../../../../../projects/schemas'
import {
  closeRequestInboxItems,
  loadProjectRequest,
  notifyRequestDecided,
} from '../../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'request id')
  const body = await readValidated(event, ApproveProjectRequestBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const notFound = createError({ statusCode: 404, statusMessage: 'Project request not found' })

  return await withRequestRls(event, async (tx) => {
    const req = await loadProjectRequest(tx, id)
    if (!req) throw notFound
    await requireRegionScopeOrNotFound(event, req.region_id, notFound)
    if (req.status !== 'pending') {
      throw createError({ statusCode: 409, statusMessage: `This request is already ${req.status}` })
    }

    const final: CreateProjectInput = {
      code: body.code,
      display_name: body.display_name ?? req.display_name,
      type: body.type ?? req.type,
      region_id: body.region_id ?? req.region_id,
      cost_owning_unit_id: body.cost_owning_unit_id ?? req.cost_owning_unit_id,
      wbs_code: body.wbs_code ?? req.wbs_code,
      end_date: body.end_date === undefined ? req.end_date : body.end_date,
      pm_teammate_id: body.pm_teammate_id ?? req.proposed_pm_teammate_id,
      budget: body.budget ?? { amount_usd: req.budget_usd, from: req.budget_from, to: req.budget_to },
    }
    if (final.region_id !== req.region_id) await requireRegionScope(event, final.region_id)

    const decided = await tx.execute<{ id: string }>(sql`
      UPDATE project_request
         SET status = 'approved', decided_by = ${caller.teammateId}::uuid, decided_at = now(),
             decision_note = ${body.note ?? null}
       WHERE id = ${id}::uuid AND status = 'pending'
       RETURNING id::text AS id
    `)
    if (![...decided][0]) {
      throw createError({ statusCode: 409, statusMessage: 'This request was decided or withdrawn meanwhile' })
    }

    const created = await createProject(
      tx,
      { kind: 'teammate', teammateId: caller.teammateId },
      final,
      { source: `request:${id}`, ipAddress: ip, userAgent: ua },
    )
    const projectId = created.project.id

    if (req.requester_teammate_id !== final.pm_teammate_id) {
      await tx.execute(sql`
        INSERT INTO project_assignment (project_id, teammate_id, effective, role, source)
        VALUES (${projectId}::uuid, ${req.requester_teammate_id}::uuid, tstzrange(now(), NULL, '[)'), 'member', 'manual')
      `)
      await recordAuditEvent(tx, {
        eventType: 'project-member-added',
        actorTeammateId: caller.teammateId,
        subjectKind: 'project',
        subjectId: projectId,
        payload: { teammate_id: req.requester_teammate_id, email: req.requester_email, role: 'member', source: `request:${id}` },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    await tx.execute(sql`
      UPDATE project_request SET created_project_id = ${projectId}::uuid WHERE id = ${id}::uuid
    `)
    await recordAuditEvent(tx, {
      eventType: 'project-request-approved',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project_request',
      subjectId: id,
      payload: {
        before: {
          status: 'pending',
          suggested_code: req.suggested_code,
          display_name: req.display_name,
          type: req.type,
          region_id: req.region_id,
          cost_owning_unit_id: req.cost_owning_unit_id,
          proposed_pm_teammate_id: req.proposed_pm_teammate_id,
          budget_usd: req.budget_usd,
        },
        after: { status: 'approved', ...final, project_id: projectId },
        context: { note: body.note ?? null },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    await closeRequestInboxItems(tx, id, caller.teammateId)
    await notifyRequestDecided(tx, req, {
      status: 'approved',
      note: body.note ?? null,
      projectCode: created.project.code,
      projectName: final.display_name,
    })

    return {
      request: await loadProjectRequest(tx, id),
      project: { id: projectId, code: created.project.code },
      allocation_id: created.allocation?.id ?? null,
    }
  })
})
