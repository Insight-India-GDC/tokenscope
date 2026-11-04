/*
 * report-visibility — the ONE source of truth for report-ACCESS vocabulary: a
 * role-derived BASELINE, widened by per-teammate positive GRANTS
 * (`report_access_grant`, mig 0129).
 * Replaces the three-mode admin dial (task #19, mig 0087,
 * `REPORT_VISIBILITY_MODES`/`reportGrants`) — that dial could only say "every
 * region admin" or "every cost-centre owner", org-wide; this says "this
 * teammate, this permission, until <expiry>".
 *
 * Two positive PERMISSIONS ({@link REPORT_ACCESS_PERMISSIONS}) an admin grants
 * per-teammate: 'operational' (every region + every Business Unit) and
 * 'finance' (the whole-company finance pack). {@link baselineGrants} is what every
 * caller holds with NO row at all — role + cost-centre ownership; the ORG-WIDE
 * role (platform-admin) holds the whole company there, every
 * other role is region-bound.
 * {@link effectiveReportGrants} widens the baseline by whichever positive
 * permissions the caller's ACTIVE grants
 * (`server/auth/report-scope.ts::resolveReportPermissions`) return — a widening
 * that applies to ANY role whose baseline lacks that scope, a region `admin`
 * included. `ReportScopeGrants` (the resolved per-scope object every reporting
 * endpoint reads) keeps its SHAPE exactly as before — only what PRODUCES it
 * changed — so `server/auth/report-scope.ts` and the `/reports/**` read path
 * are untouched below the two producer functions.
 *
 * READ-ONLY blast radius by construction, unchanged from the retired policy:
 * this module is consumed only by the reporting read path
 * (server/auth/report-scope.ts and the endpoints under server/api/v1/reports/**),
 * the read-only diagnostics probe (admin/diagnostics/ab-decomposition.get.ts
 * and its panel), and the client drill contract. It never touches write
 * endpoints, provisioning, or the GUC/RLS layer.
 *
 * The regional / cost-centre grants stay AUTHORIZATION LEVELS, never region-clamp
 * bypasses: `'own-region'` still routes through the existing region clamp
 * (resolveRegionalScope); only `'all-regions'` widens. `finance` is a simple BOOLEAN —
 * the whole-company `/reports/finance` pack is the only consumer, and it is
 * region-unbounded by design (global finance is a global function), so there is no
 * region-clamp level to express. The static {@link WHO_SEES_WHAT_BASELINE} /
 * {@link WHO_SEES_WHAT_ELEVATED} tables are the SAME shape the admin pane can render
 * and the unit tests pin the two producer functions against — so preview and
 * enforcement can never drift.
 */
import { consola } from 'consola'
import type { Role } from './roles'

/**
 * The two POSITIVE permissions an admin grants per-teammate
 * (`report_access_grant.permission`, mig 0129). The column's CHECK is pinned
 * 0084-style to this tuple (re-narrowed by mig 0158); the migration unit test
 * reads the migrations off disk and compares them to this constant.
 */
export const REPORT_ACCESS_PERMISSIONS = ['operational', 'finance'] as const
export type ReportAccessPermission = (typeof REPORT_ACCESS_PERMISSIONS)[number]

export function isReportAccessPermission(v: string): v is ReportAccessPermission {
  return (REPORT_ACCESS_PERMISSIONS as readonly string[]).includes(v)
}

export const REPORT_ACCESS_PERMISSION_LABELS: Record<ReportAccessPermission, string> = {
  operational: 'Operational reporting (whole company)',
  finance: 'Finance reporting (whole company)',
}

/**
 * Honest about MONEY (owner ruling, post external design review): 'operational'
 * widens past a reporting shape into the BILLED-spend figures those wider views
 * carry, and the copy must say so rather than reading as a scope-only toggle.
 *
 * Design-doc collision note: 'finance' names the PACK this permission unlocks
 * (`/reporting?scope=finance`), NOT the retired `finance` role enum member
 * (shared/auth/roles.ts's zombie — see ROLE_LABELS' "Finance (retired)"). Same
 * word, two different things; this constant is the permission, never the role.
 */
export const REPORT_ACCESS_PERMISSION_DESCRIPTIONS: Record<ReportAccessPermission, string> = {
  operational:
    'Company-wide reporting: every region and Business Unit view, including their billed-spend figures.',
  finance: 'The whole-company finance pack (month close, Business Unit invoices).',
}

