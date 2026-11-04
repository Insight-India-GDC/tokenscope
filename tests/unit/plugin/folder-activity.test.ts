/**
 * #475: a folder's default activity, `tokenscope.activity` in its
 * `.claude/settings.local.json`, rides telemetry as the `tokenscope.activity`
 * resource attribute (Claude via the repo tag the SessionStart hook writes,
 * Copilot via the forwarder's payload). The server keeps it only when it names a
 * standard activity type; here it only has to be a plain label.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFolderActivity } from '../../../plugin/scripts/tokenscope-project.mjs'
import { buildRepoResourceAttrs } from '../../../plugin/scripts/env-builder.mjs'
import { writeRepoTag } from '../../../plugin/scripts/tag-repo.mjs'
import { launchResourceAttrs } from '../../../plugin/scripts/plugin-runtime.mjs'
import { repoTagPlan } from '../../../plugin/hooks/session-start.mjs'
import { buildCopilotOtlpPayload } from '../../../plugin/scripts/otlp-logs.mjs'

const INST = '0e8b5f3c-2d71-4a96-b4c8-91f6e2a7d530'
let dir: string
const local = (body: unknown) => {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.local.json'), typeof body === 'string' ? body : JSON.stringify(body))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-folder-activity-'))
  mkdirSync(join(dir, '.git'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readFolderActivity', () => {
  it('reads tokenscope.activity from .claude/settings.local.json', () => {
    local({ tokenscope: { activity: ' Code review ' } })
    expect(readFolderActivity(dir)).toBe('Code review')
  })

  it('accepts the punctuation admin-made activity types use', () => {
    local({ tokenscope: { activity: 'R&D / design (v2).1+' } })
    expect(readFolderActivity(dir)).toBe('R&D / design (v2).1+')
  })

  it('is null when absent, not a plain label, or the file is unreadable', () => {
    expect(readFolderActivity(dir)).toBeNull()
    for (const v of ['', 'a,b', 'x=y', 'Acme;rm', 'a'.repeat(65), 42, { a: 1 }]) {
      local({ tokenscope: { activity: v } })
      expect(readFolderActivity(dir), JSON.stringify(v)).toBeNull()
    }
    local('{ not json')
    expect(readFolderActivity(dir)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('does not follow a symlinked settings file', () => {
    const elsewhere = join(dir, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify({ tokenscope: { activity: 'research' } }))
    mkdirSync(join(dir, '.claude'))
    symlinkSync(elsewhere, join(dir, '.claude', 'settings.local.json'))
    expect(readFolderActivity(dir)).toBeNull()
  })
})

describe('the activity in the resource attributes', () => {
  it('rides beside the project, percent-encoded', () => {
    expect(buildRepoResourceAttrs(INST, 'abc', 'Code review')).toBe(
      `tokenscope.instance_id=${INST},project.code_hash=abc,tool=claude-code,tokenscope.activity=Code%20review`,
    )
  })

  it('a folder with only an activity carries no project hash', () => {
    expect(buildRepoResourceAttrs(INST, null, 'research')).toBe(
      `tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=research`,
    )
  })

  it('without one, the attrs are what they were', () => {
    expect(buildRepoResourceAttrs(INST, 'abc')).toBe(`tokenscope.instance_id=${INST},project.code_hash=abc,tool=claude-code`)
  })

  it('the repo tag writes it, and keeps the folder setting itself', () => {
    local({ tokenscope: { activity: 'research' } })
    writeRepoTag({ cwd: dir, enrolment: { sessionId: INST }, codeHash: null, activity: 'research', storeDir: join(dir, 'store') })
    const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toBe(`tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=research`)
    expect(written.tokenscope).toEqual({ activity: 'research' })
  })

  it('scripts launched from the folder (backfill) carry it too', () => {
    local({ env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=Code%20review` } })
    const attrs = launchResourceAttrs(dir, { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},tool=claude-code` }, join(dir, 'store'))
    expect(attrs).toBe(`tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=Code%20review`)
  })

  // Copilot review on PR 496: `.` and parentheses survive encodeURIComponent.
  it('backfill keeps a label with a dot or parentheses', () => {
    const enc = encodeURIComponent('Review (v2.1)')
    local({ env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=${enc}` } })
    const attrs = launchResourceAttrs(dir, { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},tool=claude-code` }, join(dir, 'store'))
    expect(attrs).toContain(`tokenscope.activity=${enc}`)
  })

  it('the Copilot payload carries it as a resource attribute', () => {
    const p = buildCopilotOtlpPayload([], INST, null, { activity: 'research' })
    const attrs = p.resourceLogs[0].resource.attributes.map((a: { key: string }) => a.key)
    expect(attrs).toContain('tokenscope.activity')
  })
})

// External review (HIGH): a folder default must not untag a repo whose tag has no
// .tokenscope behind it, and removing the default must clear it from the tag.
describe('repoTagPlan', () => {
  const HASH = 'b'.repeat(64)
  it('keeps an existing project hash when only an activity is added', () => {
    local({ tokenscope: { activity: 'research' }, env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},project.code_hash=${HASH},tool=claude-code` } })
    expect(repoTagPlan(dir, null)).toEqual({ codeHash: HASH, activity: 'research' })
  })

  it('a .tokenscope hash wins over the one in the file', () => {
    local({ env: { OTEL_RESOURCE_ATTRIBUTES: `project.code_hash=${HASH}` } })
    expect(repoTagPlan(dir, 'c'.repeat(64))).toEqual({ codeHash: 'c'.repeat(64), activity: null })
  })

  it('rewrites a tag whose activity was removed from the folder setting', () => {
    local({ env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INST},tool=claude-code,tokenscope.activity=research` } })
    expect(repoTagPlan(dir, null)).toEqual({ codeHash: null, activity: null })
  })

  it('nothing to write in an untagged folder with no default', () => {
    expect(repoTagPlan(dir, null)).toBeNull()
  })
})
