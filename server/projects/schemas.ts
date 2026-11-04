/*
 * Request-body pieces shared by the project create, PMO create and project
 * request routes. The project-code and WBS rules are the admin create path's
 * (POST /admin/projects), so every create path validates a code the same way.
 */
import { z } from 'zod'
import { displayText, PROJECT_NAME_MAX } from '#shared/schemas/display-text'
import { BudgetUsdSchema } from '../utils/allocation-validation'

export const ProjectCodeSchema = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid project code')

// '' is accepted and stored as NULL ("not set").
export const WbsCodeSchema = z.union([
  z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid WBS code'),
  z.literal(''),
])

export const ProjectTypeSchema = z.enum(['billable', 'pursuit', 'internal'])

export const ProjectNameSchema = displayText(PROJECT_NAME_MAX)

export const IsoInstantSchema = z.string().datetime({ offset: true })

/** A positive NUMERIC(14,2) USD amount. */
export const PositiveBudgetUsdSchema = BudgetUsdSchema.refine((v) => Number(v) > 0, {
  message: 'budget must be greater than zero',
})

/** A baseline budget: amount plus the `[from, to)` period it covers. */
export const BudgetInputSchema = z
  .object({
    amount_usd: PositiveBudgetUsdSchema,
    from: IsoInstantSchema,
    to: IsoInstantSchema,
  })
  .refine((b) => Date.parse(b.from) < Date.parse(b.to), {
    message: 'budget period must end after it starts',
    path: ['to'],
  })

export type BudgetInput = z.infer<typeof BudgetInputSchema>

/** Free prose (a justification or a decision note): newlines allowed. */
export const NoteSchema = z.string().trim().min(1).max(2000)

/**
 * POST /me/project-requests. The PM defaults to the requester. `idempotency_key`
 * is optional (older clients send none): a resend with the same key returns the
 * request already filed (mig 0170).
 */
export const ProjectRequestBody = z
  .object({
    idempotency_key: z.string().uuid().optional(),
    suggested_code: ProjectCodeSchema.optional(),
    display_name: ProjectNameSchema,
    type: ProjectTypeSchema,
    region_id: z.string().uuid(),
    cost_owning_unit_id: z.string().uuid(),
    wbs_code: WbsCodeSchema.optional(),
    end_date: IsoInstantSchema.optional(),
    proposed_pm_teammate_id: z.string().uuid().optional(),
    budget: BudgetInputSchema,
    justification: NoteSchema,
  })
  .strict()

/**
 * POST /admin/project-requests/{id}/approve. The admin sets the final code and
 * may override any proposed field; an omitted field keeps the proposal.
 * `end_date: null` clears a proposed end date.
 */
export const ApproveProjectRequestBody = z
  .object({
    code: ProjectCodeSchema,
    display_name: ProjectNameSchema.optional(),
    type: ProjectTypeSchema.optional(),
    region_id: z.string().uuid().optional(),
    cost_owning_unit_id: z.string().uuid().optional(),
    wbs_code: WbsCodeSchema.optional(),
    end_date: IsoInstantSchema.nullable().optional(),
    pm_teammate_id: z.string().uuid().optional(),
    budget: BudgetInputSchema.optional(),
    note: NoteSchema.optional(),
  })
  .strict()

export const RejectProjectRequestBody = z.object({ note: NoteSchema }).strict()
