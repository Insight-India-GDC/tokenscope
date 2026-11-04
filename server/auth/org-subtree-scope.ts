/*
 * org-subtree-scope — the in-query authorization predicate that clamps an
 * org_unit subtree to the caller (the practice rollup and the reporting layer).
 *
 * RLS is INERT at runtime (the app connects as the table owner, no FORCE ROW
 * LEVEL SECURITY) so this MUST be embedded in-query; a handler that "relies on
 * RLS" here is a cross-region spend leak. The role split applies the same
 * region-scoped-admin contract every admin/* endpoint applies:
 *
 *   - global-finops / platform-admin  → unbounded (platform-admin is mapped to
 *                                        'global-finops' at the GUC layer by
 *                                        withRequestRls, so one clause covers both)
 *   - admin                           → their OWN region, never another
 *   - developer / manager             → their own org subtree (ltree <@)
 *
 * NOTE this deliberately does NOT copy allocation-scope's "admin is unbounded"
 * semantics: that predates the multi-region operating model. For a region-scoped
 * spend view, admin must be hard-bound to their region.
 */
import { sql, type SQL } from 'drizzle-orm'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'

/**
 * Returns a boolean SQL predicate restricting an `org_unit` row to the caller's
 * authority. `ref` is the table name or alias the calling query uses for the
 * org_unit row (a code constant, never user input). The referenced row must
 * expose `path` (ltree) and `region_id` (uuid).
 *
 * Reads the per-request GUCs set by withRequestRls / withRlsContext:
 *   - app.user_role       — role split above
 *   - app.user_region_id  — the admin region clamp (NULLIF-guarded so an empty
 *                           GUC for a global-finops caller can't throw on ::uuid)
 *   - app.user_org_path   — the dev/manager subtree (ltree)
 */
export function orgSubtreeScopePredicate(ref: string): SQL {
  const path = sql.raw(`${ref}.path`)
  const regionId = sql.raw(`${ref}.region_id`)
  // Structure matters: every non-global role is region-clamped FIRST, then the path check
  // applies only WITHIN that region. A flat `... OR path <@ org_path` would let an admin (or
  // manager) pass on a colliding path from ANOTHER region, because org_unit paths are only
  // unique per-region — so the region clamp wraps the path check, it does not sit beside it.
  //
  // The dev/manager arm is additionally gated on placedBelowRegionRootPredicate(): `path <@
  // org_path` alone is TRUE for EVERY unit in the region when org_path IS the region root (the
  // JIT/directory/enroll default before S3), so the "least-privilege subtree" boundary
  // degenerates to the whole region. The clamp only trusts the subtree once the caller's OWN
  // placement is a genuine, non-root home.
  return sql`(
    current_setting('app.user_role', true) = 'global-finops'
    OR (
      ${regionId} = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND (
        current_setting('app.user_role', true) = 'admin'
        OR (${path} <@ current_setting('app.user_org_path', true)::ltree AND ${placedBelowRegionRootPredicate()})
      )
    )
  )`
}

/**
 * The security clamp's LOAD-BEARING conjunction (S3): is the CALLER's own placement
 * (`app.user_org_path` within `app.user_region_id`) a genuine least-privilege home, or
 * the region-root catch-all whose subtree IS the whole region? Three candidate
 * discriminators, and why the answer is their CONJUNCTION rather than any one alone:
 *
 *   - `unit_type <> 'holding'` — catches only the `__UNPLACED__` node. Doesn't touch
 *     a region root that isn't a holding node (every seeded/created one today).
 *   - `code <> 'default'` — catches a SEEDED region's root, but `'default'` is a
 *     property of the seed files (drizzle/seed*.ts), NOT a schema invariant: BEFORE
 *     part (f), `regions.post.ts` creates a region with ZERO org units and
 *     `org-units.post.ts` does not reserve `'default'` — so a runtime-created region's
 *     root is whatever the admin typed, and this test FAILS OPEN the moment it isn't
 *     literally `'default'`. It also has a false positive `parent_id` doesn't: a
 *     legitimate NON-root unit that happens to be coded `'default'` (unique per
 *     `(region_id, code)`, so this can happen in another region) would blind a
 *     properly-placed teammate.
 *   - `parent_id IS NOT NULL` — catches a region root STRUCTURALLY, whatever it is
 *     named: a region root is by definition parentless. This is NOT the same test as
 *     `nlevel(path) = 1` — once an admin creates a root-level BU, that BU sits at a
 *     bare label OUTSIDE the seeded root's subtree, so `nlevel` and parentage diverge.
 *     Its own false positive: a legitimate admin-created ROOT-LEVEL BU (org-units.post
 *     explicitly allows `parent_id: null`) would blind a properly-placed manager.
 *
 * `code <> 'default'` alone carries the `parent_id`-class false positive PLUS a false
 * negative `parent_id` does not have (a runtime-created 'hq' root). On a security clamp
 * the false negative is strictly worse (it fails OPEN), so the clamp is keyed on the
 * STRUCTURAL test and keeps the naming test as defence-in-depth against the admin-root
 * false positive. Part (f) turns the naming test into a real invariant — every region's
 * root is ALWAYS the parentless `code='default'` unit and `'default'` can never be
 * anything else — so that arm's own false positive becomes unrepresentable.
 *
 * Do NOT key this on subtree coverage ("the placement spans every unit in the region")
 * either: an admin-created root-level BU sits at a bare label, so it is NOT `<@` the
 * seeded root — the seeded root stops spanning the region the instant one exists, so a
 * coverage test fails open in exactly the case that matters.
 *
 * Reads the SAME GUCs orgSubtreeScopePredicate does; NULLIF-guarded so an empty
 * `app.user_region_id` can't throw on the `::uuid` cast (the documented NULLIF trap).
 */
