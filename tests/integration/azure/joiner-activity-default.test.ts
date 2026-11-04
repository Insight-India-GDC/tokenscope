// @vitest-environment node
/*
 * The folder's default activity (#475) through the read joiner.
 *
 * The plugins emit `tokenscope.activity` as a resource attribute. It is a CLAIM:
 * the joiner stamps it only when it names an active activity_type that is global
 * or the teammate's region's, in the vocabulary's spelling, and a manual tag of
 * the session always wins, including against a tag committed mid-join.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { tagSessionTx } from '../../../server/utils/tag-session'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

type TagTx = Parameters<typeof tagSessionTx>[0]

let t: TestDb

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

const REGION_A = '9a1e0000-0000-4000-8000-000000000a01'
const REGION_B = '9a1e0000-0000-4000-8000-000000000b01'
const OU_A = '9a1e0000-0000-4000-8000-000000000a02'
const OU_B = '9a1e0000-0000-4000-8000-000000000b02'
const DEV_A = '9a1e0000-0000-4000-8000-000000000a03'
const DEV_B = '9a1e0000-0000-4000-8000-000000000b03'
const INST_A = '9a1e0000-0000-4000-8000-000000000a04'
const INST_B = '9a1e0000-0000-4000-8000-000000000b04'

/** One provider-priced span: deterministic cost, its own ledger row. */
function span(o: { conv: string; runId: string; ts: string; activity?: string }): UsageRecord {
  return {
    tokens: 1000,
    tokenType: 'output',
    model: 'claude-fable-5',
    tsEvent: o.ts,
    sourceRunId: o.runId,
    claudeSessionId: o.conv,
    lawCostUsd: 1.5,
    ...(o.activity === undefined ? {} : { activity: o.activity }),
  }
}

async function join(instance: string, records: UsageRecord[]) {
  const reader = new StubReader(new Map([[instance, records]])) as unknown as TelemetryReader
  return runReadJoiner(t.db, reader, { sessionIds: [instance] })
}

async function activityOf(runId: string): Promise<string | null> {
  const [r] = await t.client<{ activity: string | null }[]>`
    SELECT activity FROM attribution_record WHERE source_run_id = ${runId}`
  expect(r, `no ledger row for ${runId}`).toBeDefined()
  return r!.activity
}

