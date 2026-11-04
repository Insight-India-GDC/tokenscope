// @vitest-environment node
/*
 * tools/publish/validation/require-empty-resource-group.sh stops a validation
 * run before it deploys into a group an earlier run left resources in: the
 * v1.0.4 re-run picked up the earlier run's registry and failed on it (#516).
 * Runs the real script with `az` stubbed on PATH. tools/publish is
 * internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const SCRIPT = resolve(__dirname, '../../../tools/publish/validation/require-empty-resource-group.sh')
const ACR = '/subscriptions/9a1e0000-0000-4000-8000-000000000001/resourceGroups/rg-v/providers/Microsoft.ContainerRegistry/registries/crv18'

let dir: string

async function run(env: Record<string, string>) {
  try {
    const r = await exec('bash', [SCRIPT, 'rg-v'], {
      timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    })
    return { code: 0, out: `${r.stdout}${r.stderr}` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(PUBLIC_SNAPSHOT)('require-empty-resource-group.sh', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'require-empty-'))
    await writeFile(
      join(dir, 'az'),
      '#!/usr/bin/env bash\n[ -n "${STUB_FAIL:-}" ] && exit 1\n[ -n "${STUB_IDS:-}" ] && printf \'%s\\n\' $STUB_IDS\nexit 0\n',
    )
    await chmod(join(dir, 'az'), 0o755)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('passes an empty group', async () => {
    const r = await run({})
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('rg-v is empty')
  })

  it('refuses a group with leftovers and names them', async () => {
    const r = await run({ STUB_IDS: ACR })
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::rg-v is not empty (1 resources')
    expect(r.out).toContain('Microsoft.ContainerRegistry/registries/crv18')
  })

  it('refuses when the group cannot be read', async () => {
    const r = await run({ STUB_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Cannot read rg-v')
  })
})
