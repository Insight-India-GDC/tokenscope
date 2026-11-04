import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  mapUsageEvent,
  usageRequestId,
  querySourceFor,
  ctxPct,
  emitMode,
  readUsageDrift,
  encodable,
  countInt,
  invalidUsageCounts,
  surfaceOf,
  buildBatches,
  createSpool,
  createUsageEmitter,
  WRITER_STALE_MS,
} from '../../../plugin/scripts/copilot-usage.mjs'
import { compare, jsonl } from '../../../scripts/copilot-usage-parity.mjs'
import { extensionsEnabled } from '../../../plugin/scripts/copilot-emit.mjs'
import { SIGNAL_WIRE_COLUMNS } from '../../../server/azure/reader'

// Windows (#430): skipped on win32 because this file asserts POSIX file mode 0600; Windows reports 0666.
const POSIX_ONLY = process.platform === 'win32'

const SID = '81bf258d-aca2-45b1-b317-c964b6c98390'
const INSTANCE = '9a1e0000-0000-4000-8000-000000000001'
// Reader bound for request_id / session.id (server/azure/reader.ts).
const READER_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

type Attr = { key: string; value: Record<string, string> }
type Rec = { timeUnixNano: string; attributes: Attr[] }
const attr = (r: Rec, k: string) => {
  const v = r.attributes.find((a) => a.key === k)?.value
  return v ? Object.values(v)[0] : undefined
}

// Shapes captured from a live CLI 1.0.88 run (docs/design/copilot-usage-extension.md §Parity).
function usage(over: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  return {
    type: 'assistant.usage',
    id: 'e1',
    timestamp: '2026-09-23T13:35:05.153Z',
    ...env,
    data: {
      model: 'gpt-5-mini',
      inputTokens: 11830,
      outputTokens: 1680,
      cacheReadTokens: 7936,
      cacheWriteTokens: 0,
      reasoningTokens: 1536,
      initiator: 'user',
      interactionType: 'conversation-agent',
      apiCallId: '1FafLXukvQix+PRA8doND2iLvRptj7id/SBCeaF2qXrVKhrSk82KqUz==',
      copilotUsage: { totalNanoAiu: 453190000 },
      ...over,
    },
  }
}

describe.skipIf(POSIX_ONLY)('mapUsageEvent', () => {
  it('maps assistant.usage onto the forwarder api_request shape', () => {
    const r = mapUsageEvent(usage(), SID) as Rec
    expect(attr(r, 'event.name')).toBe('api_request')
    expect(attr(r, 'session.id')).toBe(SID)
    expect(attr(r, 'model')).toBe('gpt-5-mini')
    expect(attr(r, 'input_tokens')).toBe('11830')
    expect(attr(r, 'output_tokens')).toBe('1680')
    expect(attr(r, 'cache_read_tokens')).toBe('7936')
    expect(attr(r, 'cache_creation_tokens')).toBe('0')
    expect(attr(r, 'query_source')).toBe('main')
    expect(attr(r, 'github.copilot.nano_aiu')).toBe('453190000')
    expect(r.timeUnixNano).toBe(String(Date.parse('2026-09-23T13:35:05.153Z') * 1_000_000))
  })

  it('derives a stable, reader-safe request_id from the provider call id', () => {
    const a = attr(mapUsageEvent(usage(), SID) as Rec, 'request_id') as string
    const b = attr(mapUsageEvent(usage({}, { id: 'other' }), SID) as Rec, 'request_id') as string
    expect(a).toMatch(READER_SAFE)
    expect(a.length).toBeLessThanOrEqual(128)
    expect(a).toBe(b)
    expect(usageRequestId({}, 'evt-1')).toMatch(READER_SAFE)
    expect(usageRequestId({}, undefined)).toBeNull()
  })

  it('rejects other events and an unsafe session id', () => {
    expect(mapUsageEvent({ ...usage(), type: 'assistant.message' }, SID)).toBeNull()
    expect(mapUsageEvent(usage(), 'a:b')).toBeNull()
  })

  it('omits nano_aiu when absent or garbage, and zero-fills one bad token count', () => {
    const r = mapUsageEvent(usage({ copilotUsage: { totalNanoAiu: -1 }, outputTokens: 'x' }), SID) as Rec
    expect(attr(r, 'github.copilot.nano_aiu')).toBeUndefined()
    expect(attr(r, 'output_tokens')).toBe('0')
  })

  it('every accepted value encodes: a far-future time falls back to now, a 1e30 count is 0 and reported invalid', () => {
    const r = mapUsageEvent(usage({ inputTokens: 1e30, outputTokens: -5 }, { timestamp: '+010000-01-01T00:00:00Z' }), SID) as Rec
    expect(BigInt(r.timeUnixNano)).toBeLessThanOrEqual(18446744073709551615n)
    expect(attr(r, 'input_tokens')).toBe('0')
    expect(encodable({ r, h: null, o: null })).toBe(true)
    expect(invalidUsageCounts({ inputTokens: 1e30, outputTokens: -5, cacheReadTokens: 3 })).toEqual(['inputTokens', 'outputTokens'])
    expect(invalidUsageCounts({ inputTokens: 5 })).toEqual([]) // absent fields are 0, not invalid
  })

  it('refuses an event with no token counts at all (contract drift, not zero usage)', () => {
    expect(mapUsageEvent(usage({ inputTokens: undefined, outputTokens: undefined }), SID)).toBeNull()
  })
})

