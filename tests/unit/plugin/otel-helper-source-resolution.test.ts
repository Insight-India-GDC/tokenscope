// @vitest-environment node
/*
 * otel-headers-helper.sh — the credential/destination source table.
 *
 * This file is the executable form of "Where the credential and destinations
 * come from" in docs/design/device-store-per-tool-sections.md. It was written
 * FROM that table, before the helper was restructured to match it, so it
 * encodes the property rather than the implementation.
 *
 * THE PROPERTY: a credential from a trusted source is never paired with a
 * destination from a less trusted one.
 *
 * Sources, most trusted first: this lane's own store; the legacy shared store if
 * this lane can claim it; the device's own ~/.claude/settings.json on the passwd
 * home; and last the process environment, which is NOT trusted because Claude
 * Code merges a repository's settings env into it.
 *
 * Per source: absent goes to the next one, present-but-incomplete REFUSES (it
 * must never borrow a destination from elsewhere), present-and-complete is
 * adopted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file drives the POSIX .sh helper, which Windows does not run; the PowerShell twin is covered by otel-helper-conformance, claude-redeem-ps1 and status-ps1.
const POSIX_ONLY = process.platform === 'win32'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')

const OWN = 'own-instance'
const LEGACY = 'legacy-instance'
const SETTINGS = 'settings-instance'
const bearerFor = (id: string) => `https://device.local/api/v1/instances/${id}/bearer`
const tokenEp = (host = 'device.local') => `https://${host}/api/v1/oauth/token`

/** The environment a hostile repository contributes. Never a valid answer. */
const HOSTILE = {
  TOKENSCOPE_BEARER_ENDPOINT: bearerFor('HOSTILE').replace('device.local', 'evil.example'),
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEp('evil.example'),
  TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-env',
}

const STUB = `#!/bin/sh
a="$*"
printf '%s\\n' "$a" >> "$STUB_ARGV"
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true
    printf '{"access_token":"stub-access","expires_in":3600}\\n200' ;;
  *"/bearer"*) printf '{"Authorization":"Bearer stub-bearer"}\\n200' ;;
  *) printf '\\n000' ;;
esac
exit 0
`

let tmp: string
let stubDir: string
let stateDir: string
let passwdHome: string
let argvLog: string

const sentinelMsg = () => {
  const f = join(stateDir, 'emit-failure.claude-code.json')
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).message as string) : null
}
const contacted = () =>
  existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : ''

/** A COMPLETE v2 store: credential + both destinations. */
function completeStore(tool: string, instance: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2,
    tool,
    instance_id: instance,
    bearer_endpoint: bearerFor(instance),
    oauth_token_endpoint: tokenEp(),
    oauth_client_id: 'cid',
    oauth_refresh_token: `rt-${instance}`,
    otel_resource_attributes: `tokenscope.instance_id=${instance},tool=${tool}`,
    ...extra,
  })
}

const writeOwn = (tool: string, body: string) =>
  writeFileSync(join(stateDir, `config.${tool}.json`), body)
const writeLegacy = (body: string) => writeFileSync(join(stateDir, 'config.json'), body)
function writeSettings(env: Record<string, string>) {
  mkdirSync(join(passwdHome, '.claude'), { recursive: true })
  writeFileSync(join(passwdHome, '.claude', 'settings.json'), JSON.stringify({ env }, null, 2))
}
/** Settings naming SETTINGS as the instance, which is how we tell sources apart. */
const completeSettings = () => ({
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-settings',
  TOKENSCOPE_BEARER_ENDPOINT: bearerFor(SETTINGS),
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEp(),
  TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
})

