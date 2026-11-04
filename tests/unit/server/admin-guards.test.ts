// @vitest-environment node
/*
 * admin-guards — pure decision unit tests.
 *
 * Mirrors the pattern in tests/integration/auth/persona-override.test.ts
 * §"pure-gate decisions": the function is total + DB-free, so we can
 * exhaust the matrix of (caller, target, newRole) without booting Nitro
 * or a testcontainer.
 */
import { describe, it, expect, vi } from 'vitest'
import { evaluateRoleChange, evaluateRevokeSessions } from '../../../server/auth/admin-guards'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

// The network probe itself (real DNS/TCP) is exercised elsewhere — mocked
// here so this stays a fast, DB-free RBAC-boundary check, matching the rest
// of this file's philosophy.
vi.mock('../../../server/azure/network-check', () => ({
  runNetworkCheck: vi.fn().mockResolvedValue({
    generatedNote: 'x',
    vnetHint: 'x',
    summary: { total: 0, ok: 0, dnsOnly: 0, zoneNotLinked: 0, unreachable: 0, dnsFail: 0 },
    records: [],
    itReport: 'x',
  }),
}))

const CALLER_ADMIN = { role: 'admin' as const, teammateId: 'admin-1' }
const CALLER_FINOPS = { role: 'platform-admin' as const, teammateId: 'finops-1' }
const TARGET = (id: string, role: 'admin' | 'developer' | 'manager' | 'finance' | 'platform-admin' = 'developer') => ({ id, role })

describe('evaluateRoleChange — pure verdicts', () => {
  it('admin promoting a developer to manager → allowed', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'developer'), 'manager')
    expect(v).toEqual({ allowed: true })
  })

  it('the verdict does not refuse granting admin itself (canAssignRole does, at the route)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'developer'), 'admin')
    expect(v).toEqual({ allowed: true })
  })

  it('admin demoting another admin → allowed', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'admin'), 'developer')
    expect(v).toEqual({ allowed: true })
  })

  it('admin demoting themselves → refused 400 self-demote-blocked', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'developer')
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('admin "demoting" themselves to admin (no-op) → refused 400 same-role-noop (self check only fires on a genuine role-change)', () => {
    // R1 F3: self-role-change predicate is `caller.id === target.id &&
    // caller.role !== newRole`. If newRole equals caller.role the
    // predicate is false and we fall through to same-role-noop.
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'admin')
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('same-role-noop')
    }
  })

  it('platform-admin self-demote IS blocked (R1 F3 — both privileged roles get self-protection)', () => {
    // Earlier scope blocked only admin self-demote; that left global-
    // finops with the same lock-out vector. The brief was "Both checks
    // (Recommended)" — interpret strictly: any self-role-change by a
    // privileged caller is refused; a peer must perform it.
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('finops-1', 'platform-admin'), 'developer')
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('admin self-promoting (admin → platform-admin) is also blocked — same-id changes require a peer', () => {
    // R1 F3: self-promote is a privilege-escalation foot-gun. A peer
    // mutator should grant it, not the caller themselves.
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'platform-admin')
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('changing target to its current role → refused 400 same-role-noop', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'manager'), 'manager')
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('same-role-noop')
    }
  })

  it('demoting the last Region admin (different teammate) → allowed: the role is no longer grantable, so there is no "promote another first"', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'admin'), 'developer')
    expect(v).toEqual({ allowed: true })
  })

  it('a platform-admin demoting another platform-admin → allowed (the caller remains; self-change is the refused case)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'platform-admin'), 'developer')
    expect(v).toEqual({ allowed: true })
  })

  // Anchor: see Wave-VII brief Item A — auto-revoke is a CONSEQUENCE of
  // every allowed role change, not a separate verdict. The role-change
  // verdict matrix is unchanged; the handler appends the revocation
  // inside the same tx. These cases re-assert the unchanged shape so a
  // regression that erroneously starts blocking allowed mutations (e.g.
  // a future "don't revoke admins" rule) trips here.
  it('Wave-VII: an allowed role change verdict is unchanged (auto-revoke is a handler concern, not a verdict mode)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'developer'), 'manager')
    expect(v).toEqual({ allowed: true })
  })

  it('verdict refusals always carry both status + reason (RFC-9457 envelope shape)', () => {
    const refusals = [
      evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'developer'),
      evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'manager'), 'manager'),
      evaluateRoleChange(CALLER_FINOPS, TARGET('finops-1', 'platform-admin'), 'manager'),
    ]
    for (const v of refusals) {
      expect(v.allowed).toBe(false)
      if (!v.allowed) {
        expect(v.status).toBeGreaterThanOrEqual(400)
        expect(v.status).toBeLessThan(500)
        expect(typeof v.reason).toBe('string')
        expect(v.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── evaluateRevokeSessions (Wave VII) ─────────────────────────────────
//
// Pure decision for POST /api/v1/admin/users/:id/revoke-sessions. Per
// brief Item B: no last-admin-protection (revocation doesn't change
// role); self-revoke IS allowed. The one refusal is a region admin acting
// on a higher-role holder.
describe('evaluateRevokeSessions — pure verdicts (Wave VII)', () => {
  const TARGET_R = (
    id: string,
    regionId = 'region-a',
    role: 'admin' | 'developer' | 'platform-admin' = 'admin',
  ) => ({ id, regionId, role })

  it('admin revoking a platform-admin → 403 holder-outranks-caller', () => {
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('pa-1', 'region-a', 'platform-admin'))
    expect(v).toEqual({ allowed: false, status: 403, reason: 'holder-outranks-caller' })
  })

  it('platform-admin revoking another platform-admin → allowed', () => {
    const v = evaluateRevokeSessions(CALLER_FINOPS, TARGET_R('pa-1', 'region-a', 'platform-admin'))
    expect(v).toEqual({ allowed: true })
  })

  it('admin revoking a peer in the same region → allowed', () => {
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('tm-2', 'region-a', 'developer'))
    expect(v).toEqual({ allowed: true })
  })

  it('platform-admin revoking any teammate → allowed', () => {
    const v = evaluateRevokeSessions(CALLER_FINOPS, TARGET_R('tm-2', 'region-b'))
    expect(v).toEqual({ allowed: true })
  })

  it('admin revoking the sole admin in their region → allowed (revocation does NOT change role)', () => {
    // R1-style anti-regression: the role-change "last-admin-protected"
    // gate must NOT bleed into revoke-sessions. The revoked user can
    // sign back in; the role column is untouched.
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('only-admin'))
    expect(v).toEqual({ allowed: true })
  })

  it('admin revoking themselves → allowed (legitimate "force sign-out from another device")', () => {
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('admin-1'))
    expect(v).toEqual({ allowed: true })
  })

  it('platform-admin revoking themselves → allowed (mirror of admin self-revoke)', () => {
    const v = evaluateRevokeSessions(CALLER_FINOPS, TARGET_R('finops-1', 'region-a', 'platform-admin'))
    expect(v).toEqual({ allowed: true })
  })
})

