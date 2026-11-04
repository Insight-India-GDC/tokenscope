/*
 * quota_request (mig 0165) — a project member's request for more budget on that
 * project. The UI calls it a "budget request" (spec A15).
 *
 * CONSTRAINTS LIVE IN THE MIGRATION (0165), NOT this model: the status and
 * decision-shape CHECKs, the one-pending-per-(project, requester) partial unique
 * index and the RLS policies are hand-written SQL Drizzle can't render. Do NOT
 * run drizzle-kit generate against this model and ship its output.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, numeric } from 'drizzle-orm/pg-core'
import { teammate } from './identity'
import { project } from './projects'
import { allocation } from './governance'

export const quotaRequest = pgTable('quota_request', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid('project_id')
    .notNull()
    .references(() => project.id, { onDelete: 'cascade' }),
  requesterTeammateId: uuid('requester_teammate_id')
    .notNull()
    .references(() => teammate.id),
  amountUsd: numeric('amount_usd', { precision: 14, scale: 2 }).notNull(),
  reason: text('reason').notNull(),
  // 'pending' | 'approved' | 'rejected' | 'withdrawn' — CHECK in mig 0165.
  status: text('status').notNull().default('pending'),
  approvedAmountUsd: numeric('approved_amount_usd', { precision: 14, scale: 2 }),
  decidedBy: uuid('decided_by').references(() => teammate.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  allocationId: uuid('allocation_id').references(() => allocation.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
