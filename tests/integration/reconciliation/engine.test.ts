// @vitest-environment node
/*
 * Reconciliation engine — DB path against testcontainers Postgres.
 *
 * Exercises what the pure classifyDelta unit tests can't: that PG actually
 * INFERS the partial unique index from the ON CONFLICT arbiter (idempotent
 * re-pull), the NaN guard, and that v_effective_spend / v_finance_reportable_spend
 * count only applied rows and gate indicative spend.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ReconciledLine } from '../../../server/reconciliation/types'

let t: TestDb
let teammateId = ''
const NOW = new Date('2026-06-08T12:00:00.000Z')

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-re', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-re'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.re', 're-bu', 'RE BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 're-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-re', 're@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-re'`
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM reconciliation_record`
  // Clear OTel operand rows so a prior test's credit_qty/cost can't leak into the
  // next test's delta (the credit-lane test seeds its own rows inside its body).
  await t.client`DELETE FROM attribution_record`
})

function line(over: Partial<ReconciledLine> = {}): ReconciledLine {
  return {
    provider: 'anthropic',
    enterpriseRef: 'org-re',
    licenseOrg: null,
    periodDate: '2026-06-08',
    subject: { kind: 'teammate', teammateId },
    category: 'model_tokens',
    unit: { quantity: 1000, unitType: 'tokens' },
    rateUsdPerUnit: '0',
    amountUsd: '5.00',
    spendClass: 'estimated',
    raw: { test: true },
    ...over,
  }
}

async function count(): Promise<number> {
  const [r] = await t.client<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM reconciliation_record`
  return Number(r!.c)
}

describe('runReconcileEngine (DB path)', () => {
  it('writes one proposed row and re-pull is idempotent (ON CONFLICT infers the partial index)', async () => {
    const r1 = await runReconcileEngine(t.db, [line()], { now: NOW })
    expect(r1.recordsWritten).toBe(1)
    expect(r1.over).toBe(1)
    expect(await count()).toBe(1)

    const [row] = await t.client<{ status: string; disposition: string; delta_usd: string }[]>`
      SELECT status, disposition, delta_usd::text AS delta_usd FROM reconciliation_record`
    expect(row!.status).toBe('proposed')
    expect(row!.disposition).toBe('no_install') // teammate has no OTel history
    expect(Number(row!.delta_usd)).toBeCloseTo(5, 6)

    // Re-pull the same window: refreshes the open row, does NOT duplicate.
    const r2 = await runReconcileEngine(t.db, [line({ amountUsd: '7.50' })], { now: NOW })
    expect(r2.recordsWritten).toBe(1)
    expect(await count()).toBe(1)
    const [row2] = await t.client<{ delta_usd: string }[]>`
      SELECT delta_usd::text AS delta_usd FROM reconciliation_record`
    expect(Number(row2!.delta_usd)).toBeCloseTo(7.5, 6)
  })

  it('rejects a non-finite amount instead of writing NaN', async () => {
    const r = await runReconcileEngine(t.db, [line({ amountUsd: 'not-a-number' })], { now: NOW })
    expect(r.skippedInvalid).toBe(1)
    expect(r.recordsWritten).toBe(0)
    expect(await count()).toBe(0)
  })

  it('v_effective_spend counts only applied rows; v_finance_reportable_spend gates indicative', async () => {
    await runReconcileEngine(t.db, [line()], { now: NOW }) // estimated, proposed
    const proposedInView = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM v_effective_spend WHERE source = 'reconciliation'`
    expect(Number(proposedInView[0]!.c)).toBe(0) // proposed is excluded

    await t.client`UPDATE reconciliation_record SET status = 'applied', applied_at = now()`
    const appliedInEffective = await t.client<{ c: string; sc: string }[]>`
      SELECT COUNT(*)::text AS c, MAX(spend_class) AS sc FROM v_effective_spend WHERE source = 'reconciliation'`
    expect(Number(appliedInEffective[0]!.c)).toBe(1)
    expect(appliedInEffective[0]!.sc).toBe('estimated')
    const inFinance = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM v_finance_reportable_spend WHERE source = 'reconciliation'`
    expect(Number(inFinance[0]!.c)).toBe(1) // estimated is finance-reportable
  })

  it('holds indicative spend OUT of v_finance_reportable_spend', async () => {
    await runReconcileEngine(t.db, [line({ spendClass: 'indicative', indicativeReason: 'personal-subscription' })], {
      now: NOW,
    })
    await t.client`UPDATE reconciliation_record SET status = 'applied', applied_at = now()`
    const effective = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM v_effective_spend WHERE source = 'reconciliation'`
    const finance = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM v_finance_reportable_spend WHERE source = 'reconciliation'`
    expect(Number(effective[0]!.c)).toBe(1) // visible in effective spend
    expect(Number(finance[0]!.c)).toBe(0) // but NOT in the cross-charge gate
  })

  it('reconciles the ai-credits branch and stores the native unit', async () => {
    const r = await runReconcileEngine(
      t.db,
      [
        line({
          provider: 'github',
          category: 'copilot_interactive',
          unit: { quantity: 9, unitType: 'ai-credits' },
          rateUsdPerUnit: '0.01',
          amountUsd: '0.09',
        }),
      ],
      { now: NOW },
    )
    expect(r.recordsWritten).toBe(1)
    const [row] = await t.client<{ unit: string; qty: string }[]>`
      SELECT actual_unit_type AS unit, actual_qty::text AS qty FROM reconciliation_record`
    expect(row!.unit).toBe('ai-credits')
    expect(Number(row!.qty)).toBeCloseTo(9, 6)
  })

  it('rejects an ai-credits line with a non-finite rate', async () => {
    const r = await runReconcileEngine(
      t.db,
      [line({ category: 'copilot_interactive', unit: { quantity: 9, unitType: 'ai-credits' }, rateUsdPerUnit: '', amountUsd: '0.09' })],
      { now: NOW },
    )
    expect(r.skippedInvalid).toBe(1)
    expect(await count()).toBe(0)
  })

  it('rejects an empty amount (guard and ::numeric bind agree)', async () => {
    const r = await runReconcileEngine(t.db, [line({ amountUsd: '' })], { now: NOW })
    expect(r.skippedInvalid).toBe(1)
    expect(await count()).toBe(0)
  })

  it('credit lane reconciles against telemetry-only OTel rows (engine credit operand)', async () => {
    // Copilot rows are telemetry-only by design in v1, and credit_qty lives ONLY on
    // them. Seed one (9 credits); bill 12. The engine MUST subtract the 9 OTel
    // credits (delta = 3 * rate = 0.03), not treat the OTel operand as 0 (which the
    // cost_basis<>'telemetry-only' filter did before — making the lane inert/untagged
    // at the full 0.12). Found by Stream B.
    const ts = '2026-06-08T12:00:00.000Z' // matches the line() default periodDate
    const [d] = await t.client<{ rid: string; oid: string }[]>`
      SELECT region_id::text AS rid, org_unit_id::text AS oid FROM teammate WHERE id = ${teammateId}::uuid`
    await t.client`
      INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES (gen_random_uuid(), 'CP-1', 'h-cp-1', 'CP', 'billable', ${d!.rid}, ${d!.oid})`
    await t.client`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('c0901111-1111-1111-1111-111111111111', 'oid-re', 're@example.com', ${teammateId}, 'h-cp-1', 'CP-1',
              'copilot-cli', 'h-cp', ${ts}, ${d!.rid}, ${d!.oid}, ${d!.oid})`
    await t.client`
      INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
         credit_qty, fidelity_tier, cost_basis, ts_event)
      VALUES ('c0901111-1111-1111-1111-111111111111', ${teammateId}, ${d!.rid}, ${d!.oid}, 'copilot-cli', 'gpt', 'input', 0, 0,
              9, 'tier-3', 'telemetry-only', ${ts})`

    const r = await runReconcileEngine(
      t.db,
      [
        line({
          provider: 'github',
          category: 'copilot_interactive',
          unit: { quantity: 12, unitType: 'ai-credits' },
          rateUsdPerUnit: '0.01',
          amountUsd: '0.12',
        }),
      ],
      { now: NOW },
    )
    expect(r.recordsWritten).toBe(1)
    const [row] = await t.client<{ disposition: string; delta: string }[]>`
      SELECT disposition, delta_usd::text AS delta FROM reconciliation_record
      WHERE scope = 'teammate' AND category = 'copilot_interactive'`
    expect(row!.disposition).toBe('untagged')
    expect(Number(row!.delta)).toBeCloseTo(0.03, 6) // 12 billed - 9 OTel credits = 3 * 0.01
  })

  // ── within-epsilon match: counted, writes NO reconciliation_record ───────────
  // BILL-ANCHORED (mig 0059): a rounding-noise match is just a no-op for the
  // ledger — there is no coverage table any more (finance = the bill directly).
  it('a within-epsilon match is counted and writes no reconciliation_record', async () => {
    // Teammate has no OTel history -> otelUsd = 0; bill 0.005 <= epsilon (0.01) ->
    // 'matched'. matched writes NO reconciliation_record.
    const r = await runReconcileEngine(t.db, [line({ amountUsd: '0.005' })], { now: NOW })
    expect(r.matched).toBe(1)
    expect(r.recordsWritten).toBe(0)
    expect(await count()).toBe(0) // no reconciliation_record for a rounding-noise match
  })
})

describe('runReconcileEngine: the stamped cost-owning unit is the Business Unit (#450)', () => {
  it('stamps the nearest cost-owning ancestor, not the team node; NULL when there is none', async () => {
    const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-re'`
    const [bu] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (gen_random_uuid(), ${region!.id}, 'apac.bu450', 'bu-450', 'BU 450', 'bu', TRUE)
      RETURNING id::text AS id`
    const [team] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES (gen_random_uuid(), ${region!.id}, 'apac.bu450.team', 'team-450', 'Team 450', 'team')
      RETURNING id::text AS id`
    const [inTeam] = await t.client<{ id: string }[]>`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES (gen_random_uuid(), 'oid-450', 'team450@example.com', ${region!.id}, ${team!.id})
      RETURNING id::text AS id`

    await runReconcileEngine(t.db, [
      line({ subject: { kind: 'teammate', teammateId: inTeam!.id } }),
      line({ subject: { kind: 'teammate', teammateId } }), // 're-bu' is not cost-owning
    ], { now: NOW })

    const rows = await t.client<{ teammate_id: string; org_unit_id: string; cou: string | null }[]>`
      SELECT teammate_id::text AS teammate_id, org_unit_id::text AS org_unit_id, cost_owning_unit_id::text AS cou
      FROM reconciliation_record`
    const team450 = rows.find((r) => r.teammate_id === inTeam!.id)!
    expect(team450.org_unit_id).toBe(team!.id) // the recorded placement stays the team node
    expect(team450.cou).toBe(bu!.id)
    expect(rows.find((r) => r.teammate_id === teammateId)!.cou).toBeNull()
  })
})

describe('migration 0169: existing rows gain their Business Unit (#450)', () => {
  it('moves teammate rows to their unit Business Unit or NULL, leaves org rows, queues GitHub teammates', async () => {
    const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-re'`
    const [bu] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (gen_random_uuid(), ${region!.id}, 'apac.bu0169', 'bu-0169', 'BU 0169', 'bu', TRUE)
      RETURNING id::text AS id`
    const [team] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES (gen_random_uuid(), ${region!.id}, 'apac.bu0169.team', 'team-0169', 'Team 0169', 'team')
      RETURNING id::text AS id`
    const [inTeam] = await t.client<{ id: string }[]>`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES (gen_random_uuid(), 'oid-0169', 'team0169@example.com', ${region!.id}, ${team!.id})
      RETURNING id::text AS id`
    const [noBu] = await t.client<{ id: string }[]>`SELECT org_unit_id::text AS id FROM teammate WHERE id = ${teammateId}::uuid`
    await t.client`DELETE FROM usage_rollup_refresh`

    // The pre-fix shape: a teammate row stamped with its raw org unit.
    const seed = (provider: string, tm: string | null, ou: string | null, cou: string | null, scope: string) => t.client`
      INSERT INTO reconciliation_record (provider, enterprise_ref, period_date, category, scope, teammate_id, region_id,
        org_unit_id, cost_owning_unit_id, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
      VALUES (${provider}, 'ent-0169', '2026-06-01', 'copilot_interactive', ${scope}, ${tm}::uuid, ${region!.id}::uuid,
        ${ou}::uuid, ${cou}::uuid, 1, 0, 1, 'billed', 'no_install', 'applied')`
    await seed('github', inTeam!.id, team!.id, team!.id, 'teammate')
    await seed('anthropic', teammateId, noBu!.id, noBu!.id, 'teammate')
    await seed('github', null, null, team!.id, 'org') // the provider_org's own unit: must not move

    await t.client.unsafe(readFileSync(
      join(process.cwd(), 'drizzle', 'migrations', '0169_reconciliation_record_business_unit.sql'), 'utf8'))

    const rows = await t.client<{ scope: string; teammate_id: string | null; cou: string | null }[]>`
      SELECT scope, teammate_id::text AS teammate_id, cost_owning_unit_id::text AS cou FROM reconciliation_record`
    expect(rows.find((r) => r.teammate_id === inTeam!.id)!.cou).toBe(bu!.id)
    expect(rows.find((r) => r.teammate_id === teammateId)!.cou).toBeNull() // 're-bu' has no Business Unit
    expect(rows.find((r) => r.scope === 'org')!.cou).toBe(team!.id)
    const queued = await t.client<{ teammate_id: string }[]>`SELECT teammate_id::text AS teammate_id FROM usage_rollup_refresh`
    expect(queued.map((q) => q.teammate_id)).toEqual([inTeam!.id]) // the Anthropic-only teammate is not queued
  })
})
