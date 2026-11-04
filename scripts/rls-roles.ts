/*
 * scripts/rls-roles.ts — the RLS role NAMES. Constants only, zero imports.
 *
 * ONE spelling per role in the whole tree. The track that PROVISIONS the app
 * role and the probe that REPORTS on it must agree, and a literal in two places
 * is a drift bug waiting for the first rename.
 *
 * WHY HERE AND NOT server/db/. The runtime image copies `node_modules`,
 * `.output`, `drizzle/`, `scripts/` and `entrypoint.sh` — NOT `server/`
 * (Dockerfile stage 4). Boot-time code (the entrypoint pre-flight, the migration
 * runner) runs under tsx against those raw files, so a constant either of them
 * needs cannot live under server/: it would resolve in dev and be missing in
 * production. `server/db/rls-bootstrap.ts` re-exports RLS_APP_ROLE so
 * server-side code still has one obvious import site beside
 * RLS_BOOTSTRAP_TABLES.
 *
 * Deliberately import-free so that reading a role name never drags a database
 * driver in with it.
 */

/**
 * The NON-OWNER login role the app connects as once RLS enforcement is switched
 * on (docs/design/rls-enforcement.md §9 step 1:
 * `CREATE ROLE tokenscope_app LOGIN PASSWORD '…' NOINHERIT`).
 *
 * A table OWNER bypasses RLS unless the table sets `FORCE ROW LEVEL SECURITY`,
 * which is why none of the 40 policies execute today. This role is the other
 * half of the fix.
 */
export const RLS_APP_ROLE = 'tokenscope_app'

/**
 * The Azure Database for PostgreSQL Flexible Server admin group.
 *
 * On Flexible Server the `administratorLogin` — which the migration runner
 * connects as — is documented to be a member of this role, and that membership
 * is where its ability to run `CREATE ROLE` is supposed to come from. Documented
 * is not measured: `scripts/preflight-rls.ts` checks it against the live
 * instance. The role does NOT exist on a plain Postgres, so every query naming
 * it must degrade rather than error.
 */
export const AZURE_PG_ADMIN_ROLE = 'azure_pg_admin'

/**
 * The tables whose RLS must be DISABLED before the app connects as
 * `RLS_APP_ROLE` — the pre-identity reads and writes that happen BEFORE a
 * request can know whose identity to set.
 *
 * NAMES ONLY, here, for the same Dockerfile reason as the role above: the
 * provisioning step runs at boot from `drizzle/`, and `server/` is not in the
 * runtime image. `server/db/rls-bootstrap.ts` holds the reasoned table-by-table
 * record and re-exports these; it is the file to read for WHY each one is
 * present, and it has been under-derived three times.
 */
export const RLS_BOOTSTRAP_TABLE_NAMES: readonly string[] = [
  'oauth_token',
  'teammate',
  'org_unit',
  'instance_attestation',
  'audit_event',
] as const

/**
 * The `seed_state` key under which `drizzle/cutover-rls-sweep.ts` records that
 * the cutover DISABLE sweep has run — the same versioned run-once ledger
 * `drizzle/seed-org-structure.ts` uses (mig 0077), not a marker invented for
 * this step.
 *
 * IT BELONGS TO THE SWEEP, NOT TO PROVISIONING. The row was called
 * `'rls-app-role'` while the sweep lived inside `provision-app-role.ts`, which
 * is precisely the conflation that made the sweep's trigger wrong three rounds
 * running: creating a role and cutting an estate over to RLS enforcement are two
 * decisions, and a ledger named after the first cannot gate the second honestly.
 * See the header of `drizzle/cutover-rls-sweep.ts`.
 *
 * ONE FACT: `version` is the cutover DISABLE sweep that has been applied, and
 * `applied_at` is when. The old row carried a second meaning — "when
 * provisioning last committed a password rotation" — for a clock guard that
 * existed only because EVERY boot rotated. Rotation is now opt-in
 * (`TOKENSCOPE_ROTATE_APP_DB_PASSWORD`) and off by default, so the guard has
 * nothing left to arbitrate and is gone with it.
 */
export const RLS_CUTOVER_SWEEP_SEED_NAME = 'rls-cutover-sweep'

