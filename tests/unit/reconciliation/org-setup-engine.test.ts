/*
 * The Org setup engine (docs/design/org-setup/00-spec.md): the tree, the proposed
 * config preview and the decision cards, over real decidePlacement decisions.
 */
import { describe, it, expect } from 'vitest'
import {
  directoryAttributesOf,
  MAX_CHAIN_HOPS,
  type OwnedUnit,
  type PlacementConfig,
  type RegionRuleSet,
} from '../../../server/reconciliation/region-derivation'
import { buildOrgTree, regionCoverage, type OrgSetupRow } from '../../../server/reconciliation/org-setup-tree'
import { previewOrgSetup, withProposedChanges, EMPTY_PROPOSAL } from '../../../server/reconciliation/org-setup-preview'
import { buildOrgSetupDecisions, dismissalKey } from '../../../server/reconciliation/org-setup-decisions'
import type { Names } from '../../../server/reconciliation/placement-check-read'
import type { WalkEnd } from '../../../shared/placement/placement-check'
import type { ProposedChanges } from '../../../shared/org-setup/contract'

const R1 = 'region-1'
const R2 = 'region-2'
const U1 = 'unit-1' // owned by ownerx, R1
const U2 = 'unit-2' // R2, a unit-rule target
const HOLD1 = 'hold-1'
const HOLD2 = 'hold-2'
const DEF1 = 'default-1'

const names: Names = {
  region: new Map([[R1, 'APAC'], [R2, 'EMEA']]),
  unit: new Map([[U1, 'Cloud & Data'], [U2, 'Finance'], [HOLD1, 'Unplaced'], [HOLD2, 'Unplaced'], [DEF1, 'APAC (default)']]),
}

const emptyRules = (): RegionRuleSet => ({ exact: new Map(), prefix: [] })

function config(over: Partial<PlacementConfig> = {}): PlacementConfig {
  return {
    rules: emptyRules(),
    unitOwnerMap: new Map<string, OwnedUnit[]>([['ownerx', [{ orgUnitId: U1, regionId: R1 }]]]),
    leaderMap: new Map(),
    maxHops: MAX_CHAIN_HOPS,
    ...over,
  }
}

function row(
  chain: string[],
  home: { regionId?: string; orgUnitId?: string; onHolding?: boolean } = {},
  opts: { walkEnd?: WalkEnd; department?: string; spend?: number; manual?: boolean } = {},
): OrgSetupRow {
  const attributes = directoryAttributesOf(null)
  if (opts.department) attributes.department = opts.department
  return {
    teammateId: `tm-${chain[0]}`,
    name: chain[0]!.toUpperCase(),
    email: `${chain[0]}@x.test`,
    regionId: home.regionId ?? R1,
    orgUnitId: home.orgUnitId ?? HOLD1,
    onHolding: home.onHolding ?? (home.orgUnitId === undefined || home.orgUnitId.startsWith('hold')),
    manual: opts.manual ?? false,
    spend30d: opts.spend ?? 1,
    evidence: {
      attributes,
      chain: chain.map((oid) => ({ oid, name: oid === 'apac' ? 'Grace Liu' : oid.toUpperCase(), email: `${oid}@x.test` })),
      walkEnd: opts.walkEnd ?? 'top-of-chart',
    },
  }
}

/*
 * ceo
 * ├─ apac (not a user)
 * │   ├─ mgra (user, department "Cloud") → a1, a2, a3      all on R1 Unplaced
 * │   └─ ownerx (user, owns U1)          → x1, x2          in U1
 * └─ emea (not a user) → e1                                on R1 Unplaced
 * o1 → other (outside the top)
 */
function org(): OrgSetupRow[] {
  return [
    row(['mgra', 'apac', 'ceo'], {}, { department: 'Cloud', spend: 10 }),
    row(['a1', 'mgra', 'apac', 'ceo']),
    row(['a2', 'mgra', 'apac', 'ceo']),
    row(['a3', 'mgra', 'apac', 'ceo']),
    row(['ownerx', 'apac', 'ceo'], { orgUnitId: U1 }),
    row(['x1', 'ownerx', 'apac', 'ceo'], { orgUnitId: U1 }),
    row(['x2', 'ownerx', 'apac', 'ceo'], { orgUnitId: U1 }),
    row(['e1', 'emea', 'ceo'], { regionId: R2, orgUnitId: HOLD2 }),
    row(['o1', 'other'], { regionId: R2, orgUnitId: HOLD2 }),
  ]
}

