/*
 * prototype-parity — the gate that can actually fail.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * Build agents were told to "match the prototype" and reviewers were told to
 * verify against it, and nine of the fifteen surfaces the approved prototype
 * puts on the cost-centre page were still absent. The cause was mechanical, not
 * careless: the prototype is executable JS, so a page's surface list is only
 * discoverable by RUNNING it, and every check anyone ran started from the build
 * ("does the build have X?") — which can confirm presence and is structurally
 * incapable of detecting absence.
 *
 * This gate runs the other way. `inventory.json` is emitted from the approved
 * prototype (scripts/emit-prototype-inventory.mjs); every surface it records
 * must be answered for HERE, in `parity-map.json`, with one of:
 *
 *   { "built": "ComponentName" }   the scope's component tree must contain it
 *   { "built": { "text": "..." } } the tree's source must contain that string
 *   { "missing": "why" }           an ACKNOWLEDGED GAP — this test FAILS
 *   { "waived": { reason, decision } }  an owner ruling that it does not belong
 *
 * `missing` failing is the point. A gap cannot be quiet: it either gets built,
 * or somebody writes down the decision that it should not be.
 *
 * ── WHAT THIS GATE DOES NOT PROVE, STATED PLAINLY ────────────────────────────
 * It resolves the component TREE. It proves a surface is WIRED INTO a scope, not
 * that it renders — a component behind a `v-if` that is never true still
 * satisfies set membership, and so would an unused import. Saying otherwise
 * would make this gate the very thing it exists to catch: an artefact claiming a
 * guarantee it does not deliver.
 *
 * The one gap that bit immediately is LANE gating, so that half is closed here:
 * the inventory records which lanes the prototype draws a surface in, and a
 * build that shows it in fewer must declare `lanes` and say why. Anything
 * narrower than a lane — a `v-if` on data, on a grant, on a feature flag —
 * this gate cannot see, and the coverage walk (docs/development/coverage-loop.md)
 * is the check that can.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SCOPE_ROOTS, scopeTree } from './component-graph'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const DESIGN = resolve(process.cwd(), 'docs/design/reporting-consolidation')

interface Surface {
  kind: string
  title: string
  lanes: string[]
  states: string[]
  always: boolean
}
interface Inventory {
  source: string
  scopes: Record<string, { label: string; surfaces: Surface[] }>
}
interface Built {
  built: string | { text: string }
  /**
   * The lanes the BUILD shows this surface in. Omit when it matches the
   * prototype. Present means the build is NARROWER than the artefact, which is a
   * deliberate deviation and needs `laneReason` to say who decided it.
   */
  lanes?: string[]
  laneReason?: string
}
type Entry = Built | { missing: string } | { waived: { reason: string; decision: string } }

/*
 * THE PUBLIC MIRROR DOES NOT CARRY THE ARTEFACT THIS GATE READS.
 *
 * `docs/design/` is internal-only (tools/publish/internal-only-paths.txt), so the
 * published snapshot ships this file while `inventory.json` / `parity-map.json`
 * are deliberately dropped — and a module-scope read then failed the whole FILE
 * (0 tests) on every public release.
 *
 * Skip only in the public snapshot, and there only when BOTH are absent.
 * Internally, or with some-but-not-all, the JSON.parse below runs unguarded and
 * a missing file throws right here, loudly.
 */
const INVENTORY_JSON = resolve(DESIGN, 'inventory.json')
const PARITY_MAP_JSON = resolve(DESIGN, 'parity-map.json')
const CARRIES_PROTOTYPE = !PUBLIC_SNAPSHOT || existsSync(INVENTORY_JSON) || existsSync(PARITY_MAP_JSON)

const inventory: Inventory = CARRIES_PROTOTYPE
  ? JSON.parse(readFileSync(INVENTORY_JSON, 'utf8'))
  : { source: '', scopes: {} }
const parityMap: Record<string, Record<string, Entry>> = CARRIES_PROTOTYPE
  ? JSON.parse(readFileSync(PARITY_MAP_JSON, 'utf8'))
  : {}

const key = (s: Surface) => `${s.kind}:${s.title}`

describe.skipIf(!CARRIES_PROTOTYPE)('the built reporting scopes match the approved prototype', () => {
  it('every scope in the inventory has a root component and a parity map', () => {
    for (const scope of Object.keys(inventory.scopes)) {
      expect(SCOPE_ROOTS[scope], `no component root declared for scope "${scope}"`).toBeDefined()
      expect(parityMap[scope], `no parity map section for scope "${scope}"`).toBeDefined()
    }
  })

  for (const [scope, { surfaces }] of Object.entries(inventory.scopes)) {
    describe(scope, () => {
      const always = surfaces.filter((s) => s.always)

      it('answers for every surface the prototype ALWAYS draws', () => {
        const map = parityMap[scope] ?? {}
        const unmapped = always.filter((s) => !map[key(s)]).map((s) => key(s))
        expect(
          unmapped,
          `The approved prototype draws these on "${scope}" and parity-map.json does not answer for them.\n` +
            `Add an entry per surface: {"built": "Component"} | {"missing": "why"} | {"waived": {...}}\n` +
            unmapped.map((u) => `  "${u}": { "missing": "not built" },`).join('\n'),
        ).toEqual([])
      })

      it('has no stale map entries', () => {
        const live = new Set(surfaces.map(key))
        const stale = Object.keys(parityMap[scope] ?? {}).filter((k) => !live.has(k))
        expect(
          stale,
          `parity-map.json answers for surfaces the prototype no longer draws on "${scope}". ` +
            `Re-run scripts/emit-prototype-inventory.mjs and delete these:`,
        ).toEqual([])
      })

      it('wires in every surface the prototype ALWAYS draws, in the lanes it draws them', () => {
        const { root, stopAt } = SCOPE_ROOTS[scope]!
        const tree = scopeTree(root, stopAt)
        const map = parityMap[scope] ?? {}
        const failures: string[] = []

        for (const s of always) {
          const entry = map[key(s)]
          if (!entry) continue // reported by the mapping test above
          if ('missing' in entry) {
            failures.push(`${key(s)} — NOT BUILT (${entry.missing})`)
            continue
          }
          if ('waived' in entry) {
            if (!entry.waived?.reason?.trim() || !entry.waived?.decision?.trim()) {
              failures.push(`${key(s)} — waiver needs both a reason and a decision reference`)
            }
            continue
          }
          /*
           * A surface the prototype draws in BOTH lanes and the build shows in
           * one is a real difference in what a reader sees, and set membership
           * cannot see it: the component is in the tree either way.
           */
          const declared = entry.lanes
          if (declared) {
            const missingLanes = s.lanes.filter((l) => !declared.includes(l))
            if (!missingLanes.length) {
              failures.push(`${key(s)} — declares \`lanes\` but shows in every lane the prototype does; drop it`)
            } else if (!entry.laneReason?.trim()) {
              failures.push(
                `${key(s)} — shown only in [${declared.join(', ')}] where the prototype draws [${s.lanes.join(', ')}]; needs \`laneReason\``,
              )
            }
          }
          const b = entry.built
          if (typeof b === 'string') {
            if (!tree.components.has(b)) {
              failures.push(`${key(s)} — mapped to <${b}>, which is not in the ${scope} component tree`)
            }
          } else if (!tree.source.includes(b.text)) {
            failures.push(`${key(s)} — mapped to text ${JSON.stringify(b.text)}, absent from the ${scope} tree`)
          }
        }

        expect(
          failures,
          `"${scope}" does not match the approved prototype (${inventory.source}):\n  ` + failures.join('\n  '),
        ).toEqual([])
      })
    })
  }
})