function run(tool = 'claude-code', env: Record<string, string> = {}) {
  return spawnSync('sh', [HELPER, '--state-dir', stateDir, '--tool-dir', stubDir, '--tool', tool], {
    encoding: 'utf8',
    env: { PATH: `${stubDir}:${process.env.PATH}`, HOME: tmp, STUB_ARGV: argvLog, ...env },
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-src-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  passwdHome = join(tmp, 'passwd-home')
  argvLog = join(tmp, 'argv.txt')
  for (const d of [stubDir, stateDir, passwdHome]) mkdirSync(d, { recursive: true })
  writeFileSync(join(stubDir, 'curl'), STUB)
  chmodSync(join(stubDir, 'curl'), 0o755)
  // Redirect the passwd lookup so "the real home" is a temp dir, never the
  // developer's own enrolment.
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(
    join(stubDir, 'getent'),
    `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`,
  )
  chmodSync(join(stubDir, 'getent'), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Assert the run adopted `instance`'s endpoints and touched nothing hostile. */
function expectAdopted(r: { status: number | null }, instance: string) {
  expect(r.status, 'expected a successful mint').toBe(0)
  expect(contacted()).toContain(bearerFor(instance))
  expect(contacted()).not.toContain('evil.example')
}
/** Assert the run refused BEFORE any network call. */
function expectRefused(r: { status: number | null }, message: string) {
  expect(r.status).toBe(1)
  expect(sentinelMsg()).toBe(message)
  expect(contacted()).toBe('')
}

describe.skipIf(POSIX_ONLY)('source 1 — this lane own store', () => {
  it('complete: adopted', () => {
    writeOwn('claude-code', completeStore('claude-code', OWN))
    expectAdopted(run(), OWN)
  })

  it('wins over every lower source', () => {
    writeOwn('claude-code', completeStore('claude-code', OWN))
    writeLegacy(completeStore('claude-code', LEGACY))
    writeSettings(completeSettings())
    expectAdopted(run('claude-code', HOSTILE), OWN)
  })

  it.each([
    ['empty', ''],
    ['not json', 'nonsense'],
    ['truncated', '{"version":2,"tool":"claude-code","bearer_e'],
    ['no destinations', '{"version":2,"tool":"claude-code","oauth_refresh_token":"x"}'],
  ])('incomplete (%s): REFUSES rather than borrowing a destination', (_l, body) => {
    writeOwn('claude-code', body)
    writeSettings(completeSettings()) // a perfectly good lower source is NOT used
    expectRefused(run('claude-code', HOSTILE), 'store present but unreadable')
  })

  /*
   * A file with a credential and both endpoints but NO envelope used to be
   * adopted: every consistency check was conditional on its field being present,
   * so a complete pre-v2 store, or the other lane's store simply RENAMED to this
   * lane's filename, skipped them all and defeated the copy detection.
   */
  it('REFUSES a store whose version is not 2, however complete', () => {
    writeOwn('claude-code', JSON.stringify({ ...JSON.parse(completeStore('claude-code', OWN)), version: 1 }))
    expectRefused(run('claude-code', HOSTILE), 'store missing the v2 envelope')
  })

  it('REFUSES a store whose bearer endpoint is not instance-shaped', () => {
    // An empty parsed instance used to SKIP the mismatch check, so a malformed
    // https endpoint was adopted and received the minted token.
    writeOwn(
      'claude-code',
      completeStore('claude-code', OWN, { bearer_endpoint: 'https://device.local/bearer' }),
    )
    expectRefused(run('claude-code', HOSTILE), 'store instance/endpoint mismatch')
  })

  it('REFUSES a store whose attributes name a different instance than the file', () => {
    writeOwn(
      'claude-code',
      completeStore('claude-code', OWN, {
        otel_resource_attributes: `tokenscope.instance_id=someone-else,tool=claude-code`,
      }),
    )
    expectRefused(run('claude-code', HOSTILE), 'store attributes inconsistent')
  })

  it.each(['tool', 'instance_id', 'otel_resource_attributes'])(
    'REFUSES a credential-complete file missing the v2 envelope (no %s)',
    (field) => {
      const base = JSON.parse(completeStore('claude-code', OWN)) as Record<string, unknown>
      const without = Object.fromEntries(Object.entries(base).filter(([k]) => k !== field))
      writeOwn('claude-code', JSON.stringify(without))
      expectRefused(run('claude-code', HOSTILE), 'store missing the v2 envelope')
    },
  )

  it.each([
    ['declares another lane', completeStore('copilot-cli', OWN), 'store tool mismatch'],
    [
      'marker names another lane',
      completeStore('claude-code', OWN, {
        otel_resource_attributes: `tokenscope.instance_id=${OWN},tool=copilot-cli`,
      }),
      'store marker mismatch',
    ],
    [
      'endpoint addresses another instance',
      completeStore('claude-code', OWN, { bearer_endpoint: bearerFor('somebody-else') }),
      'store instance/endpoint mismatch',
    ],
  ])('self-inconsistent (%s): REFUSES', (_l, body, message) => {
    writeOwn('claude-code', body)
    expectRefused(run('claude-code', HOSTILE), message as string)
  })
})

describe.skipIf(POSIX_ONLY)('source 2 — the legacy shared store', () => {
  it('claude adopts it when the device settings prove it is ours', () => {
    writeLegacy(completeStore('claude-code', LEGACY))
    writeSettings({ ...completeSettings(), TOKENSCOPE_BEARER_ENDPOINT: bearerFor(LEGACY) })
    expectAdopted(run('claude-code', HOSTILE), LEGACY)
  })

  /*
   * THE BEHAVIOUR CHANGE THE TABLE MAKES POSSIBLE. A legacy store belonging to
   * the other lane used to be a terminal refusal. It is simply ABSENT for this
   * lane, so resolution continues to the device's own settings: trusted,
   * complete, and the device keeps emitting instead of going dark.
   */
  it('claude SKIPS a legacy store it cannot claim and falls to its own settings', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    writeSettings(completeSettings())
    expectAdopted(run('claude-code', HOSTILE), SETTINGS)
  })

  it('copilot adopts the legacy store without needing a claim', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    expectAdopted(run('copilot-cli'), LEGACY)
  })

  /*
   * Asserts the REFUSAL ITSELF, by name. An earlier version checked only "exit
   * 1", which held even with the completeness check removed: an adopted-but-
   * empty source blanks the endpoint variables and the downstream require-auth
   * check then fails for a different reason. That made the guard invisible, and
   * left its behaviour resting on an accident of assignment order.
   */
  it('an incomplete legacy store this lane CAN claim refuses AS a source, not downstream', () => {
    writeLegacy(JSON.stringify({ oauth_refresh_token: 'x', bearer_endpoint: bearerFor(LEGACY) }))
    writeSettings({ ...completeSettings(), TOKENSCOPE_BEARER_ENDPOINT: bearerFor(LEGACY) })
    expectRefused(run('claude-code', HOSTILE), 'legacy store present but incomplete')
  })
})

describe.skipIf(POSIX_ONLY)('source 3 — the device own settings file', () => {
  it('complete: adopted, and the hostile environment is ignored', () => {
    writeSettings(completeSettings())
    expectAdopted(run('claude-code', HOSTILE), SETTINGS)
  })

  it('holds a credential but not both destinations: REFUSES', () => {
    writeSettings({ TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-settings', TOKENSCOPE_OAUTH_CLIENT_ID: 'c' })
    expectRefused(run('claude-code', HOSTILE), 'settings credential without both settings endpoints')
  })

  it('holds no credential: absent, so resolution continues', () => {
    writeSettings({ TOKENSCOPE_BEARER_ENDPOINT: bearerFor(SETTINGS) })
    const r = run('claude-code', {
      TOKENSCOPE_BEARER_ENDPOINT: bearerFor(OWN),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEp(),
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-env',
    })
    // No trusted credential existed, so there was nothing to protect.
    expect(r.status).toBe(0)
  })
})

describe.skipIf(POSIX_ONLY)('the access-token cache is inside the source model too', () => {
  /*
   * The cache holds a bearer minted from whichever source won LAST time. Left
   * unbound it sits outside the ordered list entirely: a token minted while a
   * trusted source was winning would be presented to whatever endpoint
   * resolution produces now, including a repo-chosen one on a device whose
   * trusted sources have since gone away. That is the same defect the source
   * list closes, one credential down, so the cache is bound to the destination
   * it was minted for.
   */
  const seedCache = (token: string, boundTo: string | null) =>
    writeFileSync(
      join(stateDir, 'oauth-access.claude-code.json'),
      JSON.stringify({
        access_token: token,
        expires_at: 9_999_999_999,
        ...(boundTo === null ? {} : { bearer_endpoint: boundTo }),
      }),
    )

  it('a cache minted for THIS destination is used', () => {
    writeOwn('claude-code', completeStore('claude-code', OWN))
    seedCache('CACHED', bearerFor(OWN))
    const r = run('claude-code')
    expect(r.status).toBe(0)
    // used the cache: no refresh round-trip was needed
    expect(contacted()).not.toContain('/oauth/token')
  })

  it('a cache minted for a DIFFERENT destination is discarded, not presented', () => {
    writeOwn('claude-code', completeStore('claude-code', OWN))
    seedCache('TRUSTED-MINTED', bearerFor('some-other-instance'))
    const r = run('claude-code')
    expect(r.status).toBe(0)
    // it refreshed instead of replaying a token minted elsewhere
    expect(contacted()).toContain('/oauth/token')
  })

  it('a trusted-minted cache is NOT sent to a repo-chosen endpoint', () => {
    // No store, and settings hold no credential, so resolution reaches the
    // hostile environment. A cache left over from a trusted resolution must not
    // ride along to it.
    seedCache('TRUSTED-MINTED', bearerFor(OWN))
    run('claude-code', HOSTILE)
    expect(contacted()).not.toContain('TRUSTED-MINTED')
    const hostileCalls = contacted()
      .split('\n')
      .filter((l) => l.includes('evil.example') && l.includes('TRUSTED-MINTED'))
    expect(hostileCalls).toEqual([])
  })

  it('a pre-binding cache (no endpoint recorded) is discarded once and replaced', () => {
    writeOwn('claude-code', completeStore('claude-code', OWN))
    seedCache('LEGACY-UNBOUND', null)
    const r = run('claude-code')
    expect(r.status).toBe(0)
    expect(contacted()).toContain('/oauth/token') // refreshed rather than replayed
    const written = JSON.parse(
      readFileSync(join(stateDir, 'oauth-access.claude-code.json'), 'utf8'),
    )
    expect(written.bearer_endpoint).toBe(bearerFor(OWN)) // now bound
  })
})

describe.skipIf(POSIX_ONLY)('an endpoint that cannot be bound is refused, not silently degraded', () => {
  /*
   * The cache is keyed on the endpoint verbatim, so a value carrying a quote,
   * backslash or control character cannot be recorded. Writing an unusable cache
   * instead would mean refreshing on EVERY invocation and reporting no-token
   * forever from landed-check and project-check: a silent degradation where a
   * refusal is honest.
   */
  it.each([
    ['a backslash', 'https://device.local/api/v1/instances/a\\b/bearer'],
    ['a quote', 'https://device.local/api/v1/instances/a"b/bearer'],
  ])('refuses a bearer endpoint containing %s', (_l, endpoint) => {
    const r = run('claude-code', {
      TOKENSCOPE_BEARER_ENDPOINT: endpoint,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEp(),
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-env',
    })
    expect(r.status).toBe(1)
    expect(sentinelMsg()).toBe('bearer endpoint not bindable')
    expect(contacted()).toBe('')
  })
})

describe.skipIf(POSIX_ONLY)('a trusted source we could not use is not permission to use the environment', () => {
  /*
   * THE REGRESSION THE SOURCE LIST INTRODUCED, and the reason "absent" needed a
   * companion rule. Treating an unclaimable legacy store as absent let a device
   * fall all the way to the environment. The ambient refresh token there is the
   * DEVICE's (Claude Code merged it from the very settings file we may not be
   * able to read) while the endpoints beside it are the repository's, so the
   * durable credential was posted to a repo-selected host. Reproduced before the
   * fix: exit 0, and evil.example contacted twice.
   */
  it('REFUSES rather than falling to the env when a foreign legacy store is present', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY)) // the other lane's enrolment
    // no readable settings file, but the process still carries the device token
    const r = run('claude-code', HOSTILE)
    expect(r.status).toBe(1)
    expect(sentinelMsg()).toBe('trusted source unusable, ambient credential present')
    expect(contacted()).toBe('')
  })

  // #452: the refusal is right, but someone who lost or removed the store read
  // it as "my store is broken". It names the missing store and what it found.
  it('says the device store is missing and names the other enrolment it found', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    const r = run('claude-code', HOSTILE)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`This lane's device store ${join(stateDir, 'config.claude-code.json')} is missing.`)
    // No settings file to compare against: it cannot claim "another enrolment".
    expect(r.stderr).toContain(`The older shared store ${join(stateDir, 'config.json')} could not be matched to this lane`)
  })

  it('says "another enrolment" only when both instances were read and differ', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    writeSettings({ TOKENSCOPE_BEARER_ENDPOINT: bearerFor(SETTINGS) })
    const r = run('claude-code', HOSTILE)
    expect(r.stderr).toContain(`belongs to another enrolment (instance ${LEGACY};`)
  })

  it('names an unreadable settings file in the same refusal', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    mkdirSync(join(passwdHome, '.claude'), { recursive: true })
    writeFileSync(join(passwdHome, '.claude', 'settings.json'), '')
    const r = run('claude-code', HOSTILE)
    expect(r.stderr).toContain(`${join(passwdHome, '.claude', 'settings.json')} could not be read as a settings file.`)
  })

  it('REFUSES when the settings file is present but unreadable', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    mkdirSync(join(passwdHome, '.claude'), { recursive: true })
    writeFileSync(join(passwdHome, '.claude', 'settings.json'), '') // unreadable/empty
    const r = run('claude-code', HOSTILE)
    expect(r.status).toBe(1)
    expect(contacted()).not.toContain('evil.example')
  })

  it('still emits normally when the settings file IS usable', () => {
    writeLegacy(completeStore('copilot-cli', LEGACY))
    writeSettings(completeSettings())
    expectAdopted(run('claude-code', HOSTILE), SETTINGS)
  })
})

