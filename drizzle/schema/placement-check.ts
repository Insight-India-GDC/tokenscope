/*
 * placement_check_cycle + placement_evidence (mig 0160). The CHECKs and RLS policies
 * live in the migration; do not `drizzle-kit generate` against this model.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const placementCheckCycle = pgTable('placement_check_cycle', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  startedBy: uuid('started_by').references(() => teammate.id, { onDelete: 'set null' }),
})

export const placementEvidence = pgTable('placement_evidence', {
  teammateId: uuid('teammate_id')
    .primaryKey()
    .references(() => teammate.id, { onDelete: 'cascade' }),
  gatheredAt: timestamp('gathered_at', { withTimezone: true }).notNull(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => placementCheckCycle.id, { onDelete: 'cascade' }),
  lookup: text('lookup').notNull(),
  attributes: jsonb('attributes').notNull(),
  chain: jsonb('chain').notNull(),
  walkEnd: text('walk_end').notNull(),
})