const TOP = { oid: 'ceo', name: 'CEO', email: 'ceo@x.test' }

describe('buildOrgTree', () => {
  it('roots the stored chains at the top: parents, users, regions, spend, leader, owner and deciding step', () => {
    const cfg = config({ leaderMap: new Map([['emea', R2]]) })
    const tree = buildOrgTree(org(), cfg, names, TOP)
    expect(tree.nodes.map((n) => n.oid)).toEqual(['ceo', 'apac', 'mgra', 'a1', 'a2', 'a3', 'ownerx', 'x1', 'x2', 'emea', 'e1'])
    const by = new Map(tree.nodes.map((n) => [n.oid, n]))
    expect(by.get('ceo')).toMatchObject({ parentOid: null, users: 8, regionCounts: { [R1]: 7, [R2]: 1 }, name: 'CEO' })
    expect(by.get('apac')).toMatchObject({ parentOid: 'ceo', users: 7, department: null, name: 'Grace Liu' })
    expect(by.get('mgra')).toMatchObject({ parentOid: 'apac', users: 4, department: 'Cloud', spend30d: 13 })
    expect(by.get('emea')!.leaderOf).toEqual({ regionId: R2, regionName: 'EMEA' })
    expect(by.get('ownerx')!.owns).toEqual([{ orgUnitId: U1, name: 'Cloud & Data', regionId: R1 }])
    expect(by.get('apac')!.decidedBy).toEqual({ none: 4, 'chain-unit': 3 })
    expect(by.get('ceo')!.decidedBy).toEqual({ none: 4, 'chain-unit': 3, 'chain-region': 1 })
    expect(tree.outsideTop).toBe(1)
  })

  it('leaves out unusable evidence and has no nodes without a top', () => {
    const rows = [...org(), row(['f1', 'mgra', 'apac', 'ceo'], {}, { walkEnd: 'graph-error' })]
    expect(buildOrgTree(rows, config(), names, TOP).nodes.find((n) => n.oid === 'mgra')!.users).toBe(4)
    expect(buildOrgTree(rows, config(), names, null)).toMatchObject({ nodes: [], outsideTop: 0 })
  })

  it('keeps the top when nobody reaches it', () => {
    const tree = buildOrgTree([row(['o1', 'other'])], config(), names, TOP)
    expect(tree.nodes).toEqual([expect.objectContaining({ oid: 'ceo', users: 0, parentOid: null })])
    expect(tree.outsideTop).toBe(1)
  })
})

describe('regionCoverage', () => {
  it('counts current homes, not chains: a failed lookup and an outsider count where they are; leaders come from their rows', () => {
    const rows = [...org(), row(['f1', 'mgra', 'apac', 'ceo'], { regionId: R2, orgUnitId: U2 }, { walkEnd: 'graph-error' })]
    const regions = [{ id: R1, name: 'APAC' }, { id: R2, name: 'EMEA' }, { id: 'region-3', name: 'Americas' }]
    const leaders = [
      { leaderId: 'rl-2', regionId: R2, oid: 'zed', name: 'Zed', email: 'zed@x.test' },
      { leaderId: 'rl-1', regionId: R2, oid: 'emea', name: null, email: 'emea@x.test' },
      { leaderId: 'rl-9', regionId: 'region-9', oid: 'gone', name: 'Gone', email: null },
    ]
    expect(regionCoverage(rows, regions, leaders)).toEqual([
      { id: R1, name: 'APAC', users: 7, inUnit: 3, leaders: [] },
      {
        id: R2, name: 'EMEA', users: 3, inUnit: 1,
        leaders: [
          { leaderId: 'rl-1', oid: 'emea', name: null, email: 'emea@x.test' },
          { leaderId: 'rl-2', oid: 'zed', name: 'Zed', email: 'zed@x.test' },
        ],
      },
      { id: 'region-3', name: 'Americas', users: 0, inUnit: 0, leaders: [] },
    ])
  })
})