/**
 * Per-scope grant for a caller under a policy mode. Each field is an authorization
 * LEVEL the enforcement layer reads — never a truthy bypass of the region clamp:
 *   - `across`     — may read the whole-company `/reports/across-regions` rollup.
 *   - `regional`   — `'own-region'` (region-clamped, the existing resolver path) |
 *                    `'all-regions'` (cross-region: region selector + honored `?region`) |
 *                    `false` (no regional scope).
 *   - `costCentre` — `'owned-or-subtree'` (the existing owner/subtree predicate) |
 *                    `'all'` (unbounded — every cost centre) | `false` (none).
 *   - `finance`    — `true` (sees the whole-company `/reports/finance` pack) | `false`.
 *   - `teammate`   — `'people-scope'` (may open a NAMED individual's reports-depth
 *                    drill, `/reporting/teammate/{id}`) | `false`. See
 *                    {@link peopleScopeGrant}.
 *   - `project`    — the WIDEST project admission the caller holds:
 *                    `'region-wide'` | `'member-in-scope'` | `'membership'` |
 *                    `false`. See {@link projectDepthGrant}.
 */
export interface ReportScopeGrants {
  across: boolean
  regional: 'own-region' | 'all-regions' | false
  costCentre: 'owned-or-subtree' | 'all' | false
  finance: boolean
  /**
   * May this caller open the reports-depth view of a NAMED individual
   * (`/reporting/teammate/{id}`, `GET /api/v1/reports/teammate/{id}` — developer
   * pages build D31/D38)?
   *
   * `'people-scope'` is a GRANT LEVEL, never an admission: holding it is the
   * FIRST conjunct of {@link teammateDrillAdmission}, which still requires the
   * in-frame row evidence and `is_active` (D34). It is deliberately NOT a
   * region-wide level: the grant model cannot express
   * region-leader-sees-whole-region today (annex E1 :850-867 — recorded open
   * owner decision 2), so this column documents CC-subtree/self, widening only
   * for roles whose REGIONAL grant already says all-regions.
   */
  teammate: 'people-scope' | false
  /**
   * How this caller reaches a PROJECT page, at its widest:
   *   - `'membership'`      — only by being a member (the `me/*` path everyone
   *                           has). No reports depth.
   *   - `'member-in-scope'` — plus every project with ≥1 member inside their
   *                           cost-centre people-scope (annex :563-574).
   *   - `'region-wide'`     — plus every project their regional width covers.
   *   - `false`             — nothing at all. NOT produced by today's matrix;
   *                           carried for TOTALITY, the same discipline
   *                           {@link regionScopeGrant} follows, so a future mode
   *                           that denies project depth outright has a value to
   *                           say so with instead of overloading `'membership'`.
   *
   * Like `teammate`, a LEVEL and not an admission: the reports-side project
   * endpoint still resolves the caller's own scope per request.
   */
  project: 'membership' | 'member-in-scope' | 'region-wide' | false
}

/**
 * Does this caller hold a PEOPLE scope — the grant that makes a named
 * individual's drill reachable at all (D38)?
 *
 * A cost-centre grant carries one by construction: the CC subtree IS a roster,
 * and every cost-centre surface already names the people in it (the over-cap
 * card, the people hero). A cross-region grant carries the wider one.
 *
 * A plain `regional: 'own-region'` does NOT. That width resolves through
 * `resolveRegionalScope`, which clamps a developer to their OWN org subtree —
 * a reporting width, not a governance grant over named individuals. Deriving
 * `teammate` from it would hand every developer the audited, refusal-gated
 * per-person view, which is the opposite of "manager-facing depth is
 * contribution against budgets only".
 */
function peopleScopeGrant(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre'>,
): 'people-scope' | false {
  if (g.costCentre !== false) return 'people-scope'
  if (g.regional === 'all-regions' || g.across) return 'people-scope'
  return false
}

/**
 * The WIDEST project admission a caller holds (D37/D38). Membership is the floor
 * because it is not a grant at all — `me/projects/{code}` gates on current
 * `project_assignment` and knows nothing about `reportGrants`, which is exactly
 * why D37 refuses to add a third admission arm there.
 */
function projectDepthGrant(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre'>,
): 'membership' | 'member-in-scope' | 'region-wide' {
  if (g.regional === 'all-regions' || g.across) return 'region-wide'
  if (g.costCentre !== false) return 'member-in-scope'
  return 'membership'
}

