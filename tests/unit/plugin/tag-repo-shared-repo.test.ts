/*
 * One repo opened by two Claude installs on one machine (Claude Desktop and the
 * CLI, each with its own config folder and device store since #449).
 *
 * The repo tag carries only the project attrs, so each install keeps its own
 * helper, store and credential. An instance another local store holds is kept
 * when that store targets the same deployment, so the installs do not rewrite the
 * tag in turn; any other instance is replaced and reported as drift. Backfill
 * stamps the instance the tag keeps. The status line judges the repo tag's
 * current instance, and reads unknown where it cannot confirm it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeRepoTag, computeCodeHash } from '../../../plugin/scripts/tag-repo.mjs'
import { buildHelperCommand } from '../../../plugin/scripts/env-builder.mjs'
import { launchResourceAttrs, localClaudeEnrolments } from '../../../plugin/scripts/plugin-runtime.mjs'
import { NEVER_LANDED_GRACE_MS, sessionLanding } from '../../../plugin/scripts/statusline.mjs'

const CODE_HASH = computeCodeHash('TokenScope-MVP')
const CLI = '3f6c2a1e-8b4d-4c7a-9e21-5d8f0b6a4c13'
const DESKTOP = 'b7e41d92-0c35-4f8a-a6d1-2e9c7f3b5a08'
const GONE = '5a9d3e70-61f2-4b8c-8d47-c0e2a1f96b35'
const HERE = 'https://ts.example'
const ELSEWHERE = 'https://ts-other.example'
const bearer = (origin: string, instance: string) => `${origin}/api/v1/instances/${instance}/bearer`
// A helper command whose script exists: the plugin's own, for this platform.
const HELPER = buildHelperCommand(
  { tool: 'claude-code', platform: process.platform },
  { scriptsDir: resolve(__dirname, '../../../plugin/scripts') },
)

let base: string
let repo: string
let stores: string

/** A complete Claude-lane store for `instance` in `dir`, enrolled with `origin`. */
function writeStore(dir: string, instance: string, origin = HERE) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.claude-code.json'),
    JSON.stringify({
      version: 2,
      tool: 'claude-code',
      instance_id: instance,
      oauth_refresh_token: 'rt',
      oauth_token_endpoint: `${origin}/oauth/token`,
      oauth_client_id: 'cid',
      bearer_endpoint: bearer(origin, instance),
      otel_resource_attributes: `tokenscope.instance_id=${instance},tool=claude-code`,
    }),
  )
}

const attrs = (instance: string) =>
  `tokenscope.instance_id=${instance},project.code_hash=${CODE_HASH},tool=claude-code`

function writeRepoFile(body: unknown) {
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify(body, null, 2) + '\n')
}

const readRepoFile = () => JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'))

