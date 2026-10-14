// @vitest-environment node
/*
 * The self-served Claude Code marketplace (docs/design/self-served-marketplace.md).
 *
 * Pins, through the real routes on a real HTTP listener:
 *   - marketplace.json pins the sha256 of the bytes the zip route serves, and
 *     names the zip by version + sha8
 *   - the zip is the plugin/ tree and nothing else, both origin rewrites land,
 *     .sh entries are 0755, and an independent reader (Python zipfile) accepts it
 *   - the rewrite works on the PUBLIC shape too (both defaults already emptied)
 *   - same input, same bytes (replicas must agree)
 *   - 503 when the origin is unpinned, http or loopback; 404 for any other zip name
 *   - refuses an injected enrollment secret, a symlink, a missing rewrite target
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createApp, createRouter, toNodeListener } from 'h3'
import marketplaceGet from '../../../server/api/v1/plugin/marketplace.json.get'
import zipGet from '../../../server/api/v1/plugin/[file].get'
import {
  buildPluginArchive,
  PluginArchiveError,
  resetPluginArchiveCache,
  servedMarketplaceUrlIfBuildable,
} from '../../../server/utils/plugin-marketplace'
import { servedMarketplaceRefusal, servedMarketplaceUrl } from '../../../shared/connect'

const ORIGIN = 'https://tokenscope.acme.example'
const PLUGIN = join(process.cwd(), 'plugin')
const saved = { origin: process.env.APP_PUBLIC_ORIGIN, dir: process.env.TOKENSCOPE_PLUGIN_DIR }
let server: Server
let base: string
const tmp: string[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-mkt-'))
  tmp.push(d)
  return d
}

/** Read a zip with Python's zipfile: names, unix modes, contents; testzip() checks every CRC. */
function readZip(bytes: Buffer): { name: string; mode: number; text: string }[] {
  const f = join(scratch(), 'p.zip')
  writeFileSync(f, bytes)
  const out = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      'import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n' +
        'print(json.dumps([{"name":i.filename,"mode":i.external_attr>>16,"text":z.read(i).decode("utf8","replace")} for i in z.infolist()]))',
      f,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return JSON.parse(out)
}

function treeFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(root, p).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