/**
 * Derive the two W4 columns from the four scope grants, in ONE place, so
 * {@link baselineGrants} and {@link effectiveReportGrants} cannot state them
 * differently. {@link WHO_SEES_WHAT_BASELINE} / {@link WHO_SEES_WHAT_ELEVATED}
 * stay hand-written literals (see their own comment) — the point of those
 * tables is to be an INDEPENDENT statement, so they are not derived from this.
 */
function withDrillGrants(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'>,
): ReportScopeGrants {
  return { ...g, teammate: peopleScopeGrant(g), project: projectDepthGrant(g) }
}

/**
 * The UNCONDITIONAL floor every teammate holds by role + cost-centre ownership
 * alone — no explicit `report_access_grant` needed. Named `baselineGrants`
 * (not `standardGrants`, the retired single-mode function it replaces) because
 * the concept changed: that function was ONE OF THREE outcomes an admin-set
 * mode selected; this is the ONE floor every caller starts from, widened only
 * by {@link effectiveReportGrants}'s permission overlay.
 *
 * developer / manager / admin / cost-centre-owner are BYTE-IDENTICAL to
 * today's retired `standardGrants` — the whole point of separating "floor"
 * from "grant" is that a role which never held elevation keeps exactly what
 * it had.
 *
 * platform-admin sees the WHOLE COMPANY at this floor —
 * all-regions, every Business Unit, and the finance pack (PO decision
 * 2026-08-13). These roles answer for no single region, so tying their report
 * access to a per-person grant made the access fragile: a platform-admin whose
 * backfilled grant landed on a different teammate row (or whose grant never
 * backfilled) saw an EMPTY report shell, which is the opposite of least
 * privilege — it is a broken admin. The role is the authority here.
 *
 * The cost-centre floor is `'all'`, NOT `'owned-or-subtree'`, and that choice is
 * what keeps the old #251 SECURITY note irrelevant rather than violated:
 * `orgSubtreeScopePredicate`'s GUC arm is unconditionally TRUE for org-wide
 * roles (org-subtree-scope.ts:49; platform-admin maps at request-rls.ts:33), so
 * an `'owned-or-subtree'` floor on these roles WOULD have leaked every BU
 * through that predicate. `'all'` never touches the predicate — it routes
 * through `costCentreScopeOpts`'s `unbounded` arm, the resolvers' explicit
 * "every BU" path. So the hazard #251 named is designed out, not re-opened.
 */
export function baselineGrants(role: Role, ownsCostCentre: boolean): ReportScopeGrants {
  const devTier: ReportScopeGrants = withDrillGrants({
    across: false,
    regional: 'own-region',
    costCentre: ownsCostCentre ? 'owned-or-subtree' : false,
    finance: false,
  })
  switch (role) {
    case 'developer':
    case 'finance': // zombie enum member — never minted; developer-tier keeps it benign.
    case 'global-finops': // RETIRED 2026-09-05 — same treatment: no capability, benign tier.
      return devTier
    case 'manager':
    case 'admin':
      // Region-BOUND. A region `admin` sees all reports FOR THEIR OWN REGION
      // (own-region + their real org-subtree ownership), NOT other regions. This
      // is deliberate: making a region admin cross-region would drop the
      // anti-IDOR region clamp that stops one region's admin reading another
      // region's billed spend (tests/integration/reports/{regional,cost-centres}
      // assert exactly that). "Admins see all reports" is delivered for the
      // ORG-WIDE roles below; a region admin is scoped, widened only by a grant.
      return withDrillGrants({
        across: false,
        regional: 'own-region',
        costCentre: 'owned-or-subtree',
        finance: false,
      })
    case 'platform-admin':
      // ORG-WIDE roles see the whole company BY DEFAULT (PO decision 2026-08-13,
      // reversing #251 for these roles). They answer for no single region, so an
      // `own-region` floor is degenerate — there is no home region to clamp to,
      // which is exactly how a platform-admin ended up staring at an empty report
      // shell while their backfilled grant sat unread on another teammate row.
      // `costCentre: 'all'` is deliberate and SAFE: it routes through the
      // resolvers' `unbounded` arm (costCentreScopeOpts → `unbounded: true`) and
      // the project path's explicit `return null` — NEVER the org-subtree
      // predicate whose unconditional org-wide GUC arm #251's `ownerOnly` seal
      // guarded. `'all'` is the explicit "every BU" value, so that leak class is
      // designed out, not re-opened.
      return withDrillGrants({
        across: true,
        regional: 'all-regions',
        costCentre: 'all',
        finance: true,
      })
    default: {
      // Unreachable for a valid Role; fail-closed to developer-tier rather than throw.
      consola.error(
        `baselineGrants: unrecognised role '${role as string}' — defaulting to developer-tier grants`,
      )
      return devTier
    }
  }
}

