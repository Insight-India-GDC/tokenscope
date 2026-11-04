/*
 * dimension-snapshot — the ingest-time (region, org-unit, cost-owning-unit)
 * snapshot every `actual_spend` writer stamps onto its rows (Workstream A,
 * docs/design/usage-completeness-and-provider-governance.md §3.1 "Historical
 * homing uses source snapshots, with an explicit legacy fallback").
 *
 * WHAT IT IS NOW. Each row's RECORDED placement. No report reads it: every
 * report groups a person's usage by where they sit now (the current-org lens,
 * mig 0162, docs/design/current-org-lens/00-design.md). It is kept, unedited,
 * so a future "as recorded" lens has something to build on. Migration 0101
 * backfilled rows that predate the columns from placement at migration time
 * (labelled `legacy-current-placement`); every write since stamps the placement
 * at write/replay time, labelled `ingest-snapshot`.
 *
 * WRITE ONCE. A writer snapshots dimensions on the INITIAL INSERT only and
 * leaves them OUT of any `ON CONFLICT ... DO UPDATE SET` clause: a re-poll of an
 * already-written (teammate, date, tool, source) day refreshes cost/tokens/
 * raw_payload and keeps the recorded placement.
 *
 * THE NEAREST-COST-OWNING-ANCESTOR LOOKUP mirrors the LATERAL join used by
 * `v_finance_bill_chargeback` (migration 0073) and `fetchOverageDrivers`
 * (server/reporting/finance.ts) — same semantics (the nearest active
 * `is_cost_owning_unit` ancestor of the teammate's CURRENT org unit, evaluated
 * at the moment the snapshot is taken). It is duplicated here rather than
 * imported because each call site is a handful of scalar SQL fragments
 * embedded directly into that writer's own INSERT, not a standalone query —
 * matching the project's existing precedent of independently-maintained SQL
 * copies over near-identical single-purpose queries (e.g. migrations 0073 /
 * 0084 / 0086). NULL when the teammate has no cost-owning ancestor — never
 * guessed; the explicit unallocated bucket the design requires.
 */
import { sql, type SQL } from 'drizzle-orm'

/** Stamped by every writer's INITIAL insert of a (teammate, date, tool,
 *  source) row — the dimensions reflect the teammate's placement AT WRITE (or
 *  replay) TIME, which is the best evidence available for that row. */
export const DIMENSION_SOURCE_INGEST_SNAPSHOT = 'ingest-snapshot'

/** Stamped ONLY by migration 0101's one-time backfill of rows that predate
 *  these columns. They carry no point-in-time evidence, so the current
 *  teammate placement is recorded and labelled — never represented as
 *  historical truth. */
export const DIMENSION_SOURCE_LEGACY_CURRENT_PLACEMENT = 'legacy-current-placement'

export interface TeammateDimensionSnapshotSql {
  regionId: SQL
  orgUnitId: SQL
  costOwningUnitId: SQL
}

/**
 * Three scalar-subquery SQL fragments resolving `teammateIdSql`'s CURRENT
 * region / org unit / nearest active cost-owning ancestor, for embedding
 * directly into a writer's INSERT (its VALUES or SELECT list) alongside
 * `DIMENSION_SOURCE_INGEST_SNAPSHOT`.
 *
 * `teammateIdSql` must be a single bound value (e.g. `` sql`${agg.teammateId}::uuid` ``)
 * or a plain column reference of the INSERT's own SELECT (provider-fact.ts
 * passes `v.teammate_id`, its record set's uuid column) — it is inlined into
 * three independent subqueries, so a non-deterministic expression would
 * evaluate three times and could disagree with itself.
 */
export function teammateDimensionSnapshotSql(teammateIdSql: SQL): TeammateDimensionSnapshotSql {
  return {
    regionId: sql`(SELECT t.region_id FROM teammate t WHERE t.id = ${teammateIdSql})`,
    orgUnitId: sql`(SELECT t.org_unit_id FROM teammate t WHERE t.id = ${teammateIdSql})`,
    costOwningUnitId: sql`(
      SELECT anc.id
      FROM teammate home_t
      JOIN org_unit home ON home.id = home_t.org_unit_id
      JOIN org_unit anc ON home.path <@ anc.path AND anc.region_id = home.region_id
      WHERE home_t.id = ${teammateIdSql} AND anc.is_cost_owning_unit AND anc.retired_at IS NULL
      ORDER BY nlevel(anc.path) DESC LIMIT 1
    )`,
  }
}
