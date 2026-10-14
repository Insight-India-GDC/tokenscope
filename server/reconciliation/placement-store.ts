/*
 * SQL adapter for the PlacementStore port (placement-service.ts). All money/region
 * correctness that can't be expressed in the pure layer lives here and is
 * integration-tested against testcontainers Postgres in CI:
 *   - bill teammates get an `entra_oid='bill:'||uuid` placeholder, source='bill',
 *     non-provisional (so the money path's `NOT provisional` filter accepts them);
 *   - region_id is NEVER set by us — the mig-0066 trigger derives it from
 *     org_unit_id (the H-A invariant);
 *   - replayOwedBills drains pending_placement → actual_spend idempotently.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import type { PlacementStore } from './placement-service'
import type { OwnedUnit, RegionRuleSet } from './region-derivation'
import type { RegionAttributeKey } from '../../shared/placement/region-attributes'
import { unplacedOrgUnitIdForRegion as placementHomeForRegion } from '../auth/placement-home'
import {
  UNASSIGNED_REGION_CODE,
  UNPLACED_UNIT_CODE,
  HOLDING_UNIT_TYPE,
} from '../../shared/placement/holding-nodes'
import { teammateDimensionSnapshotSql, DIMENSION_SOURCE_INGEST_SNAPSHOT } from './dimension-snapshot'
import { captureDirectorySnapshot } from './directory-snapshot'
import {
  PLACED_VIA_MANAGER_CHAIN,
  PLACEMENT_AUDIT_EVENT,
  PLACEMENT_PROVENANCE_AUDIT_EVENT,
  reenrichmentCandidatePredicate,
  stripProvenanceKeys,
  type PlacementProvenance,
} from './placement-provenance'
import { rehomeSafePredicate } from './rehome-safety'
import { eligibleUnitOwnerPredicate } from './unit-owner-eligibility'
import { parseActualSpendSourceOrgRef } from './source-org-ref'
import { loadGovernanceResolutionContext, resolveAnthropicVerdict, resolveGithubVerdict } from '../governance/verdict'
import { recordAuditEvent } from '../db/audit'
import { followPlacement } from '../utils/device-lifecycle'

type Db = PostgresJsDatabase<typeof schema>

/*
 * DERIVED-placement provenance on teammate.metadata. Set so a later pass can
 * re-derive the person when the thing that derived them changes — their Entra
 * manager, or the curated rule that named the unit; cleared on a non-unit home.
 * Merge/strip only the keys in PLACEMENT_PROVENANCE_KEYS (preserve other metadata).
 * One writer for the store's plain setter and the compare-and-set placement.
 */
async function writePlacementProvenance(
  db: Pick<Db, 'execute'>,
  teammateId: string,
  prov: PlacementProvenance | null,
): Promise<void> {
  if (prov) {
    await db.execute(sql`
      UPDATE teammate
      SET metadata = (coalesce(metadata, '{}'::jsonb) ${stripProvenanceKeys()})
        || jsonb_build_object(
             'placedVia', ${prov.via}::text,
             ${prov.via === PLACED_VIA_MANAGER_CHAIN ? sql`'placedOwnerOid', ${prov.ownerOid}::text,` : sql`'placedAttribute', ${prov.attribute}::text,`}
             'placedAt', now())
      WHERE id = ${teammateId}::uuid`)
  } else {
    await db.execute(sql`
      UPDATE teammate
      SET metadata = (coalesce(metadata, '{}'::jsonb) ${stripProvenanceKeys()})
      WHERE id = ${teammateId}::uuid
        AND metadata ? 'placedVia'`)
  }
}

