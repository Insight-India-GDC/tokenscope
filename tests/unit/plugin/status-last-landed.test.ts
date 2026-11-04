/**
 * #457: /tokenscope:status says when this device's usage last ARRIVED, not only
 * that the credential works. landedReport() picks the live /health answer, else
 * the status line's landing record for this instance, else says it is unknown.
 */
import { describe, it, expect } from 'vitest'
import { landedReport, interpretEmissionProbe, workReport } from '../../../plugin/scripts/status.mjs'

const AT = '2026-10-30T09:12:00.000Z'
const CHECKED = '2026-10-30T09:20:00.000Z'

describe('landedReport', () => {
  it('reports the live server answer', () => {
    const r = landedReport({ ok: true, lastEmission: AT }, null, 'inst-a')
    expect(r).toMatchObject({ at: AT, source: 'server' })
    expect(r.message).toContain(AT)
  })

  it('says nothing has arrived yet when the server has no emission', () => {
    const r = landedReport({ ok: true, lastEmission: null }, null, 'inst-a')
    expect(r).toMatchObject({ at: null, source: 'server' })
    expect(r.message).toMatch(/has not received usage/)
  })

  it('falls back to this instance’s landing record when the server cannot be asked', () => {
    const cache = { instanceId: 'inst-a', lastEmission: AT, checkedAt: CHECKED }
    const r = landedReport({ ok: false, reason: 'fetch-failed' }, cache, 'inst-a')
    expect(r).toMatchObject({ at: AT, source: 'cache', checked_at: CHECKED })
    expect(r.message).toContain(CHECKED)
  })

  it('ignores a landing record that names another instance (an old shared file)', () => {
    const cache = { instanceId: 'copilot-inst', lastEmission: AT, checkedAt: CHECKED }
    const r = landedReport(null, cache, 'inst-a')
    expect(r).toMatchObject({ at: null, source: null })
  })

  it('is unknown when there is neither', () => {
    expect(landedReport(null, null, 'inst-a').source).toBeNull()
  })
})

describe('the OK verdict no longer claims delivery is invisible', () => {
  it('drops "it cannot see whether your usage has arrived"', () => {
    const v = interpretEmissionProbe({ status: 0, stdoutHasAuth: true, sentinel: null })
    expect(v.message).toBe('OK: this computer can send usage to TokenScope.')
  })
})

// #475: status says what the work is tagged with, and where each part came from.
describe('workReport', () => {
  it('a tag set this session wins over the folder', () => {
    expect(
      workReport({ set: { project: 'P-1', activity: 'Research' }, tokenscopeCode: 'P-2', folderActivity: 'testing' }),
    ).toEqual({
      project: { code: 'P-1', source: 'set this session' },
      activity: { label: 'Research', source: 'set this session' },
    })
  })

  it('falls back to .tokenscope, then .claude/settings.json, and the folder default', () => {
    expect(workReport({ tokenscopeCode: 'P-2', folderActivity: 'testing' })).toEqual({
      project: { code: 'P-2', source: 'from .tokenscope' },
      activity: { label: 'testing', source: 'folder default', note: "applies from the next session, and only if it is one of your region's activity types" },
    })
    expect(workReport({ settingsHash: 'f'.repeat(64) }).project).toEqual({
      code: null,
      code_hash: 'f'.repeat(64),
      source: 'from .claude/settings.json',
    })
  })

  it('a cleared activity this session shows the folder default again', () => {
    expect(workReport({ set: { project: null, activity: null }, folderActivity: 'testing' }).activity).toMatchObject({
      label: 'testing',
      source: 'folder default',
    })
  })

  it('is none and none with nothing', () => {
    expect(workReport({})).toEqual({ project: { code: null, source: null }, activity: { label: null, source: null } })
  })
})
