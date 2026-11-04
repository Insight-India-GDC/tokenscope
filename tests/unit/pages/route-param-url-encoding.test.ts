// @vitest-environment node
/*
 * Vue Router hands a page its params already DECODED, so an id param spliced
 * raw into a request URL lets a crafted link (`/admin/regions/..%2Forg-units%2F<id>`)
 * re-route the page's PATCH to a different resource. Each page below must
 * refuse a non-uuid id, and every request URL it (or a child it passes the id
 * to) builds must encode it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const CASES: { file: string; idExpr: string; guarded: boolean }[] = [
  { file: 'app/pages/admin/regions/[id].vue', idExpr: 'regionId', guarded: true },
  { file: 'app/pages/allocations/[id].vue', idExpr: 'id.value', guarded: true },
  { file: 'app/pages/practice/[ouId].vue', idExpr: 'ouId.value', guarded: true },
  { file: 'app/components/admin/RegionLeadersModal.vue', idExpr: 'props.regionId', guarded: false },
  { file: 'app/components/admin/ReResolvePlacementDialog.vue', idExpr: 'props.regionId', guarded: false },
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('route-param ids are validated and encoded before they reach a request URL', () => {
  for (const { file, idExpr, guarded } of CASES) {
    it(`${file}: no raw \${${idExpr}} inside an /api/ URL`, () => {
      const src = read(file)
      const raw = new RegExp('`/api/[^`]*\\$\\{' + escape(idExpr) + '\\}', 'g')
      expect(src.match(raw) ?? []).toEqual([])
      expect(src).toContain(`encodeURIComponent(${idExpr})`)
    })
    if (guarded) {
      it(`${file}: a non-uuid id is a 404 before any request is built`, () => {
        const src = read(file)
        expect(src).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-[^/]*\$\/i\.test\(/)
        expect(src).toMatch(/statusCode: 404[^}]*fatal: true/)
      })
    }
  }

  it('RegionLeadersModal encodes the leader id in the DELETE URL', () => {
    expect(read('app/components/admin/RegionLeadersModal.vue')).not.toMatch(/\/leaders\/\$\{l\.id\}/)
  })
})
