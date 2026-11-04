/*
 * Roles + demo personas — pilot-shaped.
 *
 * Six enum members, first shaped by the prototype's RoleMenu
 * (docs/archive/ux-pilot/tokenscope-pilot-design/project/src/chrome.jsx; see ROLES below: developer, manager, admin, finance,
 * global-finops, platform-admin). Per docs/archive/build-plans/mvp-lite-epic.md
 * §Epic 3: "4 demo personas → each lands on role-correct page". Three are
 * assignable today: developer, manager and platform-admin ("Admin"). `admin`
 * ("Region admin") can no longer be granted, though a remaining holder keeps
 * region-scoped access. `finance` (never minted) and `global-finops` (retired
 * 2026-09-05) hold no capability and are kept in the enum for historical rows
 * only. See the banner above ADMIN_ROLES.
 *
 * Persona records below are the dev-mode mapping. Real Entra OIDC
 * (Epic 10) replaces dev-login but the role enum stays.
 */

// `platform-admin` is the cross-region super-admin (region-unbounded; passes
// any requireRole and maps to the unbounded scope at the RLS layer). `admin`
// is the per-region admin (region-scoped via requireRegionScope).
// TODO(region-model): relabel `admin` → `region-admin` for clarity once the
// role rename churn is worth it (see docs/build/dogfood-followups.md).
export const ROLES = ['developer', 'manager', 'admin', 'finance', 'global-finops', 'platform-admin'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

/** Cross-region super-admin: satisfies any role gate, unbounded data scope. */
export function isPlatformAdmin(role: string): boolean {
  return role === 'platform-admin'
}

/*
 * RETIRED 2026-09-05 — `global-finops`. It is kept in `ROLES` (like `finance`)
 * so historical `teammate.role` rows still render a label instead of a raw enum
 * code, but it is in NO capability set: not admin, not org-wide, not reporting,
 * not selectable. A stray holder therefore lands on the developer tier —
 * least privilege, the same fail-closed shape `finance` has.
 *
 * DO NOT confuse this with the string 'global-finops' in `server/db/rls.ts`,
 * `server/db/worker-db.ts` and the `app.user_role` GUC predicates. That is a
 * SCOPE VALUE the RLS policies compare against, which `platform-admin` itself
 * maps onto (rls.ts `rlsRoleFor`) and the worker lane runs as. It is a
 * different vocabulary that happens to share a spelling, and removing it would
 * break the worker lane and platform-admin's own data scope.
 */

/** Roles that can reach the admin area at all (region-scoped or wider). */
export const ADMIN_ROLES = ['admin', 'platform-admin'] as const

/** Org-wide (cross-region) roles: unbounded data scope, edit platform defaults. */
export const ORG_WIDE_ROLES = ['platform-admin'] as const

/** True for any role that may enter /admin (Admin, and a remaining Region admin). */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role)
}

/**
 * Roles that exist in the enum for historical rows but may never be ASSIGNED.
 * `finance` was never minted; `global-finops` was retired 2026-09-05. Neither
 * holds a capability, so minting one is always a mistake — and before this list
 * existed, `canAssignRole` waved both through as "not an org-wide grant".
 */
export const RETIRED_ROLES = ['finance', 'global-finops'] as const

/** True for a role that must never be granted to anyone. */
export function isRetiredRole(role: string | null | undefined): boolean {
  return !!role && (RETIRED_ROLES as readonly string[]).includes(role)
}

/** True for the cross-region role (Admin). */
export function isOrgWideRole(role: string | null | undefined): boolean {
  return !!role && (ORG_WIDE_ROLES as readonly string[]).includes(role)
}

/**
 * Roles that reach /reporting on the ROLE axis alone. Excludes `finance` (a
 * retired enum member, see SELECTABLE_ROLES) and `developer`.
 *
 * Reporting visibility is role OR Business-Unit ownership OR an active
 * report-access grant — the other two are RELATIONSHIPS, not roles (J3, mig
 * 0048/0129), so they cannot be answered from this list. `resolveReportingNav`
 * (server/auth/nav-visibility.ts) is the one place all three are combined; the
 * nav renders its verdict and never re-derives it.
 */
export const REPORTING_ROLES = ['manager', 'admin', 'platform-admin'] as const

/** True for a role that reaches /reporting without needing ownership or a grant. */
export function isReportingRole(role: string | null | undefined): boolean {
  return !!role && (REPORTING_ROLES as readonly string[]).includes(role)
}

/**
 * `admin` (Region admin) can no longer be granted: there is one admin role, Admin
 * (`platform-admin`), by owner ruling (docs/design/org-setup/00-spec.md). Existing
 * holders keep its region-scoped access until the region-scoping code is removed.
 */
export const UNGRANTABLE_ROLES = [...RETIRED_ROLES, 'admin'] as const

/** True for a role nobody may be given, retired or not. */
export function isUngrantableRole(role: string | null | undefined): boolean {
  return !!role && (UNGRANTABLE_ROLES as readonly string[]).includes(role)
}

/** Roles offered in role-assignment dropdowns: never an ungrantable one. */
export const SELECTABLE_ROLES: readonly Role[] = ROLES.filter((r) => !isUngrantableRole(r))

/**
 * Canonical human-facing role labels — ONE source so no surface renders a raw
 * enum code. `platform-admin` is the one admin role, "Admin". `admin` (Region
 * admin), `finance` and `global-finops` can no longer be granted and say so, so a
 * historical row still reads as a name rather than a raw code.
 */
export const ROLE_LABELS: Record<Role, string> = {
  developer: 'Developer',
  manager: 'Manager',
  admin: 'Region admin (retired)',
  finance: 'Finance (retired)',
  'global-finops': 'Global finance (retired)',
  'platform-admin': 'Admin',
}

/** Display label for a role value; falls back to the raw value if unknown. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return (ROLE_LABELS as Record<string, string>)[role] ?? role
}

export const DEMO_PERSONAS = [
  {
    key: 'developer',
    role: 'developer' as Role,
    email: 'demo-priya.iyer@example.com',
    displayName: 'Priya Iyer (demo)',
    landing: '/',
  },
  {
    key: 'manager',
    role: 'manager' as Role,
    email: 'demo-anil.verma@example.com',
    displayName: 'Anil Verma (demo)',
    landing: '/reporting?scope=region',
  },
  {
    key: 'admin',
    role: 'admin' as Role,
    email: 'demo-lena.park@example.com',
    displayName: 'Lena Park (demo)',
    landing: '/admin',
  },
  /*
   * MUST stay `developer`. The finance lens is a `report_access_grant` (mig
   * 0129), never a role — giving this persona an admin role to make its landing
   * page resolve turns a finance view into an org-wide super-admin.
   * See docs/security-sprint/epic-mdash-remediation.md §Wave 4.
   */
  {
    key: 'finance',
    role: 'developer' as Role,
    email: 'demo-mara.holloway@example.com',
    displayName: 'Mara Holloway (demo)',
    landing: '/reporting?scope=finance',
  },
  // CC owner (J1, mig 0048): org role is plain developer — the P&L
  // visibility flows from cou_owner relationship rows, not the role enum.
  {
    key: 'cc-owner',
    role: 'developer' as Role,
    email: 'demo-owen.cole@example.com',
    displayName: 'Owen Cole (demo)',
    landing: '/reporting?scope=cost-centre',
  },
] as const

export type PersonaKey = (typeof DEMO_PERSONAS)[number]['key']

export function getPersona(key: string) {
  return DEMO_PERSONAS.find((p) => p.key === key)
}
