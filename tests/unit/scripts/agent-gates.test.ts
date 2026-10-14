/*
 * The two process gates added 2026-10-08: lint before commit
 * (scripts/check-commit-lint.mjs) and an external review before pushing code
 * (scripts/check-external-review.mjs). Their decisions are pure; git is injected.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitShape, eslintEntry, isCommit } from '../../../scripts/check-commit-lint.mjs'
import { CODE_PATHS, codeFingerprint, decide, isPush, pushSkipsReview, reviewedFingerprints } from '../../../scripts/check-external-review.mjs'

describe('lint gate: which commands are commits', () => {
  it('matches commits, including chained and env-prefixed ones', () => {
    for (const c of ['git commit -m x', 'git add -A && git commit -q -F - <<EOF\nm\nEOF', 'GIT_X=1 git commit --amend']) {
      expect(isCommit(c), c).toBe(true)
    }
  })
  it('recognises the forms the backlink gate does (newlines, wrappers, global options)', () => {
    for (const c of ['echo hi\ngit commit -m x', 'git -C repo commit -m x']) {
      expect(isCommit(c), c).toBe(true)
    }
    // Not parsed as commits, so the lint hook refuses them as unmodelled (see the hook tests below).
    for (const c of ['/usr/bin/git -c a=b commit -m x', 'command git commit']) {
      expect(isCommit(c), c).toBe(false)
    }
    for (const c of ['echo hi\ngit push', 'git -C repo push', 'command git push -q', '/usr/bin/git --no-pager push']) {
      expect(isPush(c), c).toBe(true)
    }
    expect(isPush('git status && echo push')).toBe(false)
  })

  it('lints unstaged and untracked files only when the command stages them', () => {
    expect(commitShape('git commit -m x')).toEqual({ commit: true, stages: false })
    expect(commitShape('git add -A && git commit -m x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git commit -am x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git commit --all -m x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git -C r add f.ts\ngit commit -m x')).toEqual({ commit: true, stages: true })
  })

  it('ignores everything else', () => {
    for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'npm run lint']) {
      expect(isCommit(c), c).toBe(false)
    }
  })
})

describe('external-review gate', () => {
  const trees = (overrides: Record<string, string>) => (args: string[]) => {
    const [ref, path] = args[1]!.split(':')
    const t = overrides[`${ref}:${path}`]
    if (t === undefined) throw new Error('missing')
    return t
  }

  it('the fingerprint covers exactly the code trees: a docs change leaves it equal', () => {
    const base = Object.fromEntries(CODE_PATHS.map((p) => [`A:${p}`, `tree-${p}`]))
    const sameCode = Object.fromEntries(CODE_PATHS.map((p) => [`B:${p}`, `tree-${p}`]))
    const changed = { ...Object.fromEntries(CODE_PATHS.map((p) => [`C:${p}`, `tree-${p}`])), 'C:plugin': 'tree-plugin-2' }
    const git = trees({ ...base, ...sameCode, ...changed })
    expect(codeFingerprint('A', git)).toBe(codeFingerprint('B', git))
    expect(codeFingerprint('C', git)).not.toBe(codeFingerprint('A', git))
  })

  it('allows non-push commands, unchanged code, reviewed code and the explicit skip', () => {
    const reviewed = new Set(['fp-reviewed'])
    expect(decide({ command: 'git status', head: 'x', base: 'y', reviewed }).allow).toBe(true)
    expect(decide({ command: 'git push', head: 'same', base: 'same', reviewed }).allow).toBe(true)
    expect(decide({ command: 'git push -q', head: 'fp-reviewed', base: 'old', reviewed }).allow).toBe(true)
    expect(decide({ command: 'SKIP_EXTERNAL_REVIEW=1 git push', head: 'new', base: 'old', reviewed }).allow).toBe(true)
  })

  it('refuses a push of code no external review covers', () => {
    expect(decide({ command: 'cd x && git push', head: 'new', base: 'old', reviewed: new Set() }).allow).toBe(false)
    // Forms whose code the gate would read from the wrong place are refused even when HEAD is reviewed.
    for (const c of ['cd ../other && git push', 'git -C ../other push', 'git push origin feature:main', 'git push --all']) {
      const d = decide({ command: c, head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']), branch: 'feat/x' })
      expect(d.allow, c).toBe(false)
      expect(d.unmodelled, c).toBeTruthy()
    }
    // A wrapped push is still a push, and is refused.
    for (const c of ['sh -c "git push origin main"', 'env --chdir=../o git push', 'FOO=1 sh -c "git push"', 'git --config-env push.default=PD push']) {
      expect(isPush(c), c).toBe(true)
      expect(decide({ command: c, head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']) }).allow, c).toBe(false)
    }
    expect(decide({ command: 'git push -u origin feat/x', head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']), branch: 'feat/x' }).allow).toBe(true)
    expect(decide({ command: 'git push --force-with-lease', head: 'new', base: 'old', reviewed: new Set(['other']) }).allow).toBe(false)
  })

  it('the emergency skip counts only as an env assignment on the push itself', () => {
    expect(pushSkipsReview('SKIP_EXTERNAL_REVIEW=1 git push')).toBe(true)
    expect(pushSkipsReview('A=b SKIP_EXTERNAL_REVIEW=1 git push -q')).toBe(true)
    for (const c of [
      'echo SKIP_EXTERNAL_REVIEW=1 && git push',
      'git push --push-option=SKIP_EXTERNAL_REVIEW=1',
      'SKIP_EXTERNAL_REVIEW=1 git status\ngit push',
      'SKIP_EXTERNAL_REVIEW=0 git push',
    ]) {
      expect(pushSkipsReview(c), c).toBe(false)
      expect(decide({ command: c, head: 'new', base: 'old', reviewed: new Set() }).allow, c).toBe(false)
    }
  })

  it('root manifests and workflows count as code', () => {
    for (const p of ['package.json', 'package-lock.json', 'nuxt.config.ts', 'Dockerfile', '.github/workflows', '.claude/settings.json']) {
      expect(CODE_PATHS).toContain(p)
    }
  })

  it('reads the ledger’s first column', () => {
    expect(reviewedFingerprints('fp1\tsha\tts\t/path\nfp2\tsha\n\n')).toEqual(new Set(['fp1', 'fp2']))
  })
})

describe('commit-lint hook: a wrapped or relocated commit is refused', () => {
  const run = (command: string) =>
    spawnSync(process.execPath, ['scripts/check-commit-lint.mjs'], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).stdout
  it('launches ESLint through Node, not the .bin shim (eslint.cmd will not spawn on Windows)', () => {
    expect(eslintEntry()).toMatch(/eslint[\\/]bin[\\/]eslint\.js$/)
    expect(readFileSync('scripts/check-commit-lint.mjs', 'utf8')).toContain('spawnSync(process.execPath, [eslint')
  })

  it('a lint error refuses the commit (ESLint really runs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-gate-'))
    try {
      // A throwaway repo with this checkout's node_modules and a one-rule config.
      spawnSync('git', ['init', '-q', dir])
      symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'junction')
      writeFileSync(join(dir, 'eslint.config.mjs'), "export default [{ rules: { 'no-unused-vars': 'error' } }]\n")
      writeFileSync(join(dir, 'bad.mjs'), 'const unused = 1\n')
      spawnSync('git', ['-C', dir, 'add', 'bad.mjs'])
      const out = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-commit-lint.mjs')], {
        cwd: dir,
        input: JSON.stringify({ tool_input: { command: 'git commit -m x' } }),
        encoding: 'utf8',
        timeout: 60_000,
      }).stdout
      expect(out).toContain('"permissionDecision":"deny"')
      expect(out).toContain('eslint reports errors')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 70_000)

  it('denies sh -c "git commit", and stays silent for a non-commit', () => {
    expect(run('sh -c "git commit -m x"')).toContain('"permissionDecision":"deny"')
    expect(run('sh -c "ls"')).toBe('')
    expect(run('FOO=1 sh -c "git commit -m x"')).toContain('"permissionDecision":"deny"')
    // A commit in another checkout: the gate would lint this one's files.
    for (const c of ['git -C ../other commit -m x', 'git -C../other commit -m x', 'cd ../other && git commit -m x', 'GIT_DIR=../o/.git git commit -m x', '/usr/bin/git -c a=b commit -m x', 'command git commit']) {
      expect(run(c), c).toContain('"permissionDecision":"deny"')
    }
  })
})
