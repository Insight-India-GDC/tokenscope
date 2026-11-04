// @vitest-environment node
/*
 * The example deploy workflow's "Resolve resources" step picks the Container
 * App to roll, the registry to build into and the image to roll back to. It
 * used to take the first registry the resource group listed: a group still
 * holding an earlier run's registry rolled the app to an image in that one,
 * which its private network could not reach, and the rollback then tried a
 * `latest` that did not exist yet (#516).
 *
 * Runs the step's own script, cut from the workflow file, with `az` stubbed
 * on PATH. The stub answers from STUB_* variables; STUB_READY_IMAGE is the
 * image of the app's latest ready revision, the rollback target.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const ROOT = resolve(__dirname, '../../..')
const WORKFLOW = join(ROOT, 'examples/github-actions/tokenscope-deploy.yml')

/** The `run: |` block of the named step, de-indented. */
function stepScript(src: string, name: string): string {
  const lines = src.split('\n')
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  if (at < 0) throw new Error(`no step ${name}`)
  const run = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l))
  const indent = /^(\s*)/.exec(lines[run]!)![1]!.length
  const body: string[] = []
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== '' && /^(\s*)/.exec(l)![1]!.length <= indent) break
    body.push(l)
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => /^(\s*)/.exec(l)![1]!.length))
  return body.map((l) => l.slice(pad)).join('\n')
}

const AZ_STUB = `#!/usr/bin/env bash
case "$1 $2" in
  "containerapp list") [ -n "\${STUB_APPS:-}" ] && printf '%s\\n' $STUB_APPS; exit 0 ;;
  "acr list") [ -n "\${STUB_ACRS:-}" ] && printf '%s\\n' $STUB_ACRS; exit 0 ;;
  "acr repository") [ -n "\${STUB_DIGEST:-}" ] && echo "$STUB_DIGEST"; exit 0 ;;
  "containerapp revision") [ -n "\${STUB_READY_IMAGE:-}" ] && echo "$STUB_READY_IMAGE"; exit 0 ;;
  "containerapp show")
    case "$*" in
      *registries*) [ -n "\${STUB_SERVER:-}" ] && echo "$STUB_SERVER" ;;
      *latestReadyRevisionName*) [ -n "\${STUB_READ_FAIL:-}" ] && { echo "ERROR: (InternalServerError) simulated" >&2; exit 1; }
        [ -n "\${STUB_READY:-}" ] && echo "$STUB_READY" ;;
    esac
    exit 0 ;;
esac
echo "unexpected az $*" >&2; exit 2
`

let dir: string

async function resolveStep(stub: Record<string, string>) {
  const script = join(dir, 'resolve.sh')
  const out = join(dir, 'out')
  await writeFile(script, stepScript(readFileSync(WORKFLOW, 'utf8'), 'Resolve resources'))
  await writeFile(out, '')
  let code = 0
  let log: string
  try {
    const r = await exec('bash', ['-e', script], {
      cwd: ROOT,
      timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RG: 'rg-v', BUILD: 'prebuilt', GITHUB_OUTPUT: out, ...stub },
    })
    log = `${r.stdout}${r.stderr}`
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    log = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const outputs = Object.fromEntries(
    (await readFile(out, 'utf8')).split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  return { code, log, outputs }
}

describe('example deploy workflow: Resolve resources', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deploy-resolve-'))
    await writeFile(join(dir, 'az'), AZ_STUB)
    await chmod(join(dir, 'az'), 0o755)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('takes the registry the app pulls from, not the first one the group lists', async () => {
    const r = await resolveStep({
      STUB_APPS: 'ca-v19',
      STUB_ACRS: 'crv18 crv19',
      STUB_SERVER: 'crv19.azurecr.io',
      STUB_READY: 'ca-v19--r1',
      STUB_READY_IMAGE: 'crv19.azurecr.io/tokenscope:aaaaaaaaaaaa',
      STUB_DIGEST: 'sha256:abc',
    })
    expect(r.code, r.log).toBe(0)
    expect(r.outputs.acr).toBe('crv19')
    expect(r.outputs.app).toBe('ca-v19')
    expect(r.outputs.prev).toBe('crv19.azurecr.io/tokenscope@sha256:abc')
  })

  it('refuses a group holding more than one Container App', async () => {
    const r = await resolveStep({ STUB_APPS: 'ca-a ca-b', STUB_SERVER: 'cra.azurecr.io', STUB_READY: 'r' })
    expect(r.code).not.toBe(0)
    expect(r.log).toContain('more than one Container App (ca-a ca-b)')
    expect(r.outputs.app).toBeUndefined()
  })

  it('falls back to the group\'s one registry when the app names none', async () => {
    const r = await resolveStep({ STUB_APPS: 'ca-v', STUB_ACRS: 'crv', STUB_READY: 'r' })
    expect(r.code, r.log).toBe(0)
    expect(r.outputs.acr).toBe('crv')
  })

  it('refuses to guess between registries when the app names none', async () => {
    const r = await resolveStep({ STUB_APPS: 'ca-v', STUB_ACRS: 'crv18 crv19', STUB_READY: 'r' })
    expect(r.code).not.toBe(0)
    expect(r.log).toContain('holds several (crv18 crv19)')
  })

  it('has nothing to roll back to when the app has never had a working revision', async () => {
    const r = await resolveStep({
      STUB_APPS: 'ca-v',
      STUB_SERVER: 'crv.azurecr.io',
    })
    expect(r.code, r.log).toBe(0)
    expect(r.outputs.prev).toBe('')
    expect(r.log).toContain('nothing to roll back to')
  })

  it('rolls back to the last revision that came up, not the image the app was last given', async () => {
    // An earlier deploy failed and its rollback failed too: the app's template
    // names the broken build, its latest ready revision still runs the good one.
    const r = await resolveStep({
      STUB_APPS: 'ca-v',
      STUB_SERVER: 'crv.azurecr.io',
      STUB_READY: 'ca-v--good',
      STUB_READY_IMAGE: 'crv.azurecr.io/tokenscope:000000000good',
    })
    expect(r.code, r.log).toBe(0)
    expect(r.outputs.prev).toBe('crv.azurecr.io/tokenscope:000000000good')
    expect(r.log).toContain('rollback target is the tag crv.azurecr.io/tokenscope:000000000good')
  })

  it('stops rather than dropping the rollback when Azure fails a read', async () => {
    const r = await resolveStep({ STUB_APPS: 'ca-v', STUB_SERVER: 'crv.azurecr.io', STUB_READ_FAIL: '1' })
    expect(r.code).not.toBe(0)
    expect(r.outputs.prev).toBeUndefined()
  })
})
