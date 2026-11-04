/*
 * The placement-check API contract (docs/design/placement-check/00-spec.md P5–P8).
 * Server routes and the admin page both import these; change them together.
 */

/** One person in a manager chain; index 0 is the teammate themself. */
export interface ChainLink {
  oid: string
  name: string | null
  email: string | null
}

export type WalkEnd = 'top-of-chart' | 'hop-cap' | 'cycle' | 'graph-error' | 'not-in-directory'

export type PlacementStep = 'unit-rule' | 'chain-unit' | 'chain-region' | 'region-rule'

export const PLACEMENT_VERDICTS = [
  'ok',
  'unit-unverified',
  'move-region',
  'move-unit',
  'place',
  'needs-owner',
  'ambiguous-owner',
  'walk-incomplete',
  'no-signal',
  'lookup-failed',
  'manual',
] as const
export type PlacementVerdict = (typeof PLACEMENT_VERDICTS)[number]

/** Verdicts Apply accepts. `manual` additionally needs `confirmManual`. */
export const APPLICABLE_VERDICTS = ['move-region', 'move-unit', 'place', 'manual'] as const

export interface PlacementHome {
  regionId: string | null
  regionName: string | null
  orgUnitId: string | null
  orgUnitName: string | null
  /** On a holding node (Unplaced, or the global unassigned bucket). */
  onHolding: boolean
}

/** What the page saw; Apply refuses unless the row still matches it. */
export interface PlacementSeen {
  regionId: string | null
  orgUnitId: string | null
  /** `metadata.placedVia` and its sibling keys (PLACEMENT_PROVENANCE_KEYS), null when none. */
  provenance: Record<string, string> | null
}

export interface PlacementCheckRow {
  teammateId: string
  name: string | null
  email: string
  current: PlacementHome
  /** Null fields when nothing was derived. */
  derived: PlacementHome & { step: PlacementStep | null }
  verdict: PlacementVerdict
  /** The current home was set by a person (manualPlacementSql). */
  manual: boolean
  provenance: Record<string, string> | null
  spend30d: number
  gatheredAt: string
  why: {
    /** The deciding rule (step unit-rule / region-rule) only. */
    rule: { attribute: string; value: string } | null
    /** A region rule that matched but lost to the reporting line (step chain-unit / chain-region). */
    overruledRule?: { attribute: string; value: string } | null
    owner: { oid: string; name: string | null } | null
    leader: { oid: string; name: string | null } | null
    ambiguousOwners: Array<{ oid: string; name: string | null; unitNames: string[] }>
    chain: ChainLink[]
    walkEnd: WalkEnd
  }
  seen: PlacementSeen
}

export interface PlacementCheckResponse {
  cycle: { id: string; startedAt: string } | null
  /** Active teammates not yet gathered in this cycle. */
  remaining: number
  /** People whose lookup failed in this cycle: what "Retry failed" would re-gather. */
  failedThisCycle: number
  evidenceAge: { oldest: string | null; newest: string | null }
  summary: Array<{ verdict: PlacementVerdict; count: number; spend30d: number }>
  rows: PlacementCheckRow[]
}

export interface PlacementPassResponse {
  checked: number
  errors: number
  remaining: number
}

/** Most items one Apply call takes (the bulk-place cap). */
export const PLACEMENT_APPLY_MAX = 200

export interface PlacementApplyRequest {
  items: PlacementApplyItem[]
}

export interface PlacementApplyItem {
  teammateId: string
  seen: PlacementSeen
  /** `orgUnitId` null = the target region's holding (Unplaced) node, for a region-only derivation. */
  target: { regionId: string; orgUnitId: string | null }
  confirmManual?: boolean
}

export type PlacementApplyRefusal =
  | 'changed-since-check'
  | 'manual-not-confirmed'
  | 'derivation-changed'
  | 'target-invalid'
  | 'not-found'
  | 'error'

export interface PlacementApplyResponse {
  batchId: string
  results: Array<{ teammateId: string; outcome: 'moved' | 'refused'; reason?: PlacementApplyRefusal }>
}

export interface PlacementRulePreviewRequest {
  attribute: string
  match_mode: string
  match_value: string
  region_id?: string
  org_unit_id?: string
}

export interface PlacementRulePreviewResponse {
  evidenceAge: { oldest: string | null; newest: string | null }
  /** People with no evidence yet or a failed lookup; the preview cannot speak for them. */
  unchecked: number
  /** `from` = derived home under the live rules; `to` = derived home with the proposed rule added (same live owners and leaders). */
  changes: Array<{ teammateId: string; name: string | null; email: string; from: PlacementHome; to: PlacementHome }>
}