const propose = (p: Partial<ProposedChanges>): ProposedChanges => ({ ...EMPTY_PROPOSAL, ...p })

describe('previewOrgSetup', () => {
  it('a new leader moves the region of their branch; an existing owner below them still wins', () => {
    const res = previewOrgSetup(org(), config(), propose({ leaders: [{ oid: 'apac', regionId: R2 }] }), names)
    expect(res.byNode.apac).toMatchObject({ regionChanges: 4, unitChanges: 4 })
    expect(res.byNode.mgra).toMatchObject({ regionChanges: 4 })
    expect(res.byNode.ownerx).toMatchObject({ regionChanges: 0, unitChanges: 0 })
    expect(res.groups).toEqual([
      {
        from: { regionId: R1, regionName: 'APAC', orgUnitId: HOLD1, orgUnitName: 'Unplaced' },
        to: { regionId: R2, regionName: 'EMEA', orgUnitId: null, orgUnitName: null },
        verdict: 'move-region',
        count: 4,
        spend30d: 13,
      },
    ])
  })

  it('a new unit takes its owner\'s branch, and a nested new unit takes its own sub-branch', () => {
    const res = previewOrgSetup(
      org(),
      config({ leaderMap: new Map([['apac', R1]]) }),
      propose({
        newUnits: [
          { key: 'new-apac', ownerOid: 'apac', regionId: R1, name: 'APAC Services' },
          { key: 'new-mgra', ownerOid: 'mgra', regionId: R1, name: 'Cloud' },
        ],
      }),
      names,
    )
    expect(res.groups.map((g) => [g.to.orgUnitName, g.verdict, g.count])).toEqual([['Cloud', 'place', 4]])
    expect(res.byNode.ownerx!.unitChanges).toBe(0) // the existing owner below apac keeps their branch

    const withEmea = previewOrgSetup(
      org(),
      config(),
      propose({ newUnits: [{ key: 'new-emea', ownerOid: 'emea', regionId: R2, name: 'EMEA Services' }] }),
      names,
    )
    expect(withEmea.groups).toEqual([
      expect.objectContaining({ to: expect.objectContaining({ orgUnitId: 'new-emea', orgUnitName: 'EMEA Services' }), verdict: 'place', count: 1 }),
    ])
  })

  it('a leader who owns a unit keeps their branch in their unit', () => {
    const res = previewOrgSetup(org(), config(), propose({ leaders: [{ oid: 'ownerx', regionId: R2 }] }), names)
    expect(res.byNode.ownerx).toMatchObject({ regionChanges: 0, unitChanges: 0, groups: [] })
    expect(res.groups).toEqual([])
  })

  it('a unit rule still wins over a new leader', () => {
    const rules: RegionRuleSet = {
      exact: new Map([['department', new Map([['finance', { regionId: R2, orgUnitId: U2 }]])]]),
      prefix: [],
    }
    const rows = [row(['f1', 'mgra', 'apac', 'ceo'], { regionId: R2, orgUnitId: U2 }, { department: 'Finance' })]
    const res = previewOrgSetup(rows, config({ rules }), propose({ leaders: [{ oid: 'apac', regionId: R1 }] }), names)
    expect(res.groups).toEqual([])
    expect(res.byNode.apac).toMatchObject({ regionChanges: 0, unitChanges: 0 })
  })

  it('removing a leader stops their branch moving; manual and not-moved people are not counted as moves', () => {
    const cfg = config({ leaderMap: new Map([['apac', R2]]) })
    // An empty proposal changes nobody's derived home: the 4 waiting are in groups, not byNode.
    const unchanged = previewOrgSetup(org(), cfg, EMPTY_PROPOSAL, names)
    expect(unchanged.groups.map((g) => g.count)).toEqual([4])
    expect(unchanged.byNode.apac!.regionChanges).toBe(0)
    const removed = previewOrgSetup(org(), cfg, propose({ leaders: [{ oid: 'apac', regionId: null }] }), names)
    expect(removed.groups).toEqual([])
    expect(removed.byNode.apac!.regionChanges).toBe(0)

    const rows = [
      row(['m1', 'mgra', 'apac', 'ceo'], {}, { manual: true }),
      row(['f1', 'mgra', 'apac', 'ceo'], {}, { walkEnd: 'graph-error' }),
      row(['h1', 'mgra', 'apac'], {}, { walkEnd: 'hop-cap' }),
    ]
    const res = previewOrgSetup(rows, cfg, EMPTY_PROPOSAL, names)
    expect(res.manual).toEqual([{ teammateId: 'tm-m1', name: 'M1', email: 'm1@x.test', from: 'APAC / Unplaced', to: 'EMEA / Unplaced' }])
    expect(res.notMoved).toEqual({ 'lookup-failed': 1, 'walk-incomplete': 1 })
    expect(res.groups).toEqual([])
    expect(res.byNode.apac!.regionChanges).toBe(0)
  })

  it('byNode is the proposal\'s own delta: a move already waiting stays out of an unrelated proposal and in one that changes it', () => {
    // apac already leads EMEA, so mgra's branch (4) is waiting to move region today.
    const cfg = config({ leaderMap: new Map([['apac', R2]]) })
    const unrelated = previewOrgSetup(org(), cfg, propose({ leaders: [{ oid: 'emea', regionId: R1 }] }), names)
    expect(unrelated.groups.map((g) => [g.verdict, g.count])).toEqual([['move-region', 4], ['move-region', 1]])
    expect(unrelated.byNode.apac).toEqual({ regionChanges: 0, unitChanges: 0, groups: [] })
    expect(unrelated.byNode.mgra).toEqual({ regionChanges: 0, unitChanges: 0, groups: [] })
    expect(unrelated.byNode.emea).toMatchObject({ regionChanges: 1, unitChanges: 1 })
    expect(unrelated.byNode.ceo).toMatchObject({ regionChanges: 1, unitChanges: 1 })

    const touching = previewOrgSetup(org(), cfg, propose({ newUnits: [{ key: 'new-mgra', ownerOid: 'mgra', regionId: R2, name: 'Cloud' }] }), names)
    expect(touching.byNode.mgra).toMatchObject({ regionChanges: 4, unitChanges: 4 })
    expect(touching.byNode.apac).toMatchObject({ regionChanges: 4, unitChanges: 4 })
    expect(touching.byNode.mgra!.groups).toEqual([
      expect.objectContaining({ to: expect.objectContaining({ orgUnitId: 'new-mgra', orgUnitName: 'Cloud' }), verdict: 'move-region', count: 4 }),
    ])
    // The summary still lists everyone waiting under the proposal.
    expect(touching.groups.reduce((s, g) => s + g.count, 0)).toBe(4)
  })

  it('applies the proposal to copies, and skips a new unit for someone who already owns one', () => {
    const live = config({ leaderMap: new Map([['apac', R1]]) })
    const proposed = withProposedChanges(live, {
      leaders: [{ oid: 'apac', regionId: null }],
      newUnits: [{ key: 'k', ownerOid: 'ownerx', regionId: R2, name: 'Second' }],
    })
    expect(live.leaderMap.get('apac')).toBe(R1)
    expect(proposed.leaderMap.has('apac')).toBe(false)
    expect(proposed.unitOwnerMap.get('ownerx')).toEqual([{ orgUnitId: U1, regionId: R1 }])
    expect(live.unitOwnerMap.get('ownerx')).toEqual([{ orgUnitId: U1, regionId: R1 }])
  })
})

