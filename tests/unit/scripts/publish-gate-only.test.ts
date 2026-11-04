// @vitest-environment node
/*
 * publish.sh --gate-only builds the public snapshot, runs the leak gate and the
 * public docs check, and stops (#520): CI runs it so a doc link into an
 * internal-only path fails the PR, not the next publish. Runs against a small
 * fixture repository holding a copy of the publish tooling. tools/publish is
 * internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const ROOT = resolve(__dirname, '../../..')
let repo: string

function write(rel: string, text: string): void {
  mkdirSync(join(repo, rel, '..'), { recursive: true })
  writeFileSync(join(repo, rel), text)
}

async function git(...args: string[]): Promise<void> {
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args])
}

async function publish(...args: string[]): Promise<{ code: number; out: string }> {
  await git('add', '-A')
  await git('commit', '-qm', 'fixture', '--allow-empty')
  try {
    const r = await exec('bash', [join(repo, 'tools/publish/publish.sh'), ...args], { timeout: 60_000 })
    return { code: 0, out: `${r.stdout}${r.stderr}` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(PUBLIC_SNAPSHOT)('publish.sh --gate-only', () => {
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'publish-gate-only-'))
    await exec('git', ['init', '-q', repo])
    for (const f of ['publish.sh', 'leak-gate.sh', 'gate-patterns.txt', 'allow-patterns.txt']) {
      cpSync(join(ROOT, 'tools/publish', f), join(repo, 'tools/publish', f))
    }
    cpSync(join(ROOT, 'scripts/check-docs-references.mjs'), join(repo, 'scripts/check-docs-references.mjs'))
    write('tools/publish/internal-only-paths.txt', 'tools/publish\ndocs/design\n')
    write('tools/publish/substitutions.txt', '')
    write('package.json', '{ "name": "fixture", "version": "9.9.9" }\n')
    write('docs/design/note.md', '# Note\n')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('fails on a wiki link into an internal-only path, as a publish would', async () => {
    write('docs/wiki/Page.md', '# Page\n\nSee [the note](../design/note.md).\n')
    const r = await publish('--gate-only')
    expect(r.code).toBe(2)
    expect(r.out).toContain('docs/wiki/Page.md:3: link target "../design/note.md" does not exist')
    expect(r.out).not.toContain('public unit suite')
  })

  it('stops after the docs check when the snapshot is clean', async () => {
    write('docs/wiki/Page.md', '# Page\n\nNothing internal here.\n')
    const r = await publish('--gate-only')
    expect(r.out).toContain('OK: gate clean')
    expect(r.out).toContain('gate-only: leak gate and public docs check passed')
    expect(r.out).not.toContain('public unit suite')
    expect(r.out).not.toContain('classify the release')
    expect(r.code).toBe(0)
  })

  it('still writes the snapshot when --out is given', async () => {
    write('docs/wiki/Page.md', '# Page\n\nNothing internal here.\n')
    const out = join(repo, '..', `${basename(repo)}-out`)
    try {
      const r = await publish('--gate-only', '--out', out)
      expect(r.code).toBe(0)
      expect(r.out).toContain(`snapshot copied to ${out}`)
      expect(existsSync(join(out, 'docs/wiki/Page.md'))).toBe(true)
      expect(existsSync(join(out, 'docs/design'))).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses --gate-only with --push', async () => {
    const r = await publish('--gate-only', '--push')
    expect(r.code).toBe(64)
    expect(r.out).toContain('--gate-only cannot be combined with --push')
  })
})
