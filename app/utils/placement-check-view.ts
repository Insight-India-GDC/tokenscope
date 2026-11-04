/*
 * Pure view logic for /admin/placement-check (docs/design/placement-check/00-spec.md P6).
 * Words the page shows for the contract's enums, the default filter, the
 * selectable set and the group-by-manager view. No Vue, so it is unit-testable.
 *
 * Copy rule: the page states what the directory derives NOW. It never says why
 * the current placement happened unless the row's provenance records it.
 */
import {
  APPLICABLE_VERDICTS,
  PLACEMENT_VERDICTS,
  type ChainLink,
  type PlacementApplyItem,
  type PlacementApplyRefusal,
  type PlacementCheckRow,
  type PlacementHome,
  type PlacementVerdict,
  type WalkEnd,
} from '#shared/placement/placement-check'
import { regionAttributeLabel } from '#shared/placement/region-attributes'
import { BU_LABEL, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

type BadgeKind = 'neutral' | 'harmony' | 'vision' | 'zeal' | 'hunger' | 'rag-green' | 'rag-amber' | 'rag-red' | 'outline'

export const PLACEMENT_VERDICT_TEXT: Record<PlacementVerdict, { label: string; hint: string; badge: BadgeKind }> = {
  ok: { label: 'Matches', hint: 'Region and unit match what the directory derives.', badge: 'rag-green' },
  'unit-unverified': {
    label: 'Region confirmed',
    hint: `The directory confirms the region but names no ${BU_LABEL}, so the current one is not checked.`,
    badge: 'neutral',
  },
  'move-region': { label: 'Move region', hint: 'The directory derives a different region.', badge: 'rag-red' },
  'move-unit': { label: `Move ${BU_LABEL}`, hint: `Same region, different ${BU_LABEL}.`, badge: 'rag-amber' },
  place: { label: 'Place', hint: `Unplaced, and the directory derives a ${BU_LABEL} in the same region.`, badge: 'rag-amber' },
  'needs-owner': {
    label: 'Needs an owner',
    hint: `Unplaced, and no manager above them owns a ${BU_LABEL}.`,
    badge: 'vision',
  },
  'ambiguous-owner': {
    label: 'Ambiguous owner',
    hint: `A manager above them owns more than one ${BU_LABEL}, so none is chosen.`,
    badge: 'vision',
  },
  'walk-incomplete': { label: 'Chain incomplete', hint: 'The manager chain was cut short.', badge: 'neutral' },
  'no-signal': { label: 'No signal', hint: 'No rule, Region leader or owner applies.', badge: 'neutral' },
  'lookup-failed': { label: 'Lookup failed', hint: 'The directory lookup failed or found nobody.', badge: 'hunger' },
  manual: {
    label: 'Placed by an admin',
    hint: 'An admin placed them, and the directory now derives something else.',
    badge: 'zeal',
  },
}

export const PLACEMENT_WALK_END_TEXT: Record<WalkEnd, string> = {
  'top-of-chart': 'The chain reached the top of the reporting line.',
  'hop-cap': 'The chain stopped at the limit of managers checked, before the top.',
  cycle: 'The reporting line loops back on itself, so the chain stopped there.',
  'graph-error': 'The directory lookup failed partway. "Retry failed" checks this person again.',
  'not-in-directory': 'This person was not found in the directory.',
}

export const PLACEMENT_REFUSAL_TEXT: Record<PlacementApplyRefusal, string> = {
  'changed-since-check': 'Their placement changed after this page loaded. Reload and review.',
  'manual-not-confirmed': 'An admin placed them since this page loaded. Reload and confirm the move.',
  'derivation-changed': 'The directory no longer proposes this move. Reload and review.',
  'target-invalid': `The target unit is retired or no longer a ${BU_LABEL}.`,
  'not-found': 'This teammate no longer exists or is inactive.',
  error: 'The move failed. Nothing was changed for this person.',
}

const PROVENANCE_VIA_TEXT: Record<string, string> = {
  'manager-chain': 'Manager chain',
  'attribute-rule': 'Directory rule',
  'placement-check': 'Placement check',
  'jit-directory': 'Sign-in, from the directory',
  'jit-default': 'Sign-in, default region',
}

/** How the current home came about, as far as anything recorded it. */
export function placementProvenanceText(row: Pick<PlacementCheckRow, 'manual' | 'provenance'>): string {
  if (row.manual) return 'Placed by an admin'
  const via = row.provenance?.placedVia
  if (!via) return 'Unknown'
  return PROVENANCE_VIA_TEXT[via] ?? via
}

/** "Region · unit". A region with no unit says so instead of naming a holding node as a unit. */
export function placementHomeText(home: PlacementHome): string {
  if (!home.regionId) return 'Nothing derived'
  const region = home.regionName ?? 'Unknown region'
  if (home.onHolding) return `${region} · Unplaced`
  return `${region} · ${home.orgUnitName ?? `no ${BU_LABEL}`}`
}

export type VerdictFilter = 'not-ok' | 'all' | PlacementVerdict

/** The unit filter value for "no unit on that side" (`orgUnitId` null); '' is any. */
export const NO_UNIT = 'none'

export interface PlacementFilters {
  verdict: VerdictFilter
  /** Region id, '' = any. */
  currentRegion: string
  derivedRegion: string
  /** Unit id, NO_UNIT, or '' = any. */
  currentUnit: string
  derivedUnit: string
}

export const DEFAULT_PLACEMENT_FILTERS: PlacementFilters = { verdict: 'not-ok', currentRegion: '', derivedRegion: '', currentUnit: '', derivedUnit: '' }

/**
 * Filters a link may carry: `?verdict=&current=&derived=` (region ids) and
 * `&currentUnit=&derivedUnit=` (unit ids, or `none` for no unit; a key left out
 * is no filter). An unknown verdict falls back to the default; a region or unit
 * id is kept as given, known or not (`unknownHomeFilters` says which ones no row
 * has, once the rows load).
 */
export function placementFiltersFromQuery(query: Record<string, unknown>): PlacementFilters {
  const str = (k: string) => (typeof query[k] === 'string' ? (query[k] as string) : '')
  const verdict = str('verdict')
  return {
    verdict: (PLACEMENT_VERDICTS as readonly string[]).includes(verdict) ? (verdict as PlacementVerdict) : DEFAULT_PLACEMENT_FILTERS.verdict,
    currentRegion: str('current'),
    derivedRegion: str('derived'),
    currentUnit: str('currentUnit'),
    derivedUnit: str('derivedUnit'),
  }
}

type Side = 'current' | 'derived'

function unitMatches(h: PlacementHome, unit: string): boolean {
  return !unit || (unit === NO_UNIT ? h.orgUnitId === null : h.orgUnitId === unit)
}

export type HomeFilterKey = 'currentRegion' | 'derivedRegion' | 'currentUnit' | 'derivedUnit'

/**
 * The region and unit filters no row has on their side. They stay applied, so the
 * table shows nobody and the page says which filter is why. A link stands for one
 * group of people and must never show more than that group: dropping an unknown
 * filter would widen the view to every region or unit, i.e. to other groups'
 * people under this group's name. Regions follow the same rule as units; there is
 * no reason an empty table is worse for one than the other.
 */
export function unknownHomeFilters(f: PlacementFilters, rows: readonly PlacementCheckRow[]): HomeFilterKey[] {
  const knownRegion = (side: Side, id: string) => !id || rows.some((r) => r[side].regionId === id)
  const knownUnit = (side: Side, unit: string) => rows.some((r) => unitMatches(r[side], unit))
  const unknown: HomeFilterKey[] = []
  if (!knownRegion('current', f.currentRegion)) unknown.push('currentRegion')
  if (!knownRegion('derived', f.derivedRegion)) unknown.push('derivedRegion')
  if (!knownUnit('current', f.currentUnit)) unknown.push('currentUnit')
  if (!knownUnit('derived', f.derivedUnit)) unknown.push('derivedUnit')
  return unknown
}

export function filterPlacementRows(rows: readonly PlacementCheckRow[], f: PlacementFilters): PlacementCheckRow[] {
  return rows
    .filter((r) => {
      if (f.verdict === 'not-ok' ? r.verdict === 'ok' : f.verdict !== 'all' && r.verdict !== f.verdict) return false
      if (f.currentRegion && r.current.regionId !== f.currentRegion) return false
      if (f.derivedRegion && r.derived.regionId !== f.derivedRegion) return false
      if (!unitMatches(r.current, f.currentUnit)) return false
      if (!unitMatches(r.derived, f.derivedUnit)) return false
      return true
    })
    .sort((a, b) => b.spend30d - a.spend30d)
}

/** Regions present on either side, for the two region filters. */
export function placementRegionOptions(rows: readonly PlacementCheckRow[], side: Side) {
  const seen = new Map<string, string>()
  for (const r of rows) {
    const h = r[side]
    if (h.regionId && !seen.has(h.regionId)) seen.set(h.regionId, h.regionName ?? h.regionId)
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Units present on a side as "Region · unit", NO_UNIT first when a row has no unit there. */
export function placementUnitOptions(rows: readonly PlacementCheckRow[], side: Side) {
  const seen = new Map<string, string>()
  let none = false
  for (const r of rows) {
    const h = r[side]
    if (h.orgUnitId === null) none = true
    else if (!seen.has(h.orgUnitId)) seen.set(h.orgUnitId, `${h.regionName ?? 'Unknown region'} · ${h.orgUnitName ?? h.orgUnitId}`)
  }
  const units = [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  return none ? [{ id: NO_UNIT, name: `No ${BU_LABEL}` }, ...units] : units
}

/** Apply needs an applicable verdict and a derived region; no unit means that region's Unplaced node. */
export function isPlacementApplicable(row: PlacementCheckRow): boolean {
  return (APPLICABLE_VERDICTS as readonly string[]).includes(row.verdict) && row.derived.regionId != null
}

/** What "Select all" picks: applicable rows, never `manual` ones. */
export function bulkSelectablePlacementIds(rows: readonly PlacementCheckRow[]): string[] {
  return rows.filter((r) => isPlacementApplicable(r) && r.verdict !== 'manual').map((r) => r.teammateId)
}

export function movesRegion(row: PlacementCheckRow): boolean {
  return row.derived.regionId !== row.current.regionId
}

export function buildPlacementApplyItems(rows: readonly PlacementCheckRow[], confirmManual: boolean): PlacementApplyItem[] {
  return rows.filter(isPlacementApplicable).map((r) => ({
    teammateId: r.teammateId,
    seen: r.seen,
    target: { regionId: r.derived.regionId!, orgUnitId: r.derived.orgUnitId },
    ...(r.verdict === 'manual' && confirmManual ? { confirmManual: true } : {}),
  }))
}

/** The decisive step in one sentence. */
export function placementDecisiveText(row: PlacementCheckRow): string {
  const { why, derived } = row
  const target = placementHomeText(derived)
  switch (derived.step) {
    case 'unit-rule':
    case 'region-rule':
      return why.rule
        ? `Directory rule: ${regionAttributeLabel(why.rule.attribute)} is “${why.rule.value}” → ${target}.`
        : `A directory rule → ${target}.`
    case 'chain-unit':
      return `${why.owner?.name ?? 'A manager'} owns ${derived.orgUnitName ?? `a ${BU_LABEL}`}, so → ${target}.`
    case 'chain-region':
      return `${why.leader?.name ?? 'A manager'} is a Region leader for ${derived.regionName ?? 'a region'}, so → ${target}.`
    default:
      return 'Nothing in the directory decides a placement for this person.'
  }
}

/** A decided unit with an owner of several units nearer the person; null otherwise. */
export function placementAmbiguousWarning(row: Pick<PlacementCheckRow, 'derived' | 'why'>): string | null {
  const decided = row.derived.step === 'chain-unit' || row.derived.step === 'unit-rule'
  if (!decided || row.why.ambiguousOwners.length === 0) return null
  return `A nearer manager owns several ${BU_LABEL_PLURAL}; check this is the right ${BU_LABEL}.`
}

export interface ChainLinkView extends ChainLink {
  depth: number
  marks: string[]
}

/** The chain from the person upward, each link marked owner / leader / ambiguous owner. */
export function placementChainView(row: PlacementCheckRow): ChainLinkView[] {
  const ambiguous = new Map(row.why.ambiguousOwners.map((a) => [a.oid, a.unitNames]))
  return row.why.chain.map((link, depth) => {
    const marks: string[] = []
    if (depth === 0) marks.push('this person')
    if (row.why.owner?.oid === link.oid) marks.push(`owns ${row.derived.orgUnitName ?? `the ${BU_LABEL}`}`)
    if (row.why.leader?.oid === link.oid) marks.push('Region leader')
    const units = ambiguous.get(link.oid)
    if (units) marks.push(`owns ${units.length} units (${units.join(', ')}), so none is chosen`)
    return { ...link, depth, marks }
  })
}

export interface ManagerGroup {
  oid: string | null
  name: string
  /** The manager above them, for context. */
  above: string | null
  count: number
  spend30d: number
  people: PlacementCheckRow[]
}

/** `needs-owner` rows grouped by their nearest manager (chain[1]), largest group first. */
export function groupNeedsOwnerByManager(rows: readonly PlacementCheckRow[]): ManagerGroup[] {
  const groups = new Map<string, ManagerGroup>()
  for (const r of rows) {
    if (r.verdict !== 'needs-owner') continue
    const mgr = r.why.chain[1]
    const key = mgr?.oid ?? ''
    let g = groups.get(key)
    if (!g) {
      const above = r.why.chain[2]
      g = {
        oid: mgr?.oid ?? null,
        name: mgr ? (mgr.name ?? mgr.email ?? mgr.oid) : 'No manager above them',
        above: above ? (above.name ?? above.email ?? above.oid) : null,
        count: 0,
        spend30d: 0,
        people: [],
      }
      groups.set(key, g)
    }
    g.count++
    g.spend30d += r.spend30d
    g.people.push(r)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.spend30d - a.spend30d)
}
