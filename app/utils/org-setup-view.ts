/*
 * Pure view logic for /admin/org-setup (docs/design/org-setup/00-spec.md, Screens).
 *
 * Structure only: which rows to show, what a draft proposes, where a new unit nests.
 * Nothing here works out where a person is placed; every "what this changes" number
 * comes from POST /api/v1/admin/org-setup/preview.
 */
import type {
  OrgSetupDecision,
  OrgSetupDecisionsResponse,
  OrgSetupSettings,
  OrgSetupUnitItem,
  OrgSetupUnitResult,
  OrgSetupUnitsResponse,
  OrgTreeNode,
  PlacementMoveGroup,
  ProposedChanges,
} from '#shared/org-setup/contract'
import { ORG_SETUP_UNITS_MAX } from '#shared/org-setup/contract'
import type { PlacementCheckRow, PlacementVerdict } from '#shared/placement/placement-check'
import { BU_LABEL } from '#shared/reports/vocabulary'
import { NO_UNIT, isPlacementApplicable } from './placement-check-view'

export const REGION_ROW_MIN_USERS = 5
export const MOST_THERE_SHARE = 0.8

export function nodeLabel(n: Pick<OrgTreeNode, 'name' | 'email' | 'oid'>): string {
  return n.name ?? n.email ?? n.oid
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`
}

export function indexNodes(nodes: readonly OrgTreeNode[]): Map<string, OrgTreeNode> {
  return new Map(nodes.map((n) => [n.oid, n]))
}

/** Direct reports of `oid`, most users first. */
export function childNodes(nodes: readonly OrgTreeNode[], oid: string): OrgTreeNode[] {
  return nodes.filter((n) => n.parentOid === oid).sort((a, b) => b.users - a.users || nodeLabel(a).localeCompare(nodeLabel(b)))
}

/** Step 2 rows: the top's direct reports; those with fewer than 5 users fold away. */
export function regionRows(nodes: readonly OrgTreeNode[], topOid: string) {
  const all = childNodes(nodes, topOid).filter((n) => n.users > 0)
  const main = all.filter((n) => n.users >= REGION_ROW_MIN_USERS)
  const small = all.filter((n) => n.users < REGION_ROW_MIN_USERS)
  return { main, small, smallPeople: small.reduce((s, n) => s + n.users, 0) }
}

/** Every ancestor of `oid`, nearest first, stopping before the top (parentOid null). */
export function ancestors(byOid: Map<string, OrgTreeNode>, oid: string): OrgTreeNode[] {
  const out: OrgTreeNode[] = []
  const seen = new Set<string>([oid])
  let cur = byOid.get(oid)?.parentOid ?? null
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const n = byOid.get(cur)
    if (!n) break
    out.push(n)
    cur = n.parentOid
  }
  return out
}

export function mostAlreadyThere(node: OrgTreeNode, regionId: string | null): boolean {
  if (!regionId || node.users === 0) return false
  return (node.regionCounts[regionId] ?? 0) / node.users >= MOST_THERE_SHARE
}

/** Unsaved leader picks: oid → region id, or null for "not a leader". Absent = unchanged. */
export type LeaderChoices = Record<string, string | null>

export function effectiveLeaderRegion(node: OrgTreeNode, choices: LeaderChoices): string | null {
  return node.oid in choices ? (choices[node.oid] ?? null) : (node.leaderOf?.regionId ?? null)
}

/** The picks that differ from what is saved. */
export function proposedLeaders(nodes: readonly OrgTreeNode[], choices: LeaderChoices): ProposedChanges['leaders'] {
  const byOid = indexNodes(nodes)
  return Object.entries(choices)
    .filter(([oid, regionId]) => {
      const n = byOid.get(oid)
      return n != null && (n.leaderOf?.regionId ?? null) !== regionId
    })
    .map(([oid, regionId]) => ({ oid, regionId }))
}

/** Saving the picks: revoke every changed saved leader first, then assign the new picks. */
export function leaderDiff(nodes: readonly OrgTreeNode[], choices: LeaderChoices) {
  const byOid = indexNodes(nodes)
  const revoke: { oid: string; regionId: string }[] = []
  const assign: { node: OrgTreeNode; regionId: string }[] = []
  for (const { oid, regionId } of proposedLeaders(nodes, choices)) {
    const n = byOid.get(oid)!
    if (n.leaderOf) revoke.push({ oid, regionId: n.leaderOf.regionId })
    if (regionId) assign.push({ node: n, regionId })
  }
  return { revoke, assign }
}

type Side = PlacementMoveGroup['from']

function aggregate(groups: readonly PlacementMoveGroup[], differs: (g: PlacementMoveGroup) => boolean, name: (s: Side) => string) {
  const totals = new Map<string, number>()
  for (const g of groups) {
    if (!differs(g) || g.count === 0) continue
    const key = `${name(g.from)}\u0000${name(g.to)}`
    totals.set(key, (totals.get(key) ?? 0) + g.count)
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000')
      return `${plural(count, 'moves', 'move')} from ${from} to ${to}`
    })
}

const regionName = (s: Side) => s.regionName ?? 'no region'
const unitName = (s: Side) => s.orgUnitName ?? (s.regionName ? `${s.regionName}, no ${BU_LABEL}` : 'nowhere')

/** "40 move from APAC to EMEA", one line per region pair, from a preview's groups. */
export function regionChangeLines(groups: readonly PlacementMoveGroup[]): string[] {
  return aggregate(groups, (g) => g.from.regionId !== g.to.regionId, regionName)
}

/** "12 move from Unplaced to Cloud & Data", for unit changes within the same region. */
export function unitChangeLines(groups: readonly PlacementMoveGroup[]): string[] {
  return aggregate(groups, (g) => g.from.regionId === g.to.regionId && g.from.orgUnitId !== g.to.orgUnitId, unitName)
}

// ── Business Units ───────────────────────────────────────────────────────────

export function ownsIn(node: OrgTreeNode, regionId: string) {
  return node.owns.find((o) => o.regionId === regionId) ?? null
}
export function ownsElsewhere(node: OrgTreeNode, regionId: string) {
  return ownsIn(node, regionId) ? null : (node.owns[0] ?? null)
}

/** The region's leader nodes that have no leader of the same region above them. */
export function regionRoots(nodes: readonly OrgTreeNode[], regionId: string, choices: LeaderChoices): OrgTreeNode[] {
  const byOid = indexNodes(nodes)
  return nodes.filter(
    (n) =>
      effectiveLeaderRegion(n, choices) === regionId &&
      !ancestors(byOid, n.oid).some((a) => effectiveLeaderRegion(a, choices) === regionId),
  )
}

export interface UnitRow {
  node: OrgTreeNode
  depth: number
}

/** The subtree under the region's leaders, depth first; a branch led for another region is left out. */
export function unitRows(nodes: readonly OrgTreeNode[], regionId: string, choices: LeaderChoices): UnitRow[] {
  const out: UnitRow[] = []
  const seen = new Set<string>()
  const managers = managersWithReports(nodes)
  const walk = (n: OrgTreeNode, depth: number) => {
    if (seen.has(n.oid)) return
    seen.add(n.oid)
    out.push({ node: n, depth })
    for (const c of childNodes(nodes, n.oid)) {
      const led = effectiveLeaderRegion(c, choices)
      if (c.users === 0 || (led && led !== regionId)) continue
      // Nobody reports to them and they own nothing: there is no decision to make.
      if (!managers.has(c.oid) && !c.owns.length) continue
      walk(c, depth + 1)
    }
  }
  for (const r of regionRoots(nodes, regionId, choices).sort((a, b) => b.users - a.users)) {
    if (managers.has(r.oid) || r.owns.length) walk(r, 0)
  }
  return out
}

export function defaultUnitName(node: OrgTreeNode): string {
  return node.department?.trim() || `${node.name ?? node.email ?? 'Unnamed'}'s team`
}

