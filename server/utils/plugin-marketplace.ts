/*
 * The Claude Code marketplace each deployment serves itself
 * (docs/design/self-served-marketplace.md).
 *
 * `plugin/` from the running image, zipped with this deployment's origin
 * written into the two places the plugin reads its server from, plus a
 * marketplace.json that pins the zip's sha256. Nothing here needs Git on the
 * developer's machine, which is the point: Claude Desktop does not ship it.
 *
 * The zip is deterministic (sorted entries, fixed timestamps, entries STORED
 * uncompressed), so every replica of one image produces the same bytes, and the
 * sha256 that replica A puts in marketplace.json matches the zip that replica B
 * serves. Not deflated: Node's zlib picks CPU-specific code paths, so two
 * hosts can compress the same input differently. Stored, it is about 0.8 MB.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { crc32 } from 'node:zlib'
import consola from 'consola'
import { servedMarketplaceUrl } from '../../shared/connect'

export const SERVED_MARKETPLACE_NAME = 'tokenscope'
const PLUGIN_NAME = 'tokenscope'

export interface PluginArchive {
  /** `tokenscope-<version>-<sha8>.zip`, the only file name the zip route serves. */
  fileName: string
  bytes: Buffer
  sha256: string
  version: string
  description: string
}

/** Thrown when the plugin tree cannot be packaged safely. The route answers 503. */
export class PluginArchiveError extends Error {}

/** The `plugin/` directory: `TOKENSCOPE_PLUGIN_DIR`, else `./plugin` (`/app/plugin` in the image). */
export function pluginDir(): string {
  return resolve(process.env.TOKENSCOPE_PLUGIN_DIR || join(process.cwd(), 'plugin'))
}

// Matched by shape, not by value: the public build has already emptied it.
const API_BASE_LINE = /^export const DEFAULT_API_BASE = '[^'\n]*'$/gm
const SECRET_PLACEHOLDER_LINE = /^const BUNDLED_ENROLLMENT_SECRET = PLACEHOLDER$/m

/* The plugin's own dotfiles. Any other (an editor's or a local `.env`) never ships. */
const PLUGIN_DOTFILES = new Set(['.claude-plugin', '.mcp.json'])

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') && !PLUGIN_DOTFILES.has(name)) continue
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) throw new PluginArchiveError(`refusing a symlink in the plugin: ${name}`)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

function rewritePluginJson(raw: Buffer, origin: string): Buffer {
  let manifest
  try {
    manifest = JSON.parse(raw.toString('utf8'))
  } catch (err) {
    throw new PluginArchiveError(`plugin.json is not valid JSON: ${(err as Error).message}`)
  }
  const opt = manifest?.userConfig?.server_url
  if (!opt || typeof opt !== 'object') throw new PluginArchiveError('plugin.json has no userConfig.server_url')
  opt.default = origin
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

/* Claude Desktop's /mcp Connect cannot expand `${user_config.server_url}`: it
 * sees an unparseable URL, the session sees the expanded default, and its
 * binding check refuses sign-in. This plugin belongs to one deployment, so its
 * MCP URL is a literal. The Git build keeps the template, which Configure
 * options still steers. */
function rewriteMcpJson(raw: Buffer, origin: string): Buffer {
  let config
  try {
    config = JSON.parse(raw.toString('utf8'))
  } catch (err) {
    throw new PluginArchiveError(`.mcp.json is not valid JSON: ${(err as Error).message}`)
  }
  const server = config?.mcpServers?.tokenscope
  if (!server || typeof server !== 'object' || server.type !== 'http') {
    throw new PluginArchiveError('.mcp.json has no http mcpServers.tokenscope')
  }
  server.url = `${origin}/api/v1/mcp`
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
}

function rewriteApiBase(raw: Buffer, origin: string): Buffer {
  const text = raw.toString('utf8')
  const hits = text.match(API_BASE_LINE)?.length ?? 0
  if (hits !== 1) throw new PluginArchiveError(`api-base.mjs: expected one DEFAULT_API_BASE line, found ${hits}`)
  return Buffer.from(text.replace(API_BASE_LINE, `export const DEFAULT_API_BASE = ${JSON.stringify(origin)}`))
}

/** The served zip is anonymous: it must never carry an injected enrollment secret. */
function assertNoSecret(raw: Buffer): Buffer {
  if (!SECRET_PLACEHOLDER_LINE.test(raw.toString('utf8'))) {
    throw new PluginArchiveError('enrollment-secret.mjs carries a value; refusing to serve it anonymously')
  }
  return raw
}

const REWRITES: Record<string, (raw: Buffer, origin: string) => Buffer> = {
  '.claude-plugin/plugin.json': rewritePluginJson,
  '.mcp.json': rewriteMcpJson,
  'scripts/api-base.mjs': rewriteApiBase,
  'scripts/enrollment-secret.mjs': (raw) => assertNoSecret(raw),
}

// 1980-01-01 00:00, the zip epoch: no build time leaks in, and every replica agrees.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/** A minimal stored (uncompressed) zip: local headers, central directory, end record. */
export function writeZip(entries: { name: string; data: Buffer; mode: number }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const packed = e.data
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, packed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so external attrs carry the mode
    cd.writeUInt16LE(10, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(packed.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += local.length + name.length + packed.length
  }
  const cdBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBytes, end])
}

