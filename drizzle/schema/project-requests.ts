/*
 * project_manager_grant + project_request (migs 0164, 0170,
 * docs/design/project-requests/00-spec.md). CHECKs, the partial unique index and
 * the RLS policies live in the migration — never ship drizzle-kit output for these.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, numeric } from 'drizzle-orm/pg-core'
import { teammate, region, orgUnit } from './identity'
import { project } from './projects'

export const projectManagerGrant = pgTable('project_manager_grant', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  grantedBy: uuid('granted_by').references(() => teammate.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => teammate.id),
  note: text('note'),
})

export const projectRequest = pgTable('project_request', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  requesterTeammateId: uuid('requester_teammate_id')
    .notNull()
    .references(() => teammate.id),
  // 'pending' | 'approved' | 'rejected' | 'withdrawn'
  status: text('status').notNull().default('pending'),
  // 'person' | 'connector' (reserved; no v1 writer)
  source: text('source').notNull().default('person'),
  suggestedCode: text('suggested_code'),
  displayName: text('display_name').notNull(),
  type: text('type').notNull(),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  costOwningUnitId: uuid('cost_owning_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  wbsCode: text('wbs_code'),
  endDate: timestamp('end_date', { withTimezone: true }),
  proposedPmTeammateId: uuid('proposed_pm_teammate_id')
    .notNull()
    .references(() => teammate.id),
  budgetUsd: numeric('budget_usd', { precision: 14, scale: 2 }).notNull(),
  budgetFrom: timestamp('budget_from', { withTimezone: true }).notNull(),
  budgetTo: timestamp('budget_to', { withTimezone: true }).notNull(),
  justification: text('justification').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedBy: uuid('decided_by').references(() => teammate.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  createdProjectId: uuid('created_project_id').references(() => project.id, { onDelete: 'set null' }),
  // mig 0170: client-generated, unique per requester (partial index in the migration).
  idempotencyKey: uuid('idempotency_key'),
})
