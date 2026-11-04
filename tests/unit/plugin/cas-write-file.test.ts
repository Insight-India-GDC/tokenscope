// @vitest-environment node
/*
 * casWriteFile — the one read-modify-write used by every writer of
 * ~/.claude/settings.json.
 *
 * WHY IT MATTERS. settings.json holds the durable emit refresh token. Each writer
 * used to read it, compute, and rename its own snapshot over whatever was there.
 * A hook or a status-line toggle could therefore rename a STALE snapshot over a
 * token a redeem had just rotated, silently rolling the credential back to one
 * that may since have been revoked.
 *
 * WHY NOT A LOCK. `~/.claude` is a host bind-mount shared by every container, and
 * each container has its own PID namespace, so a lockfile's usual stale-holder
 * check ("is that pid alive?") is meaningless across writers. A wedged lock on
 * this file would stop every session on the host, which is worse than the race.
 * See the function's own header.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casWriteFile } from '../../../plugin/scripts/plugin-runtime.mjs'

// Windows (#430): skipped on win32 because this file asserts POSIX file mode 0600; Windows reports 0666.
const POSIX_ONLY = process.platform === 'win32'

let dir: string
let target: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-cas-'))
  target = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const temps = () => readdirSync(dir).filter((f) => f.includes('.tmp.'))

describe.skipIf(POSIX_ONLY)('casWriteFile', () => {
  it('writes when nothing else is competing', () => {
    writeFileSync(target, 'v1')
    expect(casWriteFile(target, () => 'v2')).toEqual({ changed: true })
    expect(readFileSync(target, 'utf8')).toBe('v2')
    expect(temps()).toEqual([])
  })

  it('treats a null render as "nothing to do" and leaves the file alone', () => {
    writeFileSync(target, 'v1')
    expect(casWriteFile(target, () => null)).toMatchObject({ changed: false })
    expect(readFileSync(target, 'utf8')).toBe('v1')
    expect(temps()).toEqual([])
  })

  it('hands the CURRENT bytes to render, including null for an absent file', () => {
    const seen: (string | null)[] = []
    casWriteFile(target, (raw) => {
      seen.push(raw)
      return 'created'
    })
    expect(seen).toEqual([null])
    expect(readFileSync(target, 'utf8')).toBe('created')
  })

  /*
   * THE ROLLBACK CASE. render() rewrites the file underneath itself on the first
   * attempt, exactly as a concurrent redeem would. The first candidate must be
   * discarded and the second derived from the WINNER's bytes.
   */
  it('re-derives from the winner instead of clobbering a concurrent write', () => {
    writeFileSync(target, 'old-token')
    const seen: (string | null)[] = []
    let attempt = 0
    const result = casWriteFile(target, (raw) => {
      seen.push(raw)
      attempt += 1
      if (attempt === 1) writeFileSync(target, 'ROTATED-TOKEN') // the redeem lands here
      return `${raw}+mine`
    })
    expect(result).toEqual({ changed: true })
    // Derived from the rotated bytes, NOT from the stale snapshot.
    expect(readFileSync(target, 'utf8')).toBe('ROTATED-TOKEN+mine')
    expect(seen).toEqual(['old-token', 'ROTATED-TOKEN'])
    expect(temps()).toEqual([])
  })

  it('gives up after the attempt budget rather than looping forever', () => {
    writeFileSync(target, 'start')
    let n = 0
    const result = casWriteFile(
      target,
      (raw) => {
        n += 1
        writeFileSync(target, `churn-${n}`) // a writer that never stops
        return `${raw}+mine`
      },
      { attempts: 3 },
    )
    expect(result).toMatchObject({ changed: false, reason: 'contended' })
    expect(n).toBe(3)
    expect(readFileSync(target, 'utf8')).toBe('churn-3') // ours never landed
    expect(temps()).toEqual([])
  })

  it('leaves no temp file behind when render throws mid-write', () => {
    writeFileSync(target, 'v1')
    expect(() =>
      casWriteFile(target, () => {
        throw new Error('boom')
      }),
    ).toThrow(/boom/)
    expect(temps()).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('v1')
  })

  /*
   * WHAT IS ACTUALLY OBSERVABLE. An earlier version of this case listed the
   * directory from inside render(), which runs BEFORE the temp is created, so it
   * asserted nothing — a world-readable temp would have passed. The temp cannot
   * be observed from outside without a seam that would exist only for the test,
   * so the honest assertions are the ones below: the resulting file is 0600, and
   * stays 0600 when it replaces a world-readable one under a permissive umask.
   *
   * These do NOT isolate the explicit chmod, and cannot: a umask only removes
   * bits, so writeFileSync's own mode already caps the result at 0600. The chmod
   * restores a bit a umask stripped; it is not what keeps the file private.
   */
  it('writes the credential file 0600', () => {
    casWriteFile(target, () => 'secret')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('is 0600 even replacing a world-readable file under a permissive umask', () => {
    writeFileSync(target, 'was-open', { mode: 0o644 })
    const prev = process.umask(0o000)
    try {
      casWriteFile(target, () => 'secret')
    } finally {
      process.umask(prev)
    }
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readFileSync(target, 'utf8')).toBe('secret')
  })

  // ONLY an absent file is "absent": a present-but-unreadable one must never be
  // rendered as fresh and renamed over.
  it('aborts on a present-but-unreadable file and leaves it byte-identical', () => {
    writeFileSync(target, 'precious-credential', { mode: 0o600 })
    chmodSync(target, 0o000)
    try {
      expect(() => casWriteFile(target, () => 'fresh')).toThrow(/EACCES/)
      expect(temps()).toEqual([])
    } finally {
      chmodSync(target, 0o600)
    }
    expect(readFileSync(target, 'utf8')).toBe('precious-credential')
  })

  it('creates the parent directory when it does not exist', () => {
    const nested = join(dir, 'deep', 'settings.json')
    expect(casWriteFile(nested, () => 'x')).toEqual({ changed: true })
    expect(existsSync(nested)).toBe(true)
  })
})