/** Package `root` for `origin`. Throws PluginArchiveError when it cannot be done safely. */
export function buildPluginArchive(root: string, origin: string): PluginArchive {
  let files: string[]
  try {
    files = listFiles(root)
  } catch (err) {
    if (err instanceof PluginArchiveError) throw err
    throw new PluginArchiveError(`cannot read the plugin at ${root}: ${(err as Error).message}`)
  }
  const seen = new Set<string>()
  const entries = files.map((full) => {
    const name = relative(root, full).split(sep).join('/')
    let data: Buffer
    let mode: number
    try {
      data = readFileSync(full)
      mode = lstatSync(full).mode
    } catch (err) {
      throw new PluginArchiveError(`cannot read ${name}: ${(err as Error).message}`)
    }
    const rewrite = REWRITES[name]
    if (rewrite) {
      data = rewrite(data, origin)
      seen.add(name)
    }
    const executable = name.endsWith('.sh') || (mode & 0o111) !== 0
    return { name, data, mode: executable ? 0o755 : 0o644 }
  })
  for (const name of Object.keys(REWRITES)) {
    if (!seen.has(name)) throw new PluginArchiveError(`plugin is missing ${name}`)
  }
  const manifest = JSON.parse(entries.find((e) => e.name === '.claude-plugin/plugin.json')!.data.toString('utf8'))
  const version = String(manifest.version ?? '')
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new PluginArchiveError('plugin.json has no usable version')
  const bytes = writeZip(entries)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    fileName: `${PLUGIN_NAME}-${version}-${sha256.slice(0, 8)}.zip`,
    bytes,
    sha256,
    version,
    description: String(manifest.description ?? ''),
  }
}

/* One archive per origin. The origin is server-vouched (pinned or Front Door),
 * but bound the cache anyway so no header value can grow it. */
const MAX_CACHED = 4
const cache = new Map<string, PluginArchive | PluginArchiveError>()

/**
 * The archive for `origin`, built once per process. A failure is cached too and
 * logged once: the routes are anonymous, and a broken image must not re-walk
 * the tree and log on every request.
 */
export function pluginArchiveFor(origin: string): PluginArchive {
  let hit = cache.get(origin)
  if (hit) cache.delete(origin)
  else {
    try {
      hit = buildPluginArchive(pluginDir(), origin)
    } catch (err) {
      if (!(err instanceof PluginArchiveError)) throw err
      consola.error(`[plugin-marketplace] ${err.message}`)
      hit = err
    }
  }
  cache.set(origin, hit)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  if (hit instanceof PluginArchiveError) throw hit
  return hit
}

/** `${origin}/api/v1/plugin/marketplace.json` when the routes would serve it, else null. */
export function servedMarketplaceUrlIfBuildable(origin: string | null): string | null {
  const url = servedMarketplaceUrl(origin)
  if (!url || !origin) return null
  try {
    pluginArchiveFor(origin)
    return url
  } catch (err) {
    if (err instanceof PluginArchiveError) return null
    throw err
  }
}

/** Tests only. */
export function resetPluginArchiveCache(): void {
  cache.clear()
}

/** The marketplace.json body for `origin`. */
export function servedMarketplace(origin: string, archive: PluginArchive) {
  return {
    name: SERVED_MARKETPLACE_NAME,
    owner: { name: 'TokenScope' },
    metadata: {
      description: `TokenScope plugin for Claude Code, served by ${origin}. Already points at this deployment.`,
      version: archive.version,
    },
    plugins: [
      {
        name: PLUGIN_NAME,
        description: archive.description,
        version: archive.version,
        source: {
          source: 'archive',
          url: `${origin}/api/v1/plugin/${archive.fileName}`,
          sha256: archive.sha256,
        },
      },
    ],
  }
}
