// @vitest-environment node
/*
 * publish.sh echoes its --remote and derives the release slug from it, so a
 * URL carrying a token would print the token. It must refuse such a remote
 * before doing anything, and without echoing it. tools/publish is
 * internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const PUBLISH = resolve(__dirname, '../../../tools/publish/publish.sh')
const TOKEN = 'tok9a1e0000placeholder'

async function run(remote: string): Promise<{ code: number; out: string }> {
  try {
    // --validate bogus makes an accepted remote stop at the next check, so
    // nothing past argument validation ever runs.
    const r = await exec('bash', [PUBLISH, '--remote', remote, '--validate', 'bogus'], { timeout: 30_000 })
    return { code: 0, out: `${r.stdout}${r.stderr}` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(PUBLIC_SNAPSHOT)('publish.sh --remote', () => {
  for (const remote of [
    `https://x-access-token:${TOKEN}@github.com/o/r.git`,
    `https://${TOKEN}@github.com/o/r.git`,
    `HTTPS://${TOKEN}@github.com/o/r.git`,
    `Http://${TOKEN}@github.com/o/r.git`,
    `git+https://${TOKEN}@github.com/o/r.git`,
    `https::https://${TOKEN}@github.com/o/r.git`,
    `SSH://git:${TOKEN}@github.com/o/r.git`,
    `ssh://git:${TOKEN}@github.com/o/r.git`,
  ]) {
    it(`refuses ${remote.replace(TOKEN, '<token>')} without echoing it`, async () => {
      const r = await run(remote)
      expect(r.code).toBe(64)
      expect(r.out).toContain('carries credentials')
      expect(r.out).not.toContain(TOKEN)
    })
  }

  it('accepts an SSH remote and a plain https remote', async () => {
    for (const remote of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://github.com/o/r.git']) {
      const r = await run(remote)
      expect(r.out, remote).not.toContain('carries credentials')
      expect(r.out, remote).toContain('--validate must be')
    }
  })
})
