// @vitest-environment node
/*
 * tagSessionTx — preserved-project axis regression (CORE-1, robustness review
 * 2026-06-09).
 *
 * After a boundary-preserving re-tag (D2a) a conversation legitimately has
 * attribution rows split between an ENDED project X and its successor Y. The
 * old snapshot derived "current project" as MAX(project_id::text) over the
 * ledger — an arbitrary, textually-largest UUID — so a later activity-only tag
 * (setProject=false) silently reverted session_assignment to the ended project.
 * The decision record (session_assignment) is the preserved-project source now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { tagSessionTx } from '../../../server/utils/tag-session'

type TagTx = Parameters<typeof tagSessionTx>[0]

let t: TestDb

const TEAM = '33333333-3333-3333-3333-333333333333'
const INST = '66666666-6666-6666-6666-666666666666'
// X (ENDED) deliberately textually GREATER than Y so MAX() would pick X.
const PROJ_X_ENDED = 'ffffffff-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROJ_Y_SUCCESSOR = '11111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CONV = 'conv-core1-1111'

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    -- X: ENDED (end_date in the past). Y: the live successor.
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id, end_date)
      VALUES ('${PROJ_X_ENDED}', 'OLD-X', 'h-old-x', 'Ended X', 'billable',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
              '2026-05-01 00:00:00+00'),
             ('${PROJ_Y_SUCCESSOR}', 'NEW-Y', 'h-new-y', 'Successor Y', 'billable',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
              NULL);
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('${PROJ_X_ENDED}', '${TEAM}', '[2026-01-01, 2099-01-01)'::tstzrange),
             ('${PROJ_Y_SUCCESSOR}', '${TEAM}', '[2026-01-01, 2099-01-01)'::tstzrange);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INST}', 'oid', 'dev@i.com', '${TEAM}', 'h-old-x', 'OLD-X',
       'claude-code', 'hashS', '2026-04-28 09:00:00+00', '2026-05-02 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
    -- The D2a post-re-tag ledger: pre-end earnings frozen to X, post-end spend on Y.
    INSERT INTO attribution_record
      (instance_id, claude_session_id, teammate_id, project_id, region_id, org_unit_id,
       cost_owning_unit_id, tool, model, token_type, tokens, cost_usd,
       fidelity_tier, cost_basis, ts_event)
    VALUES
      ('${INST}', '${CONV}', '${TEAM}', '${PROJ_X_ENDED}',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222', 'claude-code', 'claude-sonnet-4-7',
       'input', 1000, 0.010000, 'tier-1', 'estimated', '2026-04-30 10:00:00+00'),
      ('${INST}', '${CONV}', '${TEAM}', '${PROJ_Y_SUCCESSOR}',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222', 'claude-code', 'claude-sonnet-4-7',
       'output', 2000, 0.020000, 'tier-1', 'estimated', '2026-05-02 10:00:00+00');
    -- The re-tag DECISION record: the conversation belongs to successor Y.
    INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, source)
      VALUES ('${CONV}', '${TEAM}', '${PROJ_Y_SUCCESSOR}', 'manual');
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('tagSessionTx — activity-only tag preserves the successor project (CORE-1)', () => {
  it('keeps session_assignment on Y after setActivity with setProject=false', async () => {
    const result = await t.db.transaction((tx) =>
      tagSessionTx(tx as unknown as TagTx, TEAM, CONV, {
        setProject: false,
        projectVal: null,
        setActivity: true,
        activityVal: 'testing',
      }, { actorSystem: 'test' }),
    )
    // The preserved project axis must be the DECISION record (Y), never the
    // textually-largest ledger project (the ended X).
    expect(result.project_id).toBe(PROJ_Y_SUCCESSOR)
    expect(result.activity).toBe('testing')
    // Copilot review on PR 496: an activity-only tag names the kept project's
    // code, so /tokenscope:activity does not report "no project".
    expect(result.project_code).toBe('NEW-Y')

    const [row] = await t.client<{ project_id: string; activity: string }[]>`
      SELECT project_id::text AS project_id, activity FROM session_assignment
      WHERE claude_session_id = ${CONV} AND teammate_id = ${TEAM}::uuid`
    expect(row!.project_id).toBe(PROJ_Y_SUCCESSOR)
    expect(row!.activity).toBe('testing')

    // The ledger split is untouched (boundary preservation — X keeps its rows).
    const ledger = await t.client<{ project_id: string }[]>`
      SELECT project_id::text AS project_id FROM attribution_record
      WHERE claude_session_id = ${CONV} ORDER BY ts_event`
    expect(ledger.map((r) => r.project_id)).toEqual([PROJ_X_ENDED, PROJ_Y_SUCCESSOR])
  })

  it('with NO assignment row, falls back to the non-ended ledger rows (never the ended project)', async () => {
    await t.client`DELETE FROM session_assignment WHERE claude_session_id = ${CONV}`
    const result = await t.db.transaction((tx) =>
      tagSessionTx(tx as unknown as TagTx, TEAM, CONV, {
        setProject: false,
        projectVal: null,
        setActivity: true,
        activityVal: 'research',
      }, { actorSystem: 'test' }),
    )
    expect(result.project_id).toBe(PROJ_Y_SUCCESSOR) // non-ended rows only
    expect(result.activity).toBe('research')
  })
})

/*
 * server-api-app:idor:0005 — the ended-state predicate ran BEFORE the
 * membership check, so a non-member probing a project id they don't belong
 * to could learn "this id exists and is ended" (409, WITH the project's code
 * in the detail) before ever being told "you're not a member" (403). The fix
 * reorders membership first: an unknown id, a real ACTIVE project the caller
 * isn't a member of, and a real ENDED project the caller isn't a member of
 * must now be indistinguishable — same status, same body, no code leaked.
 *
 * These assertions FAIL against the pre-fix code (the ended project used to
 * short-circuit to a 409 carrying its code before membership was checked) —
 * confirmed by running this file against a git stash of the ordering fix.
 */
