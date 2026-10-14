/*
 * Bill-driven provision + placement orchestration
 * (docs/design/org-tree-and-bill-driven-placement.md).
 *
 * Pure-ish: it depends on a PlacementStore PORT (the DB ops) + a directory lookup,
 * both injectable — so the orchestration is unit-tested with fakes, while the SQL
 * store is integration-tested in CI. The money/sign-in correctness lives in the
 * store SQL (region trigger, bill: oid, replay idempotency) + decidePlacement.
 */
import { consola } from 'consola'
import { getDirectoryUserByMailOrUpn, type DirectoryUser } from '../azure/directory'
import { decidePlacement, type PlacementCandidate, type PlacementReason } from './placement'
import type { DirectorySnapshot } from './directory-snapshot'
import type { OwnedUnit, RegionRuleSet } from './region-derivation'
import {
  PLACED_VIA_ATTRIBUTE_RULE,
  PLACED_VIA_MANAGER_CHAIN,
  type PlacementProvenance,
} from './placement-provenance'
import type { RegionAttributeKey } from '../../shared/placement/region-attributes'

/** The DB operations provisionAndPlace needs. The SQL adapter (CI-tested) sets
 *  org_unit_id; teammate.region_id follows automatically via the mig-0066 trigger
 *  — callers NEVER set region_id directly (that's the H-A invariant). */
export interface PlacementStore {
  /** Existing REAL (NOT provisional) teammate for this email: its id, whether it sits on
   *  a __UNPLACED__ holding node, and whether it is SAFE to auto re-home cross-region
   *  (never-adopted bill placeholder with no live emit instance). null when none. */
  findTeammateByEmail(
    email: string,
  ): Promise<{ id: string; onUnplaced: boolean; rehomeSafe: boolean } | null>
  /** Cost-owning, active units that carry a cost_centre_code (placement candidates). */
  loadCostOwningCandidates(): Promise<PlacementCandidate[]>
  /** The GLOBAL __unassigned__ holding org_unit id (last-resort fallback). */
  unplacedOrgUnitId(): Promise<string>
  /** The per-region __UNPLACED__ holding org_unit id (mig 0068), create-on-demand. */
  unplacedOrgUnitIdForRegion(regionId: string): Promise<string>
  /** Curated directory-attribute → region rules, pre-indexed (mig 0089). */
  loadDirectoryRegionRules(): Promise<RegionRuleSet>
  /** Active region_leader oid → region_id map (mig 0068 manager-walk target). */
  loadActiveRegionLeaders(): Promise<Map<string, string>>
  /** Active cou_owner → owned cost-owning units, keyed on the owner's REAL Entra oid (the
   *  manager-chain match key). An owner may own >1 unit (ambiguous; resolved by the walk).
   *  Owners without a real oid (bill:/provisional:) are excluded. (Practice extension.) */
  loadActiveUnitOwners(): Promise<Map<string, OwnedUnit[]>>
  /** Create a REAL teammate from a provider-attested bill email (entra_oid='bill:'||uuid),
   *  homed to orgUnitId. Returns the new id. region_id is set by the trigger. */
  createBillTeammate(args: { email: string; displayName: string | null; orgUnitId: string }): Promise<string>
  /**
   * Re-home an existing teammate to orgUnitId (region_id follows via the trigger),
   * re-asserting rehome-safety under the teammate lock. Returns whether it moved.
   */
  homeTeammate(teammateId: string, orgUnitId: string): Promise<boolean>
  /**
   * Re-home ONLY if every precondition still holds AT WRITE TIME: the teammate is
   * still safe to move without the revoke cascade (rehome-safety.ts), is still in
   * `regionId`, and `orgUnitId` is still an active cost-owning unit in that region.
   * Returns whether the row actually moved — false is a SKIP, never a move.
   *
   * The region re-resolve awaits the directory and a manager chain between choosing
   * a candidate and writing it, and every one of those facts is writable by someone
   * else in that window. See the adapter for the lock order.
   */
  homeTeammateIfStillDerivable(
    teammateId: string,
    orgUnitId: string,
    regionId: string,
  ): Promise<boolean>
  /**
   * The re-enrichment worker's write: move (or, when `target.orgUnitId` is the
   * unit it is already on, only re-stamp the provenance of) a teammate chosen by a
   * query and then held across directory awaits — COMPARE-AND-SET, in one
   * transaction. Every fact the selection relied on is re-checked under locks:
   * the rehome-safety predicate, that the teammate is still on
   * `selectedOrgUnitId`, and the target for its kind. 'refused' is a SKIP; nothing
   * was written. See the adapter.
   */
  placeTeammateIfStillSelected(input: CasPlacementInput): Promise<CasPlacementOutcome>
  /**
   * Stamp `last_sync_at` on rows a pass LOOKED AT but did not move. Without it a
   * batched pass ordered oldest-sync-first re-reads the same head every time and
   * never reaches the tail.
   */
  stampPlacementAttempt(teammateIds: string[]): Promise<void>
  /** Stamp (or clear) DERIVED placement PROVENANCE on teammate.metadata. Set when the home
   *  was derived — the manager chain, or a curated attribute rule — into a cost-owning unit,
   *  so a later pass can re-derive the person when the thing that derived them changes;
   *  cleared on a non-unit home. See server/reconciliation/placement-provenance.ts. */
  setPlacementProvenance(teammateId: string, prov: PlacementProvenance | null): Promise<void>
  /** Persist the directory attributes an admin groups the placement worklist by
   *  (server/reconciliation/directory-snapshot.ts). Capture-what-we-already-fetched:
   *  never a re-read, never used to DERIVE a placement. */
  captureDirectorySnapshot(teammateId: string, snap: DirectorySnapshot): Promise<void>
  /** Replay this email's owed bills (pending_placement) into actual_spend for the
   *  now-existing teammate; idempotent. Returns the count replayed. */
  replayOwedBills(teammateId: string, email: string): Promise<number>
}

