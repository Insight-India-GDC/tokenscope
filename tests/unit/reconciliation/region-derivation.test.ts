/*
 * Placement derivation core — manager-chain walk to a UNIT (cou_owner) or REGION
 * (region_leader). Carries the AEUF cases (hop cap, cycle, cache back-propagation,
 * department-first for region) and adds the unit-placement invariants: unit ALWAYS wins
 * over a nearer region, multi-unit owner is ambiguous, owned-unit is the target.
 */
import { describe, it, expect } from 'vitest'
import {
  mapAttributesToRegion,
  resolvePlacementViaManagerChain,
  resolvesToSingleUnit,
  derivePlacement,
  decidePlacement,
  gatherPlacementEvidence,
  makeChainCaches,
  MAX_CHAIN_HOPS,
  type PlacementDecision,
  type GetManager,
  type ManagerEdge,
  type OwnedUnit,
  type RegionRuleSet,
} from '../../../server/reconciliation/region-derivation'
import { normalizeMatchValue, type RegionAttributeKey } from '../../../shared/placement/region-attributes'
import type { DirectoryUser } from '../../../server/azure/directory'

/** Build a RegionRuleSet from [attribute, value, regionId, mode?, orgUnitId?] tuples.
 *  A 5th element makes it a UNIT rule (mig 0112); omitted = the region-only shape. */
function ruleset(
  rules: Array<[RegionAttributeKey, string, string, ('exact' | 'prefix')?, string?]>,
): RegionRuleSet {
  const exact: RegionRuleSet['exact'] = new Map()
  const prefix: RegionRuleSet['prefix'] = []
  for (const [attr, val, rid, mode, orgUnitId] of rules) {
    const v = normalizeMatchValue(val)
    const target = { regionId: rid, orgUnitId: orgUnitId ?? null }
    if (mode === 'prefix') {
      prefix.push({ attribute: attr, value: v, target })
    } else {
      let m = exact.get(attr)
      if (!m) {
        m = new Map()
        exact.set(attr, m)
      }
      m.set(v, target)
    }
  }
  prefix.sort((a, b) => b.value.length - a.value.length)
  return { exact, prefix }
}

function fakeManager(edges: Record<string, ManagerEdge | null>) {
  const calls: string[] = []
  const get: GetManager = async (oid) => {
    calls.push(oid)
    return Object.prototype.hasOwnProperty.call(edges, oid) ? edges[oid]! : null
  }
  return { get, calls }
}
const unit = (orgUnitId: string, regionId = 'rg'): OwnedUnit => ({ orgUnitId, regionId })
const dir = (over: Partial<DirectoryUser> = {}): DirectoryUser => ({
  oid: 'u', email: 'u@x.com', displayName: 'U', mail: null, upn: null,
  department: null, jobTitle: null, companyName: null, country: null,
  officeLocation: null, state: null, costCenter: null, division: null,
  ...over,
})

