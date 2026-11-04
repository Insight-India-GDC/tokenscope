/*
 * WCAG 2.2 AA checks that can be made from source, without a browser (#487).
 *
 * There is no axe run in this repo: the Playwright suite does not run in CI and
 * axe-core is not a dependency. These checks pin the properties #487 fixed so
 * they cannot drift back, each by reading the files that own them:
 *
 *  1. Contrast (1.4.3): the text tokens in brand-tokens.css, computed with the
 *     WCAG formula against the surfaces they are drawn on. A token change that
 *     drops a pair below 4.5:1 fails here.
 *  2. The fill hues too light for text (vision, zeal) are never used as text;
 *     their `-ink` tokens are.
 *  3. Focus (2.4.7): no `focus:outline-none` / `focus-visible:outline-none`,
 *     and a bare `outline-none` only on a container that is not in the tab
 *     order (tabindex="-1"); main.css keeps a 2px :focus-visible outline.
 *  4. Dialogs: every `role="dialog"` in a template is wired to useModalA11y
 *     (Escape, focus trap, focus return).
 *  5. Bypass blocks (2.4.1): both layouts start with a skip link to the id of
 *     their <main>.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { stripComments } from '../../helpers/strip-comments'

const ROOT = resolve(__dirname, '../../..')
const APP = join(ROOT, 'app')

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}

const vueFiles = walk(APP, /\.vue$/)
const rel = (p: string) => relative(ROOT, p)

/** The <template> part of a .vue file, with comments removed by the shared scanner (a regex
 *  strip is what CodeQL's js/incomplete-multi-character-sanitization flags; see the helper). */
function template(src: string): string {
  const start = src.indexOf('<template')
  const end = src.lastIndexOf('</template>')
  return start === -1 ? '' : stripComments(src.slice(start, end === -1 ? undefined : end))
}

// ── 1. Contrast ────────────────────────────────────────────────────────────
const tokensCss = readFileSync(join(APP, 'assets/css/brand-tokens.css'), 'utf8')
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss)
  if (!m) throw new Error(`token --${name} is not a hex in brand-tokens.css`)
  return m[1]!.toLowerCase()
}
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
/** `fg` at `alpha` over `bg` — what `bg-<token>/10` paints on a white card. */
function tint(fg: string, bg: string, alpha: number): string {
  const f = rgb(fg)
  const b = rgb(bg)
  return `#${f.map((v, i) => Math.round((v * alpha + b[i]! * (1 - alpha)) * 255).toString(16).padStart(2, '0')).join('')}`
}

describe('1.4.3 text contrast, computed from brand-tokens.css', () => {
  const WHITE = token('white')
  const surfaces = { white: WHITE, paper: token('paper'), clarity: token('brand-clarity') }
  const textTokens = [
    'carbon', 'carbon-2', 'carbon-3', 'brand-harmony', 'brand-heart', 'brand-hustle',
    'rag-red', 'rag-amber', 'rag-green', 'brand-vision-ink', 'brand-zeal-ink',
  ]

  it('the formula is the WCAG one (black on white is 21:1)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })

  for (const t of textTokens) {
    for (const [name, bg] of Object.entries(surfaces)) {
      it(`${t} on ${name} reaches 4.5:1`, () => {
        expect(contrast(token(t), bg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('muted text (carbon-3) stays readable on the grey and lilac fills it sits on', () => {
    expect(contrast(token('carbon-3'), token('calm-2'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('carbon-3'), token('brand-harmony-lite'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['rag-red', 'rag-amber', 'rag-green'])('%s as text on its own 10%% tint, and white on its fill', (t) => {
    expect(contrast(token(t), tint(token(t), WHITE, 0.1))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(WHITE, token(t))).toBeGreaterThanOrEqual(4.5)
  })

  it('ink tokens on their own lite chips', () => {
    expect(contrast(token('brand-vision-ink'), token('brand-vision-lite'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-zeal-ink'), token('brand-zeal-lite'))).toBeGreaterThanOrEqual(4.5)
  })

  it('heart (the text colour on hunger fills) on hunger-lite, hunger-sheer and a 10% hunger tint', () => {
    expect(contrast(token('brand-heart'), token('brand-hunger-lite'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-heart'), token('brand-hunger-sheer'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-heart'), tint(token('brand-hunger'), WHITE, 0.1))).toBeGreaterThanOrEqual(4.5)
  })
})

// ── 2. Fill hues never carry text ──────────────────────────────────────────
describe('vision and zeal are fills; their -ink tokens carry text', () => {
  it('no text-brand-vision / text-brand-zeal (3.2:1 and 2.0:1 on white)', () => {
    const offenders: string[] = []
    for (const f of walk(APP, /\.(vue|ts)$/)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![\w-])text-brand-(vision|zeal)(?![\w-])/.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

// ── 3. Focus ───────────────────────────────────────────────────────────────
describe('2.4.7 focus stays visible', () => {
  it('main.css draws a 2px :focus-visible outline for every element', () => {
    const css = readFileSync(join(APP, 'assets/css/main.css'), 'utf8')
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--brand-harmony\);/)
  })

  it('no class removes the focus outline', () => {
    const offenders: string[] = []
    for (const f of walk(APP, /\.(vue|ts)$/)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![\w-])focus(-visible)?:outline-(none|0|hidden)(?![\w-])/.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('a bare outline-none sits only on a container outside the tab order', () => {
    const offenders: string[] = []
    for (const f of vueFiles) {
      for (const tag of template(readFileSync(f, 'utf8')).match(/<[a-zA-Z][^>]*>/g) ?? []) {
        if (/(?<![\w:-])outline-none(?![\w-])/.test(tag) && !/tabindex="-1"/.test(tag)) {
          offenders.push(`${rel(f)}: ${tag.slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('UiButton carries its own focus-visible ring', () => {
    const src = readFileSync(join(APP, 'components/ui/Button.vue'), 'utf8')
    expect(src).toContain('focus-visible:outline-2')
    expect(src).toContain('focus-visible:outline-brand-harmony')
  })
})

// ── 4. Dialogs ─────────────────────────────────────────────────────────────
describe('every role="dialog" uses useModalA11y', () => {
  const dialogFiles = vueFiles
    .map((f) => {
      const src = readFileSync(f, 'utf8')
      return {
        file: rel(f),
        dialogs: (template(src).match(/role="dialog"/g) ?? []).length,
        wired: (src.match(/useModalA11y\(\{/g) ?? []).length,
      }
    })
    .filter((d) => d.dialogs > 0)

  it('finds the dialogs (the scan is live)', () => {
    expect(dialogFiles.length).toBeGreaterThan(15)
  })

  it.each(dialogFiles)('$file wires each dialog it renders', ({ dialogs, wired }) => {
    expect(wired).toBeGreaterThanOrEqual(dialogs)
  })
})

// ── 5. Skip links ──────────────────────────────────────────────────────────
describe('2.4.1 each layout starts with a skip link to its <main>', () => {
  it.each(['default', 'admin'])('%s layout', (name) => {
    const tpl = template(readFileSync(join(APP, `layouts/${name}.vue`), 'utf8'))
    const skip = /<a\s[^>]*href="#([\w-]+)"[^>]*>\s*Skip to content\s*<\/a>/.exec(tpl)
    expect(skip, 'no skip link').not.toBeNull()
    expect(tpl).toMatch(new RegExp(`<main[^>]*\\sid="${skip![1]}"`))
    // First focusable thing in the layout: before the header.
    expect(tpl.indexOf(skip![0])).toBeLessThan(tpl.indexOf('<NavAppHeader'))
  })
})
