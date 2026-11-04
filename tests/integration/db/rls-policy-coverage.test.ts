// @vitest-environment node
/*
 * RLS policy role-list coverage — S11 (b): `admin` is a REGION-scoped role
 * (server/auth/rbac.ts:44, requireRegionScope) and must never appear in an
 * UNSCOPED region/org bypass disjunct — that grants a region admin reach into
 * every OTHER region, which is exactly the bug migration
 * drizzle/migrations/0098_rls_policy_convergence.sql converges away.
 *
 * This asserts against pg_policies (not fixture data — a structural check, no
 * non-owner role needed) that every policy 0098 touched now reads
 * ('global-finops', 'platform-admin') and never a bare 'admin' in that
 * position.
 *
 * Scope note: this checks the EXPLICIT set of policies 0098 converged, not
 * every policy in the schema. Two known, deliberate exclusions:
 *   - session_quarantine_self_scope (0032) legitimately keeps 'admin' in its
 *     OWN region-AND-scoped arm (region_id = ... AND role IN (...)) — that
 *     arm was never the bug; only its separate unconditional bypass arm was,
 *     and that one IS covered below.
 *   (directory_exclusion_pattern_write used to be the second: 0083 admitted a
 *   bare 'admin'. Migration 0167 narrowed it to the Admin scope (#493), so it
 *   is covered below like the others.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

interface PolicyRow {
  tablename: string
  policyname: string
  qual: string | null
  with_check: string | null
}

// [table, policy] pairs migration 0098 converged FROM a bare 'admin' bypass TO
// ('global-finops', 'platform-admin'). Kept in the same order as the migration
// for easy cross-reference.
const CONVERGED_POLICIES: Array<[string, string]> = [
  ['attribution_record', 'attribution_record_region_scope'],
  ['attribution_record', 'attribution_record_org_scope'],
  ['attribution_aggregate', 'attribution_aggregate_admin_only'],
  // session_attestation was renamed to instance_attestation in migration 0019,
  // which also renamed this policy — target the LIVE names.
  ['instance_attestation', 'instance_attestation_region_scope'],
  ['allocation', 'allocation_admin_only'],
  ['limit_policy', 'limit_policy_admin_only'],
  ['tier_assignment', 'tier_assignment_admin_only'],
  ['spill_record', 'spill_record_admin_only'],
  ['project', 'project_region_scope'],
  ['repo_project_map', 'repo_project_map_admin_only'],
  // 0167: company-wide config with no region_id; writes are Admin only (#493).
  ['directory_exclusion_pattern', 'directory_exclusion_pattern_write'],
  ['audit_event', 'audit_event_admin_only'],
  ['inbox_item', 'inbox_item_self'],
  ['insight_ack', 'insight_ack_admin'],
  ['governance_setting', 'governance_setting_write'],
  ['usage_signal_record', 'usage_signal_record_admin'],
  ['unaccounted_usage', 'unaccounted_usage_owner'],
  ['unaccounted_usage', 'unaccounted_usage_org_scope'],
  ['over_emission', 'over_emission_owner'],
  ['over_emission', 'over_emission_org_scope'],
  // 0136 — born converged (never carried the bare-'admin' bypass).
  ['usage_rollup_daily', 'usage_rollup_daily_admin_only'],
]

// session_quarantine_self_scope: 'admin' legitimately remains in the middle
// (region-AND-scoped) arm; only the FINAL unconditional-bypass arm converged.
// Checked separately below with a shape-aware assertion instead of a blanket
// "no 'admin' anywhere" rule, which would false-positive on the legitimate arm.
const PARTIALLY_CONVERGED: [string, string] = ['session_quarantine', 'session_quarantine_self_scope']

async function fetchPolicies(client: TestDb['client'], pairs: Array<[string, string]>): Promise<PolicyRow[]> {
  const tables = [...new Set(pairs.map(([table]) => table))]
  const rows = await client<PolicyRow[]>`
    SELECT tablename, policyname, qual::text AS qual, with_check::text AS with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(${tables})
  `
  return [...rows]
}

describe('RLS policy role-list coverage — no converged policy admits a bare admin bypass', () => {
  it('every converged policy exists and its qual/with_check never contains a bare \'admin\' literal', async () => {
    const rows = await fetchPolicies(t.client, CONVERGED_POLICIES)
    const byKey = new Map(rows.map((r) => [`${r.tablename}.${r.policyname}`, r]))

    const missing: string[] = []
    const stillAdmits: string[] = []
    for (const [table, policy] of CONVERGED_POLICIES) {
      const key = `${table}.${policy}`
      const row = byKey.get(key)
      if (!row) {
        missing.push(key)
        continue
      }
      const text = `${row.qual ?? ''} ${row.with_check ?? ''}`
      if (/'admin'/.test(text)) stillAdmits.push(key)
    }
    expect(missing, `expected policies not found in pg_policies: ${missing.join(', ')}`).toEqual([])
    expect(stillAdmits, `policies still admitting a bare 'admin' bypass: ${stillAdmits.join(', ')}`).toEqual([])

    // Every converged policy DOES still admit 'global-finops' + 'platform-admin'
    // (the correct list) — a policy that lost the bypass entirely would be an
    // over-correction, not the intended fix.
    const wrongList: string[] = []
    for (const [table, policy] of CONVERGED_POLICIES) {
      const row = byKey.get(`${table}.${policy}`)!
      const text = `${row.qual ?? ''} ${row.with_check ?? ''}`
      if (!/global-finops/.test(text) || !/platform-admin/.test(text)) {
        wrongList.push(`${table}.${policy}`)
      }
    }
    expect(wrongList, `policies missing the expected ('global-finops','platform-admin') list: ${wrongList.join(', ')}`).toEqual([])
  })

  it("session_quarantine_self_scope: 'admin' survives only inside the region-AND-scoped arm, not the unconditional bypass", async () => {
    const [table, policy] = PARTIALLY_CONVERGED
    const rows = await fetchPolicies(t.client, [PARTIALLY_CONVERGED])
    const row = rows.find((r) => r.tablename === table && r.policyname === policy)
    expect(row, `${table}.${policy} not found`).toBeTruthy()
    const text = row!.qual ?? ''
    // The legitimate arm: 'admin' appears together with a region_id equality
    // check in the SAME breath (an AND, not a bare OR-bypass). pg_policies
    // renders literals with an explicit ::text cast and no whitespace
    // guarantees, so this matches loosely (dotAll) rather than assuming exact
    // punctuation.
    expect(text).toMatch(/region_id.*current_setting\('app\.user_region_id'.*'admin'/s)

    // The final disjunct (the one that WAS the bug) is the LAST
    // current_setting('app.user_role', ...) comparison in the expression — it
    // must admit 'platform-admin' and must NOT contain a bare 'admin' literal
    // (the exact-quoted substring 'admin' does not match inside
    // 'platform-admin', which has '-' immediately before "admin").
    const roleChecks = text.split("current_setting('app.user_role'")
    expect(roleChecks.length, `expected 2 role checks (region-scoped arm + bypass arm); got: ${text}`).toBe(3)
    const finalArm = roleChecks[roleChecks.length - 1]!
    expect(finalArm, `expected the trailing bypass arm to admit platform-admin; got: ${text}`).toContain("'platform-admin'")
    expect(finalArm).not.toMatch(/'admin'/)
  })

  it('the S11 (c) priority tables (org_unit, teammate, oauth_token) exist, have RLS, and never admit a bare admin bypass', async () => {
    const NEW_POLICIES: Array<[string, string]> = [
      ['org_unit', 'org_unit_scope'],
      ['teammate', 'teammate_scope'],
      ['oauth_token', 'oauth_token_scope'],
    ]
    const rows = await fetchPolicies(t.client, NEW_POLICIES)
    const byKey = new Map(rows.map((r) => [`${r.tablename}.${r.policyname}`, r]))
    for (const [table, policy] of NEW_POLICIES) {
      const row = byKey.get(`${table}.${policy}`)
      expect(row, `${table}.${policy} not found`).toBeTruthy()
      const text = `${row!.qual ?? ''} ${row!.with_check ?? ''}`
      // 'admin' legitimately appears here ONLY inside a region-clamped conjunct
      // (`region_id = ... AND role = 'admin'`), never as a bare disjunct
      // alongside 'global-finops' — assert the specific bug shape is absent:
      // a role list literal containing BOTH 'admin' and 'global-finops'.
      expect(text).not.toMatch(/\(\s*'global-finops'\s*,\s*'admin'\s*\)/)
      expect(text).not.toMatch(/\(\s*'admin'\s*,\s*'global-finops'\s*\)/)
    }
  })
})
