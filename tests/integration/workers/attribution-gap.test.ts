// @vitest-environment node
/*
 * attribution-gap — the per-instance "emitting but not attributing" detector.
 *
 * The outage it exists for: an instance minted ingest credentials continuously
 * while its spend went nowhere, for 19 days, invisible to every existing alarm
 * (went-silent needs a bearer FAILURE; read-path-health gates on fleet-wide
 * signals; mitigation-query only looks at ENDED instances). These tests pin both
 * halves — that it FIRES on that exact shape, and that it does not fire on the
 * shapes that legitimately look similar.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { findAttributionGaps, runAttributionGap, ATTRIBUTION_GAP } from '../../../server/workers/attribution-gap'

let t: TestDb
const REGION = '11111111-2222-3333-4444-555555555551'
const BU = '11111111-2222-3333-4444-555555555552'
const TEAM = '11111111-2222-3333-4444-555555555553'
const REVOKED_TEAM = '11111111-2222-3333-4444-555555555554'

/** Insert an instance + optional attribution history. Times are relative hours. */
async function seed(opts: {
  id: string
  bearerHoursAgo: number | null
  attributedHoursAgo: number | null
  open?: boolean
  purged?: boolean
  state?: string
  teammate?: string
}): Promise<void> {
  const {
    id,
    bearerHoursAgo,
    attributedHoursAgo,
    open = true,
    purged = false,
    state = 'attested',
    teammate = TEAM,
  } = opts
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at, ts_purged,
       attestation_state, region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${id}', 'oid-${id.slice(0, 8)}', 'dev@i.com', '${teammate}', 'h-ag', 'AG-PROJ',
       'claude-code', 'tok-${id.slice(0, 8)}', NOW() - INTERVAL '60 days',
       ${open ? 'NULL' : `NOW() - INTERVAL '1 hour'`},
       ${bearerHoursAgo === null ? 'NULL' : `NOW() - INTERVAL '${bearerHoursAgo} hours'`},
       ${purged ? 'NOW()' : 'NULL'},
       '${state}', '${REGION}', '${BU}', '${BU}')
  `)
  if (attributedHoursAgo !== null) {
    await attribute(id, teammate, new Date(Date.now() - attributedHoursAgo * 3600_000))
  }
}

/** One attributed record. Uses drizzle so every NOT NULL column is supplied. */
async function attribute(instanceId: string, teammateId: string, tsEvent: Date): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId,
    regionId: REGION,
    orgUnitId: BU,
    costOwningUnitId: BU,
    tool: 'claude-code',
    model: 'claude-sonnet-4-7',
    tokenType: 'input',
    tokens: 100n,
    costUsd: '0.01',
    fidelityTier: 'tier-2',
    costBasis: 'telemetry-only',
    tsEvent,
  })
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES ('${REGION}', 'ag', 'AG');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES ('${BU}', '${REGION}', 'ag.svc'::ltree, 'ag-svc', 'AG Services', 'bu', true);
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, role)
      VALUES ('${TEAM}', 'oid-ag', 'dev.ag@example.com', '${REGION}', '${BU}', 'platform-admin');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, revoked_at, emit_revoked_at)
      VALUES ('${REVOKED_TEAM}', 'oid-ag-rev', 'gone@example.com', '${REGION}', '${BU}', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day');
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client.unsafe(`
    DELETE FROM inbox_item WHERE category = '${ATTRIBUTION_GAP}';
    DELETE FROM instance_attestation_health;
    DELETE FROM attribution_record;
    DELETE FROM instance_attestation;
  `)
})

describe('findAttributionGaps — fires on the outage shape', () => {
  it('THE OUTAGE: minting right now, last attributed 19 days ago', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24 })
    const gaps = await findAttributionGaps(t.db)
    expect(gaps.map((g) => g.instanceId)).toContain(id)
    expect(gaps.find((g) => g.instanceId === id)!.gapHours).toBeGreaterThan(19 * 24 - 2)
  })

  it('reports the teammate email so an operator knows WHO is affected', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 2, attributedHoursAgo: 10 * 24 })
    const gap = (await findAttributionGaps(t.db)).find((g) => g.instanceId === id)
    expect(gap?.email).toBe('dev.ag@example.com')
  })
})

describe('findAttributionGaps — does NOT fire on look-alikes', () => {
  it('a HEALTHY instance (attributing minutes after minting) is not reported', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 1 })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('an IDLE instance (nobody has used it for a week) is not reported', async () => {
    // Stale attribution is CORRECT here — there is nothing to attribute.
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 7 * 24, attributedHoursAgo: 8 * 24 })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('a NEVER-ATTRIBUTED instance is not reported (indistinguishable from never-spent)', async () => {
    // The SessionStart hook mints a bearer on every launch even with zero spend,
    // so "minted, never attributed" is a normal state, not a defect.
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: null })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('a CLOSED instance is not reported (expected to go quiet)', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24, open: false })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('a REVOKED teammate\'s instance is not reported (correctly excluded, not a victim)', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24, teammate: REVOKED_TEAM })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('a PURGED instance is not reported', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24, purged: true })
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })

  it('a gap just UNDER the threshold is not reported (no hair-trigger)', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 60 }) // ~59h gap, under 72h
    expect((await findAttributionGaps(t.db)).map((g) => g.instanceId)).not.toContain(id)
  })
})

describe('runAttributionGap — alerting lifecycle', () => {
  async function openAlerts(): Promise<number> {
    const rows = await t.client.unsafe(
      `SELECT COUNT(*)::int AS n FROM inbox_item WHERE category = '${ATTRIBUTION_GAP}' AND ack_state IN ('unread','read','acknowledged')`,
    )
    return (rows as unknown as [{ n: number }])[0]!.n
  }
  async function openHealth(): Promise<number> {
    const rows = await t.client.unsafe(
      `SELECT COUNT(*)::int AS n FROM instance_attestation_health WHERE status = '${ATTRIBUTION_GAP}' AND resolved_at IS NULL`,
    )
    return (rows as unknown as [{ n: number }])[0]!.n
  }

  it('raises a health row + admin alert, then is idempotent on the next tick', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24 })

    const first = await runAttributionGap(t.db)
    expect(first.gapsFound).toBe(1)
    expect(first.alertsDispatched).toBe(1)
    expect(await openAlerts()).toBe(1)
    expect(await openHealth()).toBe(1)

    // Second tick: still broken, but must NOT re-alert every 30 minutes.
    const second = await runAttributionGap(t.db)
    expect(second.skippedExisting).toBe(1)
    expect(second.alertsDispatched).toBe(0)
    expect(await openAlerts()).toBe(1)
  })

  it('the alert CONTENT is what an operator needs at 3am, not just a row count', async () => {
    // The sweep found every field of this body deletable with the suite green.
    // A count-only assertion lets the alert rot into "something is wrong" with
    // no device, no person, and no next step — which is how an alert becomes
    // noise people mute.
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24 })
    await runAttributionGap(t.db)

    const rows = (await t.client.unsafe(
      `SELECT severity, subject, body FROM inbox_item WHERE category = '${ATTRIBUTION_GAP}' AND related_entity_id = '${id}' LIMIT 1`,
    )) as unknown as Array<{ severity: string; subject: string; body: Record<string, unknown> }>
    expect(rows).toHaveLength(1)
    const item = rows[0]!

    // Pages like a connector outage — money is silently not being attributed.
    expect(item.severity).toBe('urgent')
    // WHICH device, WHO owns it, HOW far behind, and WHERE to look next.
    expect(item.body.instance_id).toBe(id)
    expect(item.body.teammate).toBe('dev.ag@example.com')
    expect(item.body.teammate_id).toBe(TEAM)
    expect(Number(item.body.gap_hours)).toBeGreaterThan(18 * 24)
    expect(String(item.body.hint)).toMatch(/Attribution gaps/)
    // The counter-intuitive fact that caused the outage must survive in the alert.
    expect(String(item.body.hint)).toMatch(/204/)
    expect(item.subject).toMatch(/not being attributed/)
    // The two timestamps that let an operator bound the loss window without
    // opening a console, plus when we noticed (distinct from when it started).
    expect(String(item.body.last_bearer_at)).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(String(item.body.last_attributed_at)).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(new Date(String(item.body.detectedAt)).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('AUTO-RESOLVES once the gap closes (the joiner caught up)', async () => {
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24 })
    await runAttributionGap(t.db)
    expect(await openAlerts()).toBe(1)

    // The recovery lands: fresh attribution arrives.
    await attribute(id, TEAM, new Date())

    const after = await runAttributionGap(t.db)
    expect(after.gapsFound).toBe(0)
    expect(after.autoResolved).toBeGreaterThan(0)
    expect(await openAlerts()).toBe(0)
    expect(await openHealth()).toBe(0)
  })

  it('does not resolve an alert while the instance is STILL starved', async () => {
    // The failure mode that matters for an alerter: quietly closing itself
    // mid-outage. Two ticks with no recovery must leave the alert open.
    const id = randomUUID()
    await seed({ id, bearerHoursAgo: 1, attributedHoursAgo: 19 * 24 })
    await runAttributionGap(t.db)
    const second = await runAttributionGap(t.db)
    expect(second.autoResolved).toBe(0)
    expect(await openAlerts()).toBe(1)
  })

  it('past the dispatch cap: still-gapped instances stay open and the cap hit is reported', async () => {
    const ids = [
      // seed() keys oid/token on the first 8 chars, so those must differ.
      '9a1e00a1-0000-4000-8000-000000000001',
      '9a1e00a2-0000-4000-8000-000000000002',
      '9a1e00a3-0000-4000-8000-000000000003',
    ]
    // Distinct gaps so the cap keeps a deterministic pair: ids[2] has the smallest.
    await seed({ id: ids[0]!, bearerHoursAgo: 1, attributedHoursAgo: 30 * 24 })
    await seed({ id: ids[1]!, bearerHoursAgo: 1, attributedHoursAgo: 20 * 24 })
    await seed({ id: ids[2]!, bearerHoursAgo: 1, attributedHoursAgo: 10 * 24 })

    const first = await runAttributionGap(t.db)
    expect(first.capHit).toBeNull()
    expect(await openAlerts()).toBe(3)
    expect(await openHealth()).toBe(3)

    const capped = await runAttributionGap(t.db, { limit: 2 })
    expect(capped.capHit).toBe(2)
    expect(capped.instances.map((i) => i.instanceId)).toEqual([ids[0], ids[1]])
    expect(capped.autoResolved).toBe(0)
    expect(await openAlerts()).toBe(3)
    expect(await openHealth()).toBe(3)
  })

  it('a clean fleet raises nothing', async () => {
    await seed({ id: randomUUID(), bearerHoursAgo: 1, attributedHoursAgo: 1 })
    const res = await runAttributionGap(t.db)
    expect(res.gapsFound).toBe(0)
    expect(res.alertsDispatched).toBe(0)
    expect(await openAlerts()).toBe(0)
  })
})