/**
 * The overlay an ACTIVE 'operational' grant buys: whole-company across, every
 * region, every Business Unit. `finance` is deliberately absent — the two
 * permissions are independent (a caller can hold either, both, or neither),
 * so 'operational' never implies the finance pack.
 */
export const OPERATIONAL_OVERLAY: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre'> = {
  across: true,
  regional: 'all-regions',
  costCentre: 'all',
}

function regionalRank(v: ReportScopeGrants['regional']): 0 | 1 | 2 {
  return v === 'all-regions' ? 2 : v === 'own-region' ? 1 : 0
}
function widerRegional(
  a: ReportScopeGrants['regional'],
  b: ReportScopeGrants['regional'],
): ReportScopeGrants['regional'] {
  return regionalRank(a) >= regionalRank(b) ? a : b
}
function costCentreRank(v: ReportScopeGrants['costCentre']): 0 | 1 | 2 {
  return v === 'all' ? 2 : v === 'owned-or-subtree' ? 1 : 0
}
function widerCostCentre(
  a: ReportScopeGrants['costCentre'],
  b: ReportScopeGrants['costCentre'],
): ReportScopeGrants['costCentre'] {
  return costCentreRank(a) >= costCentreRank(b) ? a : b
}

/**
 * Field-wise WIDEST of two (across/regional/costCentre/finance) grants — pure,
 * total, and the ONLY place two grants combine. `regional` and `costCentre`
 * are ORDERED SCALES (`false < 'own-region' < 'all-regions'`;
 * `false < 'owned-or-subtree' < 'all'`); `across`/`finance` are booleans,
 * widened by OR. Never narrows: the result is always ≥ both inputs on every
 * field, which is what makes {@link effectiveReportGrants} monotone in the
 * caller's held permissions.
 */
function unionGrants(
  a: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'>,
  b: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'>,
): Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'> {
  return {
    across: a.across || b.across,
    regional: widerRegional(a.regional, b.regional),
    costCentre: widerCostCentre(a.costCentre, b.costCentre),
    finance: a.finance || b.finance,
  }
}

const NO_OVERLAY: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'> = {
  across: false,
  regional: false,
  costCentre: false,
  finance: false,
}

/**
 * `permissions` → the OVERLAY they buy, BEFORE combining with the baseline. A
 * permission the caller does not hold contributes nothing — {@link NO_OVERLAY}
 * is the neutral element for {@link unionGrants}, never a narrowing.
 */
function permissionOverlay(
  permissions: readonly ReportAccessPermission[],
): Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'> {
  let out = NO_OVERLAY
  if (permissions.includes('operational')) out = unionGrants(out, { ...OPERATIONAL_OVERLAY, finance: false })
  if (permissions.includes('finance')) out = unionGrants(out, { ...NO_OVERLAY, finance: true })
  return out
}

/**
 * The ONE enforcement primitive: (role × ownership × held permissions) → the
 * caller's effective per-scope grants:
 * `baselineGrants(role, ownsCostCentre)` UNION `permissionOverlay(permissions)`,
 * field-wise widest ({@link unionGrants}), then {@link withDrillGrants}. PURE
 * and TOTAL — no DB handle, no throw: an empty `permissions` array degrades to
 * exactly the baseline, and an unrecognised role still fails closed via
 * {@link baselineGrants}'s own default arm.
 */
export function effectiveReportGrants(caller: {
  role: Role
  ownsCostCentre: boolean
  permissions: readonly ReportAccessPermission[]
}): ReportScopeGrants {
  const base = baselineGrants(caller.role, caller.ownsCostCentre)
  const overlay = permissionOverlay(caller.permissions)
  return withDrillGrants(unionGrants(base, overlay))
}

/*
 * ── The Region scope: what the selector offers ───────────────────────────────
 *
 * `across` and `regional` are still the two grants a caller HOLDS — this adds no
 * authorization concept. What changed is the surface: Across-Regions stopped
 * being a tab of its own and became the FIRST OPTION of the Region tab's region
 * selector ("All regions"). So the question every consumer now asks is not "which
 * of two tabs?" but "which options does this caller's selector carry, and which
 * one does a bare `?scope=region` land on?".
 *
 * `regionScopeGrant` is the one answer. The tab, the landing region, the option
 * list and the endpoint's own 403 all read it, so the selector a caller SEES and
 * the widths the endpoint SERVES cannot drift: the options ARE the grant.
 *
 * TOTALITY IS THE POINT. It is a pure function over the 2 × 3 = 6 (across ×
 * regional) states, and every one of them names exactly one landing — including
 * the three that today's role matrix never produces. The failure this replaces is
 * a caller holding `across: false` with nowhere to go once the Across tab is
 * gone; a mapping with a hole is how that comes back.
 */
