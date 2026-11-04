/*
 * The Org setup overview's "For you to decide" cards (docs/design/org-setup/
 * 00-spec.md, Screens 5). Pure: built at read time from the same judged evidence
 * the placement check shows, under the live config.
 */
import {
  DECISION_KINDS,
  DISMISSIBLE_KINDS,
  type DecisionKind,
  type OrgSetupDecision,
} from '../../shared/org-setup/contract'
import type { Names } from './placement-check-read'
import type { OrgSetupRow, OrgTree } from './org-setup-tree'
import { EMPTY_PROPOSAL, previewOrgSetup, judgeRows } from './org-setup-preview'
import type { PlacementConfig } from './region-derivation'

/** Fewest reports under a manager before they are suggested as a new team. */
export const NEW_TEAM_MIN_REPORTS = 3

/** An owner or leader as the cards name them, with the ids a replacement revokes. */
export interface OrgSetupPrincipal {
  name: string | null
  email: string | null
  /** The teammate holding the oid (an owner's cou_owner row is keyed on it). */
  teammateId?: string
  /** Their active region_leader row. */
  leaderId?: string
}

export interface OrgSetupDecisionInput {
  rows: readonly OrgSetupRow[]
  config: PlacementConfig
  names: Names
  tree: OrgTree
  top: { oid: string; name: string | null; email: string | null } | null
  /** Regions an Admin can pick: everything but the system-wide unassigned bucket. */
  realRegions: ReadonlySet<string>
  /** Owners and leaders the current cycle's directory check did not find. */
  notFound: ReadonlySet<string>
  /** Owners and leaders, who may have no evidence of their own. */
  principals: ReadonlyMap<string, OrgSetupPrincipal>
  /** `${kind}:${subjectKey}` dismissed in the current cycle. */
  dismissed: ReadonlySet<string>
  /** Each region's `default` unit id: where a new unit with no owned unit above it sits. */
  defaultUnits: ReadonlyMap<string, string>
}

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`)

export function dismissalKey(kind: string, subjectKey: string): string {
  return `${kind}:${subjectKey}`
}

export function buildOrgSetupDecisions(input: OrgSetupDecisionInput): OrgSetupDecision[] {
  const { rows, config, names, tree, top } = input
  const out: OrgSetupDecision[] = []
  const linkNames = new Map<string, { name: string | null; email: string | null }>()
  for (const r of rows) for (const l of r.evidence.chain) if (!linkNames.has(l.oid)) linkNames.set(l.oid, l)
  const who = (oid: string) => {
    const p = input.principals.get(oid)
    const l = linkNames.get(oid)
    return { name: p?.name ?? l?.name ?? null, email: p?.email ?? l?.email ?? null }
  }
  const label = (oid: string) => {
    const p = who(oid)
    return p.name ?? p.email ?? 'Someone'
  }
  const regionName = (id: string) => names.region.get(id) ?? 'another region'
  const unitName = (id: string) => names.unit.get(id) ?? 'a Business Unit'

  // Moves waiting.
  const preview = previewOrgSetup(rows, config, EMPTY_PROPOSAL, names)
  const waiting = preview.groups.reduce((s, g) => s + g.count, 0)
  if (waiting > 0) {
    out.push({
      kind: 'moves-waiting',
      subjectKey: 'moves-waiting',
      title: `${people(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting to move.`,
      detail: 'Their reporting line or a directory rule places them somewhere other than where they are now.',
      data: { count: waiting, groups: preview.groups },
    })
  }

  // New team: the highest manager whose whole branch sits on ONE region's holding
  // node (the system-wide unassigned bucket counts as one), with no owner at or
  // above them. A branch split across regions is not one team to create a unit
  // for; its people show under moves waiting or no placement as their verdicts say.
  const nodeByOid = new Map(tree.nodes.map((n) => [n.oid, n]))
  const hasChildren = new Set(tree.nodes.map((n) => n.parentOid).filter((p): p is string => p !== null))
  const qualifies = (oid: string): boolean => {
    if (!top || oid === top.oid || !hasChildren.has(oid)) return false
    const n = nodeByOid.get(oid)
    const m = tree.meta.get(oid)
    if (!n || !m) return false
    const reports = n.users - (m.isUser ? 1 : 0)
    if (reports < NEW_TEAM_MIN_REPORTS || m.onHolding !== n.users) return false
    if (Object.keys(n.regionCounts).length !== 1) return false
    return !m.chainUp.some((o) => (config.unitOwnerMap.get(o)?.length ?? 0) > 0)
  }
  for (const n of tree.nodes) {
    if (!qualifies(n.oid) || (n.parentOid && qualifies(n.parentOid))) continue
    const reports = n.users - (tree.meta.get(n.oid)!.isUser ? 1 : 0)
    const holdingRegion = Object.keys(n.regionCounts)[0]!
    // The unassigned bucket is not a region the unit can be created in.
    const regionId = input.realRegions.has(holdingRegion) ? holdingRegion : null
    // No owner above them means no owned unit above them: the unit sits in the region's default.
    const parentUnitId = (regionId && input.defaultUnits.get(regionId)) || null
    out.push({
      kind: 'new-team',
      subjectKey: n.oid,
      title: `${n.name ?? n.email ?? 'A manager'} has ${people(reports)} under them and no Business Unit above them.`,
      detail: regionId
        ? `All of them are in ${regionName(regionId)}'s Unplaced.`
        : 'They have no region yet. Pick one on the Regions step, then come back.',
      data: {
        oid: n.oid,
        name: n.name,
        email: n.email,
        department: n.department,
        users: n.users,
        regionId,
        parentUnitId,
        parentUnitName: parentUnitId ? (names.unit.get(parentUnitId) ?? null) : null,
      },
    })
  }

  // New head: someone with no leader at or above them who is above two or more
  // leaders of ONE region and of no other, e.g. a head hired while the region's line
  // leaders stood in as its leaders. Only the highest such person in a branch; never
  // the top person, who sits above the regions.
  const leadersBelow = new Map<string, Map<string, number>>()
  for (const [leaderOid, regionId] of config.leaderMap) {
    for (const above of tree.meta.get(leaderOid)?.chainUp.slice(1) ?? []) {
      const byRegion = leadersBelow.get(above) ?? new Map<string, number>()
      byRegion.set(regionId, (byRegion.get(regionId) ?? 0) + 1)
      leadersBelow.set(above, byRegion)
    }
  }
  const headOf = (oid: string): { regionId: string; count: number } | null => {
    if (!top || oid === top.oid || config.leaderMap.has(oid)) return null
    const m = tree.meta.get(oid)
    const below = leadersBelow.get(oid)
    if (!m || below?.size !== 1) return null
    if (m.chainUp.slice(1).some((o) => config.leaderMap.has(o))) return null
    const [regionId, count] = [...below][0]!
    return count >= 2 ? { regionId, count } : null
  }
  const newHeads = new Map<string, { regionId: string; count: number }>()
  for (const n of tree.nodes) {
    const head = headOf(n.oid)
    if (!head || (n.parentOid && headOf(n.parentOid)?.regionId === head.regionId)) continue
    newHeads.set(n.oid, head)
  }

  // Owner left / leader left.
  for (const oid of input.notFound) {
    const p = who(oid)
    const ids = input.principals.get(oid)
    const units = config.unitOwnerMap.get(oid) ?? []
    if (units.length) {
      const unitList = units.map((u) => unitName(u.orgUnitId)).join(', ')
      out.push({
        kind: 'owner-left',
        subjectKey: oid,
        title: `${label(oid)} owns ${unitList} but was not found in the directory.`,
        detail: 'The latest directory read could not find them. Choose a new owner, or open the Business Unit.',
        // One unit per owner is the rule; the list covers legacy multi-owners.
        data: {
          oid,
          ...p,
          orgUnitId: units[0]!.orgUnitId,
          unitName: unitName(units[0]!.orgUnitId),
          regionId: units[0]!.regionId,
          units: units.map((u) => ({ orgUnitId: u.orgUnitId, name: unitName(u.orgUnitId), regionId: u.regionId })),
          ...(ids?.teammateId ? { ownerTeammateId: ids.teammateId } : {}),
        },
      })
    }
    const leads = config.leaderMap.get(oid)
    if (leads) {
      out.push({
        kind: 'leader-left',
        subjectKey: oid,
        title: `${label(oid)} leads ${regionName(leads)} but was not found in the directory.`,
        detail: 'The latest directory read could not find them. Choose a new leader, or open the region.',
        data: {
          oid,
          ...p,
          regionId: leads,
          regionName: names.region.get(leads) ?? null,
          ...(ids?.leaderId ? { leaderId: ids.leaderId } : {}),
        },
      })
    }
  }

  // No placement, grouped by the highest manager under the top. A no-signal person
  // has no leader anywhere in their chain.
  const judged = judgeRows(rows, config)
  const noSignal = new Map<string, number>()
  /** Heads who are themselves among their count (chain index 0 is the person). */
  const headCounted = new Set<string>()
  let lookupFailed = 0
  let walkIncomplete = 0
  for (const j of judged) {
    if (j.verdict === 'lookup-failed') lookupFailed++
    if (j.verdict === 'walk-incomplete') walkIncomplete++
    // Someone an Admin placed by hand is settled; Review still lists them.
    if (j.verdict !== 'no-signal' || j.row.manual) continue
    const chain = j.row.evidence.chain
    const k = top ? chain.findIndex((l) => l.oid === top.oid) : chain.length - 1
    if (k < 0) continue // outside the top: its own card
    const head = chain[Math.max(0, k - 1)]?.oid
    // The top person sits above the regions, so having none is not a decision.
    if (head === top?.oid) continue
    if (head) noSignal.set(head, (noSignal.get(head) ?? 0) + 1)
    if (head && head === chain[0]?.oid) headCounted.add(head)
  }
  const isDismissed = (kind: DecisionKind, key: string) =>
    (DISMISSIBLE_KINDS as readonly string[]).includes(kind) && input.dismissed.has(dismissalKey(kind, key))
  for (const [oid, head] of newHeads) {
    const region = regionName(head.regionId)
    const unplaced = noSignal.get(oid) ?? 0
    // Both cards open the Regions step at the same person, so the head card says
    // what the no-placement one would have, and replaces it unless it was set aside.
    if (!isDismissed('new-head', oid)) noSignal.delete(oid)
    out.push({
      kind: 'new-head',
      subjectKey: oid,
      title: `${label(oid)} is above ${head.count} of ${region}'s leaders.`,
      detail:
        `If they now lead ${region}, make them its leader on the Regions step; it shows who would move before anything is saved.` +
        (unplaced ? ` ${people(unplaced)} in their branch ${unplaced === 1 ? 'has' : 'have'} no region today.` : ''),
      data: { oid, ...who(oid), regionId: head.regionId, regionName: names.region.get(head.regionId) ?? null, count: head.count },
    })
  }

  for (const [oid, count] of [...noSignal].sort((a, b) => b[1] - a[1])) {
    const p = who(oid)
    // "Under them" never includes them, so a head counted in their own group is named.
    const under = headCounted.has(oid) ? count - 1 : count
    out.push({
      kind: 'no-placement',
      subjectKey: oid,
      title:
        under === 0
          ? `${label(oid)} has no region.`
          : headCounted.has(oid)
            ? `${label(oid)} and ${people(under)} under them have no region.`
            : `${people(under)} under ${label(oid)} ${under === 1 ? 'has' : 'have'} no region.`,
      detail: 'No region leader, Business Unit owner or directory rule places them.',
      data: { oid, ...p, count },
    })
  }

  if (lookupFailed + walkIncomplete > 0) {
    const parts = [
      lookupFailed ? `${people(lookupFailed)} could not be looked up` : null,
      walkIncomplete ? `${people(walkIncomplete)} had a manager chain that stopped before the top` : null,
    ].filter(Boolean)
    out.push({
      kind: 'not-read',
      subjectKey: 'not-read',
      title: `${people(lookupFailed + walkIncomplete)} could not be read from the directory.`,
      detail: `${parts.join(', and ')}. They stay where they are.`,
      data: { lookupFailed, walkIncomplete },
    })
  }

  if (top && tree.outsideTop > 0) {
    out.push({
      kind: 'outside-top',
      subjectKey: 'outside-top',
      title: `${people(tree.outsideTop)} ${tree.outsideTop === 1 ? 'does' : 'do'} not report up to ${top.name ?? top.email ?? 'the top person'}.`,
      detail: 'Their manager chain reaches the top of the directory without passing through them.',
      data: { count: tree.outsideTop },
    })
  }

  // Unit under another region's leader: the owner's nearest leader, themself included.
  const ownRow = new Map(rows.map((r) => [r.evidence.chain[0]?.oid, r]))
  for (const [oid, units] of config.unitOwnerMap) {
    const chain = ownRow.get(oid)?.evidence.chain
    if (!chain) continue
    const leader = chain.slice(0, config.maxHops + 1).find((l) => config.leaderMap.has(l.oid))
    if (!leader) continue
    const leaderRegion = config.leaderMap.get(leader.oid)!
    for (const u of units) {
      if (u.regionId === leaderRegion) continue
      const via =
        leader.oid === oid
          ? `its owner ${label(oid)} leads ${regionName(leaderRegion)}`
          : `its owner ${label(oid)} reports to ${leader.name ?? leader.email ?? 'the leader'} of ${regionName(leaderRegion)}`
      out.push({
        kind: 'unit-under-other-region',
        subjectKey: u.orgUnitId,
        title: `${unitName(u.orgUnitId)} is in ${regionName(u.regionId)}, but ${via}.`,
        detail: 'Its people follow the unit, so they stay in its region. Moving a unit to another region is not supported yet.',
        data: {
          orgUnitId: u.orgUnitId,
          unitName: names.unit.get(u.orgUnitId) ?? null,
          regionId: u.regionId,
          ownerOid: oid,
          leaderOid: leader.oid,
          leaderRegionId: leaderRegion,
        },
      })
    }
  }

  const order = (k: DecisionKind) => DECISION_KINDS.indexOf(k)
  return out
    .filter((d) => !isDismissed(d.kind, d.subjectKey))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => order(a.d.kind) - order(b.d.kind) || a.i - b.i)
    .map(({ d }) => d)
}
