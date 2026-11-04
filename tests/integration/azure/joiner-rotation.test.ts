// @vitest-environment node
/*
 * The joiner's fair rotation and bounded watermark against real Postgres
 * (docs/design/scaling-to-1000-users.md, Phase 1 item 2; mig 0149).
 *
 *   - ROTATION: the scheduled selection orders least-recently-read first and the
 *     scheduled run stamps what it attempted, so a fleet larger than one tick's
 *     reach is visited in full within ceil(N / per-tick) ticks.
 *   - STAMP: exactly the attempted devices, success or failure; never on a run
 *     that was not asked to stamp.
 *   - CS-EDGE-01: an already-read confirmed device still outranks a flood of
 *     never-read provisional rows.
 *   - WATERMARK BOUND: in-window history gives the same watermark as before; a
 *     device whose last row is older than the reader's lookback gets none.
 *
 * Lanes and the deadline are pinned in tests/unit/azure/joiner-lanes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner, selectJoinableInstances } from '../../../server/workers/azure-monitor-reader'
import type { TelemetryReader, UsageRecord, SignalRecord } from '../../../server/azure/reader'

let t: TestDb

const REGION = '9a1e0000-0000-4000-8000-00000000a001'
const UNIT = '9a1e0000-0000-4000-8000-00000000a002'
const MATE_A = '9a1e0000-0000-4000-8000-00000000a003'
const MATE_B = '9a1e0000-0000-4000-8000-00000000a004'
const dev = (n: number) => `9a1e0000-0000-4000-8000-${(0xb000 + n).toString(16).padStart(12, '0')}`

/** Reader that returns nothing and records which devices it was asked for, and with what watermark. */
class RecordingReader {
  readonly usageCalls: { id: string; since?: Date }[] = []
  readonly signalCalls: { id: string; since?: Date }[] = []
  constructor(
    private readonly usage: Map<string, UsageRecord[]> = new Map(),
    private readonly signals: Map<string, SignalRecord[]> = new Map(),
    readonly appliedLookbackDays?: number,
    private readonly failFor: Set<string> = new Set(),
  ) {}
  async getSessionUsage(id: string, since?: Date): Promise<UsageRecord[]> {
    this.usageCalls.push({ id, since })
    if (this.failFor.has(id)) throw new Error('Log Analytics query timed out')
    return this.usage.get(id) ?? []
  }
  async getSignalUsage(id: string, since?: Date): Promise<SignalRecord[]> {
    this.signalCalls.push({ id, since })
    return this.signals.get(id) ?? []
  }
}
const asReader = (r: RecordingReader) => r as unknown as TelemetryReader

