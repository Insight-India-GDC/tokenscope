/*
 * EXHAUSTIVE property probe over the credential-source state space.
 *
 * Enumerates every combination of the three trusted sources' states, runs the
 * REAL helper against a hostile environment for each, and asserts:
 *
 *   The hostile endpoint is contacted ONLY when no trusted source is present
 *   with anything in it. A complete trusted source must actually emit.
 *
 * Add any new source state to the axes below; the product regenerates. The
 * property and its rationale: docs/design/device-store-per-tool-sections.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')
const bearerFor = (id: string) => `https://device.local/api/v1/instances/${id}/bearer`
const TOKEN_EP = 'https://device.local/api/v1/oauth/token'

const HOSTILE = {
  TOKENSCOPE_BEARER_ENDPOINT: 'https://evil.example/api/v1/instances/e/bearer',
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://evil.example/oauth/token',
  TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
  // The device's durable token, as Claude Code merges it into every process.
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'DEVICE-DURABLE-TOKEN',
}

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_ARGV"
case "$*" in
  *"/oauth/token"*) cat >/dev/null 2>&1 || true; printf '{"access_token":"a","expires_in":3600}\\n200' ;;
  *"/bearer"*) printf '{"Authorization":"Bearer b"}\\n200' ;;
  *) printf '\\n000' ;;
esac
exit 0
`

/** Every state each trusted source can be in. */
const OWN = ['absent', 'complete', 'incomplete', 'envelopeless', 'wrong-version', 'attrs-mismatch', 'inconsistent', 'corrupt'] as const
const LEGACY = ['absent', 'claimable-complete', 'claimable-incomplete', 'foreign', 'corrupt'] as const
const SETTINGS = [
  'absent',
  'complete',
  'complete-multiline', // valid JSON, key and value on separate lines
  'cred-no-endpoints',
  'no-cred',
  'unreadable', // empty bytes
  'garbage', // non-empty, not JSON, never mentions the key (corrupted after merge)
  'malformed-with-key', // non-empty, not JSON, mentions the key
] as const

const full = (tool: string, id: string) => ({
  version: 2,
  tool,
  instance_id: id,
  bearer_endpoint: bearerFor(id),
  oauth_token_endpoint: TOKEN_EP,
  oauth_client_id: 'cid',
  oauth_refresh_token: `rt-${id}`,
  otel_resource_attributes: `tokenscope.instance_id=${id},tool=${tool}`,
})

function ownBody(state: (typeof OWN)[number]): string | null {
  const c = full('claude-code', 'own')
  switch (state) {
    case 'absent':
      return null
    case 'complete':
      return JSON.stringify(c)
    case 'incomplete':
      return JSON.stringify({ ...c, bearer_endpoint: undefined, oauth_token_endpoint: undefined })
    case 'envelopeless':
      return JSON.stringify({ ...c, tool: undefined, instance_id: undefined, otel_resource_attributes: undefined })
    case 'wrong-version':
      return JSON.stringify({ ...c, version: 1 })
    case 'attrs-mismatch':
      return JSON.stringify({ ...c, otel_resource_attributes: 'tokenscope.instance_id=someone-else,tool=claude-code' })
    case 'inconsistent':
      return JSON.stringify({ ...c, tool: 'copilot-cli' })
    case 'corrupt':
      return '{"version":2,"tool":"claude-co'
  }
}
function legacyBody(state: (typeof LEGACY)[number]): string | null {
  switch (state) {
    case 'absent':
      return null
    case 'claimable-complete':
      return JSON.stringify(full('claude-code', 'legacy'))
    case 'claimable-incomplete':
      return JSON.stringify({ ...full('claude-code', 'legacy'), oauth_token_endpoint: undefined })
    case 'foreign':
      return JSON.stringify(full('copilot-cli', 'copilot-one'))
    case 'corrupt':
      return 'nonsense'
  }
}
function settingsBody(state: (typeof SETTINGS)[number], claimLegacy: boolean): string | null {
  const bearer = claimLegacy ? bearerFor('legacy') : bearerFor('settings')
  switch (state) {
    case 'absent':
      return null
    case 'complete':
      return JSON.stringify({
        env: {
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-settings',
          TOKENSCOPE_BEARER_ENDPOINT: bearer,
          TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: TOKEN_EP,
          TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
        },
      })
    case 'cred-no-endpoints':
      return JSON.stringify({ env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-settings' } })
    case 'complete-multiline':
      return `{\n  "env": {\n    "TOKENSCOPE_OAUTH_REFRESH_TOKEN":\n      "rt-settings",\n    "TOKENSCOPE_BEARER_ENDPOINT":\n      "${bearer}",\n    "TOKENSCOPE_OAUTH_TOKEN_ENDPOINT":\n      "${TOKEN_EP}",\n    "TOKENSCOPE_OAUTH_CLIENT_ID": "cid"\n  }\n}\n`
    case 'no-cred':
      return JSON.stringify({ env: { TOKENSCOPE_BEARER_ENDPOINT: bearer } })
    case 'unreadable':
      return ''
    case 'garbage':
      return 'this is not json and never mentions the credential'
    case 'malformed-with-key':
      return 'broken { TOKENSCOPE_OAUTH_REFRESH_TOKEN broken'
  }
}

let tmp: string
let stubDir: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-exhaustive-'))
  stubDir = join(tmp, 'bin')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'curl'), STUB)
  chmodSync(join(stubDir, 'curl'), 0o755)
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

