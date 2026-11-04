// @vitest-environment node
/*
 * A checkout should not leave the job token in .git/config, where every later
 * step (third-party actions included) can read it. Every actions/checkout step
 * sets `persist-credentials: false`: the internal workflows, the public example
 * workflows adopters copy, and the release-validation workflow (internal-only,
 * so absent from the snapshot). The one exemption is the wiki checkout, which
 * wiki-publish.yml pushes from.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const DIRS = ['.github/workflows', 'examples/github-actions', 'tools/publish/validation']

const workflows = DIRS.filter((d) => existsSync(join(ROOT, d))).flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(d, f)),
)

const CHECKOUT = /^\s*(?:- )?uses: actions\/checkout@/m

/** Each step's own lines, named or not: from its `- ` to the next line at or left of it. */
function steps(src: string): string[] {
  const lines = src.split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    const m = /^(\s*)- [\w-]+:/.exec(line)
    if (!m) return
    const indent = m[1]!.length
    const body = [line]
    for (const next of lines.slice(i + 1)) {
      const lead = next.length - next.trimStart().length
      if (next.trim() !== '' && lead <= indent) break
      body.push(next)
    }
    out.push(body.join('\n'))
  })
  return out
}

const checkoutSteps = (src: string) => steps(src).filter((s) => CHECKOUT.test(s))
const pushesFrom = (step: string) => /repository:\s*\$\{\{\s*github\.repository\s*\}\}\.wiki\b/.test(step)

describe('actions/checkout never persists the job token', () => {
  it('finds the example and validation workflows', () => {
    expect(workflows).toContain('examples/github-actions/tokenscope-deploy.yml')
    expect(workflows).toContain('examples/github-actions/tokenscope-infra.yml')
  })

  for (const wf of workflows) {
    it(wf, () => {
      const src = readFileSync(join(ROOT, wf), 'utf8')
      const found = checkoutSteps(src)
      expect(found, `${wf}: a checkout step the parser did not see`).toHaveLength(
        (src.match(/uses: actions\/checkout@/g) ?? []).length,
      )
      for (const step of found) {
        if (pushesFrom(step)) continue
        expect(step, `${wf}: checkout without persist-credentials: false`).toMatch(/persist-credentials:\s*false/)
      }
    })
  }

  it('sees named checkout steps, and exempts only the wiki checkout', () => {
    const src = readFileSync(join(ROOT, '.github/workflows/wiki-publish.yml'), 'utf8')
    const found = checkoutSteps(src)
    expect(found).toHaveLength(2)
    expect(found.filter(pushesFrom)).toHaveLength(1)
  })
})