/**
 * The version of the cutover DISABLE sweep. THE LEDGER IS WHAT DECIDES WHETHER
 * THE SWEEP RUNS: it runs while the recorded version is behind this number and
 * never again, because after that the rollout's phases own RLS state (design
 * §7) and a boot script that re-derived it from the catalog would silently undo
 * them.
 *
 * IT IS NOT WHAT DECIDES WHAT MAY BE SWEPT. That is a separate, un-overridable
 * rule in `cutover-rls-sweep.ts`: a table that is ENABLEd **and** FORCEd is a
 * phase's deliberate work and is never disabled, whatever the ledger says. The
 * ledger got the authority to destroy a phase's work in an earlier design, and
 * that was the fourth appearance of the same hazard.
 *
 * Bump this to roll a DELIBERATE new sweep to every environment on its next
 * deploy — the same contract as `SEED_ORG_STRUCTURE_VERSION`. That is the repair
 * for the mixed-revision window, where an older replica sweeps and stamps before
 * a newer replica's migration adds an RLS-enabled table: the new version sweeps
 * the table the old one could not see. It is not a general drift fixer — a bump
 * re-DISABLEs every RLS-enabled table that is not FORCEd, so an operator's bare
 * `ENABLE` (a table turned on to watch a policy) is reverted by it. FORCE it
 * first, or accept that.
 */
export const RLS_CUTOVER_SWEEP_VERSION = 1

/**
 * The advisory-lock keys that serialise the two boot steps across replicas, in
 * the two-argument `(classid, objid)` form.
 *
 * `classid = 100` is deliberately OUTSIDE `server/db/advisory-lock.ts`'s
 * `LOCK_NAMESPACE` (1..9, and growing): boot-path code cannot import that file
 * (the runtime image has no `server/`), so the two key spaces are kept disjoint
 * by construction rather than by anyone remembering to check.
 *
 * TWO KEYS, NOT ONE, because the two steps now own DISJOINT state: provisioning
 * owns the role, its grants and its default privileges; the sweep owns RLS
 * posture. Nothing either writes can tear the other's read. Sharing one key
 * would only make a boot wait out a peer's unrelated step inside the container
 * start probe's window.
 */
export const RLS_PROVISION_LOCK_CLASS = 100
export const RLS_PROVISION_LOCK_KEY = 1
export const RLS_CUTOVER_SWEEP_LOCK_KEY = 2
/** drizzle/migrate.ts: replicas booting together apply each migration once. */
export const MIGRATE_LOCK_KEY = 3

/**
 * The roles this connection could `SET ROLE` to in order to borrow a
 * `CREATEROLE` / `SUPERUSER` attribute — ONE spelling, shared by the probe that
 * REPORTS the capability (`scripts/preflight-rls.ts`) and the step that USES it
 * (`drizzle/provision-app-role.ts`). A probe saying "yes, via SET ROLE" beside a
 * provisioner that never issues one is how diagnostics come to disagree with
 * reality on the exact instance the whole change exists for.
 *
 * Returns one `rolname` column, ordered, suitable for wrapping in `ARRAY(…)`.
 *
 * ── WHY `'SET'` AND NOT `'MEMBER'` OR `'USAGE'` — MEASURED, NOT ASSUMED ──────
 * Measured on PostgreSQL 16.13 (the version `docker-compose.yml`,
 * `tests/integration/helpers/db.ts` and `infra/modules/postgresql.bicep` all
 * pin), with `GRANT grp TO usr WITH SET FALSE` — PG 16's new option:
 *
 *   grant shape                  MEMBER  USAGE  SET   `SET ROLE grp` really…
 *   ---------------------------  ------  -----  ----  ----------------------
 *   default (SET TRUE, NOINHERIT)   t       f     t    succeeds
 *   WITH SET FALSE  (NOINHERIT)     t       f     f    ERROR 'permission denied to set role'
 *   WITH INHERIT TRUE, SET FALSE    t       t     f    ERROR 'permission denied to set role'
 *
 * So `MEMBER` reports a capability the server refuses, and `USAGE` is wrong in
 * BOTH directions — false for the working case, true for the forbidden one.
 * `USAGE` answers "are this role's OBJECT privileges inherited", which is a
 * different question again: role ATTRIBUTES are never inherited (measured: a
 * member with `INHERIT TRUE` still gets `ERROR: permission denied to create
 * role`), so inheritance cannot make `CREATEROLE` usable at all — only `SET
 * ROLE` can. `pg_has_role(…, 'SET')` also follows indirect grant chains
 * (measured), which a `pg_auth_members.set_option` join would have to walk by
 * hand.
 *
 * REQUIRES PostgreSQL 16+: the `SET` privilege type was added alongside
 * `GRANT … WITH SET`. On an older server this errors rather than lying, which is
 * the right failure for a capability probe.
 */
export const CREATEROLE_VIA_SET_ROLE_SQL = `
  SELECT g.rolname::text AS rolname
    FROM pg_roles g
   WHERE (g.rolsuper OR g.rolcreaterole)
     AND g.rolname <> current_user
     AND pg_has_role(current_user, g.oid, 'SET')
   ORDER BY 1
`
