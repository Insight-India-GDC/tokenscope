import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  bigint,
  numeric,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { region, orgUnit, teammate } from './identity'
import { project } from './projects'
import { instanceAttestation } from './instance-attestation'

export const attributionRecord = pgTable('attribution_record', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // The INSTANCE id (device/enrolment) — teammate binding via the attestation.
  instanceId: uuid('instance_id')
    .notNull()
    .references(() => instanceAttestation.instanceId),
  // Claude's own per-conversation session.id (Attributes['session.id']) — the
  // CONVERSATION the spend belongs to. Subagents share their parent's value, so
  // grouping on this rolls subagent spend into the parent conversation. Nullable:
  // historical rows (pre-0016) stay NULL and fall back to instance grouping.
  claudeSessionId: text('claude_session_id'),
  // mig 0166 (#494): the tokenscope.instance_id the telemetry record NAMED, set
  // only when the joiner booked the row to another instance of the same
  // teammate from a session_instance_report. NULL = booked as named. The dedup
  // index keys on COALESCE(emitted_instance_id, instance_id).
  emittedInstanceId: uuid('emitted_instance_id').references(() => instanceAttestation.instanceId),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  // Nullable (mig 0021): a project-LESS row is unallocated spend (untagged or
  // tagged-only). NULL means "no project budget". region/org are the emitting
  // teammate's RECORDED placement and stay NOT NULL; reports group by the
  // teammate's current placement instead (mig 0162, docs/design/current-org-lens).
  projectId: uuid('project_id').references(() => project.id),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  orgUnitId: uuid('org_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  // Nullable (mig 0021): follows the project — NULL when there's no project budget.
  // It is the PROJECT's cost-owning unit, stamped at emit time
  // (azure-monitor-reader.ts sets it from proj.cost_owning_unit_id) — NOT the
  // spender's home cost centre. So `WHERE cost_owning_unit_id = X` is a
  // project-axis clamp: it selects whole projects, and can never express "the
  // part X's own people spent". That question is a TEAMMATE-axis one (resolve
  // the teammates homed in X, clamp on teammate_id) and it deliberately does not
  // foot to a cost centre's burn — see me/cost-centres.get.ts's
  // member_untagged_usd note. Two design reviews have now read this column as
  // the spender's home; it is not.
  costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
  tool: text('tool').notNull(),
  model: text('model').notNull(),
  tokenType: text('token_type').notNull(),
  tokens: bigint('tokens', { mode: 'bigint' }).notNull(),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
  // Native AIU operand for the GitHub lane (mig 0038): the Copilot joiner persists
  // nano_aiu->AIU so reconciliation is credit-vs-credit. NULL for Claude rows.
  creditQty: numeric('credit_qty', { precision: 20, scale: 6 }),
  // Nullable (mig 0036): NULL for Copilot rows (priced by AI-credit constant,
  // not a token rate_line). Non-null for Claude rows.
  rateCardId: uuid('rate_card_id'),
  rateCardVersion: integer('rate_card_version'),
  fidelityTier: text('fidelity_tier').notNull(),
  costBasis: text('cost_basis').notNull(),
  tsEvent: timestamp('ts_event', { withTimezone: true }).notNull(),
  tsRecorded: timestamp('ts_recorded', { withTimezone: true }).notNull().defaultNow(),
  sourceRunId: text('source_run_id'),
  isFrozen: boolean('is_frozen').notNull().default(true),
  // Orthogonal activity axis (mig 0020): denormalised from session_assignment by
  // the joiner / assign endpoint, for within-project activity rollups. Nullable.
  activity: text('activity'),
  // Claude's per-event query_source attr (mig 0045), stored RAW — Claude's own
  // token ('repl_main_thread', 'agent:custom', 'compact', …), NEVER the word
  // 'main'. Classify with shared/usage/query-source.ts; vocabulary + evidence in
  // docs/development/claude-code-telemetry-contract.md. NULL = captured
  // pre-0045 / attr absent — unknown lane, never assumed to be a conversation.
  // Not in the dedup index: request_id (source_run_id) already disambiguates
  // same-ms aux/main events.
  querySource: text('query_source'),
  // Identity provenance (mig 0057; emit-on-install). The emitting instance's
  // instance_attestation.identity_state, stamped by the read joiner at insert
  // time so downstream surfaces can exclude/label provisional usage. NOTE: money
  // is gated by the FINANCE axis (reconciled), NOT by this — identity_state is
  // display + human-paging discipline only. NULL = legacy rows written before
  // 0057 (treat as 'confirmed').
  identityState: text('identity_state'),
  // ── Emitting identity + billing lane (mig 0119) ──────────────────────────
  // WHICH ACCOUNT was signed in, as opposed to which DEVICE emitted. Money
  // still binds to the device (instance_id → teammate); these decide only
  // whether the dollar is inside the bill we reconcile against.
  //
  // Canonicalised (trim + lower, shared/identity/email.ts) at storage, so a
  // comparison against a canonicalised address set is like-for-like. NULL =
  // the emitter reported no address (or reported an unsafe one — see the
  // optional-field bound in server/azure/reader.ts).
  emittingEmail: text('emitting_email'),
  // Hint + diagnostics only; it NEVER decides the lane. Distinct from the
  // reconciliation lane pick, which uses one organization.id per grouped
  // session — this is the per-RECORD value.
  emittingOrgId: text('emitting_org_id'),
  // 'provider-billed' | 'self-billed' | 'unknown' (CHECK in mig 0119).
  //
  // STAMPED ONCE AT JOIN, NEVER UPDATED. The only write that may change it is a
  // backfill filling an 'unknown' — one way, never overwriting a decided lane
  // (design §5/§9). Read that as a hard rule: a present-day identity action
  // (email change, shadow confirm, marking an alias enterprise, erasure) must
  // not rewrite a historic residual, project total or budget. Three earlier
  // drafts of this design died on exactly that.
  //
  // 'unknown' is NOT folded into 'provider-billed' even though both net against
  // the API: keeping it distinct is what lets a PARTIALLY classified
  // (teammate, day, tool) cell be detected and held on the old operand
  // (server/usage/corroborated-otel.ts).
  billingLane: text('billing_lane').notNull().default('unknown'),
  metadata: jsonb('metadata'),
}, (t) => [
  // Read-joiner idempotency (migrations 0011 + 0017 + 0035 + 0166): one row per
  // (EMITTED instance, conversation, event, token-type, model, source_run_id).
  // The live index keys on COALESCE(emitted_instance_id, instance_id),
  // COALESCE(claude_session_id, '') and COALESCE(source_run_id, '') —
  // migrations are hand-written, so this drizzle def (which can't express the
  // COALESCE) is approximate; 0166 is the source of truth.
  // source_run_id (= spanId/requestId) is added in 0035 for Copilot parallel-
  // subagent safety: same-ms chat calls to the same model no longer collide.
  uniqueIndex('attribution_record_session_event_unique').on(
    t.instanceId,
    t.claudeSessionId,
    t.tsEvent,
    t.tokenType,
    t.model,
    t.sourceRunId,
  ),
])