function decisions(rows: OrgSetupRow[], cfg: PlacementConfig, extra: { notFound?: string[]; dismissed?: string[] } = {}) {
  return buildOrgSetupDecisions({
    rows,
    config: cfg,
    names,
    tree: buildOrgTree(rows, cfg, names, TOP),
    top: TOP,
    realRegions: new Set([R1, R2]),
    notFound: new Set(extra.notFound ?? []),
    principals: new Map([
      ['ownerx', { name: 'Daniel Ng', email: 'ownerx@x.test', teammateId: 'tm-ownerx' }],
      ['emea', { name: null, email: 'emea@x.test', leaderId: 'rl-emea' }],
    ]),
    dismissed: new Set(extra.dismissed ?? []),
    defaultUnits: new Map([[R1, DEF1]]),
  })
}

/*
 * ceo
 * ├─ vp (user)
 * │   └─ nah (user)
 * │       ├─ l1 (leads APAC) → l1a
 * │       └─ l2 (leads APAC) → l2a
 * └─ mix (not a user)
 *     ├─ m1 (leads APAC) → m1a
 *     ├─ m3 (leads APAC)
 *     └─ m2 (leads EMEA) → m2a
 */
function heads(): OrgSetupRow[] {
  return [
    row(['vp', 'ceo']),
    row(['nah', 'vp', 'ceo']),
    row(['l1', 'nah', 'vp', 'ceo']),
    row(['l1a', 'l1', 'nah', 'vp', 'ceo']),
    row(['l2', 'nah', 'vp', 'ceo']),
    row(['l2a', 'l2', 'nah', 'vp', 'ceo']),
    row(['m1', 'mix', 'ceo']),
    row(['m1a', 'm1', 'mix', 'ceo']),
    row(['m3', 'mix', 'ceo']),
    row(['m2', 'mix', 'ceo'], { regionId: R2, orgUnitId: HOLD2 }),
    row(['m2a', 'm2', 'mix', 'ceo'], { regionId: R2, orgUnitId: HOLD2 }),
  ]
}
const headLeaders = () => new Map([['l1', R1], ['l2', R1], ['m1', R1], ['m3', R1], ['m2', R2]])

