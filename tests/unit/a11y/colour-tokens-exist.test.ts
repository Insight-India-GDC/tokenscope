/*
 * Every Tailwind colour class in app/ names a colour the theme defines.
 *
 * Tailwind generates nothing for a class whose colour token does not exist, and
 * says nothing either: `border-carbon-6` drew the default border colour and
 * `bg-carbon-8` drew no background at all, on 49 sites in 8 files, for months
 * (#490, REMAINING A10). Nothing type-checks a class string, so this walks
 * every .vue and .ts under app/ and fails on any colour utility whose colour is
 * neither a token bound in main.css `@theme` (`--color-*`) nor a step of a
 * Tailwind default palette.
 *
 * What counts as a colour class: a colour utility prefix (`text-`, `bg-`,
 * `border-`, `divide-`, `ring-`, `fill-`, ...) followed by a name whose first
 * word is one of this project's palette families or a Tailwind default family.
 * Size and layout values that share a prefix (`text-sm`, `border-2`,
 * `ring-offset-2`) are not colour names and are not matched.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const APP = join(ROOT, 'app')

/** `--color-<name>` bindings inside main.css's @theme block. */
function themeColours(): Set<string> {
  const css = readFileSync(join(APP, 'assets/css/main.css'), 'utf8')
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  return new Set([...theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
}

// Tailwind 4's default palette: each family has these steps.
const DEFAULT_FAMILIES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate', 'gray', 'zinc', 'neutral', 'stone',
]
const DEFAULT_STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

// This project's own palette families (brand-tokens.css). Any class naming one
// of these must resolve to a bound token.
const PROJECT_FAMILIES = ['carbon', 'calm', 'cloud', 'paper', 'clarity', 'brand', 'rag', 'lane']

const PREFIXES = [
  'text', 'bg', 'border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l',
  'border-s', 'border-e', 'divide', 'ring', 'ring-offset', 'outline', 'fill', 'stroke', 'from', 'via',
  'to', 'decoration', 'accent', 'caret', 'placeholder', 'shadow', 'inset-shadow', 'inset-ring',
]

const FAMILIES = [...PROJECT_FAMILIES, ...DEFAULT_FAMILIES]
// prefix-<family>[-rest][/opacity], not preceded by a class-name character.
// Longest prefixes first so `border-t-carbon` is not read as `border-` + `t-…`.
const CLASS_RE = new RegExp(
  `(?<![\\w-])(?:${[...PREFIXES].sort((a, b) => b.length - a.length).join('|')})-((?:${FAMILIES.join('|')})(?:-[a-z0-9]+)*)(?:\\/\\d+)?(?![\\w-])`,
  'g',
)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

function isDefined(name: string, theme: Set<string>): boolean {
  if (theme.has(name)) return true
  const [family, step, ...rest] = name.split('-')
  return rest.length === 0 && DEFAULT_FAMILIES.includes(family!) && DEFAULT_STEPS.includes(step ?? '')
}

describe('Tailwind colour classes in app/ name a colour the theme defines', () => {
  const theme = themeColours()

  it('reads the theme (guards against a parse that finds nothing and passes everything)', () => {
    for (const t of ['carbon', 'carbon-3', 'calm-2', 'brand-harmony', 'rag-amber', 'paper']) {
      expect(theme.has(t), t).toBe(true)
    }
  })

  it('detects an undefined token (the matcher is live)', () => {
    const sample = `<div class="border-t border-carbon-6 hover:bg-carbon-8/40 text-sm divide-calm-3">`
    const found = [...sample.matchAll(CLASS_RE)].map((m) => m[1]!).filter((n) => !isDefined(n, theme))
    expect(found).toEqual(['carbon-6', 'carbon-8', 'calm-3'])
  })

  it('finds no colour class without a token', () => {
    const offenders: string[] = []
    for (const file of walk(APP)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const m of line.matchAll(CLASS_RE)) {
          if (!isDefined(m[1]!, theme)) offenders.push(`${relative(ROOT, file)}:${i + 1}  ${m[0]}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
