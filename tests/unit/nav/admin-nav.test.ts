/*
 * admin-nav — the shared admin IA. Tests the pure matchers/access logic the
 * sidebar + breadcrumb derivation depend on (no Vue/Nuxt runtime).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ADMIN_NAV,
  allAdminNavItems,
  matchAdminNavItem,
  groupForItem,
  roleMeetsAccess,
  policyNavItemsFor,
} from '../../../shared/nav/admin-nav'

/** Every .vue file under `dir`, recursively, as absolute paths. */
function readdirSyncRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) return readdirSyncRecursive(full)
    return e.name.endsWith('.vue') ? [full] : []
  })
}

describe('every admin page opts into the admin route middleware', () => {
  // `middleware: 'admin'` is what enforces the navigation boundary. The API is a
  // second gate, but without this a non-admin reaches the page and renders its
  // empty states as if they were the truth. All 23 admin pages carried it and the
  // 24th did not -- a convention with no guard is a convention that drifts.
  const adminPages = readdirSyncRecursive(resolve(__dirname, '../../../app/pages/admin'))

  it('finds admin pages to check', () => {
    expect(adminPages.length).toBeGreaterThan(10)
  })

  it.each(adminPages)('%s declares middleware: admin', (file) => {
    expect(readFileSync(file, 'utf8')).toMatch(/middleware:\s*'admin'/)
  })
  // The admin layout renders the linked breadcrumb trail for every admin page.
  // A page that also hands UiPageHead its own `crumbs` draws a second trail
  // (the project request detail page did, #490).
  it.each(adminPages)('%s leaves the breadcrumb trail to the admin layout', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/<UiPageHead[^>]*[\s:]crumbs=/)
  })
})

describe('every nav item points at a page that exists', () => {
  // The nav is hand-maintained and the router resolves at runtime, so a typo or a
  // link added ahead of its page ships a dead entry that only a human clicking it
  // would find. Same silent-gap shape as a worker registered without a cron.
  const pagesRoot = resolve(__dirname, '../../../app/pages')

  it.each(allAdminNavItems().map((i) => [i.label, i.to] as const))('%s -> %s', (_label, to) => {
    const path = String(to).split('?')[0]!.replace(/^\/+|\/+$/g, '')
    // Nuxt resolves `/admin/foo` to either `admin/foo.vue` or `admin/foo/index.vue`.
    const candidates = [`${path}.vue`, `${path}/index.vue`]
    const found = candidates.some((c) => existsSync(resolve(pagesRoot, c)))
    expect(found, `no page file for ${to} (looked for ${candidates.join(', ')})`).toBe(true)
  })
})

describe('matchAdminNavItem — longest-prefix active item', () => {
  it('maps the hub root to Overview', () => {
    expect(matchAdminNavItem('/admin')?.testid).toBe('overview')
    expect(matchAdminNavItem('/admin/')?.testid).toBe('overview')
  })

  it('prefers Regions over Overview for a region detail route', () => {
    // /admin/regions/:id must NOT collapse onto Overview (/admin).
    expect(matchAdminNavItem('/admin/regions/abc-123')?.testid).toBe('regions')
    expect(matchAdminNavItem('/admin/regions')?.testid).toBe('regions')
  })

  it('resolves query-constrained items — Providers vs Reconciliation on the same path', () => {
    // Providers and Reconciliation share /admin/reconciliation; the ?tab= query
    // disambiguates. A query-constrained item out-ranks the bare one.
    expect(matchAdminNavItem('/admin/reconciliation?tab=providers')?.testid).toBe('providers')
    expect(matchAdminNavItem('/admin/reconciliation?tab=runs')?.testid).toBe('reconciliation')
    expect(matchAdminNavItem('/admin/reconciliation')?.testid).toBe('reconciliation')
    expect(matchAdminNavItem('/admin/reconciliation?tab=records')?.testid).toBe('reconciliation')
  })

  it('returns null for a non-admin path', () => {
    expect(matchAdminNavItem('/reporting')).toBeNull()
  })

  it('Overview matches ONLY exactly — never swallows an admin route not in the nav', () => {
    // /admin/help is pinned, not in ADMIN_NAV. Overview (match /admin) must NOT
    // claim it as a prefix, else Overview double-highlights and the pinned
    // breadcrumb branch never runs.
    expect(matchAdminNavItem('/admin/help')).toBeNull()
    expect(matchAdminNavItem('/admin/some-future-unlisted-page')).toBeNull()
    expect(matchAdminNavItem('/admin')?.testid).toBe('overview')
  })

  it('every nav item resolves to itself', () => {
    for (const item of allAdminNavItems()) {
      expect(matchAdminNavItem(item.to)?.to).toBe(item.to)
    }
  })
})

describe('groupForItem', () => {
  it('finds the containing group', () => {
    const teammates = allAdminNavItems().find((i) => i.testid === 'teammates')!
    expect(groupForItem(teammates)?.label).toBe('People')
  })
  it('null in → null out', () => {
    expect(groupForItem(null)).toBeNull()
  })
})

describe('roleMeetsAccess', () => {
  it('platform-admin satisfies every access level', () => {
    for (const a of ['admin', 'org-wide', 'platform'] as const) {
      expect(roleMeetsAccess('platform-admin', a)).toBe(true)
    }
  })
  it('a retired role satisfies NO access level — org-wide is platform-admin alone', () => {
    for (const a of ['admin', 'org-wide', 'platform'] as const) {
      expect(roleMeetsAccess('global-finops', a)).toBe(false)
    }
  })
  it('region admin satisfies only admin', () => {
    expect(roleMeetsAccess('admin', 'admin')).toBe(true)
    expect(roleMeetsAccess('admin', 'org-wide')).toBe(false)
    expect(roleMeetsAccess('admin', 'platform')).toBe(false)
  })
  it('non-admin roles satisfy nothing', () => {
    for (const a of ['admin', 'org-wide', 'platform'] as const) {
      expect(roleMeetsAccess('developer', a)).toBe(false)
      expect(roleMeetsAccess(null, a)).toBe(false)
    }
  })
})

describe('IA invariants', () => {
  it('the first group is the ungrouped Overview home', () => {
    expect(ADMIN_NAV[0]!.label).toBeNull()
    expect(ADMIN_NAV[0]!.items).toHaveLength(1)
    expect(ADMIN_NAV[0]!.items[0]!.to).toBe('/admin')
  })
  it('every item has a unique route and testid', () => {
    const items = allAdminNavItems()
    expect(new Set(items.map((i) => i.to)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.testid)).size).toBe(items.length)
  })
})

describe('policyNavItemsFor — the System info "Policies" links', () => {
  const policies = ADMIN_NAV.find((g) => g.label === 'Policies')!.items

  it('offers a platform admin every Policies page, in sidebar order', () => {
    expect(policyNavItemsFor('platform-admin').map((i) => i.to)).toEqual(policies.map((i) => i.to))
    // The two pages the hand-written list had missed (#490).
    expect(policyNavItemsFor('platform-admin').map((i) => i.to)).toEqual(
      expect.arrayContaining(['/admin/policies/provider-governance', '/admin/policies/client-connection']),
    )
  })

  it('offers a region admin only the pages a region admin can open', () => {
    const tos = policyNavItemsFor('admin').map((i) => i.to)
    expect(tos).toEqual(policies.filter((i) => i.access === 'admin').map((i) => i.to))
    expect(tos).not.toContain('/admin/policies/client-connection')
  })

  it('offers a non-admin nothing', () => {
    expect(policyNavItemsFor('developer')).toEqual([])
    expect(policyNavItemsFor(null)).toEqual([])
  })
})