const NEW_UNIT_PREFIX = 'new:'

export function newUnitKey(ownerOid: string): string {
  return `${NEW_UNIT_PREFIX}${ownerOid}`
}

/** A unit id a preview names before the unit exists (`withCreatedUnitIds` replaces it once it does). */
export function isDraftUnitKey(id: string | null): boolean {
  return id !== null && id.startsWith(NEW_UNIT_PREFIX)
}

/** Unsaved new units, by owner oid. */
export type DraftUnits = Record<string, { regionId: string; name: string }>

export type UnitParent = { kind: 'existing'; orgUnitId: string; name: string } | { kind: 'new'; ownerOid: string; name: string }

/** Nearest manager above `oid` who is ticked or owns a unit in the same region; null = the region's default unit. */
export function unitParent(nodes: readonly OrgTreeNode[], oid: string, regionId: string, drafts: DraftUnits): UnitParent | null {
  for (const a of ancestors(indexNodes(nodes), oid)) {
    const d = drafts[a.oid]
    if (d && d.regionId === regionId) return { kind: 'new', ownerOid: a.oid, name: d.name }
    const own = ownsIn(a, regionId)
    if (own) return { kind: 'existing', orgUnitId: own.orgUnitId, name: own.name }
  }
  return null
}

export function proposedNewUnits(drafts: DraftUnits): ProposedChanges['newUnits'] {
  return Object.entries(drafts).map(([ownerOid, d]) => ({ key: newUnitKey(ownerOid), ownerOid, regionId: d.regionId, name: d.name }))
}