/**
 * Where a compare-and-set placement may land, by kind:
 *   - 'unit'         — a derived cost-owning unit; must still be active,
 *                      cost-owning and in `regionId`;
 *   - 'holding-node' — the `__UNPLACED__` holding node of `regionId`, or of the
 *                      global holding region when `regionId` is null.
 */
export type CasPlacementTarget =
  | { kind: 'unit'; orgUnitId: string; regionId: string }
  | { kind: 'holding-node'; orgUnitId: string; regionId: string | null }

export interface CasPlacementInput {
  teammateId: string
  /** The org_unit the teammate was on when the candidate query selected it. */
  selectedOrgUnitId: string
  target: CasPlacementTarget
  provenance: PlacementProvenance | null
  /** Names the writer on the audit row. */
  actorSystem: string
}

export type CasPlacementOutcome = 'moved' | 'provenance-only' | 'refused'

/**
 * The teammate's own direct manager as the derivation observed it.
 *
 * Present only when the manager chain was actually walked. ABSENT (undefined on
 * PlacementDerivation) means "we never asked" and a caller must leave any
 * previously-captured value alone; `oid: null` means "we asked, they are the top
 * of the chart". Collapsing those two would let one skipped walk erase a fact a
 * previous run established.
 */
export interface DerivedManager {
  oid: string | null
  email: string | null
}

/** How a cost-centre-unplaced user's home was derived (mig 0068 + the practice extension +
 *  the mig 0089 attribute generalisation + the mig 0112 unit rule). via='unit' → a
 *  cost-owning unit found by the manager chain (chargeable, with orgUnitId + the owner oid
 *  for provenance); via='unit-rule' → a cost-owning unit named by a directory-attribute
 *  RULE, which outranks the chain (spec C5); via='attribute'|'manager' → a region (holding
 *  node); via=null → neither. On 'attribute' and 'unit-rule', `attribute` names the matched
 *  directory field (coverage instrumentation) and `conflict` flags a divergent lower-
 *  precedence match. */
export interface PlacementDerivation {
  orgUnitId?: string
  regionId?: string
  ownerOid?: string
  via: 'unit' | 'unit-rule' | 'attribute' | 'manager' | null
  attribute?: RegionAttributeKey
  conflict?: boolean
  /** See DerivedManager — undefined means the chain was never walked. */
  manager?: DerivedManager
}

