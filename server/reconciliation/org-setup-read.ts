/*
 * The IO for the Org setup reads (docs/design/org-setup/00-spec.md, Server): one
 * pass over stored evidence, the live config and names; no Graph calls. The
 * decisions themselves are pure (org-setup-tree, -preview, -decisions).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { DISMISSIBLE_KINDS } from '../../shared/org-setup/contract'
import type {
  OrgSetupDecisionsResponse,
  OrgSetupPreviewResponse,
  OrgSetupTopHome,
  OrgTreeResponse,
  ProposedChanges,
} from '../../shared/org-setup/contract'
import { UNASSIGNED_REGION_CODE } from '../../shared/placement/holding-nodes'
import { fetchRegionOptions } from '../reporting/regional'
import { loadOrgSetupRead, loadOrgSetupSettings } from './org-setup-store'
import { loadEvidenceRows, loadNames, loadPopulationHomes } from './placement-check-read'
import { loadPlacementConfig, placementCheckPopulationSql } from './placement-check-store'
import { buildOrgTree, regionCoverage, type ActiveLeaderRow } from './org-setup-tree'
import { previewOrgSetup } from './org-setup-preview'
import { buildOrgSetupDecisions, dismissalKey, type OrgSetupPrincipal } from './org-setup-decisions'

type Db = PostgresJsDatabase<typeof schema>

/** Every active region leader, with the row id the revoke needs. */
async function loadActiveLeaderRows(db: Pick<Db, 'execute'>): Promise<ActiveLeaderRow[]> {
  const rows = await db.execute<{ id: string; region_id: string; oid: string; name: string | null; email: string }>(sql`
    SELECT id::text AS id, region_id::text AS region_id, leader_oid AS oid, display_name AS name, leader_email AS email
    FROM region_leader WHERE revoked_at IS NULL`)
  return [...rows].map((r) => ({ leaderId: r.id, regionId: r.region_id, oid: r.oid, name: r.name, email: r.email }))
}

/**
 * Where the top person sits in TokenScope today. Org setup never places them. A teammate
 * first seen on a provider bill carries a `bill:` placeholder oid until they sign in, so
 * the directory email finds such a row too (never a row bound to another real oid); a
 * row holding the oid wins.
 */
async function loadTopHome(db: Pick<Db, 'execute'>, top: { oid: string; email: string | null }): Promise<OrgSetupTopHome> {
  const rows = await db.execute<{ id: string; email: string; region_id: string; region_name: string; region_code: string; unit_name: string }>(sql`
    SELECT t.id::text AS id, t.email, r.id::text AS region_id, r.display_name AS region_name, r.code AS region_code,
           ou.display_name AS unit_name
    FROM teammate t
    JOIN region r ON r.id = t.region_id
    JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE (t.entra_oid = ${top.oid}
           OR (${top.email}::text IS NOT NULL AND t.entra_oid LIKE 'bill:%' AND lower(t.email) = lower(${top.email})))
      AND ${placementCheckPopulationSql(sql`t`)}
    ORDER BY (t.entra_oid = ${top.oid}) DESC
    LIMIT 1`)
  const t = [...rows][0]
  if (!t) return { kind: 'not-a-user' }
  if (t.region_code === UNASSIGNED_REGION_CODE) return { kind: 'unassigned', teammateId: t.id, email: t.email, regionId: t.region_id }
  return { kind: 'placed', teammateId: t.id, email: t.email, regionId: t.region_id, regionName: t.region_name, unitName: t.unit_name }
}

/** Each region's `default` unit (parentless, made with the region), by region id. */
async function loadDefaultUnits(db: Pick<Db, 'execute'>): Promise<Map<string, string>> {
  const rows = await db.execute<{ region_id: string; id: string }>(sql`
    SELECT region_id::text AS region_id, id::text AS id FROM org_unit
    WHERE code = 'default' AND parent_id IS NULL AND retired_at IS NULL`)
  return new Map([...rows].map((r) => [r.region_id, r.id]))
}

