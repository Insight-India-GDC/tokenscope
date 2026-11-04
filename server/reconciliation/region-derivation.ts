/*
 * Placement derivation for people no cost-centre code places. PRECEDENCE, highest first
 * (decidePlacement):
 *   1. unit rule    — a directory-attribute rule naming a cost-owning unit (mig 0112).
 *   2. chain unit   — the nearest chain member who owns EXACTLY ONE cost-owning unit.
 *   3. chain region — the nearest chain member who is a region leader.
 *   4. region rule  — a directory-attribute rule naming a region.
 * A chain unit beats a nearer region leader, so the walk only stops early on a unit owner.
 *
 * The decision is a pure function of the evidence (attributes + chain); the Graph manager
 * fetch is injected (GetManager). A non-404 Graph error propagates out of the live walk
 * and is never cached as a miss.
 */
import type { ChainLink, WalkEnd, PlacementStep } from '../../shared/placement/placement-check'
import type { DirectoryUser } from '../azure/directory'
import type { DerivedManager, PlacementDerivation } from './placement-service'
import {
  REGION_ATTRIBUTE_KEYS,
  normalizeMatchValue,
  type RegionAttributeKey,
} from '../../shared/placement/region-attributes'

/** Managers above the person a walk may reach (the person themself is hop 0). */
export const MAX_CHAIN_HOPS = 12

/** A manager edge from the Entra `/users/{id}/manager` hop. */
export interface ManagerEdge {
  oid: string
  email: string | null
  name?: string | null
}

/** Fetch a user's manager (null = top of chart). MUST map 404 → null and throw on any
 *  other error. */
export type GetManager = (oid: string) => Promise<ManagerEdge | null>

/** A cost-owning unit owned by a chain member (cou_owner → org_unit). */
export interface OwnedUnit {
  orgUnitId: string
  regionId: string
}

/** The chain's own answer, ignoring rules. null = neither an owner nor a leader. */
export type ChainPlacement =
  | { kind: 'unit'; orgUnitId: string; regionId: string; ownerOid: string }
  | { kind: 'region'; regionId: string; leaderOid: string }
  | null

export interface ChainCaches {
  /** oid → manager edge | null (top of chart). Shared across users in one run. */
  managerCache: Map<string, ManagerEdge | null>
  /** oid → that person's own ChainPlacement, so a later walk through them stops there. */
  placementCache: Map<string, ChainPlacement>
}

/** What one curated rule places a matching teammate into. `regionId` is always set (for a
 *  unit rule it is the unit's region); `orgUnitId` null = a region rule. */
export interface RuleTarget {
  regionId: string
  orgUnitId: string | null
}

/** The curated rules, pre-indexed: exact attribute→value→target, and prefixes sorted
 *  longest-first so the most specific prefix wins. */
export interface RegionRuleSet {
  exact: Map<RegionAttributeKey, Map<string, RuleTarget>>
  prefix: Array<{ attribute: RegionAttributeKey; value: string; target: RuleTarget }>
}

const EMPTY_RULE_SET: RegionRuleSet = { exact: new Map(), prefix: [] }

// Every catalog key must be a string field on DirectoryUser.
type _AssertAttrsAreDirectoryFields = RegionAttributeKey extends keyof DirectoryUser ? true : never
const _assertAttrsAreDirectoryFields: _AssertAttrsAreDirectoryFields = true
void _assertAttrsAreDirectoryFields

/** The directory attributes rules match on (every catalog key). */
export type DirectoryAttributes = Record<RegionAttributeKey, string | null>

export function directoryAttributesOf(dir: Pick<DirectoryUser, RegionAttributeKey> | null): DirectoryAttributes {
  const out = {} as DirectoryAttributes
  for (const key of REGION_ATTRIBUTE_KEYS) out[key] = dir?.[key] ?? null
  return out
}

export interface AttributeMatch {
  regionId: string
  /** The rule's unit target, or null for a region rule. */
  orgUnitId: string | null
  attribute: RegionAttributeKey
  /** The matched rule's value (normalised; the prefix itself for a prefix rule). */
  value: string
  /** A lower-precedence attribute also matched a DIFFERENT target (region or unit). */
  conflict: boolean
}

