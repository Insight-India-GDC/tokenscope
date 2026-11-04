// @vitest-environment node
/*
 * #503: /tokenscope:status checks the project tag with the attributes the
 * device actually emits with (this install's settings plus the repo tag), not
 * the command's env, which Claude Code strips of every OTEL_* key; and when the
 * check cannot run it names the reason. #494: it names this install's device.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceBlock, projectCheckEnv, unverifiedMessage } from '../../../plugin/scripts/status.mjs'

const MINE = '203d6725-f9f9-46d5-987b-571adfbb0857'
const OTHER = '11111111-2222-4333-8444-555555555555'
const BEARER = `https://tokenscope.example.com/api/v1/instances/${MINE}/bearer`
const HASH = 'a'.repeat(64)

let repo: string
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'st-repo-'))
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, '.claude'))
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('projectCheckEnv', () => {
  const install = {
    TOKENSCOPE_BEARER_ENDPOINT: BEARER,
    OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${MINE},tool=claude-code`,
  }

  it('takes the repo tag’s attributes and nothing else from the repo', () => {
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${OTHER},project.code_hash=${HASH},tool=claude-code`,
          TOKENSCOPE_BEARER_ENDPOINT: 'https://evil.example/api/v1/instances/x/bearer',
        },
      }),
    )
    const env = projectCheckEnv(install, join(repo))
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`project.code_hash=${HASH}`)
    expect(env.TOKENSCOPE_BEARER_ENDPOINT).toBe(BEARER)
  })

  it('reads the tag at the repo root from a subfolder', () => {
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: `project.code_hash=${HASH}` } }),
    )
    const sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(projectCheckEnv(install, sub).OTEL_RESOURCE_ATTRIBUTES).toBe(`project.code_hash=${HASH}`)
  })

  it('falls back to the committed .claude/settings.json tag, and the local file wins over it', () => {
    const shared = `project.code_hash=${'b'.repeat(64)}`
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: shared, TOKENSCOPE_BEARER_ENDPOINT: 'https://evil.example/x/bearer' } }),
    )
    expect(projectCheckEnv(install, repo)).toEqual({ ...install, OTEL_RESOURCE_ATTRIBUTES: shared })
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: `project.code_hash=${HASH}` } }),
    )
    expect(projectCheckEnv(install, repo).OTEL_RESOURCE_ATTRIBUTES).toBe(`project.code_hash=${HASH}`)
  })

  it('is this install’s own settings in an untagged repo', () => {
    expect(projectCheckEnv(install, repo)).toEqual(install)
  })
})

describe('unverifiedMessage', () => {
  it('names the real reason, never a fixed guess', () => {
    expect(unverifiedMessage('not-configured')).toMatch(/not set up.*\/tokenscope:setup/)
    expect(unverifiedMessage('no-token')).toMatch(/no current sign-in/)
    expect(unverifiedMessage('fetch-failed')).toMatch(/could not be reached/)
    expect(unverifiedMessage('http-401')).toMatch(/refused this device/)
    expect(unverifiedMessage('http-500')).toMatch(/answered unexpectedly \(http-500\)/)
    for (const r of ['not-configured', 'no-token', 'http-401', 'http-500', undefined]) {
      expect(unverifiedMessage(r)).not.toMatch(/offline, or emit/)
    }
  })
})

describe('deviceBlock', () => {
  it('names the instance this install’s own endpoint addresses, as the Account page shows it', () => {
    expect(deviceBlock({ TOKENSCOPE_BEARER_ENDPOINT: BEARER })).toEqual({
      instance: MINE.slice(0, 8),
      message: `This install is device ${MINE.slice(0, 8)}, as listed on your Account page.`,
    })
  })

  it('falls back to its own attributes, and is null when not set up', () => {
    expect(deviceBlock({ OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${OTHER}` })?.instance).toBe(OTHER.slice(0, 8))
    expect(deviceBlock({})).toBeNull()
  })
})