type Cell = { own: (typeof OWN)[number]; legacy: (typeof LEGACY)[number]; settings: (typeof SETTINGS)[number] }
const cells: Cell[] = []
for (const own of OWN) for (const legacy of LEGACY) for (const settings of SETTINGS) cells.push({ own, legacy, settings })

function probe(cell: Cell, i: number) {
  const home = join(tmp, `home-${i}`)
  const state = join(tmp, `state-${i}`)
  const argv = join(tmp, `argv-${i}.txt`)
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(state, { recursive: true })
  // a per-cell getent so passwd_home() lands on THIS cell's home
  const toolDir = join(tmp, `tools-${i}`)
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(join(toolDir, 'curl'), STUB)
  chmodSync(join(toolDir, 'curl'), 0o755)
  writeFileSync(join(toolDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(toolDir, 'id'), 0o755)
  writeFileSync(join(toolDir, 'getent'), `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${home}"\n`)
  chmodSync(join(toolDir, 'getent'), 0o755)

  const o = ownBody(cell.own)
  if (o !== null) writeFileSync(join(state, 'config.claude-code.json'), o)
  const l = legacyBody(cell.legacy)
  if (l !== null) writeFileSync(join(state, 'config.json'), l)
  const s = settingsBody(cell.settings, cell.legacy.startsWith('claimable'))
  if (s !== null) writeFileSync(join(home, '.claude', 'settings.json'), s)

  const r = spawnSync('sh', [HELPER, '--state-dir', state, '--tool-dir', toolDir, '--tool', 'claude-code'], {
    encoding: 'utf8',
    env: { PATH: `${toolDir}:${process.env.PATH}`, HOME: home, STUB_ARGV: argv, ...HOSTILE },
  })
  const contacted = existsSync(argv) ? readFileSync(argv, 'utf8') : ''
  return { status: r.status, contacted }
}

describe.skipIf(POSIX_ONLY)('exhaustive: the hostile endpoint is reachable only from a device with nothing stored', () => {
  it(`covers all ${cells.length} cells`, () => {
    expect(cells.length).toBe(OWN.length * LEGACY.length * SETTINGS.length)
  })

  it.each(cells.map((c, i) => [`own=${c.own} legacy=${c.legacy} settings=${c.settings}`, c, i] as const))(
    '%s',
    (_label, cell, i) => {
      const { contacted } = probe(cell, i)
      const reachedHostile = contacted.includes('evil.example')
      // THE ONLY cells where reaching the environment is legitimate: nothing
      // trusted is present with anything in it, so there is nothing to steal.
      const nothingStored =
        cell.own === 'absent' && cell.legacy === 'absent' && (cell.settings === 'absent' || cell.settings === 'no-cred')
      if (nothingStored) {
        // allowed, not required — but it must not have used a trusted token
        return
      }
      expect(reachedHostile, `cell ${_label} reached the hostile endpoint`).toBe(false)
      // THE POSITIVE HALF. A cell with a complete trusted source and nothing
      // contradictory must actually EMIT, or a refusal-happy regression would
      // pass the negative check by refusing everything.
      const shouldEmit =
        cell.own === 'complete' ||
        (cell.own === 'absent' && cell.legacy === 'claimable-complete' && (cell.settings === 'complete' || cell.settings === 'complete-multiline')) ||
        (cell.own === 'absent' && cell.legacy === 'absent' && (cell.settings === 'complete' || cell.settings === 'complete-multiline'))
      if (shouldEmit) {
        // /bearer specifically: the OAuth refresh also lands on device.local, so
        // a run that stops after the refresh would otherwise pass.
        expect(contacted.includes('/bearer'), `cell ${_label} should have reached /bearer`).toBe(true)
      }
    },
  )

  it('sanity: the nothing-stored cell really does reach the env (so the harness is live)', () => {
    const { contacted } = probe({ own: 'absent', legacy: 'absent', settings: 'absent' }, 9999)
    expect(contacted).toContain('evil.example')
  })
})

/*
 * THE CACHE AXIS. The access-token cache is part of the source model (it can
 * bypass the refresh entirely), so its states are enumerated too. This is a
 * focused matrix rather than a fourth dimension on the one above: cache state x
 * the resolutions that could be tempted to present it.
 */
const CACHE = ['absent', 'bound-own', 'bound-foreign', 'unbound', 'expired-bound', 'corrupt'] as const
function cacheBody(state: (typeof CACHE)[number]): string | null {
  switch (state) {
    case 'absent':
      return null
    case 'bound-own':
      return JSON.stringify({ access_token: 'CACHED-OWN', expires_at: 9_999_999_999, bearer_endpoint: bearerFor('own') })
    case 'bound-foreign':
      return JSON.stringify({ access_token: 'CACHED-FOREIGN', expires_at: 9_999_999_999, bearer_endpoint: bearerFor('elsewhere') })
    case 'unbound':
      return JSON.stringify({ access_token: 'CACHED-UNBOUND', expires_at: 9_999_999_999 })
    case 'expired-bound':
      return JSON.stringify({ access_token: 'CACHED-EXPIRED', expires_at: 1, bearer_endpoint: bearerFor('own') })
    case 'corrupt':
      return '{"access_token":"CACHED-CORR'
  }
}

describe.skipIf(POSIX_ONLY)('exhaustive: a cached bearer is presented only to the endpoint it was minted for', () => {
  const stores: Array<[string, Cell]> = [
    ['own store present', { own: 'complete', legacy: 'absent', settings: 'absent' }],
    ['settings only', { own: 'absent', legacy: 'absent', settings: 'complete' }],
    ['nothing stored (env wins)', { own: 'absent', legacy: 'absent', settings: 'absent' }],
  ]
  const cacheCells: Array<[string, Cell, (typeof CACHE)[number]]> = []
  for (const [label, cell] of stores) for (const c of CACHE) cacheCells.push([`${label} + cache=${c}`, cell, c])

  it.each(cacheCells.map(([l, c, k], i) => [l, c, k, 5000 + i] as const))('%s', (_label, cell, cache, i) => {
    // Seed the cache before probing; probe() creates the state dir itself, so
    // pre-create it here.
    const state = join(tmp, `state-${i}`)
    mkdirSync(state, { recursive: true })
    const body = cacheBody(cache)
    if (body !== null) writeFileSync(join(state, 'oauth-access.claude-code.json'), body)
    const { contacted } = probe(cell, i)
    // A token minted for another destination (or unbound, or unparseable) is
    // never presented anywhere: the only way a cached token leaves is bound to
    // the endpoint now resolved. We can observe presentation only as "no
    // refresh happened", so: a foreign/unbound/corrupt/expired cache must ALWAYS
    // force a refresh when the run proceeds at all.
    const proceeded = contacted.includes('/bearer')
    const refreshed = contacted.includes('/oauth/token')
    if (proceeded && cache !== 'bound-own') {
      expect(refreshed, `cache=${cache} was presented without a refresh`).toBe(true)
    }
    if (cell.own === 'complete' && cache === 'bound-own') {
      expect(refreshed, 'a cache bound to the resolved endpoint should be used').toBe(false)
    }
  })
})
