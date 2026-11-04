/*
 * What a proposed Org setup change does (docs/design/org-setup/00-spec.md, "The rule
 * every screen follows"): every person decided by decidePlacement under the live
 * config with the proposal applied, and judged by classifyPlacement against their
 * current home exactly as the placement check judges them. Pure.
 */
import {
  APPLICABLE_VERDICTS,
  type PlacementVerdict,
} from '../../shared/placement/placement-check'
import type { OrgSetupPreviewResponse, PlacementMoveGroup, ProposedChanges } from '../../shared/org-setup/contract'
import type { Names } from './placement-check-read'
import type { OrgSetupRow } from './org-setup-tree'
import { classifyPlacement } from './placement-verdict'
import { decidePlacement, type OwnedUnit, type PlacementConfig, type PlacementDecision } from './region-derivation'

export const EMPTY_PROPOSAL: ProposedChanges = { leaders: [], newUnits: [] }

/** Verdicts Apply takes; `manual` is listed apart, before this is consulted. */
const MOVED_VERDICTS: ReadonlySet<PlacementVerdict> = new Set(APPLICABLE_VERDICTS)

/**
 * The live config with the proposal applied, on copies. A new unit for someone who
 * already owns one is left out: saving it is refused (one owner, one Business Unit).
 */
export function withProposedChanges(live: PlacementConfig, changes: ProposedChanges): PlacementConfig {
  const leaderMap = new Map(live.leaderMap)
  for (const l of changes.leaders) {
    if (l.regionId === null) leaderMap.delete(l.oid)
    else leaderMap.set(l.oid, l.regionId)
  }
  const unitOwnerMap = new Map<string, OwnedUnit[]>([...live.unitOwnerMap].map(([oid, units]) => [oid, [...units]]))
  for (const u of changes.newUnits) {
    if (unitOwnerMap.get(u.ownerOid)?.length) continue
    unitOwnerMap.set(u.ownerOid, [{ orgUnitId: u.key, regionId: u.regionId }])
  }
  return { ...live, leaderMap, unitOwnerMap }
}

export interface JudgedRow {
  row: OrgSetupRow
  decision: PlacementDecision
  verdict: PlacementVerdict
}

export function judgeRows(rows: readonly OrgSetupRow[], config: PlacementConfig): JudgedRow[] {
  return rows.map((row) => {
    const decision = decidePlacement(row.evidence, config)
    const verdict = classifyPlacement({
      walkEnd: row.evidence.walkEnd,
      decision,
      current: { regionId: row.regionId, orgUnitId: row.orgUnitId, onHolding: row.onHolding },
      manual: row.manual,
    })
    return { row, decision, verdict }
  })
}

type Home = PlacementMoveGroup['from']

export function homeNamer(names: Names, changes: ProposedChanges) {
  const newUnitNames = new Map(changes.newUnits.map((u) => [u.key, u.name]))
  return (regionId: string | null, orgUnitId: string | null): Home => ({
    regionId,
    regionName: regionId ? (names.region.get(regionId) ?? null) : null,
    orgUnitId,
    orgUnitName: orgUnitId ? (names.unit.get(orgUnitId) ?? newUnitNames.get(orgUnitId) ?? null) : null,
  })
}

function addToGroups(groups: Map<string, PlacementMoveGroup>, j: JudgedRow, name: ReturnType<typeof homeNamer>) {
  const toRegion = j.decision.regionId ?? null
  const toUnit = j.decision.orgUnitId ?? null
  const key = [j.row.regionId, j.row.orgUnitId, toRegion, toUnit, j.verdict].join('|')
  let g = groups.get(key)
  if (!g) {
    g = { from: name(j.row.regionId, j.row.orgUnitId), to: name(toRegion, toUnit), verdict: j.verdict, count: 0, spend30d: 0 }
    groups.set(key, g)
  }
  g.count++
  g.spend30d += j.row.spend30d
}

const sortGroups = (groups: Map<string, PlacementMoveGroup>) =>
  [...groups.values()].sort((a, b) => b.count - a.count || b.spend30d - a.spend30d)

function homeLabel(h: Home): string {
  return `${h.regionName ?? 'No region'} / ${h.orgUnitName ?? 'Unplaced'}`
}

const derivedHomeKey = (d: PlacementDecision) => `${d.regionId ?? ''}|${d.orgUnitId ?? ''}`

/**
 * Who would move under the proposal: `groups`, `notMoved` and `manual` describe
 * everyone whose verdict is not `ok` under the live config with the proposal
 * applied, moves already waiting included. `byNode` is narrower: per chain member,
 * the people at or under them whom Apply would move AND whose derived home the
 * proposal changed (it differs from what the live config alone derives). A move
 * that was waiting before the proposal is not the proposal's doing, so a row's
 * "what this changes" stays 0 for a choice that does not touch it.
 */
export function previewOrgSetup(
  rows: readonly OrgSetupRow[],
  live: PlacementConfig,
  changes: ProposedChanges,
  names: Names,
): OrgSetupPreviewResponse {
  const name = homeNamer(names, changes)
  const judged = judgeRows(rows, withProposedChanges(live, changes))
  const baseline = rows.map((row) => derivedHomeKey(decidePlacement(row.evidence, live)))
  const groups = new Map<string, PlacementMoveGroup>()
  const nodeGroups = new Map<string, Map<string, PlacementMoveGroup>>()
  const byNode: OrgSetupPreviewResponse['byNode'] = {}
  const notMoved: OrgSetupPreviewResponse['notMoved'] = {}
  const manual: OrgSetupPreviewResponse['manual'] = []

  for (const [i, j] of judged.entries()) {
    for (const link of j.row.evidence.chain) {
      byNode[link.oid] ??= { regionChanges: 0, unitChanges: 0, groups: [] }
    }
    if (j.verdict === 'ok') continue
    if (j.verdict === 'manual') {
      manual.push({
        teammateId: j.row.teammateId,
        name: j.row.name,
        email: j.row.email,
        from: homeLabel(name(j.row.regionId, j.row.orgUnitId)),
        to: homeLabel(name(j.decision.regionId ?? null, j.decision.orgUnitId ?? null)),
      })
      continue
    }
    if (!MOVED_VERDICTS.has(j.verdict)) {
      notMoved[j.verdict] = (notMoved[j.verdict] ?? 0) + 1
      continue
    }
    addToGroups(groups, j, name)
    if (derivedHomeKey(j.decision) === baseline[i]) continue // waiting already; not this proposal's change
    const regionChange = j.decision.regionId !== j.row.regionId
    // A region-only move lands on the target region's holding node: a unit change too.
    const unitChange = (j.decision.orgUnitId ?? null) !== j.row.orgUnitId
    for (const link of j.row.evidence.chain) {
      const n = byNode[link.oid]!
      if (regionChange) n.regionChanges++
      if (unitChange) n.unitChanges++
      let ng = nodeGroups.get(link.oid)
      if (!ng) {
        ng = new Map()
        nodeGroups.set(link.oid, ng)
      }
      addToGroups(ng, j, name)
    }
  }
  for (const [oid, ng] of nodeGroups) byNode[oid]!.groups = sortGroups(ng)
  manual.sort((a, b) => a.email.localeCompare(b.email))
  return { byNode, groups: sortGroups(groups), notMoved, manual }
}
