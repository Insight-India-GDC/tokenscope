// @vitest-environment node
/*
 * The fake-azure-monitor's REAL ingest route (`POST /v1/logs`).
 *
 * This stub plays both collector and queryable store for the local stack, and
 * its failure mode is uniquely nasty: an unrecognised resource attribute makes
 * it drop every record while still answering `200 { records_normalised: 0 }`.
 * The dev stack then looks healthy and simply never produces attribution, which
 * is exactly what happened when the stub still keyed on the retired
 * `tokenscope.session_id` attribute after the wire renamed it.
 *
 * Every existing journey drives `/admin/ingest` (the SIMULATED path), so none of
 * them would notice. This drives the production-shaped path end to end: POST the
 * OTLP envelope Claude Code actually emits, then read the record back out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { encodeExportLogsServiceRequest } from '../../../plugin/scripts/otlp-logs.mjs'

const SERVER = fileURLToPath(
  new URL('../../../tools/fake-azure-monitor/server.js', import.meta.url),
)

let child: ChildProcess
let base: string

/** An ephemeral port, obtained by letting the OS pick one and releasing it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`fake-azure-monitor did not start at ${url}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })
  await waitForReady(`${base}/`)
}, 30_000)

afterAll(() => {
  child?.kill()
})

/**
 * The envelope Claude Code emits: token counts ride an `api_request` LOG event,
 * and the instance binding is a RESOURCE attribute (see
 * docs/development/claude-code-telemetry-contract.md).
 */
function otlpPayload(instanceAttr: string, instanceId: string, convId: string) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: instanceAttr, value: { stringValue: instanceId } },
            { key: 'project.code_hash', value: { stringValue: 'abc123' } },
            { key: 'tokenscope.activity', value: { stringValue: 'research' } },
            { key: 'tool', value: { stringValue: 'claude-code' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request' } },
                  { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                  { key: 'session.id', value: { stringValue: convId } },
                  { key: 'user.email', value: { stringValue: 'dev@example.com' } },
                  { key: 'input_tokens', value: { intValue: '1200' } },
                  { key: 'output_tokens', value: { intValue: '340' } },
                  { key: 'cost_usd', value: { doubleValue: 0.042 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

async function postLogs(payload: unknown) {
  const res = await fetch(`${base}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as { records_normalised?: number } }
}

describe('fake-azure-monitor POST /v1/logs (the real OTLP path)', () => {
  it('normalises a record keyed on the CURRENT tokenscope.instance_id attribute', async () => {
    const { status, body } = await postLogs(
      otlpPayload('tokenscope.instance_id', 'inst-current', 'conv-current'),
    )
    expect(status).toBe(200)
    // The whole point: not merely accepted, actually normalised. A 200 with
    // zero records is the silent-drop failure this test exists to catch. Two,
    // not one: the stub emits one row per token type, mirroring the sandbox
    // KQL mv-expand, so input_tokens and output_tokens are separate records.
    expect(body.records_normalised).toBe(2)

    // Keyed on the INSTANCE, which is the attribute the read joiner joins on;
    // session.id rides the record as a field rather than being the store key.
    const usage = (await fetch(`${base}/v1/sessions/inst-current/usage`).then((r) => r.json())) as {
      usage: Array<{ tokenType: string; claudeSessionId: string; projectCodeHash: string; activity: string }>
    }
    expect(usage.usage).toHaveLength(2)
    expect(usage.usage.map((u) => u.tokenType).sort()).toEqual(['input', 'output'])
    // The two attributes attribution depends on must survive normalisation.
    expect(new Set(usage.usage.map((u) => u.claudeSessionId))).toEqual(new Set(['conv-current']))
    expect(new Set(usage.usage.map((u) => u.projectCodeHash))).toEqual(new Set(['abc123']))
    // The folder default activity (#475) rides through raw; the joiner gates it.
    expect(new Set(usage.usage.map((u) => u.activity))).toEqual(new Set(['research']))
  })

  it('still accepts the retired tokenscope.session_id attribute', async () => {
    // Backwards compatibility is deliberate, so an old capture replayed against
    // the stub keeps working. Pin it, or a future cleanup silently breaks it.
    const { body } = await postLogs(
      otlpPayload('tokenscope.session_id', 'inst-legacy', 'conv-legacy'),
    )
    expect(body.records_normalised).toBe(2)
  })

  it('ignores resources carrying neither attribute rather than mis-attributing them', async () => {
    const { status, body } = await postLogs(
      otlpPayload('some.other.attribute', 'inst-unknown', 'conv-unknown'),
    )
    expect(status).toBe(200)
    expect(body.records_normalised).toBe(0)
  })

  // Clients send http/protobuf (the emit bundle pins OTEL_EXPORTER_OTLP_LOGS_PROTOCOL,
  // and the Copilot extension encodes with the plugin encoder), so this is the
  // shape real local traffic arrives in.
  it('normalises the same envelope sent as http/protobuf, gzipped or not', async () => {
    for (const [id, gzip] of [['inst-proto', false], ['inst-proto-gz', true]] as const) {
      const payload = otlpPayload('tokenscope.instance_id', id, `conv-${id}`)
      // A fixed instant: a broken fixed64 decode falls back to "now", which a
      // Date.now() fixture could not tell apart.
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = '1700000000123000000'
      const raw = encodeExportLogsServiceRequest(payload)
      const res = await fetch(`${base}/v1/logs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-protobuf',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
        body: gzip ? gzipSync(raw) : raw,
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { records_normalised: number }).records_normalised).toBe(2)
      const usage = (await fetch(`${base}/v1/sessions/${id}/usage`).then((r) => r.json())) as {
        usage: Array<{ tokens: number; tokenType: string; tsEvent: string; claudeSessionId: string; projectCodeHash: string; lawCostUsd: number }>
      }
      const byType = Object.fromEntries(usage.usage.map((u) => [u.tokenType, u]))
      expect(byType.input.tokens).toBe(1200)
      expect(byType.output.tokens).toBe(340)
      expect(byType.input.claudeSessionId).toBe(`conv-${id}`)
      expect(byType.input.projectCodeHash).toBe('abc123')
      expect(byType.input.lawCostUsd).toBeCloseTo(0.042)
      expect(byType.input.tsEvent).toBe('2023-11-14T22:13:20.123Z')
    }
  })

  it('answers the reader health probe', async () => {
    expect((await fetch(`${base}/v1/health`)).status).toBe(200)
  })

  it('rejects a truncated protobuf body with a 400', async () => {
    const raw = encodeExportLogsServiceRequest(otlpPayload('tokenscope.instance_id', 'inst-trunc', 'c'))
    const res = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: raw.subarray(0, raw.length - 5),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed body without echoing internals back to the caller', async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toMatch(/at .*server\.js/)
    expect(text).not.toMatch(/SyntaxError/)
  })
})