export interface RegionScopeGrant {
  /** Is the Region tab present at all? `false` ⇒ the caller lands on another scope. */
  tab: boolean
  /** May the caller pick "All regions" — the unclamped, whole-company answer? */
  allRegions: boolean
  /** May the caller pick a region OTHER than their own (the honoured `?region=`)? */
  crossRegion: boolean
  /** May the caller read a single region at all (their own, at minimum)? */
  ownRegion: boolean
  /** Where a bare `?scope=region` lands. Exactly one value whenever `tab` is true. */
  landing: 'all-regions' | 'own-region' | null
}

/**
 * (grants a caller holds) → (what their Region selector offers, and where they land).
 *
 * Each option is backed by a grant the caller actually holds, and nothing else:
 * "All regions" IS `across`, "any region" IS `regional === 'all-regions'`, "own
 * region" IS `regional !== false`. A caller with `regional: false` is therefore
 * offered no single region even when `across` lets them read the whole company —
 * inventing a per-region option out of a whole-company grant would be a grant this
 * module made up rather than one the policy issued.
 *
 * Landing prefers the widest option the caller holds, which is what "Region
 * absorbs Across" means for the person who used to open on Across-Regions: they
 * still open on the whole-company answer, now as the selector's first option.
 */
export function regionScopeGrant(g: ReportScopeGrants): RegionScopeGrant {
  const allRegions = g.across === true
  const crossRegion = g.regional === 'all-regions'
  const ownRegion = g.regional !== false
  const tab = allRegions || ownRegion
  return {
    tab,
    allRegions,
    crossRegion,
    ownRegion,
    landing: !tab ? null : allRegions ? 'all-regions' : 'own-region',
  }
}

/**
 * Render the per-scope grant object (the ENFORCEMENT type) as the human scope
 * list a surface shows. Shared so the diagnostics probe and any admin surface
 * name the scopes with the SAME words — a second copy of this wording is a
 * second vocabulary, and the whole point of showing resolved grants is that
 * they are the ones in force.
 *
 * ONE Region line, not two. Across-Regions is no longer a scope a caller is
 * granted separately; it is the "All regions" option of the Region selector, so
 * the pane names the selector the caller would actually see rather than listing a
 * tab that no longer exists.
 */
export function grantsToScopes(g: ReportScopeGrants): string[] {
  const out: string[] = []
  const rg = regionScopeGrant(g)
  if (rg.allRegions && rg.crossRegion) out.push('Region (all regions + every region)')
  else if (rg.allRegions) out.push('Region (all regions)')
  else if (rg.crossRegion) out.push('Region (every region)')
  else if (rg.ownRegion) out.push('Region (own region)')
  if (g.costCentre === 'all') out.push('Business Units (all)')
  else if (g.costCentre === 'owned-or-subtree') out.push('Business Units (owned)')
  if (g.finance) out.push('Finance (whole company)')
  /*
   * The two DRILL columns (D38). They render from this ONE function so the admin
   * preview and the diagnostics probe name them in the same words as every other
   * scope — the annex's explicit instruction was that the named-row/drill rules
   * must leave code comments and enter the design record AND the matrix, not stay
   * a second RBAC path visible only to whoever reads the handler (:557-561).
   *
   * Read defensively: a caller passing a pre-W4 grant literal (older tests, a
   * cached payload) simply gets no line, never a wrong one.
   */
  if (g.teammate === 'people-scope') out.push('Teammate drill (people in your scope)')
  if (g.project === 'region-wide') out.push('Projects (region-wide)')
  else if (g.project === 'member-in-scope') out.push('Projects (members in your scope)')
  else if (g.project === 'membership') out.push('Projects (own memberships only)')
  return out
}

/**
 * The five personas the WHO-SEES-WHAT matrix (and the RBAC-matrix tests)
 * enumerate. It was six until `global-finops` was retired; the retired role's
 * reach is asserted separately in tests/unit/server/retired-roles.test.ts rather
 * than as a persona row, because a row here is a CAPABILITY claim.
 * `cost-centre-owner` is a plain developer WITH an active cou_owner row — ownership is
 * a relationship, not a role (mig 0048).
 */
