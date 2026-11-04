/*
 * Placement-check verdicts (spec P5) and the rule preview diff (P8), over real
 * decidePlacement decisions.
 */
import { describe, it, expect } from 'vitest'
import {
  decidePlacement,
  directoryAttributesOf,
  MAX_CHAIN_HOPS,
  type OwnedUnit,
  type PlacementConfig,
  type PlacementEvidence,
  type RegionRuleSet,
} from '../../../server/reconciliation/region-derivation'
import {
  classifyPlacement,
  overruledRegionRule,
  previewPlacementChanges,
  withProposedRule,
  type CurrentHome,
} from '../../../server/reconciliation/placement-verdict'
import type { WalkEnd } from '../../../shared/placement/placement-check'

const R1 = 'region-1'
const R2 = 'region-2'
const U1 = 'unit-1' // cost-owning, R1
const U1B = 'unit-1b' // cost-owning, R1
const U2 = 'unit-2' // cost-owning, R2
const HOLD1 = 'hold-1' // R1 holding node
const HOLD_GLOBAL = 'hold-global'

const emptyRules = (): RegionRuleSet => ({ exact: new Map(), prefix: [] })

function config(over: Partial<PlacementConfig> = {}): PlacementConfig {
  return { rules: emptyRules(), unitOwnerMap: new Map(), leaderMap: new Map(), maxHops: MAX_CHAIN_HOPS, ...over }
}

function evidence(chainOids: string[], walkEnd: WalkEnd = 'top-of-chart', attrs: Partial<Record<string, string>> = {}): PlacementEvidence {
  const attributes = directoryAttributesOf(null)
  Object.assign(attributes, attrs)
  return { attributes, chain: chainOids.map((oid) => ({ oid, name: oid.toUpperCase(), email: null })), walkEnd }
}

const owners = (entries: Array<[string, OwnedUnit[]]>) => new Map(entries)
const inUnit = (orgUnitId: string, regionId = R1): CurrentHome => ({ regionId, orgUnitId, onHolding: false })
const onHolding = (orgUnitId = HOLD1, regionId = R1): CurrentHome => ({ regionId, orgUnitId, onHolding: true })

function verdict(ev: PlacementEvidence, cfg: PlacementConfig, current: CurrentHome, manual = false) {
  return classifyPlacement({ walkEnd: ev.walkEnd, decision: decidePlacement(ev, cfg), current, manual })
}

const ownerOfU1 = config({ unitOwnerMap: owners([['boss', [{ orgUnitId: U1, regionId: R1 }]]]) })
const leaderOfR1 = config({ leaderMap: new Map([['svp', R1]]) })

