/*
 * The retirement invariant for `global-finops` (2026-09-05) and `finance`.
 *
 * Both stay in `ROLES` so a historical `teammate.role` row still renders a label
 * instead of a raw enum code — which means the enum ALONE cannot tell you they
 * are dead. These assertions are what makes the retirement true: a stray holder
 * must land on the least-privilege tier and reach nothing, and nobody may mint
 * one.
 *
 * Written because the per-route "global-finops is also rejected 403" cases this
 * replaces asserted the boundary once per endpoint and would still have passed
 * if the role had quietly kept a capability somewhere else.
 */
import { describe, it, expect } from 'vitest'
import {
  ROLES,
  RETIRED_ROLES,
  isRetiredRole,
  isAdminRole,
  isOrgWideRole,
  isReportingRole,
  SELECTABLE_ROLES,
  ROLE_LABELS,
} from '../../../shared/auth/roles'
import { canAssignRole, canModifyHolderOf } from '../../../server/auth/admin-guards'
import { baselineGrants } from '../../../shared/auth/report-visibility'

describe('retired roles hold no capability', () => {
  it('global-finops is retired', () => {
    expect(isRetiredRole('global-finops')).toBe(true)
    expect(RETIRED_ROLES).toContain('global-finops')
  })

  it.each([...RETIRED_ROLES])('%s stays in the enum for historical rows', (role) => {
    expect(ROLES).toContain(role)
    expect(ROLE_LABELS[role]).toMatch(/retired/i)
  })

  it.each([...RETIRED_ROLES])('%s is in NO capability set', (role) => {
    expect(isAdminRole(role)).toBe(false)
    expect(isOrgWideRole(role)).toBe(false)
    expect(isReportingRole(role)).toBe(false)
    expect(SELECTABLE_ROLES).not.toContain(role)
  })

  it.each([...RETIRED_ROLES])('nobody may assign %s — not even platform-admin', (role) => {
    for (const caller of ROLES) expect(canAssignRole(caller, role)).toBe(false)
  })

  it('nobody may assign Region admin (`admin`) — there is one admin role', () => {
    for (const caller of ROLES) expect(canAssignRole(caller, 'admin')).toBe(false)
    expect(SELECTABLE_ROLES).not.toContain('admin')
    expect(ROLE_LABELS.admin).toBe('Region admin (retired)')
    // Still a working admin role for anyone who holds it, until the region-scoping code goes.
    expect(isAdminRole('admin')).toBe(true)
  })

  it('platform-admin is still assignable BY platform-admin only — the retirement did not widen it', () => {
    // This omitted the second argument entirely (`canAssignRole('platform-admin')`).
    // `undefined` is neither retired nor platform-admin, so it fell through the
    // permissive tail and returned true: the assertion proved nothing. `tests/`
    // is outside the typecheck scope, so nothing caught the arity either.
    expect(canAssignRole('platform-admin', 'platform-admin')).toBe(true)
    expect(canAssignRole('admin', 'platform-admin')).toBe(false)
    expect(canAssignRole('manager', 'platform-admin')).toBe(false)
  })

  it.each([...RETIRED_ROLES])(
    'platform-admin CAN still remediate a stray %s holder — the retirement must not strand its own cleanup',
    (role) => {
      /*
       * The role-change route asks in BOTH directions: may the caller grant the
       * NEW role, and may they touch a holder of the CURRENT one. Routing the
       * second through canAssignRole meant a retired current role refused
       * everyone, so migration 0140's own fallback — a human demoting a row the
       * migration missed, raced, or that reappeared — became impossible.
       */
      expect(canModifyHolderOf('platform-admin', role)).toBe(true)
      expect(canAssignRole('platform-admin', role)).toBe(false) // still unmintable
      expect(canModifyHolderOf('admin', role)).toBe(false) // org-wide cleanup only
    },
  )

  it('canModifyHolderOf still protects a platform-admin target from a region admin', () => {
    expect(canModifyHolderOf('admin', 'platform-admin')).toBe(false)
    expect(canModifyHolderOf('platform-admin', 'platform-admin')).toBe(true)
    expect(canModifyHolderOf('admin', 'developer')).toBe(true)
  })

  it.each([...RETIRED_ROLES])('a stray %s holder sees the developer tier, not the whole company', (role) => {
    const grants = baselineGrants(role, false)
    expect(grants.across).toBe(false)
    expect(grants.finance).toBe(false)
    expect(grants.regional).not.toBe('all-regions')
    expect(grants.costCentre).not.toBe('all')
  })
})
