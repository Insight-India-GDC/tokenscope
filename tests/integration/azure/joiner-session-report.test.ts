// @vitest-environment node
/*
 * Session-to-instance reports through the read joiner (#494), and a project tag
 * committed mid-join (#497).
 *
 * #494: a tagged repo's settings carry the whole resource attribute string, so
 * Claude Code CLI and Claude Desktop opening one repo both emit naming whichever
 * install wrote the file last. Each install's SessionStart hook reports its own
 * instance for the session; the joiner books the session's rows to it when it is
 * the same teammate's, and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { tagSessionTx } from '../../../server/utils/tag-session'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

type TagTx = Parameters<typeof tagSessionTx>[0]

let t: TestDb

class StubReader {
  readonly watermarks: (Date | undefined)[] = []
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    this.watermarks.push(sinceTsEvent)
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

const REGION = '9a1e0000-0000-4000-8000-000000005a01'
const OU = '9a1e0000-0000-4000-8000-000000005a02'
const DEV = '9a1e0000-0000-4000-8000-000000005a03'
const OTHER_DEV = '9a1e0000-0000-4000-8000-000000005b03'
const CLI = '9a1e0000-0000-4000-8000-000000005a04'
const DESKTOP = '9a1e0000-0000-4000-8000-000000005a05'
const SECOND = '9a1e0000-0000-4000-8000-000000005a06'
const STRANGER = '9a1e0000-0000-4000-8000-000000005b04'
const PROJ = '9a1e0000-0000-4000-8000-000000005a07'
const COPILOT = '9a1e0000-0000-4000-8000-000000005a08'
const PURGED = '9a1e0000-0000-4000-8000-000000005a09'

/** Claude session ids are UUIDs; the report route holds them to that shape. */
const conv = (n: number) => `9a1e0000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`

function span(o: { conv: string; runId: string; ts: string; email?: string }): UsageRecord {
  return {
    ...(o.email === undefined ? {} : { emittingEmail: o.email }),
    tokens: 1000,
    tokenType: 'output',
    model: 'claude-fable-5',
    tsEvent: o.ts,
    sourceRunId: o.runId,
    claudeSessionId: o.conv,
    lawCostUsd: 1.5,
  }
}

async function join(instance: string, records: UsageRecord[]) {
  const reader = new StubReader(new Map([[instance, records]]))
  const result = await runReadJoiner(t.db, reader as unknown as TelemetryReader, { sessionIds: [instance] })
  return { result, reader }
}

async function report(convId: string, instance: string) {
  await t.client`INSERT INTO session_instance_report (claude_session_id, instance_id) VALUES (${convId}, ${instance}::uuid)`
}

