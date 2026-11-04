import { describe, it, expect } from 'vitest'
import { isNavLinkActive } from '../../../shared/nav/active-link'

describe('isNavLinkActive', () => {
  it('keeps the Admin tab active on every admin page, not only /admin', () => {
    for (const p of ['/admin', '/admin/', '/admin/users', '/admin/audit', '/admin/regions/9a1e0000-0000-4000-8000-000000000001']) {
      expect(isNavLinkActive(p, '/admin')).toBe(true)
    }
  })

  it('does not match a sibling path that only shares a prefix', () => {
    expect(isNavLinkActive('/administrator', '/admin')).toBe(false)
    expect(isNavLinkActive('/usage-old', '/usage')).toBe(false)
  })

  it('matches Home exactly, never as a prefix of every route', () => {
    expect(isNavLinkActive('/', '/')).toBe(true)
    expect(isNavLinkActive('/admin', '/')).toBe(false)
    expect(isNavLinkActive('/usage', '/')).toBe(false)
  })

  it('ignores the query on the link and on the path', () => {
    expect(isNavLinkActive('/reporting', '/reporting?scope=cost-centre')).toBe(true)
    expect(isNavLinkActive('/reporting/teammate/x?from=y', '/reporting?scope=cost-centre')).toBe(true)
    expect(isNavLinkActive('/usage?day=2026-10-01', '/usage')).toBe(true)
  })
})
