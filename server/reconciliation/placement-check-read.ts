/*
 * The placement check's read side (docs/design/placement-check/00-spec.md P5, P8):
 * stored evidence joined with each person's current home and judged against the
 * CURRENT config, so a new owner or rule shows without a new check.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import {
  PLACEMENT_VERDICTS,
  type PlacementCheckResponse,
  type PlacementCheckRow,
  type PlacementHome,
  type PlacementRulePreviewResponse,
  type PlacementVerdict,
} from '../../shared/placement/placement-check'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'
import { GITHUB_FIREWALL_EXCLUSIONS } from '../../shared/usage/github-surface'
import { shiftUtcDay } from '../../shared/reports/clock'
import type { MatchMode, RegionAttributeKey } from '../../shared/placement/region-attributes'
import { provenanceOf } from './placement-provenance'
import { manualPlacementSql } from './placement-manual'
import {
  countPlacementCheckFailed,
  countPlacementCheckRemaining,
  currentPlacementCycle,
  evidenceFromRow,
  loadPlacementConfig,
  placementCheckPopulationSql,
} from './placement-check-store'
import { decidePlacement, type PlacementDecision, type PlacementEvidence, type RuleTarget } from './region-derivation'
import {
  classifyPlacement,
  isUsableEvidence,
  overruledRegionRule,
  previewPlacementChanges,
  withProposedRule,
} from './placement-verdict'

type Db = PostgresJsDatabase<typeof schema>

/** Days of chargeable spend shown per person, ending with the server's today. */
export const PLACEMENT_SPEND_DAYS = 30

export interface EvidenceRow {
  teammateId: string
  name: string | null
  email: string
  regionId: string
  orgUnitId: string
  onHolding: boolean
  manual: boolean
  provenance: Record<string, string> | null
  spend30d: number
  gatheredAt: string
  evidence: PlacementEvidence
}

export interface Names {
  region: Map<string, string>
  unit: Map<string, string>
}

export async function loadNames(db: Pick<Db, 'execute'>): Promise<Names> {
  const regions = await db.execute<{ id: string; name: string }>(sql`
    SELECT id::text AS id, display_name AS name FROM region`)
  const units = await db.execute<{ id: string; name: string }>(sql`
    SELECT id::text AS id, display_name AS name FROM org_unit`)
  return {
    region: new Map([...regions].map((r) => [r.id, r.name])),
    unit: new Map([...units].map((u) => [u.id, u.name])),
  }
}

/*
 * Chargeable (§B) spend per teammate: v_finance_bill_chargeback with the GitHub
 * firewall, the per-teammate arm unhomed-causes.ts uses. Pooled Copilot has no
 * teammate grain and is not in it.
 */
function spendSql(today: string) {
  const firewall = sql.join(
    GITHUB_FIREWALL_EXCLUSIONS.map((tool) => sql`${tool}`),
    sql`, `,
  )
  return sql`
    SELECT b.teammate_id, SUM(b.bill_usd) AS usd
    FROM v_finance_bill_chargeback b
    WHERE b.period_date >= ${shiftUtcDay(today, 1 - PLACEMENT_SPEND_DAYS)}::date
      AND b.period_date < ${shiftUtcDay(today, 1)}::date
      AND b.tool NOT IN (${firewall})
    GROUP BY b.teammate_id`
}

export async function loadEvidenceRows(db: Pick<Db, 'execute'>, opts: { today: string | null }): Promise<EvidenceRow[]> {
  const spendJoin = opts.today ? sql`LEFT JOIN (${spendSql(opts.today)}) sp ON sp.teammate_id = t.id` : sql``
  const spend = opts.today ? sql`COALESCE(sp.usd, 0)` : sql`0`
  const rows = await db.execute<{
    teammate_id: string
    name: string | null
    email: string
    region_id: string
    org_unit_id: string
    on_holding: boolean
    manual: boolean
    metadata: unknown
    spend: string
    gathered_at: string
    attributes: unknown
    chain: unknown
    walk_end: string
  }>(sql`
    SELECT t.id::text AS teammate_id, t.display_name AS name, t.email,
           t.region_id::text AS region_id, t.org_unit_id::text AS org_unit_id,
           (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_holding,
           ${manualPlacementSql(sql`t`)} AS manual,
           t.metadata,
           (${spend})::numeric(14,6)::text AS spend,
           to_char(pe.gathered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS gathered_at,
           pe.attributes, pe.chain, pe.walk_end
    FROM placement_evidence pe
    JOIN teammate t ON t.id = pe.teammate_id
    JOIN org_unit ou ON ou.id = t.org_unit_id
    ${spendJoin}
    WHERE ${placementCheckPopulationSql(sql`t`)}`)
  return [...rows].map((r) => ({
    teammateId: r.teammate_id,
    name: r.name,
    email: r.email,
    regionId: r.region_id,
    orgUnitId: r.org_unit_id,
    onHolding: r.on_holding,
    manual: r.manual,
    // The same reader Apply compares `seen.provenance` with.
    provenance: provenanceOf(r.metadata),
    spend30d: Number(r.spend),
    gatheredAt: r.gathered_at,
    evidence: evidenceFromRow(r),
  }))
}

/**
 * The current home of EVERY population member, evidence or not: a person the check
 * has never read still sits somewhere today. The Org setup overview's region
 * coverage counts these, so a region is never "fully covered" by the few people
 * who happen to have been read.
 */
