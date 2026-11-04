import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  bigint,
  numeric,
  date,
  jsonb,
  timestamp,
  boolean,
  customType,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { teammate, orgUnit, region } from './identity'
import { providerOrg, providerEnterprise } from './governance'

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const actualSpend = pgTable(
  'actual_spend',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    date: date('date').notNull(),
    tool: text('tool').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    source: text('source').notNull().default('anthropic-analytics-api'),
    // Cost-category on the adapter staging row (mig 0038). NULL = legacy (treated
    // as model_tokens). See docs/design/reconciliation-engine.md §7.4.
    category: text('category'),
    // ADR-0010 rule 5 (mig 0072): excluded from the chargeback view
    // (v_finance_bill_chargeback) but NOT showback (v_finance_bill_showback). True for
    // NFR/exempt license-orgs; Anthropic bill rows are always false.
    chargebackExempt: boolean('chargeback_exempt').notNull().default(false),
    pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
    rawPayload: jsonb('raw_payload'),
    // Recorded placement (mig 0101): stamped at write/replay time
    // (dimensionSource='ingest-snapshot') and never updated on a re-poll;
    // 0101's backfill labels older rows 'legacy-current-placement'. Reports do
    // not read it — they group by the teammate's CURRENT placement through the
    // current-lens views (mig 0162, docs/design/current-org-lens).
    regionId: uuid('region_id').references(() => region.id),
    orgUnitId: uuid('org_unit_id').references(() => orgUnit.id),
    costOwningUnitId: uuid('cost_owning_unit_id').references(() => orgUnit.id),
    // 'ingest-snapshot' | 'legacy-current-placement' — see dimension-snapshot.ts.
    dimensionSource: text('dimension_source'),
    // Governance key (mig 0103, Workstream B §4.0/R1-H9). NULL = governance
    // -unresolved: showback-visible, never chargeable. See
    // server/reconciliation/governance-keys.ts + server/governance/verdict.ts.
    // ON DELETE SET NULL is in 0103 (Drizzle def omits the FK action, matching
    // the workerRun.runId precedent below) — provider_org/-enterprise stay
    // deletable leaves; a delete un-resolves any row that referenced them
    // rather than orphan-blocking the delete or destroying money history.
    providerOrgId: uuid('provider_org_id').references(() => providerOrg.id),
    // GitHub billing lives on the ENTERPRISE (ADR-0011 D11), not the org.
    providerEnterpriseId: uuid('provider_enterprise_id').references(() => providerEnterprise.id),
    // Backfill bookkeeping only ('resolved' | 'unresolved'); NULL = not yet attempted.
    governanceKeyStatus: text('governance_key_status'),
    // Provenance of the current chargeback_exempt value. See server/governance/verdict.ts.
    governanceVerdictSource: text('governance_verdict_source'),
  },
  (t) => [
    uniqueIndex('actual_spend_teammate_date_tool_source_unique').on(
      t.teammateId,
      t.date,
      t.tool,
      t.source,
    ),
  ],
)

export const spillRecord = pgTable('spill_record', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: text('workspace_id').notNull(),
  invoicePeriod: tstzrange('invoice_period').notNull(),
  invoiceTotalUsd: numeric('invoice_total_usd', { precision: 14, scale: 2 }).notNull(),
  attributedTotalUsd: numeric('attributed_total_usd', { precision: 14, scale: 2 }).notNull(),
  costOwningUnitId: uuid('cost_owning_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  shadowMode: boolean('shadow_mode').notNull().default(false),
  reconciliationState: text('reconciliation_state').notNull().default('open'),
})