export const REPORT_VISIBILITY_PERSONAS = [
  { key: 'developer', label: 'Developer', role: 'developer', ownsCostCentre: false },
  { key: 'manager', label: 'Manager', role: 'manager', ownsCostCentre: false },
  { key: 'admin', label: 'Region admin (retired)', role: 'admin', ownsCostCentre: false },
  { key: 'cost-centre-owner', label: 'Business Unit owner', role: 'developer', ownsCostCentre: true },
  { key: 'platform-admin', label: 'Admin', role: 'platform-admin', ownsCostCentre: false },
] as const satisfies readonly { key: string; label: string; role: Role; ownsCostCentre: boolean }[]

export type ReportVisibilityPersonaKey = (typeof REPORT_VISIBILITY_PERSONAS)[number]['key']

/**
 * The static (persona → grants) tables — the SAME shape the admin pane can render
 * as a who-sees-what preview and the unit tests assert the two producer functions
 * against. HAND-WRITTEN LITERALS (independent of `baselineGrants` /
 * `effectiveReportGrants`) so the assertion is a real pin, not a tautology: change
 * the semantics without updating these tables and the matrix test fails.
 *
 * `WHO_SEES_WHAT_BASELINE` — what each persona holds with NO report-access row.
 * `WHO_SEES_WHAT_ELEVATED` — what each persona holds with BOTH permissions
 * ('operational' AND 'finance') actively granted. Every persona lands on the SAME
 * object at full elevation (the whole-company set) — that identity is the point:
 * the two permissions together buy everyone the full report set regardless of
 * starting role, which is what "elevated" means.
 */
