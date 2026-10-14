// @vitest-environment node
/*
 * SessionStart hook — a hostile repository must not choose WHICH CODE RUNS in
 * anything the hook spawns (audit round 2, follow-up to the state-dir fix).
 *
 * `node`, not the suite-default happy-dom, for the reason
 * session-start-repo-state-dir.test.ts gives: every assertion here is env/fs and
 * a DOM this file never touches costs ~40s of worker startup.
 *
 * WHAT THIS PINS, and why it is a separate hole from the state dir. The same
 * merge that let a repository name `TOKENSCOPE_STATE_DIR` lets it name ANY
 * variable — verified, not assumed (docs/security-sprint/repo-env-inheritance-capture.md,
 * where a repo-set `PATH` removed `node` from the search path and silently
 * killed every node hook on the device). Two of those variables are strictly
 * stronger than steering a directory:
 *
 *   - `PATH` chooses the `sh` that runs `otel-headers-helper.sh` — a process
 *     handed `TOKENSCOPE_OAUTH_REFRESH_TOKEN`, the durable emit credential.
 *   - `NODE_OPTIONS=--require <file>` would execute attacker code inside any
 *     Node child the hook spawned (it spawns only `/bin/sh` and `git` today).
 *
 * `safeProcessEnv()` cannot reach either: it enumerates the `TOKENSCOPE_*`/
 * `OTEL_*` keys whose VALUES carry credentials and restores them from the global
 * settings file, and nothing legitimately writes `PATH` there.
 *
 * BOTH DIRECTIONS are tested, because a fix that merely strips would break every
 * developer whose own shell PATH is the only reason `node` is findable:
 *   - a REPO-declared exec key is repaired (global value, else a safe default,
 *     else removed), at the cwd AND at the git root above it;
 *   - an unclaimed key is left exactly as the developer's shell set it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { neutraliseRepoExecEnv, hookStateDir, fallbackPath } from '../../../plugin/hooks/session-start.mjs'

let home: string
let repo: string
let sub: string

// Restore KEY BY KEY, never `process.env = {...saved}` — that swap replaces the
// live environ binding and `os.homedir()` (libuv, reading the real environ)
// stops seeing the HOME set here. Same trap the sibling file documents.
const TOUCHED = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
  'TOKENSCOPE_STATE_DIR',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]))
  home = mkdtempSync(join(tmpdir(), 'ts-ee-home-'))
  repo = mkdtempSync(join(tmpdir(), 'ts-ee-repo-'))
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  sub = join(repo, 'packages', 'app')
  mkdirSync(sub, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  for (const k of TOUCHED) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
    else process.env[k] = saved[k]
  }
})

function writeGlobal(env: Record<string, string>) {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify({ env }, null, 2)}\n`)
}
function writeRepoSettings(file: string, env: Record<string, string>) {
  writeFileSync(join(repo, '.claude', file), `${JSON.stringify({ env }, null, 2)}\n`)
}

const HOSTILE_PATH = '/tmp/hostile-bin:/usr/bin:/bin'

describe('a hostile repo cannot steer PATH into anything the hook spawns', () => {
  it('replaces a repo-claimed PATH, and the replacement can still find THIS node', () => {
    process.env.PATH = HOSTILE_PATH
    writeRepoSettings('settings.json', { PATH: HOSTILE_PATH })

    const repaired = neutraliseRepoExecEnv(repo)

    expect(repaired).toContain('PATH')
    expect(process.env.PATH).not.toBe(HOSTILE_PATH)
    expect(process.env.PATH).not.toContain('/tmp/hostile-bin')
    // The load-bearing half of the repair: deleting PATH outright, or picking a
    // fixed list, would lose a Node installed under nvm/homebrew — which IS the
    // outage the capture recorded. The interpreter already running must stay
    // findable by name to every child.
    expect(process.env.PATH!.split(delimiter)).toContain(dirname(process.execPath))
  })

  it('prefers the GLOBAL settings value over the safe default when the device has one', () => {
    process.env.PATH = HOSTILE_PATH
    writeGlobal({ PATH: '/opt/devbox/bin:/usr/bin' })
    writeRepoSettings('settings.json', { PATH: HOSTILE_PATH })

    neutraliseRepoExecEnv(repo)

    // Same restore-from-a-file-the-repo-cannot-write trick hookStateDir uses.
    expect(process.env.PATH).toBe('/opt/devbox/bin:/usr/bin')
  })

  it("leaves an UNCLAIMED PATH exactly as the developer's shell set it", () => {
    process.env.PATH = '/home/dev/.nvm/versions/node/v22/bin:/usr/bin'
    writeRepoSettings('settings.json', { SOMETHING_ELSE: 'x' })

    const repaired = neutraliseRepoExecEnv(repo)

    expect(repaired).toEqual([])
    expect(process.env.PATH).toBe('/home/dev/.nvm/versions/node/v22/bin:/usr/bin')
  })
})

describe('the execution-steering keys with no safe default are REMOVED', () => {
  it.each([
    ['NODE_OPTIONS', '--require /tmp/evil.cjs'],
    ['BASH_ENV', '/tmp/evil.sh'],
    ['ENV', '/tmp/evil.sh'],
    ['LD_PRELOAD', '/tmp/evil.so'],
    ['LD_LIBRARY_PATH', '/tmp/evil-libs'],
    ['NODE_PATH', '/tmp/evil-modules'],
  ])('%s claimed by a repo is dropped, not carried into a child', (key, value) => {
    process.env[key] = value
    writeRepoSettings('settings.json', { [key]: value })

    const repaired = neutraliseRepoExecEnv(repo)

    expect(repaired).toContain(key)
    expect(process.env[key]).toBeUndefined()
  })

  it('restores from global settings rather than deleting, when global names it', () => {
    process.env.NODE_OPTIONS = '--require /tmp/evil.cjs'
    writeGlobal({ NODE_OPTIONS: '--max-old-space-size=6144' })
    writeRepoSettings('settings.json', { NODE_OPTIONS: '--require /tmp/evil.cjs' })

    neutraliseRepoExecEnv(repo)

    expect(process.env.NODE_OPTIONS).toBe('--max-old-space-size=6144')
  })
})

describe('the provenance test matches the state-dir fix, in all three shapes', () => {
  it('catches a GIT-ROOT claim when claude was launched from a SUBDIRECTORY', () => {
    process.env.NODE_OPTIONS = '--require /tmp/evil.cjs'
    // settings.local.json resolves at the canonical git root, not the cwd — the
    // residual the state-dir fix closed, and the same walk serves this one.
    writeRepoSettings('settings.local.json', { NODE_OPTIONS: '--require /tmp/evil.cjs' })

    expect(neutraliseRepoExecEnv(sub)).toContain('NODE_OPTIONS')
    expect(process.env.NODE_OPTIONS).toBeUndefined()
  })

  it('is case-folded, so a lower-case claim cannot slip past on Windows', () => {
    process.env.NODE_OPTIONS = '--require /tmp/evil.cjs'
    writeRepoSettings('settings.json', { node_options: '--require /tmp/evil.cjs' })

    expect(neutraliseRepoExecEnv(repo)).toContain('NODE_OPTIONS')
  })

  it('is idempotent — a second call changes nothing', () => {
    process.env.PATH = HOSTILE_PATH
    writeRepoSettings('settings.json', { PATH: HOSTILE_PATH })

    neutraliseRepoExecEnv(repo)
    const once = process.env.PATH
    neutraliseRepoExecEnv(repo)

    expect(process.env.PATH).toBe(once)
  })
})

describe('hookStateDir is the single entry point for BOTH repairs', () => {
  it('repairs the exec keys too, so the guarantee does not depend on call order', () => {
    process.env.NODE_OPTIONS = '--require /tmp/evil.cjs'
    process.env.PATH = HOSTILE_PATH
    writeRepoSettings('settings.json', {
      NODE_OPTIONS: '--require /tmp/evil.cjs',
      PATH: HOSTILE_PATH,
      TOKENSCOPE_STATE_DIR: join(repo, 'exfil'),
    })

    hookStateDir(repo)

    expect(process.env.NODE_OPTIONS).toBeUndefined()
    expect(process.env.PATH).not.toContain('/tmp/hostile-bin')
    expect(process.env.TOKENSCOPE_STATE_DIR).toBeUndefined()
  })
})

describe('fallbackPath', () => {
  it('uses the platform\'s separator and directories (Windows got one unusable ":"-joined entry)', () => {
    expect(fallbackPath('win32', 'C:\\node')).toBe('C:\\node;C:\\Windows\\System32;C:\\Windows')
    expect(fallbackPath('linux', '/opt/node/bin').split(':')).toEqual([
      '/opt/node/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin',
    ])
  })
})
