/*
 * holding-nodes — the reserved codes for "this teammate has no genuine
 * placement yet", as ONE constant each rather than a literal per call site.
 *
 * These are PRODUCT sentinels, not one organisation's structure: the platform
 * mints them itself when placement finds nothing, so they carry no tenant name,
 * no region list and no assumed tree depth (open-source portability).
 *
 * WHY A MODULE. The "no region" case is NOT a NULL column — placement writes a
 * REAL region row and a REAL org_unit row and points the teammate at them. A
 * reader that classifies on `region_id IS NULL` therefore measures $0.00
 * forever: a term that cannot fail.
 *
 * WHAT IS GUARANTEED, exactly. No non-test site anywhere in `server/`,
 * `shared/`, `app/` or `drizzle/` types one of these values — every site that
 * WRITES or RECOGNISES a holding node imports the constant, so renaming one is a
 * compile-time rename rather than a silent zero in whichever reader was missed.
 * That is enforced over a DISCOVERED file walk of those four trees, not a list
 * (tests/unit/usage/one-expression-invariants.test.ts): a list cannot see the
 * file nobody added to it, which is the only regression worth enforcing against.
 *
 * The importers, so the next reader can check the claim instead of trusting it —
 * and the same test fails if this list gains a stale entry or misses a new one:
 *
 *   writers  server/auth/placement-home.ts
 *            server/reconciliation/placement-store.ts
 *   readers  server/usage/unhomed-causes.ts        (the cause classifier)
 *            server/auth/org-subtree-scope.ts      (the S3 security clamp)
 *            server/reporting/regional.ts          (region picker)
 *            server/workers/region-reenrichment.ts (re-enrichment candidates)
 *            server/reconciliation/placement-provenance.ts
 *                                                  (the candidate predicate the
 *                                                   worker and its compare-and-set
 *                                                   share)
 *            server/reconciliation/region-reresolve.ts
 *                                                  (the region-scoped re-resolve's
 *                                                   candidate set)
 *            server/reconciliation/placement-check-read.ts
 *                                                  (the placement check's current
 *                                                   home)
 *            server/api/v1/admin/placement-check/apply.post.ts
 *                                                  (the current home, for the verdict)
 *            server/api/v1/admin/regions/[id].delete.ts
 *                                                  (a region's own Unplaced node does
 *                                                   not stop it being deleted)
 *            server/reconciliation/org-setup-read.ts
 *                                                  (the top person's own home: on the
 *                                                   system bucket, or placed)
 *   guards  server/db/org-units.ts                (a holding node may never be
 *                                                   cost-owning — both write doors)
 *            server/db/org-unit-create.ts          (nothing is created or moved under a
 *                                                   holding node; its code is fixed)
 *   worklist server/api/v1/admin/teammates.get.ts  (the unplaced/placed filter)
 *            server/api/v1/admin/region/[regionId]/index.get.ts
 *                                                  (the unplaced count + checklist)
 *            app/pages/admin/regions/[id].vue      (the Unplaced row's worklist link)
 *            app/components/admin/OrgUnitDialog.vue
 *                                                  (hides the cost-owning toggle and
 *                                                   never offers it as a parent)
 *            app/components/admin/MoveOrgUnitDialog.vue
 *                                                  (never offers it as a destination)
 *
 * An earlier version of this header promised that guarantee while six of those
 * readers were still on inline literals, and named only four of them. A false
 * guarantee is worse than none: the next person trusts it.
 *
 * Prose mentions of the sentinels in COMMENTS are deliberately left as literals:
 * a comment that reads `UNPLACED_UNIT_CODE` says less than one that reads
 * `__UNPLACED__`, and a comment cannot silently mis-measure anything. Prose in
 * an ERROR MESSAGE is not exempt — it is executable, so it goes through the
 * constant and cannot outlive a rename. (Both writers' "failed to create" errors
 * spelled it out until the discovered walk above found them; the list-based
 * check never could, because it matched the quoted literal and these embed the
 * token inside a longer string.)
 */

/**
 * The SYSTEM-WIDE holding region — minted by
 * `PlacementStore.unplacedOrgUnitId()` when a teammate could not be placed in
 * ANY real region (no directory match, no manager chain, no billing region).
 * Excluded from region pickers everywhere.
 */
export const UNASSIGNED_REGION_CODE = '__unassigned__'

/**
 * The PER-REGION holding org_unit code — minted by
 * `unplacedOrgUnitIdForRegion()` (and by the system-wide holding region's own
 * node). The region is known; the unit is not.
 */
export const UNPLACED_UNIT_CODE = '__UNPLACED__'

/**
 * `org_unit.unit_type` for a holding node. Deliberately the classification key
 * rather than the code: a holding node is defined by BEING a holding node, and
 * a tenant that mints a second one under a different code must still be
 * recognised as "not a real placement".
 */
export const HOLDING_UNIT_TYPE = 'holding'