export const WHO_SEES_WHAT_BASELINE: Record<ReportVisibilityPersonaKey, ReportScopeGrants> = {
  developer: { across: false, regional: 'own-region', costCentre: false, finance: false, teammate: false, project: 'membership' },
  manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
  admin: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
  'cost-centre-owner': { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
  // Org-wide role: full access AT BASELINE (PO decision 2026-08-13). For this
  // role baseline == elevated — an additive permission on an already-full
  // floor is idempotent — so both tables state the same shape by construction.
  'platform-admin': { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
}

export const WHO_SEES_WHAT_ELEVATED: Record<ReportVisibilityPersonaKey, ReportScopeGrants> = {
  developer: { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
  manager: { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
  admin: { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
  'cost-centre-owner': { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
  'platform-admin': { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
}

/*
 * The §7 persona matrix's Region rows — BASELINE / ELEVATED counterparts of
 * WHO_SEES_WHAT_BASELINE / WHO_SEES_WHAT_ELEVATED, carrying the
 * selector-visibility column (§6's grant table) rather than the raw
 * `across`/`regional` pair.
 *
 * HAND-WRITTEN, exactly like the tables above and for the same reason: the
 * test asserts `regionScopeGrant(effectiveReportGrants(...))` equals this
 * table, so the table has to be an independent statement of the intent.
 * Deriving it would make the assertion `f(x) === f(x)` — a tautology that
 * passes through any change to `f`, including one that strands a persona with
 * no landing at all.
 *
 * Region-BOUND personas land on the same baseline row (own-region, no
 * cross-region option); the ORG-WIDE persona (
 * platform-admin) land on all-regions AT BASELINE, matching their full-access
 * floor above — for them baseline == elevated here too.
 */
export const WHO_SEES_WHAT_REGION_BASELINE: Record<ReportVisibilityPersonaKey, RegionScopeGrant> = {
  developer: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
  manager: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
  admin: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
  'cost-centre-owner': { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
  'platform-admin': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
}

export const WHO_SEES_WHAT_REGION_ELEVATED: Record<ReportVisibilityPersonaKey, RegionScopeGrant> = {
  developer: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  manager: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  admin: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  'cost-centre-owner': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  'platform-admin': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
}

/*
 * ── THE DRILL CONTRACT'S TWO RULES (developer pages build D38) ───────────────
 *
 * NAMING A ROW AND OPENING A DRILL ARE DIFFERENT QUESTIONS. Conflating them was
 * a round-1 HIGH on the build design (r1-H4) because the conflation is a
 * membership bypass in one direction and a dead link in the other: a project
 * MEMBER may see their team-mates NAMED on the project page and hold no reports
 * grant at all, so "named ⇒ drillable" would hand a per-person governance view
 * to anyone who joins a project. The prototype pins that persona at 403
 * (`prototype.html:780-785`).
 *
 * So there are two exported rules and they are never one:
 *   1. {@link namedContributionRow} — may this subject be NAMED in a row, or
 *      must they fold into the aggregate remainder (annex :521-526, C3)?
 *   2. {@link teammateDrillAdmission} — may this viewer OPEN this subject's
 *      reports-depth page (D34's in-frame conjunction, ALWAYS)?
 *
 * A name can be NAMED by rule 1 and PLAIN TEXT by rule 2. That is the drill
 * contract working, not a bug: a named row is not automatically a door.
 *
 * BOTH ARE PURE. They take RESOLVED FACTS, never a database handle, because the
 * SAME rule has to run in two places — the server (facts from SQL) and the
 * client (facts from the payload it was served). A second, client-side copy of
 * either rule is precisely the "second, unproven RBAC path" the annex warns
 * about (:557-561).
 */

/**
 * The viewer, as the two rules see them.
 *
 * `Pick<…, 'teammate'>` and not the whole grant object, deliberately: these
 * rules read exactly one column, and narrowing the input is what lets the CLIENT
 * consume them from a `/reports/meta` payload that carries only the two drill
 * columns — instead of shipping the full policy object to the browser, or
 * casting a partial one into the full shape at every call site.
 */
export interface DrillViewer {
  grants: Pick<ReportScopeGrants, 'teammate'>
}

/** The subject of a NAMED row, as resolved facts. */
export interface NamedRowSubject {
  /** `null` for an aggregate/remainder row — a row with no subject to name. */
  id: string | null
  /**
   * Is the subject inside the viewer's PEOPLE scope (own cost-centre subtree,
   * own region at an all-regions width)? Resolved by the caller: server-side
   * from the scope predicate, client-side from the payload the server served.
   */
  inPeopleScope: boolean
  /** The subject IS the viewer. Always nameable (annex :521-526 names self). */
  isSelf: boolean
}

/** Where the row sits: the project whose table is being rendered, if any. */
export interface NamedRowProjectContext {
  /**
   * The VIEWER holds current membership of this project. Membership names
   * team-mates on the member-depth team table with no grants model involved —
   * which is why it names but never drills.
   */
  viewerIsMember: boolean
}

/**
 * ROW-NAMING (rule 1). Name the subject iff they are in the viewer's
 * people-scope, or the viewer is a member of the project the row belongs to, or
 * the subject is the viewer; else the row folds into the ONE aggregate
 * remainder so the table still foots to the whole-project total (C3, annex
 * :399/:521-526).
 *
 * Consumed by the project reports-depth named rows (D37) and by the admin
 * preview. It says NOTHING about whether the resulting name is a link — that is
 * {@link teammateDrillAdmission}, and only that.
 */
export function namedContributionRow(
  viewer: DrillViewer,
  subject: NamedRowSubject,
  projectCtx: NamedRowProjectContext,
): boolean {
  // An unidentified subject cannot be named at all — there is no name to print
  // and no id to key on; it IS the remainder.
  if (subject.id == null) return false
  if (subject.isSelf) return true
  if (projectCtx.viewerIsMember) return true
  return viewer.grants.teammate === 'people-scope' && subject.inPeopleScope
}

/** The subject of a DRILL, as resolved facts — D34's two conjuncts, separated. */
export interface DrillSubject {
  /** `null` when the row names no target id (`__null_*` keys, folded rows). */
  id: string | null
  /**
   * CONJUNCT 1 — IN-FRAME ROW: ≥1 in-window `v_complete_usage_current` row for
   * this subject inside the viewer's scope predicate (annex :902-909).
   *
   * Every report groups a person's usage by where they sit NOW (the current-org
   * lens, docs/design/current-org-lens/00-design.md), so the gate reads the same
   * lens as the table that named them: a moved person's whole history follows
   * them, and a drill opens exactly where their row was ranked.
   *
   * Server-side this is the EXISTS the endpoint runs. Client-side the row's own
   * presence in a scope-clamped report IS the evidence — that row was computed
   * over exactly this predicate and window.
   */
  hasInScopeWindowRow: boolean
  /**
   * CONJUNCT 2 — `teammate.is_active` (drizzle/schema/identity.ts:86), a
   * SEPARATE conjunct and never folded into conjunct 1. `teammate.revoked_at`
   * is a session anchor, not a deactivation flag (`identity.ts:94-98`), and
   * plays no part here.
   */
  isActive: boolean | undefined
  /**
   * CONJUNCT 3 — `teammate.provisional` (drizzle/schema/identity.ts:80-86): a
   * SHADOW teammate minted by the unauthenticated enrol path, whose email is a
   * CLAIM nobody has yet authenticated (mig 0057).
   *
   * A shadow is `is_active = true`, so the first two conjuncts admit it. That
   * published an audited, named-person governance page under an UNCONFIRMED
   * identity: anyone able to enrol could claim `victim@corp.example`, emit, and
   * have the estate's own reporting surface attribute their figures to the
   * victim by name (r3-H2). The claim is not evidence, so the page it would
   * headline does not exist yet — this is a REFUSAL, not a redaction.
   *
   * REQUIRED, deliberately: the two rules take resolved facts, and a security
   * conjunct with a default is a conjunct a new call site can forget. The
   * client-side helper {@link teammateDrillTarget} supplies the default its own
   * surfaces are entitled to; the RULE never assumes.
   */
  isProvisional: boolean | undefined
}

/**
 * The scope FRAME the drill is opened from — the `?src=` token (D16/D30) and
 * whether it resolved against a grant the VIEWER actually holds.
 *
 * `src` selects which of the caller's own grants frames the view; it NEVER
 * authorises (D33). A `src` naming a scope the caller does not hold is a 403,
 * not a fallback — which is what `held: false` expresses here.
 */
export interface DrillScopeFrame {
  src: string | null
  held: boolean
}

/** The resolved reporting window the drill carries (D16). */
export interface DrillWindow {
  from: string
  to: string
}

export type TeammateDrillRefusal =
  | 'no-teammate-grant'
  | 'no-scope-frame'
  | 'unidentified-subject'
  | 'provisional-subject'
  | 'no-in-scope-row'
  | 'inactive-subject'
  | 'no-window'

export type TeammateDrillDecision =
  | { admit: true }
  | { admit: false; reason: TeammateDrillRefusal }

/**
 * DRILL ADMISSION (rule 2) — D34's conjunction, ALWAYS, in one place.
 *
 * `grants.teammate === 'people-scope'` ∧ the `src` frame is one the viewer holds
 * ∧ the subject is identified ∧ the subject's identity is CONFIRMED (not a
 * provisional shadow) ∧ ≥1 in-window row already inside that scope
 * ∧ `subject.is_active`.
 *
 * PROJECT MEMBERSHIP NEVER OPENS THE DRILL. It is absent from the conjunction on
 * purpose: no `src` token can express a membership frame, so a membership arm
 * here could not carry the C14 entry predicate anyway — it would open a page
 * with no scope to compute over, which is the bare `teammate_id` C14 exists to
 * forbid.
 *
 * The refusal REASON is returned rather than a bare boolean so the endpoint's
 * 403 and the client's plain-text fallback are driven by the same statement, and
 * so a test can pin WHICH conjunct failed (T31 isolates `is_active`).
 */
export function teammateDrillAdmission(
  viewer: DrillViewer,
  subject: DrillSubject,
  scopePredicate: DrillScopeFrame,
  window: DrillWindow | null,
): TeammateDrillDecision {
  if (viewer.grants.teammate !== 'people-scope') return { admit: false, reason: 'no-teammate-grant' }
  if (!scopePredicate.src || !scopePredicate.held) return { admit: false, reason: 'no-scope-frame' }
  if (window == null) return { admit: false, reason: 'no-window' }
  if (subject.id == null) return { admit: false, reason: 'unidentified-subject' }
  // Identity EXISTENCE and identity CONFIRMATION are adjacent conjuncts: an
  // unconfirmed claimed identity is no more a publishable subject than none.
  //
  // BOTH read UNKNOWN AS DISQUALIFYING (r7-H1). `isProvisional` admits only on
  // an explicit `false`, and `isActive` only on an explicit `true`, so a caller
  // that cannot state a fact — a row from a payload that predates it, an
  // identity lookup that returned nothing — is refused rather than admitted by
  // the shape of its own absence. This is the rule; `teammateDrillTarget` is
  // its client mirror, and neither may soften it.
  if (subject.isProvisional !== false) return { admit: false, reason: 'provisional-subject' }
  if (!subject.hasInScopeWindowRow) return { admit: false, reason: 'no-in-scope-row' }
  if (subject.isActive !== true) return { admit: false, reason: 'inactive-subject' }
  return { admit: true }
}
