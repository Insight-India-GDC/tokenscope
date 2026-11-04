/**
 * #447: when one ~/.claude is shared by a host and a container, the side whose
 * helper path was written by the other one is told it is not sending usage, and
 * how to fix it. The self-heal no longer rewrites the path (that broke the
 * other side, which rewrote it back).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeOtherSides, sharedHomeHelperWarning } from '../../../plugin/hooks/session-start.mjs'

const HOST = '/home/u/.claude/plugins/cache/tokenscope/tokenscope/0.1.51/scripts'
const CONT = '/home/claude/.claude/plugins/cache/tokenscope/tokenscope/0.1.51/scripts'
const inContainer = (p: string) => p.startsWith('/home/claude/')
let dir: string
let settingsPath: string
const write = (helper: string) => writeFileSync(settingsPath, JSON.stringify({ otelHeadersHelper: helper }))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-shared-home-'))
  settingsPath = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sharedHomeHelperWarning', () => {
  it('names both sides and the fix when the helper was written by the other side', () => {
    write(`"${HOST}/otel-headers-helper.sh" --tool claude-code`)
    const w = sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: inContainer, otherSides: ['/home/u/.claude'] })
    expect(w).toContain('is NOT being sent')
    expect(w).toContain('/home/u/.claude')
    expect(w).toContain('/home/claude/.claude')
    expect(w).toMatch(/restart Claude Code/)
  })

  it('is silent when the helper path exists on this side', () => {
    write(`"${CONT}/otel-headers-helper.sh" --tool claude-code`)
    expect(sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: inContainer, otherSides: ['/home/u/.claude'] })).toBeNull()
  })

  it('is silent for a path that is simply gone (the self-heal repairs that one)', () => {
    write(`"${HOST}/otel-headers-helper.sh" --tool claude-code`)
    expect(sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: () => false, otherSides: ['/home/u/.claude'] })).toBeNull()
  })

  it('is silent when no other side has run (a renamed home is repaired, not warned about)', () => {
    write(`"${HOST}/otel-headers-helper.sh" --tool claude-code`)
    expect(sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: inContainer, otherSides: [] })).toBeNull()
  })

  it('is silent with no settings file or no helper of ours', () => {
    expect(sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: inContainer, otherSides: ['/home/u/.claude'] })).toBeNull()
    write('/usr/local/bin/my-helper.sh')
    expect(sharedHomeHelperWarning({ settingsPath, scriptsDir: CONT, exists: inContainer, otherSides: ['/home/u/.claude'] })).toBeNull()
  })
})

describe('claudeOtherSides — which sides of a shared Claude folder are running', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z')
  const day = 24 * 60 * 60 * 1000
  const sidesFile = () => join(dir, 'tokenscope-sides.json')

  it('records this side and reports the other one seen recently', () => {
    writeFileSync(sidesFile(), JSON.stringify({ '/home/u/.claude': new Date(NOW - 2 * day).toISOString() }))
    expect(claudeOtherSides({ settingsPath, scriptsDir: CONT, now: NOW })).toEqual(['/home/u/.claude'])
    const saved = JSON.parse(readFileSync(sidesFile(), 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['/home/claude/.claude', '/home/u/.claude'])
  })

  it('forgets a side not seen for two weeks (a renamed home)', () => {
    writeFileSync(sidesFile(), JSON.stringify({ '/home/u/.claude': new Date(NOW - 15 * day).toISOString() }))
    expect(claudeOtherSides({ settingsPath, scriptsDir: CONT, now: NOW })).toEqual([])
  })

  it('never lists this side as another one, and survives a broken file', () => {
    writeFileSync(sidesFile(), '{ not json')
    expect(claudeOtherSides({ settingsPath, scriptsDir: CONT, now: NOW })).toEqual([])
    expect(claudeOtherSides({ settingsPath, scriptsDir: CONT, now: NOW + 1000 })).toEqual([])
  })

  it('without recording, writes nothing', () => {
    claudeOtherSides({ settingsPath, scriptsDir: CONT, now: NOW, record: false })
    expect(() => readFileSync(sidesFile(), 'utf8')).toThrow()
  })
})
