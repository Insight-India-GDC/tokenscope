// @vitest-environment node
/*
 * trusted-git.mjs — git is resolved from an ABSOLUTE trusted location, never by
 * name.
 *
 * WHY THIS EXISTS. `execFileSync('git', …)` resolves through the process lookup
 * rules, and on Windows those search the CURRENT DIRECTORY before PATH. The
 * Copilot forwarder starts automatically with a repository as its cwd, so a
 * committed `git.exe` would run merely because someone opened the repository —
 * the same class Wave 1 removed from tag-repo.mjs, surviving in the paths that
 * were not walked with it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { gitRemoteOrgUrl } from '../../../plugin/scripts/copilot-forwarder.mjs'
import { trustedGitPath, resetTrustedGitPathCache } from '../../../plugin/scripts/trusted-git.mjs'

// Windows (#430): skipped on win32 because this file chdirs to /tmp.
const POSIX_ONLY = process.platform === 'win32'

afterEach(() => resetTrustedGitPathCache())

describe.skipIf(POSIX_ONLY)('trustedGitPath', () => {
  it('returns an ABSOLUTE path to a real binary, or null — never a bare name', () => {
    const p = trustedGitPath()
    if (p === null) return // a host without git in a trusted location is allowed
    expect(isAbsolute(p), 'a relative path would be resolved against the cwd').toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(p).not.toBe('git')
  })

  it('ignores PATH entirely — a repo-supplied directory cannot contribute', () => {
    /*
     * The bug is a REPOSITORY choosing the binary. PATH is one of the two
     * channels it reaches (the settings env block); the cwd is the other. Point
     * PATH exclusively at a directory holding a fake `git` and the answer must
     * not change.
     */
    const before = trustedGitPath()
    resetTrustedGitPathCache()
    const savedPath = process.env.PATH
    const savedCwd = process.cwd()
    try {
      process.env.PATH = '/nonexistent-repo-bin'
      process.chdir('/tmp')
      expect(trustedGitPath()).toBe(before)
    } finally {
      process.env.PATH = savedPath
      process.chdir(savedCwd)
    }
  })
})

describe.skipIf(POSIX_ONLY)('the CALL SITES resolve git through the trusted path, not by name', () => {
  /*
   * Testing the resolver alone proves nothing about the callers — the defect is
   * a call site doing a NAME lookup, and only exercising one can show that.
   *
   * A fake `git` is planted on PATH. A name lookup finds it and returns its
   * output; a trusted absolute path ignores PATH entirely and asks the real git,
   * which reports no origin for a bare temp directory. This is the POSIX stand-in
   * for the Windows cwd-before-PATH case that makes the class exploitable.
   */
  it('gitRemoteOrgUrl ignores a PATH-planted git', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'ts-fake-git-'))
    const workdir = mkdtempSync(join(tmpdir(), 'ts-fake-work-'))
    const savedPath = process.env.PATH
    try {
      const fake = join(fakeBin, 'git')
      writeFileSync(fake, '#!/bin/sh\nprintf "https://evil.example/pwned.git\\n"\n')
      chmodSync(fake, 0o755)
      process.env.PATH = fakeBin
      resetTrustedGitPathCache()
      expect(
        gitRemoteOrgUrl(workdir),
        'a repository-supplied git on PATH was EXECUTED',
      ).not.toBe('https://evil.example/pwned.git')
    } finally {
      process.env.PATH = savedPath
      rmSync(fakeBin, { recursive: true, force: true })
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
