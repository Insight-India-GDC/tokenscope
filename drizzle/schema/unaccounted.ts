import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, date, numeric, bigint, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'
import { teammate, region, orgUnit } from './identity'
import { project } from './projects'

/*
 * over_emission (mig 0072) — the integrity counterpart of unaccounted_usage: per
 * (teammate, day, tool) OTel emission the provider API does not corroborate. Both
 * providers since mig 0073. See docs/design/provider-billing-attribution-model.md
 * §A + ADR-0010 rule 2 / ADR-0008.
 *
 * TWO LANES, discriminated by `reason` (mig 0132) and NEVER merged:
 *   - 'api-uncorroborated' — a bill EXISTS for that cell and OTel materially exceeds
 *     it. The high-confidence flag: the developer reviews it and either quarantines
 *     the suspect session or escalates.
 *   - 'no-bill-to-corroborate' — there is no bill to compare against at all
 *     (api_usd = 0; the org may simply be unreconciled), so only a much higher
 *     absolute floor applies. NOT an accusation, and never a review item — every
 *     developer-facing reader filters to 'api-uncorroborated'.
 */
export const overEmission = pgTable(
  'over_emission',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    day: date('day').notNull(),
    tool: text('tool').notNull(),
    otelUsd: numeric('otel_usd', { precision: 14, scale: 6 }).notNull(),
    apiUsd: numeric('api_usd', { precision: 14, scale: 6 }).notNull(),
    overUsd: numeric('over_usd', { precision: 14, scale: 6 }).notNull(),
    // mig 0132. CHECK IN ('api-uncorroborated','no-bill-to-corroborate'). The
    // default backfilled pre-0132 rows, which all came from the api-uncorroborated
    // lane because it was the only lane that wrote.
    reason: text('reason').notNull().default('api-uncorroborated'),
    state: text('state').notNull().default('open'),
    quarantinedConversationId: text('quarantined_conversation_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => teammate.id),
    resolvedOverUsd: numeric('resolved_over_usd', { precision: 14, scale: 6 }),
    // When the admins were last notified of an escalation (mig 0156).
    escalationNotifiedAt: timestamp('escalation_notified_at', { withTimezone: true }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('over_emission_teammate_day_tool_unique').on(t.teammateId, t.day, t.tool)],
)

/*
 * unaccounted_usage (mig 0071) — per-(teammate, day, tool) reconciliation of the
 * provider usage API (the COMPLETE truth) against what OTel actually captured.
 * `cost_usd` = max(0, API daily total − Σ OTel captured that day). Surfaced as ONE
 * taggable record per (teammate, day, tool) in the needs-tagging flow; `project_id`
 * NULL = still needs tagging. See docs/design/provider-billing-attribution-model.md §A.
 * Attribution (usage completeness), NOT chargeback.
 */
export const unaccountedUsage = pgTable(
  'unaccounted_usage',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    day: date('day').notNull(),
    tool: text('tool').notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    tokens: bigint('tokens', { mode: 'bigint' }).notNull().default(0n),
    projectId: uuid('project_id').references(() => project.id),
    activity: text('activity'),
    source: text('source').notNull().default('api-reconciled'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    taggedAt: timestamp('tagged_at', { withTimezone: true }),
    taggedBy: uuid('tagged_by').references(() => teammate.id),
    // Worklist-only (mig 0094): the teammate decided to leave this day
    // unallocated. It leaves the needs-tagging queue; the spend is untouched and
    // still counts in the unallocated total. A CHECK makes tagged-and-dismissed
    // unrepresentable. See needs-tagging-worklist.md.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    // The reconciled delta when the decision was made. Reconciliation recomputes
    // that delta every run, so a dismissal that predates a large upward revision
    // is stale — sweepStaleDismissals hands it back.
    dismissedCostUsd: numeric('dismissed_cost_usd', { precision: 14, scale: 6 }),
    // Why this row has no unaccounted_usage_model children (mig 0123, r1-H5):
    // 'provider-day-grain' (only github money backs the key — Copilot money is
    // day-grain, mig 0120) | 'awaiting-provider-detail' (no cost-bearing facts
    // landed yet — transient) | NULL (children exist, or nothing to explain).
    // Stamped by unaccounted-reconciliation.ts on every recompute. NOT a model
    // column — the (teammate, day, tool) key and one-tagging-decision stand.
    modelGapReason: text('model_gap_reason'),
  },
  (t) => [
    uniqueIndex('unaccounted_usage_teammate_day_tool_unique').on(t.teammateId, t.day, t.tool),
    index('unaccounted_usage_teammate_day_idx').on(t.teammateId, t.day),
  ],
)

/*
 * unaccounted_usage_model (mig 0123) — the fill's per-model residual, one row per
 * (parent, model): cap(GREATEST(0, API_model − OTel_model)), a subtraction of two
 * OBSERVED operands (provider_usage_fact cost/token rows vs corroborated OTel),
 * never an apportionment. Written by unaccounted-reconciliation.ts in the SAME
 * transaction as the parent upsert, replaced wholesale per run — so
 * Σ children ≤ parent holds at every read. No tagging columns: the parent stays
 * the one tagging decision. See
 * docs/design/reporting-consolidation/07-model-axis-subtraction-build.md D1-D3.
 */
export const unaccountedUsageModel = pgTable(
  'unaccounted_usage_model',
  {
    unaccountedUsageId: uuid('unaccounted_usage_id')
      .notNull()
      .references(() => unaccountedUsage.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    tokens: bigint('tokens', { mode: 'bigint' }).notNull().default(0n),
  },
  (t) => [primaryKey({ columns: [t.unaccountedUsageId, t.model] })],
)