export interface PlacementDeps {
  store: PlacementStore
  /** Defaults to the real Graph exact lookup; injected in tests. */
  lookupDirectory?: (email: string) => Promise<DirectoryUser | null>
  /** Placement derivation for cost-centre-unplaced users. Built ONCE per worker run (so the
   *  manager caches + curated maps are shared across all users in the run — AEUF's
   *  cross-user optimisation). Absent → unplaced users use the global bucket (e.g. unit
   *  tests that don't exercise derivation). */
  derivePlacement?: (dir: DirectoryUser) => Promise<PlacementDerivation>
  /** ADR-0010 D4: the billing region the caller already knows (GitHub license-org →
   *  region, via regionForLicenseOrg). When set, a user who can't be placed by Entra
   *  (directory-miss or no cost-centre/derivation) is homed to THIS region's holding
   *  node instead of the GLOBAL __unassigned__ bucket — so a Copilot seat's cost always
   *  lands in the right region (D4's "no truly unplaceable seat at region grain").
   *  Anthropic callers omit it → unchanged global fallback. */
  fallbackRegionId?: string
}

// 'attribute' = a directory-attribute region rule (mig 0089; was 'department').
// 'billing-region' = ADR-0010 D4 GitHub license-org → region fallback (a region
// holding home NOT derived from Entra — previously mislabeled 'department').
// 'unit-rule' = a curated attribute rule naming a cost-owning UNIT (mig 0112). A
// real placement like 'unit' and 'cost-centre', kept as its own value because
// "which signal placed these people" is the coverage question this field answers,
// and folding a rule into the chain's bucket would hide a rule that is placing
// everybody (or nobody).
export type PlacementVia =
  | 'cost-centre'
  | 'unit'
  | 'unit-rule'
  | 'manager'
  | 'attribute'
  | 'billing-region'
  | 'global'

export interface PlaceOutcome {
  teammateId: string
  created: boolean
  /** True = homed at a REAL cost-owning unit (cost-centre match OR manager-chain unit) →
   *  charges that unit's P&L. False = a holding node (region/global, unattributed). */
  placed: boolean
  /** 'directory-miss' = the email wasn't found in Entra at all (no enrichment). */
  reason: PlacementReason | 'directory-miss'
  replayedBills: number
  /** How the home was determined (coverage instrumentation). */
  placedVia: PlacementVia
  /** When placedVia==='attribute', which directory attribute matched (per-attribute
   *  coverage). And whether a lower-precedence attribute matched a DIFFERENT region. */
  placedAttribute?: RegionAttributeKey
  placedConflict?: boolean
  /** True when this call actually created or re-homed the teammate (vs left-in-place). */
  homed: boolean
}

/**
 * Provision (if needed) a teammate for a provider-attested bill email, enrich from
 * Entra, place by cost centre (or the __UNPLACED__ holding node), and replay any
 * owed bills. Idempotent: a second call for the same email re-homes + re-replays
 * (no duplicate teammate, no double-charge — replay is idempotent in the store).
 */
