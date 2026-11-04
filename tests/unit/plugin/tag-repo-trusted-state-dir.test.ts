/*
 * writeRepoTag looks for local enrolments under the TRUSTED state dir by
 * default, never under `TOKENSCOPE_STATE_DIR`: a repository's settings env can
 * set that variable, and a store planted there would decide which instance the
 * repo tag keeps.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const asked: unknown[] = []
vi.mock('../../../plugin/scripts/plugin-runtime.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    keptRepoTagEnrolment: (_tag: string, _own: string, _bearer: string, root: string) => {
      asked.push(root)
      return null
    },
  }
})

const { writeRepoTag } = await import('../../../plugin/scripts/tag-repo.mjs')
const { trustedStateDir } = await import('../../../plugin/scripts/plugin-runtime.mjs')

describe('writeRepoTag default state dir', () => {
  const saved = process.env.TOKENSCOPE_STATE_DIR
  let cwd = ''
  afterEach(() => {
    if (saved === undefined) delete process.env.TOKENSCOPE_STATE_DIR
    else process.env.TOKENSCOPE_STATE_DIR = saved
    rmSync(cwd, { recursive: true, force: true })
  })

  it('a repo-set TOKENSCOPE_STATE_DIR does not choose where local enrolments are read', () => {
    cwd = mkdtempSync(join(tmpdir(), 'ts-trusted-state-'))
    mkdirSync(join(cwd, '.git'))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=c41d7e2a-9b3f-4e60-8a15-7f2d6b0c9e84,tool=claude-code' } }),
    )
    process.env.TOKENSCOPE_STATE_DIR = join(cwd, 'repo-chosen')
    asked.length = 0
    writeRepoTag({
      cwd,
      enrolment: { sessionId: '0e8b5f3c-2d71-4a96-b4c8-91f6e2a7d530' },
      codeHash: 'abc',
    })
    expect(asked).toEqual([trustedStateDir()])
  })
})