describe('classifyPlacement', () => {
  it('ok: the derived unit is the current unit', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U1))).toBe('ok')
  })

  it('move-unit: same region, a different real unit', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U1B))).toBe('move-unit')
  })

  it('place: on the region holding node, a cost-owning unit derived in that region', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, onHolding())).toBe('place')
  })

  it('move-region: derived region differs, for a unit and for a region-only derivation', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U2, R2))).toBe('move-region')
    expect(verdict(evidence(['me', 'svp']), leaderOfR1, onHolding(HOLD_GLOBAL, 'unassigned'))).toBe('move-region')
  })

  it('unit-unverified: region-only derived, same region, person in a real unit', () => {
    expect(verdict(evidence(['me', 'svp']), leaderOfR1, inUnit(U1))).toBe('unit-unverified')
  })

  it('needs-owner: region-only derived, on that region holding node, walk reached the top', () => {
    expect(verdict(evidence(['me', 'mgr', 'svp']), leaderOfR1, onHolding())).toBe('needs-owner')
    const rule = config({ rules: withProposedRule(emptyRules(), { attribute: 'country', matchMode: 'exact', value: 'australia', target: { regionId: R1, orgUnitId: null } }) })
    expect(verdict(evidence(['me'], 'top-of-chart', { country: 'Australia' }), rule, onHolding())).toBe('needs-owner')
  })

  it('needs-owner only on a complete walk: hop-cap and cycle are walk-incomplete', () => {
    expect(verdict(evidence(['me', 'svp'], 'hop-cap'), leaderOfR1, onHolding())).toBe('walk-incomplete')
    expect(verdict(evidence(['me', 'svp'], 'cycle'), leaderOfR1, onHolding())).toBe('walk-incomplete')
    expect(verdict(evidence(['me', 'mgr'], 'hop-cap'), config(), onHolding())).toBe('walk-incomplete')
  })

  it('an incomplete walk still judges a unit rule or a unit owner found below the cut', () => {
    expect(verdict(evidence(['me', 'boss'], 'hop-cap'), ownerOfU1, onHolding())).toBe('place')
    const unitRule = config({ rules: withProposedRule(emptyRules(), { attribute: 'department', matchMode: 'exact', value: 'data', target: { regionId: R1, orgUnitId: U1 } }) })
    expect(verdict(evidence(['me'], 'cycle', { department: 'Data' }), unitRule, inUnit(U1))).toBe('ok')
  })

  it('ambiguous-owner: an owner of 2+ units met and no unit decided', () => {
    const twoUnits: OwnedUnit[] = [{ orgUnitId: U1, regionId: R1 }, { orgUnitId: U1B, regionId: R1 }]
    const before = config({
      unitOwnerMap: owners([['multi', twoUnits], ['boss', [{ orgUnitId: U2, regionId: R2 }]]]),
      leaderMap: new Map([['svp', R1]]),
    })
    expect(verdict(evidence(['me', 'multi', 'svp']), before, onHolding())).toBe('ambiguous-owner')
    expect(verdict(evidence(['me', 'multi']), before, onHolding())).toBe('ambiguous-owner')
    // A usable owner further up decides: the move is classified, the ambiguous owner stays in `why`.
    expect(verdict(evidence(['me', 'multi', 'boss']), before, onHolding())).toBe('move-region')
    expect(verdict(evidence(['me', 'multi', 'boss']), before, inUnit(U2, R2))).toBe('ok')
    expect(decidePlacement(evidence(['me', 'multi', 'boss']), before).ambiguousOwners.map((a) => a.oid)).toEqual(['multi'])
    // Met only above the usable owner: the walk stopped there, so it is not ambiguity.
    expect(verdict(evidence(['me', 'boss', 'multi']), before, inUnit(U2, R2))).toBe('ok')
  })

  it('a unit rule decides regardless of ambiguous owners on the chain', () => {
    const cfg = config({
      unitOwnerMap: owners([['multi', [{ orgUnitId: U1, regionId: R1 }, { orgUnitId: U1B, regionId: R1 }]]]),
      rules: withProposedRule(emptyRules(), { attribute: 'department', matchMode: 'exact', value: 'data', target: { regionId: R1, orgUnitId: U1 } }),
    })
    expect(verdict(evidence(['me', 'multi'], 'top-of-chart', { department: 'Data' }), cfg, onHolding())).toBe('place')
  })

  it('no-signal: complete walk, no leader, no owner, no rule', () => {
    expect(verdict(evidence(['me', 'mgr']), config(), onHolding())).toBe('no-signal')
    expect(verdict(evidence(['me', 'mgr']), config(), inUnit(U1))).toBe('no-signal')
  })

  it('lookup-failed: graph-error and not-in-directory, even when stored attributes match a rule', () => {
    const rule = config({ rules: withProposedRule(emptyRules(), { attribute: 'country', matchMode: 'exact', value: 'australia', target: { regionId: R2, orgUnitId: null } }) })
    expect(verdict(evidence(['me'], 'graph-error', { country: 'Australia' }), rule, onHolding())).toBe('lookup-failed')
    expect(verdict(evidence([], 'not-in-directory'), rule, onHolding())).toBe('lookup-failed')
  })

  it('manual: placed by hand AND the derivation would move them', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U2, R2), true)).toBe('manual')
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U1B), true)).toBe('manual')
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, onHolding(), true)).toBe('manual')
  })

  it('manual is not shown when the derivation agrees or cannot speak', () => {
    expect(verdict(evidence(['me', 'boss']), ownerOfU1, inUnit(U1), true)).toBe('ok')
    expect(verdict(evidence(['me', 'svp']), leaderOfR1, inUnit(U1), true)).toBe('unit-unverified')
    expect(verdict(evidence([], 'not-in-directory'), ownerOfU1, inUnit(U1), true)).toBe('lookup-failed')
    expect(verdict(evidence(['me', 'mgr']), config(), inUnit(U1), true)).toBe('no-signal')
  })
})

