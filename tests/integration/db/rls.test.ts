/*
 * RLS — region + org-path scoping enforce visibility on attribution_record
 * + project; admin/global-finops bypass.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 testing: "RLS scope enforcement".
 *
 * Critical PostgreSQL behaviour: RLS policies don't apply to the table's
 * OWNER by default — we explicitly create a non-owner role inside the
 * test and run scoped queries as that role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let scopedClient: ReturnType<typeof postgres>
let scopedDb: PostgresJsDatabase<typeof schema>

beforeAll(async () => {
  t = await startTestDb()

  // Create a non-owner role so RLS actually applies. Roles are CLUSTER-global
  // (not per-database): on a fresh testcontainer they never pre-exist, but on
  // a shared TEST_PG_URL server they survive between runs — tolerate that.
  await t.client.unsafe(`
    DO $$ BEGIN
      CREATE ROLE tokenscope_app NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT USAGE ON SCHEMA public TO tokenscope_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tokenscope_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tokenscope_app;
    DO $$ BEGIN
      CREATE USER tokenscope_login WITH LOGIN PASSWORD 'app';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT tokenscope_app TO tokenscope_login;
  `)

  const url = new URL(t.url)
  url.username = 'tokenscope_login'
  url.password = 'app'
  scopedClient = postgres(url.toString(), { max: 2, idle_timeout: 5 })
  scopedDb = drizzle(scopedClient, { schema })

  // ── Two regions, two org units, two teammates, two projects, two records ──
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC'),
      ('22222222-2222-2222-2222-222222222222', 'emea', 'EMEA');

    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
       'apac.services'::ltree, 'apac-services', 'APAC Services', 'bu'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222',
       'emea.services'::ltree, 'emea-services', 'EMEA Services', 'bu');

    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'oid-apac', 'apac@example.com',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'oid-emea', 'emea@example.com',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id) VALUES
      ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'APAC-PRJ', 'h1', 'APAC Project', 'billable',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'EMEA-PRJ', 'h2', 'EMEA Project', 'billable',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO instance_attestation (
      instance_id, principal_oid, teammate_id, project_code_hash, tool,
      session_token_hash, region_id, org_unit_id, cost_owning_unit_id
    ) VALUES
      ('00000000-0000-0000-0000-000000000001', 'oid-apac',
       'cccccccc-cccc-cccc-cccc-cccccccccccc', 'h1', 'claude-code', 'tok-1',
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ('00000000-0000-0000-0000-000000000002', 'oid-emea',
       'dddddddd-dddd-dddd-dddd-dddddddddddd', 'h2', 'claude-code', 'tok-2',
       '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    INSERT INTO attribution_record (
      instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
      tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version,
      fidelity_tier, cost_basis, ts_event
    ) VALUES
      ('00000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'claude-code', 'claude-sonnet', 'output', 100, 1.50,
       gen_random_uuid(), 1, 'tier-1', 'measured', NOW()),
      ('00000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
       'ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222',
       'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
       'claude-code', 'claude-sonnet', 'output', 200, 3.00,
       gen_random_uuid(), 1, 'tier-1', 'measured', NOW());
  `)
}, 180_000)

afterAll(async () => {
  await scopedClient.end({ timeout: 5 })
  await stopTestDb(t)
}, 30_000)

describe('RLS — region + org_unit scope on attribution_record', () => {
  it('an APAC developer sees only APAC attribution rows', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'developer',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('an EMEA developer sees only EMEA attribution rows', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '22222222-2222-2222-2222-222222222222',
        userOrgPath: 'emea.services',
        userRole: 'developer',
        userTeammateId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('22222222-2222-2222-2222-222222222222')
  })

  it('global-finops sees both regions', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'global-finops',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(2)
  })

  // S11 (b): `admin` is a REGION-scoped role (rbac.ts:44, requireRegionScope) —
  // migration 0098 converges the region/org bypass disjuncts from
  // `IN ('global-finops', 'admin')` to `IN ('global-finops', 'platform-admin')`.
  // This assertion previously read "admin sees both regions", which certified
  // the BUG (a region admin bypassing every other region) rather than the
  // intended contract. Corrected here in lockstep with the migration that
  // fixes it — see the migration header for why that pairing matters.
  it('admin (region-scoped) sees only their own region — not a cross-region bypass', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'admin',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM attribution_record`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  // S11 (a): the tests above connect as a NON-OWNER role specifically so the
  // policies execute — but production does not have that role. The app
  // connects to Postgres as the table OWNER (infra/modules/keyvault-secrets.bicep
  // administratorLogin), and a table owner bypasses RLS entirely unless FORCE ROW
  // LEVEL SECURITY is set (it deliberately is not — see 0098's migration header).
  // Without this case, CI certifies a control production does not have: every
  // test above could pass while the real deployed app enforces nothing.
  it('the OWNER connection bypasses RLS entirely — matches production topology', async () => {
    const rows = await t.client<{ region_id: string }[]>`
      SELECT region_id::text FROM attribution_record
    `
    expect(rows.length).toBe(2) // both regions — the owner sees everything above
  })
})

describe('applyRlsContext — single-statement GUC installation (request-floor-performance.md F1)', () => {
  it('all four GUCs read back via current_setting inside the tx, and are gone after it', async () => {
    const ctx = {
      userRegionId: '11111111-1111-1111-1111-111111111111',
      userOrgPath: 'apac.services',
      userRole: 'developer' as const,
      userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    }
    const inside = await withRlsContext(scopedDb, ctx, async (tx) =>
      tx.execute(sql`SELECT
        current_setting('app.user_region_id', true)   AS user_region_id,
        current_setting('app.user_org_path', true)    AS user_org_path,
        current_setting('app.user_role', true)        AS user_role,
        current_setting('app.user_teammate_id', true) AS user_teammate_id`),
    )
    expect(inside[0]).toEqual({
      user_region_id: ctx.userRegionId,
      user_org_path: ctx.userOrgPath,
      user_role: ctx.userRole,
      user_teammate_id: ctx.userTeammateId,
    })

    // `true` (transaction-local) scoping: outside the tx none of the values
    // survive — a later checkout must never inherit an identity.
    const after = await scopedDb.execute(sql`SELECT
      current_setting('app.user_region_id', true)   AS user_region_id,
      current_setting('app.user_teammate_id', true) AS user_teammate_id`)
    expect([null, '']).toContain(after[0]!.user_region_id)
    expect([null, '']).toContain(after[0]!.user_teammate_id)
  })
})

describe('RLS — org_unit (S11 c): mirrors orgSubtreeScopePredicate(), recursion-safe', () => {
  it('admin (region-scoped) sees only org_unit rows in their own region', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'admin',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM org_unit`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('global-finops sees org_unit rows in both regions', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'global-finops',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM org_unit`),
    )
    expect(rows.length).toBe(2)
  })

  // THE RECURSION HAZARD the story calls out explicitly: placed_below_region_root()
  // queries org_unit FROM INSIDE org_unit's own policy. If that function were not
  // SECURITY DEFINER, Postgres would raise "infinite recursion detected in policy
  // for relation org_unit" the moment a non-owner role queries this table with a
  // non-admin, non-global-finops role (the only arm that calls the function). The
  // fixture's org_unit rows have parent_id = NULL (they ARE the region root), so
  // placed_below_region_root() correctly returns false and this developer sees
  // zero rows — the assertion that matters is that the query does not throw.
  it('does not recurse for a developer/manager role (the arm that calls placed_below_region_root())', async () => {
    await expect(
      withRlsContext(
        scopedDb,
        {
          userRegionId: '11111111-1111-1111-1111-111111111111',
          userOrgPath: 'apac.services',
          userRole: 'developer',
          userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        },
        async (tx) => tx.execute(sql`SELECT region_id::text FROM org_unit`),
      ),
    ).resolves.toEqual([])
  })
})

describe('RLS — teammate (S11 c): same role-split contract as org_unit, self always visible', () => {
  it('a caller always sees their own row, even one not "placed below" a genuine leaf', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'developer',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT id::text FROM teammate`),
    )
    expect(rows.map((r) => r.id)).toEqual(['cccccccc-cccc-cccc-cccc-cccccccccccc'])
  })

  it('admin (region-scoped) sees every teammate in their own region, not another', async () => {
    const rows = await withRlsContext(
      scopedDb,
      {
        userRegionId: '11111111-1111-1111-1111-111111111111',
        userOrgPath: 'apac.services',
        userRole: 'admin',
        userTeammateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
      async (tx) => tx.execute(sql`SELECT region_id::text FROM teammate`),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.region_id).toBe('11111111-1111-1111-1111-111111111111')
  })
})

describe('RLS drift guard', () => {
  // Catches the OTHER half of the coverage bug: a table with RLS enabled but NO
  // policy at all denies every row to every non-owner role (silent all-deny),
  // rather than being correctly scoped. rls-policy-coverage.test.ts checks the
  // 'admin' role-list convergence; this checks the structural invariant that
  // makes any policy's role list meaningful in the first place.
  it('every RLS-enabled table has at least one policy', async () => {
    const rows = await t.client<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
      -- 'r' = ordinary table, 'p' = partitioned table (attribution_record, mig
      -- 0055) — RLS + policies live on the partitioned PARENT, not each partition.
      WHERE c.relrowsecurity = true AND c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace
      GROUP BY c.relname
      HAVING COUNT(p.polname) = 0
    `
    expect(rows.map((r) => r.relname)).toEqual([])
  })

  // Fixed list of tables that MUST carry RLS (every table a migration has ever
  // ENABLEd, per drizzle/migrations/*.sql, plus S11's three new ones). A future
  // migration that drops RLS from one of these (e.g. a careless DROP TABLE /
  // recreate, as happened to attribution_record during partitioning) fails this
  // test instead of silently regressing coverage.
  it('every must-be-scoped table still has RLS enabled', async () => {
    const MUST_BE_SCOPED = [
      'attribution_record',
      'attribution_aggregate',
      // session_attestation was renamed to instance_attestation in migration 0019.
      'instance_attestation',
      'allocation',
      'limit_policy',
      'tier_assignment',
      'spill_record',
      'project',
      'repo_project_map',
      'audit_event',
      'inbox_item',
      'usage_signal_record',
      'session_quarantine',
      'session_instance_report',
      'insight_ack',
      'governance_setting',
      'cou_owner',
      'unaccounted_usage',
      'report_access_grant',
      'directory_exclusion_pattern',
      'over_emission',
      'org_unit',
      'teammate',
      'oauth_token',
    ]
    const rows = await t.client<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname = ANY(${MUST_BE_SCOPED}) AND relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace
    `
    const byName = new Map(rows.map((r) => [r.relname, r.relrowsecurity]))
    for (const name of MUST_BE_SCOPED) {
      expect(byName.get(name), `${name} should have RLS enabled`).toBe(true)
    }
    expect(byName.size).toBe(MUST_BE_SCOPED.length)
  })
})
