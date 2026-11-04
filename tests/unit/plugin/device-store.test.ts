// @vitest-environment node
/*
 * device-store.mjs — the ONE definition of where each lane's enrolment lives.
 *
 * Both plugins vendor this file through the sync gate, so a drift between the
 * two copies would mean each lane reads the other's enrolment as absent — the
 * exact split the module exists to end. These tests pin the shapes both copies
 * must agree on, and the tool validation, which is a boundary rather than a
 * convenience: the store FILENAME is derived from the tool, so an unvalidated
 * value would let a caller name any file in the state dir.
 *
 * See docs/design/device-store-per-tool-sections.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  TOOLS,
  deviceStorePath,
  accessCachePath,
  legacyStorePath,
  resolveStorePath,
  bearerInstance,
  attrsTool,
  assertStoreConsistent,
} from '../../../plugin/scripts/device-store.mjs'

// Windows (#430): skipped on win32 because this file compares the store with the POSIX .sh helper, which Windows does not run.
const POSIX_ONLY = process.platform === 'win32'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-devstore-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(POSIX_ONLY)('paths are per tool and never collide', () => {
  it('names one store and one access cache per tool', () => {
    expect(deviceStorePath('claude-code', dir)).toBe(join(dir, 'config.claude-code.json'))
    expect(deviceStorePath('copilot-cli', dir)).toBe(join(dir, 'config.copilot-cli.json'))
    expect(accessCachePath('claude-code', dir)).toBe(join(dir, 'oauth-access.claude-code.json'))
    expect(accessCachePath('copilot-cli', dir)).toBe(join(dir, 'oauth-access.copilot-cli.json'))
  })

  it('gives the two lanes disjoint files, which is the whole point', () => {
    const paths = TOOLS.flatMap((t) => [deviceStorePath(t, dir), accessCachePath(t, dir)])
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).not.toContain(legacyStorePath(dir))
  })

  it('REFUSES an unknown tool rather than deriving a filename from it', () => {
    for (const bad of ['../../etc/passwd', 'claude', '', 'CLAUDE-CODE']) {
      expect(() => deviceStorePath(bad, dir)).toThrow(/unknown tool/)
      expect(() => accessCachePath(bad, dir)).toThrow(/unknown tool/)
    }
  })
})

describe.skipIf(POSIX_ONLY)('resolveStorePath — own file first, legacy only as a bridge', () => {
  it('prefers this lane own file when both exist', () => {
    writeFileSync(legacyStorePath(dir), '{}')
    writeFileSync(deviceStorePath('claude-code', dir), '{}')
    expect(resolveStorePath('claude-code', dir)).toBe(deviceStorePath('claude-code', dir))
  })

  it('falls back to the legacy file so an un-migrated device keeps working', () => {
    writeFileSync(legacyStorePath(dir), '{}')
    expect(resolveStorePath('copilot-cli', dir)).toBe(legacyStorePath(dir))
  })

  it('names this lane own path when nothing is on disk, so errors point at the right file', () => {
    expect(resolveStorePath('copilot-cli', dir)).toBe(deviceStorePath('copilot-cli', dir))
  })

  it('does not let one lane own file satisfy the other lane', () => {
    writeFileSync(deviceStorePath('copilot-cli', dir), '{}')
    expect(resolveStorePath('claude-code', dir)).toBe(deviceStorePath('claude-code', dir))
  })
})

describe.skipIf(POSIX_ONLY)('correlation helpers', () => {
  it('extracts the instance an endpoint addresses', () => {
    expect(bearerInstance('https://h/api/v1/instances/abc-123/bearer')).toBe('abc-123')
  })

  it('returns empty for anything not instance-shaped, so a caller cannot match on ""', () => {
    for (const v of ['https://h/bearer', '', null, undefined, 'nonsense']) {
      expect(bearerInstance(v as string)).toBe('')
    }
  })

  /*
   * THIS VALUE DECIDES OWNERSHIP, so a substring match is not good enough. An
   * unanchored pattern read `https://evil.example/?next=/instances/good/bearer`
   * as instance `good`, which would let a crafted endpoint pass the check that
   * says a legacy store belongs to this lane.
   */
  it.each([
    ['https://h/api/v1/instances/abc-123/bearer', 'abc-123'],
    ['https://evil.example/?next=/instances/good/bearer', ''],
    ['https://h/instances/a/bearer#/instances/b/bearer', ''],
    ['https://h/x/instances/a/instances/b/bearer', 'b'],
    ['https://h/instances//bearer', ''],
    ['https://h/api/v1/instances/abc/bearer/extra', ''],
  ])('is end-anchored on the pathname: %s', (input, expected) => {
    expect(bearerInstance(input)).toBe(expected)
  })

  /*
   * The shell helper answers the SAME question on the same data, so the two
   * must not disagree. This drives the real sed out of otel-headers-helper.sh.
   */
  it('agrees with the shell helper on every case', () => {
    const sed = String.raw`s|^[^?#]*/instances/\([^/?#][^/?#]*\)/bearer$|\1|p`
    const helper = readFileSync(
      join(process.cwd(), 'plugin/scripts/otel-headers-helper.sh'),
      'utf8',
    )
    expect(helper, 'the shell pattern changed; update this test and re-compare').toContain(sed)
    const cases = [
      'https://h/api/v1/instances/abc-123/bearer',
      'https://evil.example/?next=/instances/good/bearer',
      'https://h/instances/a/bearer#/instances/b/bearer',
      'https://h/x/instances/a/instances/b/bearer',
      'https://h/bearer',
      'nonsense',
    ]
    for (const c of cases) {
      const shell = execFileSync('sed', ['-n', sed], { input: c, encoding: 'utf8' }).trim()
      expect(bearerInstance(c), `disagreement on ${c}`).toBe(shell)
    }
  })

  it('reads the tool marker out of a resource-attributes string', () => {
    expect(attrsTool('tokenscope.instance_id=i,tool=copilot-cli')).toBe('copilot-cli')
    expect(attrsTool('tool=claude-code,tokenscope.instance_id=i')).toBe('claude-code')
    expect(attrsTool('tokenscope.instance_id=i')).toBe('')
    expect(attrsTool(undefined as unknown as string)).toBe('')
  })
})

