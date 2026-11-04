/*
 * The Org setup tree (docs/design/org-setup/00-spec.md, Server: tree). Pure: built
 * from stored evidence chains rooted at the top person, never from a directory read.
 */
import type { OrgTreeNode, OrgTreeRegion } from '../../shared/org-setup/contract'
import type { EvidenceRow, Names } from './placement-check-read'
import { isUsableEvidence } from './placement-verdict'
import { decidePlacement, type PlacementConfig } from './region-derivation'

export type OrgSetupRow = Pick<
  EvidenceRow,
  'teammateId' | 'name' | 'email' | 'regionId' | 'orgUnitId' | 'onHolding' | 'manual' | 'spend30d' | 'evidence'
>

/** What the decisions need beyond the contract's node. */
export interface OrgTreeNodeMeta {
  /** The node has its own evidence row (they are a TokenScope user). */
  isUser: boolean
  /** Users at or under the node whose current home is a holding node. */
  onHolding: number
  /** The node and every manager above them, nearest first (from the first chain seen). */
  chainUp: string[]
}

export interface OrgTree {
  nodes: OrgTreeNode[]
  /** Complete walks that never pass through the top person. */
  outsideTop: number
  meta: Map<string, OrgTreeNodeMeta>
}

export function buildOrgTree(
  rows: readonly OrgSetupRow[],
  config: PlacementConfig,
  names: Names,
  top: { oid: string; name: string | null; email: string | null } | null,
): OrgTree {
  const meta = new Map<string, OrgTreeNodeMeta>()
  if (!top) return { nodes: [], outsideTop: 0, meta }
  const usable = rows.filter((r) => isUsableEvidence(r.evidence.walkEnd))
  const ownRow = new Map<string, OrgSetupRow>()
  for (const r of usable) {
    const self = r.evidence.chain[0]?.oid
    if (self) ownRow.set(self, r)
  }

  const byOid = new Map<string, OrgTreeNode>()
  const node = (oid: string, link: { name: string | null; email: string | null }, parentOid: string | null) => {
    let n = byOid.get(oid)
    if (!n) {
      const own = ownRow.get(oid)
      const leaderRegion = config.leaderMap.get(oid)
      n = {
        oid,
        name: link.name ?? own?.name ?? null,
        email: link.email ?? own?.email ?? null,
        department: own?.evidence.attributes.department ?? null,
        parentOid,
        users: 0,
        regionCounts: {},
        spend30d: 0,
        leaderOf: leaderRegion ? { regionId: leaderRegion, regionName: names.region.get(leaderRegion) ?? leaderRegion } : null,
        owns: (config.unitOwnerMap.get(oid) ?? []).map((u) => ({
          orgUnitId: u.orgUnitId,
          name: names.unit.get(u.orgUnitId) ?? u.orgUnitId,
          regionId: u.regionId,
        })),
        decidedBy: {},
      }
      byOid.set(oid, n)
    }
    return n
  }
  node(top.oid, top, null)

  let outsideTop = 0
  for (const r of usable) {
    const chain = r.evidence.chain
    const k = chain.findIndex((l) => l.oid === top.oid)
    if (k < 0) {
      // Only a walk that reached the top of the chart proves it; a capped one is "not read".
      if (r.evidence.walkEnd === 'top-of-chart') outsideTop++
      continue
    }
    const step = decidePlacement(r.evidence, config).step ?? 'none'
    for (let i = 0; i <= k; i++) {
      const link = chain[i]!
      const n = node(link.oid, link, i < k ? chain[i + 1]!.oid : null)
      n.users++
      n.regionCounts[r.regionId] = (n.regionCounts[r.regionId] ?? 0) + 1
      n.spend30d += r.spend30d
      n.decidedBy[step] = (n.decidedBy[step] ?? 0) + 1
      let m = meta.get(link.oid)
      if (!m) {
        m = { isUser: ownRow.has(link.oid), onHolding: 0, chainUp: chain.slice(i).map((l) => l.oid) }
        meta.set(link.oid, m)
      }
      if (r.onHolding) m.onHolding++
    }
  }
  if (!meta.has(top.oid)) meta.set(top.oid, { isUser: ownRow.has(top.oid), onHolding: 0, chainUp: [top.oid] })

  return { nodes: orderTopDown(byOid, top.oid), outsideTop, meta }
}

export interface ActiveLeaderRow {
  leaderId: string
  regionId: string
  oid: string
  name: string | null
  email: string | null
}

/**
 * Region coverage from CURRENT homes, not from the tree: every person given (the
 * whole placement-check population, read or not — loadPopulationHomes) counts in
 * the region they are in today, whatever their chain says, and a leader counts
 * whether or not anyone reports to them. Regions come in the order given; one
 * without people or leaders is still listed.
 */
export function regionCoverage(
  homes: readonly Pick<OrgSetupRow, 'regionId' | 'onHolding'>[],
  regions: readonly { id: string; name: string }[],
  leaders: readonly ActiveLeaderRow[],
): OrgTreeRegion[] {
  const out = new Map<string, OrgTreeRegion>(regions.map((r) => [r.id, { id: r.id, name: r.name, users: 0, inUnit: 0, leaders: [] }]))
  for (const h of homes) {
    const region = out.get(h.regionId)
    if (!region) continue
    region.users++
    if (!h.onHolding) region.inUnit++
  }
  for (const l of leaders) {
    out.get(l.regionId)?.leaders.push({ leaderId: l.leaderId, oid: l.oid, name: l.name, email: l.email })
  }
  for (const region of out.values()) region.leaders.sort((a, b) => (a.name ?? a.email ?? a.oid).localeCompare(b.name ?? b.email ?? b.oid))
  return [...out.values()]
}

/** Top first, then depth-first with each node's children by users, largest first. */
function orderTopDown(byOid: Map<string, OrgTreeNode>, topOid: string): OrgTreeNode[] {
  const children = new Map<string, OrgTreeNode[]>()
  for (const n of byOid.values()) {
    if (n.parentOid === null) continue
    const list = children.get(n.parentOid) ?? []
    list.push(n)
    children.set(n.parentOid, list)
  }
  const byUsers = (a: OrgTreeNode, b: OrgTreeNode) =>
    b.users - a.users || (a.name ?? a.oid).localeCompare(b.name ?? b.oid)
  const out: OrgTreeNode[] = []
  const seen = new Set<string>()
  const stack = [byOid.get(topOid)!]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n.oid)) continue
    seen.add(n.oid)
    out.push(n)
    const kids = (children.get(n.oid) ?? []).slice().sort(byUsers)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
  }
  // Chains that disagree (evidence gathered at different times) can strand a node.
  for (const n of byOid.values()) if (!seen.has(n.oid)) out.push(n)
  return out
}