function tag(teammate: string, conv: string, activity: string) {
  return t.db.transaction((tx) =>
    tagSessionTx(
      tx as unknown as TagTx,
      teammate,
      conv,
      { setProject: false, projectVal: null, setActivity: true, activityVal: activity },
      { actorSystem: 'test' },
    ),
  )
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('${REGION_A}', 'act-a', 'Activity A'), ('${REGION_B}', 'act-b', 'Activity B');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES
      ('${OU_A}', '${REGION_A}', 'acta'::ltree, 'act-a-bu', 'A BU', 'bu', TRUE),
      ('${OU_B}', '${REGION_B}', 'actb'::ltree, 'act-b-bu', 'B BU', 'bu', TRUE);
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('${DEV_A}', 'oid-act-a', 'a@example.com', '${REGION_A}', '${OU_A}'),
      ('${DEV_B}', 'oid-act-b', 'b@example.com', '${REGION_B}', '${OU_B}');
    -- Region A's own entry (created by an admin, so is_standard FALSE, as
    -- admin/activity-types/index.post.ts writes it), and an inactive global one.
    -- The global seeds (mig 0020: documentation, development, ...) are lowercase.
    INSERT INTO activity_type (region_id, label, is_standard, sort_order, is_active) VALUES
      ('${REGION_A}', 'Bid Review', FALSE, 100, TRUE),
      (NULL, 'retired thing', TRUE, 200, FALSE);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INST_A}', 'oid-act-a', 'a@example.com', '${DEV_A}', 'h-act', 'ACT-1',
       'claude-code', 'hashActA', '2026-07-01 00:00:00+00', '2026-07-31 23:59:00+00',
       '${REGION_A}', '${OU_A}', '${OU_A}'),
      ('${INST_B}', 'oid-act-b', 'b@example.com', '${DEV_B}', 'h-act', 'ACT-1',
       'claude-code', 'hashActB', '2026-07-01 00:00:00+00', '2026-07-31 23:59:00+00',
       '${REGION_B}', '${OU_B}', '${OU_B}');
  `)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('folder default activity (#475)', () => {
  it('stamps a standard label in the vocabulary spelling, whatever case was emitted', async () => {
    await join(INST_A, [
      span({ conv: 'conv-a1', runId: 'a1-upper', ts: '2026-07-02T09:00:00Z', activity: 'TESTING' }),
      span({ conv: 'conv-a2', runId: 'a1-spaced', ts: '2026-07-02T09:01:00Z', activity: '  development ' }),
    ])
    // The seed is 'testing'; the pickers offer (and a manual tag stores) 'Testing'.
    expect(await activityOf('a1-upper')).toBe('Testing')
    expect(await activityOf('a1-spaced')).toBe('Development')
  })

  it('ignores anything that is not an active standard label', async () => {
    await join(INST_A, [
      span({ conv: 'conv-a3', runId: 'a3-client', ts: '2026-07-03T09:00:00Z', activity: 'Contoso bid' }),
      span({ conv: 'conv-a4', runId: 'a3-inactive', ts: '2026-07-03T09:01:00Z', activity: 'retired thing' }),
      span({ conv: 'conv-a5', runId: 'a3-none', ts: '2026-07-03T09:02:00Z' }),
    ])
    expect(await activityOf('a3-client')).toBeNull()
    expect(await activityOf('a3-inactive')).toBeNull()
    expect(await activityOf('a3-none')).toBeNull()
    // The emitted string never reaches storage anywhere.
    const [leak] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM attribution_record WHERE activity ILIKE '%contoso%'`
    expect(leak!.n).toBe(0)
  })

  it("counts a region's own label only for that region's teammates", async () => {
    await join(INST_A, [span({ conv: 'conv-a6', runId: 'a6-region', ts: '2026-07-04T09:00:00Z', activity: 'bid review' })])
    await join(INST_B, [span({ conv: 'conv-b1', runId: 'b1-region', ts: '2026-07-04T09:00:00Z', activity: 'bid review' })])
    expect(await activityOf('a6-region')).toBe('Bid Review')
    expect(await activityOf('b1-region')).toBeNull()
  })

  it('a manual tag wins over the default, on rows joined before AND after it', async () => {
    const conv = 'conv-a7'
    await join(INST_A, [span({ conv, runId: 'a7-before', ts: '2026-07-05T09:00:00Z', activity: 'research' })])
    expect(await activityOf('a7-before')).toBe('Research')

    await tag(DEV_A, conv, 'Documentation')
    expect(await activityOf('a7-before')).toBe('Documentation')

    await join(INST_A, [span({ conv, runId: 'a7-after', ts: '2026-07-05T09:10:00Z', activity: 'research' })])
    expect(await activityOf('a7-after')).toBe('Documentation')
  })

  // External review (HIGH): with no manual tag yet, a project-axis tag must not
  // record the folder default as the session's own activity.
  it('a project-only tag leaves a folder default a default', async () => {
    const conv = 'conv-a8'
    await join(INST_A, [span({ conv, runId: 'a8-1', ts: '2026-07-06T09:00:00Z', activity: 'research' })])
    expect(await activityOf('a8-1')).toBe('Research')
    await t.db.transaction((tx) =>
      tagSessionTx(
        tx as unknown as TagTx,
        DEV_A,
        conv,
        { setProject: true, projectVal: null, setActivity: false, activityVal: null },
        { actorSystem: 'test' },
      ),
    )
    const [row] = await t.client<{ activity: string | null }[]>`
      SELECT activity FROM session_assignment WHERE claude_session_id = ${conv} AND teammate_id = ${DEV_A}::uuid`
    expect(row?.activity ?? null).toBeNull()
    expect(await activityOf('a8-1')).toBe('Research')
  })

  /*
   * THE RACE. A tag that commits while the joiner is between reading the
   * session's activity and inserting its rows must reach those rows.
   *
   * The tag's transaction is held open after tagSessionTx (lock held, UPDATE
   * done, not committed) while the joiner runs:
   *   - WITH the fix, the joiner's write transaction waits on the same advisory
   *     lock; the test sees it waiting, commits the tag, and the joiner then
   *     reads 'Documentation' under the lock.
   *   - WITHOUT it (no lock, or the read outside the lock), the joiner does not
   *     wait: it reads no committed manual tag, stamps the default 'Research'
   *     and commits; the tag's UPDATE already ran, before that row existed. The
   *     row keeps 'Research' and both assertions below go red.
   */
  it('a tag committed while a join is in flight is not lost on the joined rows', async () => {
    const conv = 'conv-a8'
    await join(INST_A, [span({ conv, runId: 'a8-first', ts: '2026-07-06T09:00:00Z', activity: 'research' })])

    let tagged!: () => void
    const tagApplied = new Promise<void>((r) => (tagged = r))
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    const tagTx = t.db.transaction(async (tx) => {
      await tagSessionTx(
        tx as unknown as TagTx,
        DEV_A,
        conv,
        { setProject: false, projectVal: null, setActivity: true, activityVal: 'Documentation' },
        { actorSystem: 'test' },
      )
      tagged()
      await released
    })
    await tagApplied

    const joinDone = join(INST_A, [span({ conv, runId: 'a8-second', ts: '2026-07-06T09:10:00Z', activity: 'research' })])
    const poll = { stop: false }
    const outcome = await Promise.race([joinDone.then(() => 'finished' as const), waitForAdvisoryWaiter(poll)])
    poll.stop = true
    release()
    await tagTx
    await joinDone

    expect(outcome).toBe('blocked')
    expect(await activityOf('a8-first')).toBe('Documentation')
    expect(await activityOf('a8-second')).toBe('Documentation')
  })
})

/** Resolves 'blocked' once some backend in this database waits on an advisory lock. */
async function waitForAdvisoryWaiter(poll: { stop: boolean }): Promise<'blocked' | 'timed-out'> {
  const deadline = Date.now() + 10_000
  while (!poll.stop && Date.now() < deadline) {
    const [r] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_locks l
        JOIN pg_database d ON d.oid = l.database
       WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`
    if (r!.n > 0) return 'blocked'
    await new Promise((res) => setTimeout(res, 25))
  }
  return 'timed-out'
}