describe.skipIf(POSIX_ONLY)('source 4 — the environment, and only as the terminator', () => {
  it('is used when nothing is stored anywhere', () => {
    const r = run('claude-code', {
      TOKENSCOPE_BEARER_ENDPOINT: bearerFor(OWN),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEp(),
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-env',
    })
    expect(r.status).toBe(0)
  })

  it('incomplete: fails loudly rather than half-configured', () => {
    const r = run('claude-code', { TOKENSCOPE_OAUTH_CLIENT_ID: 'cid' })
    expect(r.status).toBe(1)
    expect(contacted()).toBe('')
  })

  /*
   * THE WHOLE POINT, stated as one assertion: in every state where a TRUSTED
   * source holds the credential, the hostile environment never receives it.
   */
  it.each([
    ['own store', () => writeOwn('claude-code', completeStore('claude-code', OWN))],
    [
      'legacy store',
      () => {
        writeLegacy(completeStore('claude-code', LEGACY))
        writeSettings({ ...completeSettings(), TOKENSCOPE_BEARER_ENDPOINT: bearerFor(LEGACY) })
      },
    ],
    ['device settings', () => writeSettings(completeSettings())],
  ])('a credential in the %s never reaches a repo-chosen endpoint', (_l, setup) => {
    setup()
    run('claude-code', HOSTILE)
    expect(contacted()).not.toContain('evil.example')
  })
})
