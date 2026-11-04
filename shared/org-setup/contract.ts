/*
 * The Org setup API contract (docs/design/org-setup/00-spec.md). Server routes and
 * the admin page both import these; change them together.
 */
import type { PlacementStep, PlacementVerdict } from '../placement/placement-check'

export const READ_CADENCES = ['month', 'week'] as const
export type ReadCadence = (typeof READ_CADENCES)[number]

export interface OrgSetupSettings {
  /** Null until an Admin picks the top of the organisation. */
  top: { oid: string; name: string | null; email: string | null } | null
  readCadence: ReadCadence
  updatedAt: string | null
}

/** PUT body; omit a field to leave it unchanged. */
export interface OrgSetupSettingsUpdate {
  top?: { oid: string; name: string | null; email: string | null }
  readCadence?: ReadCadence
}

export interface OrgSetupRead {
  cycleId: string | null
  startedAt: string | null
  /** Population members with no evidence in the cycle yet. */
  remaining: number
  /** Lookups that failed in the cycle (stored, retryable). */
  failed: number
  /** True when remaining is 0. */
  complete: boolean
}

export interface OrgTreeNode {
  oid: string
  name: string | null
  email: string | null
  /** From the node's own evidence; null when the node is not a TokenScope user. */
  department: string | null
  /** Next manager up; null at the top person. */
  parentOid: string | null
  /** Users at or under this node (the node included when it is a user). */
  users: number
  /** Of those users, how many are in each region today, by region id. */
  regionCounts: Record<string, number>
  spend30d: number
  /** Region this node leads, when they are an active region leader. */
  leaderOf: { regionId: string; regionName: string } | null
  /** Units this node owns (active, cost-owning). More than one is the ambiguous case. */
  owns: { orgUnitId: string; name: string; regionId: string }[]
  /** Of the users under them, how many each step decides (null = nothing decides). */
  decidedBy: Partial<Record<PlacementStep | 'none', number>>
}

/** A region as the overview shows it: coverage from CURRENT homes, leaders from the
 *  leader table (a leader need not be in the tree). */
export interface OrgTreeRegion {
  id: string
  name: string
  /** Population users whose current home is this region. */
  users: number
  /** Of those, how many sit in a Business Unit today (not on a holding node). */
  inUnit: number
  leaders: { leaderId: string; oid: string; name: string | null; email: string | null }[]
}

/** The top person's own home in TokenScope today, as the overview names it. */
export type OrgSetupTopHome =
  | { kind: 'not-a-user' }
  | { kind: 'unassigned'; teammateId: string; email: string; regionId: string }
  | { kind: 'placed'; teammateId: string; email: string; regionId: string; regionName: string; unitName: string }

export interface OrgTreeResponse {
  settings: OrgSetupSettings
  /** Null when no top is set. */
  topHome: OrgSetupTopHome | null
  read: OrgSetupRead
  regions: OrgTreeRegion[]
  /** Every node reachable from the top, top first. Empty when no top is set. */
  nodes: OrgTreeNode[]
  /** Users whose complete chain does not reach the top person. */
  outsideTop: number
}

/** A change the Admin is considering but has not saved. */
export interface ProposedChanges {
  /** regionId null = stop being a leader. */
  leaders: { oid: string; regionId: string | null }[]
  /** New units, keyed by the client so previews can name them before they exist. */
  newUnits: { key: string; ownerOid: string; regionId: string; name: string }[]
}

export interface PlacementMoveGroup {
  from: { regionId: string | null; regionName: string | null; orgUnitId: string | null; orgUnitName: string | null }
  /** `orgUnitId` may be a ProposedChanges.newUnits key. */
  to: { regionId: string | null; regionName: string | null; orgUnitId: string | null; orgUnitName: string | null }
  verdict: PlacementVerdict
  count: number
  spend30d: number
}

export interface OrgSetupPreviewResponse {
  /** Per node oid: what the PROPOSAL changes for the users under them, i.e. people
   *  whose derived home differs between the current config and the proposed one.
   *  Moves already waiting under the current config are not counted here. */
  byNode: Record<string, { regionChanges: number; unitChanges: number; groups: PlacementMoveGroup[] }>
  /** Everyone, grouped; the step-4 summary. */
  groups: PlacementMoveGroup[]
  /** Verdicts Apply does not take, with counts. */
  notMoved: Partial<Record<PlacementVerdict, number>>
  /** People placed by hand whose derived home differs. */
  manual: { teammateId: string; name: string | null; email: string; from: string; to: string }[]
}

export const ORG_SETUP_UNITS_MAX = 50

export interface OrgSetupUnitItem {
  ownerOid: string
  name: string
  regionId: string
  parentUnitId: string | null
}

export type OrgSetupUnitResult =
  | { ownerOid: string; status: 'created'; orgUnitId: string; code: string }
  | { ownerOid: string; status: 'refused'; reason: string; detail: string }

export interface OrgSetupUnitsResponse {
  results: OrgSetupUnitResult[]
}

export const DECISION_KINDS = [
  'moves-waiting',
  'new-team',
  'new-head',
  'owner-left',
  'leader-left',
  'no-placement',
  'not-read',
  'outside-top',
  'unit-under-other-region',
] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** Kinds the Admin can dismiss until a later cycle. */
export const DISMISSIBLE_KINDS = ['new-team', 'new-head', 'unit-under-other-region'] as const

/**
 * What each kind carries (the page reads only these keys):
 *   moves-waiting           count, groups
 *   new-team                oid, name, email, department, users, regionId, parentUnitId, parentUnitName
 *   new-head                oid, name, email, regionId, regionName, count
 *   owner-left              oid, name, email, orgUnitId, unitName, regionId, units, ownerTeammateId
 *   leader-left             oid, name, email, regionId, regionName, leaderId
 *   no-placement            oid, name, email, count
 *   not-read                lookupFailed, walkIncomplete
 *   outside-top             count
 *   unit-under-other-region orgUnitId, unitName, regionId, ownerOid, leaderOid, leaderRegionId
 */
export interface OrgSetupDecisionData {
  count?: number
  groups?: PlacementMoveGroup[]
  oid?: string
  name?: string | null
  email?: string | null
  department?: string | null
  users?: number
  /** Null on a new-team card whose people sit on the global unassigned bucket. */
  regionId?: string | null
  regionName?: string | null
  /** new-team: the unit a new unit would sit inside (the region's default unit). */
  parentUnitId?: string | null
  parentUnitName?: string | null
  orgUnitId?: string
  unitName?: string | null
  units?: { orgUnitId: string; name: string | null; regionId: string }[]
  ownerOid?: string
  /** owner-left: the departed owner's teammate id, for the revoke. */
  ownerTeammateId?: string
  /** leader-left: the departed leader's region_leader row id, for the revoke. */
  leaderId?: string
  leaderOid?: string
  leaderRegionId?: string
  lookupFailed?: number
  walkIncomplete?: number
}

export interface OrgSetupDecision {
  kind: DecisionKind
  /** Stable within a cycle: the dismissal key. */
  subjectKey: string
  title: string
  detail: string
  /** Kind-specific payload the page needs for its actions. */
  data: OrgSetupDecisionData
}

export interface OrgSetupDecisionsResponse {
  read: OrgSetupRead
  decisions: OrgSetupDecision[]
}
