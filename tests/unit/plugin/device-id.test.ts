// @vitest-environment node
/*
 * device-id — the credential-free device-identity accessor (S16b).
 *
 * Its ONE security guarantee: given a device store that holds the durable emit
 * credential next to the instance id, the output carries the id and NEVER the
 * credential. Everything else it does exists to keep the setup flow correct once
 * the prompts stopped reading those files directly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { realHome } from '../../../plugin/scripts/real-home.mjs'
import { join } from 'node:path'
import {
  attrValue,
  hostOf,
  readClaudeDevice,
  readCopilotDevice,
  deviceIdentity,
  parseArgs,
} from '../../../plugin/scripts/device-id.mjs'

const INSTANCE = '9a1e0000-0000-4000-8000-000000000001'
const SECRET = 'rt_durable_refresh_token_do_not_leak'

/** A realistic ~/.claude/settings.json as claude-redeem.mjs writes it (both keys, one `env`). */
function claudeSettings(overrides: Record<string, unknown> = {}) {
  return {
    otelHeadersHelper: '/plugins/tokenscope/scripts/otel-headers-helper.sh',
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`,
      TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope-dev.example.net/api/v1/emit/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: SECRET,
      TOKENSCOPE_OAUTH_CLIENT_ID: 'client-abc',
      ...overrides,
    },
  }
}

/** A realistic ~/.tokenscope/config.json as copilot-redeem.mjs writes it (flat siblings). */
function copilotConfig(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: INSTANCE,
    bearer_endpoint: 'https://tokenscope-dev.example.net/api/v1/emit/bearer',
    oauth_refresh_token: SECRET,
    oauth_client_id: 'client-abc',
    otel_resource_attributes: `tokenscope.instance_id=${INSTANCE},tool=copilot-cli`,
    ...overrides,
  }
}

describe('device-id NEVER emits a credential', () => {
  it('the Claude reading carries the instance id but no secret from the same env block', () => {
    const out = readClaudeDevice(claudeSettings())
    expect(out.instance_id).toBe(INSTANCE)
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('the Copilot reading carries the instance id but no secret from the same object', () => {
    const out = readCopilotDevice(copilotConfig())
    expect(out.instance_id).toBe(INSTANCE)
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('the output shape is a FIXED key set, so a new store key cannot leak through', () => {
    // A future credential key added to either store must not appear in the output
    // just because it was added — the result object is built from known keys only.
    const claude = readClaudeDevice(claudeSettings({ TOKENSCOPE_FUTURE_SECRET: 'nope' }))
    const copilot = readCopilotDevice(copilotConfig({ future_secret: 'nope' }))
    const expected = ['enrolled', 'tool', 'instance_id', 'bearer_host', 'reason', 'platform', 'node']
    expect(Object.keys(claude).sort()).toEqual([...expected].sort())
    expect(Object.keys(copilot).sort()).toEqual([...expected].sort())
    expect(JSON.stringify(claude)).not.toContain('nope')
    expect(JSON.stringify(copilot)).not.toContain('nope')
  })
})

describe('device-id reports the runtime setup step 0 branches on (#408 S6)', () => {
  it('platform and node are this process’s, on every branch', () => {
    for (const out of [readClaudeDevice(claudeSettings()), readClaudeDevice(null), readCopilotDevice(null)]) {
      expect(out.platform).toBe(process.platform)
      expect(out.node).toBe(process.version)
    }
  })
})

describe('device-id reports the identity setup actually needs', () => {
  it('reports enrolled + tool + bearer host for a provisioned Claude device', () => {
    expect(readClaudeDevice(claudeSettings())).toMatchObject({
      enrolled: true,
      tool: 'claude-code',
      instance_id: INSTANCE,
      bearer_host: 'tokenscope-dev.example.net',
      reason: null,
    })
  })

  it('reports enrolled for a provisioned Copilot device', () => {
    expect(readCopilotDevice(copilotConfig())).toMatchObject({
      enrolled: true,
      tool: 'copilot-cli',
      instance_id: INSTANCE,
      bearer_host: 'tokenscope-dev.example.net',
    })
  })

  it('an enrolment with no tool attr defaults to its own store\'s tool', () => {
    // Every writer that AUTHORS the attrs in ~/.claude/settings.json
    // (claude-redeem.mjs, enroll.mjs) goes through assertClaudeRedeemResponse,
    // which refuses a copilot bundle — so claude-code is the sound default there.
    const settings = claudeSettings({ OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE}` })
    expect(readClaudeDevice(settings)).toMatchObject({ enrolled: true, tool: 'claude-code' })
    const cfg = copilotConfig({ otel_resource_attributes: undefined })
    expect(readCopilotDevice(cfg)).toMatchObject({ enrolled: true, tool: 'copilot-cli' })
  })
})

