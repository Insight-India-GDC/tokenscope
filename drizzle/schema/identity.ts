/*
 * Identity & org hierarchy — region, org_unit, teammate, teammate_identity_map.
 *
 * Schema mirrors the DDL in drizzle/migrations/0001_schema.sql.
 * `customType` is used for `LTREE` (Drizzle has no native binding) — the
 * column is serialised as plain text on the wire and PG handles the cast.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  jsonb,
  timestamp,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core'

const ltree = customType<{ data: string }>({
  dataType() {
    return 'ltree'
  },
})

export const region = pgTable('region', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code: text('code').notNull().unique(),
  displayName: text('display_name').notNull(),
})

export const orgUnit = pgTable(
  'org_unit',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    parentId: uuid('parent_id'),
    path: ltree('path').notNull(),
    code: text('code').notNull(),
    displayName: text('display_name').notNull(),
    unitType: text('unit_type').notNull(),
    isCostOwningUnit: boolean('is_cost_owning_unit').notNull().default(false),
    // Soft-retire (mig 0022): NULL = active. Set when a cost centre with history
    // (referencing projects/teammates) is retired; a hard DELETE is only allowed
    // when the unit is empty.
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    source: text('source').notNull().default('manual'),
    isPinned: boolean('is_pinned').notNull().default(true),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('org_unit_region_code_unique').on(t.regionId, t.code)],
)

export const teammate = pgTable('teammate', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  entraOid: text('entra_oid').notNull().unique(),
  // Email uniqueness is a PARTIAL unique index (mig 0057): UNIQUE (email) WHERE
  // NOT provisional. Drizzle can't render a WHERE-filtered unique, so the inline
  // .unique() is dropped here and 0057 owns the constraint (same pattern as
  // cou_owner's active-unique). Provisional shadow teammates (emit-on-install)
  // are EXCLUDED, so a claimed email never occupies or collides with a real
  // teammate's slot — the real Entra JIT sign-in must not hit a unique violation.
  email: text('email').notNull(),
  displayName: text('display_name'),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  orgUnitId: uuid('org_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  // Wave-V: durable role anchor. Default 'developer'; JIT teammate creation
  // writes the bootstrap-resolved role here. stop-impersonating restores
  // from this column, not from a hardcoded 'admin'.
  role: text('role').notNull().default('developer'),
  competencyTier: text('competency_tier'),
  // Emit-on-install (mig 0057): a provisional shadow teammate minted by the
  // enroll path before the human authenticates. Such rows use the reserved
  // entra_oid='provisional:'||uuid namespace (slice 3) and are excluded from the
  // partial email-unique index. A confirm-on-auth merge re-points their instances
  // to the real teammate and flips this false (display-only; never moves money).
  provisional: boolean('provisional').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  // The SESSION ANCHOR, and only that (#428, mig 0168's column comment).
  // Every cookie session, auth code (by its approving session, #431) and
  // interactive credential minted before it is refused; anything minted after
  // is valid. Bumped by a role change, a region move, revoke-sessions and
  // shadow retirement. Offboarding is is_active; device emission is
  // emit_revoked_at. Never gate eligibility on it.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Mig 0152 (#414): the anchor device emission is judged against. Bumped by
  // revoke-sessions and retirement only, never by a role or region change.
  emitRevokedAt: timestamp('emit_revoked_at', { withTimezone: true }),
})

// Explicit cost-owning-unit ownership (mig 0048). The P&L owner is typically
// 2-3 levels removed from developers in the org chart, so ownership is an
// explicit assignment, never derived from LTREE adjacency. 1..n owners per
// CoU; soft-revoke keeps history. Active = revoked_at IS NULL (partial-unique
// in the migration; Drizzle can't render WHERE-indexed uniques).
export const couOwner = pgTable('cou_owner', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgUnitId: uuid('org_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  assignedBy: uuid('assigned_by').references(() => teammate.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => teammate.id),
})

// Region derivation (mig 0068) — curated config for placing unplaced users in their
// real region (docs/design/org-entra-region-derivation.md). department_to_region is the
// primary signal (Entra `department` → region); region_leader is the manager-walk
// fallback target, keyed on the leader's stable Entra oid.
// directory_region_rule (was department_to_region, mig 0068 → generalised in
// mig 0089): a curated "when a user's <attribute> = <value>, their region is R"
// rule. `attribute` is a RegionAttributeKey (companyName / country /
// officeLocation / state / department / division) so ANY tenant can key on the
// directory field that is region-correlated on THEIR directory — not just
// `department`. See shared/placement/region-attributes.ts + the design doc.
export const directoryRegionRule = pgTable(
  'directory_region_rule',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // RegionAttributeKey — which Entra directory attribute this rule matches on.
    attribute: text('attribute').notNull(),
    // 'exact' | 'prefix'. prefix maps a whole country/state at once
    // (officeLocation 'AU-…' → APAC) without a row per site.
    matchMode: text('match_mode').notNull().default('exact'),
    // normalised trim().lower() — the value compared to the user's attribute.
    matchValue: text('match_value').notNull(),
    // original casing, for display.
    matchValueRaw: text('match_value_raw').notNull(),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    // mig 0112: NULL = a region rule (the original shape); NOT NULL = a UNIT
    // rule — matching teammates are placed into this cost-owning unit and
    // region_id is that unit's own region. The composite FK
    // (org_unit_id, region_id) → org_unit(id, region_id) lives in the migration
    // (Drizzle cannot render a composite FK against a non-PK unique), and it is
    // what stops a rule naming a unit and a region that disagree.
    orgUnitId: uuid('org_unit_id'),
    createdBy: uuid('created_by').references(() => teammate.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('directory_region_rule_attr_value_unique').on(t.attribute, t.matchValue)],
)

export const regionLeader = pgTable('region_leader', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  // The leader's Entra oid — the manager-chain match key (the /manager hop returns the
  // manager's id). Active oid is partial-unique in the migration (Drizzle can't render
  // WHERE-indexed uniques). leaderEmail is display/admin only.
  leaderOid: text('leader_oid').notNull(),
  leaderEmail: text('leader_email').notNull(),
  kind: text('kind').notNull().default('region-svp'),
  displayName: text('display_name'),
  addedBy: uuid('added_by').references(() => teammate.id),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => teammate.id),
})

export const teammateIdentityMap = pgTable('teammate_identity_map', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id, { onDelete: 'cascade' }),
  system: text('system').notNull(),
  identifier: text('identifier').notNull(),
  identifierKind: text('identifier_kind').notNull(),
  isCanonical: boolean('is_canonical').notNull().default(false),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  // Directory-sourced identity columns (mig 0038). github_login is the billing-join
  // key; enterprise_slug qualifies it so one login can recur across enterprises.
  // See docs/design/reconciliation-engine.md §7.3.
  githubLogin: text('github_login'),
  enterpriseSlug: text('enterprise_slug'),
  licenseOrg: text('license_org'),
  ssoEmail: text('sso_email'),
  billingRelationship: text('billing_relationship').notNull().default('indicative'), // 'enterprise-reconciled' | 'indicative'
  metadata: jsonb('metadata'),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  // ── Subscription facts (mig 0119) ─────────────────────────────────────────
  // EXACTLY ONE of these three does work. `isEnterprise` puts this address into
  // the teammate's enterprise address set, so emissions under it stamp
  // `provider-billed`; the other two are display + migration planning.
  //
  // FUTURE WRITES ONLY. Setting `isEnterprise` never re-stamps an existing
  // attribution_record — the stamp is immutable with no exceptions (design §3).
  // The unrepaired window costs a bounded §A overstatement (showback, never
  // money) and is loud, because the teammate's shown usage roughly doubles.
  isEnterprise: boolean('is_enterprise').notNull().default(false),
  // Display only (e.g. 'Max 20'). Never decides a lane.
  subscriptionType: text('subscription_type'),
  // Display + migration planning. A self-billed Claude session's emitted
  // cost_usd IS the equivalent usage-based cost, so this compares a plan's
  // monthly price against what enterprise would have charged for the same work.
  monthlyCostUsd: numeric('monthly_cost_usd', { precision: 10, scale: 2 }),
}, (t) => [
  // Authoritative key is (system, COALESCE(enterprise_slug,''), lower(identifier))
  // in 0038 — case-insensitive per 0012 (anti-claim-jacking), enterprise-qualified.
  // Drizzle can't express COALESCE/lower(); this def is approximate — 0038 wins.
  uniqueIndex('teammate_identity_map_identity_unique').on(t.system, t.enterpriseSlug, t.identifier),
])