describe.skipIf(POSIX_ONLY)('assertStoreConsistent — the writer-side mirror of what the helper refuses', () => {
  const ok = () => ({
    version: 2,
    tool: 'claude-code',
    instance_id: 'i-1',
    bearer_endpoint: 'https://h/api/v1/instances/i-1/bearer',
    oauth_token_endpoint: 'https://h/oauth/token',
    oauth_refresh_token: 'rt-1',
    otel_resource_attributes: 'tokenscope.instance_id=i-1,tool=claude-code',
  })

  it('accepts a consistent store', () => {
    expect(() => assertStoreConsistent('claude-code', ok())).not.toThrow()
  })

  /*
   * Every one of these would have been WRITTEN successfully and then refused by
   * the helper forever, with setup having already reported success.
   */
  it.each([
    ['tool is another lane', { tool: 'copilot-cli' }, /tool/],
    ['attributes name another tool', { otel_resource_attributes: 'tokenscope.instance_id=i-1,tool=copilot-cli' }, /name tool/],
    ['attributes name another instance', { otel_resource_attributes: 'tokenscope.instance_id=i-9,tool=claude-code' }, /name instance/],
    ['attributes truncated', { otel_resource_attributes: 'tokenscope.instance_id=i,tool=claude-code' }, /name instance/],
    ['bearer addresses another instance', { bearer_endpoint: 'https://h/api/v1/instances/i-9/bearer' }, /addresses instance/],
    ['bearer not instance-shaped', { bearer_endpoint: 'https://h/bearer' }, /addresses instance/],
    ['no instance_id', { instance_id: '' }, /no instance_id/],
    // The helper's other refusals: completeness, envelope, endpoint safety, and
    // the sed extraction every field must survive.
    ['version missing', { version: undefined }, /version/],
    ['version is a string', { version: '2' }, /version/],
    ['no refresh token', { oauth_refresh_token: '' }, /no oauth_refresh_token/],
    ['no token endpoint', { oauth_token_endpoint: '' }, /no oauth_token_endpoint/],
    ['no attributes', { otel_resource_attributes: '' }, /no otel_resource_attributes/],
    ['bearer is http off-box', { bearer_endpoint: 'http://h/api/v1/instances/i-1/bearer' }, /insecure-scheme/],
    ['token endpoint is http off-box', { oauth_token_endpoint: 'http://h/oauth/token' }, /insecure-scheme/],
    ['refresh token has a quote', { oauth_refresh_token: 'rt"1' }, /oauth_refresh_token is not readable/],
    ['token endpoint has a backslash', { oauth_token_endpoint: 'https://h/oauth\\token' }, /oauth_token_endpoint is not readable/],
    ['client id has a newline', { oauth_client_id: 'c\nid' }, /oauth_client_id is not readable/],
    ['attributes have a control char', { otel_resource_attributes: 'tokenscope.instance_id=i-1,tool=claude-code\u0001' }, /otel_resource_attributes is not readable/],
  ])('rejects: %s', (_l, patch, re) => {
    expect(() => assertStoreConsistent('claude-code', { ...ok(), ...patch })).toThrow(re)
  })

  // The optional `helper` record (S1 of #408): accepted when well-formed, and
  // adding it never lets through a store the checks above refuse.
  it('accepts a store carrying a well-formed helper record', () => {
    for (const helper of [
      { tool: 'claude-code', platform: 'linux' },
      { tool: 'claude-code', platform: 'darwin', stateDir: '/Users/jo do/.ts-sandbox' },
      { tool: 'claude-code', platform: 'win32', stateDir: 'C:\\Users\\Jo Do\\.tokenscope' },
    ]) {
      expect(() => assertStoreConsistent('claude-code', { ...ok(), helper })).not.toThrow()
    }
  })

  it.each([
    ['not an object', 'x'],
    ['another lane', { tool: 'copilot-cli', platform: 'linux' }],
    ['an unknown field', { tool: 'claude-code', platform: 'linux', script: '/evil.sh' }],
    ['no platform', { tool: 'claude-code' }],
    ['a platform that is not a name', { tool: 'claude-code', platform: 'linux; rm -rf' }],
    ['a relative state dir', { tool: 'claude-code', platform: 'linux', stateDir: '.ts' }],
    ['a state dir with a quote', { tool: 'claude-code', platform: 'linux', stateDir: '/a"b' }],
    ['a state dir with a newline', { tool: 'claude-code', platform: 'linux', stateDir: '/a\nb' }],
    ['a relative state dir on win32', { tool: 'claude-code', platform: 'win32', stateDir: 'relative\\x' }],
  ])('rejects a helper record with %s', (_l, helper) => {
    expect(() => assertStoreConsistent('claude-code', { ...ok(), helper })).toThrow(/helper record/)
  })

  it('a helper record does not rescue a store the other checks refuse', () => {
    const helper = { tool: 'claude-code', platform: 'linux' }
    expect(() => assertStoreConsistent('claude-code', { ...ok(), helper, oauth_refresh_token: '' })).toThrow(/no oauth_refresh_token/)
    expect(() => assertStoreConsistent('claude-code', { ...ok(), helper, bearer_endpoint: 'https://h/api/v1/instances/i-9/bearer' })).toThrow(/addresses instance/)
  })

  it('accepts loopback http endpoints (a local dev server)', () => {
    expect(() =>
      assertStoreConsistent('claude-code', {
        ...ok(),
        bearer_endpoint: 'http://localhost:3450/api/v1/instances/i-1/bearer',
        oauth_token_endpoint: 'http://127.0.0.1:3450/oauth/token',
      }),
    ).not.toThrow()
  })

  it('names the field and never the value when an endpoint is rejected', () => {
    let msg = ''
    try {
      assertStoreConsistent('claude-code', { ...ok(), oauth_token_endpoint: 'http://evil.example/leak-me' })
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toMatch(/oauth_token_endpoint/)
    expect(msg).not.toContain('evil.example')
  })
})