export async function loadOrgTree(db: Db, opts: { today: string }): Promise<OrgTreeResponse> {
  const settings = await loadOrgSetupSettings(db)
  const read = await loadOrgSetupRead(db)
  const regionOptions = (await fetchRegionOptions(db)).map((r) => ({ id: r.id, name: r.displayName }))
  // Coverage is the whole population's current homes (someone never read still
  // counts), so it needs neither evidence nor a top person; the tree needs both.
  const regions = regionCoverage(await loadPopulationHomes(db), regionOptions, await loadActiveLeaderRows(db))
  if (!settings.top) return { settings, topHome: null, read, regions, nodes: [], outsideTop: 0 }
  const topHome = await loadTopHome(db, settings.top)
  const rows = await loadEvidenceRows(db, { today: opts.today })
  const config = await loadPlacementConfig(db)
  const names = await loadNames(db)
  const tree = buildOrgTree(rows, config, names, settings.top)
  return { settings, topHome, read, regions, nodes: tree.nodes, outsideTop: tree.outsideTop }
}

export async function loadOrgSetupPreview(
  db: Db,
  changes: ProposedChanges,
  opts: { today: string },
): Promise<OrgSetupPreviewResponse> {
  const config = await loadPlacementConfig(db)
  const names = await loadNames(db)
  const rows = await loadEvidenceRows(db, { today: opts.today })
  return previewOrgSetup(rows, config, changes, names)
}

export async function loadOrgSetupDecisions(db: Db, opts: { today: string }): Promise<OrgSetupDecisionsResponse> {
  const settings = await loadOrgSetupSettings(db)
  const read = await loadOrgSetupRead(db)
  const config = await loadPlacementConfig(db)
  const names = await loadNames(db)
  const rows = await loadEvidenceRows(db, { today: opts.today })
  const tree = buildOrgTree(rows, config, names, settings.top)
  const realRegions = new Set((await fetchRegionOptions(db)).map((r) => r.id))

  const notFound = new Set<string>()
  const dismissed = new Set<string>()
  if (read.cycleId) {
    const checks = await db.execute<{ oid: string }>(sql`
      SELECT oid FROM placement_principal_check WHERE cycle_id = ${read.cycleId}::uuid AND NOT found`)
    for (const c of checks) notFound.add(c.oid)
    const dis = await db.execute<{ kind: string; subject_key: string }>(sql`
      SELECT kind, subject_key FROM org_setup_dismissal
      WHERE cycle_id = ${read.cycleId}::uuid AND kind IN ${[...DISMISSIBLE_KINDS]}`)
    for (const d of dis) dismissed.add(dismissalKey(d.kind, d.subject_key))
  }

  // Owners and leaders: names for the cards, and the ids a replacement revokes
  // (the leader row for a leader; the teammate for an owner, whose cou_owner row
  // is keyed on it).
  const principals = new Map<string, OrgSetupPrincipal>()
  const oids = [...new Set([...config.unitOwnerMap.keys(), ...config.leaderMap.keys()])]
  if (oids.length) {
    for (const l of await loadActiveLeaderRows(db)) {
      if (config.leaderMap.has(l.oid)) principals.set(l.oid, { name: l.name, email: l.email, leaderId: l.leaderId })
    }
    const people = await db.execute<{ oid: string; id: string; name: string | null; email: string }>(sql`
      SELECT entra_oid AS oid, id::text AS id, display_name AS name, email FROM teammate WHERE entra_oid IN ${oids}`)
    for (const p of people) {
      const prior = principals.get(p.oid)
      principals.set(p.oid, { ...prior, name: p.name ?? prior?.name ?? null, email: p.email, teammateId: p.id })
    }
  }

  const defaultUnits = await loadDefaultUnits(db)
  const decisions = buildOrgSetupDecisions({
    rows,
    config,
    names,
    tree,
    top: settings.top,
    realRegions,
    notFound,
    principals,
    dismissed,
    defaultUnits,
  })
  return { read, decisions }
}