export const attributionAggregate = pgTable(
  'attribution_aggregate',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    periodKind: text('period_kind').notNull(),
    tool: text('tool'),
    model: text('model'),
    // mig 0045: token-type dimension (input | output | cache-read | cache-write).
    // NULL = all-types rollup, mirroring the nullable tool/model convention.
    tokenType: text('token_type'),
    // mig 0046: query-source lane dimension, carried RAW from
    // attribution_record (classify with shared/usage/query-source.ts;
    // NULL = unknown). The live unique index keys on COALESCE(query_source, '')
    // — an expression this drizzle def can't render; 0046 is the source of truth.
    querySource: text('query_source'),
    totalTokens: bigint('total_tokens', { mode: 'bigint' }).notNull(),
    totalCostUsd: numeric('total_cost_usd', { precision: 14, scale: 6 }).notNull(),
    // mig 0046: the tier-2 (telemetry-only / advisory) subset of
    // total_cost_usd for this cell — estimated vs advisory split without
    // touching the raw ledger.
    advisoryCostUsd: numeric('advisory_cost_usd', { precision: 14, scale: 6 })
      .notNull()
      .default('0'),
    recordCount: integer('record_count').notNull(),
    refreshAt: timestamp('refresh_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('attribution_aggregate_scope_unique').on(
      t.scopeType,
      t.scopeId,
      t.periodStart,
      t.periodEnd,
      t.tool,
      t.model,
      t.tokenType,
    ),
  ],
)

// Durable enriched spend rollup (mig 0053; ledger-retention epic). The single
// source-of-truth that survives raw retention — grain serves dev / PM / finance
// past month-end. The live grain-unique index keys on COALESCE expressions
// (sentinel uuid for nullable project_id/cost_owning_unit_id, '' for
// activity/query_source) which this drizzle def can't render — 0053 is the
// source of truth. project_id/cost_owning_unit_id/activity/query_source are
// nullable grain dims; region/org are the recorded placement, CARRIED from raw.
export const spendRollupDaily = pgTable(
  'spend_rollup_daily',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    projectId: uuid('project_id').references(() => project.id),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnit.id),
    costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
    tool: text('tool').notNull(),
    model: text('model').notNull(),
    tokenType: text('token_type').notNull(),
    activity: text('activity'),
    querySource: text('query_source'),
    totalTokens: bigint('total_tokens', { mode: 'bigint' }).notNull(),
    totalCostUsd: numeric('total_cost_usd', { precision: 14, scale: 6 }).notNull(),
    // The telemetry-only (indicative) subset of total_cost_usd, keyed on
    // cost_basis (the axis v_effective_spend.spend_class uses). estimated =
    // total - indicative.
    indicativeCostUsd: numeric('indicative_cost_usd', { precision: 14, scale: 6 })
      .notNull()
      .default('0'),
    recordCount: integer('record_count').notNull(),
    refreshAt: timestamp('refresh_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('spend_rollup_daily_project_period').on(t.projectId, t.periodStart),
    index('spend_rollup_daily_teammate_period').on(t.teammateId, t.periodStart),
    index('spend_rollup_daily_cou_period').on(t.costOwningUnitId, t.periodStart),
  ],
)