async function rowsOf(runId: string) {
  return t.client<{ instance_id: string; emitted_instance_id: string | null; project_id: string | null }[]>`
    SELECT instance_id::text, emitted_instance_id::text, project_id::text
      FROM attribution_record WHERE source_run_id = ${runId}`
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES ('${REGION}', 'sir', 'Session report');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES
      ('${OU}', '${REGION}', 'sir'::ltree, 'sir-bu', 'SIR BU', 'bu', TRUE);
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('${DEV}', 'oid-sir', 'sir@example.com', '${REGION}', '${OU}'),
      ('${OTHER_DEV}', 'oid-sir-other', 'sir-other@example.com', '${REGION}', '${OU}');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash,
       ts_start, region_id, org_unit_id, cost_owning_unit_id, attestation_state)
    VALUES
      ('${CLI}', 'oid-sir', 'sir@example.com', '${DEV}', 'claude-code', 'hashSirCli', '2026-07-01 00:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned'),
      ('${DESKTOP}', 'oid-sir', 'sir@example.com', '${DEV}', 'claude-code', 'hashSirDesk', '2026-07-01 00:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned'),
      ('${SECOND}', 'oid-sir', 'sir@example.com', '${DEV}', 'claude-code', 'hashSirTwo', '2026-07-01 00:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned'),
      ('${COPILOT}', 'oid-sir', 'sir@example.com', '${DEV}', 'copilot-cli', 'hashSirCop', '2026-07-01 00:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned'),
      ('${STRANGER}', 'oid-sir-other', 'sir-other@example.com', '${OTHER_DEV}', 'claude-code', 'hashSirOther', '2026-07-01 00:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash,
       ts_start, ts_actual_end, ts_purged, region_id, org_unit_id, cost_owning_unit_id, attestation_state)
    VALUES
      ('${PURGED}', 'oid-sir', 'sir@example.com', '${DEV}', 'claude-code', 'hashSirPurged', '2026-07-01 00:00:00+00',
       '2026-07-01 01:00:00+00', '2026-07-01 02:00:00+00', '${REGION}', '${OU}', '${OU}', 'unassigned');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('${PROJ}', 'SIR-1', 'h-sir-1', 'SIR project', 'billable', '${REGION}', '${OU}');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('${PROJ}', '${DEV}', '[2026-01-01, 2099-01-01)'::tstzrange);
  `)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('session-to-instance reports (#494)', () => {
  it('books a reported session to the reporting instance, and keeps what the record named', async () => {
    await report(conv(1), DESKTOP)
    const { result } = await join(CLI, [span({ conv: conv(1), runId: 'r1', ts: '2026-07-02T09:00:00Z' })])
    expect(await rowsOf('r1')).toEqual([{ instance_id: DESKTOP, emitted_instance_id: CLI, project_id: null }])
    expect(result.sessionRecordsRepointed).toBe(1)
    expect(result.sessionReportsRefused).toBe(0)
  })

  it('leaves a session with no report exactly as before', async () => {
    const { result } = await join(CLI, [span({ conv: conv(2), runId: 'r2', ts: '2026-07-02T10:00:00Z' })])
    expect(await rowsOf('r2')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionRecordsRepointed).toBe(0)
  })

  it('never follows a report from another teammate’s instance', async () => {
    await report(conv(3), STRANGER)
    const { result } = await join(CLI, [span({ conv: conv(3), runId: 'r3', ts: '2026-07-02T11:00:00Z' })])
    expect(await rowsOf('r3')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionReportsRefused).toBe(1)
  })

  it('never follows a session reported by two instances', async () => {
    await report(conv(4), DESKTOP)
    await report(conv(4), SECOND)
    const { result } = await join(CLI, [span({ conv: conv(4), runId: 'r4', ts: '2026-07-02T12:00:00Z' })])
    expect(await rowsOf('r4')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionReportsRefused).toBe(1)
  })

  it('never follows a session both installs reported', async () => {
    await report(conv(8), CLI)
    await report(conv(8), DESKTOP)
    const { result } = await join(CLI, [span({ conv: conv(8), runId: 'r8', ts: '2026-07-02T13:00:00Z' })])
    expect(await rowsOf('r8')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionReportsRefused).toBe(1)
  })

  it('a lone report by the named instance itself changes nothing and is not a refusal', async () => {
    await report(conv(9), CLI)
    const { result } = await join(CLI, [span({ conv: conv(9), runId: 'r9', ts: '2026-07-02T14:00:00Z' })])
    expect(await rowsOf('r9')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionReportsRefused).toBe(0)
  })

  it('another tool’s instance of the same teammate is not followed', async () => {
    await report(conv(10), COPILOT)
    const { result } = await join(CLI, [span({ conv: conv(10), runId: 'r10', ts: '2026-07-02T15:00:00Z' })])
    expect(await rowsOf('r10')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(result.sessionReportsRefused).toBe(1)
  })

  it('a stranger’s report cannot make the teammate’s own report ambiguous', async () => {
    await report(conv(11), DESKTOP)
    await report(conv(11), STRANGER)
    await join(CLI, [span({ conv: conv(11), runId: 'r11', ts: '2026-07-02T16:00:00Z' })])
    expect(await rowsOf('r11')).toEqual([{ instance_id: DESKTOP, emitted_instance_id: CLI, project_id: null }])
  })

  it('a report by a purged instance is not followed', async () => {
    await report(conv(12), PURGED)
    await join(CLI, [span({ conv: conv(12), runId: 'r12', ts: '2026-07-02T17:00:00Z' })])
    expect(await rowsOf('r12')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
  })

  /*
   * THE DEDUP. A resumed session reports late: its early records were booked to
   * the instance they named, and the next read (the watermark overlap, or a
   * deep rescan) returns them again, now with a report. Keyed on the booked
   * instance, the re-read would insert each a second time under the reported
   * one. The index keys on the emitted instance (mig 0166), so it cannot.
   */
  it('a report that arrives after some rows were booked never books them twice', async () => {
    const early = span({ conv: conv(5), runId: 'r5-early', ts: '2026-07-03T09:00:00Z' })
    await join(CLI, [early])
    await report(conv(5), DESKTOP)
    const late = span({ conv: conv(5), runId: 'r5-late', ts: '2026-07-03T09:01:00Z' })
    const { result } = await join(CLI, [early, late])
    expect(await rowsOf('r5-early')).toEqual([{ instance_id: CLI, emitted_instance_id: null, project_id: null }])
    expect(await rowsOf('r5-late')).toEqual([{ instance_id: DESKTOP, emitted_instance_id: CLI, project_id: null }])
    expect(result.attributionRowsWritten).toBe(1)
  })

  // The fill-only enrichment matches the row on the same key as the index: a
  // row booked as named, re-read after its session reported, is still enriched.
  it('a row booked before its session reported is still enriched on a re-read', async () => {
    const bare = span({ conv: conv(13), runId: 'r13', ts: '2026-07-04T09:00:00Z' })
    await join(CLI, [bare])
    await report(conv(13), DESKTOP)
    await join(CLI, [{ ...bare, emittingEmail: 'sir@example.com' }])
    const [row] = await t.client<{ instance_id: string; emitting_email: string | null }[]>`
      SELECT instance_id::text, emitting_email FROM attribution_record WHERE source_run_id = 'r13'`
    expect(row).toEqual({ instance_id: CLI, emitting_email: 'sir@example.com' })
  })

  it('rows re-pointed away still move the named instance’s watermark', async () => {
    // Its only rows in this window went to DESKTOP: without the moved-rows
    // watermark the next read would get none and re-read the whole window.
    await report(conv(6), DESKTOP)
    const rec = span({ conv: conv(6), runId: 'r6', ts: '2026-07-20T09:00:00Z' })
    await join(CLI, [rec])
    const { reader } = await join(CLI, [rec])
    expect(reader.watermarks[0]?.toISOString()).toBe('2026-07-20T09:00:00.000Z')
  })
})

describe('a project tag committed mid-join (#497)', () => {
  /*
   * The tag's transaction is held open after tagSessionTx (lock held, project
   * set on the session's existing rows, not committed) while the joiner runs.
   * The joiner has already grouped the new record with the session's project
   * fallback as it was (none) when it reaches the write and waits on the lock.
   *   - WITH the fix it re-reads the fallback under the lock, finds the tag,
   *     rolls the unit back and groups again: the row gets the project.
   *   - WITHOUT it the row is written untagged after the tag's UPDATE ran, and
   *     stays untagged.
   */
  it('the joined rows carry the project the tag set', async () => {
    const c = conv(7)
    // After every earlier test's events: CLI's watermark is the latest of them
    // (2026-07-20), and the reader returns nothing older than it.
    await join(CLI, [span({ conv: c, runId: 'r7-first', ts: '2026-07-25T09:00:00Z' })])
    expect(await rowsOf('r7-first')).toHaveLength(1)

    let tagged!: () => void
    const tagApplied = new Promise<void>((r) => (tagged = r))
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    const tagTx = t.db.transaction(async (tx) => {
      await tagSessionTx(
        tx as unknown as TagTx,
        DEV,
        c,
        { setProject: true, projectVal: PROJ, setActivity: false, activityVal: null },
        { actorSystem: 'test' },
      )
      tagged()
      await released
    })
    // A refused tag must fail the test, not leave it waiting on tagApplied.
    await Promise.race([tagApplied, tagTx])

    const joinDone = join(CLI, [span({ conv: c, runId: 'r7-second', ts: '2026-07-25T09:10:00Z' })])
    const poll = { stop: false }
    const outcome = await Promise.race([joinDone.then(() => 'finished' as const), waitForAdvisoryWaiter(poll)])
    poll.stop = true
    release()
    await tagTx
    const { result } = await joinDone

    expect(outcome).toBe('blocked')
    expect((await rowsOf('r7-first'))[0]?.project_id).toBe(PROJ)
    expect((await rowsOf('r7-second'))[0]?.project_id).toBe(PROJ)
    expect(result.projectFallbackRetries).toBe(1)
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