export async function provisionAndPlace(emailRaw: string, deps: PlacementDeps): Promise<PlaceOutcome> {
  const email = emailRaw.trim().toLowerCase()
  const lookup = deps.lookupDirectory ?? getDirectoryUserByMailOrUpn
  const { store } = deps

  // 1. Enrich (exact, single directory match — else we treat as a miss and hold).
  const dir = await lookup(email)

  // 2. Decide the home, in order: (a) exact cost-centre match → that cost-owning unit;
  //    else (b) manager-chain → a cost-owning UNIT (practice; chargeable, Entra is the org
  //    truth); else (c) manager-chain/department → a REGION holding node; else (d) the
  //    global __unassigned__ fallback. (a)+(b) are real placements (placed=true).
  const candidates = await store.loadCostOwningCandidates()
  const decision = dir ? decidePlacement(dir.costCenter, candidates) : null
  const reason: PlaceOutcome['reason'] = dir ? decision!.reason : 'directory-miss'

  let orgUnitId: string
  let placedVia: PlacementVia
  let placed: boolean
  let provenance: PlacementProvenance | null = null
  let placedAttribute: RegionAttributeKey | undefined
  let placedConflict: boolean | undefined
  let derivedManager: PlacementDerivation['manager']
  if (decision?.placed) {
    orgUnitId = decision.orgUnitId!
    placedVia = 'cost-centre'
    placed = true
  } else {
    const der = dir && deps.derivePlacement ? await deps.derivePlacement(dir) : null
    derivedManager = der?.manager
    if (der?.via === 'unit') {
      orgUnitId = der.orgUnitId! // a real cost-owning unit (the owned practice)
      placedVia = 'unit'
      placed = true
      provenance = der.ownerOid ? { via: PLACED_VIA_MANAGER_CHAIN, ownerOid: der.ownerOid } : null
    } else if (der?.via === 'unit-rule') {
      // A curated attribute rule named the unit outright (mig 0112) — it outranks
      // the chain walk, so the derivation already stopped there. Same OUTCOME as a
      // chain unit (a real cost-owning home, chargeable); different provenance, so
      // a later re-resolve re-derives them against the RULE rather than looking for
      // a chain owner that never placed them.
      orgUnitId = der.orgUnitId!
      placedVia = 'unit-rule'
      placed = true
      placedAttribute = der.attribute
      placedConflict = der.conflict
      provenance = der.attribute ? { via: PLACED_VIA_ATTRIBUTE_RULE, attribute: der.attribute } : null
    } else if (der?.regionId) {
      orgUnitId = await store.unplacedOrgUnitIdForRegion(der.regionId)
      placedVia = der.via === 'manager' ? 'manager' : 'attribute'
      if (der.via === 'attribute') {
        placedAttribute = der.attribute
        placedConflict = der.conflict
      }
      placed = false
    } else if (deps.fallbackRegionId) {
      // ADR-0010 D4: no Entra placement, but the caller knows the billing region
      // (GitHub license-org → region). Home to that region's holding node — the seat's
      // cost lands in the right region rather than the global unassigned bucket. Same
      // OUTCOME as a department-derived region home (region holding node, placed=false).
      orgUnitId = await store.unplacedOrgUnitIdForRegion(deps.fallbackRegionId)
      placedVia = 'billing-region'
      placed = false
    } else {
      orgUnitId = await store.unplacedOrgUnitId()
      placedVia = 'global'
      placed = false
    }
  }

  // 3. Find-or-create (region_id follows org_unit_id via the DB trigger — H-A).
  const existing = await store.findTeammateByEmail(email)
  let teammateId: string
  let created = false
  let homed = false
  if (existing === null) {
    teammateId = await store.createBillTeammate({ email, displayName: dir?.displayName ?? null, orgUnitId })
    created = true
    homed = true
  } else {
    teammateId = existing.id
    // Only (re)home a teammate that is (a) still on a holding node AND (b) safe to move
    // cross-region: a never-adopted bill placeholder with no live emit instance/oauth
    // (findTeammateByEmail.rehomeSafe). A teammate on a real node was deliberately placed;
    // a teammate with a live session must go through the admin region-PATCH revoke cascade.
    if (existing.onUnplaced && existing.rehomeSafe) {
      homed = await store.homeTeammate(teammateId, orgUnitId)
    }
  }

  // 3b. Provenance: stamp DERIVED unit placements — the manager chain, or the rule
  //     that named the unit — so a later pass re-derives them when that changes;
  //     clear it on a non-unit (re-)home. Only when we actually homed.
  if (homed) {
    await store.setPlacementProvenance(teammateId, provenance)
  }

  /*
   * 3c. Directory snapshot — the two attributes the placement WORKLIST groups by,
   *     captured from the record step 1 already fetched. Unconditional on `homed`:
   *     a teammate left in place still benefits from a fresh department, and a
   *     directory MISS (dir === null) writes nothing rather than a row of nulls
   *     that would read as "the tenant leaves these empty".
   *
   *     FENCED. This is DISPLAY data and step 4 below is MONEY — replaying the
   *     owed bills into actual_spend. A failed snapshot write must never be the
   *     reason a bill does not land, and it sits before the replay only because
   *     the teammate id is settled here. The caller counts a thrown error as a
   *     failed identity and retries the whole thing next tick; that is the right
   *     handling for a replay failure and the wrong one for a cosmetic column.
   */
  if (dir) {
    try {
      await store.captureDirectorySnapshot(teammateId, {
        department: dir.department,
        companyName: dir.companyName,
        // OMITTED, not nulled, when the derivation never walked the chain: the
        // manager is captured from the walk's own first hop, so "no walk" means
        // "we did not ask" and must leave a previous capture standing.
        ...(derivedManager ? { manager: derivedManager } : {}),
      })
    } catch (err) {
      consola.warn('[placement] directory snapshot failed', {
        email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 4. Replay owed bills now that the teammate exists.
  const replayedBills = await store.replayOwedBills(teammateId, email)

  return { teammateId, created, placed, reason, replayedBills, placedVia, placedAttribute, placedConflict, homed }
}
