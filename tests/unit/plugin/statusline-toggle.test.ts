/*
 * statusline-toggle.mjs — PLG-1 regression tests.
 *
 * The HIGH finding: `/tokenscope:statusline on` used to silently swallow a
 * JSON.parse failure of ~/.claude/settings.json (settings = {}) and then
 * rewrite the file as just {statusLine} — wiping the env block (the durable
 * TOKENSCOPE_OAUTH_REFRESH_TOKEN, OTel endpoints), otelHeadersHelper and
 * permissions: silent de-enrolment. These tests pin the fixed contract:
 *
 *   1. An unparseable settings.json → loud error + exit non-zero, file
 *      byte-identical (NEVER proceed with {}).
 *   2. A valid settings.json → 'on' merges the statusLine in while preserving
 *      every pre-existing key (env, permissions), via an atomic temp+rename
 *      write that leaves no temp droppings behind.
 *
 * The script runs its logic at module top level, so we drive it as a child
 * process with HOME pointed at a temp dir (os.homedir() honours $HOME on linux).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file relies on POSIX permission bits.
const POSIX_ONLY = process.platform === 'win32'

const SCRIPT = resolve(__dirname, '../../../plugin/scripts/statusline-toggle.mjs')

let home: string
let claudeDir: string
let settingsPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ts-sl-toggle-'))
  claudeDir = join(home, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  settingsPath = join(claudeDir, 'settings.json')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function runToggle(arg: string) {
  return spawnSync(process.execPath, [SCRIPT, arg], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
}

const ENROLLED = {
  otelHeadersHelper: '/opt/plugin/scripts/otel-headers-helper.sh',
  env: {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt_durable_secret',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=abc,tool=claude-code',
  },
  permissions: { allow: ['Bash(ls:*)'] },
}

describe.skipIf(POSIX_ONLY)('statusline-toggle — corrupt settings.json (PLG-1)', () => {
  const CORRUPT = '{ "env": { "TOKENSCOPE_OAUTH_REFRESH_TOKEN": "rt_secret", '

  it.each(['on', 'off', ''])('arg %j: exits non-zero and leaves the file byte-identical', (arg) => {
    writeFileSync(settingsPath, CORRUPT)
    const r = runToggle(arg)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not valid JSON|refusing/i)
    // The enrolment-destroying behaviour was rewriting the file as {statusLine}.
    expect(readFileSync(settingsPath, 'utf8')).toBe(CORRUPT)
  })

  it('does not leave a temp file behind on refusal', () => {
    writeFileSync(settingsPath, CORRUPT)
    runToggle('on')
    expect(readdirSync(claudeDir)).toEqual(['settings.json'])
  })
})

describe.skipIf(POSIX_ONLY)('statusline-toggle — happy path preserves enrolment', () => {
  it("'on' installs the status line WITHOUT dropping env/permissions/otelHeadersHelper", () => {
    writeFileSync(settingsPath, JSON.stringify(ENROLLED, null, 2) + '\n')
    const r = runToggle('on')
    expect(r.status).toBe(0)
    const next = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(next.statusLine?.command).toContain('statusline.mjs')
    // The enrolment must survive (the whole point of PLG-1).
    expect(next.env).toEqual(ENROLLED.env)
    expect(next.permissions).toEqual(ENROLLED.permissions)
    expect(next.otelHeadersHelper).toBe(ENROLLED.otelHeadersHelper)
    // Atomic write cleans up after itself.
    expect(readdirSync(claudeDir)).toEqual(['settings.json'])
  })

  it("'off' removes only the TokenScope status line and keeps everything else", () => {
    writeFileSync(settingsPath, JSON.stringify(ENROLLED, null, 2) + '\n')
    expect(runToggle('on').status).toBe(0)
    const r = runToggle('off')
    expect(r.status).toBe(0)
    const next = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(next.statusLine).toBeUndefined()
    expect(next.env).toEqual(ENROLLED.env)
  })
})
