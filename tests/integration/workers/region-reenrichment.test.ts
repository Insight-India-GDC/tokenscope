// @vitest-environment node
/*
 * region-reenrichment — re-derives bill teammates on a holding node into their real region
 * (mig 0068). Validates the heal/backfill move AND the revoke-safety gate (a teammate with
 * a live emit instance is NEVER moved by the worker).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'
import { runRegionReenrichment } from '../../../server/workers/region-reenrichment'
import { _resetGraphTokenCache, GraphHttpError, type DirectoryUser } from '../../../server/azure/directory'

// A switchable fault in the holding-node lookup — a NON-Graph failure inside the
// worker's own path. Off, it is the real function.
const placementHomeFault = vi.hoisted(() => ({ fail: false }))
vi.mock('../../../server/auth/placement-home', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/auth/placement-home')>()
  return {
    ...real,
    unplacedOrgUnitIdForRegion: async (...args: Parameters<typeof real.unplacedOrgUnitIdForRegion>) => {
      if (placementHomeFault.fail) throw new Error('placement: holding-node lookup failed')
      return real.unplacedOrgUnitIdForRegion(...args)
    },
  }
})

let t: TestDb
let emeaId = ''

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'emea', 'EMEA')`
  const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='emea'`
  emeaId = rg!.id
  await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id)
    VALUES ('department', 'exact', 'emea data & ai', 'EMEA Data & AI', ${emeaId})`
})
afterAll(async () => { await stopTestDb(t) })

const enrich = (department: string | null) =>
  async (email: string): Promise<DirectoryUser> => ({
    oid: `oid-${email}`, email, displayName: 'D', department, jobTitle: null, costCenter: null, division: null,
  })

const regionCodeOf = async (tmId: string) => {
  const [tm] = await t.client<{ code: string }[]>`
    SELECT rg.code FROM teammate t JOIN region rg ON rg.id = t.region_id WHERE t.id = ${tmId}::uuid`
  return tm!.code
}

describe('runRegionReenrichment', () => {
  it('moves a never-logged-in bill teammate from global __unassigned__ to its department region', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'reenrich1@example.com', displayName: null, orgUnitId: globalUnplaced })
    expect(await regionCodeOf(tmId)).toBe('__unassigned__')

    const r = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    expect(r.rehomed).toBeGreaterThanOrEqual(1)
    expect(await regionCodeOf(tmId)).toBe('emea')

    // Idempotent: a second run sees it already correct, no move.
    const r2 = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    expect(r2.rehomed).toBe(0)
    expect(r2.alreadyCorrect).toBeGreaterThanOrEqual(1)
  })

  it('does NOT move a teammate with a live emit instance (revoke-safety gate)', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'reenrich2@example.com', displayName: null, orgUnitId: globalUnplaced })
    // Live instance (ts_actual_end NULL) → not rehome-safe. An attested instance must
    // carry a project (instance_attestation_attested_has_project), so stamp a hash.
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      SELECT gen_random_uuid(), 'oid-live', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-test', 'TEST'
      FROM teammate t WHERE t.id = ${tmId}::uuid`

    const r = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    // It must not even be considered as a candidate.
    expect(await regionCodeOf(tmId)).toBe('__unassigned__')
    void r
  })

  it('a stale manager-chain UNIT placement (chain no longer resolves) is de-placed to global + provenance cleared', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
      VALUES (${emeaId}::uuid, 'emea_prac'::ltree, 'emea-prac', 'EMEA Practice', 'practice', true, 'CC-EMEA-1')`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-prac'`
    const tmId = await store.createBillTeammate({ email: 'stale@example.com', displayName: null, orgUnitId: u!.id })
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'gone-owner' }) // was chain-placed

    // Chain no longer resolves (no manager, department doesn't map) → de-place.
    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({ oid: 'stale-oid', email, displayName: 'S', department: 'Services', jobTitle: null, costCenter: null, division: null }),
      getManager: async () => null,
    })
    expect(r.rehomed).toBeGreaterThanOrEqual(1)
    const [tm] = await t.client<{ ou_code: string; region: string; via: string | null }[]>`
      SELECT ou.code AS ou_code, rg.code AS region, t.metadata->>'placedVia' AS via
      FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id JOIN region rg ON rg.id=t.region_id WHERE t.id=${tmId}::uuid`
    expect(tm!.ou_code).toBe('__UNPLACED__') // de-placed off the stale unit
    expect(tm!.region).toBe('__unassigned__')
    expect(tm!.via).toBeNull() // provenance cleared
  })

  /*
   * C3 — the placement worklist's Department/Company columns are fed from a
   * snapshot captured HERE, from the directory record this worker already
   * fetched. Two properties matter and both are asserted:
   *   1. the snapshot lands even when the derivation resolves NOTHING — those
   *      are precisely the people an admin has to place by hand, so they are the
   *      ones who most need to be clusterable;
   *   2. it merges, never replaces: the placement provenance lives in the same
   *      jsonb column and the two writers must not erase each other.
   */
  it('captures the directory department/company onto the teammate, without clobbering provenance', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'snap@example.com', displayName: null, orgUnitId: globalUnplaced })
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'keep-me' })

    await runRegionReenrichment(t.db, {
      // An UNMAPPED department, so the derivation resolves nothing and the row is
      // left on the holding node — the hand-placement case.
      lookupDirectory: async (email) => ({
        oid: 'snap-oid', email, displayName: 'S', department: 'Sales-Solution Sales Management',
        companyName: 'Insight EMEA', jobTitle: null, costCenter: null, division: null,
      }),
      getManager: async () => null,
    })

    const [tm] = await t.client<{ dept: string | null; company: string | null; captured: string | null }[]>`
      SELECT metadata->'directory'->>'department'  AS dept,
             metadata->'directory'->>'companyName' AS company,
             metadata->'directory'->>'capturedAt'  AS captured
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.dept).toBe('Sales-Solution Sales Management')
    expect(tm!.company).toBe('Insight EMEA')
    expect(tm!.captured).not.toBeNull() // a snapshot that cannot be dated cannot be judged stale
  })

  it('a directory record MISSING an attribute still writes the snapshot, with NULL for the absent one', async () => {
    /*
     * drizzle's sql`` OMITS an `undefined` binding rather than binding NULL, so a
     * DirectoryUser built without `companyName` rendered `'companyName', ::text`
     * and PostgreSQL rejected the whole statement — taking department with it.
     * The write is fenced, so the only symptom was a silently absent snapshot.
     * This is the case that pins the coercion.
     */
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'partial@example.com', displayName: null, orgUnitId: globalUnplaced })

    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({
        oid: 'partial-oid', email, displayName: 'P', department: 'Delivery',
        jobTitle: null, costCenter: null, division: null,
      } as unknown as DirectoryUser), // no companyName key at all
      getManager: async () => null,
    })
    expect(r.snapshotErrors).toBe(0)

    const [tm] = await t.client<{ dept: string | null; company: string | null; has: boolean }[]>`
      SELECT metadata->'directory'->>'department'  AS dept,
             metadata->'directory'->>'companyName' AS company,
             (metadata ? 'directory')              AS has
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.has).toBe(true)
    expect(tm!.dept).toBe('Delivery')
    expect(tm!.company).toBeNull()
  })

  it('MERGES into metadata.directory — a capture never erases a field already under that key', async () => {
    /*
     * `metadata || jsonb_build_object('directory', {...})` merges at the TOP
     * level only: it protects the placement provenance (a sibling KEY) while
     * replacing everything under `directory` wholesale. Today's writer happens to
     * supply every field it knows about, so the loss is invisible — right up
     * until any other field lives there, and then one capture deletes it with no
     * error and no trace.
     */
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'merge@example.com', displayName: null, orgUnitId: globalUnplaced })
    await t.client`
      UPDATE teammate
      SET metadata = jsonb_build_object('directory', jsonb_build_object(
            'department', 'Stale Dept', 'writtenByAnotherLane', 'keep-me'))
      WHERE id = ${tmId}::uuid`

    await store.captureDirectorySnapshot(tmId, { department: 'Fresh Dept', companyName: 'Insight X' })

    const [tm] = await t.client<{ dept: string | null; other: string | null; company: string | null }[]>`
      SELECT metadata->'directory'->>'department'            AS dept,
             metadata->'directory'->>'writtenByAnotherLane'  AS other,
             metadata->'directory'->>'companyName'           AS company
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.dept).toBe('Fresh Dept') // the captured fields DO win
    expect(tm!.company).toBe('Insight X')
    expect(tm!.other).toBe('keep-me') // …and nothing else under the key is lost
  })

  it('a SECOND holding node, under a different code, is still a holding node to this worker', async () => {
    /*
     * The worklist, the region's unplaced count and the RLS clamp all classify a
     * holding node by unit_type — "a holding node is defined by BEING one, and a
     * tenant that mints a second one under a different code must still be
     * recognised as not a real placement". This worker classified by CODE, so the
     * same person appeared in the admin's unplaced worklist and was invisible to
     * the re-derivation meant to place them: one population, two definitions.
     */
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_hold2'::ltree, 'emea-holding-2', 'Unplaced (second)', 'holding', false)`
    const [second] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-holding-2'`
    const tmId = await store.createBillTeammate({ email: 'second-holding@example.com', displayName: null, orgUnitId: second!.id })

    await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })

    // Considered, re-derived, and moved off the second holding node onto the
    // region's canonical one. Keyed on the code, it was never even a candidate.
    const [tm] = await t.client<{ code: string }[]>`
      SELECT ou.code FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id WHERE t.id = ${tmId}::uuid`
    expect(tm!.code).toBe('__UNPLACED__')
  })

  /*
   * A RULE placement is a DERIVED placement, so it must keep following the rule.
   * The candidate arm reads every kind in DERIVED_PLACEMENT_VIAS for exactly this
   * reason: keyed on 'manager-chain' alone, a teammate the mig-0112 unit rule
   * placed would be frozen in whichever unit the rule named on the day they were
   * provisioned, and re-pointing the rule would move nobody who already exists —
   * which is the defect C7 exists to close, reappearing one rule kind later.
   */
  it('re-derives a RULE-placed teammate when the rule is re-pointed', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_ruleold'::ltree, 'emea-rule-old', 'EMEA Rule Old', 'practice', true),
             (${emeaId}::uuid, 'emea_rulenew'::ltree, 'emea-rule-new', 'EMEA Rule New', 'practice', true)`
    const [oldU] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-rule-old'`
    const [newU] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-rule-new'`
    const tmId = await store.createBillTeammate({ email: 'ruled@example.com', displayName: null, orgUnitId: oldU!.id })
    await store.setPlacementProvenance(tmId, { via: 'attribute-rule', attribute: 'department' })

    // The rule now names a DIFFERENT cost centre.
    await t.client`INSERT INTO directory_region_rule
        (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id)
      VALUES ('department', 'exact', 'ruled practice', 'Ruled Practice', ${emeaId}::uuid, ${newU!.id}::uuid)`

    await runRegionReenrichment(t.db, {
      lookupDirectory: enrich('Ruled Practice'),
      getManager: async () => null,
    })
    const [tm] = await t.client<{ code: string; via: string | null; attr: string | null }[]>`
      SELECT ou.code, t.metadata->>'placedVia' AS via, t.metadata->>'placedAttribute' AS attr
      FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id WHERE t.id = ${tmId}::uuid`
    expect(tm!.code).toBe('emea-rule-new')
    expect(tm!.via).toBe('attribute-rule')
    expect(tm!.attr).toBe('department')

    await t.client`DELETE FROM directory_region_rule WHERE match_value = 'ruled practice'`
    await t.client`DELETE FROM teammate WHERE id = ${tmId}::uuid`
  })

  it('a placeholder in its region rule\'s region whose chain reaches another region\'s leader moves to that region', async () => {
    await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'zz-led', 'ZZ Led') ON CONFLICT (code) DO NOTHING`
    const [apac] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='zz-led'`
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email)
      VALUES (${apac!.id}::uuid, 'oid-apac-leader', 'apac-leader@example.com')`
    const store = makePlacementStore(t.db)
    const tm = await store.createBillTeammate({
      email: 'ruled-but-led@example.com', displayName: null,
      orgUnitId: await store.unplacedOrgUnitIdForRegion(emeaId),
    })
    await runRegionReenrichment(t.db, {
      lookupDirectory: enrich('EMEA Data & AI'),
      getManager: async (oid) => (oid === 'oid-ruled-but-led@example.com' ? { oid: 'oid-apac-leader', email: null } : null),
    })
    expect(await regionCodeOf(tm)).toBe('zz-led')
    await t.client`DELETE FROM region_leader WHERE leader_oid = 'oid-apac-leader'`
  })

  it('an admin move clears provenance → re-enrichment does NOT revert it (admin authority wins)', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
      VALUES (${emeaId}::uuid, 'emea_prac2'::ltree, 'emea-prac2', 'EMEA Practice 2', 'practice', true, 'CC-EMEA-2')`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-prac2'`
    const tmId = await store.createBillTeammate({ email: 'pinned@example.com', displayName: null, orgUnitId: u!.id })
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'someowner' })
    // The admin-move endpoints now strip the provenance (that is the fix); replicate it.
    await t.client`UPDATE teammate SET metadata = (coalesce(metadata,'{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAttribute' - 'placedAt') WHERE id=${tmId}::uuid`

    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({ oid: 'pinned-oid', email, displayName: 'P', department: 'Services', jobTitle: null, costCenter: null, division: null }),
      getManager: async () => null,
    })
    // No provenance + on a real (non-holding) unit → NOT a re-enrichment candidate → unchanged.
    const [tm] = await t.client<{ code: string }[]>`SELECT ou.code FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id WHERE t.id=${tmId}::uuid`
    expect(tm!.code).toBe('emea-prac2')
    void r
  })

  /*
   * THE BATCHING CURSOR. The candidate query is `ORDER BY last_sync_at NULLS
   * FIRST LIMIT n`, and only the MOVE branch stamped last_sync_at — so a row that
   * could not move kept its old timestamp and re-occupied the head of the window
   * on every subsequent pass. Past `limit` such rows, no other candidate was ever
   * read. Stamping every row the pass LOOKED AT is what advances it.
   *
   * Deterministic by construction: every other teammate is stamped `now()` first,
   * then the two rows under test are given distinct, older timestamps — so the
   * order the worker reads them in is a fact, not a heap-order accident.
   */
  it('a pass over rows that cannot move still advances the cursor — the next pass reads DIFFERENT candidates', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    await t.client`UPDATE teammate SET last_sync_at = now()`
    const aId = await store.createBillTeammate({ email: 'jam-a@example.com', displayName: null, orgUnitId: globalUnplaced })
    const bId = await store.createBillTeammate({ email: 'jam-b@example.com', displayName: null, orgUnitId: globalUnplaced })
    await t.client`UPDATE teammate SET last_sync_at = now() - interval '2 hours' WHERE id = ${aId}::uuid`
    await t.client`UPDATE teammate SET last_sync_at = now() - interval '1 hour'  WHERE id = ${bId}::uuid`

    // Unmovable: no directory match at all → the `unresolved` exit, which writes
    // nothing about the teammate. It is the cheapest of the three non-move exits
    // and the one an unplaceable person hits every tick, for ever.
    const seen: string[] = []
    const unresolvable = async (email: string) => {
      seen.push(email)
      return null
    }

    await runRegionReenrichment(t.db, { lookupDirectory: unresolvable, getManager: async () => null, limit: 1 })
    expect(seen).toEqual(['jam-a@example.com'])

    const second = await runRegionReenrichment(t.db, { lookupDirectory: unresolvable, getManager: async () => null, limit: 1 })
    expect(second.unresolved).toBe(1)
    // The second pass must reach the row BEHIND the one it could not move.
    expect(seen).toEqual(['jam-a@example.com', 'jam-b@example.com'])
  })
})