beforeAll(async () => {
  const router = createRouter()
    .get('/api/v1/plugin/marketplace.json', marketplaceGet)
    .get('/api/v1/plugin/:file', zipGet)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

afterEach(() => {
  resetPluginArchiveCache()
  if (saved.origin === undefined) delete process.env.APP_PUBLIC_ORIGIN
  else process.env.APP_PUBLIC_ORIGIN = saved.origin
  if (saved.dir === undefined) delete process.env.TOKENSCOPE_PLUGIN_DIR
  else process.env.TOKENSCOPE_PLUGIN_DIR = saved.dir
})

async function fetchMarketplace() {
  const r = await fetch(`${base}/api/v1/plugin/marketplace.json`)
  return { status: r.status, cache: r.headers.get('cache-control'), body: r.status === 200 ? await r.json() : null }
}

describe('served marketplace routes', () => {
  it('pins the sha256 of exactly the bytes the zip route serves', async () => {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    const m = await fetchMarketplace()
    expect(m.status).toBe(200)
    expect(m.cache).toBe('no-store')
    expect(m.body.name).toBe('tokenscope')
    expect(m.body.plugins).toHaveLength(1)
    const p = m.body.plugins[0]
    const version = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version
    expect(p).toMatchObject({ name: 'tokenscope', version, source: { source: 'archive' } })
    const url = new URL(p.source.url)
    expect(url.origin).toBe(ORIGIN)
    const prefix = `/api/v1/plugin/tokenscope-${version}-`
    expect(url.pathname.startsWith(prefix)).toBe(true)
    expect(url.pathname.slice(prefix.length)).toMatch(/^[0-9a-f]{8}\.zip$/)
    expect(url.pathname).toContain(p.source.sha256.slice(0, 8))

    const z = await fetch(`${base}${url.pathname}`)
    expect(z.status).toBe(200)
    expect(z.headers.get('content-type')).toBe('application/zip')
    expect(z.headers.get('cache-control')).toContain('immutable')
    const bytes = Buffer.from(await z.arrayBuffer())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.source.sha256)
    expect(servedMarketplaceUrlIfBuildable(ORIGIN)).toBe(`${ORIGIN}/api/v1/plugin/marketplace.json`)
  })

  it('serves the plugin/ tree and nothing else, pointed at this deployment', async () => {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    const { body } = await fetchMarketplace()
    const bytes = Buffer.from(await (await fetch(`${base}${new URL(body.plugins[0].source.url).pathname}`)).arrayBuffer())
    const entries = readZip(bytes)
    expect(entries.map((e) => e.name)).toEqual(treeFiles(PLUGIN))
    const by = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(JSON.parse(by['.claude-plugin/plugin.json']!.text).userConfig.server_url.default).toBe(ORIGIN)
    expect(by['scripts/api-base.mjs']!.text).toContain(`export const DEFAULT_API_BASE = "${ORIGIN}"`)
    // A literal: Claude Desktop's /mcp Connect cannot expand a userConfig template.
    expect(JSON.parse(by['.mcp.json']!.text).mcpServers.tokenscope).toEqual({
      type: 'http',
      url: `${ORIGIN}/api/v1/mcp`,
    })
    for (const e of entries) {
      expect(e.mode & 0o170000).toBe(0o100000)
      if (e.name.endsWith('.sh')) expect(e.mode & 0o777).toBe(0o755)
    }
    expect(by['scripts/otel-headers-helper.sh']).toBeDefined()
  })

  it('answers 404 for any other zip name, so a rollout never pairs a pin with other bytes', async () => {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    const r = await fetch(`${base}/api/v1/plugin/tokenscope-0.0.1-deadbeef.zip`)
    expect(r.status).toBe(404)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it.each([
    ['unpinned', undefined],
    ['http', 'http://tokenscope.acme.example'],
    ['loopback', 'https://localhost:3450'],
  ])('503s when the origin is %s', async (_label, origin) => {
    if (origin) process.env.APP_PUBLIC_ORIGIN = origin
    else delete process.env.APP_PUBLIC_ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect((await fetch(`${base}/api/v1/plugin/tokenscope-x.zip`)).status).toBe(503)
  })

  it('503s, not 500s, when the image has no plugin/ directory', async () => {
    process.env.TOKENSCOPE_PLUGIN_DIR = join(scratch(), 'absent')
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect(servedMarketplaceUrlIfBuildable(ORIGIN)).toBeNull()
  })

  it('503s, not 500s, when plugin.json is not valid JSON', async () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), '{ not json')
    process.env.TOKENSCOPE_PLUGIN_DIR = dir
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect(servedMarketplaceUrlIfBuildable(ORIGIN)).toBeNull()
  })

  it('503s rather than serve a plugin whose MCP server it cannot point here', async () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    process.env.TOKENSCOPE_PLUGIN_DIR = dir
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect(servedMarketplaceUrlIfBuildable(ORIGIN)).toBeNull()
  })

  it.each([
    ['is not valid JSON', '{ not json'],
    ['has no tokenscope server', JSON.stringify({ mcpServers: {} })],
    ['has a non-http tokenscope server', JSON.stringify({ mcpServers: { tokenscope: { type: 'stdio', command: 'x' } } })],
  ])('503s on both routes when .mcp.json %s', async (_label, body) => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), body)
    process.env.TOKENSCOPE_PLUGIN_DIR = dir
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect((await fetch(`${base}/api/v1/plugin/tokenscope-x.zip`)).status).toBe(503)
  })

  it.skipIf(process.getuid?.() === 0)('503s, not 500s, when a plugin file cannot be read', async () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    chmodSync(join(dir, 'README.md'), 0o000)
    process.env.TOKENSCOPE_PLUGIN_DIR = dir
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
    expect(servedMarketplaceUrlIfBuildable(ORIGIN)).toBeNull()
  })

  it('503s rather than serve a plugin it could not point at this deployment', async () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    rmSync(join(dir, 'scripts/api-base.mjs'))
    process.env.TOKENSCOPE_PLUGIN_DIR = dir
    process.env.APP_PUBLIC_ORIGIN = ORIGIN
    expect((await fetchMarketplace()).status).toBe(503)
  })
})