/**
 * Match the curated rules in catalog precedence order, exact before prefix. The
 * highest-precedence hit wins; any hit naming a different complete target (region AND
 * unit) sets `conflict`. null = no attribute matched.
 */
export function mapAttributesToRegion(
  dir: Pick<DirectoryUser, RegionAttributeKey>,
  rules: RegionRuleSet = EMPTY_RULE_SET,
): AttributeMatch | null {
  const hits: Array<{ attribute: RegionAttributeKey; value: string; target: RuleTarget }> = []
  for (const attr of REGION_ATTRIBUTE_KEYS) {
    const norm = normalizeMatchValue(dir[attr] ?? null)
    if (!norm) continue
    const exact = rules.exact.get(attr)?.get(norm)
    if (exact) {
      hits.push({ attribute: attr, value: norm, target: exact })
      continue
    }
    const pfx = rules.prefix.find((p) => p.attribute === attr && norm.startsWith(p.value))
    if (pfx) hits.push({ attribute: attr, value: pfx.value, target: pfx.target })
  }
  if (hits.length === 0) return null
  const winner = hits[0]!
  const conflict = hits.some(
    (h) =>
      h.target.regionId !== winner.target.regionId || h.target.orgUnitId !== winner.target.orgUnitId,
  )
  return {
    regionId: winner.target.regionId,
    orgUnitId: winner.target.orgUnitId,
    attribute: winner.attribute,
    value: winner.value,
    conflict,
  }
}

/**
 * Whether a cou_owner can be a placement target: exactly one active cost-owning unit. An
 * owner of more is ambiguous and the walk climbs past them. The admin surface
 * (org-units.get.ts) warns from this same predicate.
 */
export function resolvesToSingleUnit(owned: OwnedUnit[] | undefined): owned is [OwnedUnit] {
  return resolvesToSingleUnitCount(owned?.length ?? 0)
}

/** The same rule over a count, for readers holding aggregate counts (mig 0111). */
export function resolvesToSingleUnitCount(unitCount: number): boolean {
  return unitCount === UNAMBIGUOUS_OWNER_UNIT_COUNT
}

/** Units an owner may hold and still be a placement target; SQL readers use this too. */
export const UNAMBIGUOUS_OWNER_UNIT_COUNT = 1

export type { ChainLink, WalkEnd, PlacementStep } from '../../shared/placement/placement-check'

export interface PlacementEvidence {
  attributes: DirectoryAttributes
  /** chain[0] is the person themself (they can be an owner or leader), then their
   *  manager, upward. A `graph-error` walk keeps the links fetched before the error. */
  chain: ChainLink[]
  walkEnd: WalkEnd
}

export interface PlacementConfig {
  rules: RegionRuleSet
  unitOwnerMap: Map<string, OwnedUnit[]>
  leaderMap: Map<string, string>
  maxHops: number
}


export interface PlacementDecision {
  orgUnitId?: string
  regionId?: string
  step: PlacementStep | null
  ownerOid?: string
  leaderOid?: string
  /** The deciding rule (unit-rule / region-rule only). */
  rule?: { attribute: RegionAttributeKey; value: string }
  /** Owners of 2+ units met before the first usable owner, nearest first. */
  ambiguousOwners: Array<{ oid: string; units: OwnedUnit[] }>
  /** The deciding rule had a divergent lower-precedence match. */
  conflict?: boolean
}

type ChainMaps = Pick<PlacementConfig, 'unitOwnerMap' | 'leaderMap'>

interface ChainScan {
  unit?: { orgUnitId: string; regionId: string; ownerOid: string }
  leader?: { oid: string; regionId: string }
  ambiguousOwners: PlacementDecision['ambiguousOwners']
}

function scanChain(oids: readonly string[], maps: ChainMaps): ChainScan {
  const scan: ChainScan = { ambiguousOwners: [] }
  for (const oid of oids) {
    const owned = maps.unitOwnerMap.get(oid)
    if (resolvesToSingleUnit(owned)) {
      scan.unit = { orgUnitId: owned[0].orgUnitId, regionId: owned[0].regionId, ownerOid: oid }
      break
    }
    if (owned?.length) scan.ambiguousOwners.push({ oid, units: owned })
    if (!scan.leader) {
      const regionId = maps.leaderMap.get(oid)
      if (regionId !== undefined) scan.leader = { oid, regionId }
    }
  }
  return scan
}

