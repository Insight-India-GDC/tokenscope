/*
 * POST /api/v1/admin/projects — register a new project (Journey 3a
 * onboarding, Screen 5 admin Projects tab).
 *
 * Admin / platform-admin only; a region admin is bound to their own region
 * (requireRegionScope). Validation and writes are createProject's
 * (server/projects/create-project.ts). PM and budget are optional here: without
 * a budget the project is created not-yet-onboarded and the first allocation
 * (POST /api/v1/allocations) onboards it; with one it is onboarded in this call.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { readValidated } from '../../../utils/validated-body'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { createProject } from '../../../projects/create-project'
import {
  BudgetInputSchema,
  IsoInstantSchema,
  ProjectCodeSchema,
  ProjectNameSchema,
  ProjectTypeSchema,
  WbsCodeSchema,
} from '../../../projects/schemas'

const Body = z.object({
  code: ProjectCodeSchema,
  display_name: ProjectNameSchema,
  type: ProjectTypeSchema,
  region_id: z.string().uuid(),
  cost_owning_unit_id: z.string().uuid(),
  // Optional finance-system WBS code (correlation only).
  wbs_code: WbsCodeSchema.optional(),
  end_date: IsoInstantSchema.optional(),
  pm_teammate_id: z.string().uuid().optional(),
  budget: BudgetInputSchema.optional(),
  // Admin override for code-burn (D6) — typo recovery. Lets a code that
  // previously belonged to an attributed-then-deleted project be reused.
  allow_burned_code: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  await requireRegionScope(event, body.region_id)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const result = await createProject(
      tx,
      { kind: 'teammate', teammateId: caller.teammateId },
      body,
      { source: 'admin', ipAddress: ip, userAgent: ua },
    )
    return {
      id: result.project.id,
      code: result.project.code,
      is_onboarded: result.project.isOnboarded,
      ...(result.allocation ? { allocation_id: result.allocation.id } : {}),
    }
  })
})