export async function loadPopulationHomes(db: Pick<Db, 'execute'>): Promise<{ regionId: string; onHolding: boolean }[]> {
  const rows = await db.execute<{ region_id: string; on_holding: boolean }>(sql`
    SELECT t.region_id::text AS region_id, (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_holding
    FROM teammate t
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE ${placementCheckPopulationSql(sql`t`)}`)
  return [...rows].map((r) => ({ regionId: r.region_id, onHolding: r.on_holding }))
}

function evidenceAge(rows: readonly EvidenceRow[]): { oldest: string | null; newest: string | null } {
  if (rows.length === 0) return { oldest: null, newest: null }
  const sorted = rows.map((r) => r.gatheredAt).sort()
  return { oldest: sorted[0]!, newest: sorted[sorted.length - 1]! }
}

function derivedHome(d: PlacementDecision, names: Names): PlacementHome {
  const regionId = d.regionId ?? null
  const orgUnitId = d.orgUnitId ?? null
  return {
    regionId,
    regionName: regionId ? (names.region.get(regionId) ?? null) : null,
    orgUnitId,
    orgUnitName: orgUnitId ? (names.unit.get(orgUnitId) ?? null) : null,
    onHolding: regionId !== null && orgUnitId === null,
  }
}

function toRow(
  r: EvidenceRow,
  d: PlacementDecision,
  verdict: PlacementVerdict,
  overruledRule: { attribute: string; value: string } | null,
  names: Names,
): PlacementCheckRow {
  const linkName = (oid: string) => r.evidence.chain.find((l) => l.oid === oid)?.name ?? null
  return {
    teammateId: r.teammateId,
    name: r.name,
    email: r.email,
    current: {
      regionId: r.regionId,
      regionName: names.region.get(r.regionId) ?? null,
      orgUnitId: r.orgUnitId,
      orgUnitName: names.unit.get(r.orgUnitId) ?? null,
      onHolding: r.onHolding,
    },
    derived: { ...derivedHome(d, names), step: d.step },
    verdict,
    manual: r.manual,
    provenance: r.provenance,
    spend30d: r.spend30d,
    gatheredAt: r.gatheredAt,
    why: {
      rule: d.rule ? { attribute: d.rule.attribute, value: d.rule.value } : null,
      overruledRule,
      owner: d.ownerOid ? { oid: d.ownerOid, name: linkName(d.ownerOid) } : null,
      leader: d.leaderOid ? { oid: d.leaderOid, name: linkName(d.leaderOid) } : null,
      ambiguousOwners: d.ambiguousOwners.map((a) => ({
        oid: a.oid,
        name: linkName(a.oid),
        unitNames: a.units.map((u) => names.unit.get(u.orgUnitId) ?? u.orgUnitId),
      })),
      chain: r.evidence.chain,
      walkEnd: r.evidence.walkEnd,
    },
    seen: { regionId: r.regionId, orgUnitId: r.orgUnitId, provenance: r.provenance },
  }
}

/** Every person with evidence, judged now. Rows are ordered by spend, highest first. */
export async function loadPlacementCheck(db: Db, opts: { today: string }): Promise<PlacementCheckResponse> {
  const cycle = await currentPlacementCycle(db)
  const remaining = await countPlacementCheckRemaining(db, cycle?.id ?? null)
  const failedThisCycle = await countPlacementCheckFailed(db, cycle?.id ?? null)
  const config = await loadPlacementConfig(db)
  const names = await loadNames(db)
  const evidenceRows = await loadEvidenceRows(db, { today: opts.today })

  const rows = evidenceRows.map((r) => {
    const d = decidePlacement(r.evidence, config)
    const verdict = classifyPlacement({
      walkEnd: r.evidence.walkEnd,
      decision: d,
      current: { regionId: r.regionId, orgUnitId: r.orgUnitId, onHolding: r.onHolding },
      manual: r.manual,
    })
    return toRow(r, d, verdict, overruledRegionRule(r.evidence, config, d), names)
  })
  rows.sort((a, b) => b.spend30d - a.spend30d || a.email.localeCompare(b.email))

  const summary = PLACEMENT_VERDICTS.map((verdict) => {
    const of = rows.filter((r) => r.verdict === verdict)
    return { verdict, count: of.length, spend30d: of.reduce((s, r) => s + r.spend30d, 0) }
  })
  return { cycle, remaining, failedThisCycle, evidenceAge: evidenceAge(evidenceRows), summary, rows }
}

/**
 * Every stored evidence row decided under the live rules and under the live rules
 * with `proposed` upserted; the people whose derived home differs. `unchecked`
 * counts population members the preview cannot speak for: no evidence, or a failed
 * lookup.
 */
export async function previewPlacementRule(
  db: Db,
  proposed: { attribute: RegionAttributeKey; matchMode: MatchMode; value: string; target: RuleTarget },
): Promise<PlacementRulePreviewResponse> {
  const live = await loadPlacementConfig(db)
  const names = await loadNames(db)
  const evidenceRows = await loadEvidenceRows(db, { today: null })
  const populationRows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM teammate t WHERE ${placementCheckPopulationSql(sql`t`)}`)
  const population = Number([...populationRows][0]?.n ?? 0)

  const withRule = { ...live, rules: withProposedRule(live.rules, proposed) }
  const changes = previewPlacementChanges(evidenceRows, live, withRule)
  const usable = evidenceRows.filter((r) => isUsableEvidence(r.evidence.walkEnd))
  return {
    evidenceAge: evidenceAge(evidenceRows),
    unchecked: Math.max(0, population - usable.length),
    changes: changes.map(({ row, from, to }) => ({
      teammateId: row.teammateId,
      name: row.name,
      email: row.email,
      from: derivedHome(from, names),
      to: derivedHome(to, names),
    })),
  }
}