describe('mapAttributesToRegion', () => {
  it('exact match, case-insensitive + trim; blank/unmapped → null', () => {
    const rules = ruleset([['companyName', 'Insight Australia', 'rg-apac']])
    expect(mapAttributesToRegion(dir({ companyName: ' Insight Australia ' }), rules))
      .toEqual({ regionId: 'rg-apac', orgUnitId: null, attribute: 'companyName', value: 'insight australia', conflict: false })
    expect(mapAttributesToRegion(dir({ companyName: 'Insight USA' }), rules)).toBeNull()
    expect(mapAttributesToRegion(dir({ companyName: null }), rules)).toBeNull()
  })
  it('prefix match — a country/state prefix maps a whole office group', () => {
    const rules = ruleset([['officeLocation', 'au-', 'rg-apac', 'prefix']])
    expect(mapAttributesToRegion(dir({ officeLocation: 'AU-Brisbane' }), rules))
      .toMatchObject({ regionId: 'rg-apac', value: 'au-' })
    expect(mapAttributesToRegion(dir({ officeLocation: 'UK-London' }), rules)).toBeNull()
  })
  it('precedence: higher-precedence attribute wins; divergent lower match flags conflict', () => {
    // companyName (precedence 0) beats department (precedence 4); different regions → conflict.
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac'],
      ['department', 'Services', 'rg-emea'],
    ])
    const m = mapAttributesToRegion(dir({ companyName: 'Insight Australia', department: 'Services' }), rules)
    expect(m).toEqual({ regionId: 'rg-apac', orgUnitId: null, attribute: 'companyName', value: 'insight australia', conflict: true })
  })
  it('a UNIT rule carries its unit target through the match', () => {
    const rules = ruleset([['department', 'Sales-Solution', 'rg-emea', 'exact', 'ou-emea-core']])
    expect(mapAttributesToRegion(dir({ department: 'Sales-Solution' }), rules))
      .toEqual({ regionId: 'rg-emea', orgUnitId: 'ou-emea-core', attribute: 'department', value: 'sales-solution', conflict: false })
  })
  it('conflict compares the COMPLETE TARGET: two rules naming two cost centres in ONE region ARE a conflict', () => {
    // Which cost centre a person's spend charges is the decision this whole
    // feature makes. Comparing regions only reported "no conflict" here, so the
    // broad-catalogue rule quietly won and the narrow one an admin had just
    // written did nothing — with no counter anywhere saying so.
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac', 'exact', 'ou-1'],
      ['department', 'Services', 'rg-apac', 'exact', 'ou-2'],
    ])
    const m = mapAttributesToRegion(dir({ companyName: 'Insight Australia', department: 'Services' }), rules)
    // Highest precedence still WINS the target; the divergence is surfaced, not
    // resolved differently.
    expect(m).toEqual({ regionId: 'rg-apac', orgUnitId: 'ou-1', attribute: 'companyName', value: 'insight australia', conflict: true })
  })

  it('two rules naming the SAME unit are not a conflict', () => {
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac', 'exact', 'ou-1'],
      ['department', 'Services', 'rg-apac', 'exact', 'ou-1'],
    ])
    expect(mapAttributesToRegion(dir({ companyName: 'Insight Australia', department: 'Services' }), rules)?.conflict)
      .toBe(false)
  })

  it('a unit rule and a region-only rule on the same person diverge — one places, the other does not', () => {
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac', 'exact', 'ou-1'],
      ['department', 'Services', 'rg-apac'],
    ])
    expect(mapAttributesToRegion(dir({ companyName: 'Insight Australia', department: 'Services' }), rules)?.conflict)
      .toBe(true)
  })
  it('same region across attributes → no conflict', () => {
    const rules = ruleset([
      ['companyName', 'Insight Australia', 'rg-apac'],
      ['country', 'Australia', 'rg-apac'],
    ])
    expect(mapAttributesToRegion(dir({ companyName: 'Insight Australia', country: 'Australia' }), rules)?.conflict).toBe(false)
  })
})