describe('buildOrgSetupDecisions', () => {
  it('new team: the highest manager whose branch is all Unplaced with no owner above; not the top, not nested', () => {
    const cards = decisions(org(), config()).filter((d) => d.kind === 'new-team')
    expect(cards.map((d) => d.subjectKey)).toEqual(['mgra'])
    expect(cards[0]!.title).toBe('MGRA has 3 people under them and no Business Unit above them.')
    expect(cards[0]!.detail).toBe("All of them are in APAC's Unplaced.")
    expect(cards[0]!.data).toMatchObject({ department: 'Cloud', regionId: R1 })
    // No owned unit above them, so the new unit would sit in the region's default unit.
    expect(cards[0]!.data).toMatchObject({ parentUnitId: DEF1, parentUnitName: 'APAC (default)' })
  })

  it('new team: a qualifying manager inside a qualifying branch is not a card of its own', () => {
    const rows = org().filter((r) => !['ownerx', 'x1', 'x2'].includes(r.evidence.chain[0]!.oid))
    const cards = decisions(rows, config()).filter((d) => d.kind === 'new-team')
    expect(cards.map((d) => [d.subjectKey, d.title])).toEqual([['apac', 'Grace Liu has 4 people under them and no Business Unit above them.']])
  })

  it('new team: a branch on the unassigned bucket is a card with no region; one split across regions is no card', () => {
    const unassigned = { regionId: 'region-0', orgUnitId: 'hold-0' }
    const bucketed = org().map((r) => (['mgra', 'a1', 'a2', 'a3'].includes(r.evidence.chain[0]!.oid) ? { ...r, ...unassigned } : r))
    const [card, ...rest] = decisions(bucketed, config()).filter((d) => d.kind === 'new-team')
    expect(rest).toEqual([])
    expect(card).toMatchObject({
      subjectKey: 'mgra',
      title: 'MGRA has 3 people under them and no Business Unit above them.',
      detail: 'They have no region yet. Pick one on the Regions step, then come back.',
      data: { regionId: null },
    })

    const split = org().map((r) => (r.evidence.chain[0]!.oid === 'a1' ? { ...r, regionId: R2, orgUnitId: HOLD2 } : r))
    expect(decisions(split, config()).some((d) => d.kind === 'new-team')).toBe(false)
  })

  it('new team: an owner above the manager suppresses it, and a dismissal hides it', () => {
    const owned = config({ unitOwnerMap: new Map([['apac', [{ orgUnitId: U1, regionId: R1 }]]]) })
    expect(decisions(org(), owned).some((d) => d.kind === 'new-team')).toBe(false)
    expect(decisions(org(), config(), { dismissed: [dismissalKey('new-team', 'mgra')] }).some((d) => d.kind === 'new-team')).toBe(false)
    // Not dismissible: a key for it changes nothing.
    expect(decisions(org(), config(), { dismissed: [dismissalKey('outside-top', 'outside-top')] }).some((d) => d.kind === 'outside-top')).toBe(true)
  })

  it('no placement groups no-signal people by the top person\'s direct report; outside-top and not-read count', () => {
    const rows = [...org(), row(['f1', 'mgra', 'apac', 'ceo'], {}, { walkEnd: 'graph-error' }), row(['h1', 'mgra', 'apac'], {}, { walkEnd: 'hop-cap' })]
    const cards = decisions(rows, config())
    const noPlacement = cards.filter((d) => d.kind === 'no-placement')
    expect(noPlacement.map((d) => [d.subjectKey, d.data.count])).toEqual([['apac', 4], ['emea', 1]])
    expect(noPlacement[0]!.title).toBe('4 people under Grace Liu have no region.')
    expect(cards.find((d) => d.kind === 'outside-top')!.title).toBe('1 person does not report up to CEO.')
    expect(cards.find((d) => d.kind === 'not-read')!.data).toEqual({ lookupFailed: 1, walkIncomplete: 1 })
  })

  it('no placement names a head who is in their own count instead of counting them "under" themself', () => {
    const cards = decisions([...org(), row(['apac', 'ceo'])], config())
    const apac = cards.find((d) => d.kind === 'no-placement' && d.subjectKey === 'apac')!
    expect(apac.data.count).toBe(5)
    expect(apac.title).toBe('Grace Liu and 4 people under them have no region.')
    const alone = decisions([row(['solo', 'ceo'])], config()).find((d) => d.kind === 'no-placement')!
    expect(alone.title).toMatch(/^.+ has no region\.$/)
  })

  it('no placement never names the top person, who sits above the regions', () => {
    const cards = decisions([...org(), row(['ceo'])], config())
    expect(cards.filter((d) => d.kind === 'no-placement').map((d) => d.subjectKey)).toEqual(['apac', 'emea'])
  })

  it('no placement leaves out people an Admin placed by hand', () => {
    const rows = org().map((r) => (['a1', 'a2'].includes(r.evidence.chain[0]!.oid) ? { ...r, manual: true } : r))
    const apac = decisions(rows, config()).find((d) => d.kind === 'no-placement' && d.subjectKey === 'apac')!
    expect(apac.data.count).toBe(2)
    expect(apac.title).toBe('2 people under Grace Liu have no region.')
  })

  it('new head: the highest person above two leaders of one region, never the top, never above two regions', () => {
    const cards = decisions(heads(), config({ unitOwnerMap: new Map(), leaderMap: headLeaders() }))
    const head = cards.filter((d) => d.kind === 'new-head')
    // vp and nah both qualify for APAC; only vp, the higher, gets the card. mix is
    // above two of APAC's leaders but also one of EMEA's, and ceo is the top.
    expect(head.map((d) => d.subjectKey)).toEqual(['vp'])
    expect(head[0]!.title).toBe("VP is above 2 of APAC's leaders.")
    expect(head[0]!.data).toMatchObject({ oid: 'vp', regionId: R1, regionName: 'APAC', count: 2 })
    expect(head[0]!.detail).toBe(
      'If they now lead APAC, make them its leader on the Regions step; it shows who would move before anything is saved. 2 people in their branch have no region today.',
    )

    // With vp gone nah is the highest; with only one leader below there is no card.
    const noVp = heads()
      .filter((r) => r.evidence.chain[0]!.oid !== 'vp')
      .map((r) => ({ ...r, evidence: { ...r.evidence, chain: r.evidence.chain.filter((l) => l.oid !== 'vp') } }))
    expect(decisions(noVp, config({ unitOwnerMap: new Map(), leaderMap: headLeaders() })).filter((d) => d.kind === 'new-head').map((d) => d.subjectKey)).toEqual(['nah'])
    const one = new Map([['l1', R1], ['m1', R1], ['m3', R2], ['m2', R2]])
    expect(decisions(heads(), config({ unitOwnerMap: new Map(), leaderMap: one })).some((d) => d.kind === 'new-head')).toBe(false)

    // With every leader in APAC the top is above them all, and still gets no card.
    const allApac = new Map([['l1', R1], ['l2', R1], ['m1', R1], ['m2', R1]])
    const apacCards = decisions(heads(), config({ unitOwnerMap: new Map(), leaderMap: allApac })).filter((d) => d.kind === 'new-head')
    expect(apacCards.map((d) => d.subjectKey).sort()).toEqual(['mix', 'vp'])
  })

  it('new head: a leader above them means no card', () => {
    const cards = decisions(heads(), config({ unitOwnerMap: new Map(), leaderMap: new Map([...headLeaders(), ['vp', R2]]) }))
    expect(cards.some((d) => d.kind === 'new-head')).toBe(false)
  })

  it('new head replaces their no-placement card, which comes back when the head card is set aside', () => {
    const cfg = config({ unitOwnerMap: new Map(), leaderMap: headLeaders() })
    const cards = decisions(heads(), cfg)
    expect(cards.some((d) => d.kind === 'no-placement' && d.subjectKey === 'vp')).toBe(false)
    expect(cards.some((d) => d.kind === 'new-head' && d.subjectKey === 'vp')).toBe(true)

    const dismissed = decisions(heads(), cfg, { dismissed: [dismissalKey('new-head', 'vp')] })
    expect(dismissed.some((d) => d.kind === 'new-head')).toBe(false)
    expect(dismissed.find((d) => d.kind === 'no-placement' && d.subjectKey === 'vp')!.title).toBe('VP and 1 person under them have no region.')
  })

  it('moves waiting: one card with the applicable groups', () => {
    const cards = decisions(org(), config({ leaderMap: new Map([['apac', R2]]) }))
    const moves = cards.find((d) => d.kind === 'moves-waiting')!
    expect(moves.title).toBe('4 people are waiting to move.')
    expect(moves.data.count).toBe(4)
    expect(cards[0]!.kind).toBe('moves-waiting')
  })

  it('owner left and leader left come from the current cycle\'s directory check', () => {
    const cfg = config({ leaderMap: new Map([['emea', R2]]) })
    const cards = decisions(org(), cfg, { notFound: ['ownerx', 'emea', 'nobody'] })
    expect(cards.find((d) => d.kind === 'owner-left')).toMatchObject({
      subjectKey: 'ownerx',
      title: 'Daniel Ng owns Cloud & Data but was not found in the directory.',
      data: { ownerTeammateId: 'tm-ownerx' },
    })
    expect(cards.find((d) => d.kind === 'owner-left')!.data).not.toHaveProperty('leaderId')
    expect(cards.find((d) => d.kind === 'leader-left')).toMatchObject({ subjectKey: 'emea', data: { regionId: R2, leaderId: 'rl-emea' } })
    expect(cards.find((d) => d.kind === 'leader-left')!.data).not.toHaveProperty('ownerTeammateId')
    expect(cards.filter((d) => d.kind === 'owner-left' || d.kind === 'leader-left')).toHaveLength(2)
  })

  it('unit under another region\'s leader: the owner\'s nearest leader leads a different region', () => {
    const cards = decisions(org(), config({ leaderMap: new Map([['apac', R2]]) }))
    const card = cards.find((d) => d.kind === 'unit-under-other-region')!
    expect(card).toMatchObject({ subjectKey: U1 })
    expect(card.title).toBe('Cloud & Data is in APAC, but its owner Daniel Ng reports to Grace Liu of EMEA.')
    expect(decisions(org(), config({ leaderMap: new Map([['apac', R1]]) })).some((d) => d.kind === 'unit-under-other-region')).toBe(false)
  })
})
