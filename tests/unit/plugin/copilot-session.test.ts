/**
 * #475: the Copilot `activity` skill tags "this session" from the session that
 * last sent usage from the folder. Both senders (the usage extension and the
 * legacy forwarder) note it in the TokenScope state folder, keyed by folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastSession, recordLastSession } from '../../../plugin/scripts/copilot-session.mjs'
import { recordLastConversation } from '../../../plugin/scripts/copilot-forwarder.mjs'
import { findFolderActivity } from '../../../plugin/scripts/tokenscope-project.mjs'

const SID = '7d2c9a10-5b3e-4f61-9a8d-2e4b6c8d0f12'
let root: string
let state: string
let folder: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-copilot-session-'))
  state = join(root, 'state')
  folder = join(root, 'project')
  mkdirSync(folder)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const record = (id: string) => ({ attributes: [{ key: 'session.id', value: { stringValue: id } }] })

describe('the last-session note', () => {
  it('a sender notes the session, and the skill script reads it for that folder only', () => {
    recordLastSession(SID, folder, state)
    expect(lastSession(folder, state)).toMatchObject({ session_id: SID })
    mkdirSync(join(root, 'other'))
    expect(lastSession(join(root, 'other'), state).session_id).toBeNull()
  })

  it('nothing is written into the project folder', () => {
    recordLastSession(SID, folder, state)
    expect(readdirSync(folder)).toEqual([])
  })

  it('the legacy forwarder notes the last record it sent', () => {
    recordLastConversation([record('aaaaaaaa-0000-4000-8000-000000000001'), record(SID)], folder, state)
    expect(lastSession(folder, state)).toMatchObject({ session_id: SID })
  })

  it('is null for a note dated in the future', () => {
    recordLastSession(SID, folder, state, new Date(Date.now() + 24 * 60 * 60 * 1000))
    expect(lastSession(folder, state).session_id).toBeNull()
  })

  it('is null for a note older than two hours, or a malformed id', () => {
    recordLastSession(SID, folder, state, new Date(Date.now() - 3 * 60 * 60 * 1000))
    expect(lastSession(folder, state).session_id).toBeNull()
    recordLastSession('../../etc', folder, state)
    expect(lastSession(folder, state).session_id).toBeNull()
  })
})

describe('findFolderActivity (a Copilot session can start in a subfolder)', () => {
  it('walks up to the nearest .claude/settings.local.json', () => {
    mkdirSync(join(folder, '.claude'))
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ tokenscope: { activity: 'research' } }))
    mkdirSync(join(folder, 'src', 'deep'), { recursive: true })
    expect(findFolderActivity(join(folder, 'src', 'deep'))).toBe('research')
  })

  it('the nearest file decides, even when it names no activity', () => {
    mkdirSync(join(folder, '.claude'))
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ tokenscope: { activity: 'research' } }))
    mkdirSync(join(folder, 'sub', '.claude'), { recursive: true })
    writeFileSync(join(folder, 'sub', '.claude', 'settings.local.json'), '{}')
    expect(findFolderActivity(join(folder, 'sub'))).toBeNull()
  })
})