describe('overruledRegionRule', () => {
  const regionRule = (cfg: PlacementConfig) => ({
    ...cfg,
    rules: withProposedRule(emptyRules(), { attribute: 'country', matchMode: 'exact', value: 'australia', target: { regionId: R2, orgUnitId: null } }),
  })
  const ev = evidence(['me', 'svp'], 'top-of-chart', { country: 'Australia' })
  const of = (cfg: PlacementConfig, e = ev) => overruledRegionRule(e, cfg, decidePlacement(e, cfg))

  it('names a matching region rule the chain region beat', () => {
    expect(of(regionRule(leaderOfR1))).toEqual({ attribute: 'country', value: 'australia' })
  })

  it('names it when a chain unit decided', () => {
    expect(of(regionRule(ownerOfU1), evidence(['me', 'boss'], 'top-of-chart', { country: 'Australia' }))).toEqual({ attribute: 'country', value: 'australia' })
  })

  it('is null when the rule decided, or nothing matched', () => {
    expect(of(regionRule(config()))).toBeNull()
    expect(of(leaderOfR1)).toBeNull()
  })
})

describe('withProposedRule', () => {
  const live = withProposedRule(emptyRules(), {
    attribute: 'officeLocation', matchMode: 'prefix', value: 'au-', target: { regionId: R1, orgUnitId: null },
  })

  it('does not mutate the live rule set', () => {
    const next = withProposedRule(live, { attribute: 'country', matchMode: 'exact', value: 'nz', target: { regionId: R2, orgUnitId: null } })
    expect(live.exact.size).toBe(0)
    expect(next.exact.get('country')?.get('nz')).toEqual({ regionId: R2, orgUnitId: null })
  })

  it('replaces a rule with the same (attribute, value) key, whatever its mode', () => {
    const next = withProposedRule(live, { attribute: 'officeLocation', matchMode: 'exact', value: 'au-', target: { regionId: R2, orgUnitId: null } })
    expect(next.prefix).toHaveLength(0)
    expect(next.exact.get('officeLocation')?.get('au-')).toEqual({ regionId: R2, orgUnitId: null })
  })

  it('keeps prefixes longest-first so the more specific one wins', () => {
    const next = withProposedRule(live, { attribute: 'officeLocation', matchMode: 'prefix', value: 'au-syd', target: { regionId: R2, orgUnitId: null } })
    expect(next.prefix.map((p) => p.value)).toEqual(['au-syd', 'au-'])
  })
})

describe('previewPlacementChanges', () => {
  const rows = [
    { id: 'sydney', evidence: evidence(['sydney', 'mgr'], 'top-of-chart', { officeLocation: 'AU-Sydney' }) },
    { id: 'led', evidence: evidence(['led', 'svp'], 'top-of-chart', { officeLocation: 'AU-Perth' }) },
    { id: 'failed', evidence: evidence(['failed'], 'graph-error', { officeLocation: 'AU-Sydney' }) },
    { id: 'other', evidence: evidence(['other'], 'top-of-chart', { officeLocation: 'US-Atlanta' }) },
  ]
  const live = config({ leaderMap: new Map([['svp', R1]]) })
  const proposed = { ...live, rules: withProposedRule(live.rules, { attribute: 'officeLocation', matchMode: 'prefix', value: 'au-', target: { regionId: R2, orgUnitId: null } }) }

  it('lists only rows whose derived home changes, skipping failed lookups', () => {
    const changes = previewPlacementChanges(rows, live, proposed)
    expect(changes.map((c) => c.row.id)).toEqual(['sydney'])
    expect(changes[0]!.from.regionId).toBeUndefined()
    expect(changes[0]!.to.regionId).toBe(R2)
  })

  it('a chain region leader still beats the proposed region rule (P2), so that row does not change', () => {
    const changes = previewPlacementChanges(rows, live, proposed)
    expect(changes.find((c) => c.row.id === 'led')).toBeUndefined()
  })

  it('a unit rule changes the unit within the same region', () => {
    const regionRule = { ...live, rules: withProposedRule(live.rules, { attribute: 'officeLocation', matchMode: 'prefix', value: 'au-', target: { regionId: R1, orgUnitId: null } }) }
    const unitRule = { ...live, rules: withProposedRule(live.rules, { attribute: 'officeLocation', matchMode: 'prefix', value: 'au-', target: { regionId: R1, orgUnitId: U1 } }) }
    const changes = previewPlacementChanges(rows, regionRule, unitRule)
    expect(changes.map((c) => [c.row.id, c.to.orgUnitId])).toEqual([['sydney', U1], ['led', U1]])
  })
})