// ── GET /api/v1/admin/diagnostics/network — tier matrix ────────────────────
//
// This route used to accept admin/platform-admin; it now matches
// otel-logs.get.ts's platform-admin-only tier (it exposes the same class of
// infrastructure-topology detail: private IPs, internal host:port pairs).
// injectTestSession is DB-free (it pre-populates tryAuth's per-event cache
// directly — see tests/helpers/auth.ts), so this exercises the REAL
// requireRole gate without a testcontainer.
function fakeEvent(session: Session) {
  const event = { context: {} } as Parameters<typeof injectTestSession>[0]
  injectTestSession(event, session)
  return event
}

const REGION_ID = '00000000-0000-0000-0000-0000000000aa'
const platformAdminSession = (): Session =>
  ({ teammateId: 'pa-1', email: 'pa@x.test', displayName: 'PA', role: 'platform-admin', regionId: REGION_ID, orgPath: 'x' }) as Session
const adminSession = (): Session =>
  ({ teammateId: 'ad-1', email: 'ad@x.test', displayName: 'Admin', role: 'admin', regionId: REGION_ID, orgPath: 'x' }) as Session

describe('GET /api/v1/admin/diagnostics/network — tier matrix', () => {
  it('a region-scoped admin is REJECTED (403) — network topology is platform-admin only now', async () => {
    const handler = (await import('../../../server/api/v1/admin/diagnostics/network.get')).default
    await expect(handler(fakeEvent(adminSession()) as never)).rejects.toMatchObject({ statusCode: 403 })
  })


  it('platform-admin is allowed (200-shaped response)', async () => {
    const handler = (await import('../../../server/api/v1/admin/diagnostics/network.get')).default
    const res = (await handler(fakeEvent(platformAdminSession()) as never)) as { records: unknown[] }
    expect(res.records).toEqual([])
  })
})
