/*
 * POST /api/v1/admin/projects/:id/migrate-preview — what a Migrate WOULD move.
 *
 * Read-only. Answers the question the admin has to be able to answer before
 * they press the button: how many rows, how much money, over which periods, and
 * what will be refused. Money changing home is not an outcome anyone should
 * discover afterwards.
 *
 * It is a POST because it takes a body, not because it writes: nothing here
 * mutates, and the handler holds no locks.
 *
 * The returned `token` binds the preview to the row set it described.
 * `PATCH /admin/projects/:id` accepts it as `migrate_expect_token` and refuses
 * with 409 if the picture has moved — the preview and the write are two
 * requests, and a shared predicate is not a shared row set.
 *
 * Same authorisation as the PATCH it precedes: admin/platform-admin, bounded to
 * the project's own region. A preview that leaked another region's spend totals
 * would be an information-disclosure bug wearing a dry-run's clothes.
 */
import { defineEventHandler, createError, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readValidated } from '../../../../../utils/validated-body'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { assertOrgUnitInRegion } from '../../../../../db/org-units'
import { planRehome, type RehomeRange } from '../../../../../governance/rehome-spend'
import { isRealUtcDay } from '#shared/schemas/activity'

const Body = z.object({
  to_cost_owning_unit_id: z.string().uuid(),
  range: z.union([
    z.object({
          // A REAL day, not just the shape: the regex alone admits 2026-02-31,
          // which reaches Postgres's ::date cast and aborts the query — a 500
          // on a plain caller error. `isRealUtcDay` is the repo's boundary
          // check for exactly this.
          from: z.string().refine(isRealUtcDay, 'not a real calendar day'),
        }),
    z.object({ from: z.literal('all'), confirm_unbounded: z.literal(true) }),
  ]),
})

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireRole(event, 'admin')

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid project id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid project id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const projectId = parsedId.data
  const body = await readValidated(event, Body)

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{ region_id: string; cost_owning_unit_id: string | null }>(sql`
      SELECT region_id::text AS region_id, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM project WHERE id = ${projectId}::uuid LIMIT 1`)
    const project = [...rows][0]
    if (!project) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project matches the supplied id (or RLS denied access).',
        },
      })
    }
    await requireRegionScope(event, project.region_id)
    // Previewing a move to a unit the PATCH would reject wastes the admin's
    // decision on an outcome they cannot have.
    await assertOrgUnitInRegion(tx, {
      orgUnitId: body.to_cost_owning_unit_id,
      regionId: project.region_id,
      mustBeActive: true,
      mustBeCostOwning: true,
      statusMessage: 'to_cost_owning_unit_id is not an active Business Unit in this region',
    })

    const plan = await planRehome(tx, {
      projectId,
      toCostOwningUnitId: body.to_cost_owning_unit_id,
      range: body.range as RehomeRange,
    })
    return { from_cost_owning_unit_id: project.cost_owning_unit_id, ...plan }
  })
})