export function makePlacementStore(db: Db): PlacementStore {
  return {
    async findTeammateByEmail(email) {
      // Join the home unit so the caller can tell a deliberately-placed teammate
      // (real node) from one still on a HOLDING node — only the latter may be re-homed
      // by the bill path (see provisionAndPlace). org_unit_id is NOT NULL, so the
      // join never drops the row.
      //
      // on_unplaced is keyed on unit_type, the classification key
      // (shared/placement/holding-nodes.ts), for the same reason the worklist and
      // region-reenrichment are: a teammate parked on a SECOND holding node has no
      // genuine placement either, and keyed on the code this lane would have read
      // them as deliberately placed and refused to re-home them.
      //
      // rehome_safe (mig-0068 cross-region safety): a (re)home can move the teammate to
      // a DIFFERENT region (cost-centre match or derived region), which changes their RLS
      // scope. The admin region-PATCH runs a revoke cascade (revoked_at + revoke interactive
      // OAuth, #414) for exactly this reason; the worker's homeTeammate does NOT. So the
      // worker may only auto-move a teammate that is (a) a never-adopted bill placeholder
      // AND (b) has NO live emit instance AND no live OAuth credential — i.e. no live
      // session to re-scope (stricter than the admin region-PATCH cascade, which no
      // longer ends devices). Anything with a real oid or a live credential is left for the admin worklist.
      const rows = await db.execute<{ id: string; on_unplaced: boolean; rehome_safe: boolean }>(sql`
        SELECT t.id::text AS id,
               (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_unplaced,
               (t.entra_oid LIKE 'bill:%'
                AND NOT EXISTS (
                  SELECT 1 FROM instance_attestation ia
                  WHERE ia.teammate_id = t.id AND ia.ts_actual_end IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM oauth_token o
                  WHERE o.teammate_id = t.id AND o.revoked_at IS NULL
                )) AS rehome_safe
        FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
        WHERE lower(t.email) = lower(${email}) AND NOT t.provisional
        ORDER BY t.id LIMIT 1`)
      const r = rows[0]
      return r ? { id: r.id, onUnplaced: r.on_unplaced, rehomeSafe: r.rehome_safe } : null
    },

    async loadCostOwningCandidates() {
      const rows = await db.execute<{ org_unit_id: string; region_id: string; cost_centre_code: string }>(sql`
        SELECT id::text AS org_unit_id, region_id::text AS region_id, cost_centre_code
        FROM org_unit
        WHERE is_cost_owning_unit AND retired_at IS NULL AND cost_centre_code IS NOT NULL`)
      return rows.map((r) => ({ orgUnitId: r.org_unit_id, regionId: r.region_id, costCentreCode: r.cost_centre_code }))
    },

    async unplacedOrgUnitId() {
      // Create-on-demand (NOT migration-seeded — a seed pollutes other tests'
      // `SELECT ... FROM region/org_unit LIMIT 1` fixtures). Idempotent.
      await db.execute(sql`
        INSERT INTO region (id, code, display_name)
        VALUES (gen_random_uuid(), ${UNASSIGNED_REGION_CODE}, 'Unassigned')
        ON CONFLICT (code) DO NOTHING`)
      await db.execute(sql`
        INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
        SELECT gen_random_uuid(), r.id, 'unassigned'::ltree, ${UNPLACED_UNIT_CODE}, 'Unplaced', ${HOLDING_UNIT_TYPE}, false
        FROM region r WHERE r.code = ${UNASSIGNED_REGION_CODE}
        ON CONFLICT (region_id, code) DO NOTHING`)
      const rows = await db.execute<{ id: string }>(sql`
        SELECT ou.id::text AS id
        FROM org_unit ou JOIN region r ON r.id = ou.region_id
        WHERE r.code = ${UNASSIGNED_REGION_CODE} AND ou.code = ${UNPLACED_UNIT_CODE} LIMIT 1`)
      const id = rows[0]?.id
      if (!id) throw new Error(`placement: failed to create ${UNPLACED_UNIT_CODE} holding node`)
      return id
    },

    async unplacedOrgUnitIdForRegion(regionId) {
      // S3: lifted into server/auth/placement-home.ts (the shared "no genuine
      // placement" destination — the SSO/directory/enroll placement writers now
      // call it too, instead of each hand-rolling their own "first unit in the
      // region" query). This adapter method is kept so PlacementStore callers
      // (the bill-driven lane) are unaffected; it now delegates rather than
      // duplicating the SQL. The cast matches the pattern used across the
      // codebase (e.g. server/db/request-rls.ts) for a schema-typed db passed to
      // a Record<string, unknown>-typed shared helper.
      return placementHomeForRegion(db as unknown as PostgresJsDatabase<Record<string, unknown>>, regionId)
    },

    async loadDirectoryRegionRules(): Promise<RegionRuleSet> {
      // Curated (attribute, match_value, match_mode) → target rules. Cached per run
      // by the caller; small table. Exact rules → a keyed map (O(1)); prefix rules →
      // a list scanned longest-first so the most specific prefix wins.
      //
      // A rule's target is the UNIT when org_unit_id is set (mig 0112) and the region
      // otherwise. The unit is filtered to one that can actually receive a placement —
      // active and cost-owning — for the same reason the bulk action refuses anything
      // else: a rule pointing at a retired or non-cost-owning unit would silently home
      // spend somewhere it still reaches no cost centre.
      //
      // A UNIT RULE WHOSE TARGET IS NO LONGER VALID IS DROPPED, NOT DEGRADED, and the
      // difference is a privilege boundary rather than a nicety. Degrading it to
      // `{ orgUnitId: null, regionId }` produces a REGION rule — the exact artefact a
      // region admin is forbidden to author (directory-region-rules.post.ts: a region
      // rule is org-wide placement configuration and takes global finance access).
      // Retiring the unit would then hand its author org-wide config they could not
      // have written: the degraded rule decides which REGION every matching person
      // lands in, including people whose own chain resolves elsewhere, because an
      // attribute region rule outranks a chain region leader. So an invalid unit rule
      // places NOBODY until its target is fixed or the rule is re-pointed; the admin
      // list already reports it as `target_placeable: false` so it is visible rather
      // than mysteriously inert.
      const rows = await db.execute<{
        attribute: string
        match_value: string
        match_mode: string
        region_id: string
        org_unit_id: string | null
        target_dead: boolean
      }>(sql`
        SELECT d.attribute, d.match_value, d.match_mode, d.region_id::text AS region_id,
               CASE WHEN ou.id IS NOT NULL THEN ou.id::text END AS org_unit_id,
               (d.org_unit_id IS NOT NULL AND ou.id IS NULL) AS target_dead
        FROM directory_region_rule d
        LEFT JOIN org_unit ou
          ON ou.id = d.org_unit_id AND ou.retired_at IS NULL AND ou.is_cost_owning_unit`)
      const exact: RegionRuleSet['exact'] = new Map()
      const prefix: RegionRuleSet['prefix'] = []
      for (const r of rows) {
        if (r.target_dead) continue
        const attr = r.attribute as RegionAttributeKey
        const target = { regionId: r.region_id, orgUnitId: r.org_unit_id }
        if (r.match_mode === 'prefix') {
          prefix.push({ attribute: attr, value: r.match_value, target })
        } else {
          let m = exact.get(attr)
          if (!m) {
            m = new Map()
            exact.set(attr, m)
          }
          m.set(r.match_value, target)
        }
      }
      prefix.sort((a, b) => b.value.length - a.value.length)
      return { exact, prefix }
    },

    async loadActiveRegionLeaders() {
      // leader_oid → region_id, active rows only (the manager-walk fallback target).
      const rows = await db.execute<{ leader_oid: string; region_id: string }>(sql`
        SELECT leader_oid, region_id::text AS region_id
        FROM region_leader WHERE revoked_at IS NULL`)
      return new Map(rows.map((r) => [r.leader_oid, r.region_id]))
    },

    async loadActiveUnitOwners() {
      // owner's real Entra oid → the cost-owning unit(s) they actively own (cou_owner). The
      // owner oid is the manager-chain match key, so exclude owners without a REAL oid
      // (bill:/provisional: placeholders can't appear in a chain). An owner may own >1 unit
      // (the resolver treats that as ambiguous). The target is the OWNED unit, independent
      // of where the owner teammate is themselves homed.
      // The eligibility clause is eligibleUnitOwnerPredicate — the SAME expression
      // the C9 catch-all warning tests occupants against. Two copies of it is how
      // the warning ends up suppressing exactly the people this walk cannot place.
      const rows = await db.execute<{ owner_oid: string; org_unit_id: string; region_id: string }>(sql`
        SELECT t.entra_oid AS owner_oid, ou.id::text AS org_unit_id, ou.region_id::text AS region_id
        FROM cou_owner co
        JOIN teammate t ON t.id = co.teammate_id
        JOIN org_unit ou ON ou.id = co.org_unit_id
        WHERE ${eligibleUnitOwnerPredicate(sql`co`, sql`t`, sql`ou`)}`)
      const map = new Map<string, OwnedUnit[]>()
      for (const r of rows) {
        const arr = map.get(r.owner_oid) ?? []
        arr.push({ orgUnitId: r.org_unit_id, regionId: r.region_id })
        map.set(r.owner_oid, arr)
      }
      return map
    },

    async createBillTeammate({ email, displayName, orgUnitId }) {
      // region_id is provided AND re-derived by the trigger (belt-and-suspenders);
      // entra_oid placeholder keeps the row inert until a real login adopts it.
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO teammate (entra_oid, email, display_name, org_unit_id, region_id, source, provisional)
        VALUES ('bill:' || gen_random_uuid(), lower(${email}), ${displayName},
                ${orgUnitId}::uuid,
                (SELECT region_id FROM org_unit WHERE id = ${orgUnitId}::uuid),
                'bill', false)
        RETURNING id::text AS id`)
      return rows[0]!.id
    },

    async homeTeammate(teammateId, orgUnitId) {
      // org_unit_id only; region_id follows via the mig-0066 trigger. The caller's
      // rehome_safe came from an earlier read: re-asserted here under the teammate
      // lock (FOR UPDATE conflicts with a device INSERT's FOR KEY SHARE, as in
      // homeTeammateIfStillDerivable), so a device provisioned since is never
      // moved without its revoke cascade (#417).
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM teammate WHERE id = ${teammateId}::uuid FOR UPDATE`)
        const moved = await tx.execute<{ id: string }>(sql`
          UPDATE teammate t SET org_unit_id = ${orgUnitId}::uuid, last_sync_at = now()
          WHERE t.id = ${teammateId}::uuid AND ${rehomeSafePredicate(sql`t`)}
            -- Still on a holding node, as when the caller selected it: an admin
            -- placement made since is deliberate and is not overwritten.
            AND EXISTS (SELECT 1 FROM org_unit cur WHERE cur.id = t.org_unit_id AND cur.unit_type = ${HOLDING_UNIT_TYPE})
          RETURNING t.id::text AS id`)
        if ([...moved].length === 0) return false
        await followPlacement(tx as never, teammateId)
        return true
      })
    },

    async homeTeammateIfStillDerivable(teammateId, orgUnitId, regionId) {
      /*
       * THE SAME WRITE, WITH ITS PRECONDITIONS RE-ASSERTED AT WRITE TIME.
       *
       * The region re-resolve chooses a candidate from a query and then awaits the
       * directory and a manager chain before writing. Every fact that made the move
       * legal is re-readable and re-writable during those awaits:
       *
       *   - the SAFETY predicate. `rehomeSafePredicate` is the control that keeps an
       *     automatic lane off anyone with a live session to re-scope. Evaluated only
       *     as a candidate filter, an emit instance or an OAuth token created during
       *     the awaits is re-scoped with no revoke cascade — precisely what the
       *     predicate exists to prevent.
       *   - the DESTINATION. It can be retired, un-flagged as cost-owning, or moved to
       *     another region in the same window, so "an active cost-owning unit in this
       *     region" is a fact about the preview, not about the write.
       *
       * So both are conditions of the UPDATE itself, and RETURNING reports whether the
       * row actually moved. A false here is a SKIP, never a move.
       *
       * ORDER OF LOCKS, and why the plain conditional UPDATE is not enough on its own.
       * A no-key UPDATE takes FOR NO KEY UPDATE, which does NOT conflict with the
       * FOR KEY SHARE an instance_attestation / oauth_token INSERT takes on its parent
       * teammate row — so a concurrent credential insert neither blocks nor is seen.
       * The explicit `FOR UPDATE` does conflict with it: an insert already in flight
       * makes us wait and is then visible to the UPDATE's own (fresh, READ COMMITTED)
       * snapshot, and one starting after us waits for our commit. The destination is
       * pinned FOR SHARE second — the same lock, in the same order, as
       * server/db/place-teammate.ts, so the two placement writers cannot deadlock
       * against each other.
       *
       * Wrapped in its own transaction so the lock and the write are atomic on a
       * worker's pooled handle too; inside the endpoint's request transaction this is
       * a savepoint, and the locks are held to the outer commit either way.
       */
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM teammate WHERE id = ${teammateId}::uuid FOR UPDATE`)
        await tx.execute(sql`SELECT 1 FROM org_unit WHERE id = ${orgUnitId}::uuid FOR SHARE`)
        const moved = await tx.execute<{ id: string }>(sql`
          UPDATE teammate t
          SET org_unit_id = ${orgUnitId}::uuid, last_sync_at = now()
          WHERE t.id = ${teammateId}::uuid
            AND t.is_active = TRUE
            AND t.region_id = ${regionId}::uuid
            AND t.org_unit_id <> ${orgUnitId}::uuid
            AND ${rehomeSafePredicate(sql`t`)}
            AND EXISTS (
              SELECT 1 FROM org_unit ou
              WHERE ou.id = ${orgUnitId}::uuid
                AND ou.region_id = ${regionId}::uuid
                AND ou.retired_at IS NULL
                AND ou.is_cost_owning_unit
            )
          RETURNING t.id::text AS id`)
        if ([...moved].length === 0) return false
        // Moves nothing while rehome_safe holds; keeps the rule true if it changes (#417).
        await followPlacement(tx as never, teammateId)
        return true
      })
    },

    async placeTeammateIfStillSelected({ teammateId, selectedOrgUnitId, target, provenance, actorSystem }) {
      /*
       * COMPARE-AND-SET for the re-enrichment worker. It selects a candidate by
       * query, then awaits the directory and a manager chain — seconds, more under
       * throttling — before writing. In that window someone can sign in (a live
       * credential: no longer rehome-safe), an admin can move the person by hand,
       * and the target can be retired or un-flagged as cost-owning. Writing the
       * stale decision would re-scope a live session with no revoke cascade,
       * undo an admin's placement, or home spend on a dead unit.
       *
       * homeTeammateIfStillDerivable cannot be reused: it requires a same-region
       * cost-owning target, and these moves cross regions and land on holding
       * nodes. Its LOCK ORDER is reused exactly — teammate FOR UPDATE, then the
       * target FOR SHARE (as server/db/place-teammate.ts) — and so is its reason:
       * FOR UPDATE conflicts with the FOR KEY SHARE that an instance_attestation /
       * oauth_token INSERT takes on the teammate, so a credential created during
       * the awaits is either visible to the re-check below or waits for our commit.
       *
       * The re-check is the SAME candidate predicate the selection used
       * (reenrichmentCandidatePredicate: rehome-safe, AND on a holding node or
       * placed by a derivation), plus "still on the unit it was selected on", plus
       * the target for its kind. The candidate predicate is what refuses an admin
       * move that ended on the selected unit (U → V → U): the unit compares equal,
       * but the manual placement stripped the derived provenance. Then:
       *   - unit:         active, cost-owning, in the derived region;
       *   - holding-node: the __UNPLACED__ holding node of the expected region
       *                   (the global holding region when regionId is null).
       * Any miss → 'refused', nothing written.
       *
       * The provenance-only case (target = the unit it is already on) runs through
       * the same checks: a re-stamped derivation on someone who just signed in, or
       * was just placed by an admin, would mark an assertion re-derivable.
       */
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM teammate WHERE id = ${teammateId}::uuid FOR UPDATE`)
        await tx.execute(sql`SELECT 1 FROM org_unit WHERE id = ${target.orgUnitId}::uuid FOR SHARE`)
        const targetStillValid =
          target.kind === 'unit'
            ? sql`ou.retired_at IS NULL AND ou.is_cost_owning_unit AND ou.region_id = ${target.regionId}::uuid`
            : sql`ou.unit_type = ${HOLDING_UNIT_TYPE} AND ou.code = ${UNPLACED_UNIT_CODE}
                  AND ou.region_id = ${
                    target.regionId === null
                      ? sql`(SELECT r.id FROM region r WHERE r.code = ${UNASSIGNED_REGION_CODE})`
                      : sql`${target.regionId}::uuid`
                  }`
        const still = await tx.execute<{ via: string | null; owner_oid: string | null; attribute: string | null }>(sql`
          SELECT t.metadata->>'placedVia' AS via,
                 t.metadata->>'placedOwnerOid' AS owner_oid,
                 t.metadata->>'placedAttribute' AS attribute
          FROM teammate t
          JOIN org_unit cur ON cur.id = t.org_unit_id
          WHERE t.id = ${teammateId}::uuid
            AND t.org_unit_id = ${selectedOrgUnitId}::uuid
            AND ${reenrichmentCandidatePredicate(sql`t`, sql`cur`)}
            AND EXISTS (
              SELECT 1 FROM org_unit ou
              WHERE ou.id = ${target.orgUnitId}::uuid AND ${targetStillValid}
            )`)
        const before = [...still][0]
        if (!before) return 'refused'

        const moving = target.orgUnitId !== selectedOrgUnitId
        // org_unit_id only; region_id follows via the mig-0066 trigger.
        await tx.execute(
          moving
            ? sql`UPDATE teammate SET org_unit_id = ${target.orgUnitId}::uuid, last_sync_at = now()
                  WHERE id = ${teammateId}::uuid`
            : sql`UPDATE teammate SET last_sync_at = now() WHERE id = ${teammateId}::uuid`,
        )
        await writePlacementProvenance(tx, teammateId, provenance)
        if (moving) {
          // Moves nothing while the candidate predicate holds (rehome-safe); keeps
          // the rule true if it changes (#417).
          await followPlacement(tx as never, teammateId)
          // In the same transaction as the move: an audit row for a move that
          // rolled back, or a move with no audit row, are both worse than neither.
          await recordAuditEvent(tx as unknown as PostgresJsDatabase<Record<string, unknown>>, {
            eventType: PLACEMENT_AUDIT_EVENT,
            actorSystem,
            subjectKind: 'teammate',
            subjectId: teammateId,
            payload: {
              previousOrgUnitId: selectedOrgUnitId,
              newOrgUnitId: target.orgUnitId,
              targetKind: target.kind,
              placedVia: provenance?.via ?? null,
              sessionsRevoked: false,
            },
          })
        }
        if (!moving) {
          // A provenance-only write is audited when — and only when — it changes
          // the stored provenance (placedAt aside, which every write restamps), in
          // the same transaction. An unchanged re-derivation every 6 hours would
          // otherwise be an audit row per person per run that says nothing.
          const after = {
            via: provenance?.via ?? null,
            owner_oid: provenance?.via === PLACED_VIA_MANAGER_CHAIN ? provenance.ownerOid : null,
            attribute: provenance && provenance.via !== PLACED_VIA_MANAGER_CHAIN ? provenance.attribute : null,
          }
          const prior = { via: before.via, owner_oid: before.owner_oid, attribute: before.attribute }
          if (prior.via !== after.via || prior.owner_oid !== after.owner_oid || prior.attribute !== after.attribute) {
            await recordAuditEvent(tx as unknown as PostgresJsDatabase<Record<string, unknown>>, {
              eventType: PLACEMENT_PROVENANCE_AUDIT_EVENT,
              actorSystem,
              subjectKind: 'teammate',
              subjectId: teammateId,
              payload: {
                orgUnitId: selectedOrgUnitId,
                before: { placedVia: prior.via, placedOwnerOid: prior.owner_oid, placedAttribute: prior.attribute },
                after: { placedVia: after.via, placedOwnerOid: after.owner_oid, placedAttribute: after.attribute },
              },
            })
          }
        }
        return moving ? 'moved' : 'provenance-only'
      })
    },

    async stampPlacementAttempt(teammateIds) {
      if (teammateIds.length === 0) return
      // The batching cursor. A pass that leaves an unresolved / errored /
      // out-of-region / already-correct row untouched leaves it at the FRONT of
      // `ORDER BY last_sync_at NULLS FIRST` for ever, so every limited pass re-reads
      // the same head while `remaining` keeps telling the admin to run again and the
      // tail is never reached. Stamping what was LOOKED AT (which is what a sync
      // timestamp means — the directory was read for this row) is what advances it.
      await db.execute(sql`
        UPDATE teammate SET last_sync_at = now()
        WHERE id IN (${sql.join(teammateIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
    },

    async setPlacementProvenance(teammateId, prov) {
      await writePlacementProvenance(db, teammateId, prov)
    },

    async captureDirectorySnapshot(teammateId, snap) {
      await captureDirectorySnapshot(
        db as unknown as PostgresJsDatabase<Record<string, never>>,
        teammateId,
        snap,
      )
    },

    async replayOwedBills(teammateId, email) {
      // Dimension snapshot (mig 0101): the teammate is only just now being placed
      // (that's what triggers a replay), so "at replay time" = "now" is the
      // earliest and only evidence available — stamped on INSERT, omitted from
      // the ON CONFLICT SET list so a later re-poll of the same day cannot
      // re-home it (server/reconciliation/dimension-snapshot.ts).
      const teammateIdSql = sql`${teammateId}::uuid`
      const dims = teammateDimensionSnapshotSql(teammateIdSql)

      // Governance verdict (mig 0103, Workstream B): each owed row already carries
      // its governance key (resolved at ENQUEUE time — see enqueueOwedBill); the
      // verdict itself is computed HERE, at replay, from CURRENT governance (never
      // stale-cached from enqueue time, which could predate a billing edit).
      // Wrapped in one transaction with the placement update below so a crash
      // mid-replay cannot leave rows selected-but-unplaced.
      return await db.transaction(async (tx) => {
        const owed = await tx.execute<{
          id: string
          actual_source: string
          tool: string
          date: string
          cost_usd: string
          input_tokens: string
          output_tokens: string
          raw_payload: unknown
          provider: string
          provider_org_id: string | null
          provider_enterprise_id: string | null
        }>(sql`
          SELECT id::text AS id, actual_source, tool, date::text AS date, cost_usd::text AS cost_usd,
                 input_tokens::text AS input_tokens, output_tokens::text AS output_tokens, raw_payload,
                 provider, provider_org_id::text AS provider_org_id, provider_enterprise_id::text AS provider_enterprise_id
          FROM pending_placement
          WHERE lower(identity_email) = lower(${email}) AND placed_at IS NULL
          FOR UPDATE
        `)
        if (owed.length === 0) return 0

        const ctx = await loadGovernanceResolutionContext(tx)
        for (const o of owed) {
          const verdict =
            o.provider === 'anthropic'
              ? resolveAnthropicVerdict(ctx, { providerOrgId: o.provider_org_id })
              : resolveGithubVerdict(ctx, {
                  providerEnterpriseId: o.provider_enterprise_id,
                  enterpriseSlug: '',
                  licenseOrg: parseActualSpendSourceOrgRef(o.actual_source).externalOrgId,
                })

          await tx.execute(sql`
            INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, raw_payload,
              region_id, org_unit_id, cost_owning_unit_id, dimension_source,
              provider_org_id, provider_enterprise_id, governance_key_status,
              chargeback_exempt, governance_verdict_source)
            VALUES (${teammateId}::uuid, ${o.date}::date, ${o.tool}, ${o.input_tokens}::bigint, ${o.output_tokens}::bigint,
              ${o.cost_usd}::numeric, ${o.actual_source}, ${JSON.stringify(o.raw_payload)}::jsonb,
              ${dims.regionId}, ${dims.orgUnitId}, ${dims.costOwningUnitId}, ${DIMENSION_SOURCE_INGEST_SNAPSHOT},
              ${o.provider_org_id}::uuid, ${o.provider_enterprise_id}::uuid,
              ${o.provider_org_id || o.provider_enterprise_id ? 'resolved' : 'unresolved'},
              ${verdict.exempt}, ${verdict.source})
            ON CONFLICT (teammate_id, date, tool, source) DO UPDATE SET
              cost_usd = EXCLUDED.cost_usd, input_tokens = EXCLUDED.input_tokens,
              output_tokens = EXCLUDED.output_tokens, raw_payload = EXCLUDED.raw_payload, pulled_at = now(),
              provider_org_id = EXCLUDED.provider_org_id, provider_enterprise_id = EXCLUDED.provider_enterprise_id,
              governance_key_status = EXCLUDED.governance_key_status,
              chargeback_exempt = EXCLUDED.chargeback_exempt,
              governance_verdict_source = EXCLUDED.governance_verdict_source
          `)
        }

        await tx.execute(sql`
          UPDATE pending_placement SET placed_at = now()
          WHERE id IN (${sql.join(owed.map((o) => sql`${o.id}::uuid`), sql`, `)})
        `)
        return owed.length
      })
    },
  }
}

/* Enqueue an owed bill for an as-yet-unprovisioned identity (the bill writers call
 * this instead of dropping unknown emails). Idempotent on the natural bill key;
 * refreshes the amount + last_seen on re-poll. */
export async function enqueueOwedBill(
  db: Db,
  o: {
    provider: string
    actualSource: string
    email: string
    tool: string
    date: string
    costUsd: number
    inputTokens?: number
    outputTokens?: number
    raw?: unknown
    /** Governance key (mig 0103), resolved ONCE by the caller — carried
     *  unchanged into actual_spend by replayOwedBills below (no re-resolution
     *  at replay time). Omitted/null = unresolved (governance-unresolved). */
    providerOrgId?: string | null
    providerEnterpriseId?: string | null
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pending_placement
      (provider, actual_source, identity_email, tool, date, cost_usd, input_tokens, output_tokens, raw_payload,
       provider_org_id, provider_enterprise_id)
    VALUES (${o.provider}, ${o.actualSource}, lower(${o.email}), ${o.tool}, ${o.date}::date,
            ${o.costUsd.toFixed(6)}::numeric, ${o.inputTokens ?? 0}::bigint, ${o.outputTokens ?? 0}::bigint,
            ${o.raw === undefined ? null : JSON.stringify(o.raw)}::jsonb,
            ${o.providerOrgId ?? null}::uuid, ${o.providerEnterpriseId ?? null}::uuid)
    ON CONFLICT (provider, actual_source, identity_email, tool, date) DO UPDATE SET
      cost_usd = EXCLUDED.cost_usd, input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens, raw_payload = EXCLUDED.raw_payload, last_seen_at = now(),
      provider_org_id = EXCLUDED.provider_org_id, provider_enterprise_id = EXCLUDED.provider_enterprise_id`)
}