describe('resolvePlacementViaManagerChain', () => {
  const noUnits = new Map<string, OwnedUnit[]>()
  const noLeaders = new Map<string, string>()

  it('self is a unit owner → unit immediately, no climb', async () => {
    const m = fakeManager({})
    const owners = new Map([['u', [unit('ou-1', 'rg-1')]]])
    const r = await resolvePlacementViaManagerChain('u', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'unit', orgUnitId: 'ou-1', regionId: 'rg-1', ownerOid: 'u' })
    expect(m.calls).toEqual([])
  })

  it('UNIT ALWAYS WINS over a region-leader that is NEARER in the chain', async () => {
    // dev → X (region leader, hop 1) → Katrina (unit owner, hop 2). Must resolve to the UNIT,
    // never short-circuit on the nearer region leader.
    const m = fakeManager({ dev: { oid: 'x', email: null }, x: { oid: 'katrina', email: null }, katrina: { oid: 'top', email: null } })
    const owners = new Map([['katrina', [unit('ou-mp', 'rg-apac')]]])
    const leaders = new Map([['x', 'rg-apac']])
    const r = await resolvePlacementViaManagerChain('dev', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'unit', orgUnitId: 'ou-mp', regionId: 'rg-apac', ownerOid: 'katrina' })
  })

  it('nearest unit wins when two owners are in the chain', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null } })
    const owners = new Map([['b', [unit('ou-near')]], ['c', [unit('ou-far')]]])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toMatchObject({ kind: 'unit', orgUnitId: 'ou-near' })
  })

  it('multi-unit owner is AMBIGUOUS → skipped; climbs to the next unambiguous owner', async () => {
    const m = fakeManager({ a: { oid: 'kat', email: null }, kat: { oid: 'vp', email: null } })
    const owners = new Map([['kat', [unit('ou-mp'), unit('ou-data')]], ['vp', [unit('ou-bu')]]])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toMatchObject({ kind: 'unit', orgUnitId: 'ou-bu' }) // kat skipped (2 units), vp wins
  })

  /*
   * The admin surface (server/api/v1/admin/org-units.get.ts) warns "this owner
   * places nobody" from THIS function, so the warning cannot describe a behaviour
   * the walk does not have. Pinned as an explicit agreement rather than left
   * implicit: these four rows are the walk's own branch condition, and the case
   * above ("multi-unit owner is AMBIGUOUS → skipped") fails alongside them if the
   * predicate changes.
   */
  it('resolvesToSingleUnit IS the walk\'s unit-hit condition — one rule, two readers', () => {
    expect(resolvesToSingleUnit([unit('ou-one')])).toBe(true)
    expect(resolvesToSingleUnit([unit('ou-one'), unit('ou-two')])).toBe(false) // ambiguous
    expect(resolvesToSingleUnit([])).toBe(false)
    expect(resolvesToSingleUnit(undefined)).toBe(false) // not an owner at all
  })

  it('multi-unit owner with no owner above → falls to region', async () => {
    const m = fakeManager({ a: { oid: 'kat', email: null }, kat: { oid: 'vp', email: null } })
    const owners = new Map([['kat', [unit('ou-mp'), unit('ou-data')]]])
    const leaders = new Map([['vp', 'rg-apac']])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-apac', leaderOid: 'vp' })
  })

  it('no owner in chain → region leader (nearest) wins', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null } })
    const leaders = new Map([['b', 'rg-near'], ['c', 'rg-far']])
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-near', leaderOid: 'b' })
  })

  it('hop cap → null', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null }, c: { oid: 'd', email: null } })
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches(), maxHops: 1 })
    expect(r).toBeNull()
  })

  it('cycle → null (no infinite loop)', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'a', email: null } })
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: noLeaders, getManager: m.get, caches: makeChainCaches() })
    expect(r).toBeNull()
  })

  it('back-propagates so a sibling sharing the chain short-circuits (incl. region-below-unit)', async () => {
    // dev → x(region leader) → kat(unit). sib → x. After dev resolves to the unit, x is
    // cached as the UNIT (not region), so sib resolves to the unit with one extra hop.
    const m = fakeManager({ dev: { oid: 'x', email: null }, x: { oid: 'kat', email: null }, kat: { oid: 't', email: null }, sib: { oid: 'x', email: null } })
    const owners = new Map([['kat', [unit('ou-mp')]]])
    const leaders = new Map([['x', 'rg-apac']])
    const caches = makeChainCaches()
    const r1 = await resolvePlacementViaManagerChain('dev', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches })
    expect(r1).toMatchObject({ kind: 'unit', orgUnitId: 'ou-mp' })
    const callsAfter = m.calls.length
    const r2 = await resolvePlacementViaManagerChain('sib', { unitOwnerMap: owners, leaderMap: leaders, getManager: m.get, caches })
    expect(r2).toMatchObject({ kind: 'unit', orgUnitId: 'ou-mp' }) // x cached as unit, not region
    expect(m.calls.length).toBe(callsAfter + 1) // only sib→x
  })

  it('transient (non-404) Graph error PROPAGATES and is NOT cached', async () => {
    let throwOnce = true
    const get: GetManager = async (oid) => {
      if (oid === 'a' && throwOnce) { throwOnce = false; throw new Error('Graph request failed (429) for /users/a/manager.') }
      return ({ a: { oid: 'b', email: null } } as Record<string, ManagerEdge | null>)[oid] ?? null
    }
    const caches = makeChainCaches()
    const leaders = new Map([['b', 'rg-b']])
    await expect(resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: get, caches })).rejects.toThrow(/429/)
    expect(caches.placementCache.has('a')).toBe(false)
    const r = await resolvePlacementViaManagerChain('a', { unitOwnerMap: noUnits, leaderMap: leaders, getManager: get, caches })
    expect(r).toEqual({ kind: 'region', regionId: 'rg-b', leaderOid: 'b' })
  })
})

