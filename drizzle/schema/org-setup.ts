/*
 * org_setup_setting, org_setup_dismissal, placement_principal_check (mig 0161). The
 * CHECKs, the seeded row and the RLS policies live in the migration; do not
 * `drizzle-kit generate` against this model.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, boolean, unique } from 'drizzle-orm/pg-core'
import { teammate } from './identity'
import { placementCheckCycle } from './placement-check'

export const orgSetupSetting = pgTable('org_setup_setting', {
  id: boolean('id').primaryKey().default(true),
  topOid: text('top_oid'),
  topName: text('top_name'),
  topEmail: text('top_email'),
  readCadence: text('read_cadence').notNull().default('month'),
  updatedBy: uuid('updated_by').references(() => teammate.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgSetupDismissal = pgTable(
  'org_setup_dismissal',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => placementCheckCycle.id, { onDelete: 'cascade' }),
    dismissedBy: uuid('dismissed_by').references(() => teammate.id, { onDelete: 'set null' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.kind, t.subjectKey, t.cycleId)],
)

export const placementPrincipalCheck = pgTable('placement_principal_check', {
  oid: text('oid').primaryKey(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => placementCheckCycle.id, { onDelete: 'cascade' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  found: boolean('found').notNull(),
})