/** The global enrolment of an install on `instance`, as readGlobalEnrolment returns it. */
const enrolment = (instance: string, helperCommand: string | null = HELPER) => ({
  sessionId: instance,
  helperCommand,
  env: {
    OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${instance},tool=claude-code`,
    TOKENSCOPE_BEARER_ENDPOINT: bearer(HERE, instance),
  },
})

const tag = (instance: string, helperCommand: string | null = HELPER) =>
  writeRepoTag({ cwd: repo, enrolment: enrolment(instance, helperCommand), codeHash: CODE_HASH, storeDir: stores })

const desktopDir = () => join(stores, 'claude-config', '0123456789ab')

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ts-shared-repo-'))
  repo = join(base, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  stores = join(base, 'tokenscope')
  // The CLI on the default store, Desktop on its own config-folder store.
  writeStore(stores, CLI)
  writeStore(desktopDir(), DESKTOP)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('writeRepoTag — narrow tag', () => {
  const copied = {
    permissions: { allow: ['Bash(ls:*)'] },
    otelHeadersHelper: 'copied helper command',
    env: {
      MY_OWN_FLAG: 'kept',
      OTEL_RESOURCE_ATTRIBUTES: attrs(CLI),
      TOKENSCOPE_BEARER_ENDPOINT: bearer(HERE, CLI),
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://dce.example/logs',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
    },
  }

  it("keeps the user's own keys and drops the ones an earlier tag copied in", () => {
    writeRepoFile(copied)
    const r = tag(CLI)
    expect(r.changed).toBe(true)
    expect(r.instanceDrifted).toBe(false)
    expect(readRepoFile()).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      env: { MY_OWN_FLAG: 'kept', OTEL_RESOURCE_ATTRIBUTES: attrs(CLI) },
    })
  })

  it("keeps the repo's helper while the install's global settings have none", () => {
    writeRepoFile(copied)
    tag(CLI, null)
    expect(readRepoFile().otelHeadersHelper).toBe('copied helper command')
  })
})

describe('writeRepoTag — instance shared by the installs on this machine', () => {
  it("leaves a tag naming another local install's instance on the same deployment alone, with no drift", () => {
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    const before = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')
    const r = tag(CLI)
    expect(r).toMatchObject({ changed: false, healed: false, instanceDrifted: false })
    expect(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')).toBe(before)
  })

  it('rewrites a tag naming a local install enrolled with another deployment, and reports drift', () => {
    writeStore(desktopDir(), DESKTOP, ELSEWHERE)
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    const r = tag(CLI)
    expect(r).toMatchObject({ changed: true, healed: true, instanceDrifted: true })
    expect(readRepoFile().env.OTEL_RESOURCE_ATTRIBUTES).toBe(attrs(CLI))
  })

  it('rewrites a tag naming an instance no local store holds, and reports drift', () => {
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(GONE) } })
    const r = tag(CLI)
    expect(r).toMatchObject({ changed: true, healed: true, instanceDrifted: true })
    expect(readRepoFile().env.OTEL_RESOURCE_ATTRIBUTES).toBe(attrs(CLI))
  })

  it('localClaudeEnrolments finds the default store and each config-folder store', () => {
    expect([...localClaudeEnrolments(stores).keys()].sort()).toEqual([CLI, DESKTOP].sort())
  })
})

describe('backfill stamps the instance writeRepoTag keeps', () => {
  const globalEnv = enrolment(CLI).env

  it("the tag's instance when another local install on the same deployment holds it", () => {
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    expect(launchResourceAttrs(repo, globalEnv, stores)).toBe(
      `tokenscope.instance_id=${DESKTOP},tool=claude-code,project.code_hash=${CODE_HASH}`,
    )
  })

  it("this install's own instance when the tag's is enrolled with another deployment", () => {
    writeStore(desktopDir(), DESKTOP, ELSEWHERE)
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    expect(launchResourceAttrs(repo, globalEnv, stores)).toBe(
      `tokenscope.instance_id=${CLI},tool=claude-code,project.code_hash=${CODE_HASH}`,
    )
  })
})

describe('statusline — the repo tag instance', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z')
  function writeCache(dir: string, instance: string, lastEmission: string | null, checkedAt = '2026-10-15T11:55:00Z') {
    writeFileSync(
      join(dir, 'last-landed.claude-code.json'),
      JSON.stringify({
        ok: true,
        instanceId: instance,
        lastEmission,
        lastBearer: '2026-10-15T11:50:00Z',
        tsStart: '2026-10-01T00:00:00Z',
        silent: false,
        revoked: false,
        checkedAt,
      }),
    )
  }
  const env = enrolment(CLI).env
  const landing = () => sessionLanding(env, repo, { now: NOW, ownDir: stores, storeRoot: stores })

  it("reads the Desktop install's cache in a repo tagged with its instance, not the CLI's own", () => {
    // The CLI's own instance has never landed (all its work is in this repo);
    // the tagged Desktop instance is landing.
    writeCache(stores, CLI, null)
    writeCache(desktopDir(), DESKTOP, '2026-10-15T11:40:00Z')
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    expect(landing()).toMatchObject({ landing: 'landed', tagged: true })
  })

  it("reads unknown when the other install's cache is older than NEVER_LANDED_GRACE_MS", () => {
    writeCache(stores, CLI, '2026-10-15T11:40:00Z')
    writeCache(desktopDir(), DESKTOP, '2026-10-15T08:00:00Z', new Date(NOW - NEVER_LANDED_GRACE_MS - 60_000).toISOString())
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(DESKTOP) } })
    expect(landing().landing).toBe('unknown')
  })

  it("reads unknown, not this install's landed, when the tag names an instance no local store holds", () => {
    writeCache(stores, CLI, '2026-10-15T11:40:00Z')
    writeRepoFile({ env: { OTEL_RESOURCE_ATTRIBUTES: attrs(GONE) } })
    expect(landing().landing).toBe('unknown')
  })
})
