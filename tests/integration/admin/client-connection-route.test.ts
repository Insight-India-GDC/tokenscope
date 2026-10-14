// @vitest-environment node
/*
 * Client connection policy (#415, mig 0151) — the admin GET/PUT and the
 * GET /api/v1/connect/config the connect dialog reads.
 *
 *   - no row ⇒ defaults (today's dialog, byte for byte)
 *   - PUT: platform-admin only, format-validated, audited with before/after,
 *     persisted and served by connect/config
 *   - connect/config: origin is the pinned APP_PUBLIC_ORIGIN, else null with a
 *     reason (an untrusted Host is never echoed back)
 *   - the DB refuses shell metacharacters even if the app layer were bypassed
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import adminGet from '../../../server/api/v1/admin/settings/client-connection.get'
import adminPut from '../../../server/api/v1/admin/settings/client-connection.put'
import configGet from '../../../server/api/v1/connect/config.get'
import { CLAUDE_PLUGIN_DEFAULT_ORIGIN, COPILOT_PLUGIN_BUNDLED_ORIGIN } from '../../../shared/connect'

let t: TestDb
let regionId: string
let platformId: string
let adminId: string
let devId: string
const savedOrigin = process.env.APP_PUBLIC_ORIGIN

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'cc-r', displayName: 'CC R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cc.svc', code: 'cc-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  const mk = async (oid: string, role: string) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email: `${oid}@x.test`, role, regionId, orgUnitId: o!.id })
      .returning()
    return row!.id
  }
  platformId = await mk('oid-cc-platform', 'platform-admin')
  adminId = await mk('oid-cc-admin', 'admin')
  devId = await mk('oid-cc-dev', 'developer')
}, 120_000)

afterAll(async () => {
  if (savedOrigin === undefined) delete process.env.APP_PUBLIC_ORIGIN
  else process.env.APP_PUBLIC_ORIGIN = savedOrigin
  await stopTestDb(t)
}, 30_000)

afterEach(() => {
  delete process.env.APP_PUBLIC_ORIGIN
})

function ev(opts: { method: string; body?: unknown; session: Session; host?: string }) {
  const host = opts.host ?? 'localhost:3450'
  const headers: Record<string, string> = { host, origin: `http://${host}` }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof adminPut>[0]
}

const sess = (id: string, role: string): Session => ({
  teammateId: id, email: `${role}@x.test`, displayName: role, role, regionId, orgPath: 'cc.svc',
} as Session)
const platform = () => sess(platformId, 'platform-admin')
const admin = () => sess(adminId, 'admin')
const dev = () => sess(devId, 'developer')

const body = {
  marketplace_source: 'acme/ts-plugins',
  marketplace_ref: 'v2.0.0',
  marketplace_name: 'acme-ts',
  claude_plugin: 'acme-tokenscope',
  copilot_plugin: 'acme-tokenscope-copilot',
  enabled_clients: ['claude-code'],
  support_url: 'https://help.acme.example/tokenscope',
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? -1
  }
}

async function rowCount(): Promise<number> {
  const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM client_connection_setting`
  return Number(rows[0]!.n)
}

describe('no row ⇒ defaults', () => {
  it('admin GET reports unconfigured defaults', async () => {
    const r = await adminGet(ev({ method: 'GET', session: platform() }))
    expect(r).toEqual({
      configured: false,
      marketplace_source: 'Insight-Services-APAC/tokenscope-public',
      marketplace_ref: null,
      marketplace_name: 'tokenscope',
      claude_plugin: 'tokenscope',
      copilot_plugin: 'tokenscope-copilot',
      enabled_clients: ['claude-code', 'copilot-cli'],
      support_url: null,
      updated_by: null,
      updated_at: null,
    })
  })

  it('connect/config serves the defaults plus the pinned origin to any user', async () => {
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.acme.example/'
    const r = await configGet(ev({ method: 'GET', session: dev(), host: 'ca-internal.azurecontainerapps.io' }))
    expect(r).toEqual({
      marketplaceSource: 'Insight-Services-APAC/tokenscope-public',
      marketplaceRef: null,
      marketplaceName: 'tokenscope',
      claudePlugin: 'tokenscope',
      copilotPlugin: 'tokenscope-copilot',
      enabledClients: ['claude-code', 'copilot-cli'],
      supportUrl: null,
      origin: 'https://tokenscope.acme.example',
      originMissingReason: null,
      mcpUrl: 'https://tokenscope.acme.example/api/v1/mcp',
      claudeBundledOrigin: CLAUDE_PLUGIN_DEFAULT_ORIGIN,
      copilotBundledOrigin: COPILOT_PLUGIN_BUNDLED_ORIGIN,
      claudeMarketplaceUrl: 'https://tokenscope.acme.example/api/v1/plugin/marketplace.json',
    })
  })

  it('connect/config never echoes an untrusted Host: origin null with a reason', async () => {
    const r = await configGet(ev({ method: 'GET', session: dev(), host: 'ca-internal.azurecontainerapps.io' }))
    expect(r.origin).toBeNull()
    expect(r.mcpUrl).toBeNull()
    expect(r.claudeMarketplaceUrl).toBeNull()
    expect(r.originMissingReason).toContain('appPublicOrigin')
  })

  it('connect/config uses the loopback request origin in local dev', async () => {
    const r = await configGet(ev({ method: 'GET', session: dev(), host: 'localhost:3450' }))
    expect(r.origin).toBe('http://localhost:3450')
  })
})

describe('PUT /admin/settings/client-connection', () => {
  it('region admins and developers get 403 and nothing is written', async () => {
    expect(await status(adminPut(ev({ method: 'PUT', body, session: admin() })))).toBe(403)
    expect(await status(adminPut(ev({ method: 'PUT', body, session: dev() })))).toBe(403)
    expect(await status(adminGet(ev({ method: 'GET', session: admin() })))).toBe(403)
    expect(await rowCount()).toBe(0)
  })

  it.each([
    ['shell metacharacters in the source', { marketplace_source: 'acme/repo;id' }],
    ['a non-https git URL', { marketplace_source: 'http://git.acme.example/repo' }],
    ['an uppercase plugin name', { claude_plugin: 'TokenScope' }],
    ['a bad ref', { marketplace_ref: '../x' }],
    ['no clients', { enabled_clients: [] }],
    ['an http support link', { support_url: 'http://help.acme.example' }],
  ])('400 on %s', async (_label, patch) => {
    expect(await status(adminPut(ev({ method: 'PUT', body: { ...body, ...patch }, session: platform() })))).toBe(400)
    expect(await rowCount()).toBe(0)
  })

  it('a platform admin saves; the row, the response, the audit and connect/config agree', async () => {
    const r = await adminPut(ev({ method: 'PUT', body, session: platform() }))
    expect(r).toMatchObject({ configured: true, ...body, updated_by: platformId })

    const audit = await t.client<{ event_type: string; actor_teammate_id: string; payload: Record<string, unknown> }[]>`
      SELECT event_type, actor_teammate_id::text AS actor_teammate_id, payload
        FROM audit_event WHERE event_type = 'client-connection-policy-updated'`
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_teammate_id).toBe(platformId)
    expect((audit[0]!.payload.before as Record<string, unknown>).marketplace_source).toBe('Insight-Services-APAC/tokenscope-public')
    expect((audit[0]!.payload.after as Record<string, unknown>).marketplace_source).toBe('acme/ts-plugins')

    const got = await adminGet(ev({ method: 'GET', session: platform() }))
    expect(got).toMatchObject({ configured: true, ...body })

    const cfg = await configGet(ev({ method: 'GET', session: dev() }))
    expect(cfg).toMatchObject({
      marketplaceSource: 'acme/ts-plugins',
      marketplaceRef: 'v2.0.0',
      marketplaceName: 'acme-ts',
      claudePlugin: 'acme-tokenscope',
      copilotPlugin: 'acme-tokenscope-copilot',
      enabledClients: ['claude-code'],
      supportUrl: 'https://help.acme.example/tokenscope',
    })
  })

  it('a second save updates the single row and audits the previous values', async () => {
    await adminPut(ev({ method: 'PUT', body: { ...body, marketplace_ref: null, support_url: null }, session: platform() }))
    expect(await rowCount()).toBe(1)
    const audit = await t.client<{ payload: { before: Record<string, unknown>; after: Record<string, unknown> } }[]>`
      SELECT payload FROM audit_event WHERE event_type = 'client-connection-policy-updated' ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit[0]!.payload.before.marketplace_ref).toBe('v2.0.0')
    expect(audit[0]!.payload.after.marketplace_ref).toBeNull()
  })

  it('concurrent saves serialise: the second audit records the first save as its before', async () => {
    await adminPut(ev({ method: 'PUT', body: { ...body, marketplace_ref: 'v-a' }, session: platform() }))
    // Backends of this database waiting on a lock (the blocker below is idle, not waiting).
    const blocked = async () => {
      const r = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database()`
      return Number(r[0]!.n)
    }
    const until = async (n: number) => {
      for (let i = 0; i < 400; i++) {
        if ((await blocked()) >= n) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`timed out waiting for ${n} blocked backend(s)`)
    }
    // A transaction holding the policy ROW makes the ordering deterministic: each
    // save stops at a known point behind it. Without the table lock both saves
    // read `before` first and then queue at the upsert; with it, the second
    // queues at the lock and reads only after the first commits.
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const blocker = t.client.begin(async (tx) => {
      await tx`SELECT key FROM client_connection_setting WHERE key = 'policy' FOR UPDATE`
      locked()
      await released
    })
    await isLocked
    const putB = adminPut(ev({ method: 'PUT', body: { ...body, marketplace_ref: 'v-b' }, session: platform() }))
    await until(1)
    const putC = adminPut(ev({ method: 'PUT', body: { ...body, marketplace_ref: 'v-c' }, session: platform() }))
    await until(2)
    release()
    await Promise.all([blocker, putB, putC])

    const audit = await t.client<{ payload: { before: Record<string, unknown>; after: Record<string, unknown> } }[]>`
      SELECT payload FROM audit_event
       WHERE event_type = 'client-connection-policy-updated'
         AND payload->'after'->>'marketplace_ref' IN ('v-b', 'v-c')`
    const by = (ref: string) => audit.find((a) => a.payload.after.marketplace_ref === ref)!.payload
    expect(audit).toHaveLength(2)
    expect(by('v-b').before.marketplace_ref).toBe('v-a')
    expect(by('v-c').before.marketplace_ref).toBe('v-b')
  }, 30_000)
})

describe('mig 0151 constraints', () => {
  it('refuses a second row and shell metacharacters at the DB layer', async () => {
    await expect(
      t.client`INSERT INTO client_connection_setting (key, marketplace_source, marketplace_name, claude_plugin, copilot_plugin, enabled_clients)
               VALUES ('other', 'a/b', 'x', 'x', 'x', ARRAY['claude-code'])`,
    ).rejects.toThrow()
    await expect(t.client`UPDATE client_connection_setting SET marketplace_source = 'a/b;id'`).rejects.toThrow()
    // mig 0153: `%` too (cmd.exe expands %NAME% inside quotes).
    await expect(t.client`UPDATE client_connection_setting SET marketplace_source = 'https://h.example/a/%PATH%'`).rejects.toThrow()
    await expect(t.client`UPDATE client_connection_setting SET enabled_clients = ARRAY['cursor']`).rejects.toThrow()
    await expect(t.client`UPDATE client_connection_setting SET claude_plugin = 'Bad Name'`).rejects.toThrow()
  })
})