describe('derivePlacement', () => {
  const rules = ruleset([['department', 'APAC Digital', 'rg-dept']])
  it('chain UNIT wins (department ignored, region ignored)', async () => {
    const m = fakeManager({ u: { oid: 'kat', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map([['kat', [unit('ou-mp', 'rg-x')]]]), leaderMap: new Map([['kat', 'rg-y']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({
      orgUnitId: 'ou-mp', regionId: 'rg-x', ownerOid: 'kat', via: 'unit',
      // The walk ran, so it reports the person's OWN manager for the C9 snapshot.
      manager: { oid: 'kat', email: null },
    })
  })
  it('a UNIT RULE outranks the manager chain — an explicit statement beats an inference', async () => {
    // The chain would place them in ou-chain (kat owns it). The rule names
    // ou-rule, and the rule wins. Nothing walks: the derivation stops at step 0.
    const m = fakeManager({ u: { oid: 'kat', email: null } })
    const unitRules = ruleset([['department', 'APAC Digital', 'rg-x', 'exact', 'ou-rule']])
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules: unitRules,
      unitOwnerMap: new Map([['kat', [unit('ou-chain', 'rg-x')]]]),
      leaderMap: new Map(),
      getManager: m.get,
      caches: makeChainCaches(),
    })
    expect(r).toEqual({
      orgUnitId: 'ou-rule', regionId: 'rg-x', via: 'unit-rule',
      attribute: 'department', conflict: false,
    })
    expect(m.calls).toEqual([]) // no Graph hop was needed to reach the answer
  })
  it('a REGION rule still loses to the chain unit — only a UNIT rule outranks it', async () => {
    const m = fakeManager({ u: { oid: 'kat', email: null } })
    const regionRule = ruleset([['department', 'APAC Digital', 'rg-dept']])
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules: regionRule,
      unitOwnerMap: new Map([['kat', [unit('ou-chain', 'rg-x')]]]),
      leaderMap: new Map(),
      getManager: m.get,
      caches: makeChainCaches(),
    })
    expect(r.via).toBe('unit')
    expect(r.orgUnitId).toBe('ou-chain')
  })
  it('no unit → the chain REGION LEADER outranks a region rule', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['vp', 'rg-chain']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ regionId: 'rg-chain', via: 'manager', manager: { oid: 'vp', email: null } })
  })
  it('a region rule applies when the chain reaches no leader, and reports the walked manager', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['someone-else', 'rg-chain']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({
      regionId: 'rg-dept', via: 'attribute', attribute: 'department', conflict: false,
      manager: { oid: 'vp', email: null },
    })
  })
  it('no owners and no leaders → the region rule answers without a walk', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map(), getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ regionId: 'rg-dept', via: 'attribute', attribute: 'department', conflict: false, manager: undefined })
    expect(m.calls).toEqual([])
  })
  it('leaders but no owners: a Graph error THROWS instead of falling through to the region rule', async () => {
    const get: GetManager = async () => { throw new Error('Graph request failed (503)') }
    await expect(derivePlacement(dir({ department: 'APAC Digital', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['vp', 'rg-chain']]), getManager: get, caches: makeChainCaches(),
    })).rejects.toThrow(/503/)
  })
  it('no unit, no attribute → chain REGION (manager)', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'Services', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map([['vp', 'rg-chain']]),
      getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ regionId: 'rg-chain', via: 'manager', manager: { oid: 'vp', email: null } })
  })
  it('nothing resolves → via null', async () => {
    const m = fakeManager({ u: { oid: 'vp', email: null } })
    const r = await derivePlacement(dir({ department: 'Services', oid: 'u' }), {
      rules, unitOwnerMap: new Map(), leaderMap: new Map(), getManager: m.get, caches: makeChainCaches(),
    })
    // Neither map has entries, so neither walk runs → the manager was never asked for.
    expect(r).toEqual({ via: null, manager: undefined })
  })
  it('no oid → no walk', async () => {
    const m = fakeManager({})
    const r = await derivePlacement(dir({ oid: '' }), {
      rules, unitOwnerMap: new Map([['kat', [unit('ou')]]]), leaderMap: new Map(), getManager: m.get, caches: makeChainCaches(),
    })
    expect(r).toEqual({ via: null, manager: undefined })
    expect(m.calls).toEqual([])
  })
})

