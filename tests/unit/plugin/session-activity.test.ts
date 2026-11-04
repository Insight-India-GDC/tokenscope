/**
 * #475: the local note of what /tokenscope:activity set, which the status line
 * and /tokenscope:status read, plus the status line's rendering of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionActivity, recordSessionActivity } from '../../../plugin/scripts/session-activity.mjs'
import { formatStatusLine, sessionWork } from '../../../plugin/scripts/statusline.mjs'

const SID = 'c3f1a2e0-1111-4222-8333-444455556666'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-session-activity-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('session activity note', () => {
  it('records and reads back what the server answered', () => {
    recordSessionActivity({ sessionId: SID, activity: 'Research', project: 'HBR-2041' }, dir)
    expect(readSessionActivity(SID, dir)).toMatchObject({ activity: 'Research', project: 'HBR-2041' })
  })

  it('an empty activity records a cleared one', () => {
    recordSessionActivity({ sessionId: SID, activity: '' }, dir)
    expect(readSessionActivity(SID, dir)).toMatchObject({ activity: null, project: null })
  })

  it('refuses malformed input and keeps the newest 200 sessions', () => {
    expect(() => recordSessionActivity({ sessionId: '../x', activity: 'a' }, dir)).toThrow()
    expect(() => recordSessionActivity({ sessionId: SID, activity: 'a\nb' }, dir)).toThrow()
    expect(() => recordSessionActivity({ sessionId: SID, activity: 'a', project: 'a b' }, dir)).toThrow()
    for (let i = 0; i < 205; i++) {
      const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`
      recordSessionActivity({ sessionId: id, activity: 'x', now: new Date(Date.UTC(2026, 9, 30, 0, 0, i)) }, dir)
    }
    expect(readSessionActivity('aaaaaaaa-0000-4000-8000-000000000000', dir)).toBeNull()
    expect(readSessionActivity('aaaaaaaa-0000-4000-8000-000000000204', dir)).not.toBeNull()
  })
})

describe('the status line shows what the work is', () => {
  const base = { configured: true, emitting: true, mcpAuthed: true, landing: 'landed', color: false }

  it('project and activity after the health label', () => {
    expect(formatStatusLine({ ...base, sessionId: SID, project: 'HBR-2041', activity: 'Research' })).toBe(
      'TokenScope ✓ landed · HBR-2041 · Research #c3f1a2e0',
    )
  })

  it('nothing added when unset', () => {
    expect(formatStatusLine({ ...base, sessionId: SID })).toBe('TokenScope ✓ landed #c3f1a2e0')
  })

  it('sessionWork: the session note, else .tokenscope and the folder default', () => {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.tokenscope'), 'project:\n  code: P-2\n')
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ tokenscope: { activity: 'testing' } }))
    const state = join(dir, 'state')
    expect(sessionWork(SID, repo, state)).toEqual({ project: 'P-2', activity: 'testing' })
    recordSessionActivity({ sessionId: SID, activity: 'Research', project: 'P-1' }, state)
    expect(sessionWork(SID, repo, state)).toEqual({ project: 'P-1', activity: 'Research' })
  })
})
