/*
 * POST /api/v1/me/project-requests — any teammate asks for a new project
 * (docs/design/project-requests/00-spec.md §3). The Business Unit must be an
 * active cost-owning unit in the chosen region, and the proposed PM (default:
 * the requester) an existing active teammate. The admins of that region are
 * notified; the request also waits on Admin → Project requests regardless.
 *
 * Idempotent on `idempotency_key` (mig 0170), per requester: a resend with a
 * key already used returns that request as it is now, filing, auditing and
 * notifying nothing; the same key with different content is 422 (the
 * Idempotency-Key draft's answer to a reused key). Without a key every call
 * files a new request.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { readValidated } from '../../../../utils/validated-body'
import { requireAuth } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { assertOrgUnitInRegion } from '../../../../db/org-units'
import { ProjectRequestBody } from '../../../../projects/schemas'
import {
  loadProjectRequest,
  MAX_PENDING_PER_REQUESTER,
  notifyRequestSubmitted,
} from '../../../../projects/project-requests'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const body = await readValidated(event, ProjectRequestBody)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const pmId = body.proposed_pm_teammate_id ?? session.teammateId

  return await withRequestRls(event, async (tx) => {
    // Serialise one requester's submissions so two at once cannot both pass the
    // count, nor both miss the same idempotency key.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'project-request:' + session.teammateId}))`)

    if (body.idempotency_key) {
      // Before the checks below: a replay returns what was filed even if the unit or PM has changed since.
      const [prior] = await tx.execute<{ id: string; same: boolean }>(sql`
        SELECT id::text AS id,
               (display_name = ${body.display_name}
                AND type = ${body.type}
                AND region_id = ${body.region_id}::uuid
                AND cost_owning_unit_id = ${body.cost_owning_unit_id}::uuid
                AND suggested_code IS NOT DISTINCT FROM ${body.suggested_code ?? null}
                AND wbs_code IS NOT DISTINCT FROM ${body.wbs_code || null}
                AND end_date IS NOT DISTINCT FROM ${body.end_date ?? null}::timestamptz
                AND proposed_pm_teammate_id = ${pmId}::uuid
                AND budget_usd = ${body.budget.amount_usd}::numeric
                AND budget_from = ${body.budget.from}::timestamptz
                AND budget_to = ${body.budget.to}::timestamptz
                AND justification = ${body.justification}) AS same
        FROM project_request
        WHERE requester_teammate_id = ${session.teammateId}::uuid AND idempotency_key = ${body.idempotency_key}::uuid
      `)
      if (prior) {
        if (!prior.same) {
          throw createError({
            statusCode: 422,
            statusMessage: 'This idempotency_key was already used for a different request. Send a new key for new content.',
          })
        }
        return (await loadProjectRequest(tx, prior.id))!
      }
    }

    await assertOrgUnitInRegion(tx, {
      orgUnitId: body.cost_owning_unit_id,
      regionId: body.region_id,
      mustBeActive: true,
      mustBeCostOwning: true,
      statusMessage: 'cost_owning_unit_id is not an active Business Unit in this region',
    })
    const pm = [...(await tx.execute<{ ok: boolean }>(sql`
      SELECT TRUE AS ok FROM teammate
      WHERE id = ${pmId}::uuid AND is_active AND provisional IS NOT TRUE
    `))][0]
    if (!pm) {
      throw createError({ statusCode: 422, statusMessage: 'The proposed project manager must be an existing, active teammate' })
    }

    const [open] = await tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM project_request
      WHERE requester_teammate_id = ${session.teammateId}::uuid AND status = 'pending'
    `)
    if (Number(open?.n ?? 0) >= MAX_PENDING_PER_REQUESTER) {
      throw createError({
        statusCode: 409,
        statusMessage: `You already have ${MAX_PENDING_PER_REQUESTER} project requests waiting. Withdraw one or wait for a decision.`,
      })
    }

    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO project_request (
        requester_teammate_id, suggested_code, display_name, type, region_id,
        cost_owning_unit_id, wbs_code, end_date, proposed_pm_teammate_id,
        budget_usd, budget_from, budget_to, justification, idempotency_key)
      VALUES (
        ${session.teammateId}::uuid, ${body.suggested_code ?? null}, ${body.display_name}, ${body.type},
        ${body.region_id}::uuid, ${body.cost_owning_unit_id}::uuid, ${body.wbs_code || null},
        ${body.end_date ?? null}::timestamptz, ${pmId}::uuid,
        ${body.budget.amount_usd}::numeric, ${body.budget.from}::timestamptz, ${body.budget.to}::timestamptz,
        ${body.justification}, ${body.idempotency_key ?? null}::uuid)
      RETURNING id::text AS id
    `)
    const id = [...rows][0]!.id

    await recordAuditEvent(tx, {
      eventType: 'project-request-created',
      actorTeammateId: session.teammateId,
      subjectKind: 'project_request',
      subjectId: id,
      payload: {
        display_name: body.display_name,
        suggested_code: body.suggested_code ?? null,
        region_id: body.region_id,
        cost_owning_unit_id: body.cost_owning_unit_id,
        proposed_pm_teammate_id: pmId,
        budget_usd: body.budget.amount_usd,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    const created = (await loadProjectRequest(tx, id))!
    await notifyRequestSubmitted(tx, created)
    return created
  })
})