/**
 * Creates the drafted units, parents before children: a child of a new unit is sent
 * once its parent's id exists, at most ORG_SETUP_UNITS_MAX per call. A child whose
 * parent was refused is refused here without a call.
 */
export async function saveDraftUnits(
  nodes: readonly OrgTreeNode[],
  drafts: DraftUnits,
  post: (items: OrgSetupUnitItem[]) => Promise<OrgSetupUnitsResponse>,
): Promise<{ results: Map<string, OrgSetupUnitResult>; error: unknown }> {
  const results = new Map<string, OrgSetupUnitResult>()
  const created = new Map<string, string>()
  let pending = Object.entries(drafts).map(([ownerOid, d]) => ({ ownerOid, ...d, parent: unitParent(nodes, ownerOid, d.regionId, drafts) }))
  try {
    while (pending.length) {
      const ready: OrgSetupUnitItem[] = []
      const wait: typeof pending = []
      for (const p of pending) {
        const item = { ownerOid: p.ownerOid, name: p.name.trim(), regionId: p.regionId }
        if (!p.parent) ready.push({ ...item, parentUnitId: null })
        else if (p.parent.kind === 'existing') ready.push({ ...item, parentUnitId: p.parent.orgUnitId })
        else if (created.has(p.parent.ownerOid)) ready.push({ ...item, parentUnitId: created.get(p.parent.ownerOid)! })
        else if (results.has(p.parent.ownerOid))
          results.set(p.ownerOid, { ownerOid: p.ownerOid, status: 'refused', reason: 'parent-not-created', detail: `The ${BU_LABEL} above it was not created.` })
        else wait.push(p)
      }
      if (!ready.length) {
        for (const p of wait)
          results.set(p.ownerOid, { ownerOid: p.ownerOid, status: 'refused', reason: 'parent-not-created', detail: `The ${BU_LABEL} above it was not created.` })
        break
      }
      for (let i = 0; i < ready.length; i += ORG_SETUP_UNITS_MAX) {
        const res = await post(ready.slice(i, i + ORG_SETUP_UNITS_MAX))
        for (const r of res.results) {
          results.set(r.ownerOid, r)
          if (r.status === 'created') created.set(r.ownerOid, r.orgUnitId)
        }
      }
      pending = wait
    }
  } catch (e: unknown) {
    return { results, error: e }
  }
  return { results, error: null }
}

/** Managers with at least one node reporting to them; the rest are leaves and cannot own a new unit. */
export function managersWithReports(nodes: readonly OrgTreeNode[]): Set<string> {
  return new Set(nodes.map((n) => n.parentOid).filter((p): p is string => p !== null))
}

// ── Review and apply ─────────────────────────────────────────────────────────

/** Verdicts Apply moves without a second confirmation. */
export const MOVE_VERDICTS: readonly PlacementVerdict[] = ['move-region', 'move-unit', 'place']

export function moveGroups(groups: readonly PlacementMoveGroup[]): PlacementMoveGroup[] {
  return groups.filter((g) => MOVE_VERDICTS.includes(g.verdict) && g.count > 0).sort((a, b) => b.count - a.count)
}

export function sideText(s: Side): string {
  if (!s.regionId) return 'No region'
  return s.orgUnitName ? `${s.regionName ?? 'Unknown region'} · ${s.orgUnitName}` : `${s.regionName ?? 'Unknown region'} · Unplaced`
}

export function groupMovesRegion(g: PlacementMoveGroup): boolean {
  return g.from.regionId !== g.to.regionId
}

/** A placement-check row is in a group when its verdict, current home and derived home are the group's. */
export function rowMatchesGroup(r: PlacementCheckRow, g: PlacementMoveGroup): boolean {
  return (
    g.verdict === r.verdict &&
    g.from.regionId === r.current.regionId &&
    g.from.orgUnitId === r.current.orgUnitId &&
    g.to.regionId === r.derived.regionId &&
    g.to.orgUnitId === r.derived.orgUnitId
  )
}

/** The rows the displayed groups stand for: applicable, not placed by hand, in one of the groups. */
export function rowsInGroups(rows: readonly PlacementCheckRow[], groups: readonly PlacementMoveGroup[]): PlacementCheckRow[] {
  return rows.filter((r) => isPlacementApplicable(r) && r.verdict !== 'manual' && groups.some((g) => rowMatchesGroup(r, g)))
}

/**
 * The rows the Review step applies: the ones its displayed groups stand for, plus
 * the people placed by hand that were ticked. A row in no displayed group is never
 * moved, however applicable the live check says it is.
 */