/*
 * Scaling plan Phase 1 item 3: a Graph failure is a SKIP (never placed, never
 * stamped), the write is compare-and-set against what changed during the awaits,
 * stamps land per person as each finishes, and no new person starts after the
 * budget. Each test puts its own rows at the head of `ORDER BY last_sync_at NULLS
 * FIRST` (every other row stamped now(), its own given older, distinct stamps) and
 * limits the pass to them, so earlier tests' rows cannot interfere.
 */
describe('runRegionReenrichment — Graph failure, compare-and-set, deadline', () => {
  async function atHead(ids: string[]): Promise<void> {
    await t.client`UPDATE teammate SET last_sync_at = now()`
    for (const [i, id] of ids.entries()) {
      await t.client`UPDATE teammate SET last_sync_at = now() - make_interval(hours => ${ids.length + 10 - i})
        WHERE id = ${id}::uuid`
    }
  }
  const syncedAt = async (id: string) => {
    const [r] = await t.client<{ s: string }[]>`SELECT last_sync_at::text AS s FROM teammate WHERE id = ${id}::uuid`
    return r!.s
  }
  const unitOf = async (id: string) => {
    const [r] = await t.client<{ id: string }[]>`SELECT org_unit_id::text AS id FROM teammate WHERE id = ${id}::uuid`
    return r!.id
  }
  const signIn = (id: string) => t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    SELECT gen_random_uuid(), 'oid-live', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-test', 'TEST'
    FROM teammate t WHERE t.id = ${id}::uuid`
  const dirFor = (email: string, department: string | null): DirectoryUser =>
    ({ oid: `oid-${email}`, email, displayName: 'D', department, jobTitle: null, costCenter: null, division: null }) as DirectoryUser

  it('a TRANSIENT lookup or manager-chain THROW skips that person — not placed, not stamped — and the next is still processed', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const a = await store.createBillTeammate({ email: 'g-throttled@example.com', displayName: null, orgUnitId: global })
    const b = await store.createBillTeammate({ email: 'g-chainfail@example.com', displayName: null, orgUnitId: global })
    const c = await store.createBillTeammate({ email: 'g-fine@example.com', displayName: null, orgUnitId: global })
    await atHead([a, b, c])
    const [aBefore, bBefore] = [await syncedAt(a), await syncedAt(b)]
    // A region leader exists, so an unmapped department walks the manager chain.
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email)
      VALUES (${emeaId}::uuid, 'oid-some-leader', 'leader@example.com')`

    const r = await runRegionReenrichment(t.db, {
      limit: 3,
      lookupDirectory: async (email) => {
        if (email === 'g-throttled@example.com') throw new GraphHttpError(429, '/users')
        if (email === 'g-chainfail@example.com') return dirFor(email, 'Unmapped Dept')
        return dirFor(email, 'EMEA Data & AI')
      },
      getManager: async (oid) => {
        if (oid === 'oid-g-chainfail@example.com') throw new GraphHttpError(503, '/users/x/manager')
        return null
      },
    })

    expect(r.errors).toBe(2)
    expect(await unitOf(a)).toBe(global)
    expect(await unitOf(b)).toBe(global)
    expect(await syncedAt(a)).toBe(aBefore) // not stamped → retried at the head next run
    expect(await syncedAt(b)).toBe(bBefore)
    expect(await regionCodeOf(c)).toBe('emea') // the next person still processed
    await t.client`DELETE FROM region_leader WHERE leader_oid = 'oid-some-leader'`
  })

  it('a NON-transient failure (the holding-node lookup throwing) is stamped, so it cannot pin the head of the queue', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const tm = await store.createBillTeammate({ email: 'g-permanent@example.com', displayName: null, orgUnitId: global })
    await atHead([tm])
    const before = await syncedAt(tm)

    placementHomeFault.fail = true
    let r
    try {
      r = await runRegionReenrichment(t.db, {
        limit: 1,
        lookupDirectory: async (email) => dirFor(email, 'EMEA Data & AI'),
        getManager: async () => null,
      })
    } finally {
      placementHomeFault.fail = false
    }
    expect(r.errors).toBe(1)
    expect(await unitOf(tm)).toBe(global)
    expect(await syncedAt(tm)).not.toBe(before)
  })

  it('DEFAULT wiring: a throttled real-Graph lookup is an error, not "unresolved" — nothing placed, nothing stamped', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const tm = await store.createBillTeammate({ email: 'g-default@example.com', displayName: null, orgUnitId: global })
    await atHead([tm])
    const before = await syncedAt(tm)
    const env = {
      NUXT_GRAPH_DIRECTORY_MODE: 'graph',
      NUXT_GRAPH_BASE_URL: 'https://graph.example.test/v1.0',
      NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID: 'cid',
      NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET: 'secret',
      NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL: 'https://login.example.test/token',
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    _resetGraphTokenCache()
    let graphCalls = 0
    vi.stubGlobal('fetch', async (input: string) => {
      if (String(input).startsWith(env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL)) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      graphCalls += 1
      return new Response(null, { status: 429, headers: { 'retry-after': '0' } })
    })
    let r
    try {
      r = await runRegionReenrichment(t.db, { limit: 1 })
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      _resetGraphTokenCache()
    }
    expect(r.errors).toBe(1)
    expect(r.unresolved).toBe(0)
    expect(graphCalls).toBe(3) // the worker transport: one attempt + 2 retries
    expect(await unitOf(tm)).toBe(global)
    expect(await syncedAt(tm)).toBe(before)
  })

  it('a person who SIGNS IN while the pass awaits Graph is refused and not moved, but stamped so a repeat refusal cannot pin the queue', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const tm = await store.createBillTeammate({ email: 'cas-signin@example.com', displayName: null, orgUnitId: global })
    await atHead([tm])
    const before = await syncedAt(tm)

    const r = await runRegionReenrichment(t.db, {
      limit: 1,
      lookupDirectory: async (email) => {
        await signIn(tm) // the race: a credential lands between selection and write
        return dirFor(email, 'EMEA Data & AI')
      },
      getManager: async () => null,
    })
    expect(r.casRefused).toBe(1)
    expect(r.rehomed).toBe(0)
    expect(await unitOf(tm)).toBe(global)
    expect(await syncedAt(tm)).not.toBe(before)
  })

  it('a person an admin MOVES BY HAND while the pass awaits Graph is refused — the admin placement stands', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_handpick'::ltree, 'emea-handpick', 'EMEA Hand Pick', 'practice', true)`
    const [hand] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-handpick'`
    const tm = await store.createBillTeammate({ email: 'cas-hand@example.com', displayName: null, orgUnitId: global })
    await atHead([tm])

    const r = await runRegionReenrichment(t.db, {
      limit: 1,
      lookupDirectory: async (email) => {
        await t.client`UPDATE teammate SET org_unit_id = ${hand!.id}::uuid WHERE id = ${tm}::uuid`
        return dirFor(email, 'EMEA Data & AI')
      },
      getManager: async () => null,
    })
    expect(r.casRefused).toBe(1)
    expect(await unitOf(tm)).toBe(hand!.id)
  })

  it('a rule TARGET retired while the pass awaits Graph is refused', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_doomed'::ltree, 'emea-doomed', 'EMEA Doomed', 'practice', true)`
    const [doomed] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-doomed'`
    await t.client`INSERT INTO directory_region_rule
        (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id)
      VALUES ('department', 'exact', 'doomed practice', 'Doomed Practice', ${emeaId}::uuid, ${doomed!.id}::uuid)`
    const tm = await store.createBillTeammate({ email: 'cas-retired@example.com', displayName: null, orgUnitId: global })
    await atHead([tm])

    const r = await runRegionReenrichment(t.db, {
      limit: 1,
      lookupDirectory: async (email) => {
        await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${doomed!.id}::uuid`
        return dirFor(email, 'Doomed Practice')
      },
      getManager: async () => null,
    })
    expect(r.casRefused).toBe(1)
    expect(await unitOf(tm)).toBe(global)
    await t.client`DELETE FROM directory_region_rule WHERE match_value = 'doomed practice'`
  })

  it('the PROVENANCE-ONLY branch goes through the same re-check: a sign-in during the await leaves provenance untouched', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_same'::ltree, 'emea-same', 'EMEA Same', 'practice', true)`
    const [same] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-same'`
    await t.client`INSERT INTO directory_region_rule
        (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id)
      VALUES ('department', 'exact', 'same practice', 'Same Practice', ${emeaId}::uuid, ${same!.id}::uuid)`
    const tm = await store.createBillTeammate({ email: 'cas-prov@example.com', displayName: null, orgUnitId: same!.id })
    // Placed here by a rule on a different attribute than today's derivation matches.
    await store.setPlacementProvenance(tm, { via: 'attribute-rule', attribute: 'companyName' })
    await atHead([tm])

    const r = await runRegionReenrichment(t.db, {
      limit: 1,
      lookupDirectory: async (email) => {
        await signIn(tm)
        return dirFor(email, 'Same Practice')
      },
      getManager: async () => null,
    })
    expect(r.casRefused).toBe(1)
    expect(r.alreadyCorrect).toBe(0)
    const [m] = await t.client<{ attr: string | null }[]>`
      SELECT metadata->>'placedAttribute' AS attr FROM teammate WHERE id = ${tm}::uuid`
    expect(m!.attr).toBe('companyName')
    await t.client`DELETE FROM directory_region_rule WHERE match_value = 'same practice'`
  })

  it('stops starting people at the budget; the ones it finished are stamped as they finished, the rest are not', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const ids = [
      await store.createBillTeammate({ email: 'dl-1@example.com', displayName: null, orgUnitId: global }),
      await store.createBillTeammate({ email: 'dl-2@example.com', displayName: null, orgUnitId: global }),
      await store.createBillTeammate({ email: 'dl-3@example.com', displayName: null, orgUnitId: global }),
    ]
    await atHead(ids)
    const thirdBefore = await syncedAt(ids[2]!)

    // A fake clock: every directory call costs 100 s of the 150 s budget. Person
    // one starts at 0, person two at 100 s, person three would start at 200 s.
    let clock = 0
    const seen: string[] = []
    const r = await runRegionReenrichment(t.db, {
      limit: 3,
      now: () => clock,
      lookupDirectory: async (email) => {
        seen.push(email)
        clock += 100_000
        return null // legitimately unresolved → stamped
      },
      getManager: async () => null,
    })
    expect(seen).toEqual(['dl-1@example.com', 'dl-2@example.com'])
    expect(r.deadlineHit).toBe(true)
    expect(r.unresolved).toBe(2)
    const stamped = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate
      WHERE id IN (${ids[0]!}::uuid, ${ids[1]!}::uuid) AND last_sync_at > now() - interval '1 minute'`
    expect(stamped).toHaveLength(2)
    expect(await syncedAt(ids[2]!)).toBe(thirdBefore)
  })
})
