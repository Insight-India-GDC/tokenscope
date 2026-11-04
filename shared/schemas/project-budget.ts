/*
 * Project end date and budget requests — the shapes the project page sends and
 * the routes validate (docs/design/project-requests/00-spec.md §4, §5).
 *
 * "Budget request" is the user-facing name of a quota_request row (A15).
 */
import { z } from 'zod'

/**
 * A project's end (D1, docs/design/project-lifecycle.md). An ISO timestamp sets
 * it (now = "end now", a future value = a planned end); null clears it. Shared by
 * the admin PATCH and the PM timeline PATCH so both accept exactly the same value.
 */
export const ProjectEndDateSchema = z.string().datetime({ offset: true }).nullable()

export const ProjectTimelineBody = z.object({
  end_date: ProjectEndDateSchema,
})
export type ProjectTimelineBody = z.infer<typeof ProjectTimelineBody>

/** A positive USD amount, at most 2 decimals, within one top-up's ceiling ($1M). */
export const BudgetRequestAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter an amount in dollars, like 250 or 250.50')
  .refine((v) => Number(v) > 0, 'The amount must be more than zero')
  .refine((v) => Number(v) <= 1_000_000, 'The amount can be at most $1,000,000')

export const BUDGET_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const
export type BudgetRequestStatus = (typeof BUDGET_REQUEST_STATUSES)[number]

export const BudgetRequestCreateBody = z.object({
  amount_usd: BudgetRequestAmountSchema,
  reason: z.string().trim().min(1, 'Say what the budget is for').max(1000),
})
export type BudgetRequestCreateBody = z.infer<typeof BudgetRequestCreateBody>

export const BudgetRequestApproveBody = z.object({
  /** Omitted = approve the amount asked for. */
  amount_usd: BudgetRequestAmountSchema.optional(),
  note: z.string().trim().max(1000).optional(),
})
export type BudgetRequestApproveBody = z.infer<typeof BudgetRequestApproveBody>

export const BudgetRequestRejectBody = z.object({
  note: z.string().trim().min(1, 'Add a note saying why').max(1000),
})
export type BudgetRequestRejectBody = z.infer<typeof BudgetRequestRejectBody>

export interface BudgetRequestRow {
  id: string
  project_id: string
  requester_teammate_id: string
  requester_display_name: string | null
  requester_email: string
  amount_usd: string
  reason: string
  status: BudgetRequestStatus
  approved_amount_usd: string | null
  decided_by_display_name: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
}

export interface BudgetRequestListResponse {
  /** The caller's own requests on this project, newest first. */
  mine: BudgetRequestRow[]
  /** Every pending request on the project — only for its managers and admins, else null. */
  pending: BudgetRequestRow[] | null
  can_decide: boolean
}
