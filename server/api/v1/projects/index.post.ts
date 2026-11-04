/*
 * POST /api/v1/projects — a PMO-list holder creates a project without approval
 * (docs/design/project-requests/00-spec.md §2, A4, A13, A14).
 *
 * Any signed-in teammate may call it; canCreateProjects decides (the PMO grant,
 * plus the own-region switch). One atomic call: project, PM (default: the
 * caller) and baseline budget, which is required here. allow_burned_code is
 * admin-only, so the strict body refuses it.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { readValidated } from '../../../utils/validated-body'
import { requireAuth } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { canCreateProjects } from '../../../auth/org-roles'
import { createProject } from '../../../projects/create-project'
import {
  BudgetInputSchema,
  IsoInstantSchema,
  ProjectCodeSchema,
  ProjectNameSchema,
  ProjectTypeSchema,
  WbsCodeSchema,
} from '../../../projects/schemas'

const Body = z
  .object({
    code: ProjectCodeSchema,
    display_name: ProjectNameSchema,
    type: ProjectTypeSchema,
    region_id: z.string().uuid(),
    cost_owning_unit_id: z.string().uuid(),
    wbs_code: WbsCodeSchema.optional(),
    end_date: IsoInstantSchema.optional(),
    pm_teammate_id: z.string().uuid().optional(),
    budget: BudgetInputSchema,
  })
  .strict()

const REFUSAL_DETAIL = {
  'not-on-list': 'Only people on the Project managers list can create projects directly. Request a project instead.',
  'outside-own-region': 'Project Managers may create projects only in the region they are placed in.',
  'no-placement-region': 'Project Managers may create projects only in their own region, and you are not placed in a region.',
  'connector-unsupported': 'Connectors cannot create projects yet.',
} as const

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const actor = { kind: 'teammate', teammateId: session.teammateId } as const

  return await withRequestRls(event, async (tx) => {
    const verdict = await canCreateProjects(tx, actor, body.region_id)
    if (!verdict.ok) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: REFUSAL_DETAIL[verdict.reason],
        },
      })
    }
    const result = await createProject(
      tx,
      actor,
      { ...body, pm_teammate_id: body.pm_teammate_id ?? session.teammateId },
      { source: 'pmo', ipAddress: ip, userAgent: ua },
    )
    return {
      id: result.project.id,
      code: result.project.code,
      is_onboarded: result.project.isOnboarded,
      allocation_id: result.allocation!.id,
    }
  })
})