export function rowsToApply(
  rows: readonly PlacementCheckRow[],
  groups: readonly PlacementMoveGroup[],
  manualTicked: ReadonlySet<string>,
): PlacementCheckRow[] {
  const manual = rows.filter((r) => r.verdict === 'manual' && isPlacementApplicable(r) && manualTicked.has(r.teammateId))
  return [...rowsInGroups(rows, groups), ...manual]
}

/** A preview names a unit that does not exist yet by its draft key; once created, the live check names it by id. */
export function withCreatedUnitIds(groups: readonly PlacementMoveGroup[], created: Readonly<Record<string, string>>): PlacementMoveGroup[] {
  const resolve = (s: Side): Side => (s.orgUnitId && created[s.orgUnitId] ? { ...s, orgUnitId: created[s.orgUnitId]! } : s)
  return groups.map((g) => ({ ...g, from: resolve(g.from), to: resolve(g.to) }))
}

/**
 * `/admin/placement-check` filtered to a group (or a verdict); the page reads these
 * from the query string. A unit left undefined is no filter; null is "no unit".
 */
export function placementCheckLink(f: {
  verdict?: PlacementVerdict | null
  current?: string | null
  derived?: string | null
  currentUnit?: string | null
  derivedUnit?: string | null
}): string {
  const q = new URLSearchParams()
  if (f.verdict) q.set('verdict', f.verdict)
  if (f.current) q.set('current', f.current)
  if (f.derived) q.set('derived', f.derived)
  if (f.currentUnit !== undefined) q.set('currentUnit', f.currentUnit ?? NO_UNIT)
  if (f.derivedUnit !== undefined) q.set('derivedUnit', f.derivedUnit ?? NO_UNIT)
  const s = q.toString()
  return s ? `/admin/placement-check?${s}` : '/admin/placement-check'
}

/**
 * Both regions and both units: two groups in one region (Unplaced → Cloud, Unplaced →
 * Data) get different links. Null for a group that names a unit by its draft key: no
 * row on the placement check has that unit until it is saved, and a link on any
 * wider filter would show other groups' people under this group's count.
 */
export function groupLink(g: PlacementMoveGroup): string | null {
  if (isDraftUnitKey(g.from.orgUnitId) || isDraftUnitKey(g.to.orgUnitId)) return null
  return placementCheckLink({
    verdict: g.verdict,
    current: g.from.regionId,
    derived: g.to.regionId,
    currentUnit: g.from.orgUnitId,
    derivedUnit: g.to.orgUnitId,
  })
}

// ── Overview ─────────────────────────────────────────────────────────────────

/**
 * The `data` keys the page reads per decision kind (OrgSetupDecisionData has them all):
 *   moves-waiting           count, groups: PlacementMoveGroup[]
 *   new-team                oid, name, regionId (null = no region yet), department?, parentUnitId?, parentUnitName?
 *   new-head                oid, name, regionId, regionName
 *   owner-left              oid, name, orgUnitId, unitName, regionId, ownerTeammateId
 *   leader-left             oid, name, regionId, regionName, leaderId
 *   no-placement            oid, name
 *   unit-under-other-region orgUnitId, unitName, regionId
 */
export interface DecisionData {
  count: number | null
  oid: string | null
  name: string | null
  regionId: string | null
  regionName: string | null
  orgUnitId: string | null
  unitName: string | null
  department: string | null
  parentUnitId: string | null
  parentUnitName: string | null
  ownerTeammateId: string | null
  leaderId: string | null
  groups: PlacementMoveGroup[]
}

export function decisionData(d: OrgSetupDecision): DecisionData {
  const v = (d.data ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' && v[k] !== '' ? (v[k] as string) : null)
  return {
    count: typeof v.count === 'number' ? v.count : null,
    oid: str('oid'),
    name: str('name'),
    regionId: str('regionId'),
    regionName: str('regionName'),
    orgUnitId: str('orgUnitId'),
    unitName: str('unitName'),
    department: str('department'),
    parentUnitId: str('parentUnitId'),
    parentUnitName: str('parentUnitName'),
    ownerTeammateId: str('ownerTeammateId'),
    leaderId: str('leaderId'),
    groups: Array.isArray(v.groups) ? (v.groups as PlacementMoveGroup[]) : [],
  }
}

export type HomeCardState = { kind: 'setup' } | { kind: 'decide'; count: number; titles: string[] } | null

/** The Admin home card: set up before a top person exists; then only when something needs deciding. */
export function homeCardState(settings: OrgSetupSettings | null, decisions: OrgSetupDecisionsResponse | null): HomeCardState {
  if (!settings) return null
  if (!settings.top) return { kind: 'setup' }
  const list = decisions?.decisions ?? []
  if (!list.length) return null
  return { kind: 'decide', count: list.length, titles: list.slice(0, 3).map((d) => d.title) }
}