describe('device-id refuses to hand over the WRONG tool\'s id', () => {
  /*
   * Instances are per-HOST but bound to ONE emit tool, so one tool's id is not a
   * valid thing to provision the other with. The server refuses it — 409, BEFORE
   * any rotation (locateOrCreateInstance's cross-TOOL guard) — but only AFTER the
   * client has already asked, so handing over the wrong id turns a working setup
   * into a hard error. Before that guard existed the rotation committed first and
   * silently killed the other CLI's emitting on the same host.
   */
  it('a claude-code store queried for copilot-cli returns enrolled:false, no id', () => {
    const out = readClaudeDevice(claudeSettings(), 'copilot-cli')
    expect(out.enrolled).toBe(false)
    expect(out.instance_id).toBeNull()
    expect(out.reason).toBe('tool-mismatch')
  })

  it('a copilot-cli store queried for claude-code returns enrolled:false, no id', () => {
    const out = readCopilotDevice(copilotConfig(), 'claude-code')
    expect(out.enrolled).toBe(false)
    expect(out.instance_id).toBeNull()
    expect(out.reason).toBe('tool-mismatch')
  })
})

describe('device-id degrades to "fresh device" rather than a partial answer', () => {
  it('no env block / no instance id → enrolled:false', () => {
    expect(readClaudeDevice({}).enrolled).toBe(false)
    expect(readClaudeDevice({ env: {} }).enrolled).toBe(false)
    expect(readClaudeDevice(claudeSettings({ OTEL_RESOURCE_ATTRIBUTES: 'tool=claude-code' })).enrolled).toBe(false)
    expect(readCopilotDevice({}).enrolled).toBe(false)
    expect(readCopilotDevice(copilotConfig({ instance_id: '  ' })).enrolled).toBe(false)
  })

  it('an unknown tool is refused rather than guessed', () => {
    expect(deviceIdentity('gemini-cli', '/nonexistent')).toMatchObject({
      enrolled: false,
      reason: 'unknown-tool',
    })
  })
})

