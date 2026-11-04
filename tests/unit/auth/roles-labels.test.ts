/*
 * roles — the canonical role helpers + display labels added for the admin
 * redesign vocabulary layer. Guards the finance-zombie exclusion and the
 * one-source label map (no surface should render a raw enum code).
 */
import { describe, it, expect } from 'vitest'
import {
  ROLES,
  SELECTABLE_ROLES,
  ADMIN_ROLES,
  ORG_WIDE_ROLES,
  isAdminRole,
  isOrgWideRole,
  roleLabel,
  ROLE_LABELS,
} from '../../../shared/auth/roles'

describe('SELECTABLE_ROLES excludes every retired role', () => {
  it('never offers `finance` (retired, never assigned)', () => {
    expect(SELECTABLE_ROLES).not.toContain('finance')
  })
  it('never offers `global-finops` (retired 2026-09-05)', () => {
    expect(SELECTABLE_ROLES).not.toContain('global-finops')
  })
  it('never offers `admin` (Region admin can no longer be granted)', () => {
    expect(SELECTABLE_ROLES).not.toContain('admin')
  })
  it('keeps every other role', () => {
    expect([...SELECTABLE_ROLES].sort()).toEqual(['developer', 'manager', 'platform-admin'])
  })
})

describe('isAdminRole / isOrgWideRole', () => {
  it('admin roles are exactly the two admin-area roles', () => {
    expect([...ADMIN_ROLES]).toEqual(['admin', 'platform-admin'])
    expect(isAdminRole('global-finops')).toBe(false)
    for (const r of ADMIN_ROLES) expect(isAdminRole(r)).toBe(true)
    expect(isAdminRole('developer')).toBe(false)
    expect(isAdminRole('finance')).toBe(false)
    expect(isAdminRole(null)).toBe(false)
  })
  it('org-wide is platform-admin alone since global-finops was retired', () => {
    expect([...ORG_WIDE_ROLES]).toEqual(['platform-admin'])
    expect(isOrgWideRole('global-finops')).toBe(false)
    expect(isOrgWideRole('admin')).toBe(false)
    expect(isOrgWideRole('platform-admin')).toBe(true)
  })
})

describe('roleLabel — canonical display names', () => {
  it('renders the disambiguated admin/finance labels', () => {
    expect(roleLabel('admin')).toBe('Region admin (retired)')
    expect(roleLabel('platform-admin')).toBe('Admin')
    // Both retired members say so, so a historical row never reads as live.
    expect(roleLabel('finance')).toBe('Finance (retired)')
    expect(roleLabel('global-finops')).toBe('Global finance (retired)')
  })
  it('covers every role in the enum', () => {
    for (const r of ROLES) {
      expect(ROLE_LABELS[r]).toBeTruthy()
      expect(roleLabel(r)).not.toBe(r) // never a raw code
    }
  })
  it('falls back gracefully', () => {
    expect(roleLabel(null)).toBe('—')
    expect(roleLabel('mystery')).toBe('mystery')
  })
})