async function insertDevices(ids: string[], opts: { teammate?: string; provisional?: boolean; readAgo?: string } = {}) {
  for (const [i, id] of ids.entries()) {
    // Distinct, descending bearer stamps: the pre-0149 order would pick the
    // same freshest devices every tick.
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, ts_actual_end,
         last_bearer_at, region_id, org_unit_id, attestation_state, identity_state, claimed_email, joiner_read_at)
      VALUES ('${id}', 'oid-${id}', 'dev@i.com', '${opts.teammate ?? MATE_A}', 'claude-code',
              NOW() - INTERVAL '2 days', NULL, NOW() - INTERVAL '${i + 1} minutes',
              '${REGION}', '${UNIT}', 'unassigned',
              '${opts.provisional ? 'provisional' : 'confirmed'}',
              ${opts.provisional ? `'flood-${i}@x.test'` : 'NULL'},
              ${opts.readAgo ? `NOW() - INTERVAL '${opts.readAgo}'` : 'NULL'})
    `)
  }
}

async function readAt(ids: string[]): Promise<Map<string, string | null>> {
  const rows = await t.client<{ id: string; at: string | null }[]>`
    SELECT instance_id::text AS id, joiner_read_at::text AS at FROM instance_attestation
     WHERE instance_id = ANY(${ids}::uuid[])`
  return new Map(rows.map((r) => [r.id, r.at]))
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES ('${REGION}', 'rot', 'Rotation');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('${UNIT}', '${REGION}', 'rot.svc'::ltree, 'rot-svc', 'Rotation Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('${MATE_A}', 'oid-a', 'a@i.com', '${REGION}', '${UNIT}'),
      ('${MATE_B}', 'oid-b', 'b@i.com', '${REGION}', '${UNIT}');
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client.unsafe(`
    DELETE FROM attribution_record;
    DELETE FROM usage_signal_record;
    DELETE FROM instance_attestation;
  `)
})

/** One scheduled tick as the registry runs it: selection, then a stamping join. */
async function scheduledTick(limit: number, reader: RecordingReader) {
  const { ids } = await selectJoinableInstances(t.db, { limit })
  return runReadJoiner(t.db, asReader(reader), { sessionIds: ids, stampReadAt: true })
}

describe('fair rotation (mig 0149)', () => {
  it('visits every eligible device within ceil(N / per-tick) ticks', async () => {
    const fleet = [1, 2, 3, 4, 5, 6, 7].map(dev)
    await insertDevices(fleet)
    const perTick = 3
    const seen = new Set<string>()
    for (let tick = 0; tick < Math.ceil(fleet.length / perTick); tick++) {
      const reader = new RecordingReader()
      const res = await scheduledTick(perTick, reader)
      expect(res.devicesAttempted).toBe(perTick)
      for (const c of reader.usageCalls) seen.add(c.id)
    }
    expect(seen).toEqual(new Set(fleet))
  })

  it('stamps every attempted device, a failed one included, and reports the age it found', async () => {
    const fleet = [1, 2, 3].map(dev)
    await insertDevices(fleet, { readAgo: '90 minutes' })
    const reader = new RecordingReader(new Map(), new Map(), 7, new Set([fleet[1]!]))
    const res = await scheduledTick(10, reader)
    expect(res.errors).toBe(1)
    expect(res.oldestReadAgeMinutes).toBe(90) // read before this tick's own stamp
    const after = await t.client<{ fresh: boolean }[]>`
      SELECT bool_and(joiner_read_at > NOW() - INTERVAL '1 minute') AS fresh FROM instance_attestation`
    expect(after[0]!.fresh).toBe(true)
  })

  it('stamps only what the run attempted: devices outside the explicit set keep their stamp', async () => {
    const fleet = [1, 2, 3].map(dev)
    await insertDevices(fleet)
    await runReadJoiner(t.db, asReader(new RecordingReader()), { sessionIds: [fleet[0]!], stampReadAt: true })
    const at = await readAt(fleet)
    expect(at.get(fleet[0]!)).not.toBeNull()
    expect(at.get(fleet[1]!)).toBeNull()
    expect(at.get(fleet[2]!)).toBeNull()
  })

  it('does not stamp a run that was not asked to (operator, deep-read and recovery runs)', async () => {
    const fleet = [1, 2].map(dev)
    await insertDevices(fleet)
    await runReadJoiner(t.db, asReader(new RecordingReader()), { sessionIds: fleet, deepRescan: true, scoped: true })
    for (const v of (await readAt(fleet)).values()) expect(v).toBeNull()
  })

  it('CS-EDGE-01: a flood of never-read provisional rows does not displace an already-read confirmed device', async () => {
    const confirmed = dev(50)
    const flood = [51, 52, 53, 54, 55, 56].map(dev)
    await insertDevices([confirmed], { readAgo: '1 minute' })
    await insertDevices(flood, { teammate: MATE_B, provisional: true })
    const sel = await selectJoinableInstances(t.db, { limit: 3 })
    expect(sel.capHit).toBe(3) // the flood alone exceeds the cap
    expect(sel.ids[0]).toBe(confirmed)
  })

  it("one teammate's never-read churn does not displace another teammate's already-read device", async () => {
    const churn = [70, 71, 72, 73, 74, 75].map(dev)
    const other = dev(76)
    await insertDevices(churn)
    await insertDevices([other], { teammate: MATE_B, readAgo: '1 minute' })
    const sel = await selectJoinableInstances(t.db, { limit: 3 })
    expect(sel.capHit).toBe(3)
    expect(sel.ids).toContain(other)
  })
})

describe('watermark bound', () => {
  const DAY = 24 * 3600_000
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const rec = (ts: string): UsageRecord => ({ tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: ts, lawCostUsd: 0.01 })
  const sig = (ts: string): SignalRecord => ({ signalName: 'tool_count', value: 1, tsEvent: ts, sourceRunId: `run-${ts}` })

  it('in-window history gives the same watermark; history older than the lookback gives none', async () => {
    const recent = dev(60) // last row 1 day ago: inside a 7-day lookback
    const stale = dev(61) // last row 20 days ago: outside it
    await insertDevices([recent, stale])
    const recentTs = iso(DAY)
    const staleTs = iso(20 * DAY)
    // Land real rows through the joiner itself.
    await runReadJoiner(
      t.db,
      asReader(
        new RecordingReader(
          new Map([
            [recent, [rec(iso(2 * DAY)), rec(recentTs)]],
            [stale, [rec(staleTs)]],
          ]),
          new Map([
            [recent, [sig(recentTs)]],
            [stale, [sig(staleTs)]],
          ]),
        ),
      ),
      { sessionIds: [recent, stale] },
    )

    const unbounded = new RecordingReader()
    await runReadJoiner(t.db, asReader(unbounded), { sessionIds: [recent, stale] })
    const bounded = new RecordingReader(new Map(), new Map(), 7)
    await runReadJoiner(t.db, asReader(bounded), { sessionIds: [recent, stale] })

    const since = (calls: { id: string; since?: Date }[], id: string) => calls.find((c) => c.id === id)!.since?.getTime()
    // In the window: the same watermark either way.
    expect(since(bounded.usageCalls, recent)).toBe(new Date(recentTs).getTime())
    expect(since(bounded.usageCalls, recent)).toBe(since(unbounded.usageCalls, recent))
    expect(since(bounded.signalCalls, recent)).toBe(since(unbounded.signalCalls, recent))
    // Outside it: the unbounded read found the old row, the bounded one finds none,
    // and the reader then reads its whole lookback, which is all the old watermark allowed.
    expect(since(unbounded.usageCalls, stale)).toBe(new Date(staleTs).getTime())
    expect(since(bounded.usageCalls, stale)).toBeUndefined()
    expect(since(unbounded.signalCalls, stale)).toBe(new Date(staleTs).getTime())
    expect(since(bounded.signalCalls, stale)).toBeUndefined()
  })
})
