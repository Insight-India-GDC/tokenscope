/*
 * Admin IA — the single source of truth for the admin sidebar structure.
 *
 * Pure data + matchers (no Vue/Nuxt imports) so it is unit-testable and shared
 * by the layout, the sidebar, and breadcrumb derivation. The redesign groups
 * admin surfaces by what an admin DOES (task-oriented), not by scope. See
 * docs/design/admin-ia.md.
 *
 * `access` mirrors the page's real gate so the sidebar never offers a surface
 * the role can't use:
 *   'admin'    — any admin (Region admin / Global finance / Platform admin).
 *                Every current admin page gates page-level visibility on this;
 *                cross-region features degrade INTERNALLY via isOrgWide.
 *   'org-wide' — Global finance / Platform admin only.
 *   'platform' — Platform admin only.
 */

export type AdminAccess = 'admin' | 'org-wide' | 'platform'

export interface AdminNavItem {
  label: string
  to: string
  /** Route prefix that marks this item active; defaults to `to` (path only). */
  match?: string
  /**
   * Exact-match only (no prefix). Required for the Overview root ('/admin'),
   * which is otherwise a prefix of EVERY admin route and would swallow pages
   * that aren't in the nav (e.g. the pinned /admin/help).
   */
  exact?: boolean
  /**
   * Query constraint. When set, the item is active only if EVERY key equals the
   * current query — and it out-ranks a same-path item without a constraint.
   * Lets "Providers" (/admin/reconciliation?tab=providers) and "Reconciliation"
   * (same path, other tabs) resolve to distinct active items.
   */
  query?: Record<string, string>
  access: AdminAccess
  /** Icon key resolved by AdminNavIcon (text-labelled; never icon-only). */
  icon: string
  testid: string
}

export interface AdminNavGroup {
  /** null → ungrouped (the Overview home link renders without a header). */
  label: string | null
  items: AdminNavItem[]
}

/*
 * The IA. Items are added here as their routes land across the redesign PRs;
 * this reflects the shipped set. New Policies pages / Providers / System info /
 * Roles & terms are appended in their respective PRs.
 */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: null,
    items: [
      { label: 'Overview', to: '/admin', match: '/admin', exact: true, access: 'admin', icon: 'home', testid: 'overview' },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Teammates', to: '/admin/users', access: 'admin', icon: 'people', testid: 'teammates' },
      { label: 'Connections', to: '/admin/grants', access: 'admin', icon: 'link', testid: 'connections' },
      { label: 'Devices', to: '/admin/instances', access: 'admin', icon: 'device', testid: 'devices' },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Regions', to: '/admin/regions', access: 'admin', icon: 'globe', testid: 'regions' },
      { label: 'Projects', to: '/admin/projects', access: 'admin', icon: 'folder', testid: 'projects' },
      { label: 'Project requests', to: '/admin/project-requests', access: 'admin', icon: 'folder', testid: 'project-requests' },
      // Platform only: a PMO grant reaches every region (spec A3).
      { label: 'Project managers', to: '/admin/project-managers', access: 'platform', icon: 'people', testid: 'project-managers' },
      { label: 'Region rules', to: '/admin/department-map', access: 'org-wide', icon: 'tree', testid: 'region-rules' },
      { label: 'Org setup', to: '/admin/org-setup', access: 'platform', icon: 'tree', testid: 'org-setup' },
      { label: 'Placement check', to: '/admin/placement-check', access: 'platform', icon: 'scale', testid: 'placement-check' },
      { label: 'Activity tags', to: '/admin/activity-tags', access: 'admin', icon: 'tag', testid: 'activity-tags' },
    ],
  },
  {
    label: 'Data sources',
    items: [
      { label: 'Providers', to: '/admin/reconciliation?tab=providers', match: '/admin/reconciliation', query: { tab: 'providers' }, access: 'admin', icon: 'providers', testid: 'providers' },
      { label: 'Reconciliation', to: '/admin/reconciliation', access: 'admin', icon: 'scale', testid: 'reconciliation' },
    ],
  },
  {
    label: 'Policies',
    items: [
      { label: 'Report access', to: '/admin/policies/report-access', access: 'org-wide', icon: 'sliders', testid: 'report-access' },
      { label: 'Detection thresholds', to: '/admin/policies/detection-thresholds', access: 'admin', icon: 'pulse', testid: 'detection-thresholds' },
      { label: 'Project lifecycle', to: '/admin/policies/project-lifecycle', access: 'admin', icon: 'folder', testid: 'project-lifecycle' },
      { label: 'Directory exclusions', to: '/admin/policies/directory-exclusions', access: 'admin', icon: 'people', testid: 'directory-exclusions' },
      { label: 'Rate cards', to: '/admin/rate-cards', access: 'admin', icon: 'price', testid: 'rate-cards' },
      { label: 'Provider governance', to: '/admin/policies/provider-governance', access: 'org-wide', icon: 'shield', testid: 'provider-governance' },
      { label: 'Client connection', to: '/admin/policies/client-connection', access: 'platform', icon: 'link', testid: 'client-connection' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Diagnostics', to: '/admin/diagnostics', access: 'admin', icon: 'pulse', testid: 'diagnostics' },
      // Separate from Diagnostics on purpose: Diagnostics OBSERVES whether workers
      // run correctly, this ACTS on which ones should run. A mutating control sat
      // inside the read-only health page, which put a destructive affordance in the
      // path of someone scanning for a fault.
      { label: 'Worker controls', to: '/admin/workers', access: 'admin', icon: 'sliders', testid: 'worker-controls' },
      { label: 'Audit log', to: '/admin/audit', access: 'admin', icon: 'list', testid: 'audit' },
      { label: 'System info', to: '/admin/system', access: 'admin', icon: 'system', testid: 'system' },
    ],
  },
]

