/*
 * POST /api/v1/allocations/{id}/split — set a project's allocation mode
 * and per-developer caps (Screen 4 mode toggle + per-dev budget inputs).
 *
 * {id} is the project's baseline POOL allocation (scope_type='project',
 * teammate_id NULL). Body:
 *   { mode: 'shared_pool' }                       → drop per-dev caps
 *   { mode: 'per_dev_fixed', caps: [{teammate_id, budget_usd}, …] }
 *                                                 → replace per-dev caps
 *
 * Per-dev caps are project-scoped allocation rows carrying teammate_id,
 * sharing the pool's effective range. Invariants:
 *   - every capped teammate must be a current assignee (else 422)
 *   - sum(caps) must not exceed the pool: the baseline plus the top-ups that
 *     overlap its period (else 422). Top-ups count because an approved budget
 *     request on a per-developer project adds a top-up AND raises one cap by
 *     the same amount (spec A7).
 * "Split evenly" is a client helper that submits equal caps; the server
 * only validates the explicit amounts.
 *
 * manager / admin / platform-admin scoped to the project, OR a current PM of
 * the project (spec A1). The {id} must be a pool baseline, so the PM arm only
 * ever writes caps on the project it manages.
 */
import {
  defineEventHandler,
  createError,
  readValidatedBody,
  getRequestIP,
  getHeader,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { assertProjectScopeOrManager } from '../../../../auth/project-authority'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { lockProjectRowAt } from '../../../../projects/last-manager'
import { requestClock } from '../../../../utils/request-clock'

const Body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('shared_pool') }),
  z.object({
    mode: z.literal('per_dev_fixed'),
    caps: z
      .array(
        z.object({
          teammate_id: z.string().uuid(),
          budget_usd: z.string().regex(/^\d+(\.\d{1,2})?$/),
        }),
      )
      .min(1),
  }),
])