describe('tagSessionTx — membership checked BEFORE ended-state (server-api-app:idor:0005)', () => {
  const NON_MEMBER = '77777777-7777-7777-7777-777777777777'
  const OWNED_CONV = 'conv-idor5-owned-0001'
  const PROJ_ACTIVE_NOTMINE = '88888888-cccc-cccc-cccc-cccccccccccc'
  const PROJ_ENDED_NOTMINE = '99999999-dddd-dddd-dddd-dddddddddddd'
  const UNKNOWN_PROJECT = '00000000-0000-4000-8000-00000000cafe'
  const SECRET_ACTIVE_CODE = 'SECRET-ACTIVE-NOTMINE'
  const SECRET_ENDED_CODE = 'SECRET-ENDED-NOTMINE'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
        VALUES ('${NON_MEMBER}', 'oid-idor5', 'idor5-nonmember@i.com',
                '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
      -- Two REAL projects the caller is NOT assigned to: one active, one ended.
      INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id, end_date)
        VALUES ('${PROJ_ACTIVE_NOTMINE}', '${SECRET_ACTIVE_CODE}', 'h-secret-active-notmine', 'Secret Active', 'billable',
                '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', NULL),
               ('${PROJ_ENDED_NOTMINE}', '${SECRET_ENDED_CODE}', 'h-secret-ended-notmine', 'Secret Ended', 'billable',
                '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
                '2026-05-01 00:00:00+00');
      -- An owned (unallocated) session for NON_MEMBER, so tagSessionTx's own
      -- ownership gate (attribution_record rows for the caller) passes and we
      -- reach the project gate under test.
      INSERT INTO attribution_record
        (instance_id, claude_session_id, teammate_id, project_id, region_id, org_unit_id,
         cost_owning_unit_id, tool, model, token_type, tokens, cost_usd,
         fidelity_tier, cost_basis, ts_event)
      VALUES
        ('${INST}', '${OWNED_CONV}', '${NON_MEMBER}', NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         NULL, 'claude-code', 'claude-sonnet-4-7', 'input', 500, 0.005000,
         'tier-1', 'estimated', '2026-05-05 10:00:00+00');
    `)
  })

  type TagError = { statusCode?: number; statusMessage?: string; data?: unknown }

  async function attemptTag(projectId: string): Promise<TagError> {
    try {
      await t.db.transaction((tx) =>
        tagSessionTx(
          tx as unknown as TagTx,
          NON_MEMBER,
          OWNED_CONV,
          { setProject: true, projectVal: projectId, setActivity: false, activityVal: null },
          { actorSystem: 'test' },
        ),
      )
      throw new Error('expected tagSessionTx to reject the non-member tag')
    } catch (err) {
      return err as TagError
    }
  }

  it('an unknown id, a real ACTIVE non-member project, and a real ENDED non-member project all produce the SAME 403 — no code disclosed', async () => {
    const unknown = await attemptTag(UNKNOWN_PROJECT)
    const active = await attemptTag(PROJ_ACTIVE_NOTMINE)
    const ended = await attemptTag(PROJ_ENDED_NOTMINE)

    for (const err of [unknown, active, ended]) {
      expect(err.statusCode).toBe(403)
      expect(err.statusMessage).toBe('Forbidden')
    }
    // Identical body across all three — no existence/ended-state oracle.
    expect(active.data).toEqual(unknown.data)
    expect(ended.data).toEqual(unknown.data)

    // The 409 "Budget has ended" branch — and the code it would have named —
    // must never be reached by a non-member.
    for (const err of [unknown, active, ended]) {
      expect(err.statusCode).not.toBe(409)
      const serialized = JSON.stringify(err)
      expect(serialized).not.toContain(SECRET_ACTIVE_CODE)
      expect(serialized).not.toContain(SECRET_ENDED_CODE)
    }
  })
})
