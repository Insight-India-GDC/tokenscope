/*
 * statusline — the TokenScope Claude Code status-line segment + its install /
 * remove (non-clobber) settings helpers.
 *
 * Guards the LANDING-driven render (the fix for the "auth minted a bearer fine but
 * nothing was landing, hidden behind a benign cyan ◎ emit-auth" incident):
 * classifyLanding() turns a cached /health answer into landed / dead / revoked /
 * unknown, and formatStatusLine() makes a DEAD EXPORT read clearly not-working
 * (red ✗ not landing) — never the benign cyan. Also guards the throttled-poll gate
 * (landedRefreshDue), the env-tag derivation, and that turning the status line on
 * never silently clobbers a developer's own custom status line.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLandedCache,
  formatStatusLine,
  emitEnvLabel,
  classifyLanding,
  landedRefreshDue,
  DEAD_EXPORT_MS,
  LANDED_LAG_MS,
  NEVER_LANDED_GRACE_MS,
  POLL_INTERVAL_MS,
} from '../../../plugin/scripts/statusline.mjs'
import {
  installStatusLine,
  removeStatusLine,
  tokenscopeStatusLine,
  reconcilePluginPaths,
} from '../../../plugin/scripts/env-builder.mjs'

const noColor = { color: false }
// A render where auth is fine and MCP is authed — landing then drives the colour.
const base = { configured: true, emitting: true, mcpAuthed: true, ...noColor }

describe('formatStatusLine — landing is the primary driver', () => {
  it('shows not-configured when there is no device emit config', () => {
    expect(formatStatusLine({ configured: false, emitting: false, mcpAuthed: false, sessionId: 'abc', ...noColor })).toBe(
      'TokenScope · not configured',
    )
  })

  it('red ✗ not landing on a DEAD EXPORT — auth fine but /health says nothing is landing (THE fix)', () => {
    // The core regression: landing==="dead" must NOT read as the benign cyan.
    expect(formatStatusLine({ ...base, landing: 'dead', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ✗ not landing #65d2c64f',
    )
  })

  it('red ✗ enrolment revoked when /health reports the enrolment revoked', () => {
    expect(formatStatusLine({ ...base, landing: 'revoked', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ✗ enrolment revoked #65d2c64f',
    )
  })

  it('green ✓ landed when delivery is CONFIRMED and MCP is authed', () => {
    expect(formatStatusLine({ ...base, landing: 'landed', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ✓ landed #65d2c64f',
    )
  })

  it('yellow ⚠ landed · emit-only when delivery confirmed but MCP NOT authed', () => {
    expect(formatStatusLine({ ...base, mcpAuthed: false, landing: 'landed', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ⚠ landed · emit-only #65d2c64f',
    )
  })

  it('neutral cyan ◎ emit-auth ONLY when /health is unreachable (landing unknown) — never for a dead export', () => {
    // The fallback: auth fine + MCP authed + delivery unconfirmed. Distinct from green.
    expect(formatStatusLine({ ...base, landing: 'unknown', sessionId: '65d2c64f-0545-49ab' })).toBe(
      'TokenScope ◎ emit-auth #65d2c64f',
    )
  })

  it('landing defaults to unknown → the neutral cyan fallback', () => {
    expect(formatStatusLine({ ...base, sessionId: '65d2c64f-0545' })).toBe('TokenScope ◎ emit-auth #65d2c64f')
  })

  it('yellow ⚠ emit-only when landing unknown AND MCP NOT authed', () => {
    expect(formatStatusLine({ ...base, mcpAuthed: false, landing: 'unknown', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ⚠ emit-only #65d2c64f',
    )
  })

  it('red ✗ emit-auth failing outranks landing — a broken credential is the root problem', () => {
    expect(formatStatusLine({ ...base, emitting: false, landing: 'landed', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ✗ emit-auth failing #65d2c64f',
    )
  })

  it('omits the session id when none is passed', () => {
    expect(formatStatusLine({ ...base, landing: 'unknown', sessionId: null })).toBe('TokenScope ◎ emit-auth')
  })

  it('appends the (Env) tag after the session id, in every state', () => {
    expect(formatStatusLine({ ...base, landing: 'unknown', sessionId: '0ac97f89-af0e', envLabel: 'Dev' })).toBe(
      'TokenScope ◎ emit-auth #0ac97f89 (Dev)',
    )
    expect(formatStatusLine({ ...base, landing: 'dead', sessionId: '0ac97f89-af0e', envLabel: 'Dev' })).toBe(
      'TokenScope ✗ not landing #0ac97f89 (Dev)',
    )
    expect(
      formatStatusLine({ ...base, emitting: false, sessionId: 'abc12345', envLabel: 'Sandbox' }),
    ).toBe('TokenScope ✗ emit-auth failing #abc12345 (Sandbox)')
  })
})

describe('classifyLanding — landing keyed off emit ACTIVITY, not wall-clock (pure, no network)', () => {
  const INSTANCE = 'e0d06f65-1100-4d6f-b544-e377a7b391a6'
  const NOW = Date.parse('2026-07-01T00:00:00Z')
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const cache = (over: Record<string, unknown> = {}) => ({ ok: true, instanceId: INSTANCE, ...over })
  // A client counts as ACTIVE when it minted a bearer within DEAD_EXPORT_MS.
  const RECENT_BEARER = iso(10 * 60 * 1000) // 10 min ago → active
  const OLD_BEARER = iso(12 * 60 * 60 * 1000) // 12h ago → idle

  it('null / non-object cache → unknown (never confirms OR denies)', () => {
    expect(classifyLanding(null, INSTANCE, NOW)).toBe('unknown')
    expect(classifyLanding(undefined, INSTANCE, NOW)).toBe('unknown')
    expect(classifyLanding('nope' as never, INSTANCE, NOW)).toBe('unknown')
  })

  it('cache from a refresh that never reached /health (ok!==true) → unknown', () => {
    expect(classifyLanding({ ok: false, instanceId: INSTANCE, lastEmission: null }, INSTANCE, NOW)).toBe('unknown')
    expect(classifyLanding({ instanceId: INSTANCE, lastEmission: null } as never, INSTANCE, NOW)).toBe('unknown')
  })

  it('cache left by a DIFFERENT enrolment (shared home dir) → unknown, never a false state', () => {
    const other = cache({ instanceId: 'other-instance', lastEmission: iso(0), lastBearer: RECENT_BEARER })
    expect(classifyLanding(other, INSTANCE, NOW)).toBe('unknown')
  })

  it('revoked → revoked (outranks everything)', () => {
    expect(
      classifyLanding(cache({ revoked: true, lastEmission: iso(60_000), lastBearer: RECENT_BEARER }), INSTANCE, NOW),
    ).toBe('revoked')
  })

  // ── CLIENT ACTIVE (recent bearer → we CAN judge landing) ────────────────────
  it('ACTIVE + watermark keeping up (emission ~30 min behind the bearer) → landed', () => {
    const c = cache({ lastBearer: iso(5 * 60 * 1000), lastEmission: iso(35 * 60 * 1000) }) // gap ~30 min
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('landed')
  })

  it('ACTIVE + WITHIN-SESSION IDLE (bearer 5 min ago on the 29-min timer, last real emission 3h ago) → landed, NOT dead', () => {
    // The false-positive the split threshold prevents: `last_bearer_at` is a
    // credential-refresh heartbeat, so it stays fresh while `last_emission`
    // legitimately lags by hours during a read/think stretch. A 3h gap < 24h.
    const c = cache({ lastBearer: iso(5 * 60 * 1000), lastEmission: iso(3 * 60 * 60 * 1000) })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('landed')
  })

  it('ACTIVE + gap just under LANDED_LAG_MS → landed; just over → dead (the boundary)', () => {
    const bearer = iso(5 * 60 * 1000)
    const bearerMs = NOW - 5 * 60 * 1000
    const underEmission = new Date(bearerMs - (LANDED_LAG_MS - 60_000)).toISOString() // gap < 24h
    const overEmission = new Date(bearerMs - (LANDED_LAG_MS + 60_000)).toISOString() // gap > 24h
    expect(classifyLanding(cache({ lastBearer: bearer, lastEmission: underEmission }), INSTANCE, NOW)).toBe('landed')
    expect(classifyLanding(cache({ lastBearer: bearer, lastEmission: overEmission }), INSTANCE, NOW)).toBe('dead')
  })

  it('ACTIVE + landed watermark FROZEN days back (gap ≫ 24h) → dead — THE dead-export detection', () => {
    // The week-long outage shape: bearer minted recently, last_emission stuck days ago.
    const c = cache({ lastBearer: RECENT_BEARER, lastEmission: iso(5.5 * 24 * 60 * 60 * 1000) })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('dead')
  })

  it('ACTIVE + NEVER landed with NO ts_start (older server) → unknown, NOT a false red', () => {
    // The HIGH finding: a brand-new device (bearer minted, first record not yet
    // landed ~10-60 min post-setup) must read the honest neutral 'unknown', never
    // red — otherwise the statusline lies about health exactly when the user is
    // verifying setup worked. Without `ts_start` we cannot age the enrolment, so
    // this stays neutral — which is also the back-compat path against a server
    // that predates the field.
    expect(classifyLanding(cache({ lastBearer: RECENT_BEARER, lastEmission: null }), INSTANCE, NOW)).toBe('unknown')
  })

  it('ACTIVE + NEVER landed but enrolment still INSIDE the grace → unknown (first record in flight)', () => {
    // A record takes ~5 min of Azure Monitor ingest plus up to one ~15-min reader
    // cadence, so a minutes-old enrolment reporting null is NORMAL. This is the
    // case the neutral fallback exists to protect and it must stay neutral.
    const c = cache({
      lastBearer: RECENT_BEARER,
      lastEmission: null,
      tsStart: iso(NEVER_LANDED_GRACE_MS - 10 * 60 * 1000),
    })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('unknown')
  })

  it('ACTIVE + NEVER landed and enrolment PAST the grace → dead — nothing has EVER been attributed', () => {
    // The 2026-09-01 incident: a superseded instance pin meant a whole session
    // emitted against an instance the device no longer claimed. Emit auth was
    // healthy, bearers minted on cadence, and this read benign cyan for 69 minutes
    // because "never landed" was treated as permanently unknowable. Past the grace
    // it is a fault, and the beacon must say so.
    const c = cache({
      lastBearer: RECENT_BEARER,
      lastEmission: null,
      tsStart: iso(NEVER_LANDED_GRACE_MS + 60 * 60 * 1000),
    })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('dead')
  })

  it('IDLE + NEVER landed stays unknown however OLD the enrolment — age alone never reddens an idle device', () => {
    // Age is only meaningful alongside emit ACTIVITY: with no recent bearer there
    // is nothing to land, so an ancient never-landed idle enrolment must NOT read
    // red. This is the guard that keeps the new rule from re-introducing the
    // false-alarm class DEAD_EXPORT_MS was added to kill.
    const c = cache({
      lastBearer: OLD_BEARER,
      lastEmission: null,
      tsStart: iso(30 * 24 * 60 * 60 * 1000),
    })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('unknown')
  })

  it('never-landed age is measured bearer−ts_start, so a client clock running AHEAD cannot false-red', () => {
    // Both stamps come from the server; only `now` is local. Passing a `now` far
    // in the future (a skewed client) must change nothing, because the verdict is
    // a server-stamp difference. The `now - enrolled` form this replaced would
    // have crossed the grace here and painted red — the exact outcome the skew
    // note on the active branch promises this function never produces.
    const c = cache({
      lastBearer: RECENT_BEARER,
      lastEmission: null,
      tsStart: iso(NEVER_LANDED_GRACE_MS - 30 * 60 * 1000), // in-grace by server time
    })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('unknown')
    // The skew must keep the client ACTIVE to discriminate: push `now` far enough
    // and it lands in the IDLE branch, which returns 'unknown' for its own reason
    // and would pass against the buggy form too. +60 min keeps now−bearer at
    // 70 min (inside DEAD_EXPORT_MS = 90 min) while now−ts_start reaches 150 min
    // (past the 120 min grace) — so the old form returns 'dead' here and the
    // server-stamp form returns 'unknown'.
    const skewed = NOW + 60 * 60 * 1000
    expect(skewed - Date.parse(RECENT_BEARER)).toBeLessThanOrEqual(DEAD_EXPORT_MS) // still active
    expect(classifyLanding(c, INSTANCE, skewed)).toBe('unknown')
  })

  it('ACTIVE + NEVER landed with an unparseable ts_start → unknown (never guesses, never false-reds)', () => {
    const c = cache({ lastBearer: RECENT_BEARER, lastEmission: null, tsStart: 'not-a-date' })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('unknown')
  })

  it('ACTIVE + PRIOR landing then frozen (gap > LANDED_LAG_MS) → dead — landing was working and STOPPED', () => {
    // 'dead' means "was landing, then stopped" — the real incident. Contrast with
    // the in-grace never-landed case above, which stays neutral.
    const c = cache({ lastBearer: RECENT_BEARER, lastEmission: iso(LANDED_LAG_MS + 2 * 60 * 60 * 1000) })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('dead')
  })

  it('ACTIVE + unparseable emission → unknown (treated as absent, never a false red)', () => {
    expect(classifyLanding(cache({ lastBearer: RECENT_BEARER, lastEmission: 'not-a-date' }), INSTANCE, NOW)).toBe(
      'unknown',
    )
  })

  it('parseTs REFUSES a naive (zoneless) timestamp — never guesses machine-local time', () => {
    // A last_emission with NO offset would else be parsed against the local zone →
    // a wrong epoch, silently skewing staleness. It must be treated as absent: an
    // active client with a naive emission → unknown (as if null), never dead/landed.
    const naive = '2026-06-30 21:38:58' // no Z, no ±HH:MM
    expect(classifyLanding(cache({ lastBearer: RECENT_BEARER, lastEmission: naive }), INSTANCE, NOW)).toBe('unknown')
    // And a naive BEARER (zoneless) is treated as absent → idle branch, not active.
    const c = cache({ lastBearer: naive, lastEmission: iso(3 * 60 * 60 * 1000) })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('landed') // idle + prior landing → landed, never red
  })

  // ── CLIENT IDLE (no recent bearer → a stale emission is EXPECTED, never red) ──
  it('IDLE (bearer 12h old) + last emission DID land → landed, NOT a false red (the live dev-instance case)', () => {
    // Real dev instance: last_bearer_at AND last_emission both ~12h old = idle,
    // read path healthy. Must NOT render dead.
    const c = cache({ lastBearer: OLD_BEARER, lastEmission: iso(12 * 60 * 60 * 1000) })
    expect(classifyLanding(c, INSTANCE, NOW)).toBe('landed')
  })

  it('IDLE + never landed anything (fresh enrolment) → unknown, never red', () => {
    expect(classifyLanding(cache({ lastBearer: OLD_BEARER, lastEmission: null }), INSTANCE, NOW)).toBe('unknown')
  })

  it('active-window boundary (now − bearer around DEAD_EXPORT_MS): frozen watermark → dead just inside, idle→landed just outside', () => {
    const frozen = iso(6 * 24 * 60 * 60 * 1000) // 6 days → dead if judged, expected if idle
    const justActive = cache({ lastBearer: iso(DEAD_EXPORT_MS - 60_000), lastEmission: frozen }) // inside window
    const justIdle = cache({ lastBearer: iso(DEAD_EXPORT_MS + 60_000), lastEmission: frozen }) // outside window
    expect(classifyLanding(justActive, INSTANCE, NOW)).toBe('dead') // still emitting, frozen watermark
    expect(classifyLanding(justIdle, INSTANCE, NOW)).toBe('landed') // idle: stale emission expected, it did land
  })

  it('lastBearer ABSENT (old-format cache) → treated as idle (safe: no false red)', () => {
    // A stale emission with no bearer field must not trip dead — a fresh
    // landed-check run repopulates lastBearer.
    expect(classifyLanding(cache({ lastEmission: iso(5 * 60 * 60 * 1000) }), INSTANCE, NOW)).toBe('landed')
    expect(classifyLanding(cache({ lastEmission: null }), INSTANCE, NOW)).toBe('unknown')
  })

  it('parses the Postgres text timestamp shape (space, no T, +00 offset) for BOTH fields', () => {
    // The real dev values: `2026-06-30 21:38:58.933+00`. Active client, watermark
    // keeping up → landed; frozen watermark under an active bearer → dead.
    const activeKeepingUp = cache({
      lastBearer: '2026-06-30 23:55:00.000+00', // 5 min before NOW
      lastEmission: '2026-06-30 23:30:00.000+00', // 30 min before NOW → gap 25 min
    })
    const activeFrozen = cache({
      lastBearer: '2026-06-30 23:55:00.000+00', // active
      lastEmission: '2026-06-25 08:00:00.000+00', // days back → gap ≫ 90 min → dead
    })
    expect(classifyLanding(activeKeepingUp, INSTANCE, NOW)).toBe('landed')
    expect(classifyLanding(activeFrozen, INSTANCE, NOW)).toBe('dead')
  })
})

describe('landedRefreshDue — throttled poll gate (pure given the stamp)', () => {
  const NOW = Date.parse('2026-07-01T00:00:00Z')
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

  it('no cache and no recent attempt → due', () => {
    expect(landedRefreshDue(null, NOW, null)).toBe(true)
  })

  it('cache checked within the interval → NOT due (render from cache)', () => {
    expect(landedRefreshDue({ checkedAt: iso(60 * 1000) }, NOW, null)).toBe(false) // 1 min ago
  })

  it('cache older than the interval → due', () => {
    expect(landedRefreshDue({ checkedAt: iso(POLL_INTERVAL_MS + 1000) }, NOW, null)).toBe(true)
  })

  it('cache stale BUT a recent spawn attempt is in flight → NOT due (no duplicate spawn)', () => {
    expect(landedRefreshDue({ checkedAt: iso(POLL_INTERVAL_MS + 1000) }, NOW, iso(30 * 1000))).toBe(false)
  })

  it('cache stale and the last attempt is also old → due again', () => {
    expect(
      landedRefreshDue({ checkedAt: iso(POLL_INTERVAL_MS + 1000) }, NOW, iso(POLL_INTERVAL_MS + 1000)),
    ).toBe(true)
  })
})

describe('emitEnvLabel (derived from the live emit endpoint, not hardcoded)', () => {
  it('labels the dev OTLP ingestion (DCE) endpoint as Dev', () => {
    expect(
      emitEnvLabel({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
          'https://dce-tokenscope-dev-wus3-hw1s.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-x/streams/Microsoft-OTLP-Logs/otlp/v1/logs',
      }),
    ).toBe('Dev')
  })

  it('labels the REAL sandbox pair as Sandbox via the bearer host (its DCE carries no env name)', () => {
    // Real provisioned sandbox config: the DCE host is dce-tokenscope-OTLP-… (no
    // env token), so classification must come from the bearer/app host.
    expect(
      emitEnvLabel({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
          'https://dce-tokenscope-otlp-h23d.australiaeast-1.ingest.monitor.azure.com/x/otlp/v1/logs',
        TOKENSCOPE_BEARER_ENDPOINT: 'https://ep-tokenscope-sandbox-aue-ctabchgvdsarb3g8.z03.azurefd.net/api/v1/instances/x/bearer',
      }),
    ).toBe('Sandbox')
  })

  it('labels the REAL dev pair as Dev', () => {
    expect(
      emitEnvLabel({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
          'https://dce-tokenscope-dev-wus3-hw1s.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-x/streams/Microsoft-OTLP-Logs/otlp/v1/logs',
        TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope.example.com/api/v1/instances/x/bearer',
      }),
    ).toBe('Dev')
  })

  it('classifies a same-region (aue) Staging env as Staging, NOT Sandbox', () => {
    // Regression for the old `-aue` substring heuristic, which forced every
    // Australia-East host to Sandbox and shadowed Staging/Prod.
    expect(
      emitEnvLabel({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
          'https://dce-tokenscope-staging-aue-cd34.australiaeast-1.ingest.monitor.azure.com/x/otlp/v1/logs',
      }),
    ).toBe('Staging')
  })

  it('does NOT mislabel a self-hosted host that merely contains "dev"', () => {
    // `TOKENSCOPE_API_BASE` override to a corp host with "dev" in it must show the
    // real host, not a false "Dev" (only `tokenscope-<env>` classifies).
    expect(emitEnvLabel({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://otel.dev-cluster.acme.example/v1/logs' })).toBe(
      'otel.dev-cluster.acme.example',
    )
  })

  it('does not match the env token mid-word (left boundary)', () => {
    // `mytokenscope-dev…` must NOT classify as Dev — only a bounded tokenscope-<env>.
    expect(emitEnvLabel({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://mytokenscope-dev.acme.example/v1/logs' })).toBe(
      'mytokenscope-dev.acme.example',
    )
  })

  it('maps a production host to Prod', () => {
    expect(emitEnvLabel({ TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope-production.example.com/api/v1/instances/x/bearer' })).toBe(
      'Prod',
    )
  })

  it('falls back to the bearer endpoint origin when no OTLP endpoint is set', () => {
    // `.example.com` on purpose — see the twin in copilot-redeem.test.ts: the
    // public-mirror substitution rewrites the real internal host to
    // `tokenscope.example.com`, dropping the `-dev` token this classifies on,
    // while the expected `'Dev'` stays put. Any host works here; the env token is
    // the only part under test.
    expect(
      emitEnvLabel({
        TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope-dev.example.com/api/v1/instances/x/bearer',
      }),
    ).toBe('Dev')
  })

  it('labels a localhost stub endpoint as Local', () => {
    expect(emitEnvLabel({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:3450/azmon-stub/v1/logs' })).toBe('Local')
  })

  it('shows the bare host for an unrecognised deployment (never a wrong guess)', () => {
    expect(emitEnvLabel({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://otel.example.com/v1/logs' })).toBe('otel.example.com')
  })

  it('returns null when nothing is configured / endpoint is unparseable', () => {
    expect(emitEnvLabel({})).toBeNull()
    expect(emitEnvLabel(undefined)).toBeNull()
    expect(emitEnvLabel({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'not a url' })).toBeNull()
  })
})

describe('tokenscopeStatusLine — the persisted command is a spawn site', () => {
  it('names the interpreter by absolute, quoted path, never a bare node', () => {
    const cmd = tokenscopeStatusLine('/p/scripts/statusline.mjs', { node: '/opt/node 22/bin/node', platform: 'linux' }).command
    expect(cmd).toBe('"/opt/node 22/bin/node" "/p/scripts/statusline.mjs"')
    expect(cmd).not.toMatch(/^node /)
  })

  it('defaults to the node running this script', () => {
    expect(tokenscopeStatusLine('/p/scripts/statusline.mjs').command.startsWith(`"${process.execPath}" `)).toBe(true)
  })

  it('quotes for cmd.exe on Windows', () => {
    const cmd = tokenscopeStatusLine('C:\\p\\statusline.mjs', { node: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' }).command
    expect(cmd).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\p\\statusline.mjs"')
  })
})

describe('installStatusLine (non-clobber)', () => {
  const PATH = '/p/scripts/statusline.mjs'

  it('installs when there is no status line', () => {
    const { settings, installed } = installStatusLine({}, PATH)
    expect(installed).toBe(true)
    expect(settings.statusLine).toEqual(tokenscopeStatusLine(PATH))
  })

  it('refreshes our OWN status line (e.g. plugin path changed)', () => {
    const existing = { statusLine: { type: 'command', command: 'node /old/scripts/statusline.mjs' } }
    const { settings, installed } = installStatusLine(existing, PATH)
    expect(installed).toBe(true)
    expect(settings.statusLine.command).toContain('/p/scripts/statusline.mjs')
  })

  it('does NOT clobber a custom (non-TokenScope) status line by default', () => {
    const custom = { statusLine: { type: 'command', command: 'my-prompt.sh' } }
    const { settings, installed } = installStatusLine(custom, PATH)
    expect(installed).toBe(false)
    expect(settings.statusLine.command).toBe('my-prompt.sh')
  })

  it('force replaces a custom status line on explicit opt-in', () => {
    const custom = { statusLine: { type: 'command', command: 'my-prompt.sh' }, permissions: { a: 1 } }
    const { settings, installed } = installStatusLine(custom, PATH, { force: true })
    expect(installed).toBe(true)
    expect(settings.statusLine).toEqual(tokenscopeStatusLine(PATH))
    expect(settings.permissions).toEqual({ a: 1 }) // other keys preserved
  })
})

describe('reconcilePluginPaths (self-heal version-pinned settings on update)', () => {
  // `exists` injected: these cases are about the move rules, not the disk. The
  // helper is REBUILT (buildHelperCommand), so the healed value is a command.
  const A = {
    statuslinePath: '/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.19/scripts/statusline.mjs',
    scriptsDir: '/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.19/scripts',
    platform: 'linux',
    exists: () => true,
  }
  const A_HELPER = '"/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.19/scripts/otel-headers-helper.sh" --tool claude-code'
  const staleStatusCmd = 'node "/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.14/scripts/statusline.mjs"'
  const staleHelper = '/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.13/scripts/otel-headers-helper.sh'

  it('repoints BOTH stale paths to the active version', () => {
    const { settings, changed } = reconcilePluginPaths(
      { statusLine: { type: 'command', command: staleStatusCmd, padding: 0 }, otelHeadersHelper: staleHelper, env: { X: '1' } },
      A,
    )
    expect(changed).toBe(true)
    expect(settings.statusLine.command).toBe(tokenscopeStatusLine(A.statuslinePath, { platform: 'linux' }).command)
    expect(settings.statusLine.padding).toBe(0) // preserves other statusLine fields
    expect(settings.otelHeadersHelper).toBe(A_HELPER)
    expect(settings.env).toEqual({ X: '1' }) // untouched
  })

  it('is a no-op once both already point at the active version', () => {
    const { changed } = reconcilePluginPaths(
      { statusLine: tokenscopeStatusLine(A.statuslinePath, { node: '/usr/bin/node', platform: A.platform }), otelHeadersHelper: A_HELPER },
      A,
    )
    expect(changed).toBe(false)
  })

  it('never touches a user’s custom (non-TokenScope) status line', () => {
    const { settings, changed } = reconcilePluginPaths(
      { statusLine: { type: 'command', command: 'my-prompt.sh' }, otelHeadersHelper: staleHelper },
      A,
    )
    // statusLine left alone; only the (ours) otelHeadersHelper repointed
    expect(settings.statusLine.command).toBe('my-prompt.sh')
    expect(settings.otelHeadersHelper).toBe(A_HELPER)
    expect(changed).toBe(true)
  })

  it('does not touch an otelHeadersHelper that isn’t ours', () => {
    const { settings, changed } = reconcilePluginPaths({ otelHeadersHelper: '/usr/local/bin/my-helper.sh' }, A)
    expect(settings.otelHeadersHelper).toBe('/usr/local/bin/my-helper.sh')
    expect(changed).toBe(false)
  })

  it('also reconciles a marketplace-clone path (not just cache)', () => {
    const { changed } = reconcilePluginPaths(
      { otelHeadersHelper: '/h/.claude/plugins/marketplaces/tokenscope/plugin/scripts/otel-headers-helper.sh' },
      A,
    )
    expect(changed).toBe(true)
  })

  // #455: a directory-marketplace setup wrote the checkout's paths.
  it('moves a checkout status line and helper to the versioned active install', () => {
    const { settings, changed } = reconcilePluginPaths(
      {
        statusLine: { type: 'command', command: '"/usr/bin/node" "/home/u/src/TokenScope/plugin/scripts/statusline.mjs"' },
        otelHeadersHelper: '"/home/u/src/TokenScope/plugin/scripts/otel-headers-helper.sh" --tool claude-code',
      },
      A,
    )
    expect(changed).toBe(true)
    expect(settings.statusLine.command).toBe(tokenscopeStatusLine(A.statuslinePath, { platform: 'linux' }).command)
    expect(settings.otelHeadersHelper).toBe(A_HELPER)
  })

  it('no-ops when neither path is present', () => {
    expect(reconcilePluginPaths({ env: {} }, A).changed).toBe(false)
    expect(reconcilePluginPaths({}, A).changed).toBe(false)
  })

  it('forward-only: never DOWNGRADES to an older active version', () => {
    // A peer instance already pinned 0.1.20; this (older) instance must not clobber it.
    const newerCmd = 'node "/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.20/scripts/statusline.mjs"'
    const newerHelper = '/h/.claude/plugins/cache/tokenscope/tokenscope/0.1.20/scripts/otel-headers-helper.sh'
    const { settings, changed } = reconcilePluginPaths(
      { statusLine: { type: 'command', command: newerCmd }, otelHeadersHelper: newerHelper },
      A, // active = 0.1.19 (older)
    )
    expect(changed).toBe(false)
    expect(settings.statusLine.command).toBe(newerCmd)
    expect(settings.otelHeadersHelper).toBe(newerHelper)
  })

  it('does NOT heal when the ACTIVE path is unversioned (e.g. a marketplace-clone run)', () => {
    // An unversioned active must never overwrite a versioned pin (else it would
    // ping-pong with a cache-run peer sharing the same home).
    const cloneActive = {
      statuslinePath: '/h/.claude/plugins/marketplaces/tokenscope/plugin/scripts/statusline.mjs',
      scriptsDir: '/h/.claude/plugins/marketplaces/tokenscope/plugin/scripts',
      platform: 'linux',
      exists: () => true,
    }
    const { changed } = reconcilePluginPaths(
      { statusLine: { type: 'command', command: staleStatusCmd }, otelHeadersHelper: staleHelper },
      cloneActive,
    )
    expect(changed).toBe(false)
  })

  it('does NOT mutate the input settings object', () => {
    const input = Object.freeze({
      statusLine: Object.freeze({ type: 'command', command: staleStatusCmd, padding: 0 }),
      otelHeadersHelper: staleHelper,
      env: Object.freeze({ TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'secret' }),
    })
    // Would throw if reconcile mutated any frozen nested object.
    const { changed } = reconcilePluginPaths(input, A)
    expect(changed).toBe(true)
    expect(input.statusLine.command).toBe(staleStatusCmd) // original untouched
  })

  it('rewrites a bare-node status line at the SAME version to the absolute interpreter', () => {
    const { settings, changed } = reconcilePluginPaths(
      { statusLine: { type: 'command', command: `node ${JSON.stringify(A.statuslinePath)}`, padding: 0 } },
      A,
    )
    expect(changed).toBe(true)
    expect(settings.statusLine.command).toBe(tokenscopeStatusLine(A.statuslinePath, { platform: 'linux' }).command)
  })

  it('re-heals a status line whose recorded node no longer exists, and leaves a working one alone', () => {
    const gone = { statusLine: { type: 'command', command: `"/old/node" "${A.statuslinePath}"` } }
    const missing = reconcilePluginPaths(gone, { ...A, exists: (p: string) => p !== '/old/node' })
    expect(missing.changed).toBe(true)
    // Another host's working node at the same version is not rewritten back and forth.
    expect(reconcilePluginPaths(gone, A).changed).toBe(false)
  })

  it('skips a path target that is null (does not exist on disk)', () => {
    const { changed } = reconcilePluginPaths(
      { otelHeadersHelper: staleHelper },
      { statuslinePath: null, scriptsDir: null, platform: 'linux', exists: () => true },
    )
    expect(changed).toBe(false)
  })
})

describe('removeStatusLine', () => {
  it('removes our status line', () => {
    const s = { statusLine: tokenscopeStatusLine('/p/scripts/statusline.mjs'), env: { X: '1' } }
    const { settings, removed } = removeStatusLine(s)
    expect(removed).toBe(true)
    expect(settings.statusLine).toBeUndefined()
    expect(settings.env).toEqual({ X: '1' })
  })

  it('leaves a custom (non-TokenScope) status line untouched', () => {
    const s = { statusLine: { type: 'command', command: 'my-prompt.sh' } }
    const { settings, removed } = removeStatusLine(s)
    expect(removed).toBe(false)
    expect(settings.statusLine.command).toBe('my-prompt.sh')
  })
})

// #453: the Claude and Copilot plugins wrote one shared last-landed.json, so each
// overwrote the other's landing record. Each now has its own name.
describe('readLandedCache — per-tool landing record', () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-landed-'))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reads the Claude record, not the Copilot one beside it', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'last-landed.claude-code.json'), JSON.stringify({ instanceId: 'claude-inst' }))
      writeFileSync(join(dir, 'last-landed.copilot-cli.json'), JSON.stringify({ instanceId: 'copilot-inst' }))
      expect(readLandedCache(dir)?.instanceId).toBe('claude-inst')
    })
  })

  it('falls back to the old shared name until the first refresh after an upgrade', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'last-landed.json'), JSON.stringify({ instanceId: 'old' }))
      expect(readLandedCache(dir)?.instanceId).toBe('old')
    })
  })

  it('prefers the new name over the old one', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'last-landed.json'), JSON.stringify({ instanceId: 'old' }))
      writeFileSync(join(dir, 'last-landed.claude-code.json'), JSON.stringify({ instanceId: 'new' }))
      expect(readLandedCache(dir)?.instanceId).toBe('new')
    })
  })

  it('is null when there is no record', () => {
    withDir((dir) => expect(readLandedCache(dir)).toBeNull())
  })
})