describe('gatherPlacementEvidence', () => {
  const walk = (edges: Record<string, ManagerEdge | null>, d: DirectoryUser | null = dir(), maxHops?: number) =>
    gatherPlacementEvidence(d, { getManager: fakeManager(edges).get, managerCache: new Map(), maxHops })

  it('records the person first, then each manager, and how the walk ended', async () => {
    const e = await walk({ u: { oid: 'm', email: 'm@x.com', name: 'M' }, m: null }, dir({ department: 'Ops' }))
    expect(e.chain).toEqual([
      { oid: 'u', name: 'U', email: 'u@x.com' },
      { oid: 'm', name: 'M', email: 'm@x.com' },
    ])
    expect(e.walkEnd).toBe('top-of-chart')
    expect(e.attributes).toMatchObject({ department: 'Ops', companyName: null })
  })
  it('hop cap: the person plus maxHops managers, ended as hop-cap', async () => {
    const e = await walk({ u: { oid: 'a', email: null }, a: { oid: 'b', email: null }, b: { oid: 'c', email: null } }, dir(), 1)
    expect(e.chain.map((l) => l.oid)).toEqual(['u', 'a'])
    expect(e.walkEnd).toBe('hop-cap')
  })
  it('cycle', async () => {
    const e = await walk({ u: { oid: 'a', email: null }, a: { oid: 'u', email: null } })
    expect(e.chain.map((l) => l.oid)).toEqual(['u', 'a'])
    expect(e.walkEnd).toBe('cycle')
  })
  it('a Graph error keeps the links fetched before it', async () => {
    const get: GetManager = async (oid) => {
      if (oid === 'a') throw new Error('Graph request failed (429)')
      return { oid: 'a', email: null }
    }
    const e = await gatherPlacementEvidence(dir(), { getManager: get, managerCache: new Map() })
    expect(e.chain.map((l) => l.oid)).toEqual(['u', 'a'])
    expect(e.walkEnd).toBe('graph-error')
  })
  it('no directory record → not-in-directory, no walk', async () => {
    const e = await walk({}, null)
    expect(e).toMatchObject({ chain: [], walkEnd: 'not-in-directory' })
  })
  it('the default reaches MAX_CHAIN_HOPS managers', async () => {
    const edges: Record<string, ManagerEdge | null> = {}
    for (let i = 0; i < 20; i++) edges[i === 0 ? 'u' : `m${i}`] = { oid: `m${i + 1}`, email: null }
    const e = await walk(edges)
    expect(MAX_CHAIN_HOPS).toBe(12)
    expect(e.chain).toHaveLength(MAX_CHAIN_HOPS + 1)
    expect(e.walkEnd).toBe('hop-cap')
    const live = (leader: string) => resolvePlacementViaManagerChain('u', {
      unitOwnerMap: new Map(), leaderMap: new Map([[leader, 'rg']]), getManager: fakeManager(edges).get, caches: makeChainCaches(),
    })
    expect(await live('m12')).toMatchObject({ regionId: 'rg' })
    expect(await live('m13')).toBeNull()
  })
})