// Day-grain §A rollup for the region reporting endpoints (mig 0136) —
// content DEFINED as an aggregate of v_complete_usage, written by the
// usage-rollup worker. teammate stays in the grain for the non-additive
// reads. Live grain-unique keys on COALESCE sentinels — 0136 is the source
// of truth for that expression index (docs/design/usage-rollup-lane.md).
export const usageRollupDaily = pgTable(
  'usage_rollup_daily',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    day: date('day').notNull(),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
    projectId: uuid('project_id').references(() => project.id),
    tool: text('tool').notNull(),
    model: text('model'),
    usageProvenance: text('usage_provenance').notNull(),
    modelGapReason: text('model_gap_reason'),
    activity: text('activity'),
    // Grain dim (mig 0138): the lane row's identity_state as the view projects
    // it — NULL is a real arm-1 value; arms 2/3 are 'confirmed' by
    // construction (usage-rollup-lane.md R5b).
    identityState: text('identity_state'),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    tokens: bigint('tokens', { mode: 'bigint' }).notNull(),
    recordCount: integer('record_count').notNull(),
    refreshAt: timestamp('refresh_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_rollup_daily_day_idx').on(t.day),
    index('usage_rollup_daily_region_day_idx').on(t.regionId, t.day),
    index('usage_rollup_daily_org_unit_day_idx').on(t.orgUnitId, t.day),
    index('usage_rollup_daily_teammate_day_idx').on(t.teammateId, t.day),
  ],
)

// Retro-mutation refresh queue for usage_rollup_daily (mig 0136): quarantine
// flips and placement re-homes queue the teammate; the usage-rollup worker
// drains per teammate (delete-after-recompute).
export const usageRollupRefresh = pgTable('usage_rollup_refresh', {
  teammateId: uuid('teammate_id')
    .primaryKey()
    .references(() => teammate.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
})

// Singleton archive watermark (mig 0056; ledger-retention epic). One row,
// id='singleton'. archived_through = the exclusive lower bound of the HOT
// window: raw with ts_event < it has been exported + dropped and is served from
// spend_rollup_daily. NULL until the first partition is retired. Advanced ONLY
// by the archive-ledger worker; READ by v_effective_spend as the cold/hot
// boundary (a stored watermark, not a live min(ts_event) a late DEFAULT-routed
// row could snap backwards — see 0056).
export const ledgerArchiveState = pgTable('ledger_archive_state', {
  id: text('id').primaryKey().default('singleton'),
  archivedThrough: timestamp('archived_through', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Companion distinct-session activity per (teammate, project, day). Session
// count can't be recomputed after raw is retired, so it's captured here at
// rollup time. Cross-day rollups are session-(project-)days, not exact distinct
// sessions (see 0053). Live grain-unique keys on COALESCE(project_id, sentinel).
export const spendSessionDaily = pgTable(
  'spend_session_daily',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    projectId: uuid('project_id').references(() => project.id),
    distinctSessionCount: integer('distinct_session_count').notNull(),
    refreshAt: timestamp('refresh_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('spend_session_daily_project_period').on(t.projectId, t.periodStart)],
)

// Behavioural usage signals — a name-keyed, NON-additive telemetry lane kept
// deliberately SEPARATE from the token ledger (Copilot tool/MCP/context/turn
// signals; design: docs/design/copilot-usage-signals.md). One row per
// (emitting span, signal). `value` is a per-observation gauge aggregated ON READ
// by fetchSignalCells (count/sum/min/max) — it is NEVER summed as spend, so this
// is not part of attribution_aggregate. Generalises the spend_session_daily
// "non-additive companion" precedent (0053) to be name-keyed: a new signal is a
// new row value, never a migration. Mig 0065. The dedup UNIQUE is expression-based
// (COALESCE(source_run_id,'')) and lives in the migration — this drizzle def
// carries only the read-path index (cf. spend_session_daily / attribution_aggregate).
export const usageSignalRecord = pgTable(
  'usage_signal_record',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instanceAttestation.instanceId),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    tool: text('tool').notNull(),
    signalName: text('signal_name').notNull(),
    value: numeric('value', { precision: 20, scale: 4 }).notNull(),
    tsEvent: timestamp('ts_event', { withTimezone: true }).notNull(),
    tsRecorded: timestamp('ts_recorded', { withTimezone: true }).notNull().defaultNow(),
    sourceRunId: text('source_run_id'),
  },
  (t) => [index('usage_signal_record_teammate_event').on(t.teammateId, t.tsEvent)],
)
