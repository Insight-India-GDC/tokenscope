// @vitest-environment node
/*
 * parseLogAnalyticsRows — the pure Log Analytics result-table → UsageRecord
 * mapper. The KQL itself is verified at sandbox bring-up; this locks the
 * mapping logic (column-name keyed, type coercion, skip rules) now.
 */
import { describe, it, expect } from 'vitest'
import {
  parseLogAnalyticsRows,
  parseSignalRows,
  emptyParseCounters,
  buildSessionUsageKql,
  buildSessionUsageKqlGenAI,
  KQL_PROJECTED_COLUMNS,
} from '../../../server/azure/reader'

const COLS = ['TokenscopeSessionId', 'Model', 'TokenType', 'Tokens', 'TsEvent', 'SourceRunId']

describe('parseLogAnalyticsRows', () => {
  it('maps a LAW table to UsageRecords (one per token type)', () => {
    const ts = new Date('2026-06-01T00:00:00Z')
    const rows = [
      ['sid-1', 'claude-opus-4-8', 'input', 1856, ts, 'req_1'],
      ['sid-1', 'claude-opus-4-8', 'output', 4, ts, 'req_1'],
      ['sid-1', 'claude-opus-4-8', 'cache-read', 17308, ts, 'req_1'],
    ]
    const out = parseLogAnalyticsRows(COLS, rows)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      tokens: 1856,
      tokenType: 'input',
      model: 'claude-opus-4-8',
      tsEvent: '2026-06-01T00:00:00.000Z',
      sourceRunId: 'req_1',
    })
    expect(out[2]!.tokenType).toBe('cache-read')
    expect(out[2]!.tokens).toBe(17308)
  })

  it('is column-order independent (keyed by name)', () => {
    const reordered = ['Tokens', 'TokenType', 'TsEvent', 'Model', 'SourceRunId', 'TokenscopeSessionId']
    const out = parseLogAnalyticsRows(reordered, [[500, 'output', '2026-06-01T00:00:00Z', 'm', 'r', 's']])
    expect(out[0]).toMatchObject({ tokens: 500, tokenType: 'output', model: 'm', sourceRunId: 'r' })
  })

  it('skips rows with zero/empty tokens or missing token type', () => {
    const out = parseLogAnalyticsRows(COLS, [
      ['s', 'm', 'input', 0, '2026-06-01T00:00:00Z', 'r'], // zero → skip
      ['s', 'm', '', 100, '2026-06-01T00:00:00Z', 'r'], // no type → skip
      ['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r'], // keep
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(100)
  })

  it('tolerates string-typed token counts + missing SourceRunId', () => {
    const out = parseLogAnalyticsRows(['TokenType', 'Tokens', 'Model', 'TsEvent'], [
      ['input', '442', 'm', '2026-06-01T00:00:00Z'],
    ])
    expect(out[0]!.tokens).toBe(442)
    expect(out[0]!.sourceRunId).toBeUndefined()
  })

  it('ING-9: skips + counts rows with a missing/unparseable TsEvent instead of fabricating now()', () => {
    // Fabricating now() gave the row a DIFFERENT synthetic ts every tick, so the
    // dedup index never matched and the same event double-counted on every read.
    const rows = [
      ['s', 'm', 'input', 100, null, 'r'], // null ts → skip
      ['s', 'm', 'input', 100, 'not-a-date', 'r'], // unparseable → skip
      ['s', 'm', 'input', 100, '', 'r'], // empty → skip
      ['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r'], // keep
    ]
    const counters = { skippedNoTimestamp: 0 }
    const out = parseLogAnalyticsRows(COLS, rows, counters)
    expect(out).toHaveLength(1)
    expect(out[0]!.tsEvent).toBe('2026-06-01T00:00:00Z')
    expect(counters.skippedNoTimestamp).toBe(3)

    // Parsing the SAME table twice yields identical output (no per-call now())
    // and the same skip count — the null-ts row can never double-count.
    const counters2 = { skippedNoTimestamp: 0 }
    const out2 = parseLogAnalyticsRows(COLS, rows, counters2)
    expect(out2).toEqual(out)
    expect(counters2.skippedNoTimestamp).toBe(3)
  })

  it('mig 0045: surfaces QuerySource + LawCostUsd when present, omits them otherwise', () => {
    const cols = [...COLS, 'QuerySource', 'LawCostUsd']
    const out = parseLogAnalyticsRows(cols, [
      ['sid-1', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', 'main', 0.0123],
      ['sid-1', 'm', 'output', 5, '2026-06-01T00:00:00Z', 'r', 'side_question', '0.0004'],
    ])
    expect(out[0]!.querySource).toBe('main')
    expect(out[0]!.lawCostUsd).toBe(0.0123)
    // string-typed cost coerces (LAW dynamic columns can stringify)
    expect(out[1]!.querySource).toBe('side_question')
    expect(out[1]!.lawCostUsd).toBe(0.0004)

    // Absent columns / empty values → undefined (legacy emission shape).
    const legacy = parseLogAnalyticsRows(COLS, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r']])
    expect(legacy[0]!.querySource).toBeUndefined()
    expect(legacy[0]!.lawCostUsd).toBeUndefined()
    const empty = parseLogAnalyticsRows(cols, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', '', '']])
    expect(empty[0]!.querySource).toBeUndefined()
    expect(empty[0]!.lawCostUsd).toBeUndefined()
  })

  it('surfaces the emitted ProjectCodeHash (ADR-0004 B′) when present, omits it otherwise', () => {
    const withProj = parseLogAnalyticsRows(
      [...COLS, 'OrganizationId', 'ProjectCodeHash'],
      [['sid-1', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', 'org-x', 'h-repo-a']],
    )
    expect(withProj[0]!.projectCodeHash).toBe('h-repo-a')

    // No ProjectCodeHash column (or empty) → undefined (record stays untagged).
    expect(parseLogAnalyticsRows(COLS, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r']])[0]!.projectCodeHash)
      .toBeUndefined()
    expect(parseLogAnalyticsRows([...COLS, 'ProjectCodeHash'],
      [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', '']])[0]!.projectCodeHash)
      .toBeUndefined()
  })
})

/*
 * S10 — ingest bounds. claudeSessionId, model, projectCodeHash and
 * sourceRunId are all EMITTER-CONTROLLED strings; an over-length or
 * control-character value must be REJECTED (never truncated) and COUNTED on
 * the caller-supplied ParseCounters — the counter is the non-negotiable half
 * of the story (bounds without it are strictly worse than no bounds).
 */
describe('parseLogAnalyticsRows — ingest bounds (S10)', () => {
  const BASE_TS = '2026-06-01T00:00:00Z'
  const VALID_SESSION_ID = '11111111-1111-4111-8111-111111111111' // UUID shape, 36 chars
  const VALID_MODEL = 'claude-opus-4-8'
  const VALID_HASH = 'a'.repeat(64) // hex-SHA-256 shape
  const VALID_RUN_ID = 'req_01AbCdEfGhIjKlMnOpQrStUvWx'
  const FULL_COLS = [...COLS, 'OrganizationId', 'ProjectCodeHash', 'ClaudeSessionId']

  it('passes normal UUID/model/hash/run-id values byte-identically (regression pin — catches a too-strict charset)', () => {
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      FULL_COLS,
      [['sid-1', VALID_MODEL, 'input', 100, BASE_TS, VALID_RUN_ID, 'org-1', VALID_HASH, VALID_SESSION_ID]],
      counters,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      model: VALID_MODEL,
      sourceRunId: VALID_RUN_ID,
      projectCodeHash: VALID_HASH,
      claudeSessionId: VALID_SESSION_ID,
    })
    expect(counters).toEqual(emptyParseCounters())
  })

  it('rejects an over-length claudeSessionId: drops ONLY the field, keeps the row, counts it', () => {
    const oversized = 'a'.repeat(129) // > MAX_CLAUDE_SESSION_ID_LENGTH (128)
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      FULL_COLS,
      [['sid-1', VALID_MODEL, 'input', 100, BASE_TS, VALID_RUN_ID, 'org-1', VALID_HASH, oversized]],
      counters,
    )
    expect(out).toHaveLength(1) // the row is NOT dropped — claudeSessionId is optional
    expect(out[0]!.claudeSessionId).toBeUndefined() // dropped, never stored truncated/raw
    expect(out[0]!.tokens).toBe(100) // the rest of the record is intact
    expect(counters.rejectedClaudeSessionId).toBe(1)
  })

  it('rejects a claudeSessionId carrying an unsafe character (charset, not just length)', () => {
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      FULL_COLS,
      [['sid-1', VALID_MODEL, 'input', 100, BASE_TS, VALID_RUN_ID, 'org-1', VALID_HASH, `id' OR 1=1`]],
      counters,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.claudeSessionId).toBeUndefined()
    expect(counters.rejectedClaudeSessionId).toBe(1)
  })

  it('rejects an over-length sourceRunId: drops ONLY the field, keeps the row, counts it', () => {
    const oversized = 'r'.repeat(129) // > MAX_SOURCE_RUN_ID_LENGTH (128)
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(COLS, [['sid-1', VALID_MODEL, 'input', 100, BASE_TS, oversized]], counters)
    expect(out).toHaveLength(1)
    expect(out[0]!.sourceRunId).toBeUndefined()
    expect(counters.rejectedSourceRunId).toBe(1)
  })

  it('rejects an over-length projectCodeHash: drops ONLY the field, keeps the row, counts it', () => {
    const oversized = 'h'.repeat(129) // > MAX_PROJECT_CODE_HASH_LENGTH (128)
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      [...COLS, 'ProjectCodeHash'],
      [['sid-1', VALID_MODEL, 'input', 100, BASE_TS, VALID_RUN_ID, oversized]],
      counters,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.projectCodeHash).toBeUndefined()
    expect(counters.rejectedProjectCodeHash).toBe(1)
  })

  it('rejects an over-length model: SKIPS THE WHOLE ROW (model is required, unlike the optional fields above) and counts it; a rejected record does not abort the row batch', () => {
    const oversized = 'm'.repeat(257) // > MAX_MODEL_LENGTH (256)
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      COLS,
      [
        ['sid-1', oversized, 'input', 100, BASE_TS, VALID_RUN_ID], // rejected
        ['sid-1', VALID_MODEL, 'output', 50, BASE_TS, VALID_RUN_ID], // sibling row in the SAME batch — must survive
      ],
      counters,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.model).toBe(VALID_MODEL)
    expect(counters.rejectedModel).toBe(1)
  })

  it('rejects a model carrying a control character (charset, not just length)', () => {
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(
      COLS,
      [['sid-1', 'bad\x00model', 'input', 100, BASE_TS, VALID_RUN_ID]],
      counters,
    )
    expect(out).toHaveLength(0)
    expect(counters.rejectedModel).toBe(1)
  })

  it('does NOT constrain vendor SHAPE — unicode/punctuation in model or hash still passes (only length + control chars are bounded)', () => {
    const counters = emptyParseCounters()
    const unicodeModel = 'claude-企業-4.8 (preview)'
    const out = parseLogAnalyticsRows(COLS, [['sid-1', unicodeModel, 'input', 100, BASE_TS, VALID_RUN_ID]], counters)
    expect(out[0]!.model).toBe(unicodeModel)
    expect(counters.rejectedModel).toBe(0)
  })
})

// parseSignalRows — the pure usage_signal table → SignalRecord mapper (mig 0065).
// One row (span) fans out to one SignalRecord per PRESENT signal column.
const SIG_COLS = ['_ts', '_req', 'tool_count', 'mcp_count', 'ctx_pct', 'turn_count']

describe('parseSignalRows', () => {
  it('fans a chat-signal row out to one record per present signal (tool_count + ctx_pct)', () => {
    const ts = new Date('2026-06-01T00:00:00Z')
    // chat span: tool_count + ctx_pct present; mcp_count + turn_count null
    const out = parseSignalRows(SIG_COLS, [[ts, 'span-chat', 38, null, 12, null]])
    expect(out).toHaveLength(2)
    expect(out).toContainEqual({ signalName: 'tool_count', value: 38, tsEvent: ts.toISOString(), sourceRunId: 'span-chat' })
    expect(out).toContainEqual({ signalName: 'ctx_pct', value: 12, tsEvent: ts.toISOString(), sourceRunId: 'span-chat' })
  })

  it('fans an invoke_agent-signal row out to mcp_count + turn_count', () => {
    const out = parseSignalRows(SIG_COLS, [['2026-06-01T00:00:00Z', 'span-inv', null, 4, null, 7]])
    expect(out.map((r) => r.signalName).sort()).toEqual(['mcp_count', 'turn_count'])
    expect(out.find((r) => r.signalName === 'turn_count')!.value).toBe(7)
  })

  it('is column-order independent (keyed by name) and tolerates string values', () => {
    const reordered = ['turn_count', '_req', 'ctx_pct', '_ts', 'tool_count', 'mcp_count']
    const out = parseSignalRows(reordered, [['9', 'r', '85', '2026-06-01T00:00:00Z', '20', '']])
    // turn_count=9, ctx_pct=85, tool_count=20; mcp_count empty → omitted
    expect(out.map((r) => r.signalName).sort()).toEqual(['ctx_pct', 'tool_count', 'turn_count'])
    expect(out.find((r) => r.signalName === 'ctx_pct')!.value).toBe(85)
  })

  it('skips null/empty/NaN/negative signal values (a chat span has no mcp_count)', () => {
    const out = parseSignalRows(SIG_COLS, [['2026-06-01T00:00:00Z', 'r', 'NaN', -3, '', 5]])
    // tool_count NaN → skip; mcp_count -3 → skip; ctx_pct '' → skip; turn_count 5 → keep
    expect(out).toEqual([{ signalName: 'turn_count', value: 5, tsEvent: '2026-06-01T00:00:00Z', sourceRunId: 'r' }])
  })

  it('ING-9: skips + counts rows with no parseable timestamp (never fabricates)', () => {
    const rows = [
      [null, 'r', 38, null, null, null], // null ts → skip
      ['not-a-date', 'r', 38, null, null, null], // unparseable → skip
      ['2026-06-01T00:00:00Z', 'r', 38, null, null, null], // keep
    ]
    const counters = { skippedNoTimestamp: 0 }
    const out = parseSignalRows(SIG_COLS, rows, counters)
    expect(out).toHaveLength(1)
    expect(counters.skippedNoTimestamp).toBe(2)
    // idempotent: re-parsing yields identical output (no per-call now())
    expect(parseSignalRows(SIG_COLS, rows, { skippedNoTimestamp: 0 })).toEqual(out)
  })

  it('omits sourceRunId when _req is absent/empty', () => {
    const out = parseSignalRows(['_ts', 'tool_count'], [['2026-06-01T00:00:00Z', 30]])
    expect(out[0]!.sourceRunId).toBeUndefined()
  })
})

/*
 * S10 — sibling of parseLogAnalyticsRows's ingest bounds. parseSignalRows
 * shares the sourceRunId field (and the identical counters shape) — "walk the
 * sibling path": whatever bound landed on parseLogAnalyticsRows lands here too.
 */
describe('parseSignalRows — ingest bounds (S10, sibling of parseLogAnalyticsRows)', () => {
  const ts = new Date('2026-06-01T00:00:00Z')

  it('passes a normal run-id byte-identically (regression pin)', () => {
    const counters = emptyParseCounters()
    const out = parseSignalRows(SIG_COLS, [[ts, 'req_ok-1', 38, null, null, null]], counters)
    expect(out[0]!.sourceRunId).toBe('req_ok-1')
    expect(counters.rejectedSourceRunId).toBe(0)
  })

  it('rejects an over-length sourceRunId: drops ONLY the field, keeps the signal rows, counts it', () => {
    const oversized = 'r'.repeat(129) // > MAX_SOURCE_RUN_ID_LENGTH (128)
    const counters = emptyParseCounters()
    const out = parseSignalRows(SIG_COLS, [[ts, oversized, 38, null, 12, null]], counters)
    // the row is NOT dropped — sourceRunId is optional on SignalRecord too
    expect(out).toHaveLength(2) // tool_count + ctx_pct, same as the unbounded-id case
    expect(out.every((r) => r.sourceRunId === undefined)).toBe(true)
    expect(counters.rejectedSourceRunId).toBe(1)
  })

  it('rejects a sourceRunId carrying an unsafe character (charset, not just length)', () => {
    const counters = emptyParseCounters()
    const out = parseSignalRows(SIG_COLS, [[ts, `r' OR 1=1`, 38, null, null, null]], counters)
    expect(out[0]!.sourceRunId).toBeUndefined()
    expect(counters.rejectedSourceRunId).toBe(1)
  })
})

/*
 * ── Emitting identity at the ingest boundary (mig 0119) ─────────────────────
 * docs/design/emitting-identity-and-subscription-type.md §2, §5.
 *
 * `user.email` says WHICH ACCOUNT was signed in — the evidence the joiner stamps
 * attribution_record.billing_lane from. Two properties are pinned here because
 * both fail silently and both fail for a WHOLE COHORT at once:
 *
 *   1. It is CANONICALISED at storage. Set membership is the one comparison
 *      shape where a case mismatch misclassifies every record of every teammate
 *      whose IdP happens to send mixed case, and the wrong answer (self-billed)
 *      looks exactly like a real verdict.
 *   2. An unsafe value drops the FIELD, not the row. Declining to classify is
 *      always a better trade than losing the spend.
 */
const IDENT_COLS = ['TokenType', 'Tokens', 'Model', 'TsEvent', 'UserEmail', 'OrganizationId']

describe('parseLogAnalyticsRows — emitting identity (mig 0119)', () => {
  const row = (email: unknown, org: unknown = null) => [
    ['output', 100, 'm', '2026-07-01T00:00:00Z', email, org],
  ]

  it('canonicalises user.email at STORAGE — trim + lowercase, once, so no consumer has to', () => {
    const out = parseLogAnalyticsRows(IDENT_COLS, row('  DEV@example.com  '))
    expect(out[0]!.emittingEmail).toBe('dev@example.com')
  })

  it('treats an absent or all-whitespace address as ABSENT, never as an address that failed to match', () => {
    // The two mean different things: absent → billing_lane 'unknown' (today's
    // behaviour); non-matching → 'self-billed' (a verdict about a real account).
    expect(parseLogAnalyticsRows(IDENT_COLS, row(null))[0]!.emittingEmail).toBeUndefined()
    expect(parseLogAnalyticsRows(IDENT_COLS, row(''))[0]!.emittingEmail).toBeUndefined()
    expect(parseLogAnalyticsRows(IDENT_COLS, row('   '))[0]!.emittingEmail).toBeUndefined()
  })

  it('rejects an over-length address: drops ONLY the field, KEEPS the row, counts it', () => {
    const counters = emptyParseCounters()
    const oversized = `${'a'.repeat(310)}@example.com` // > MAX_EMITTING_EMAIL_LENGTH (320)
    const out = parseLogAnalyticsRows(IDENT_COLS, row(oversized), counters)
    expect(out).toHaveLength(1) // the spend survives — this is NOT the `model` shape
    expect(out[0]!.emittingEmail).toBeUndefined()
    expect(counters.rejectedEmittingEmail).toBe(1)
  })

  it('rejects an address carrying a control character (charset, not just length)', () => {
    const counters = emptyParseCounters()
    const out = parseLogAnalyticsRows(IDENT_COLS, row('dev\x01@example.com'), counters)
    expect(out).toHaveLength(1)
    expect(out[0]!.emittingEmail).toBeUndefined()
    expect(counters.rejectedEmittingEmail).toBe(1)
  })

  it('organization.id: the PERSISTED copy is bounded, the LANE operand stays raw', () => {
    /*
     * One wire value, two fields, because they answer to different masters.
     * `emittingOrgId` becomes attribution_record.emitting_org_id — an
     * emitter-controlled text column, so it takes the ingest bound.
     * `organizationId` is a query parameter against provider_org and is never
     * stored, so bounding it would make a new diagnostic column's storage limit
     * change which reconciliation lane an existing record lands in.
     *
     * MUTATION: fold the two back into one bounded field (`rec.organizationId =
     * bounded`) → the over-long case's `organizationId` goes undefined and this
     * goes red.
     */
    const counters = emptyParseCounters()
    const ok = parseLogAnalyticsRows(IDENT_COLS, row(null, 'org-abc123'), counters)
    expect(ok[0]!.organizationId).toBe('org-abc123')
    expect(ok[0]!.emittingOrgId).toBe('org-abc123')
    expect(counters.rejectedOrganizationId).toBe(0)

    const oversized = 'o'.repeat(129) // > MAX_ORGANIZATION_ID_LENGTH (128)
    const bad = parseLogAnalyticsRows(IDENT_COLS, row(null, oversized), counters)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.organizationId).toBe(oversized) // the lane still gets its operand…
    expect(bad[0]!.emittingOrgId).toBeUndefined() // …and nothing over-long is stored
    expect(counters.rejectedOrganizationId).toBe(1)

    // A control character is refused on the same terms — charset, not just length.
    const ctrl = parseLogAnalyticsRows(IDENT_COLS, row(null, 'org-\x01abc'), counters)
    expect(ctrl[0]!.organizationId).toBe('org-\x01abc')
    expect(ctrl[0]!.emittingOrgId).toBeUndefined()
    expect(counters.rejectedOrganizationId).toBe(2)
  })
})

/*
 * The final `| project` clause is GENERATED from KQL_PROJECTED_COLUMNS, but the
 * intermediate `| project` that carries each alias through to it is hand-written.
 * That seam is the one the single-sourcing does NOT close: drop an alias there
 * and the query fails at Log Analytics, where no stubbed-reader test can reach it
 * and the symptom is an empty read rather than an error anyone attributes here.
 */
describe('buildSessionUsageKql — the intermediate projection carries every alias', () => {
  const SID = '00000000-0000-4000-8000-000000000001'

  it('forwards every `_alias` the final projection consumes through the intermediate one', () => {
    const kql = buildSessionUsageKql(SID)
    // The intermediate `| project` is everything between the FIRST `| project`
    // and the `| mv-expand` that fans a span into its token-type rows. An alias
    // absent from that slice is dropped before the final projection can name it.
    const start = kql.indexOf('| project ')
    const end = kql.indexOf('| mv-expand')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const intermediate = kql.slice(start, end)
    const finalProject = kql.slice(kql.lastIndexOf('| project '))

    const aliases = Object.values(KQL_PROJECTED_COLUMNS).filter((e) => e.startsWith('_'))
    expect(aliases.length).toBeGreaterThan(10) // anti-vacuity
    for (const alias of aliases) {
      expect(finalProject, `${alias} must be consumed by the final projection`).toContain(alias)
      expect(intermediate, `${alias} must survive the intermediate projection`).toContain(alias)
    }
  })

  it('reads the emitting account from Attributes[user.email]', () => {
    expect(buildSessionUsageKql(SID)).toContain("_uemail = tostring(Attributes['user.email'])")
  })
  it('reads the folder default activity from ResourceAttributes[tokenscope.activity] in both builders (#475)', () => {
    expect(KQL_PROJECTED_COLUMNS.Activity).toBe('_act')
    for (const kql of [buildSessionUsageKql(SID), buildSessionUsageKqlGenAI(SID)]) {
      expect(kql).toContain("_act = tostring(ResourceAttributes['tokenscope.activity'])")
      expect(kql).toContain('Activity = _act')
    }
  })
})

/*
 * #475 — tokenscope.activity, the folder's default activity. Optional-field
 * shape: a bad value drops the field, keeps the row, and is counted. The
 * vocabulary gate is the joiner's; the parser only decodes and bounds.
 */
describe('parseLogAnalyticsRows — tokenscope.activity (#475)', () => {
  const ACT_COLS = [...COLS, 'Activity']
  const row = (act: unknown) => [['sid-1', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', act]]

  it('surfaces a plain label, trimmed', () => {
    expect(parseLogAnalyticsRows(ACT_COLS, row('  Code review '))[0]!.activity).toBe('Code review')
  })

  it('decodes a percent-encoded value (OTEL_RESOURCE_ATTRIBUTES encoding)', () => {
    expect(parseLogAnalyticsRows(ACT_COLS, row('code%20review'))[0]!.activity).toBe('code review')
    expect(parseLogAnalyticsRows(ACT_COLS, row('R%C3%A9sum%C3%A9'))[0]!.activity).toBe('Résumé')
    // A bare % with no hex pair is not an encoding: left as it is.
    expect(parseLogAnalyticsRows(ACT_COLS, row('100%'))[0]!.activity).toBe('100%')
  })

  it('treats absent, empty or blank as absent, not as a reject', () => {
    const counters = emptyParseCounters()
    expect(parseLogAnalyticsRows(COLS, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r']], counters)[0]!.activity).toBeUndefined()
    expect(parseLogAnalyticsRows(ACT_COLS, row(''), counters)[0]!.activity).toBeUndefined()
    expect(parseLogAnalyticsRows(ACT_COLS, row(null), counters)[0]!.activity).toBeUndefined()
    expect(parseLogAnalyticsRows(ACT_COLS, row('   '), counters)[0]!.activity).toBeUndefined()
    expect(counters.rejectedActivity).toBe(0)
  })

  it('rejects over-length, control characters (raw or encoded) and bad encoding: drops ONLY the field, counts it', () => {
    const counters = emptyParseCounters()
    const bad = [
      'a'.repeat(65), // > ACTIVITY_LABEL_MAX (64)
      '%61'.repeat(65), // decodes past the bound
      'x'.repeat(64 * 12 + 1), // too long to be worth decoding
      'code\nreview',
      'code%0Areview', // an encoded newline is still a newline
      'code\u009breview', // C1 (CSI) as well as C0
      '%E0%A4%A', // malformed percent-encoding
    ]
    for (const v of bad) {
      const out = parseLogAnalyticsRows(ACT_COLS, row(v), counters)
      expect(out, JSON.stringify(v)).toHaveLength(1)
      expect(out[0]!.activity, JSON.stringify(v)).toBeUndefined()
    }
    expect(counters.rejectedActivity).toBe(bad.length)
    // Exactly at the bound passes, counted in code points (an emoji is one).
    expect(parseLogAnalyticsRows(ACT_COLS, row('\u{1F600}'.repeat(64)))[0]!.activity).toBe('\u{1F600}'.repeat(64))
  })
})