describe('decidePlacement', () => {
  const link = (oid: string) => ({ oid, name: null, email: null })
  const evidence = (oids: string[], attrs: Partial<DirectoryUser> = {}) => ({
    attributes: { companyName: null, country: null, officeLocation: null, state: null, department: null, ...attrs },
    chain: oids.map(link),
    walkEnd: 'top-of-chart' as const,
  })
  const base = { rules: ruleset([]), unitOwnerMap: new Map<string, OwnedUnit[]>(), leaderMap: new Map<string, string>(), maxHops: MAX_CHAIN_HOPS }

  it('precedence: unit rule → chain unit → chain region → region rule', () => {
    const rules = ruleset([['department', 'D', 'rg-rule'], ['companyName', 'UnitCo', 'rg-x', 'exact', 'ou-rule']])
    const cfg = { ...base, rules, unitOwnerMap: new Map([['o', [unit('ou-chain', 'rg-o')]]]), leaderMap: new Map([['l', 'rg-leader']]) }
    expect(decidePlacement(evidence(['u', 'l', 'o'], { companyName: 'UnitCo', department: 'D' }), cfg))
      .toMatchObject({ step: 'unit-rule', orgUnitId: 'ou-rule', rule: { attribute: 'companyName', value: 'unitco' } })
    expect(decidePlacement(evidence(['u', 'l', 'o'], { department: 'D' }), cfg))
      .toMatchObject({ step: 'chain-unit', orgUnitId: 'ou-chain', ownerOid: 'o' })
    expect(decidePlacement(evidence(['u', 'l'], { department: 'D' }), cfg))
      .toEqual({ step: 'chain-region', regionId: 'rg-leader', leaderOid: 'l', ambiguousOwners: [] })
    expect(decidePlacement(evidence(['u'], { department: 'D' }), cfg))
      .toEqual({ step: 'region-rule', regionId: 'rg-rule', rule: { attribute: 'department', value: 'd' }, conflict: false, ambiguousOwners: [] })
    expect(decidePlacement(evidence(['u']), cfg)).toEqual({ step: null, ambiguousOwners: [] })
  })
  it('names the ambiguous owners met before the first usable one, and none after', () => {
    const cfg = { ...base, unitOwnerMap: new Map([
      ['a', [unit('ou-1'), unit('ou-2')]], ['o', [unit('ou-o')]], ['z', [unit('ou-3'), unit('ou-4')]],
    ]) }
    const d = decidePlacement(evidence(['u', 'a', 'o', 'z']), cfg)
    expect(d.step).toBe('chain-unit')
    expect(d.ambiguousOwners).toEqual([{ oid: 'a', units: [unit('ou-1'), unit('ou-2')] }])
  })
  it('a chain longer than maxHops is decided on its first maxHops managers', () => {
    const cfg = { ...base, leaderMap: new Map([['m2', 'rg']]), maxHops: 1 }
    expect(decidePlacement(evidence(['u', 'm1', 'm2']), cfg).step).toBeNull()
  })
})

/*
 * The live derivation walks lazily and decides on the prefix it walked; decidePlacement
 * decides on stored evidence. For every scenario, and for the chain cut at every length
 * (each cut is a chain whose top is there), both must reach the same placement.
 */