const cents = (s: string) => Math.round(Number(s) * 100)

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'allocation id')
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Lock the project first (the last-PM rule's lock, server/projects/last-manager.ts)
    // so the pool, its caps and the caller's PM standing are all read under it:
    // a budget-request approval or a pool edit on this project waits for us, and
    // PM standing is judged at the post-lock instant, so a PM removed through the
    // remove route while we waited is read as removed.
    const [scope] = await tx.execute<{ project_id: string }>(sql`
      SELECT scope_id::text AS project_id FROM allocation
      WHERE id = ${id}::uuid AND scope_type = 'project'
    `)
    const pmAt = scope ? await lockProjectRowAt(tx, scope.project_id, requestClock(event).now) : undefined

    // Resolve the pool baseline + its project scope.
    const poolRows = await tx.execute<{
      project_id: string
      budget_usd: string
      effective: string
      region_id: string
      cou_path: string
      allocation_mode: string
    }>(sql`
      SELECT a.scope_id::text AS project_id,
             a.budget_usd::text AS budget_usd,
             a.effective::text AS effective,
             p.region_id::text AS region_id,
             cou.path::text AS cou_path,
             p.allocation_mode::text AS allocation_mode
      FROM allocation a
      JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE a.id = ${id}::uuid AND a.teammate_id IS NULL AND a.allocation_kind = 'baseline'
      LIMIT 1
    `)
    const pool = [...poolRows][0]
    if (!pool) {
      throw createError({ statusCode: 404, statusMessage: 'Pool allocation not found' })
    }
    const via = await assertProjectScopeOrManager(event, tx, {
      id: pool.project_id,
      regionId: pool.region_id,
      couPath: pool.cou_path,
    }, pmAt)

    // Both branches delete this period's caps, so the audit row carries them as `before`.
    const priorCaps = [
      ...(await tx.execute<{ teammate_id: string; budget_usd: string }>(sql`
        SELECT teammate_id::text AS teammate_id, budget_usd::text AS budget_usd
        FROM allocation
        WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
          AND teammate_id IS NOT NULL AND effective = ${pool.effective}::tstzrange
        ORDER BY teammate_id
      `)),
    ]
    const before = { mode: pool.allocation_mode, caps: priorCaps }
    const context = { pool_budget_usd: pool.budget_usd, effective: pool.effective, via }

    if (body.mode === 'shared_pool') {
      await recordAuditEvent(tx, {
        eventType: 'allocation-split-set',
        actorTeammateId: session.teammateId,
        subjectKind: 'project',
        subjectId: pool.project_id,
        payload: { before, after: { mode: 'shared_pool', caps: [] }, context },
        ipAddress: ip,
        userAgent: ua,
      })
      await tx.execute(sql`
        DELETE FROM allocation
        WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
          AND teammate_id IS NOT NULL AND effective = ${pool.effective}::tstzrange
      `)
      await tx.execute(sql`
        UPDATE project SET allocation_mode = 'shared_pool' WHERE id = ${pool.project_id}::uuid
      `)
      return { project_id: pool.project_id, mode: 'shared_pool', caps: [] }
    }

    // per_dev_fixed — validate caps against current assignees + pool total.
    const assignRows = await tx.execute<{ teammate_id: string }>(sql`
      SELECT teammate_id::text AS teammate_id FROM project_assignment
      WHERE project_id = ${pool.project_id}::uuid AND upper_inf(effective)
    `)
    const assigned = new Set([...assignRows].map((r) => r.teammate_id))
    for (const cap of body.caps) {
      if (!assigned.has(cap.teammate_id)) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Cap target is not assigned to this project',
          data: {
            type: 'https://tokenscope.example.com/errors/cap-unassigned',
            title: 'Assign the teammate first',
            status: 422,
            detail: `Teammate ${cap.teammate_id} must be assigned before receiving a per-dev cap.`,
          },
        })
      }
    }
    const [topups] = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(budget_usd), 0)::text AS total
      FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
        AND teammate_id IS NULL AND allocation_kind = 'top-up'
        AND effective && ${pool.effective}::tstzrange
    `)
    const poolTotal = cents(pool.budget_usd) + cents(topups?.total ?? '0')
    const sum = body.caps.reduce((acc, c) => acc + cents(c.budget_usd), 0)
    if (sum > poolTotal) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Per-developer caps exceed the project budget',
        data: {
          type: 'https://tokenscope.example.com/errors/caps-exceed-pool',
          title: 'Caps exceed pool',
          status: 422,
          detail: `Sum of caps (${(sum / 100).toFixed(2)}) exceeds the pool budget (${(poolTotal / 100).toFixed(2)}).`,
        },
      })
    }

    // One audit event covers the whole split; all per-dev rows reference it.
    const evt = await recordAuditEvent(tx, {
      eventType: 'allocation-split-set',
      actorTeammateId: session.teammateId,
      subjectKind: 'project',
      subjectId: pool.project_id,
      payload: { before, after: { mode: 'per_dev_fixed', caps: body.caps }, context },
      ipAddress: ip,
      userAgent: ua,
    })

    // Replace existing per-dev caps for this period.
    await tx.execute(sql`
      DELETE FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
        AND teammate_id IS NOT NULL AND effective = ${pool.effective}::tstzrange
    `)
    for (const cap of body.caps) {
      await tx.execute(sql`
        INSERT INTO allocation
          (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, created_by, audit_event_id, source)
        VALUES
          ('project', ${pool.project_id}::uuid, ${cap.teammate_id}::uuid, ${cap.budget_usd}::numeric,
           ${pool.effective}::tstzrange, 'baseline', ${session.teammateId}::uuid, ${evt.id}::uuid, 'manual')
      `)
    }
    await tx.execute(sql`
      UPDATE project SET allocation_mode = 'per_dev_fixed' WHERE id = ${pool.project_id}::uuid
    `)

    return {
      project_id: pool.project_id,
      mode: 'per_dev_fixed',
      caps: body.caps,
      pool_budget_usd: pool.budget_usd,
    }
  })
})
