/*
 * A small org tree for the Org setup page and view tests.
 *
 *   Tess Top
 *   ├─ Ada Apac (40, leads APAC)
 *   │  ├─ Ben Cloud (20, department Cloud & Data)
 *   │  │  └─ Cat Lee (8)
 *   │  │     └─ Gil Lee (3)
 *   │  ├─ Dan Core (12, owns Core in APAC)
 *   │  │  └─ Eve Ng (6)
 *   │  │     └─ Hui Ng (2)
 *   │  └─ Fay Far (5, owns Far in EMEA)
 *   ├─ Gus Emea (30, leads EMEA)
 *   ├─ Hal Small (3)
 *   └─ Ivy Small (2)
 *
 * Gil Lee, Hui Ng, Fay Far, Gus Emea and the Smalls are leaves (nobody reports to them).
 */
import type { OrgTreeNode, OrgTreeResponse, PlacementMoveGroup } from '../../../shared/org-setup/contract'
import type { PlacementCheckRow, PlacementVerdict } from '../../../shared/placement/placement-check'

export const APAC = '9a1e0000-0000-4000-8000-0000000000a1'
export const EMEA = '9a1e0000-0000-4000-8000-0000000000e1'
export const U_CORE = '9a1e0000-0000-4000-8000-0000000000c1'
export const U_EDGE = '9a1e0000-0000-4000-8000-0000000000c2'
export const U_FAR = '9a1e0000-0000-4000-8000-0000000000c3'
export const U_UNPLACED = '9a1e0000-0000-4000-8000-0000000000f1'

export const uuid = (n: number) => `9a1e0000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function node(oid: string, parentOid: string | null, users: number, over: Partial<OrgTreeNode> = {}): OrgTreeNode {
  return {
    oid,
    name: oid,
    email: `${oid}@example.com`,
    department: null,
    parentOid,
    users,
    regionCounts: {},
    spend30d: 0,
    leaderOf: null,
    owns: [],
    decidedBy: {},
    ...over,
  }
}

export function treeNodes(): OrgTreeNode[] {
  return [
    node('oid-top', null, 100, { name: 'Tess Top' }),
    node('oid-a', 'oid-top', 40, {
      name: 'Ada Apac',
      regionCounts: { [APAC]: 35, [EMEA]: 5 },
      leaderOf: { regionId: APAC, regionName: 'APAC' },
      decidedBy: { 'chain-unit': 12, 'unit-rule': 2, 'chain-region': 26 },
    }),
    node('oid-a1', 'oid-a', 20, { name: 'Ben Cloud', department: 'Cloud & Data' }),
    node('oid-a1a', 'oid-a1', 8, { name: 'Cat Lee' }),
    node('oid-a1a1', 'oid-a1a', 3, { name: 'Gil Lee' }),
    node('oid-a2', 'oid-a', 12, { name: 'Dan Core', owns: [{ orgUnitId: U_CORE, name: 'Core', regionId: APAC }] }),
    node('oid-a2a', 'oid-a2', 6, { name: 'Eve Ng' }),
    node('oid-a2a1', 'oid-a2a', 2, { name: 'Hui Ng' }),
    node('oid-a3', 'oid-a', 5, { name: 'Fay Far', owns: [{ orgUnitId: U_FAR, name: 'Far', regionId: EMEA }] }),
    node('oid-e', 'oid-top', 30, { name: 'Gus Emea', regionCounts: { [EMEA]: 30 }, leaderOf: { regionId: EMEA, regionName: 'EMEA' } }),
    node('oid-s1', 'oid-top', 3, { name: 'Hal Small' }),
    node('oid-s2', 'oid-top', 2, { name: 'Ivy Small' }),
  ]
}

export function tree(over: Partial<OrgTreeResponse> = {}): OrgTreeResponse {
  return {
    settings: { top: { oid: 'oid-top', name: 'Tess Top', email: 'tess@example.com' }, readCadence: 'month', updatedAt: '2026-10-21T00:00:00Z' },
    topHome: { kind: 'placed', teammateId: uuid(1), email: 'tess@example.com', regionId: APAC, regionName: 'APAC', unitName: 'APAC (default)' },
    read: { cycleId: uuid(900), startedAt: '2026-10-21T00:00:00Z', remaining: 0, failed: 0, complete: true },
    // Coverage from current homes and leaders from the leader table, as the server sends them.
    regions: [
      { id: APAC, name: 'APAC', users: 40, inUnit: 14, leaders: [{ leaderId: uuid(301), oid: 'oid-a', name: 'Ada Apac', email: 'oid-a@example.com' }] },
      { id: EMEA, name: 'EMEA', users: 30, inUnit: 0, leaders: [{ leaderId: uuid(300), oid: 'oid-e', name: 'Gus Emea', email: 'oid-e@example.com' }] },
    ],
    nodes: treeNodes(),
    outsideTop: 0,
    ...over,
  }
}

type Side = PlacementMoveGroup['from']
export const side = (regionId: string | null, regionName: string | null, orgUnitId: string | null, orgUnitName: string | null): Side => ({
  regionId,
  regionName,
  orgUnitId,
  orgUnitName,
})

export function group(verdict: PlacementVerdict, count: number, from: Side, to: Side): PlacementMoveGroup {
  return { from, to, verdict, count, spend30d: count * 10 }
}

export function checkRow(n: number, verdict: PlacementVerdict, over: Partial<PlacementCheckRow> = {}): PlacementCheckRow {
  return {
    teammateId: uuid(n),
    name: `Person ${n}`,
    email: `p${n}@example.com`,
    current: { regionId: APAC, regionName: 'APAC', orgUnitId: U_UNPLACED, orgUnitName: 'Unplaced', onHolding: true },
    derived: { regionId: APAC, regionName: 'APAC', orgUnitId: U_CORE, orgUnitName: 'Core', onHolding: false, step: 'chain-unit' },
    verdict,
    manual: verdict === 'manual',
    provenance: null,
    spend30d: 0,
    gatheredAt: '2026-10-21T00:00:00Z',
    why: { rule: null, owner: null, leader: null, ambiguousOwners: [], chain: [], walkEnd: 'top-of-chart' },
    seen: { regionId: APAC, orgUnitId: U_UNPLACED, provenance: null },
    ...over,
  }
}