/** Flat list of every nav item (order preserved). */
export function allAdminNavItems(): AdminNavItem[] {
  return ADMIN_NAV.flatMap((g) => g.items)
}

/**
 * Does `role` satisfy an item's access level? platform-admin satisfies all;
 * org-wide roles satisfy 'admin' + 'org-wide'; a plain region admin satisfies
 * only 'admin'.
 */
export function roleMeetsAccess(role: string | null | undefined, access: AdminAccess): boolean {
  if (role === 'platform-admin') return true
  if (access === 'platform') return false
  // 'org-wide' is platform-admin ONLY since `global-finops` was retired
  // (2026-09-05) — and platform-admin already returned true above, so nothing
  // else can satisfy it. Kept as an explicit arm rather than folded into the
  // line below: the two levels mean different things and the nav items carry
  // both, so collapsing them would silently widen 'org-wide' to region admins.
  if (access === 'org-wide') return false
  // 'admin' — the region-scoped admin role
  return role === 'admin'
}

/**
 * The active nav item for a path — the item whose `match` is the LONGEST prefix
 * of `path`. Longest-prefix so `/admin/regions/:id` matches `Regions`
 * (`/admin/regions`) rather than `Overview` (`/admin`). Returns null if none.
 */
export function matchAdminNavItem(pathOrFullPath: string): AdminNavItem | null {
  // Everything after the FIRST '?' is the query (a real router fullPath never
  // has a bare second '?', but split-on-first keeps a hand-built string safe).
  const qIdx = pathOrFullPath.indexOf('?')
  const rawPath = qIdx === -1 ? pathOrFullPath : pathOrFullPath.slice(0, qIdx)
  const query = new URLSearchParams(qIdx === -1 ? '' : pathOrFullPath.slice(qIdx + 1))
  const clean = rawPath.replace(/\/+$/, '') || '/'
  let best: AdminNavItem | null = null
  let bestPathLen = -1
  let bestHasQuery = false
  for (const item of allAdminNavItems()) {
    const matchPath = item.match ?? item.to
    const m = (matchPath.split('?')[0] ?? '').replace(/\/+$/, '') || '/'
    const pathMatch = item.exact ? clean === m : clean === m || clean.startsWith(m + '/')
    if (!pathMatch) continue
    if (item.query) {
      const qOk = Object.keys(item.query).every((k) => (query.get(k) ?? '') === item.query![k])
      if (!qOk) continue
    }
    // Rank by (path length, then a satisfied query constraint). Explicit tuple
    // compare — not a scalar fudge — so a real path-length gap always wins and a
    // query constraint only breaks an exact path-length tie (Providers vs
    // Reconciliation, same /admin/reconciliation).
    const hasQuery = !!item.query
    if (m.length > bestPathLen || (m.length === bestPathLen && hasQuery && !bestHasQuery)) {
      best = item
      bestPathLen = m.length
      bestHasQuery = hasQuery
    }
  }
  return best
}

/**
 * The Policies pages `role` can open, in sidebar order. System info lists these
 * as "editable settings live under Policies"; it used to hand-copy the list and
 * fell two pages behind the sidebar (Provider governance, Client connection).
 */
export function policyNavItemsFor(role: string | null | undefined): AdminNavItem[] {
  const group = ADMIN_NAV.find((g) => g.label === 'Policies')
  return (group?.items ?? []).filter((i) => roleMeetsAccess(role, i.access))
}

/** The group containing an item (by identity), or null. */
export function groupForItem(item: AdminNavItem | null): AdminNavGroup | null {
  if (!item) return null
  return ADMIN_NAV.find((g) => g.items.includes(item)) ?? null
}