describe('buildPluginArchive', () => {
  it('is deterministic: same tree and origin, same bytes', () => {
    const a = buildPluginArchive(PLUGIN, ORIGIN)
    const b = buildPluginArchive(PLUGIN, ORIGIN)
    expect(a.sha256).toBe(b.sha256)
    expect(a.bytes.equals(b.bytes)).toBe(true)
    expect(buildPluginArchive(PLUGIN, 'https://other.example').sha256).not.toBe(a.sha256)
  })

  it('rewrites the PUBLIC shape too, where both defaults are already empty', () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    const pj = join(dir, '.claude-plugin/plugin.json')
    const manifest = JSON.parse(readFileSync(pj, 'utf8'))
    manifest.userConfig.server_url.default = ''
    writeFileSync(pj, JSON.stringify(manifest, null, 2))
    const ab = join(dir, 'scripts/api-base.mjs')
    writeFileSync(ab, readFileSync(ab, 'utf8').replace(/^export const DEFAULT_API_BASE = '[^']*'$/m, "export const DEFAULT_API_BASE = ''"))
    const by = Object.fromEntries(readZip(buildPluginArchive(dir, ORIGIN).bytes).map((e) => [e.name, e.text]))
    expect(JSON.parse(by['.claude-plugin/plugin.json']!).userConfig.server_url.default).toBe(ORIGIN)
    expect(by['scripts/api-base.mjs']).toContain(`export const DEFAULT_API_BASE = "${ORIGIN}"`)
  })

  it('refuses to serve an injected enrollment secret anonymously', () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    const f = join(dir, 'scripts/enrollment-secret.mjs')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^const BUNDLED_ENROLLMENT_SECRET = PLACEHOLDER$/m, "const BUNDLED_ENROLLMENT_SECRET = 'real'"))
    expect(() => buildPluginArchive(dir, ORIGIN)).toThrow(PluginArchiveError)
  })

  it('never ships a stray dotfile, only the plugin’s own', () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'scripts', '.DS_Store'), 'x')
    const names = readZip(buildPluginArchive(dir, ORIGIN).bytes).map((e) => e.name)
    expect(names.some((n) => n.endsWith('.env') || n.endsWith('.DS_Store'))).toBe(false)
    expect(names).toContain('.mcp.json')
    expect(names).toContain('.claude-plugin/plugin.json')
  })

  it('stores entries uncompressed, so no CPU-specific deflate path can change the bytes', () => {
    const { bytes } = buildPluginArchive(PLUGIN, ORIGIN)
    expect(bytes.readUInt16LE(8)).toBe(0)
  })

  it('refuses a symlink, which could reach outside plugin/', () => {
    const dir = join(scratch(), 'plugin')
    cpSync(PLUGIN, dir, { recursive: true })
    symlinkSync('/etc/hostname', join(dir, 'leak.txt'))
    expect(() => buildPluginArchive(dir, ORIGIN)).toThrow(/symlink/)
  })
})

describe('servedMarketplaceRefusal', () => {
  it.each([
    ['https://tokenscope.acme.example', null],
    ['https://10.0.0.5:8443', null],
    ['http://tokenscope.acme.example', 'https'],
    ['https://localhost', 'local'],
    ['https://127.0.0.2', 'local'],
    ['https://[::1]:3450', 'local'],
    ['https://169.254.169.254', 'local'],
    ['https://[fe80::1]', 'local'],
  ])('%s', (origin, want) => {
    const got = servedMarketplaceRefusal(origin)
    if (want === null) {
      expect(got).toBeNull()
      expect(servedMarketplaceUrl(origin)).toBe(`${origin}/api/v1/plugin/marketplace.json`)
    } else {
      expect(got).toContain(want)
      expect(servedMarketplaceUrl(origin)).toBeNull()
    }
  })

  it('refuses a missing origin', () => {
    expect(servedMarketplaceRefusal(null)).not.toBeNull()
    expect(servedMarketplaceUrl(null)).toBeNull()
  })
})