/** `tail` = the cached answer of the person the walk stopped at, above `scan`'s links. */
function chainOutcome(scan: ChainScan, tail: ChainPlacement | undefined): ChainPlacement {
  if (scan.unit) return { kind: 'unit', ...scan.unit }
  if (tail?.kind === 'unit') return tail
  if (scan.leader) return { kind: 'region', regionId: scan.leader.regionId, leaderOid: scan.leader.oid }
  return tail ?? null
}

function decide(
  byAttr: AttributeMatch | null,
  chain: ChainPlacement,
  ambiguousOwners: PlacementDecision['ambiguousOwners'],
): PlacementDecision {
  const rule = byAttr ? { attribute: byAttr.attribute, value: byAttr.value } : undefined
  if (byAttr?.orgUnitId) {
    return { orgUnitId: byAttr.orgUnitId, regionId: byAttr.regionId, step: 'unit-rule', rule, conflict: byAttr.conflict, ambiguousOwners }
  }
  if (chain?.kind === 'unit') {
    return { orgUnitId: chain.orgUnitId, regionId: chain.regionId, step: 'chain-unit', ownerOid: chain.ownerOid, ambiguousOwners }
  }
  if (chain?.kind === 'region') {
    return { regionId: chain.regionId, step: 'chain-region', leaderOid: chain.leaderOid, ambiguousOwners }
  }
  if (byAttr) {
    return { regionId: byAttr.regionId, step: 'region-rule', rule, conflict: byAttr.conflict, ambiguousOwners }
  }
  return { step: null, ambiguousOwners }
}

/** The placement the evidence yields under `config`. Ignores `walkEnd`: a caller treats
 *  `graph-error` / `not-in-directory` evidence as undecided. */
export function decidePlacement(evidence: PlacementEvidence, config: PlacementConfig): PlacementDecision {
  const oids = evidence.chain.slice(0, config.maxHops + 1).map((l) => l.oid)
  const scan = scanChain(oids, config)
  return decide(mapAttributesToRegion(evidence.attributes, config.rules), chainOutcome(scan, undefined), scan.ambiguousOwners)
}

/**
 * Walk the whole chain (to the top or the hop cap) for stored evidence. Uses the manager
 * cache only, so the chain is this person's own. A Graph error ends the walk as
 * `graph-error` with the links fetched so far.
 */
export async function gatherPlacementEvidence(
  dir: DirectoryUser | null,
  deps: { getManager: GetManager; managerCache: Map<string, ManagerEdge | null>; maxHops?: number },
): Promise<PlacementEvidence> {
  const attributes = directoryAttributesOf(dir)
  if (!dir?.oid) return { attributes, chain: [], walkEnd: 'not-in-directory' }
  const maxHops = deps.maxHops ?? MAX_CHAIN_HOPS
  const chain: ChainLink[] = [{ oid: dir.oid, name: dir.displayName || null, email: dir.email || null }]
  for (;;) {
    const at = chain[chain.length - 1]!.oid
    let manager: ManagerEdge | null
    try {
      manager = await fetchManager(at, deps.getManager, deps.managerCache)
    } catch {
      return { attributes, chain, walkEnd: 'graph-error' }
    }
    if (!manager?.oid) return { attributes, chain, walkEnd: 'top-of-chart' }
    if (chain.some((l) => l.oid === manager.oid)) return { attributes, chain, walkEnd: 'cycle' }
    if (chain.length > maxHops) return { attributes, chain, walkEnd: 'hop-cap' }
    chain.push({ oid: manager.oid, name: manager.name ?? null, email: manager.email })
  }
}

async function fetchManager(
  oid: string,
  getManager: GetManager,
  managerCache: Map<string, ManagerEdge | null>,
): Promise<ManagerEdge | null> {
  if (!managerCache.has(oid)) managerCache.set(oid, await getManager(oid))
  return managerCache.get(oid)!
}

