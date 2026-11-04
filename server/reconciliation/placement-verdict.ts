/*
 * Placement-check verdicts and the rule preview diff (docs/design/placement-check/
 * 00-spec.md P5, P8). Pure: the caller supplies stored evidence, the current home
 * and the live config; nothing here reads the database or the directory.
 */
import type { PlacementVerdict, WalkEnd } from '../../shared/placement/placement-check'
import type { RegionAttributeKey, MatchMode } from '../../shared/placement/region-attributes'
import {
  decidePlacement,
  mapAttributesToRegion,
  type PlacementConfig,
  type PlacementDecision,
  type PlacementEvidence,
  type RegionRuleSet,
  type RuleTarget,
} from './region-derivation'

export interface CurrentHome {
  regionId: string
  orgUnitId: string
  onHolding: boolean
}

/** Evidence the decision can speak for; a failed lookup is undecided. */
export function isUsableEvidence(walkEnd: WalkEnd): boolean {
  return walkEnd !== 'graph-error' && walkEnd !== 'not-in-directory'
}

/** A unit rule and the nearest usable owner are final whatever lies further up the
 *  chain; every other step could be overruled by an owner above an incomplete walk. */
function stepIsChainFinal(step: PlacementDecision['step']): boolean {
  return step === 'unit-rule' || step === 'chain-unit'
}

/** Verdicts that propose moving the person; `manual` replaces them when an admin
 *  placed the person by hand. */
const MOVE_VERDICTS: ReadonlySet<PlacementVerdict> = new Set(['move-region', 'move-unit', 'place'])

export function classifyPlacement(input: {
  walkEnd: WalkEnd
  decision: PlacementDecision
  current: CurrentHome
  manual: boolean
}): PlacementVerdict {
  const verdict = classifyDerivation(input)
  return input.manual && MOVE_VERDICTS.has(verdict) ? 'manual' : verdict
}

function classifyDerivation({
  walkEnd,
  decision: d,
  current,
}: {
  walkEnd: WalkEnd
  decision: PlacementDecision
  current: CurrentHome
}): PlacementVerdict {
  if (!isUsableEvidence(walkEnd)) return 'lookup-failed'
  const walkComplete = walkEnd === 'top-of-chart'
  if (!walkComplete && !stepIsChainFinal(d.step)) return 'walk-incomplete'
  // An owner of several units hides nothing once a unit is decided; the row still names them.
  if (d.ambiguousOwners.length > 0 && !stepIsChainFinal(d.step)) return 'ambiguous-owner'
  if (!d.regionId) return 'no-signal'
  if (d.regionId !== current.regionId) return 'move-region'
  if (d.orgUnitId) {
    if (d.orgUnitId === current.orgUnitId) return 'ok'
    return current.onHolding ? 'place' : 'move-unit'
  }
  return current.onHolding ? 'needs-owner' : 'unit-unverified'
}

/** The region rule that matched the evidence but lost to the reporting line (a chain
 *  unit or chain region decided); null otherwise. */
export function overruledRegionRule(
  evidence: PlacementEvidence,
  config: PlacementConfig,
  decision: PlacementDecision,
): { attribute: string; value: string } | null {
  if (decision.step !== 'chain-unit' && decision.step !== 'chain-region') return null
  const match = mapAttributesToRegion(evidence.attributes, config.rules)
  return match && !match.orgUnitId ? { attribute: match.attribute, value: match.value } : null
}

/**
 * The live rule set with `rule` upserted the way directory-region-rules.post.ts
 * upserts it: keyed on (attribute, normalised value), so a rule already holding
 * that key is replaced, whatever its mode.
 */
export function withProposedRule(
  rules: RegionRuleSet,
  rule: { attribute: RegionAttributeKey; matchMode: MatchMode; value: string; target: RuleTarget },
): RegionRuleSet {
  const exact: RegionRuleSet['exact'] = new Map([...rules.exact].map(([attr, m]) => [attr, new Map(m)]))
  exact.get(rule.attribute)?.delete(rule.value)
  const prefix = rules.prefix.filter((p) => !(p.attribute === rule.attribute && p.value === rule.value))
  if (rule.matchMode === 'prefix') {
    prefix.push({ attribute: rule.attribute, value: rule.value, target: rule.target })
    prefix.sort((a, b) => b.value.length - a.value.length)
  } else {
    let m = exact.get(rule.attribute)
    if (!m) {
      m = new Map()
      exact.set(rule.attribute, m)
    }
    m.set(rule.value, rule.target)
  }
  return { exact, prefix }
}

export interface PreviewChange<T> {
  row: T
  from: PlacementDecision
  to: PlacementDecision
}

/** Rows whose derived (region, unit) differs between the two configs. Rows without
 *  usable evidence are skipped. */
export function previewPlacementChanges<T extends { evidence: PlacementEvidence }>(
  rows: readonly T[],
  live: PlacementConfig,
  proposed: PlacementConfig,
): Array<PreviewChange<T>> {
  const out: Array<PreviewChange<T>> = []
  for (const row of rows) {
    if (!isUsableEvidence(row.evidence.walkEnd)) continue
    const from = decidePlacement(row.evidence, live)
    const to = decidePlacement(row.evidence, proposed)
    if ((from.regionId ?? null) !== (to.regionId ?? null) || (from.orgUnitId ?? null) !== (to.orgUnitId ?? null)) {
      out.push({ row, from, to })
    }
  }
  return out
}