describe.skipIf(POSIX_ONLY)('lanes, context, mode', () => {
  it('classifies conversation turns (incl. subagents) as main, others as their own aux token', () => {
    expect(querySourceFor({ interactionType: 'conversation-agent', initiator: 'agent' })).toBe('main')
    expect(querySourceFor({ interactionType: 'conversation-subagent' })).toBe('main')
    expect(querySourceFor({})).toBe('main')
    expect(querySourceFor({ interactionType: 'conversation-compaction' })).toBe('compaction')
  })

  it('computes a capped context %', () => {
    expect(ctxPct({ currentTokens: 12935, tokenLimit: 128000 })).toBe(10)
    expect(ctxPct({ currentTokens: 500, tokenLimit: 100 })).toBe(100)
    expect(ctxPct({ currentTokens: 5 })).toBeNull()
  })

  it('shadows while the span exporter (the forwarder lane) is live', () => {
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' })).toBe('shadow')
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '/home/u/proj/.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' })).toBe('shadow')
    // Any other file is one the forwarder never reads: the extension must send.
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '/x/spans.jsonl' })).toBe('send')
    // A migrated device (extensions on): the forwarder idles, so an old terminal is sent.
    const ch = fs.mkdtempSync(join(os.tmpdir(), 'ts-ch-'))
    try {
      fs.writeFileSync(join(ch, 'settings.json'), JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
      expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: ch })).toBe('send')
      // JSONC written by hand counts; extension mode 'disabled' means NOT migrated.
      fs.writeFileSync(join(ch, 'settings.json'), '// mine\n{ "enabledFeatureFlags": { "EXTENSIONS": true, }, }\n')
      expect(extensionsEnabled({ COPILOT_HOME: ch })).toBe(true)
      fs.writeFileSync(join(ch, 'settings.json'), JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true }, extensions: { mode: 'disabled' } }))
      expect(extensionsEnabled({ COPILOT_HOME: ch })).toBe(false)
      // TokenScope's own extension switched off in /extensions: not migrated either.
      fs.writeFileSync(join(ch, 'settings.json'), JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true }, extensions: { disabledExtensions: ['plugin:tokenscope:tokenscope-usage'] } }))
      expect(extensionsEnabled({ COPILOT_HOME: ch })).toBe(false)
      // Copilot's legacy config.json wins over settings.json.
      fs.writeFileSync(join(ch, 'settings.json'), JSON.stringify({ enabledFeatureFlags: { EXTENSIONS: true } }))
      fs.writeFileSync(join(ch, 'config.json'), JSON.stringify({ extensions: { mode: 'disabled' } }))
      expect(extensionsEnabled({ COPILOT_HOME: ch })).toBe(false)
    } finally {
      fs.rmSync(ch, { recursive: true, force: true })
    }
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: ' ' })).toBe('send')
    expect(emitMode({})).toBe('send')
    expect(surfaceOf({ AI_AGENT: 'github_copilot_app_agent' })).toBe('app')
    expect(surfaceOf({})).toBe('cli')
  })
})

describe.skipIf(POSIX_ONLY)('buildBatches', () => {
  it('groups by (code hash, org), stamps instance + emitter from the caller, never the entry', () => {
    const r = mapUsageEvent(usage(), SID)
    const batches = buildBatches(
      [
        { r, h: 'h1', o: 'org1' },
        { r, h: 'h1', o: 'org1' },
        { r, h: null, o: null },
      ],
      INSTANCE,
      { surface: 'app' },
    )
    expect(batches).toHaveLength(2)
    const res = batches[0].payload.resourceLogs[0].resource.attributes as Attr[]
    const get = (k: string) => res.find((a) => a.key === k)?.value.stringValue
    expect(get('tokenscope.instance_id')).toBe(INSTANCE)
    expect(get('tool')).toBe('copilot-cli')
    expect(get('project.code_hash')).toBe('h1')
    expect(get('github.org')).toBe('org1')
    expect(get('tokenscope.emitter')).toBe('extension')
    expect(get('copilot.surface')).toBe('app')
    const bare = batches[1].payload.resourceLogs[0].resource.attributes as Attr[]
    expect(bare.map((a) => a.key)).not.toContain('project.code_hash')
  })

  it("keeps each entry's own surface: an adopted App record is not relabelled by a CLI sender", () => {
    const r = mapUsageEvent(usage(), SID)
    const batches = buildBatches(
      [
        { r, h: 'h1', o: 'org1', s: 'app' },
        { r, h: 'h1', o: 'org1', s: 'cli' },
        { r, h: 'h1', o: 'org1' },
      ],
      INSTANCE,
      { surface: 'cli' },
    )
    const surfaces = batches.map(
      (b) => (b.payload.resourceLogs[0].resource.attributes as Attr[]).find((a) => a.key === 'copilot.surface')?.value.stringValue,
    )
    expect(batches).toHaveLength(2)
    expect(surfaces.sort()).toEqual(['app', 'cli'])
    expect(batches.find((b) => b.entries[0].s === 'app')!.entries).toHaveLength(1)
  })
})