describe('decidePlacement agrees with the live derivation', () => {
  const CHAIN = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
  const VIA: Record<string, PlacementDecision['step']> = {
    'unit-rule': 'unit-rule', unit: 'chain-unit', manager: 'chain-region', attribute: 'region-rule',
  }
  const scenarios: Array<{ name: string; owners?: Array<[string, OwnedUnit[]]>; leaders?: Array<[string, string]>; dept?: string }> = [
    { name: 'nothing' },
    { name: 'region rule only', dept: 'R' },
    { name: 'unit rule', dept: 'U', owners: [['p2', [unit('ou-2')]]] },
    { name: 'self owns a unit', owners: [['p0', [unit('ou-0')]]] },
    { name: 'self is a leader, owner above', owners: [['p3', [unit('ou-3')]]], leaders: [['p0', 'rg-0']] },
    { name: 'leader below owner', owners: [['p4', [unit('ou-4')]]], leaders: [['p1', 'rg-1']], dept: 'R' },
    { name: 'leader vs region rule', leaders: [['p2', 'rg-2']], dept: 'R' },
    { name: 'two leaders, nearest wins', leaders: [['p1', 'rg-1'], ['p3', 'rg-3']] },
    { name: 'ambiguous then usable owner', owners: [['p1', [unit('a'), unit('b')]], ['p3', [unit('ou-3')]]] },
    { name: 'ambiguous only, leader above', owners: [['p1', [unit('a'), unit('b')]]], leaders: [['p5', 'rg-5']], dept: 'R' },
    { name: 'two owners, nearest wins', owners: [['p2', [unit('ou-2')]], ['p4', [unit('ou-4')]]] },
  ]
  const rules = ruleset([['department', 'R', 'rg-rule'], ['department', 'U', 'rg-u', 'exact', 'ou-rule']])

  for (const sc of scenarios) {
    for (let len = 1; len <= CHAIN.length; len++) {
      it(`${sc.name} — chain of ${len}`, async () => {
        const edges: Record<string, ManagerEdge | null> = {}
        for (let i = 0; i < len; i++) edges[CHAIN[i]!] = i + 1 < len ? { oid: CHAIN[i + 1]!, email: null } : null
        const cfg = {
          rules,
          unitOwnerMap: new Map(sc.owners ?? []),
          leaderMap: new Map(sc.leaders ?? []),
          maxHops: MAX_CHAIN_HOPS,
        }
        const d = dir({ oid: 'p0', department: sc.dept ?? null })
        const live = await derivePlacement(d, { ...cfg, getManager: fakeManager(edges).get, caches: makeChainCaches() })
        const ev = await gatherPlacementEvidence(d, { getManager: fakeManager(edges).get, managerCache: new Map() })
        const decided = decidePlacement(ev, cfg)
        expect(ev.walkEnd).toBe('top-of-chart')
        expect(decided.step).toBe(live.via === null ? null : VIA[live.via])
        expect(decided.regionId).toBe(live.regionId)
        expect(decided.orgUnitId).toBe(live.orgUnitId)
        expect(decided.ownerOid).toBe(live.ownerOid)
      })
    }
  }
})

describe('placement cache', () => {
  it('a person cached during someone else\'s walk keeps their OWN nearest leader', async () => {
    // a (leader rg-a) → b → c (leader rg-c). b's own answer is rg-c, not a's rg-a.
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null }, c: null, s: { oid: 'b', email: null } })
    const deps = { unitOwnerMap: new Map<string, OwnedUnit[]>(), leaderMap: new Map([['a', 'rg-a'], ['c', 'rg-c']]), getManager: m.get, caches: makeChainCaches() }
    expect(await resolvePlacementViaManagerChain('a', deps)).toMatchObject({ regionId: 'rg-a' })
    expect(await resolvePlacementViaManagerChain('s', deps)).toMatchObject({ regionId: 'rg-c' })
  })
  it('a nearer leader below a cached region answer still wins', async () => {
    // b's cached answer is rg-c; s → x (leader rg-x) → b must answer rg-x.
    const m = fakeManager({ b: { oid: 'c', email: null }, c: null, s: { oid: 'x', email: null }, x: { oid: 'b', email: null } })
    const deps = { unitOwnerMap: new Map<string, OwnedUnit[]>(), leaderMap: new Map([['c', 'rg-c'], ['x', 'rg-x']]), getManager: m.get, caches: makeChainCaches() }
    await resolvePlacementViaManagerChain('b', deps)
    expect(await resolvePlacementViaManagerChain('s', deps)).toMatchObject({ regionId: 'rg-x' })
  })
  it('a hop-capped walk does not cache the people above its start', async () => {
    const m = fakeManager({ a: { oid: 'b', email: null }, b: { oid: 'c', email: null }, c: null })
    const caches = makeChainCaches()
    await resolvePlacementViaManagerChain('a', { unitOwnerMap: new Map(), leaderMap: new Map([['c', 'rg-c']]), getManager: m.get, caches, maxHops: 1 })
    expect(caches.placementCache.has('a')).toBe(true)
    expect(caches.placementCache.has('b')).toBe(false)
  })
})