export function placedBelowRegionRootPredicate(): SQL {
  return sql`EXISTS (SELECT 1 FROM org_unit self WHERE ${callerHomeUnitMatch('self')})`
}

/**
 * The row-level test at the heart of {@link placedBelowRegionRootPredicate}: is this
 * org_unit row the CALLER's own placement, AND a genuine least-privilege home rather
 * than the region-root catch-all? `ref` is a code-constant table alias, never user
 * input. Extracted rather than inlined twice because {@link callerHomeUnitQuery} must
 * resolve EXACTLY the row this test admits — a second copy of these five conditions
 * would let the clamp and the NAME of the clamp's scope drift apart, and the only
 * value of that name is that it is the scope the figures were actually computed for.
 */
function callerHomeUnitMatch(ref: string): SQL {
  const regionId = sql.raw(`${ref}.region_id`)
  const path = sql.raw(`${ref}.path`)
  const unitType = sql.raw(`${ref}.unit_type`)
  const parentId = sql.raw(`${ref}.parent_id`)
  const code = sql.raw(`${ref}.code`)
  return sql`${regionId} = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND ${path} = current_setting('app.user_org_path', true)::ltree
      AND ${unitType} <> ${HOLDING_UNIT_TYPE}
      AND ${parentId} IS NOT NULL
      AND ${code} <> 'default'`
}

/**
 * The org unit the dev/manager SUBTREE clamp resolves to — the row whose `path` is the
 * root of `path <@ app.user_org_path`, and therefore the only honest name for the scope
 * those callers' figures were summed over.
 *
 * Returns NO ROW in exactly the case {@link placedBelowRegionRootPredicate} returns
 * false, because it applies the same test: the caller's placement is the region root or
 * a holding node, so the clamp yields zero rows and there is no scope to name. A caller
 * must treat the empty result as "no resolved scope", never as "fall back to the region"
 * — falling back is the defect this exists to remove.
 *
 * `ORDER BY` before `LIMIT 1` because `org_unit` is UNIQUE on `(region_id, code)` but
 * NOT on `(region_id, path)`: two rows may share a path, in which case they share the
 * subtree too, so any of them names the same scope — but which one must not vary
 * between requests.
 */
export function callerHomeUnitQuery(): SQL {
  return sql`SELECT home.display_name AS display_name
               FROM org_unit home
              WHERE ${callerHomeUnitMatch('home')}
              ORDER BY home.display_name, home.id
              LIMIT 1`
}

/**
 * SIBLING of {@link orgSubtreeScopePredicate} for the regional report
 * (server/reporting/regional.ts). It is deliberately NOT unified with it:
 *
 *   - shape — this scopes by an org_unit_id COLUMN via an `<col> IN (SELECT id
 *     FROM org_unit WHERE …)` subquery (the manager's tables — teammate, project,
 *     attribution_record — expose `org_unit_id` / `cost_owning_unit_id`, not an
 *     ltree `path`), whereas orgSubtreeScopePredicate filters a row's own `path`.
 *   - value source — this reads the caller's role / region / selected-region from
 *     JS (the resolved `Session` + the request's region pick), NOT the per-request
 *     GUCs, and supports a global-finops "selected region else all" branch the
 *     scope predicate has no equivalent for. (The subtree path is still the GUC,
 *     matching the original hand-rolled clause exactly.)
 *
 * Unifying the two would change one of those axes and so the SQL, so they share
 * the role-split CONTRACT (manager → subtree, admin → own region, global → a
 * selected region else all) but not an implementation.
 *
 * `regionCol` / `subtreeCol` are code-constant column refs (never user input);
 * the referenced columns are a region uuid and an org_unit_id respectively.
 */
export function managerScopePredicate(
  caller: { role: string; regionId: string },
  effectiveRegionId: string | null,
  regionCol: string,
  subtreeCol: string,
): SQL {
  const rc = sql.raw(regionCol)
  const sc = sql.raw(subtreeCol)
  if (caller.role === 'manager') {
    // Same placedBelowRegionRootPredicate() gate as orgSubtreeScopePredicate's dev/manager
    // arm — this scopes by a DIFFERENT shape (an `IN (SELECT id ...)` subquery over a column,
    // not a row's own path) but the same GUCs, so a manager whose OWN home is the region root
    // must degrade the SAME way: zero rows, not the whole region.
    return sql`(${sc} IN (SELECT id FROM org_unit WHERE path <@ current_setting('app.user_org_path', true)::ltree AND region_id = ${caller.regionId}::uuid) AND ${placedBelowRegionRootPredicate()})`
  }
  if (caller.role === 'admin') {
    return sql`${rc} = ${caller.regionId}::uuid`
  }
  // global-finops / platform-admin: a selected region, else all.
  return effectiveRegionId ? sql`${rc} = ${effectiveRegionId}::uuid` : sql`TRUE`
}