describe('device-id end-to-end against real files', () => {
  it('reads each tool from its OWN store, and reports a missing store as not enrolled', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-device-id-'))
    try {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(claudeSettings()))

      const claude = deviceIdentity('claude-code', home)
      expect(claude).toMatchObject({ enrolled: true, instance_id: INSTANCE })
      expect(JSON.stringify(claude)).not.toContain(SECRET)

      // No ~/.tokenscope yet — Copilot is simply not set up on this host.
      expect(deviceIdentity('copilot-cli', home)).toMatchObject({
        enrolled: false,
        instance_id: null,
        reason: 'no-enrolment',
      })

      mkdirSync(join(home, '.tokenscope'), { recursive: true })
      writeFileSync(join(home, '.tokenscope', 'config.copilot-cli.json'), JSON.stringify(copilotConfig()))
      const copilot = deviceIdentity('copilot-cli', home)
      expect(copilot).toMatchObject({ enrolled: true, instance_id: INSTANCE })
      expect(JSON.stringify(copilot)).not.toContain(SECRET)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Two installs on one host (Claude Desktop with its own config folder, the CLI
  // in ~/.claude) share ONE claude-code enrolment in ~/.tokenscope. A desktop
  // folder that was never set up must report that instance, or setup mints a
  // second one and strands the CLI's labels on a superseded id.
  describe('a custom config folder that is not set up yet', () => {
    afterEach(() => vi.unstubAllEnvs())
    const store = (instance = INSTANCE) => ({
      version: 2,
      tool: 'claude-code',
      instance_id: instance,
      oauth_refresh_token: SECRET,
      bearer_endpoint: `https://ts.example.com/api/v1/instances/${instance}/bearer`,
    })

    it('reports the host’s shared claude-code enrolment', () => {
      const home = mkdtempSync(join(realHome(), '.ts-device-id-cfg-'))
      try {
        vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude-desktop'))
        mkdirSync(join(home, '.tokenscope'), { recursive: true })
        writeFileSync(join(home, '.tokenscope', 'config.claude-code.json'), JSON.stringify(store()))
        const out = deviceIdentity('claude-code', home)
        expect(out).toMatchObject({ enrolled: true, tool: 'claude-code', instance_id: INSTANCE, bearer_host: 'ts.example.com' })
        expect(JSON.stringify(out)).not.toContain(SECRET)
        // A damaged settings file in that folder is NOT "not set up": setup will
        // refuse to write it, so the shared instance must not be offered for rotation.
        mkdirSync(join(home, '.claude-desktop'), { recursive: true })
        writeFileSync(join(home, '.claude-desktop', 'settings.json'), '{ not json')
        expect(deviceIdentity('claude-code', home)).toMatchObject({ enrolled: false, reason: 'no-enrolment' })
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('its own enrolment wins once it has one; the default folder never falls back', () => {
      const home = mkdtempSync(join(realHome(), '.ts-device-id-cfg-'))
      try {
        mkdirSync(join(home, '.tokenscope'), { recursive: true })
        writeFileSync(
          join(home, '.tokenscope', 'config.claude-code.json'),
          JSON.stringify(store('9a1e0000-0000-4000-8000-0000000000ff')),
        )
        // Default folder (~/.claude) with no settings: not enrolled, as before.
        expect(deviceIdentity('claude-code', home)).toMatchObject({ enrolled: false, reason: 'no-enrolment' })
        vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude-desktop'))
        mkdirSync(join(home, '.claude-desktop'), { recursive: true })
        writeFileSync(join(home, '.claude-desktop', 'settings.json'), JSON.stringify(claudeSettings()))
        expect(deviceIdentity('claude-code', home)).toMatchObject({ enrolled: true, instance_id: INSTANCE })
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  })

  it('a malformed store is "not enrolled", never a throw', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-device-id-bad-'))
    try {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), '{ not json')
      expect(deviceIdentity('claude-code', home)).toMatchObject({ enrolled: false, reason: 'no-enrolment' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ── each store is read where its WRITER writes it (audit round 2, finding 2) ──
//
// copilot-redeem.mjs anchors ~/.tokenscope on the PASSWD home so a moved $HOME
// cannot choose where a durable refresh token lands. A reader that still
// followed $HOME would (a) miss the store the writer wrote and (b) happily read
// one a moved $HOME planted — handing setup an attacker-chosen instance_id to
// rotate. ~/.claude is the opposite case: Claude Code resolves its own settings
// through $HOME, and this module reads that file only to learn what Claude will.
describe('device-id resolves each store on the right home', () => {
  const PLANTED = '9a1e0000-0000-4000-8000-0000000000ff'
  const HOME_KEYS = ['HOME', 'USERPROFILE'] as const

  /** Run `fn` with $HOME moved to a sandbox holding a planted store. */
  function withMovedHome(plant: (home: string) => void, fn: () => void) {
    const saved = Object.fromEntries(HOME_KEYS.map((k) => [k, process.env[k]]))
    const moved = mkdtempSync(join(tmpdir(), 'ts-device-id-moved-'))
    try {
      plant(moved)
      for (const k of HOME_KEYS) process.env[k] = moved
      fn()
    } finally {
      for (const k of HOME_KEYS) {
        // Reflect.deleteProperty, not `delete` (lint: no-dynamic-delete); and never
        // assign undefined — process.env stringifies it to the literal "undefined".
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = saved[k] as string
      }
      rmSync(moved, { recursive: true, force: true })
    }
  }

  it('a moved $HOME cannot supply the Copilot store', () => {
    withMovedHome(
      (moved) => {
        mkdirSync(join(moved, '.tokenscope'), { recursive: true })
        writeFileSync(
          join(moved, '.tokenscope', 'config.copilot-cli.json'),
          JSON.stringify(copilotConfig({ instance_id: PLANTED })),
        )
      },
      () => {
        // Asserted as a NEGATIVE: the passwd home may or may not hold a real
        // Copilot enrolment on the machine running this, and either way the
        // planted id must never be the answer.
        expect(deviceIdentity('copilot-cli').instance_id).not.toBe(PLANTED)
      },
    )
  })

  it('the Claude store DOES follow $HOME — it is Claude Code\'s own resolution', () => {
    withMovedHome(
      (moved) => {
        mkdirSync(join(moved, '.claude'), { recursive: true })
        writeFileSync(
          join(moved, '.claude', 'settings.json'),
          JSON.stringify(
            claudeSettings({
              OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${PLANTED},tool=claude-code`,
            }),
          ),
        )
      },
      () => {
        expect(deviceIdentity('claude-code')).toMatchObject({
          enrolled: true,
          instance_id: PLANTED,
        })
      },
    )
  })

  it('an explicit `home` still overrides BOTH stores (the test seam)', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-device-id-seam-'))
    try {
      mkdirSync(join(home, '.tokenscope'), { recursive: true })
      writeFileSync(
        join(home, '.tokenscope', 'config.copilot-cli.json'),
        JSON.stringify(copilotConfig({ instance_id: PLANTED })),
      )
      expect(deviceIdentity('copilot-cli', home).instance_id).toBe(PLANTED)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('device-id helpers', () => {
  it('attrValue reads one attribute and ignores prefix collisions', () => {
    const attrs = `tokenscope.instance_id=${INSTANCE},project.code_hash=abc,tool=claude-code`
    expect(attrValue(attrs, 'tokenscope.instance_id')).toBe(INSTANCE)
    expect(attrValue(attrs, 'tool')).toBe('claude-code')
    expect(attrValue(attrs, 'instance_id')).toBeNull()
    expect(attrValue(attrs, 'missing')).toBeNull()
    expect(attrValue(undefined, 'tool')).toBeNull()
  })

  /*
   * attrValue used to build a RegExp out of `key` and escape only `.`
   * (CodeQL js/incomplete-sanitization, alerts 15 + 16). Every other
   * metacharacter reached the pattern intact. `key` is an internal constant
   * today — so this was never exploitable — but "not currently reachable" is
   * not a control, and these pin that the key is now compared LITERALLY.
   */
  it('a key containing regex metacharacters cannot change the match semantics', () => {
    const attrs = `tokenscope.instance_id=${INSTANCE},tool=claude-code`
    // Character class: `to[o]l` matched `tool=` while the RegExp was dynamic.
    expect(attrValue(attrs, 'to[o]l')).toBeNull()
    // Wildcards: `.*` matched the FIRST field and handed back its value.
    expect(attrValue(attrs, '.*')).toBeNull()
    expect(attrValue(attrs, 'too.')).toBeNull()
    // Anchors/alternation must not be honoured either.
    expect(attrValue(attrs, 'tool|tokenscope.instance_id')).toBeNull()
    // An UNBALANCED group threw SyntaxError out of a helper contracted never to.
    expect(() => attrValue(attrs, 'to(ol')).not.toThrow()
    expect(attrValue(attrs, 'to(ol')).toBeNull()
    // …and a literal `.` in a real key still resolves (the case the old escape
    // existed for), so the replacement is not merely stricter.
    expect(attrValue(attrs, 'tokenscope.instance_id')).toBe(INSTANCE)
  })

  it('attrValue keeps the field semantics the old pattern had', () => {
    // `(?:^|,)` — a key is recognised only at the start of a field.
    expect(attrValue('xtool=y,tool=z', 'tool')).toBe('z')
    // `\s*` skips whitespace BEFORE the key, but `key=` allowed none after it.
    expect(attrValue('a=1,  tool=z', 'tool')).toBe('z')
    expect(attrValue('tool =z', 'tool')).toBeNull()
    // `([^,]*)` — the value runs to the next comma, `=` included.
    expect(attrValue('tool=a=b,next=1', 'tool')).toBe('a=b')
    // First match wins; a present-but-empty value reads as absent.
    expect(attrValue('tool=first,tool=second', 'tool')).toBe('first')
    expect(attrValue('tool=,next=1', 'tool')).toBeNull()
    expect(attrValue('novalue,tool=z', 'tool')).toBe('z')
  })

  it('hostOf lowercases the host and tolerates junk', () => {
    expect(hostOf('https://TokenScope-Dev.Example.NET/api')).toBe('tokenscope-dev.example.net')
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf(undefined)).toBeNull()
  })

  it('parseArgs defaults to claude-code and accepts both --tool forms', () => {
    expect(parseArgs([])).toBe('claude-code')
    expect(parseArgs(['--tool', 'copilot-cli'])).toBe('copilot-cli')
    expect(parseArgs(['--tool=copilot-cli'])).toBe('copilot-cli')
  })
})
