// @vitest-environment node
/*
 * THE REPORTED UNIT IS A BUSINESS UNIT. "COST CENTRE" IS A DIFFERENT THING.
 *
 * A cost centre here is an OPTIONAL finance code that can be tagged onto a
 * Business Unit — the `costCenter` attribute the directory carries, unused by
 * this product today. Calling the Business Unit itself a "cost centre" collides
 * two objects an admin can see side by side on one screen, and it kept coming
 * back after being ruled out: the reporting layer was swept while the admin
 * screens, which are where the org structure is actually configured, kept the
 * old word in every heading, button and toast.
 *
 * ── WHY A SOURCE SCAN AND NOT A RENDER ASSERTION ─────────────────────────────
 * A render check proves one dialog says the right word today. The failure mode
 * is additive — the next admin surface someone writes — so the assertion has to
 * be over the whole directory. That is the difference between the rule holding
 * and the rule being written down again.
 *
 * ── WHAT IS DELIBERATELY ALLOWED ─────────────────────────────────────────────
 * Everything that is not prose:
 *   - identifiers and wire keys: `cost_owning_unit_id`, `costCentre`, `couId`,
 *     `cou_owner`. Renaming a label and renaming a contract are different
 *     changes; only the first one happened.
 *   - `data-testid`s, the `?tab=cost-centres` slug, the `/cost-centres` route
 *     and the `cost-centre-owner` help anchor — all addresses, and a saved link
 *     or a green test is not worth a word.
 *   - `costCenter` / "directory cost-centre code": the REAL finance code, the
 *     one thing this rename must not swallow.
 *   - "cost-owning": stripped here only because this scan is about "cost
 *     centre". Issue 489 ruled that a cost-owning unit IS a Business Unit, so
 *     the word no longer reaches users either; `user-copy-vocabulary.test.ts`
 *     enforces that over the whole app, not just admin.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BU_LABEL } from '#shared/reports/vocabulary'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ADMIN_DIRS = [join(ROOT, 'app', 'components', 'admin'), join(ROOT, 'app', 'pages', 'admin')]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.vue') || full.endsWith('.ts')) out.push(full)
  }
  return out
}

/*
 * Identifiers, addresses, and the genuine finance code — see the header. These
 * are STRIPPED from the text before the scan, not used to skip whole lines.
 *
 * A line-based allowlist was the first version, and it let three user-visible
 * strings through: the `Cost centres` tab LABEL survived because its line also
 * contains the route slug `'cost-centres'`, and two dialogs wrapped the phrase
 * across a newline so no single line ever contained it. A guard that cannot see
 * the text a person reads is not a guard.
 */
const ALLOWED =
  /costCenter|cost_center|cost_owning|costCentre|couId|cou_owner|data-testid="[^"]*"|anchor="[^"]*"|id: 'cost-centre-owner'|tab=[a-z-]*|'cost-centres'|"cost-centres"|\/cost-centres|directory cost.centre|cost-owning/g

/** The word as PROSE — "cost centre", "cost-centre", "Cost Centres", … */
const PROSE = /cost[\s-]centre/i

/**
 * What a PERSON reads.
 *
 * COMMENTS ARE STRIPPED FIRST. Nobody renders them, and several deliberately
 * name the old word to explain a stable address that must NOT move — "slug
 * stays `cost-centres`", "the help anchor is an address". A guard that fought
 * those would be pressure to delete the explanation, which is the opposite of
 * what it is for.
 *
 * Then the allowed identifiers and addresses are removed, and whitespace is
 * collapsed so a phrase broken across a template line-wrap reads as one string
 * — which is how the browser renders it, and how three of these escaped the
 * first version of this guard.
 */
function renderedText(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    // Line comments, LINE-LEADING ONLY. A trailing `// …` is left in place on
    // purpose: stripping from any `//` would also truncate a string containing
    // one, silently hiding whatever followed. For a guard the safe direction is
    // a false POSITIVE — someone rephrases a trailing comment — never a false
    // negative, which is how the first version of this let three strings through.
    .replace(/^[ \t]*\/\/[^\n]*/gm, ' ')
    .replace(ALLOWED, ' ')
    .replace(/\s+/g, ' ')
}

describe('the admin surfaces say Business Unit', () => {
  it('no admin component or page calls a Business Unit a "cost centre"', () => {
    const offenders: string[] = []
    for (const dir of ADMIN_DIRS) {
      for (const file of walk(dir)) {
        const text = renderedText(readFileSync(file, 'utf8'))
        for (const m of text.matchAll(new RegExp(PROSE.source, 'gi'))) {
          const at = m.index ?? 0
          offenders.push(`${relative(ROOT, file)}  …${text.slice(Math.max(0, at - 60), at + 60).trim()}…`)
        }
      }
    }
    expect(offenders, `Say "${BU_LABEL}". A cost centre is the optional finance code tagged onto one:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the label itself is still the word the ruling picked', () => {
    // Guards the direction of the fix: a future edit that redefined BU_LABEL
    // would make the scan above pass while the product said something else.
    expect(BU_LABEL).toBe('Business Unit')
  })
})
