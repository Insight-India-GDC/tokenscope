// @vitest-environment node
/*
 * scripts/check-docs-references.mjs — each drift class it exists for must be
 * reported, a deliberate exception must be honoured, and the CLI must exit
 * non-zero on a finding (CI and publish.sh key off the exit code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { checkTree } from '../../../scripts/check-docs-references.mjs'

const SCRIPT = resolve(__dirname, '../../../scripts/check-docs-references.mjs')
let root: string

function write(rel: string, content: string) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'docs-check-'))
  write('package.json', JSON.stringify({ scripts: { dev: 'nuxt dev', 'db:migrate': 'x' } }))
  write('infra/main.bicep', "param frontDoorSku string = 'Standard'\noutput containerAppUrl string = ''\n")
  write(
    'infra/modules/container-app.bicep',
    "{ name: 'NUXT_ANTHROPIC_KEY_MAIN', secretRef: 'k' }\n{ name: 'NUXT_GITHUB_PAT_ENTERPRISE_NFR', secretRef: 'g' }\n",
  )
  write('infra/parameters/example-sandbox.bicepparam', "param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')\n")
  write('server/uses.ts', "process.env.NUXT_SESSION_SECRET\n")
  write('docs/ok.md', 'Run `npm run dev` and `npm run test:*`. See [ok](ok.md) and `infra/main.bicep`.\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const messages = () => checkTree(root).map((p: { file: string; message: string }) => `${p.file}: ${p.message}`)

// Fixture names avoid anything tools/publish/substitutions.txt rewrites, so this
// suite passes in the public snapshot too (publish.sh runs it there).
describe('check-docs-references', () => {
  it('passes a tree whose docs only reference things that exist', () => {
    expect(messages()).toEqual([])
  })

  it('reports an npm script, a repo path and a link that do not exist', () => {
    write('docs/bad.md', 'Run `npm run db:seed`, open `scripts/gone.mjs`, read [x](missing.md).\n')
    const m = messages().join('\n')
    expect(m).toContain('npm script "db:seed" does not exist')
    expect(m).toContain('path "scripts/gone.mjs" does not exist')
    expect(m).toContain('link target "missing.md" does not exist')
  })

  it('reports a NUXT_ variable no code reads', () => {
    write('docs/env.md', 'Set `NUXT_SESSION_SECRET` and `NUXT_RETIRED_FLAG`.\n')
    const m = messages().join('\n')
    expect(m).toContain('NUXT_RETIRED_FLAG is not mentioned')
    expect(m).not.toContain('NUXT_SESSION_SECRET')
  })

  it('reports deploy-doc parameters and secrets variables the template or examples do not have', () => {
    write('docs/DEPLOY-AZURE.md', 'Set `frontDoorSku = \'Premium\'`, `appPublicOrigin`, `PG_ADMIN_PASSWORD` and `GH_PAT_RENAMED`.\n')
    const m = messages().join('\n')
    expect(m).toContain('"appPublicOrigin" is not a parameter or output')
    expect(m).toContain('secrets variable GH_PAT_RENAMED is not read')
    expect(m).not.toContain('frontDoorSku')
    expect(m).not.toContain('PG_ADMIN_PASSWORD')
  })

  it('does not count a workflow mapping a secret as the deployment reading it', () => {
    write('examples/github-actions/infra.yml', 'env:\n  GH_PAT_RENAMED: ${{ secrets.GH_PAT_RENAMED }}\n  PG_ADMIN_PASSWORD: ${{ secrets.PG_ADMIN_PASSWORD }}\n')
    write('docs/DEPLOY-AZURE.md', 'Set `GH_PAT_RENAMED`.\n')
    const m = messages().join('\n')
    expect(m).toContain('docs/DEPLOY-AZURE.md: secrets variable GH_PAT_RENAMED is not read')
    expect(m).toContain('examples/github-actions/infra.yml: secret GH_PAT_RENAMED is passed to the deployment but no example parameter file reads it')
    expect(m).not.toContain('PG_ADMIN_PASSWORD')
  })

  it('matches variable names whole, not as a prefix of a longer one', () => {
    write('docs/env.md', 'Set `NUXT_SESSION`.\n')
    expect(messages().join('\n')).toContain('NUXT_SESSION is not mentioned')
  })

  it('reports a credential name that maps to no wired key, including when the phrase wraps', () => {
    write(
      'docs/DEPLOY-AZURE.md',
      'The app reads it under the credential name\n  `insight`: use that name.\n\n| `GH_PAT_X` | `enterprise-nfr` |\n| `GH_PAT_Y` | `regional-nfr` |\n',
    )
    const m = messages().join('\n')
    expect(m).toContain('credential name "insight" maps to no key')
    expect(m).toContain('credential name "regional-nfr" maps to no key')
    expect(m).not.toContain('"enterprise-nfr" maps')
  })

  it('honours an ignore marker on the line or the line above', () => {
    write('docs/ignored.md', '<!-- docs-check: ignore (a file you create) -->\nCreate `infra/parameters/mine.bicepparam`.\n')
    expect(messages()).toEqual([])
  })

  it('skips docs the publish drops', () => {
    write('tools/publish/internal-only-paths.txt', 'docs/internal.md\n')
    write('docs/internal.md', 'Run `npm run nothing-here`.\n')
    expect(messages()).toEqual([])
  })

  describe('wiki diagrams', () => {
    const svg = (body = '') =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10" role="img"><title>t</title><desc>d</desc>` +
      `<style>@media (prefers-color-scheme: dark) { svg { --bg: #000; } }</style>` +
      `<line marker-end="url(#ah)"/>${body}</svg>`

    it('passes a page whose image exists and is a self-contained SVG', () => {
      write('docs/wiki/images/flow.svg', svg())
      write('docs/wiki/Page.md', '![the claim](images/flow.svg)\n')
      expect(messages()).toEqual([])
    })

    it('reports a mermaid block unless it is marked as kept', () => {
      write('docs/wiki/Page.md', '```mermaid\nflowchart LR\n```\n')
      expect(messages().join('\n')).toContain('docs/wiki/Page.md: mermaid block in the wiki')
      write('docs/wiki/Page.md', '<!-- docs-check: keep-mermaid (an ER diagram) -->\n```mermaid\nerDiagram\n```\n')
      expect(messages()).toEqual([])
    })

    it('reports a missing image, an unreferenced one and a name the wiki workflow would not copy', () => {
      write('docs/wiki/Page.md', '![gone](images/gone.svg)\n')
      write('docs/wiki/images/orphan.svg', svg())
      write('docs/wiki/images/has space.svg', svg())
      const m = messages().join('\n')
      expect(m).toContain('image "images/gone.svg" does not exist')
      expect(m).toContain('docs/wiki/images/orphan.svg: no wiki page references this image')
      expect(m).toContain('docs/wiki/images/has space.svg: only files named')
    })

    it('reports an image outside docs/wiki/images, which the workflow never publishes', () => {
      write('infra/diagram.png', 'x')
      write('docs/wiki/Page.md', '![a](../../infra/diagram.png)\n')
      expect(messages().join('\n')).toContain('image "../../infra/diagram.png" is outside docs/wiki/images/')
    })

    it('reports a single-quoted external href', () => {
      write('docs/wiki/images/q.svg', svg("<image href='https://x.test/a.png'/>"))
      write('docs/wiki/Page.md', '![q](images/q.svg)\n')
      expect(messages().join('\n')).toContain('docs/wiki/images/q.svg: SVG contains an external href')
    })

    it('reports an SVG that would not render standalone through <img>', () => {
      write('docs/wiki/images/bad.svg', '<svg viewBox="0 0 1 1"><script>x()</script><image href="https://x.test/a.png"/><rect style="fill:url(https://x.test/p)"/></svg>')
      write('docs/wiki/Page.md', '![bad](images/bad.svg)\n')
      const m = messages().join('\n')
      for (const what of ['a width', 'role="img"', 'a <title>', 'a <desc>', 'prefers-color-scheme', '<script>', 'an external href', 'an external url()']) {
        expect(m).toContain(what)
      }
    })

    it('reports a deployed resource name in a public diagram but not in one the publish drops', () => {
      write('docs/wiki/images/pub.svg', svg('<text>ca-widgets-prod-eus2</text>'))
      write('docs/wiki/images/internal.svg', svg('<text>log-ops-tokenscope-dev-wus3</text>'))
      write('docs/wiki/Page.md', '![a](images/pub.svg) ![b](images/internal.svg) and ca-&lt;name&gt; is fine\n')
      write('tools/publish/internal-only-paths.txt', 'docs/wiki/images/internal.svg\n')
      const m = messages()
      expect(m).toHaveLength(1)
      expect(m[0]).toContain('docs/wiki/images/pub.svg: public diagram names a deployed resource ("ca-widgets-prod-eus2")')
    })
  })

  it('exits 1 with findings and 0 when clean', () => {
    const clean = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    expect(clean.status).toBe(0)
    write('docs/bad.md', 'Run `npm run db:seed`.\n')
    const dirty = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    expect(dirty.status).toBe(1)
    expect(dirty.stderr).toContain('db:seed')
  })
})