describe.skipIf(POSIX_ONLY)('createUsageEmitter', () => {
  let dir: string
  const posts: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = []
  let status = 204

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'ts-usage-'))
    posts.length = 0
    status = 204
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function make(over: Record<string, unknown> = {}) {
    return createUsageEmitter({
      stateDir: dir,
      sessionId: SID,
      env: {},
      debounceMs: 60_000,
      isProvisioned: () => true,
      loadConfig: () => ({ instance_id: INSTANCE, logs_endpoint: 'https://ingest.example/v1/logs' }),
      mint: () => 'Bearer t',
      post: async (url: string, headers: Record<string, string>, body: Uint8Array) => {
        posts.push({ url, headers, body })
        return { status }
      },
      resolveProjectCodeHash: () => 'hash1',
      resolveGithubOrg: () => 'acme-appdev',
      ...over,
    })
  }
  const spoolFiles = () => {
    try {
      return fs.readdirSync(join(dir, 'copilot-usage-spool')).filter((n) => !n.startsWith('.hb-'))
    } catch {
      return []
    }
  }

  it('spools before sending and drains the spool on 2xx', async () => {
    const em = make()
    em.onEvent({ type: 'session.usage_info', data: { currentTokens: 12935, tokenLimit: 128000 } })
    em.onEvent(usage())
    expect(spoolFiles()).toHaveLength(1)
    const mode = fs.statSync(join(dir, 'copilot-usage-spool', spoolFiles()[0])).mode & 0o777
    expect(mode).toBe(0o600)
    const res = await em.close()
    expect(res).toEqual({ sent: 2, kept: 0 })
    expect(posts).toHaveLength(1)
    expect(posts[0].headers.authorization).toBe('Bearer t')
    expect(spoolFiles()).toHaveLength(0)
  })

  it('keeps records on failure and delivers them on the next flush', async () => {
    const em = make()
    em.onEvent(usage())
    status = 500
    expect(await em.flush()).toEqual({ sent: 0, kept: 1 })
    expect(spoolFiles()).toHaveLength(1)
    status = 204
    expect(await em.flush()).toEqual({ sent: 1, kept: 0 })
    expect(spoolFiles()).toHaveLength(0)
  })

  it('keeps records appended while a send is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const em = make({
      post: async (url: string, headers: Record<string, string>, body: Uint8Array) => {
        posts.push({ url, headers, body })
        await gate
        return { status: 204 }
      },
    })
    em.onEvent(usage({ apiCallId: 'first' }))
    const inflight = em.flush()
    await new Promise((r) => setTimeout(r, 10))
    em.onEvent(usage({ apiCallId: 'second' }))
    release()
    expect(await inflight).toEqual({ sent: 1, kept: 0 })
    expect(spoolFiles()).toHaveLength(1)
    expect(await em.flush()).toEqual({ sent: 1, kept: 0 })
    expect(spoolFiles()).toHaveLength(0)
    expect(posts).toHaveLength(2)
  })

  it('captures nothing when the device is not enrolled', async () => {
    const em = make({ isProvisioned: () => false })
    em.onEvent(usage())
    await em.close()
    expect(spoolFiles()).toHaveLength(0)
    expect(posts).toHaveLength(0)
  })

  it('in shadow mode records what it would send and never posts', async () => {
    const em = make({ env: { COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' } })
    expect(em.mode).toBe('shadow')
    em.onEvent(usage())
    await em.close()
    expect(posts).toHaveLength(0)
    expect(spoolFiles()).toHaveLength(0)
    const lines = fs.readFileSync(join(dir, 'copilot-usage-shadow', `${SID}.jsonl`), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ h: 'hash1', o: 'acme-appdev', surface: 'cli' })
  })

  it('emits turn and MCP counts per interaction, counting subagent turns', async () => {
    const em = make({ env: { COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' } })
    em.onEvent({
      type: 'session.mcp_servers_loaded',
      data: { servers: [{ status: 'connected' }, { status: 'failed' }] },
    })
    em.onEvent({ type: 'assistant.turn_start', data: {} })
    em.onEvent({ type: 'assistant.turn_start', agentId: 'sub', data: {} })
    em.onEvent({ type: 'session.idle', id: 'i1', timestamp: '2026-09-23T13:35:16Z', data: {} })
    const rec = JSON.parse(fs.readFileSync(join(dir, 'copilot-usage-shadow', `${SID}.jsonl`), 'utf8')).r
    expect(attr(rec, 'event.name')).toBe('usage_signal')
    expect(attr(rec, 'sig.turn_count')).toBe('2')
    expect(attr(rec, 'sig.mcp_count')).toBe('1')
    expect(attr(rec, 'request_id')).toMatch(READER_SAFE)
  })

  it('only emits sig.* keys the reader knows', () => {
    const em = make({ env: { COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' } })
    em.onEvent({ type: 'session.usage_info', data: { currentTokens: 1, tokenLimit: 10 } })
    em.onEvent({ type: 'session.mcp_servers_loaded', data: { servers: [{ status: 'connected' }] } })
    em.onEvent(usage())
    em.onEvent({ type: 'assistant.turn_start', data: {} })
    em.onEvent({ type: 'session.idle', id: 'i', data: {} })
    const known = new Set<string>(Object.values(SIGNAL_WIRE_COLUMNS))
    const keys = fs
      .readFileSync(join(dir, 'copilot-usage-shadow', `${SID}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .flatMap((l) => (JSON.parse(l).r as Rec).attributes.map((a) => a.key))
      .filter((k) => k.startsWith('sig.'))
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(known.has(k), k).toBe(true)
  })
})

describe.skipIf(POSIX_ONLY)('usage extension: liveness, drift and the shared lane predicate', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'ts-usage-x-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function make(over: Record<string, unknown> = {}) {
    return createUsageEmitter({
      stateDir: dir,
      sessionId: SID,
      env: {},
      debounceMs: 60_000,
      heartbeatMs: 60_000,
      writerId: 'wa0001',
      isProvisioned: () => true,
      loadConfig: () => ({ instance_id: INSTANCE, logs_endpoint: 'https://ingest.example/v1/logs' }),
      mint: () => 'Bearer t',
      post: async () => ({ status: 204 }),
      resolveProjectCodeHash: () => 'hash1',
      resolveGithubOrg: () => 'acme-appdev',
      ...over,
    })
  }
  const drift = () => {
    try {
      return JSON.parse(fs.readFileSync(join(dir, 'copilot-usage-drift', `${SID}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  const checkpoint = (total: number) => ({ type: 'session.usage_checkpoint', data: { totalNanoAiu: total } })

  it("a live emitter's spool is never adopted by another writer, and is once it stops beating", async () => {
    const e = make()
    e.onEvent(usage())
    const sd = join(dir, 'copilot-usage-spool')
    expect(fs.existsSync(join(sd, '.hb-wa0001'))).toBe(true)
    expect(createSpool({ stateDir: dir, sessionId: 'other', writerId: 'wb0001' }).claim()).toHaveLength(0)

    const stale = new Date(Date.now() - WRITER_STALE_MS - 1000)
    fs.utimesSync(join(sd, '.hb-wa0001'), stale, stale)
    expect(createSpool({ stateDir: dir, sessionId: 'other', writerId: 'wb0001' }).claim()).toHaveLength(1)
    await e.close()
  })

  it('a closed emitter drops its heartbeat, so what it could not send is adopted at once', async () => {
    const e = make({ post: async () => ({ status: 503 }) })
    e.onEvent(usage())
    await e.close()
    const sd = join(dir, 'copilot-usage-spool')
    expect(fs.existsSync(join(sd, '.hb-wa0001'))).toBe(false)
    expect(createSpool({ stateDir: dir, sessionId: 'other', writerId: 'wb0001' }).claim()).toHaveLength(1)
  })

  // Copilot review on PR 496: a new session that only flushed another session's
  // leftovers must not be noted as the folder's last session (#475).
  it("notes this session only when a sent batch carried its own records", async () => {
    const dead = make({ post: async () => ({ status: 503 }) })
    dead.onEvent(usage())
    await dead.close()

    const OTHER = '0c4e9a2b-7d31-4f58-9b6a-2e8d1c5f7a90'
    const noted: string[] = []
    const fresh = make({ sessionId: OTHER, writerId: 'wb0001', recordLastSession: (id: string) => noted.push(id) })
    await fresh.flush()
    expect(noted).toEqual([])

    fresh.onEvent(usage())
    await fresh.flush()
    expect(noted).toEqual([OTHER])
    await fresh.close()
  })

  it('an unenrolled device grows no spool or heartbeat', () => {
    const e = make({ isProvisioned: () => false })
    e.onEvent(usage())
    expect(fs.existsSync(join(dir, 'copilot-usage-spool'))).toBe(false)
  })

  it('flags a shortfall between two checkpoints (calls missed), and a healthy checkpoint clears it', () => {
    const e = make()
    e.onEvent(checkpoint(1_000_000_000)) // baseline
    e.onEvent(usage({ copilotUsage: { totalNanoAiu: 400_000_000 } }))
    e.onEvent(checkpoint(2_000_000_000)) // Copilot says 1e9 was spent; we recorded 0.4e9
    expect(drift()).toMatchObject({ kind: 'shortfall', expected_nano_aiu: 1_000_000_000, recorded_nano_aiu: 400_000_000 })

    e.onEvent(usage({ apiCallId: 'second-call', copilotUsage: { totalNanoAiu: 500_000_000 } }))
    e.onEvent(checkpoint(2_500_000_000))
    expect(drift()).toBeNull()
  })

  it('flags an excess between two checkpoints (calls recorded twice)', () => {
    const e = make()
    e.onEvent(checkpoint(1_000_000_000))
    e.onEvent(usage({ copilotUsage: { totalNanoAiu: 500_000_000 } }))
    e.onEvent(usage({ apiCallId: 'dup', copilotUsage: { totalNanoAiu: 500_000_000 } }))
    e.onEvent(checkpoint(1_500_000_000))
    expect(drift()).toMatchObject({ kind: 'excess', expected_nano_aiu: 500_000_000, recorded_nano_aiu: 1_000_000_000 })
  })

  it('an unchanged checkpoint total with calls recorded in between is an excess', () => {
    const e = make()
    e.onEvent(checkpoint(1_000))
    e.onEvent(usage({ copilotUsage: { totalNanoAiu: 500 } }))
    e.onEvent(checkpoint(1_000))
    expect(drift()).toMatchObject({ kind: 'excess', expected_nano_aiu: 0, recorded_nano_aiu: 500 })
  })

  it('a failed send keeps the spool file age (how long the records have waited)', async () => {
    const e = make({ post: async () => ({ status: 503 }) })
    e.onEvent(usage())
    const sd = join(dir, 'copilot-usage-spool')
    const f = join(sd, fs.readdirSync(sd).find((n) => n.endsWith('.jsonl'))!)
    const old = new Date(Date.now() - 30 * 3600 * 1000)
    fs.utimesSync(f, old, old)
    expect(await e.flush()).toEqual({ sent: 0, kept: 1 })
    const kept = fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl'))
    expect(kept).toHaveLength(1)
    expect(Math.abs(fs.statSync(join(sd, kept[0])).mtimeMs - old.getTime())).toBeLessThan(2000)
  })

  it("a healthy checkpoint clears only its OWN session's drift, never another session's", () => {
    const dd = join(dir, 'copilot-usage-drift')
    fs.mkdirSync(dd)
    fs.writeFileSync(join(dd, 'other-session.json'), JSON.stringify({ ts: new Date().toISOString(), session: 'other-session', kind: 'shortfall' }))
    const e = make()
    e.onEvent(checkpoint(1_000))
    e.onEvent(usage({ copilotUsage: { totalNanoAiu: 400 } }))
    e.onEvent(checkpoint(1_500)) // this session's own shortfall
    e.onEvent(usage({ apiCallId: 'c2', copilotUsage: { totalNanoAiu: 500 } }))
    e.onEvent(checkpoint(2_000)) // ...cleared by its own healthy checkpoint
    expect(drift()).toBeNull()
    expect(readUsageDrift(dir)).toMatchObject({ session: 'other-session', sessions: 1 })
  })

  it('verdicts past the 7-day bound are deleted when a verdict is next written', () => {
    const dd = join(dir, 'copilot-usage-drift')
    fs.mkdirSync(dd)
    const old = join(dd, 'long-gone.json')
    fs.writeFileSync(old, JSON.stringify({ ts: '2026-01-01T00:00:00Z', session: 'long-gone', kind: 'contract' }))
    const ancient = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    fs.utimesSync(old, ancient, ancient)
    const e = make()
    e.onEvent(usage({ outputTokens: 1e30 })) // writes this session's verdict
    expect(fs.existsSync(old)).toBe(false)
    expect(drift()).toMatchObject({ kind: 'contract' })
  })

  it('concurrent sessions keep separate verdicts: a later drift does not overwrite an earlier one', () => {
    const a = make({ sessionId: 'sess-a' })
    const b = make({ sessionId: 'sess-b' })
    a.onEvent(checkpoint(1_000))
    b.onEvent(checkpoint(1_000))
    a.onEvent(checkpoint(2_000)) // a: shortfall
    b.onEvent(usage({ copilotUsage: { totalNanoAiu: 5_000 } }))
    b.onEvent(checkpoint(1_500)) // b: excess
    expect(readUsageDrift(dir)).toMatchObject({ sessions: 2 })
    b.onEvent(checkpoint(1_500)) // b clears its own
    expect(readUsageDrift(dir)).toMatchObject({ session: 'sess-a', kind: 'shortfall', sessions: 1 })
  })

  it('a record that fails to reach the spool is never counted as recorded, and flags a sticky persist drift', () => {
    const e = make()
    e.onEvent(checkpoint(1_000))
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    })
    try {
      expect(() => e.onEvent(usage({ copilotUsage: { totalNanoAiu: 500 } }))).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(drift()).toMatchObject({ kind: 'persist', error: 'ENOSPC' })
    e.onEvent(checkpoint(1_500)) // a shortfall now, but it never replaces the known loss
    expect(drift()).toMatchObject({ kind: 'persist', error: 'ENOSPC' })
  })

  it('an idle signal that fails to spool is flagged as a persist drift, never re-sent under the next idle', () => {
    const e = make({ mode: 'send' })
    e.onEvent({ type: 'assistant.turn_start', data: {} })
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    })
    try {
      e.onEvent({ type: 'session.idle', id: 'idle-1', timestamp: '2026-09-25T00:00:00Z', data: {} })
    } finally {
      spy.mockRestore()
    }
    expect(drift()).toMatchObject({ kind: 'persist', error: 'ENOSPC' })
    // A write that landed but reported failure must not be counted again: no turns since.
    e.onEvent({ type: 'session.idle', id: 'idle-2', timestamp: '2026-09-25T00:00:01Z', data: {} })
    const sd = join(dir, 'copilot-usage-spool')
    const lines = fs.existsSync(sd)
      ? fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(join(sd, n), 'utf8').trim().split('\n'))
      : []
    expect(lines.some((l) => l.includes('sig.turn_count'))).toBe(false)
  })

  it('a known loss survives a resumed session in a new process: its matching checkpoint does not clear it', () => {
    const first = make()
    first.onEvent(usage({ outputTokens: 1e30 }))
    expect(drift()).toMatchObject({ kind: 'contract' })
    const resumed = make() // same session id, new process: nothing in memory
    resumed.onEvent(checkpoint(1_000))
    resumed.onEvent(usage({ apiCallId: 'r1', copilotUsage: { totalNanoAiu: 500 } }))
    resumed.onEvent(checkpoint(1_500))
    expect(drift()).toMatchObject({ kind: 'contract' })
  })

  it('a cost-only verdict is cleared by a later healthy checkpoint, in a resumed process too', () => {
    const first = make()
    first.onEvent(checkpoint(1_000))
    first.onEvent(checkpoint(2_000)) // shortfall
    expect(drift()).toMatchObject({ kind: 'shortfall' })
    const resumed = make()
    resumed.onEvent(checkpoint(2_000))
    resumed.onEvent(usage({ apiCallId: 'r2', copilotUsage: { totalNanoAiu: 500 } }))
    resumed.onEvent(checkpoint(2_500))
    expect(drift()).toBeNull()
  })

  it('an invalid token count is recorded as 0 and flags a sticky contract drift', () => {
    const e = make()
    e.onEvent(checkpoint(1_000))
    e.onEvent(usage({ outputTokens: 1e30, copilotUsage: { totalNanoAiu: 500 } }))
    expect(drift()).toMatchObject({ kind: 'contract', invalid: ['outputTokens'] })
    e.onEvent(checkpoint(1_500))
    expect(drift()).toMatchObject({ kind: 'contract' })
  })

  it('a spooled entry that cannot be encoded is dropped and reported; the rest of its file is sent', async () => {
    const sent: Uint8Array[] = []
    const e = make({ post: async (_u: string, _h: unknown, body: Uint8Array) => (sent.push(body), { status: 204 }) })
    e.onEvent(usage())
    const sd = join(dir, 'copilot-usage-spool')
    const f = join(sd, fs.readdirSync(sd).find((n) => n.endsWith('.jsonl'))!)
    const good = fs.readFileSync(f, 'utf8').trim().split('\n')[0]
    const bad = JSON.parse(good)
    bad.r.timeUnixNano = '99999999999999999999999' // past uint64: writeBigUInt64LE throws
    fs.appendFileSync(f, JSON.stringify(bad) + '\n' + JSON.stringify({ r: 42 }) + '\n')
    expect(await e.flush()).toEqual({ sent: 1, kept: 0 })
    expect(sent).toHaveLength(1)
    expect(fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl'))).toHaveLength(0)
    expect(drift()).toMatchObject({ kind: 'poison', dropped: 2 })
    e.onEvent(checkpoint(1))
    e.onEvent(checkpoint(1))
    expect(drift()).toMatchObject({ kind: 'poison' }) // lost records: sticky
  })

  it('a contract drift is not cleared by a checkpoint whose cost adds up', () => {
    const e = make()
    e.onEvent(checkpoint(1_000))
    e.onEvent(usage({ inputTokens: undefined, outputTokens: undefined, promptTokens: 5 }))
    e.onEvent(usage({ apiCallId: 'ok-call', copilotUsage: { totalNanoAiu: 500 } }))
    e.onEvent(checkpoint(1_500))
    expect(drift()).toMatchObject({ kind: 'contract' })
  })

  it('retries what it kept with backoff, with no new usage needed, and stops on close', async () => {
    vi.useFakeTimers()
    try {
      let status = 503
      const posts: number[] = []
      const e = make({ debounceMs: 1_000, post: async () => (posts.push(status), { status }) })
      e.onEvent(usage())
      await vi.advanceTimersByTimeAsync(1_000) // debounce send: 503
      expect(posts).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(2_000) // first retry
      expect(posts).toHaveLength(2)
      status = 204
      await vi.advanceTimersByTimeAsync(4_000) // second retry delivers
      expect(posts).toHaveLength(3)
      expect(fs.readdirSync(join(dir, 'copilot-usage-spool')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(posts).toHaveLength(3) // delivered: no more retries

      status = 503
      e.onEvent(usage({ apiCallId: 'late' }))
      await e.close()
      const n = posts.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(posts).toHaveLength(n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a direct flush (extension start, idle) that keeps records also enters the retry loop', async () => {
    vi.useFakeTimers()
    try {
      let status = 503
      let calls = 0
      const e = make({ debounceMs: 1_000, post: async () => (calls++, { status }) })
      e.onEvent(usage())
      expect(await e.flush()).toMatchObject({ kept: 1 })
      status = 204
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls).toBe(2)
      expect(fs.readdirSync(join(dir, 'copilot-usage-spool')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(0)
      await e.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() also sends what was appended while a send was in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const e = make({
      post: async () => {
        calls += 1
        if (calls === 1) await gate
        return { status: 204 }
      },
    })
    e.onEvent(usage())
    const sending = e.flush() // claims the first record, then waits on the gate
    await new Promise((r) => setImmediate(r))
    e.onEvent(usage({ apiCallId: 'late-call' })) // lands in a fresh spool file
    const closing = e.close()
    release()
    await sending
    expect(await closing).toEqual({ sent: 2, kept: 0 })
    expect(fs.readdirSync(join(dir, 'copilot-usage-spool')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(0)
  })

  it('a send in flight when the emitter closes schedules no retry after it', async () => {
    vi.useFakeTimers()
    try {
      let release: (v: { status: number }) => void = () => {}
      let calls = 0
      const e = make({
        debounceMs: 1_000,
        post: () => {
          calls += 1
          return calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ status: 503 })
        },
      })
      e.onEvent(usage())
      await vi.advanceTimersByTimeAsync(1_000) // the debounced send is now in flight
      const closing = e.close()
      release({ status: 503 })
      await closing
      const atClose = calls // close's own final flush may retry once
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(atClose)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spool file that cannot be read is kept, never treated as delivered', async () => {
    const e = make()
    e.onEvent(usage())
    const sd = join(dir, 'copilot-usage-spool')
    const origRead = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p).startsWith(sd) && String(p).endsWith('.jsonl')) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return (origRead as (...a: unknown[]) => unknown)(p, o)
    }) as typeof fs.readFileSync)
    try {
      expect(await e.flush()).toEqual({ sent: 0, kept: 1 })
    } finally {
      spy.mockRestore()
    }
    expect(fs.readdirSync(sd).filter((n) => n.endsWith('.jsonl'))).toHaveLength(1)
    expect(await e.close()).toEqual({ sent: 1, kept: 0 })
  })

  it('a fractional count is never rounded into a different total: 0 and contract drift', () => {
    expect(countInt(1.5)).toBeNull()
    expect(countInt(7)).toBe('7')
    const r = mapUsageEvent(usage({ inputTokens: 1.5 }), SID) as Rec
    expect(attr(r, 'input_tokens')).toBe('0')
    expect(invalidUsageCounts({ inputTokens: 1.5 })).toEqual(['inputTokens'])
  })

  it('the encodability check covers the resource attributes the batch builder adds (surface)', () => {
    const r = mapUsageEvent(usage(), SID)
    expect(encodable({ r, h: null, o: null, s: 'cli' })).toBe(true)
    expect(encodable({ r, h: null, o: null, s: 42 })).toBe(false)
  })

  it('a damaged interior spool line is counted as lost (sticky poison drift), not silently dropped', async () => {
    const e = make()
    e.onEvent(usage())
    const sd = join(dir, 'copilot-usage-spool')
    const f = join(sd, fs.readdirSync(sd).find((n) => n.endsWith('.jsonl'))!)
    const good = fs.readFileSync(f, 'utf8')
    fs.writeFileSync(f, '{damaged\n' + good)
    expect(await e.flush()).toEqual({ sent: 1, kept: 0 })
    expect(drift()).toMatchObject({ kind: 'poison', dropped: 1 })
  })

  it('close sends a record that arrives while its own final send is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const e = make({
      post: async () => {
        calls += 1
        if (calls === 1) await gate
        return { status: 204 }
      },
    })
    e.onEvent(usage())
    const closing = e.close() // close's OWN first flush claims, then waits on the gate
    await new Promise((r) => setImmediate(r))
    e.onEvent(usage({ apiCallId: 'during-close' }))
    release()
    expect(await closing).toEqual({ sent: 2, kept: 0 })
  })

  it('shadow files older than the spool bound are pruned (parity evidence cannot grow unbounded)', () => {
    const sh = join(dir, 'copilot-usage-shadow')
    fs.mkdirSync(sh)
    const old = join(sh, 'old-session.jsonl')
    fs.writeFileSync(old, '{}\n')
    const ancient = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    fs.utimesSync(old, ancient, ancient)
    const e = make({ mode: 'shadow' })
    e.onEvent(usage())
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.readdirSync(sh)).toEqual([`${SID}.jsonl`])
  })

  it('the first checkpoint is only a baseline (a resumed session already carries earlier usage)', () => {
    const e = make()
    e.onEvent(usage({ copilotUsage: { totalNanoAiu: 100 } }))
    e.onEvent(checkpoint(9_000_000_000))
    expect(drift()).toBeNull()
  })

  it('an assistant.usage without token counts is recorded as a contract drift, never sent as zeros', () => {
    const e = make()
    e.onEvent(usage({ inputTokens: undefined, outputTokens: undefined, promptTokens: 5 }))
    expect(drift()).toMatchObject({ kind: 'contract' })
    expect(fs.existsSync(join(dir, 'copilot-usage-spool'))).toBe(false)
  })

  it('shadow exactly when the forwarder owns the session: one predicate for both lanes', () => {
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '.tokenscope.local/copilot-otel.jsonl', COPILOT_HOME: '/nonexistent/ts-copilot-home' })).toBe('shadow')
    expect(emitMode({ COPILOT_OTEL_FILE_EXPORTER_PATH: '   ' })).toBe('send')
    expect(emitMode({})).toBe('send')
  })
})

describe.skipIf(POSIX_ONLY)('createSpool', () => {
  let dir: string
  beforeEach(() => (dir = fs.mkdtempSync(join(os.tmpdir(), 'ts-spool-'))))
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('adopts files of dead writers, leaves live writers alone, prunes stale files', () => {
    const sd = join(dir, 'copilot-usage-spool')
    fs.mkdirSync(sd)
    const past = (ms: number) => new Date(Date.now() - ms)
    const stale = past(WRITER_STALE_MS + 1000)
    const ancient = past(8 * 24 * 3600 * 1000)

    // Writer ids: live = fresh heartbeat; dead = stale or missing heartbeat.
    fs.writeFileSync(join(sd, 'dead.wd0001.jsonl'), '{"r":1}\n')
    fs.writeFileSync(join(sd, '.hb-wd0001'), '')
    fs.utimesSync(join(sd, '.hb-wd0001'), stale, stale)
    fs.writeFileSync(join(sd, 'live.wc0001.jsonl'), '{"r":2}\n')
    fs.writeFileSync(join(sd, '.hb-wc0001'), '')
    // A live writer's OLD file (it has not appended for days) is still left alone.
    const liveOld = join(sd, 'liveold.wc0001.jsonl')
    fs.writeFileSync(liveOld, '{"r":4}\n')
    fs.utimesSync(liveOld, ancient, ancient)
    // A dead writer's file past the spool age is pruned, not sent.
    const old = join(sd, 'old.we0001.jsonl')
    fs.writeFileSync(old, '{"r":3}\n')
    fs.utimesSync(old, ancient, ancient)

    const claimed = createSpool({ stateDir: dir, sessionId: 'me', writerId: 'wf0001' }).claim()
    expect(claimed).toHaveLength(1)
    expect(fs.readFileSync(claimed[0], 'utf8')).toBe('{"r":1}\n')
    expect(claimed[0]).toMatch(/\.wf0001\.jsonl$/)
    expect(fs.existsSync(join(sd, 'live.wc0001.jsonl'))).toBe(true)
    expect(fs.existsSync(liveOld)).toBe(true)
    expect(fs.existsSync(old)).toBe(false)
  })

  it("a pid-shaped name never proves liveness or ownership across namespaces (legacy files: by their own age)", () => {
    const sd = join(dir, 'copilot-usage-spool')
    fs.mkdirSync(sd)
    // Named with THIS process's pid, as a host process in another pid namespace could
    // be: under pid ownership it would be claimed as "mine" while its writer appends.
    const recent = join(sd, `hostlive.${process.pid}.jsonl`)
    fs.writeFileSync(recent, '{"r":5}\n')
    const stale = new Date(Date.now() - WRITER_STALE_MS - 1000)
    const legacyDead = join(sd, `hostgone.${process.pid}.jsonl`)
    fs.writeFileSync(legacyDead, '{"r":6}\n')
    fs.utimesSync(legacyDead, stale, stale)

    const claimed = createSpool({ stateDir: dir, sessionId: 'me', writerId: 'wf0002' }).claim()
    expect(claimed).toHaveLength(1)
    expect(fs.readFileSync(claimed[0], 'utf8')).toBe('{"r":6}\n')
    expect(fs.existsSync(recent)).toBe(true)
  })

  it('a claim that cannot list the spool throws (the flush is retried), unless there is no spool yet', () => {
    expect(createSpool({ stateDir: join(dir, 'absent'), sessionId: 'me' }).claim()).toEqual([])
    const blocker = join(dir, 'file-not-dir')
    fs.mkdirSync(blocker)
    fs.writeFileSync(join(blocker, 'copilot-usage-spool'), 'x') // ENOTDIR
    expect(() => createSpool({ stateDir: blocker, sessionId: 'me' }).claim()).toThrow()
  })

  it('reads every whole entry of a file whose final append was torn, and drops only the torn line', () => {
    const f = join(dir, 'torn.jsonl')
    fs.writeFileSync(f, '{"r":1}\n{"r":2}\n{"r":')
    expect(createSpool({ stateDir: dir, sessionId: 'me' }).read(f)).toEqual({ entries: [{ r: 1 }, { r: 2 }], dropped: 1 })
  })
})

describe.skipIf(POSIX_ONLY)('parity checker', () => {
  // Main calls map 1:1; the CLI folds a subagent's calls into ONE chat span, so parity
  // is on per-session totals. The forwarder reads no cache-write key the CLI emits.
  const spans = [
    {
      type: 'span',
      spanId: 'a1',
      endTime: [1790170505, 0],
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': SID,
        'gen_ai.request.model': 'gpt-5-mini',
        'gen_ai.response.id': 'call-1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
        'gen_ai.usage.cache_read.input_tokens': 40,
        'github.copilot.nano_aiu': 5,
      },
    },
    {
      type: 'span',
      spanId: 'a2',
      endTime: [1790170506, 0],
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': SID,
        'gen_ai.request.model': 'gpt-5.6-luna',
        'gen_ai.response.id': 'call-3',
        'gen_ai.usage.input_tokens': 30,
        'gen_ai.usage.output_tokens': 3,
        'gen_ai.usage.cache_write.input_tokens': 7,
        'github.copilot.nano_aiu': 2,
      },
    },
  ]
  const ext = [
    usage({ apiCallId: 'call-1', inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, copilotUsage: { totalNanoAiu: 5 } }),
    usage({ apiCallId: 'call-2', model: 'gpt-5.6-luna', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 5, copilotUsage: { totalNanoAiu: 1 } }),
    usage({ apiCallId: 'call-3', model: 'gpt-5.6-luna', inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 2, copilotUsage: { totalNanoAiu: 1 } }),
  ].map((e) => mapUsageEvent(e, SID))

  it('passes when the extension matches the forwarder per session (cache-write may exceed)', () => {
    const res = compare(spans, ext)
    expect(res.ok).toBe(true)
    expect(res.spanCallsMatchedById).toBe(2)
    const s = res.sessions[0]
    expect(s.extension.input_tokens).toBe(s.forwarder.input_tokens)
    expect(s.extension.nano_aiu).toBe(s.forwarder.nano_aiu)
    expect(s.forwarder.cache_creation_tokens).toBe(0)
    expect(s.extension.cache_creation_tokens).toBe(7)
  })

  it('fails when the extension misses usage', () => {
    expect(compare(spans, ext.slice(1)).ok).toBe(false)
  })

  it('fails when a forwarder call is unmatched, even if totals are inflated', () => {
    const inflated = [
      usage({ apiCallId: 'x', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 100, copilotUsage: { totalNanoAiu: 100 } }),
      usage({ apiCallId: 'call-3', model: 'gpt-5.6-luna', inputTokens: 20, outputTokens: 2 }),
    ].map((e) => mapUsageEvent(e, SID))
    const res = compare(spans, inflated)
    expect(res.unmatchedSpans).toEqual(['a1'])
    expect(res.ok).toBe(false)
  })

  it('fails when the extension records more than the forwarder (a double count)', () => {
    const extra = mapUsageEvent(usage({ apiCallId: 'call-9', inputTokens: 5, outputTokens: 1 }), SID)
    const res = compare(spans, [...ext, extra])
    expect(res.unmatchedSpans).toEqual([])
    expect(res.sessions[0].ok).toBe(false)
    expect(res.ok).toBe(false)
  })

  it('fails when one request id is recorded twice', () => {
    const res = compare(spans, [...ext, ext[0]])
    expect(res.duplicateIds).toHaveLength(1)
    expect(res.ok).toBe(false)
  })

  it('the evidence reader refuses a damaged line instead of skipping it', () => {
    const f = join(os.tmpdir(), `ts-parity-${process.pid}.jsonl`)
    try {
      fs.writeFileSync(f, '{"a":1}\n\n{"b":\n')
      expect(() => jsonl(f)).toThrow(/:3: not valid JSON/)
      fs.writeFileSync(f, '{"a":1}\n\n{"b":2}\n')
      expect(jsonl(f)).toEqual([{ a: 1 }, { b: 2 }])
    } finally {
      fs.rmSync(f, { force: true })
    }
  })

  it('fails on a duplicated cache-write-only record, which equal totals cannot see', () => {
    const cw = mapUsageEvent(usage({ apiCallId: 'cw-only', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 9, copilotUsage: {} }), SID)
    const res = compare(spans, [...ext, cw, cw])
    expect(res.sessions[0].ok).toBe(true)
    expect(res.duplicateIds).toHaveLength(1)
    expect(res.ok).toBe(false)
  })
})
