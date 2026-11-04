/*
 * org-setup-view: the structural helpers behind /admin/org-setup. None of them
 * decides placement; they pick rows, diff leader choices and order unit creation.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  decisionData,
  defaultUnitName,
  groupLink,
  homeCardState,
  isDraftUnitKey,
  leaderDiff,
  managersWithReports,
  mostAlreadyThere,
  placementCheckLink,
  proposedLeaders,
  regionChangeLines,
  regionRows,
  rowsInGroups,
  rowsToApply,
  saveDraftUnits,
  unitChangeLines,
  unitParent,
  unitRows,
  withCreatedUnitIds,
  type DraftUnits,
} from '../../../app/utils/org-setup-view'
import type { OrgSetupUnitItem, OrgSetupUnitsResponse } from '../../../shared/org-setup/contract'
import {
  APAC,
  EMEA,
  U_CORE,
  U_EDGE,
  U_UNPLACED,
  checkRow,
  group,
  node,
  side,
  tree,
  treeNodes,
  uuid,
} from '../helpers/org-setup-fixture'

const byOid = (oid: string) => treeNodes().find((n) => n.oid === oid)!

describe('regions step rows', () => {
  it('lists the top person’s reports with 5+ users, folding the rest with their people count', () => {
    const r = regionRows(treeNodes(), 'oid-top')
    expect(r.main.map((n) => n.oid)).toEqual(['oid-a', 'oid-e'])
    expect(r.small.map((n) => n.oid)).toEqual(['oid-s1', 'oid-s2'])
    expect(r.smallPeople).toBe(5)
  })

  it('says most are there already at 80% in the picked region, not below', () => {
    expect(mostAlreadyThere(byOid('oid-a'), APAC)).toBe(true) // 35 of 40
    expect(mostAlreadyThere(byOid('oid-a'), EMEA)).toBe(false)
    expect(mostAlreadyThere(node('x', null, 10, { regionCounts: { [APAC]: 7 } }), APAC)).toBe(false)
    expect(mostAlreadyThere(byOid('oid-a'), null)).toBe(false)
  })

  it('aggregates preview groups into region-change lines and ignores same-region groups', () => {
    const lines = regionChangeLines([
      group('move-region', 30, side(APAC, 'APAC', U_CORE, 'Core'), side(EMEA, 'EMEA', null, null)),
      group('move-region', 10, side(APAC, 'APAC', null, null), side(EMEA, 'EMEA', U_EDGE, 'Edge')),
      group('move-region', 1, side(null, null, null, null), side(EMEA, 'EMEA', null, null)),
      group('move-unit', 5, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_CORE, 'Core')),
    ])
    expect(lines).toEqual(['40 move from APAC to EMEA', '1 moves from no region to EMEA'])
    expect(unitChangeLines([group('move-unit', 5, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_CORE, 'Core'))])).toEqual([
      '5 move from Unplaced to Core',
    ])
  })
})

describe('leader choices', () => {
  it('proposes only picks that differ from what is saved', () => {
    expect(proposedLeaders(treeNodes(), { 'oid-a': APAC, 'oid-e': APAC, 'oid-s1': null })).toEqual([{ oid: 'oid-e', regionId: APAC }])
  })

  it('revokes the saved leadership of a moved leader and assigns the new one', () => {
    const d = leaderDiff(treeNodes(), { 'oid-e': APAC, 'oid-a': null, 'oid-s1': EMEA })
    expect(d.revoke).toEqual([
      { oid: 'oid-e', regionId: EMEA },
      { oid: 'oid-a', regionId: APAC },
    ])
    expect(d.assign.map((a) => [a.node.oid, a.regionId])).toEqual([
      ['oid-e', APAC],
      ['oid-s1', EMEA],
    ])
  })
})

describe('business units step', () => {
  it('walks the region subtree under its leader, depth first, largest branch first', () => {
    const rows = unitRows(treeNodes(), APAC, {})
    expect(rows.map((r) => [r.node.oid, r.depth])).toEqual([
      ['oid-a', 0],
      ['oid-a1', 1],
      ['oid-a1a', 2],
      ['oid-a2', 1],
      ['oid-a2a', 2],
      ['oid-a3', 1],
    ])
  })

  it('leaves out people nobody reports to, unless they own a unit', () => {
    const oids = unitRows(treeNodes(), APAC, {}).map((r) => r.node.oid)
    expect(oids).not.toContain('oid-a1a1')
    expect(oids).not.toContain('oid-a2a1')
    // Fay Far has no reports but owns Far, so the row still says so.
    expect(oids).toContain('oid-a3')
    // A leader nobody reports to has nothing to decide either.
    expect(unitRows(treeNodes(), EMEA, {}).map((r) => r.node.oid)).toEqual([])
  })

  it('follows unsaved leader picks and leaves out a branch led for another region', () => {
    const rows = unitRows(treeNodes(), APAC, { 'oid-a1': EMEA })
    expect(rows.map((r) => r.node.oid)).not.toContain('oid-a1')
    // Gus Emea leads EMEA but nobody reports to him, so only the picked branch shows.
    expect(unitRows(treeNodes(), EMEA, { 'oid-a1': EMEA }).map((r) => r.node.oid)).toEqual(['oid-a1', 'oid-a1a'])
  })

  it('a leaf (nobody reports to them) cannot own a new unit', () => {
    const managers = managersWithReports(treeNodes())
    expect(managers.has('oid-a1a')).toBe(true)
    expect(managers.has('oid-a1a1')).toBe(false)
    expect(managers.has('oid-e')).toBe(false)
  })

  it('names a new unit after the department, else the person’s team', () => {
    expect(defaultUnitName(byOid('oid-a1'))).toBe('Cloud & Data')
    expect(defaultUnitName(byOid('oid-a1a'))).toBe("Cat Lee's team")
  })

  it('nests a new unit under the nearest ticked or owning manager in the same region, else top level', () => {
    const drafts: DraftUnits = { 'oid-a1': { regionId: APAC, name: 'Cloud & Data' } }
    expect(unitParent(treeNodes(), 'oid-a1a', APAC, drafts)).toEqual({ kind: 'new', ownerOid: 'oid-a1', name: 'Cloud & Data' })
    expect(unitParent(treeNodes(), 'oid-a2a', APAC, drafts)).toEqual({ kind: 'existing', orgUnitId: U_CORE, name: 'Core' })
    expect(unitParent(treeNodes(), 'oid-a1', APAC, drafts)).toBeNull()
    // Dan Core owns Core in APAC, so it is not a parent for an EMEA unit.
    expect(unitParent(treeNodes(), 'oid-a2a', EMEA, {})).toBeNull()
  })

  it('creates parents before children and passes the new parent id', async () => {
    const drafts: DraftUnits = {
      'oid-a1a': { regionId: APAC, name: "Cat Lee's team" },
      'oid-a1': { regionId: APAC, name: 'Cloud & Data' },
      'oid-a2a': { regionId: APAC, name: "Eve Ng's team" },
    }
    const post = vi.fn(async (items: OrgSetupUnitItem[]): Promise<OrgSetupUnitsResponse> => ({
      results: items.map((i) => ({ ownerOid: i.ownerOid, status: 'created', orgUnitId: `id-${i.ownerOid}`, code: 'x' })),
    }))
    const { results, error } = await saveDraftUnits(treeNodes(), drafts, post)
    expect(error).toBeNull()
    expect(post.mock.calls.map((c) => c[0].map((i) => [i.ownerOid, i.parentUnitId]))).toEqual([
      [
        ['oid-a1', null],
        ['oid-a2a', U_CORE],
      ],
      [['oid-a1a', 'id-oid-a1']],
    ])
    expect([...results.values()].every((r) => r.status === 'created')).toBe(true)
  })

  it('refuses a child without a call when its new parent was refused', async () => {
    const drafts: DraftUnits = {
      'oid-a1': { regionId: APAC, name: 'Cloud & Data' },
      'oid-a1a': { regionId: APAC, name: "Cat Lee's team" },
    }
    const post = vi.fn(async (items: OrgSetupUnitItem[]): Promise<OrgSetupUnitsResponse> => ({
      results: items.map((i) => ({ ownerOid: i.ownerOid, status: 'refused', reason: 'already-owns-a-bu', detail: 'Already owns Core.' })),
    }))
    const { results } = await saveDraftUnits(treeNodes(), drafts, post)
    expect(post).toHaveBeenCalledTimes(1)
    expect(results.get('oid-a1a')).toMatchObject({ status: 'refused', reason: 'parent-not-created' })
  })

  it('sends at most 50 units per call', async () => {
    const nodes = [node('top', null, 200), ...Array.from({ length: 51 }, (_, i) => node(`m${i}`, 'top', 3))]
    const drafts: DraftUnits = Object.fromEntries(nodes.slice(1).map((n) => [n.oid, { regionId: APAC, name: n.oid }]))
    const post = vi.fn(async (items: OrgSetupUnitItem[]): Promise<OrgSetupUnitsResponse> => ({
      results: items.map((i) => ({ ownerOid: i.ownerOid, status: 'created', orgUnitId: uuid(1), code: 'x' })),
    }))
    await saveDraftUnits(nodes, drafts, post)
    expect(post.mock.calls.map((c) => c[0].length)).toEqual([50, 1])
  })
})

describe('review and overview', () => {
  const toCore = group('place', 1, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_CORE, 'Core'))
  /** Applicable, but in no displayed group: Unplaced → Edge. */
  const elsewhere = (n: number) =>
    checkRow(n, 'place', { derived: { regionId: APAC, regionName: 'APAC', orgUnitId: U_EDGE, orgUnitName: 'Edge', onHolding: false, step: 'chain-unit' } })

  it('applies only the rows the displayed groups stand for, plus the ticked manual rows', () => {
    const rows = [checkRow(1, 'place'), checkRow(2, 'manual'), checkRow(3, 'needs-owner'), checkRow(4, 'manual'), elsewhere(5)]
    expect(rowsToApply(rows, [toCore], new Set()).map((r) => r.teammateId)).toEqual([uuid(1)])
    expect(rowsToApply(rows, [toCore], new Set([uuid(4)])).map((r) => r.teammateId)).toEqual([uuid(1), uuid(4)])
    // No groups shown: nothing but the ticked hand-placed people, however applicable the rest are.
    expect(rowsToApply(rows, [], new Set([uuid(4)])).map((r) => r.teammateId)).toEqual([uuid(4)])
  })

  it('a moves-waiting group stands for exactly its from → to rows', () => {
    expect(rowsInGroups([checkRow(1, 'place'), elsewhere(2), checkRow(3, 'manual')], [toCore]).map((r) => r.teammateId)).toEqual([uuid(1)])
  })

  it('a group naming a unit by its draft key matches the unit’s id once it exists', () => {
    const toNew = group('place', 1, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', 'new:oid-a1', 'Cloud & Data'))
    const row = checkRow(1, 'place', { derived: { regionId: APAC, regionName: 'APAC', orgUnitId: U_EDGE, orgUnitName: 'Cloud & Data', onHolding: false, step: 'chain-unit' } })
    expect(rowsInGroups([row], [toNew])).toEqual([])
    const resolved = withCreatedUnitIds([toNew, toCore], { 'new:oid-a1': U_EDGE })
    expect(resolved[0]!.to.orgUnitId).toBe(U_EDGE)
    expect(resolved[1]).toEqual(toCore)
    expect(rowsInGroups([row], resolved).map((r) => r.teammateId)).toEqual([uuid(1)])
  })

  it('links the placement check filtered to a group’s verdict, regions and units, so two groups in one region differ', () => {
    const toEdge = group('place', 2, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', U_EDGE, 'Edge'))
    expect(groupLink(toCore)).toBe(`/admin/placement-check?verdict=place&current=${APAC}&derived=${APAC}&currentUnit=${U_UNPLACED}&derivedUnit=${U_CORE}`)
    expect(groupLink(toEdge)).toBe(`/admin/placement-check?verdict=place&current=${APAC}&derived=${APAC}&currentUnit=${U_UNPLACED}&derivedUnit=${U_EDGE}`)
    // No unit on a side is `none`, which the page tells apart from a key left out.
    expect(groupLink(group('move-region', 3, side(APAC, 'APAC', U_CORE, 'Core'), side(EMEA, 'EMEA', null, null)))).toBe(
      `/admin/placement-check?verdict=move-region&current=${APAC}&derived=${EMEA}&currentUnit=${U_CORE}&derivedUnit=none`,
    )
    expect(placementCheckLink({ verdict: 'needs-owner' })).toBe('/admin/placement-check?verdict=needs-owner')
    expect(placementCheckLink({ current: null, currentUnit: undefined })).toBe('/admin/placement-check')
  })

  it('has no link for a group naming a unit by its draft key, on either side, until the id exists', () => {
    const toNew = group('place', 1, side(APAC, 'APAC', U_UNPLACED, 'Unplaced'), side(APAC, 'APAC', 'new:oid-a1', 'Cloud & Data'))
    const fromNew = group('move-unit', 1, side(APAC, 'APAC', 'new:oid-a1', 'Cloud & Data'), side(APAC, 'APAC', U_CORE, 'Core'))
    expect(isDraftUnitKey('new:oid-a1')).toBe(true)
    expect(isDraftUnitKey(U_CORE)).toBe(false)
    expect(isDraftUnitKey(null)).toBe(false)
    expect(groupLink(toNew)).toBeNull()
    expect(groupLink(fromNew)).toBeNull()
    expect(groupLink(withCreatedUnitIds([toNew], { 'new:oid-a1': U_EDGE })[0]!)).toBe(
      `/admin/placement-check?verdict=place&current=${APAC}&derived=${APAC}&currentUnit=${U_UNPLACED}&derivedUnit=${U_EDGE}`,
    )
  })

  it('reads the revoke ids and a null region off a decision', () => {
    const d = (data: Record<string, unknown>) => ({ kind: 'owner-left' as const, subjectKey: 'k', title: '', detail: '', data })
    expect(decisionData(d({ ownerTeammateId: uuid(7), leaderId: uuid(8), regionId: null }))).toMatchObject({
      ownerTeammateId: uuid(7),
      leaderId: uuid(8),
      regionId: null,
    })
    expect(decisionData(d({}))).toMatchObject({ ownerTeammateId: null, leaderId: null })
  })

  it('home card: set up before a top person, then only while something is to decide', () => {
    const t = tree()
    expect(homeCardState(null, null)).toBeNull()
    expect(homeCardState({ ...t.settings, top: null }, null)).toEqual({ kind: 'setup' })
    expect(homeCardState(t.settings, { read: t.read, decisions: [] })).toBeNull()
    const d = (title: string) => ({ kind: 'not-read' as const, subjectKey: title, title, detail: '', data: {} })
    expect(homeCardState(t.settings, { read: t.read, decisions: [d('a'), d('b'), d('c'), d('d')] })).toEqual({
      kind: 'decide',
      count: 4,
      titles: ['a', 'b', 'c'],
    })
  })
})
