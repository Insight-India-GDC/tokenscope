// @vitest-environment node
/*
 * drizzle/seed-org-structure.ts builds a region's units only while the region has none besides
 * its `default` unit and its holding node. A region that has been set up is never touched again:
 * a re-run renames nothing, un-retires nothing (the `default` unit included) and, after a code
 * change, duplicates nothing (docs/design/org-setup/01-second-run-fixes.md, item 3).
 *
 * Runs the real script the way the entrypoint does, as a child process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'

const ROOT = resolve(__dirname, '../../..')
let t: TestDb

async function seed(): Promise<void> {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli')
  await promisify(execFile)(process.execPath, [tsx, 'drizzle/seed-org-structure.ts'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: t.url, SEED_ORG_STRUCTURE_IF_OUTDATED: '', SEED_ONLY_REGIONS: '' },
    timeout: 60_000,
  })
}

async function units(region: string) {
  return t.client<{ code: string; display_name: string; retired: boolean; parent: string | null }[]>`
    SELECT ou.code, ou.display_name, ou.retired_at IS NOT NULL AS retired, p.code AS parent
    FROM org_unit ou JOIN region r ON r.id = ou.region_id LEFT JOIN org_unit p ON p.id = ou.parent_id
    WHERE r.code = ${region} ORDER BY ou.code`
}

beforeAll(async () => {
  t = await startTestDb()
  // A region made before the seed ran, holding only its default unit and Unplaced node: still fresh.
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('global-it', 'Global IT') RETURNING id::text AS id`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${r!.id}::uuid, 'global_it', 'default', 'Global IT (default)', 'bu', true)`
  await makePlacementStore(t.db).unplacedOrgUnitIdForRegion(r!.id)
  // Set up by hand before this change: a parentless, non-cost-owning team beside its default.
  const [apac] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('apac', 'APAC') RETURNING id::text AS id`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${apac!.id}::uuid, 'apac', 'default', 'APAC (default)', 'bu', true),
           (${apac!.id}::uuid, 'legacy', 'legacy', 'Legacy team', 'team', false)`
  // A region whose default unit an Admin retired: never seeded under, never un-retired.
  const [emea] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('emea', 'EMEA') RETURNING id::text AS id`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
    VALUES (${emea!.id}::uuid, 'emea', 'default', 'EMEA (default)', 'bu', true, now())`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

describe('seed-org-structure', () => {
  it("builds a fresh region's units under its default unit", async () => {
    await seed()
    const na = await units('north-america')
    expect(na.find((u) => u.code === 'canada')).toMatchObject({ parent: 'default', retired: false })
    expect(na.find((u) => u.code === 'cloud')).toMatchObject({ parent: 'united-states' })
    expect((await units('global-it')).find((u) => u.code === 'global-it')).toMatchObject({ parent: 'default' })
    expect((await units('apac')).map((u) => u.code)).toEqual(['default', 'legacy'])
    expect(await units('emea')).toEqual([{ code: 'default', display_name: 'EMEA (default)', retired: true, parent: null }])
  })

  it('leaves a region that has been set up alone on a re-run', async () => {
    await t.client`UPDATE org_unit SET retired_at = now() WHERE code IN ('cloud', 'field')`
    await t.client`UPDATE org_unit SET display_name = 'Canada (renamed)' WHERE code = 'canada'`
    await t.client`UPDATE org_unit SET code = 'ca' WHERE code = 'canada'`
    const before = { na: await units('north-america'), emea: await units('emea') }

    await seed()

    expect(await units('north-america')).toEqual(before.na)
    expect(await units('emea')).toEqual(before.emea)
    const na = await units('north-america')
    expect(na.filter((u) => u.retired).map((u) => u.code)).toEqual(['cloud', 'field'])
    expect(na.find((u) => u.code === 'ca')!.display_name).toBe('Canada (renamed)')
    expect(na.some((u) => u.code === 'canada')).toBe(false)
  })
})
