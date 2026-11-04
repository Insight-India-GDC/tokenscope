// @vitest-environment node
/*
 * Residual placement freezes at first write (issue #44).
 *
 * Still the write rule under the current-org lens: the stamps are each row's
 * RECORDED placement, written once and never edited. Reports no longer read
 * them (they group by where the person sits now, mig 0162), so the sections
 * below on the placement correction are history.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `unaccounted_usage` refreshed `region_id` / `org_unit_id` from the teammate's
 * CURRENT placement on every recompute, over a trailing 35-day window. So a
 * residual row followed the person for 35 days and then froze wherever it
 * happened to be when the window rolled past it. `Data-Lineage.md` called that
 * "not any coherent policy", which was exact: the same teammate-day could sit
 * in two org units depending on when you asked.
 *
 * ── WHY IT BLOCKS THE PLACEMENT CORRECTION ───────────────────────────────────
 * An admin correcting placement from July onwards would have JUNE rewritten to
 * the new unit by the next worker tick — within the hour, silently. The date
 * floor is not a floor while this is live, so this must land before the
 * correction feature, not after.
 *
 * `actual_spend` has always omitted the dimensions from its ON CONFLICT list;
 * this brings the residual tables into line with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

/**
 * Read the ON CONFLICT … DO UPDATE SET list a writer actually issues.
 *
 * A behavioural test would need the worker's whole fixture — providers, bills,
 * OTel rows, a 35-day window — to observe one clause. The clause IS the
 * invariant, and the failure mode is somebody adding a line to it, so the
 * assertion reads the statement. Its weakness is named rather than hidden: this
 * cannot catch placement being refreshed by some OTHER statement.
 */
async function updateSetList(file: string, marker: string): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(file, 'utf8')
  const at = src.indexOf(marker)
  expect(at, `marker not found in ${file} — the test is stale, not the code`).toBeGreaterThan(-1)
  const from = src.indexOf('DO UPDATE SET', at)
  return src.slice(from, src.indexOf('RETURNING', from))
}

describe('residual placement freezes at first write', () => {
  it('unaccounted_usage does not refresh region_id or org_unit_id', async () => {
    const setList = await updateSetList(
      'server/usage/unaccounted-reconciliation.ts',
      'ON CONFLICT (teammate_id, day, tool)',
    )
    expect(setList).toContain('cost_usd = EXCLUDED.cost_usd') // money still refreshes
    expect(setList).not.toContain('region_id')
    expect(setList).not.toContain('org_unit_id')
  })

  it('over_emission does not refresh region_id or org_unit_id', async () => {
    // Already true before this change; asserted so it stays true. The review of
    // the plan caught that it specified an edit here that did not exist.
    const setList = await updateSetList(
      'server/usage/over-emission-detection.ts',
      'ON CONFLICT (teammate_id, day, tool)',
    )
    expect(setList).toContain('over_usd = EXCLUDED.over_usd')
    expect(setList).not.toContain('region_id')
    expect(setList).not.toContain('org_unit_id')
  })

  it('the columns are still STAMPED on first write', async () => {
    // Freezing must not mean never setting them: a residual row with no
    // placement reaches no Business Unit at all.
    const { readFileSync } = await import('node:fs')
    for (const f of [
      'server/usage/unaccounted-reconciliation.ts',
      'server/usage/over-emission-detection.ts',
    ]) {
      const src = readFileSync(f, 'utf8')
      expect(src).toMatch(/INSERT INTO (unaccounted_usage|over_emission) \([^)]*region_id[^)]*org_unit_id/)
    }
  })
})