export interface ChainWalkDeps extends ChainMaps {
  getManager: GetManager
  caches: ChainCaches
  maxHops?: number
}

/**
 * The live walk: lazy (stops at the first usable unit owner or at a person whose answer
 * is cached) and strict (a Graph error throws). Caches each walked person's own answer,
 * except above the start on a capped or cyclic walk, where it is not known.
 */
async function walkChain(startOid: string, deps: ChainWalkDeps): Promise<{ path: string[]; tail?: ChainPlacement }> {
  const maxHops = deps.maxHops ?? MAX_CHAIN_HOPS
  const { managerCache, placementCache } = deps.caches
  const path: string[] = []
  let tail: ChainPlacement | undefined
  let complete = true
  let current = startOid
  for (;;) {
    const cached = placementCache.get(current)
    if (cached !== undefined) {
      tail = cached
      break
    }
    if (path.includes(current)) {
      complete = false
      break
    }
    path.push(current)
    if (resolvesToSingleUnit(deps.unitOwnerMap.get(current))) break
    const manager = await fetchManager(current, deps.getManager, managerCache)
    if (!manager?.oid) break
    if (path.length > maxHops) {
      complete = false
      break
    }
    current = manager.oid
  }
  const cacheable = complete ? path.length : Math.min(1, path.length)
  for (let i = 0; i < cacheable; i++) {
    placementCache.set(path[i]!, chainOutcome(scanChain(path.slice(i), deps), tail))
  }
  return { path, tail }
}

/** The chain's own answer for `startOid`: a usable unit owner beats any leader; else the
 *  nearest leader. */
export async function resolvePlacementViaManagerChain(startOid: string, deps: ChainWalkDeps): Promise<ChainPlacement> {
  const { path, tail } = await walkChain(startOid, deps)
  return chainOutcome(scanChain(path, deps), tail)
}

/**
 * The live derivation for one directory user. A unit rule answers without walking. The
 * chain is walked whenever an owner or a leader exists, since either outranks a region
 * rule; a Graph error throws rather than falling through to a rule.
 */
export async function derivePlacement(
  dir: DirectoryUser,
  deps: ChainWalkDeps & { rules: RegionRuleSet },
): Promise<PlacementDerivation> {
  const byAttr = mapAttributesToRegion(dir, deps.rules)
  let chain: ChainPlacement = null
  let manager: DerivedManager | undefined
  const chainCanAnswer = deps.unitOwnerMap.size > 0 || deps.leaderMap.size > 0
  if (!byAttr?.orgUnitId && dir.oid && chainCanAnswer) {
    const { path, tail } = await walkChain(dir.oid, deps)
    chain = chainOutcome(scanChain(path, deps), tail)
    manager = directManagerFrom(deps.caches, dir.oid)
  }
  const d = decide(byAttr, chain, [])
  switch (d.step) {
    case 'unit-rule':
      return { orgUnitId: d.orgUnitId, regionId: d.regionId, via: 'unit-rule', attribute: d.rule!.attribute, conflict: d.conflict }
    case 'chain-unit':
      return { orgUnitId: d.orgUnitId, regionId: d.regionId, ownerOid: d.ownerOid, via: 'unit', manager }
    case 'chain-region':
      return { regionId: d.regionId, via: 'manager', manager }
    case 'region-rule':
      return { regionId: d.regionId, via: 'attribute', attribute: d.rule!.attribute, conflict: d.conflict, manager }
    default:
      return { via: null, manager }
  }
}

/**
 * The person's own manager from the walk's cache, never a fetch. `undefined` = never
 * asked (callers keep what an earlier run captured); `oid: null` = top of chart.
 */
function directManagerFrom(caches: ChainCaches, oid: string): DerivedManager | undefined {
  if (!caches.managerCache.has(oid)) return undefined
  const edge = caches.managerCache.get(oid) ?? null
  return { oid: edge?.oid ?? null, email: edge?.email ?? null }
}

/** Fresh per-run caches. Create once in the worker and thread through `derivePlacement`. */
export function makeChainCaches(): ChainCaches {
  return { managerCache: new Map(), placementCache: new Map() }
}
