/*
 * drizzle/provision-app-role.ts — mint the NON-OWNER database role that makes
 * the RLS policies execute.
 *
 * WHAT THIS IS FOR (docs/design/rls-enforcement.md §9). TokenScope has 40 RLS
 * policies across 23 tables and none of them run: the app connects as the role
 * that OWNS the tables, and an owner bypasses RLS unless the table sets `FORCE
 * ROW LEVEL SECURITY`. Enforcement needs a non-owner. The design doc's runbook
 * called that step "out-of-band work by a database administrator" — but there is
 * no DBA here, and there does not need to be one: this script runs at boot from
 * `entrypoint.sh`, on the same `DATABASE_URL` the migration runner already uses
 * (the Flexible Server `administratorLogin`, inside the VNet), which can reach
 * `CREATEROLE` — directly or through `SET ROLE azure_pg_admin` (see
 * {@link resolveProvisionBasis}).
 *
 * ── IT CREATES A ROLE. IT DOES NOT TOUCH RLS POSTURE. ───────────────────────
 * The cutover DISABLE sweep used to live here, and its TRIGGER was wrong three
 * adversarial rounds running — on every boot (which undid design §7 phase 2 at
 * the next restart), only when this boot created the role (which could never
 * fire on an environment past its first boot), then on a version ledger alone
 * (which let a bump or a restored database revert a phase and stamp the result
 * as done). Every answer to "when should PROVISIONING sweep?" was wrong because
 * the question was: provisioning creates a role, and cutting an estate over to
 * RLS enforcement is a separate, deliberate, once-per-environment act.
 *
 * It is now `drizzle/cutover-rls-sweep.ts`, behind its own opt-in
 * (`TOKENSCOPE_RLS_CUTOVER_SWEEP`), and its rule is that a table which is
 * ENABLEd **and** FORCEd is never disabled. THIS file still READS the RLS
 * posture and reports it — a role handed out while unvetted tables would bind it
 * is worth a line in the boot log — but it never mutates it, on any code path.
 *
 * ── WHAT A BOOT DOES, IN EACH STATE ─────────────────────────────────────────
 *
 *   no opt-in, no runtime URL → one log line, exit 0. Nothing read or written.
 *   no opt-in, runtime URL    → probes THAT credential only (see below), and
 *                               aborts if it is genuinely broken. Nothing is
 *                               written.
 *   opted in, role ABSENT     → CREATE ROLE, set its password, grants,
 *                               ALTER DEFAULT PRIVILEGES. One transaction.
 *   opted in, role PRESENT    → converge its attributes, grants,
 *                               ALTER DEFAULT PRIVILEGES — and the password is
 *                               NOT TOUCHED. Same transaction.
 *
 * ── WHY THE DORMANT PATH STILL CHECKS THE RUNTIME CREDENTIAL ────────────────
 * `useAppRoleAtRuntime=true` with `provisionAppRole=false` is a combination
 * Bicep permits, and it used to be silent: this step logged "dormant", exited 0,
 * Nitro started on a credential the database rejects, and `/api/health` answered
 * 503 with none of the targeted recovery guidance below. The hazard is not "the
 * provisioning flag is off" — it is "the runtime is pointed at a credential that
 * does not work", which is a property of `TOKENSCOPE_APP_DATABASE_URL` ALONE.
 * Coupling the two flags in Bicep would not have covered it either: the role can
 * be dropped, or the secret can drift, with provisioning firmly on. So the check
 * belongs to the credential, not to the flag.
 *
 * TRUE dormancy is preserved where it matters: with no opt-in AND no
 * `TOKENSCOPE_APP_DATABASE_URL` — every environment today — nothing is read and
 * nothing is written, which is what makes this safe to merge and deploy.
 *
 * ── THE PASSWORD IS SET ONCE, WHEN THE ROLE IS CREATED ──────────────────────
 * A boot that finds the role already there must never move its password. Almost
 * every hazard this file used to carry came from rotating on every boot: a
 * rolling revision where an old-secret and a new-secret replica both boot, the
 * database-clock guard that made the loss loud rather than ordered, a login
 * probe whose only job was to skip the rotation, and an exit code for "we moved
 * the password and could not prove the result". None of it is here now, because
 * ROTATING ON EVERY BOOT is not here.
 *
 * ROTATION IS STILL POSSIBLE, AND IT IS EXPLICIT.
 * `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` sets an EXISTING role's password to
 * `TOKENSCOPE_APP_DB_PASSWORD`. That flag is THE ONLY PATH IN THIS FILE THAT
 * CHANGES AN EXISTING ROLE'S PASSWORD. It is off by default and is meant to be
 * on for one boot, deliberately — never left on, or a restart becomes a rotation
 * again. `infra/parameters/dev.bicepparam` documents the dispatch. A boot WITH
 * that flag set does rotate, so "no boot moves a password" is false and no
 * comment here may say it.
 *
 * DORMANCY IS THE ABSENCE OF AN OPT-IN, NOT A MISSING PASSWORD. An operator who
 * set the flag has asked for a role; if `TOKENSCOPE_APP_DB_PASSWORD` is missing
 * or empty that is a broken deployment, and this exits NON-ZERO naming it. It
 * used to log "dormant" and exit 0, which meant the app booted with no role
 * while the operator believed they had enabled one.
 *
 * ── WHY IT VERIFIES ITSELF ──────────────────────────────────────────────────
 * A provisioning step that reports success without reading its own result is how
 * this project has been burned repeatedly. So before it says "done" it reads
 * back: the role exists, it can log in, it is NOT a superuser, NOT `BYPASSRLS`,
 * NOT `INHERIT`, cannot reach a table owner by any grant shape that Postgres
 * actually honours, and a real connection AS the role succeeds. The login probe
 * prefers `TOKENSCOPE_APP_DATABASE_URL` when it is set, so what is proven is the
 * exact string the runtime pools will use.
 *
 * THE RLS-POSTURE LINE IS A REPORT, NEVER AN ASSERTION. This step does not own
 * that state — the cutover sweep and then the rollout's phases do — so it says
 * what it sees and exits 0. Asserting it would turn design §7 phase 2, which
 * deliberately re-`ENABLE`s `org_unit`, `teammate` and `instance_attestation`,
 * into an un-bootable image that nobody here has the database access to repair.
 *
 * ── THE OWNER URL STAYS THE OWNER URL ───────────────────────────────────────
 * This script and `migrate.ts` both connect with `DATABASE_URL`. Migrations must
 * OWN their objects, and `ALTER DEFAULT PRIVILEGES` here (unqualified, i.e. FOR
 * ROLE current_user) only covers objects created by the role running it — which
 * is exactly why both must stay on the same login. Point migrations at the app
 * role and future tables silently stop being reachable.
 *
 *   TOKENSCOPE_PROVISION_APP_ROLE=true TOKENSCOPE_APP_DB_PASSWORD=… \
 *   DATABASE_URL=… tsx drizzle/provision-app-role.ts    # npm run db:provision-app-role
 *
 * ── EXIT CODES (entrypoint.sh reads them) ───────────────────────────────────
 *   0  dormant, or provisioned and verified.
 *   1  the step did not finish. Boot continues; the next boot retries. A failed
 *      run cannot have taken the runtime's credential away: an existing role's
 *      password is untouched unless rotation was explicitly requested, and a
 *      rotation is one statement inside the one transaction, so a failure either
 *      side of the commit leaves a credential that some deployment holds.
 *   3  the runtime is configured, through `TOKENSCOPE_APP_DATABASE_URL`, to
 *      connect as a role whose credential is genuinely broken — unparseable,
 *      rejected by the server's AUTHENTICATION (SQLSTATE class 28), pointed at a
 *      database that does not exist (3D000), or authenticating as somebody else.
 *      Booting would serve 500s from a healthy-looking deploy.
 *      A database this process could not REACH is NOT this — the server never
 *      answered, so there is no evidence about the credential — and neither is a
 *      server error that is not about identity (`53300 too many connections`,
 *      say). Both exit 1 and boot continues: if the fault persists the revision
 *      fails its readiness probe and Container Apps keeps the previous one, and
 *      if it was a blip the app serves. Aborting would buy neither.
 *
 * ANY OTHER non-zero code is a signal death (an OOM kill or a boot timeout exits
 * 128+N) and `entrypoint.sh` treats it as unsafe whenever provisioning was
 * requested. {@link PROVISION_BUDGET_MS} exists so the ordinary slow paths
 * cannot get there: losing that race rejects into the SAME exit path as any
 * other failure, so the run really does classify itself first.
 *
 * NEVER LOGS THE PASSWORD, and never sends it either — see
 * {@link scramSha256Verifier}. The one statement carrying the derived verifier
 * has its error message suppressed to a pg SQLSTATE, because a server error can
 * quote the statement text back at you.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type postgres from 'postgres'
import { createDbClient } from './connect'
import { bootDdl, pgCode, type BootDb, type PgErrorish } from './boot-sql'
/*
 * From scripts/, NOT server/db/. The runtime image copies node_modules, .output,
 * drizzle/, scripts/ and entrypoint.sh — NOT server/ (Dockerfile stage 4). This
 * script runs at BOOT under tsx against those raw files, so importing from
 * server/ resolves in dev and is MISSING in production. The step is non-fatal,
 * so the failure mode was a line in the deploy log and a role that never
 * appeared. `tests/unit/scripts/boot-path-imports.test.ts` now makes that class
 * fail here instead of there.
 */
import {
  RLS_APP_ROLE as APP_DB_ROLE,
  RLS_BOOTSTRAP_TABLE_NAMES,
  AZURE_PG_ADMIN_ROLE,
  CREATEROLE_VIA_SET_ROLE_SQL,
  RLS_PROVISION_LOCK_CLASS,
  RLS_PROVISION_LOCK_KEY,
} from '../scripts/rls-roles'

/** @see BootDb — the shared base of a pool handle and a transaction handle. */
type Db = BootDb
type Tx = postgres.TransactionSql<Record<string, unknown>>

const TAG = '[provision-app-role]'
const { assertSafeIdentifier, execDdl } = bootDdl(TAG)

/** SQLSTATE 42710 duplicate_object — two replicas booting into the same CREATE ROLE. */
const DUPLICATE_OBJECT = '42710'

/**
 * Exit code for "the runtime is pointed at the app role and that credential is
 * genuinely broken". See the exit-code block at the top of this file.
 */
const EXIT_UNSAFE_TO_BOOT = 3

/*
 * ── THE STARTUP BUDGET, AND WHAT IT IS *NOT* ────────────────────────────────
 *
 * `infra/modules/container-app.bicep` gives the container a Startup probe of
 * `initialDelaySeconds: 5` + `failureThreshold: 44` × `periodSeconds: 5` = a
 * 225s window from container start to the platform giving up and killing it.
 * `entrypoint.sh` spends that window serially: pre-flight, migrations, THIS
 * STEP, the cutover sweep, the binding gate, two seeds, then Nitro binds.
 *
 * THIS DEADLINE DOES NOT ESTABLISH A 225s CONTAINER-START GUARANTEE, and an
 * earlier version of this comment claimed it did. It cannot, because the steps
 * in front of it are not all bounded:
 *
 *   scripts/preflight-run.ts   BOUNDED — 30s (preflight.ts CRITICAL_TIMEOUT_MS),
 *                              probes run concurrently — PLUS the RLS posture
 *                              line it logs afterwards, its own connect +
 *                              statement bound. The step is not just
 *                              `preflight.ts`, and counting it as though it
 *                              were is one of the ways this total has been
 *                              wrong.
 *   drizzle/migrate.ts         **UNBOUNDED**, deliberately. Its connect is
 *                              bounded by postgres.js's 30s default, but the
 *                              migrations themselves carry no
 *                              `statement_timeout` and must not: interrupting a
 *                              schema change part-way is worse than overrunning
 *                              a probe, and a long migration overrunning the
 *                              window is the accepted behaviour today.
 *   this step                  BOUNDED — PROVISION_BUDGET_MS, + up to
 *                              CONNECT_TIMEOUT_S + PROBE_STATEMENT_TIMEOUT for
 *                              the exit-3 classifier's own probe, which runs
 *                              after the deadline clears and is therefore
 *                              outside it. Both terms are needed: connecting
 *                              and querying are separately unbounded, and the
 *                              statement term was missing while this line
 *                              claimed the total.
 *   cutover-rls-sweep.ts       BOUNDED — its own equivalent deadline.
 *   assert-runtime-rls-safe.ts BOUNDED — GATE_BUDGET_MS, covering three serial
 *                              round trips including a second connection.
 *                              Dormant, and therefore free, unless the runtime
 *                              is bound to the app role.
 *   the two seeds              unbounded, and small.
 *
 * So what the deadline buys is narrower and worth stating exactly: A STEP THAT
 * CANNOT FINISH EXITS WITH A CODE `entrypoint.sh` UNDERSTANDS instead of being
 * SIGKILLed at 128+N, which the contract does not define. Per-statement timeouts
 * could not do that on their own — several of the waits here are not statements
 * (a pool open, a connection reserve) — which is why there is a wall-clock
 * deadline at all.
 *
 * The per-step bounds exist so the COMMON failures classify well inside it
 * rather than hitting the deadline:
 *
 *   database unreachable        →  10s   (connect timeout)   → exit 1
 *   a peer holds the lock       →  25s   (connect + lock)    → exit 1
 *   the tx queues on a lock     →  30s   (+ tx lock_timeout) → exit 1, rolled back
 *   happy path                  →  ~2s
 *
 * 30s, not 45s, and the reason is arithmetic rather than taste: the BOUNDED
 * steps must not be able to consume the window on their own. At 45s each they
 * summed past the window and the container could be killed with every step
 * behaving exactly as designed.
 *
 * THE SUM IS NO LONGER WRITTEN OUT HERE, deliberately. Every hand-maintained
 * version of it has been wrong: it omitted the binding gate, then omitted
 * client teardown while asserting a headroom it did not have, then counted the
 * gate's two parallel closes as serial, and this header went on quoting a 125s
 * window for two rounds after Bicep stopped saying 125s.
 * `tests/unit/scripts/provision-app-role-contract.test.ts` derives EVERY term
 * from its own source — the Bicep probe, each script's constants, the posture
 * probe and the teardowns — and requires 60s of headroom for Nitro's own
 * launch. Read the numbers there, where they cannot go stale.
 *
 * Overridable so a test can prove the deadline actually FIRES mid-run rather
 * than asserting arithmetic about it — the same shape as `PREFLIGHT_TIMEOUT_MS`
 * in `scripts/preflight.ts`.
 */
const PROVISION_BUDGET_MS = Number(process.env.TOKENSCOPE_PROVISION_BUDGET_MS) || 30_000
const CONNECT_TIMEOUT_S = 10

/*
 * `connect_timeout` bounds the CONNECT, and nothing else. A server that accepts
 * the connection and then never answers `SELECT current_user` leaves the probe
 * waiting forever — which matters most in the one place it is least visible:
 * the exit-3 classifier runs AFTER the wall-clock deadline has already fired,
 * so it is outside every other bound this file has. Unbounded there, a stalling
 * server consumes the rest of the startup window and the platform SIGKILLs the
 * step at 128+N — destroying precisely the classified exit the deadline exists
 * to produce.
 *
 * So both probes carry a statement timeout as well. It is the connection-level
 * GUC rather than a `SET LOCAL` because these probes run no transaction.
 */
const PROBE_STATEMENT_TIMEOUT = '10s'
const POOL_STATEMENT_TIMEOUT = '10s'
const TX_STATEMENT_TIMEOUT = '15s'
const TX_LOCK_TIMEOUT = '5s'

/**
 * How long to wait for the provisioning advisory lock before giving up.
 *
 * MEASURED on PostgreSQL 16.13: `lock_timeout` DOES bound `pg_advisory_lock`
 * (`SET lock_timeout='3s'` cancelled the wait after 3.07s with `canceling
 * statement due to lock timeout`), so the wait needs no polling loop. Boot must
 * not hang on a peer that is mid-provision — better to skip this boot and let
 * the next one retry. Sized against the startup budget above; the happy path a
 * peer would be holding it for is ~2s.
 */
const LOCK_WAIT = '15s'

/**
 * `statement_timeout` for the connection that WAITS on the advisory lock, and it
 * must exceed {@link LOCK_WAIT}.
 *
 * MEASURED on PostgreSQL 16.13, because the two bounds race and the shorter one
 * wins — which quietly made the message a lie the moment the pool acquired a
 * `statement_timeout` at all:
 *
 *   statement_timeout 4s,  lock_timeout 15s → cancelled at 4.0s, [57014] statement timeout
 *   statement_timeout 20s, lock_timeout  6s → cancelled at 6.0s, [55P03] lock timeout
 *
 * The first row is the bug: the run gives up after the STATEMENT bound and then
 * reports "did not release it within 15s". Raising the statement bound on this
 * one connection is what makes `lock_timeout` the bound that actually fires, so
 * the message and the SQLSTATE both describe what happened.
 */
const LOCK_WAIT_STATEMENT_TIMEOUT = '20s'

/*
 * `assertSafeIdentifier`, `execDdl` and `pgCode` live in `drizzle/boot-sql.ts`
 * because `drizzle/cutover-rls-sweep.ts` needs the same identifier-safety layer
 * and a second copy of it is exactly the sibling-path failure this project keeps
 * paying for.
 */

/**
 * Did the SERVER answer, AND was its answer about IDENTITY?
 *
 * MEASURED against PostgreSQL 16.13 with postgres@3.4.9, because these are
 * different faults with different recoveries, and the previous version — "did
 * the server answer at all" — collapsed the last three rows into "the credential
 * was refused" and then recommended rotating a password that could not fix any
 * of them:
 *
 *   wrong password        → PostgresError, 28P01, severity FATAL   AUTH
 *   unknown role          → PostgresError, 28P01, severity FATAL   AUTH
 *   database missing      → PostgresError, 3D000, severity FATAL   not auth
 *   role at CONNECTION
 *     LIMIT 0             → PostgresError, 53300, severity FATAL   not auth, transient
 *   port closed           → Error, ECONNREFUSED, no severity       never answered
 *   host does not resolve → Error, ENOTFOUND,    no severity       never answered
 *
 * SQLSTATE **class 28** — `invalid_authorization_specification` — is the class
 * that means "the server considered your identity and said no", and it is the
 * only one a credential change repairs. `severity` still decides whether the
 * server answered AT ALL, because a connection errno and a SQLSTATE are both
 * five-ish opaque strings (`EPIPE` would pass a "looks like a SQLSTATE" regex)
 * while only a server reply carries a severity.
 */
function serverAnswered(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as PgErrorish & { name?: string }
  return typeof e.severity === 'string' || e.name === 'PostgresError'
}

/** SQLSTATE class 28 — the only class that means "your identity was rejected". */
function isAuthFailure(code: string | undefined): boolean {
  return typeof code === 'string' && code.startsWith('28')
}

/** `3D000 invalid_catalog_name` — the URL names a database that does not exist. */
const MISSING_DATABASE = '3D000'

/**
 * `execDdl`, for the ONE statement that carries the SCRAM verifier. A Postgres error
 * can echo the offending statement, and that one has authentication material in
 * it — so the message is dropped and only the SQLSTATE survives into the log.
 *
 * Deliberately narrow. Every OTHER role statement (`CREATE ROLE`, the attribute
 * convergence) runs through the plain {@link execDdl} so its server message
 * reaches the log verbatim — that is where `permission denied to alter role /
 * Only roles with the SUPERUSER attribute may change the SUPERUSER attribute`
 * comes from, which is the single most useful line this script can print on an
 * instance whose admin is not a superuser. It is also why `CREATE ROLE` does not
 * carry the password itself: splitting the two keeps `permission denied to
 * create role` readable, and both statements are in one transaction, so there is
 * no window where the role exists without its password.
 */
async function execSecretDdl(sql: Db, template: string, args: string[], label: string): Promise<void> {
  try {
    await execDdl(sql, template, args)
  } catch (err) {
    const code = pgCode(err)
    const sanitised = new Error(
      `${TAG} ${label} failed${code ? ` [SQLSTATE ${code}]` : ''} — the server message is suppressed because that statement carries the role's authentication material`,
    ) as Error & PgErrorish
    sanitised.code = code
    throw sanitised
  }
}

/*
 * ── THE PASSWORD NEVER LEAVES THIS PROCESS ──────────────────────────────────
 *
 * `ALTER ROLE … PASSWORD '<cleartext>'` puts the password in the statement text,
 * and the statement text is visible in `pg_stat_activity.query` to anyone who
 * can read it (on Azure Flexible Server, every member of `azure_pg_admin`) for
 * as long as it runs, and in `log_statement`/error output if either is on.
 *
 * Postgres has accepted a PRE-COMPUTED verifier since 10: if the string handed
 * to `PASSWORD` already parses as a SCRAM-SHA-256 verifier it is stored verbatim
 * rather than hashed. So the cleartext never reaches the server at all.
 *
 * MEASURED on PostgreSQL 16.13 rather than assumed, for four passwords
 * including `9a1e-p@ss'w\ord-one` and a non-ASCII one:
 *   - `pg_authid.rolpassword` holds our string byte-for-byte;
 *   - postgres.js AND libpq both authenticate with the CLEARTEXT afterwards;
 *   - a wrong password is still rejected (the negative control — otherwise the
 *     above proves only that some login succeeded);
 *   - it is stored verbatim even with `password_encryption = md5`, so this does
 *     not depend on the instance's setting.
 *
 * RESIDUAL, stated precisely rather than waved at: the VERIFIER is still in the
 * statement text, so `pg_stat_activity` shows `SCRAM-SHA-256$4096:…` while the
 * statement runs. That is the same material `pg_authid` already stores, and by
 * SCRAM's construction it is not a login credential — authenticating needs
 * ClientKey, and the verifier holds only SHA256(ClientKey). It is an offline
 * brute-force target, nothing more. The cleartext, which WOULD be a credential,
 * is gone.
 *
 * SASLprep is not applied here. Neither does postgres.js, so the two agree,
 * which is what matters — and the generated password is a Bicep `newGuid()`,
 * for which SASLprep is the identity anyway.
 */
const SCRAM_ITERATIONS = 4096

function scramSha256Verifier(password: string): string {
  const salt = randomBytes(16)
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, SCRAM_ITERATIONS, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString(
    'base64',
  )}:${serverKey.toString('base64')}`
}

/** Build the app-role URL from the owner's, swapping only the credentials. */
function deriveAppUrl(ownerUrl: string, role: string, password: string): string {
  const u = new URL(ownerUrl)
  // postgres.js decodeURIComponent()s both fields (src/index.js:549-550), so
  // encode them here — a generated password may contain URL-significant bytes.
  u.username = encodeURIComponent(role)
  u.password = encodeURIComponent(password)
  return u.toString()
}

type ProvisionBasis = 'superuser' | 'createrole' | 'set-role'

interface Capability {
  basis: ProvisionBasis
  /** The role to `SET ROLE` to for the role DDL; null when none is needed. */
  setRoleTo: string | null
}

/**
 * Decide HOW this connection can run `CREATE ROLE`, and agree with what
 * `scripts/preflight-rls.ts` reports.
 *
 * The probe has always reported `provisionBasis: 'set-role'` when `current_user`
 * can reach `CREATEROLE` only through another role, because **Postgres does not
 * inherit role ATTRIBUTES through membership** — you must actually `SET ROLE`.
 * This step used to run `CREATE ROLE` as `current_user` regardless, so on the
 * exact instance the change exists for (an Azure `administratorLogin` holding
 * `CREATEROLE` via `azure_pg_admin`) diagnostics said "yes" and provisioning
 * failed. The predicate is shared, not re-spelled — see
 * `CREATEROLE_VIA_SET_ROLE_SQL`, which also records why `'SET'` is the right
 * `pg_has_role` mode and `'MEMBER'`/`'USAGE'` are not.
 */
async function resolveProvisionBasis(sql: Db): Promise<Capability> {
  const [me] = await sql<{ me: string; issuper: boolean; cancreate: boolean }[]>`
    SELECT current_user::text AS me, r.rolsuper AS issuper, r.rolcreaterole AS cancreate
      FROM pg_roles r WHERE r.rolname = current_user
  `
  if (!me) throw new Error(`${TAG} pg_roles has no row for current_user — refusing to guess`)
  if (me.me === APP_DB_ROLE) {
    throw new Error(
      `${TAG} DATABASE_URL connects as '${APP_DB_ROLE}' itself. That URL must stay the OWNER's: migrations have to own their objects, and this script's ALTER DEFAULT PRIVILEGES only covers objects created by the role that runs it.`,
    )
  }
  if (me.issuper) return { basis: 'superuser', setRoleTo: null }
  if (me.cancreate) return { basis: 'createrole', setRoleTo: null }

  const reachable = await sql.unsafe<{ rolname: string }[]>(CREATEROLE_VIA_SET_ROLE_SQL)
  const names = reachable.map((r) => r.rolname)
  if (names.length === 0) {
    throw new Error(
      `${TAG} '${me.me}' cannot create roles: it holds neither SUPERUSER nor CREATEROLE, and there is no role carrying either that it may SET ROLE to. ` +
        `On Azure Flexible Server that means the login is not an effective member of '${AZURE_PG_ADMIN_ROLE}' (a WITH SET FALSE grant reports as MEMBER but forbids the transition). ` +
        `/api/v1/admin/diagnostics/rls-posture reports the same verdict as provisionBasis.`,
    )
  }
  // Prefer the Azure admin group when it is one of the options: it is the role
  // the runbook names, so the audit trail says what an operator expects.
  const chosen = names.includes(AZURE_PG_ADMIN_ROLE) ? AZURE_PG_ADMIN_ROLE : names[0]!
  assertSafeIdentifier(chosen, 'SET ROLE target')
  return { basis: 'set-role', setRoleTo: chosen }
}

interface RoleAttributes {
  exists: boolean
  issuper: boolean
  bypassrls: boolean
  inherits: boolean
}

async function readRoleAttributes(sql: Db): Promise<RoleAttributes> {
  const [row] = await sql<{ issuper: boolean; bypassrls: boolean; inherits: boolean }[]>`
    SELECT rolsuper AS issuper, rolbypassrls AS bypassrls, rolinherit AS inherits
      FROM pg_roles WHERE rolname = ${APP_DB_ROLE}
  `
  return {
    exists: Boolean(row),
    issuper: row?.issuper ?? false,
    bypassrls: row?.bypassrls ?? false,
    inherits: row?.inherits ?? false,
  }
}

/**
 * Refuse to certify a role that can REACH a TABLE OWNER — by any grant shape
 * Postgres actually honours, and by NO shape it does not.
 *
 * Postgres decides the RLS owner bypass with `has_privs_of_role()`, so a role
 * that holds the owner's privileges reads the estate with every policy inert.
 * Pointing the app at that would look exactly like a completed cutover.
 *
 * ── MEASURED ON PostgreSQL 16.13: ALL 21 SHAPES, END TO END ─────────────────
 * PG 16 made INHERIT, SET and ADMIN properties of each GRANT and they are
 * INDEPENDENT. Each cell below was executed against a real RLS-enabled table
 * owned by another role: the app role tried to read it as itself, after
 * `SET ROLE`, and after re-granting itself `SET` where it held ADMIN OPTION.
 * `I` = INHERIT only, `S` = SET only, `A` = ADMIN only, `N` = none of the three.
 *
 *   direct grant of the owner to the app role
 *     I  BYPASS (reads it directly)   S  BYPASS (SET ROLE, then reads it)
 *     A  BYPASS (re-grants itself SET, then the above)          N  no
 *
 *   two hops, app -h1-> mid -h2-> owner        h2:  I       S       A       N
 *                                          h1: I  BYPASS  no      BYPASS  no
 *                                              S  BYPASS  BYPASS  BYPASS  no
 *                                              A  BYPASS  BYPASS  BYPASS  no
 *                                              N  no      no      no      no
 *
 * Two facts fall out, and the predicate below is exactly them:
 *
 *   1. AN `N` EDGE REACHES NOTHING, and is not itself a bypass. The previous
 *      walk followed every `pg_auth_members` row regardless of its options, so
 *      it called 9 of those 21 shapes a bypass and refused to provision. That is
 *      this check's THIRD wrong answer in three directions (under-rejecting,
 *      corrected, over-corrected), which is why it is now measured rather than
 *      reasoned about.
 *   2. `I -> S` DOES NOT COMPOSE. Inheriting a role's privileges does not lend
 *      you its ability to `SET ROLE`. Everything else composes, because ADMIN
 *      OPTION *is* an inheritable privilege — an `I -> A` member simply grants
 *      itself `SET` and proceeds.
 *
 * So the walk carries one bit per reached role: can we BECOME it (`SET`, or
 * `ADMIN` which buys `SET`), or do we merely hold its privileges? An edge is
 * followed when it INHERITs, when it grants ADMIN, or when it grants SET and we
 * can become the role holding it.
 *
 * It also carries which OPTIONS the followed edges used, and that is what the
 * refusal message names. A single grant routinely carries more than one (PG 16's
 * default is INHERIT-from-`rolinherit` plus `SET TRUE`), and a chain can use a
 * different one at each hop, so picking "the" route to report is a guess — this
 * message got it wrong once already by naming INHERIT for a grant whose real
 * route was `SET ROLE`.
 *
 * ONE CAVEAT WORTH KNOWING BEFORE YOU TRY TO REPRODUCE THE `ADMIN` ROW: it does
 * not fire when the owner is a SUPERUSER, because `GRANT` then refuses with
 * *"Only roles with the SUPERUSER attribute may grant roles with the SUPERUSER
 * attribute"* (measured). That is a property of the fixture, not of the
 * predicate — on Azure the table owner is `administratorLogin`, which is not a
 * superuser, and the escalation is available. A test that uses the default
 * testcontainers superuser as the owner will quietly show no bypass.
 *
 * ── AND WHY IT IS A CATALOG WALK RATHER THAN `pg_has_role` ──────────────────
 * `pg_has_role(app, owner, 'USAGE' | 'SET')` — what the two arms here used to be
 * — is wrong in BOTH directions on that table. It is VACUOUSLY TRUE for a
 * superuser, so a pre-existing SUPERUSER `tokenscope_app` skipped the check
 * entirely and was caught only after the commit. And it is FALSE for six real
 * bypasses: every `A` shape, and `S -> I`, where the app `SET ROLE`s to a
 * middle role that inherits the owner (measured: `USAGE` f, `SET` f, and the
 * owner's row read anyway). The walk answers both independently of `rolsuper`.
 *
 * The app role OWNING a table is its own arm, spelled out rather than left to
 * `pg_has_role`'s reflexivity: it is the plainest bypass there is.
 *
 * ── WHY IT REFUSES INSTEAD OF FIXING ────────────────────────────────────────
 * `ALTER ROLE app NOINHERIT` does NOT clear an inheriting membership: PG 16
 * fixes each grant's INHERIT from the member's `rolinherit` AT GRANT TIME and
 * `ALTER ROLE` never revisits it (measured: `rolinherit` goes false while
 * `inherit_option` and `USAGE` stay true). Only `REVOKE` undoes a grant somebody
 * made deliberately, so this names it and stops.
 */
async function assertNoOwnerPrivileges(sql: Db, when: string): Promise<void> {
  /*
   * The app role is JOINed rather than named as a `::name` literal. Before the
   * first provisioning run the role legitimately does not exist, and this check
   * runs then too — with the join there is simply no row to test.
   */
  const owned = await sql<{ relname: string; owner: string; reach: string }[]>`
    WITH RECURSIVE reachable(roleid, can_set, by_inherit, by_set, by_admin) AS (
      SELECT m.roleid, (m.set_option OR m.admin_option),
             m.inherit_option, m.set_option, m.admin_option
        FROM pg_auth_members m
        JOIN pg_roles a ON a.oid = m.member
       WHERE a.rolname = ${APP_DB_ROLE}
         AND (m.inherit_option OR m.set_option OR m.admin_option)
      UNION
      SELECT m.roleid, (m.admin_option OR (m.set_option AND r.can_set)),
             r.by_inherit OR m.inherit_option,
             r.by_set     OR m.set_option,
             r.by_admin   OR m.admin_option
        FROM reachable r
        JOIN pg_auth_members m ON m.member = r.roleid
       WHERE m.inherit_option OR m.admin_option OR (m.set_option AND r.can_set)
    ),
    reach AS (
      SELECT roleid,
             bool_or(by_inherit) AS by_inherit,
             bool_or(by_set)     AS by_set,
             bool_or(by_admin)   AS by_admin
        FROM reachable GROUP BY roleid
    )
    SELECT c.relname::text AS relname,
           pg_get_userbyid(c.relowner)::text AS owner,
           CASE
             WHEN c.relowner = app.oid THEN 'OWNING IT OUTRIGHT'
             /*
              * The grant options that make it reachable, not a guess at which
              * one an operator would use — a chain can carry more than one, and
              * naming only the first is how this message came to say INHERIT
              * about a grant whose real route was SET ROLE.
              */
             ELSE array_to_string(ARRAY[]::text[]
                    || CASE WHEN r.by_inherit THEN ARRAY['INHERIT'] ELSE ARRAY[]::text[] END
                    || CASE WHEN r.by_set     THEN ARRAY['SET ROLE'] ELSE ARRAY[]::text[] END
                    || CASE WHEN r.by_admin   THEN ARRAY['ADMIN OPTION'] ELSE ARRAY[]::text[] END,
                  ' / ')
           END AS reach
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles app ON app.rolname = ${APP_DB_ROLE}
      LEFT JOIN reach r ON r.roleid = c.relowner
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND (c.relowner = app.oid OR r.roleid IS NOT NULL)
     ORDER BY 1 LIMIT 5
  `
  if (owned.length === 0) return
  const owners = [...new Set(owned.map((r) => r.owner))]
  const reaches = [...new Set(owned.map((r) => r.reach))]
  throw new Error(
    `${TAG} ${when}: role '${APP_DB_ROLE}' can reach the owner of ${owned
      .map((r) => r.relname)
      .join(', ')} (owner${owners.length > 1 ? 's' : ''} ${owners.join(', ')}) by ${reaches.join(' / ')}. ` +
      'An owner bypasses RLS unless the table is FORCEd, so this role would read the estate with every policy inert — a cutover that looks done and enforces nothing. ' +
      'INHERIT, SET and ADMIN are independent grant options and ANY of them is a bypass: a SET-only member runs `SET ROLE` first, an ADMIN-only member re-grants itself SET (both measured on PG 16.13). ' +
      `NOINHERIT does NOT clear it: PG 16 keeps INHERIT per GRANT and ALTER ROLE does not revisit existing memberships. Fix it with \`REVOKE ${owners.join(
        ', ',
      )} FROM ${APP_DB_ROLE}\` and re-run.`,
  )
}

/**
 * Bring a role that ALREADY EXISTS to the security posture this script promises,
 * instead of inheriting whatever was there.
 *
 * The hazard is not hypothetical shape-hunting: `tokenscope_app` created by hand
 * (or by an earlier, laxer version of this file) carrying `BYPASSRLS`,
 * `SUPERUSER` or `INHERIT` produces a cutover that verifies clean and leaves
 * every policy bypassed.
 *
 * ── WHY THE CLAUSES ARE CONDITIONAL, MEASURED ON PG 16.13 ───────────────────
 * `NOSUPERUSER` and `NOBYPASSRLS` are NOT free to state:
 *
 *   ALTER ROLE app NOSUPERUSER   as a CREATEROLE non-superuser
 *     → ERROR: permission denied to alter role
 *       DETAIL: Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
 *   ALTER ROLE app NOBYPASSRLS   as a role without BYPASSRLS
 *     → ERROR: permission denied to alter role
 *       DETAIL: Only roles with the BYPASSRLS attribute may change the BYPASSRLS attribute.
 *
 * Both are refused even when the clause is a NO-OP. An unconditional
 * `ALTER ROLE … NOSUPERUSER NOBYPASSRLS` would therefore fail on every instance
 * whose admin is not a superuser — i.e. on Azure, the only place this runs. So
 * each negative is emitted only when the attribute is actually set, and when it
 * is, a refusal is a LOUD failure (the whole transaction rolls back) rather than
 * a role that quietly keeps bypassing RLS. `CREATE ROLE` has no such rule, so
 * the fresh path states all three.
 */
function attributeConvergenceClauses(current: RoleAttributes): string[] {
  const clauses = ['LOGIN', 'NOINHERIT']
  if (current.issuper) clauses.push('NOSUPERUSER')
  if (current.bypassrls) clauses.push('NOBYPASSRLS')
  return clauses
}

interface ProvisionReport {
  action: 'created' | 'updated'
  basis: ProvisionBasis
  setRoleTo: string | null
  /**
   * True only when this run set the role's password — i.e. it CREATEd the role,
   * or `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` asked it to roll an existing
   * one. There is no third path.
   */
  passwordSet: boolean
}

interface ProvisionInput {
  verifier: string
  cap: Capability
  /**
   * `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true`. THE ONLY THING IN THIS FILE THAT
   * CHANGES AN EXISTING ROLE'S PASSWORD. Off by default, and meant to be on for
   * one deliberate boot — leaving it on turns every restart back into a
   * rotation, which is the behaviour this file was cut down to remove.
   */
  rotate: boolean
}

/**
 * Everything that changes the database, in ONE transaction.
 *
 * Role DDL, GRANTs and `ALTER DEFAULT PRIVILEGES` are all transactional in
 * Postgres (measured: a forced error after all three rolled back the role and
 * the grants together), so a partial provisioning state cannot exist.
 */
async function provision(tx: Tx, input: ProvisionInput): Promise<ProvisionReport> {
  const { verifier, cap, rotate } = input
  // Bound the DDL: role DDL takes a tuple lock on the role's `pg_authid` row
  // (measured: a second `ALTER ROLE` on the same role blocks until lock_timeout
  // with 55P03), and two replicas booting at once will queue. Boot must not hang
  // on a lock it cannot get — better to fail this non-fatal step and retry on
  // the next boot. SET LOCAL, so the bound dies with the transaction.
  await tx.unsafe(`SET LOCAL statement_timeout = '${TX_STATEMENT_TIMEOUT}'`)
  await tx.unsafe(`SET LOCAL lock_timeout = '${TX_LOCK_TIMEOUT}'`)

  // ── The role ──────────────────────────────────────────────────────────────
  // SET ROLE only around the role DDL. It must NOT stay on for the grants
  // below: SET ROLE REPLACES the privilege set rather than adding to it, so a
  // GRANT issued while assuming azure_pg_admin can only hand out what THAT role
  // holds — and Postgres reports the shortfall as a WARNING, not an error
  // (measured: `GRANT USAGE ON SCHEMA public` as a non-owner produced
  // `WARNING: no privileges were granted for "public"` and still returned
  // GRANT). A silent half-grant is exactly the failure this file exists to
  // avoid, so the grants run as the owner login, which is what RESET ROLE
  // restores.
  if (cap.setRoleTo) await execDdl(tx, 'SET LOCAL ROLE %I', [cap.setRoleTo])

  let action: 'created' | 'updated' = 'created'
  try {
    // A savepoint, because inside a transaction a duplicate_object aborts
    // everything after it — the previous "catch and fall through to ALTER"
    // stopped working the moment this became atomic.
    await tx.savepoint(async (sp) => {
      await execDdl(sp, 'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS', [APP_DB_ROLE])
    })
  } catch (err) {
    // A second replica booted into the same CREATE, or the role predates this
    // script. Converge it below instead.
    if (pgCode(err) !== DUPLICATE_OBJECT) throw err
    action = 'updated'
  }

  /*
   * ── THE PASSWORD, AND THE ONE RULE ABOUT IT ───────────────────────────────
   *
   * A role this run CREATEd has no password yet, so it gets one — same
   * transaction, so the role cannot commit without it.
   *
   * A role that ALREADY EXISTED keeps the password it has. Not "unless it looks
   * stale", not "unless a probe says otherwise" — kept. The app may be serving
   * on it right now, and this process cannot know whether the secret it was
   * handed is newer or older than the one the role holds (Key Vault revision ids
   * are not passed to the container). Moving it on a restart is how a healthy
   * replica loses its credential to a peer that booted with a stale secret.
   *
   * `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` is the deliberate exception, and it
   * is the ONLY one.
   */
  let passwordSet = false
  /*
   * `progress.passwordSet` is set HERE, not from the report, so that a deadline
   * firing while the transaction is still open can say honestly whether an
   * in-flight commit would move the credential. Reading it off the returned
   * report meant it was false for exactly the window where the question matters.
   */
  if (action === 'created') {
    await execSecretDdl(tx, 'ALTER ROLE %I PASSWORD %L', [APP_DB_ROLE, verifier], 'ALTER ROLE PASSWORD')
    passwordSet = true
    progress.passwordSet = true
  } else {
    // Assert the posture rather than inherit it — see attributeConvergenceClauses.
    const current = await readRoleAttributes(tx)
    const clauses = attributeConvergenceClauses(current)
    await execDdl(tx, `ALTER ROLE %I WITH ${clauses.join(' ')}`, [APP_DB_ROLE])
    if (rotate) {
      await execSecretDdl(tx, 'ALTER ROLE %I PASSWORD %L', [APP_DB_ROLE, verifier], 'ALTER ROLE PASSWORD')
      passwordSet = true
      progress.passwordSet = true
    }
  }

  if (cap.setRoleTo) await tx.unsafe('RESET ROLE')

  // ── Grants, including the ones for tables that do not exist yet ───────────
  // A role that works today and breaks on the next migration is worse than no
  // role at all: the failure lands at boot, in production, on whoever deployed
  // an unrelated schema change. ALTER DEFAULT PRIVILEGES is what makes future
  // migrations' tables and sequences reachable without re-running this script.
  const grants: string[] = [
    'GRANT USAGE ON SCHEMA public TO %I',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  ]
  for (const template of grants) {
    await execDdl(tx, template, [APP_DB_ROLE])
  }
  // audit_event is append-only, and nothing in the app updates or deletes it.
  // Without this the only guard is a trigger, which the table owner can drop.
  // It must follow the blanket GRANT above, which re-grants on every run.
  await execDdl(tx, 'REVOKE UPDATE, DELETE ON audit_event FROM %I', [APP_DB_ROLE])

  /*
   * ── NO `REVOKE` ON `provider_usage_fact`, AND THIS IS THE RECORD OF WHY ────
   *
   * A previous version of this file ran
   * `REVOKE INSERT, UPDATE, DELETE ON provider_usage_fact FROM tokenscope_app`
   * here, reading migration 0118's header as a shopping list:
   *
   *   "WHAT ACTUALLY LANDS IT: the non-owner writer role … When that role
   *    exists, this becomes two lines (`GRANT SELECT …; REVOKE INSERT, UPDATE,
   *    DELETE … FROM <role>`) plus the permission test the invariant asks for."
   *
   * 0118 proposes revoking from a JOINER role — a role SEPARATE from the writer.
   * THERE IS EXACTLY ONE RUNTIME ROLE. `server/db/worker-db.ts::getWorkerDb()`
   * resolves the same `TOKENSCOPE_APP_DATABASE_URL` as the request lane, so the
   * provider-transform worker authenticates as `tokenscope_app` — and it is the
   * writer: `server/workers/provider-fact.ts:189` INSERTs into
   * `provider_usage_fact` and `server/workers/provider-transform.ts:616` DELETEs
   * from it. Revoking those from the only role that exists does not enforce the
   * invariant, it BREAKS THE API LANE: after cutover both statements fail and
   * the model axis stops being written.
   *
   * WITH A SINGLE APP ROLE THE INVARIANT IS NOT EXPRESSIBLE AS A GRANT. Grants
   * are per (role, table); the distinction 0118 wants is per CALL SITE inside
   * one role. Landing it needs one of:
   *   - a SECOND login role for the joiner lane, with its own pool and its own
   *     URL, so "the joiner cannot write this table" becomes a real grant; or
   *   - an RLS WRITE policy on `provider_usage_fact` keyed on a lane GUC (the
   *     worker lane already carries `app.user_role=global-finops`), so the
   *     write is refused by predicate rather than by privilege.
   * Either is its own change with its own blast radius. Until one lands the
   * property is held by code review, exactly as 0118 says it is.
   *
   * `tests/integration/db/provision-app-role.test.ts` asserts the app role CAN
   * INSERT, UPDATE and DELETE `provider_usage_fact`, so re-adding the revoke
   * turns a test red instead of turning the API lane off in production.
   */

  return { action, basis: cap.basis, setRoleTo: cap.setRoleTo, passwordSet }
}

/**
 * The one transaction, plus the bookkeeping that keeps {@link progressLine}
 * honest.
 *
 * `txStarted` means "OPEN, AND ITS OUTCOME HAS NOT BEEN OBSERVED", which is a
 * narrower thing than "a transaction was issued". It is cleared the moment
 * `sql.begin` settles either way: a REJECTION means postgres.js has already run
 * the ROLLBACK, so "the outcome is unknown" would be a worse answer than the
 * true one. The only genuinely unknown state is a DEADLINE landing while the
 * COMMIT is in flight — which is the state this flag exists for, and the state
 * that used to be reported as "nothing was committed".
 */
async function commitProvisioning(
  sql: postgres.Sql<Record<string, unknown>>,
  input: ProvisionInput,
): Promise<ProvisionReport> {
  progress.txStarted = true
  try {
    return await sql.begin(async (tx) => provision(tx, input))
  } catch (err) {
    progress.txStarted = false
    throw err
  }
}

function reportProvisioning(report: ProvisionReport): void {
  const basis = report.setRoleTo ? `${report.basis} via ${report.setRoleTo}` : report.basis
  console.warn(
    `${TAG} role '${APP_DB_ROLE}' ${report.action} (basis: ${basis}); grants + default privileges applied; ` +
      `password ${
        report.passwordSet
          ? report.action === 'created'
            ? 'set (the role was created by this run)'
            : 'ROTATED (TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true)'
          : 'untouched (this step never changes an existing role’s password unless TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true)'
      }.`,
  )
}

/**
 * Read back what this run did — and REPORT, without asserting, what it did not.
 *
 * The role checks are assertions because this run owns the role. THE RLS-POSTURE
 * CHECK IS NOT, because this run does not own RLS state: `cutover-rls-sweep.ts`
 * performs the cutover and the rollout's phases own it afterwards. Asserting it
 * here would make design §7 phase 2 — which deliberately re-`ENABLE`s `org_unit`,
 * `teammate` and `instance_attestation` — an un-bootable image, and nobody on
 * this project has the database access to break that loop (§9).
 */
async function verify(sql: Db, ownerUrl: string, password: string, report: ProvisionReport): Promise<void> {
  const { passwordSet } = report
  const [role] = await sql<{ canlogin: boolean; issuper: boolean; bypassrls: boolean; inherits: boolean }[]>`
    SELECT rolcanlogin AS canlogin, rolsuper AS issuper, rolbypassrls AS bypassrls, rolinherit AS inherits
      FROM pg_roles WHERE rolname = ${APP_DB_ROLE}
  `
  if (!role) throw new Error(`${TAG} verification failed: role '${APP_DB_ROLE}' does not exist after provisioning`)
  if (!role.canlogin) throw new Error(`${TAG} verification failed: role '${APP_DB_ROLE}' cannot LOGIN`)
  if (role.issuper) {
    throw new Error(
      `${TAG} verification failed: role '${APP_DB_ROLE}' is a SUPERUSER. A superuser bypasses RLS unconditionally — pointing the app at it would leave every policy inert while looking like enforcement.`,
    )
  }
  if (role.bypassrls) {
    throw new Error(
      `${TAG} verification failed: role '${APP_DB_ROLE}' has BYPASSRLS. That silences the whole estate exactly as SUPERUSER does, and it cannot be cleared from here unless this connection holds BYPASSRLS itself.`,
    )
  }
  if (role.inherits) {
    throw new Error(
      `${TAG} verification failed: role '${APP_DB_ROLE}' is INHERIT, not NOINHERIT. Postgres decides the RLS owner bypass with has_privs_of_role(), so an INHERITing member of a table owner bypasses RLS exactly as the owner does.`,
    )
  }

  // The membership half of the same hazard — and the half NOINHERIT does not
  // close. Checked before the transaction too, so this is the backstop.
  await assertNoOwnerPrivileges(sql, 'verification failed')

  const posture = await sql<{ relname: string; enabled: boolean; forced: boolean }[]>`
    SELECT c.relname::text AS relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY 1
  `
  const byName = new Map(posture.map((r) => [r.relname, r]))
  const missing = RLS_BOOTSTRAP_TABLE_NAMES.filter((t) => !byName.has(t))
  if (missing.length > 0) {
    throw new Error(`${TAG} verification failed: bootstrap table(s) not found: ${missing.join(', ')}`)
  }
  const bootstrapStillEnabled = RLS_BOOTSTRAP_TABLE_NAMES.filter((t) => byName.get(t)?.enabled)
  const bindingUnvetted = posture.filter((r) => r.enabled && !r.forced).map((r) => r.relname)
  if (bootstrapStillEnabled.length > 0 || bindingUnvetted.length > 0) {
    console.warn(
      `${TAG} RLS posture NOTE (reported, not enforced — this step never changes RLS state; the cutover sweep and then the rollout's phases own it): ` +
        `bootstrap table(s) ENABLED: ${bootstrapStillEnabled.join(', ') || 'none'}; ` +
        `ENABLED without FORCE: ${bindingUnvetted.join(', ') || 'none'}. ` +
        'A non-owner is bound by ENABLE alone, so anything listed here filters the app the moment it connects as the role. ' +
        'If the cutover has not run yet, that is what TOKENSCOPE_RLS_CUTOVER_SWEEP=true (Bicep: runRlsCutoverSweep) is for.',
    )
  }

  /*
   * Prove the credential actually works — against the string the RUNTIME will
   * use when there is one, not a reconstruction of it.
   *
   * WHEN THE DERIVED URL FAILING IS NOT A FAILURE. With no
   * `TOKENSCOPE_APP_DATABASE_URL`, no TokenScope pool connects as this role yet (this function's own probe is the exception, and anything outside this deployment is unknowable from here), and on a
   * run that did NOT set the password the derived URL is a guess: it asks
   * whether the role happens to hold the secret this deployment carries, which
   * is a question about Key Vault drift, not about what this run did. Making it
   * fatal would abort boot over a credential nothing uses. So it is reported,
   * and it names the flag that would resolve it.
   */
  const configured = process.env.TOKENSCOPE_APP_DATABASE_URL?.trim()
  const source = configured ? 'TOKENSCOPE_APP_DATABASE_URL' : 'derived from DATABASE_URL'
  const advisoryOnly = !configured && !passwordSet
  const probeUrl = configured || deriveAppUrl(ownerUrl, APP_DB_ROLE, password)
  const probe = createDbClient(probeUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { statement_timeout: PROBE_STATEMENT_TIMEOUT },
  })
  let who: { me: string } | undefined
  let probeErr: unknown
  try {
    ;[who] = await probe<{ me: string }[]>`SELECT current_user::text AS me`
  } catch (err) {
    probeErr = err
  } finally {
    await probe.end({ timeout: 5 }).catch(() => undefined)
  }

  if (probeErr) {
    // The `cause` is safe to keep here and worth keeping: a CONNECTION error
    // names a host, a SQLSTATE or a DNS failure — never the credential. (The
    // one statement that DOES carry authentication material is redacted in
    // execSecretDdl.)
    const code = pgCode(probeErr)
    const detail = `could not connect as '${APP_DB_ROLE}' using the app URL (${source})${code ? ` [SQLSTATE ${code}]` : ''}`
    if (advisoryOnly) {
      console.warn(
        `${TAG} NOTE (not a failure): ${detail}. Nothing connects as this role yet — TOKENSCOPE_APP_DATABASE_URL is unset — and this run did not set the role's password, so this only says the role does not hold TOKENSCOPE_APP_DB_PASSWORD. ` +
          'If they are meant to agree, roll the credential deliberately: re-apply infra.yml with writeAppDbPassword=true, then one boot with TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true.',
      )
    } else {
      throw new Error(`${TAG} verification failed: ${detail}.`, { cause: probeErr })
    }
  } else if (who?.me !== APP_DB_ROLE) {
    const detail = `the app URL (${source}) authenticated as '${who?.me ?? 'unknown'}', not '${APP_DB_ROLE}'`
    if (advisoryOnly) console.warn(`${TAG} NOTE (not a failure): ${detail}.`)
    else throw new Error(`${TAG} verification failed: ${detail}`)
  }

  console.warn(
    `${TAG} verified: role exists, can log in, is not SUPERUSER / BYPASSRLS / INHERIT, and cannot reach a table owner.${
      probeErr || who?.me !== APP_DB_ROLE ? '' : ` The app URL (${source}) authenticates as it.`
    }`,
  )
}

/**
 * THE LEVER, spelled out because nobody on this project has direct database
 * access and the only thing they hold is a redeploy. An abort message that
 * merely names the failure strands the environment.
 *
 * It is the FIRST half of every abort. The second half — what to fix once the
 * app is back on the owner connection — differs per cause, and merging the two
 * is how the previous text came to recommend rotating a password at an operator
 * whose database name was wrong. See {@link RuntimeCredential}.
 */
const RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE =
  `RECOVERY (no database access needed): set \`param useAppRoleAtRuntime = false\` in infra/parameters/dev.bicepparam and dispatch infra.yml. ` +
  `That returns the runtime pools to the OWNER connection immediately and the app boots — the policies were inert on that connection anyway. Then fix the cause:`

/** The cause-specific half, for a credential the server rejected on IDENTITY. */
const FIX_THE_CREDENTIAL =
  `the two that actually happen are: provisionAppRole is on without hasAppRoleSecrets, so TOKENSCOPE_APP_DB_PASSWORD never reached the container; ` +
  `or the role's password and the app-db-password secret have drifted apart. This step does not change an existing role's password unless TOKENSCOPE_ROTATE_APP_DB_PASSWORD is set, so roll it deliberately: re-apply with writeAppDbPassword=true, then ONE boot with rotateAppDbPassword=true.`

/**
 * Is the runtime configured to connect as the app role, and does that credential
 * work? That, and only that, decides whether boot is safe — which is why this is
 * asked even when provisioning itself is DORMANT (see {@link main}).
 *
 * THE STATES ARE NOT INTERCHANGEABLE, and collapsing them is how this file has
 * twice given an operator advice that could not work:
 *
 *   - `auth-failed` — SQLSTATE class 28. The server considered the identity and
 *     said no. A credential change is the fix.
 *   - `no-database` — 3D000. The URL names a database that does not exist. Every
 *     runtime pool fails forever, so booting is not safe; but rotating a
 *     password cannot possibly help, and the previous code told operators to.
 *   - `server-error` — the server answered with anything else (`53300 too many
 *     connections for role` is the one that really happens, e.g. a
 *     `CONNECTION LIMIT`). It says NOTHING about whether the credential is
 *     right, and it is often transient. Not an abort.
 *   - `unreachable` — nothing answered. No evidence about the credential at all,
 *     and no parameter change fixes DNS, a firewall, a private endpoint or a
 *     server that is down.
 *   - `malformed` — postgres.js could not even parse the URL, so neither can the
 *     runtime pools.
 */
type RuntimeCredential =
  | { state: 'absent' }
  | { state: 'ok' }
  | { state: 'wrong-role'; detail: string }
  | { state: 'auth-failed'; detail: string }
  | { state: 'no-database'; detail: string }
  | { state: 'server-error'; detail: string }
  | { state: 'unreachable'; detail: string }
  | { state: 'malformed'; detail: string }

async function classifyRuntimeCredential(): Promise<RuntimeCredential> {
  const configured = process.env.TOKENSCOPE_APP_DATABASE_URL?.trim()
  if (!configured) return { state: 'absent' }

  let probe: ReturnType<typeof createDbClient>
  try {
    probe = createDbClient(configured, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: CONNECT_TIMEOUT_S,
      connection: { statement_timeout: PROBE_STATEMENT_TIMEOUT },
    })
  } catch (err) {
    /*
     * postgres.js parses the URL in its CONSTRUCTOR and throws `TypeError:
     * Invalid URL` synchronously for one it cannot (measured, with
     * `TOKENSCOPE_APP_DATABASE_URL=not-a-url`). This `try` used to start AFTER
     * the constructor, so that throw escaped the classifier entirely, escaped
     * the top-level `.catch`, and Node exited 1 — which entrypoint.sh boots on.
     * A URL the runtime pools cannot parse either is the most certain broken
     * credential there is.
     */
    return { state: 'malformed', detail: err instanceof Error ? err.message : String(err) }
  }

  try {
    const [who] = await probe<{ me: string }[]>`SELECT current_user::text AS me`
    if (who?.me === APP_DB_ROLE) return { state: 'ok' }
    return { state: 'wrong-role', detail: `it authenticates as '${who?.me ?? 'unknown'}', not '${APP_DB_ROLE}'` }
  } catch (err) {
    const code = pgCode(err)
    const detail = `${err instanceof Error ? err.message : String(err)}${code ? ` [${code}]` : ''}`
    if (!serverAnswered(err)) return { state: 'unreachable', detail }
    if (isAuthFailure(code)) return { state: 'auth-failed', detail }
    if (code === MISSING_DATABASE) return { state: 'no-database', detail }
    return { state: 'server-error', detail }
  } finally {
    await probe.end({ timeout: 5 }).catch(() => undefined)
  }
}

/**
 * What the run had actually DONE when it failed. Reported rather than assumed:
 * "nothing was committed" is exact before the commit and false after it, and the
 * deadline can fire while Postgres is completing the COMMIT — when NEITHER
 * sentence is honest and the only truthful answer is "unknown".
 *
 * `txStarted` is what makes that third state sayable. Without it the deadline
 * printed "Nothing was committed" for a transaction that may well have landed,
 * on the exit code that tells the entrypoint to boot anyway.
 */
const progress = { txStarted: false, committed: false, passwordSet: false }

function progressLine(): string {
  if (progress.committed) {
    return (
      `the transaction COMMITTED before this failure: the role's attributes and its grants are in place. ` +
      (progress.passwordSet
        ? `The role's password WAS set by this run, so '${APP_DB_ROLE}' now holds TOKENSCOPE_APP_DB_PASSWORD.`
        : "The role's password was NOT touched — this step only sets it when it CREATEs the role, or when TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true.")
    )
  }
  if (progress.txStarted) {
    return (
      `the transaction was IN FLIGHT and its OUTCOME IS UNKNOWN — it had not returned, so it may or may not have committed. ` +
      (progress.passwordSet
        ? `If it committed, '${APP_DB_ROLE}' now holds TOKENSCOPE_APP_DB_PASSWORD; if it rolled back, the role's previous password stands. Both are credentials some deployment holds.`
        : "It carried no password statement, so the role's password is what it was either way.")
    )
  }
  return `nothing was committed — every write is in one transaction and it had not started. The role and its grants are exactly as they were before this run.`
}

/**
 * IS BOOT SAFE, GIVEN WHAT THE RUNTIME'S CREDENTIAL TURNED OUT TO BE — written
 * ONCE, because it is asked from three places (the dormant path, the deadline
 * and the ordinary failure path) and three copies is how the recovery texts
 * drifted apart the first time.
 *
 * `null` means "boot anyway". Each abort carries its OWN second half: the lever
 * is always the same, the cause is not, and merging them is what produced advice
 * to rotate a password at an operator whose database name was wrong.
 */
function abortReason(cred: RuntimeCredential): { why: string; recovery: string } | null {
  switch (cred.state) {
    case 'malformed':
      return {
        why:
          `TOKENSCOPE_APP_DATABASE_URL is not a usable connection URL (${cred.detail}). ` +
          'The runtime pools parse it with the same driver, so every one of them would fail to start.',
        recovery: `${RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE} the database-url-app Key Vault secret is not a connection URL at all — re-apply infra.yml with writeAppDbPassword=true, which is what builds it.`,
      }
    case 'auth-failed':
      return {
        why:
          `the server REFUSED the credential in TOKENSCOPE_APP_DATABASE_URL (${cred.detail}) — SQLSTATE class 28, which is the server saying it considered the identity and rejected it. ` +
          'The runtime pools are configured to connect as a role this credential does not open, so booting would serve 500s from a deploy that reported healthy.',
        recovery: `${RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE} ${FIX_THE_CREDENTIAL}`,
      }
    case 'no-database':
      return {
        why:
          `TOKENSCOPE_APP_DATABASE_URL names a database that does not exist (${cred.detail}). ` +
          'That is not an authentication failure and no credential change can repair it, but every runtime pool fails for as long as that URL is in use.',
        recovery: `${RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE} the DATABASE NAME in the database-url-app secret is wrong — rebuild it with an infra.yml apply (writeAppDbPassword=true) and compare it with the database-url secret. Do NOT roll the role's password: 3D000 is not about the credential.`,
      }
    case 'wrong-role':
      return {
        why:
          `TOKENSCOPE_APP_DATABASE_URL does not authenticate as the app role (${cred.detail}). ` +
          'The runtime would connect as something other than the non-owner role, so the policies would not execute as the cutover claims.',
        recovery: `${RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE} ${FIX_THE_CREDENTIAL}`,
      }
    case 'unreachable':
    case 'server-error':
    case 'ok':
    case 'absent':
      return null
  }
}

/** The non-abort half: what the probe saw, said only as far as it was measured. */
function describeCredential(cred: RuntimeCredential): string {
  switch (cred.state) {
    case 'ok':
      return `it authenticates as '${APP_DB_ROLE}'.`
    case 'absent':
      return 'TOKENSCOPE_APP_DATABASE_URL is not set, so there was nothing to probe.'
    case 'unreachable':
      /*
       * SAY ONLY WHAT WAS MEASURED. The probe never got an answer from the host
       * in that URL, so there is NO evidence about the credential — which is the
       * whole point of separating this from an authentication failure. An
       * earlier draft went on to assert "DATABASE_URL could not reach it
       * either", which this run did not test and which is false whenever the two
       * URLs name different hosts.
       */
      return (
        `it could NOT BE TESTED: nothing answered at that host (${cred.detail}). The server never replied, so this is not evidence the credential is wrong and boot is not aborted on it. ` +
        'Look at DNS, the private endpoint, the firewall, TLS, whether the server is up — and at whether that URL names the host you meant. ' +
        'If the fault persists the revision fails its readiness probe and Container Apps keeps the previous revision, so continuing costs nothing; if it was a blip, the app serves.'
      )
    case 'server-error':
      return (
        `the server answered, but not about identity (${cred.detail}). A SQLSTATE outside class 28 says nothing about whether the credential is right — '53300 too many connections for role' is the one that really happens — and it is usually transient, so boot is not aborted on it. ` +
        'If it persists the revision fails its readiness probe and Container Apps keeps the previous revision.'
      )
    // The abort states never reach here: abortReason() has already exited.
    case 'malformed':
    case 'auth-failed':
    case 'no-database':
    case 'wrong-role':
      return `it is BROKEN (${cred.detail}).`
  }
}

/**
 * DORMANT, BUT NOT BLIND.
 *
 * `useAppRoleAtRuntime=true` with `provisionAppRole=false` is a combination
 * `infra/main.bicep` permits, and it used to be silent: "dormant", exit 0, Nitro
 * starts on a credential the database rejects, `/api/health` 503s (it pings
 * through `getDb()`, which prefers `TOKENSCOPE_APP_DATABASE_URL`), and the
 * targeted recovery below is never printed.
 *
 * THE CHECK BELONGS TO THE CREDENTIAL, NOT TO THE FLAG. Forbidding the
 * combination in Bicep instead would (a) add another way for a flag to narrow
 * silently to a no-op, which this template already has too many of, and (b) not
 * cover the cases that actually reach this state — the role dropped, or the
 * Key Vault secret drifted, with `provisionAppRole` firmly on. Since the check
 * must exist anyway, coupling the flags buys nothing.
 *
 * TRUE dormancy survives where it matters: no opt-in AND no
 * `TOKENSCOPE_APP_DATABASE_URL` — which is every environment today — reads
 * nothing and writes nothing.
 */
async function dormantCredentialCheck(): Promise<void> {
  if (!process.env.TOKENSCOPE_APP_DATABASE_URL?.trim()) {
    console.warn(
      `${TAG} dormant — set TOKENSCOPE_PROVISION_APP_ROLE=true (with TOKENSCOPE_APP_DB_PASSWORD) to provision the '${APP_DB_ROLE}' role. Nothing was read or written.`,
    )
    return
  }
  const cred = await classifyRuntimeCredential()
  const abort = abortReason(cred)
  if (abort) {
    console.error(
      `${TAG} dormant (TOKENSCOPE_PROVISION_APP_ROLE is not 'true'), BUT the runtime is pointed at the app role and ${abort.why} Nothing was written — this path only probes. Aborting instead of booting into 503s.\n${abort.recovery}`,
    )
    process.exit(EXIT_UNSAFE_TO_BOOT)
  }
  console.warn(
    `${TAG} dormant — provisioning was not requested. Nothing was written. The runtime IS pointed at '${APP_DB_ROLE}' (TOKENSCOPE_APP_DATABASE_URL is set), so that credential was probed: ${describeCredential(
      cred,
    )}`,
  )
}

async function main(): Promise<void> {
  const optedIn = process.env.TOKENSCOPE_PROVISION_APP_ROLE === 'true'
  const password = process.env.TOKENSCOPE_APP_DB_PASSWORD ?? ''
  const rotate = process.env.TOKENSCOPE_ROTATE_APP_DB_PASSWORD === 'true'

  if (!optedIn) {
    await dormantCredentialCheck()
    return
  }

  // An EXPLICIT opt-in with no password is a broken deployment, not dormancy.
  // Exiting 0 here meant the app booted with no role while the operator who set
  // the flag believed they had enabled one — and exiting 1 was barely better,
  // because entrypoint.sh boots on a 1. The exit code is resolved in the catch
  // below, which asks whether the RUNTIME's credential actually works.
  if (password.trim() === '') {
    throw new Error(
      `${TAG} TOKENSCOPE_PROVISION_APP_ROLE=true but TOKENSCOPE_APP_DB_PASSWORD is ${
        process.env.TOKENSCOPE_APP_DB_PASSWORD === undefined ? 'not set' : 'empty'
      }. Provisioning was REQUESTED and cannot proceed: the '${APP_DB_ROLE}' role needs a password. ` +
        'Set the app-db-password Key Vault secret (infra.yml with writeAppDbPassword=true) or unset the flag.',
    )
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      `${TAG} TOKENSCOPE_PROVISION_APP_ROLE=true but DATABASE_URL is not set — nothing to provision against`,
    )
  }

  assertSafeIdentifier(APP_DB_ROLE, 'app role')
  for (const table of RLS_BOOTSTRAP_TABLE_NAMES) assertSafeIdentifier(table, 'bootstrap table')

  if (rotate) {
    console.warn(
      `${TAG} TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true — an EXISTING role's password will be set to TOKENSCOPE_APP_DB_PASSWORD. ` +
        'This is the only path that does that. Turn it back off after this boot: left on, every restart is a rotation, and a restart that rotates can take the credential out from under a replica that is already serving.',
    )
  }

  /*
   * THE DEADLINE, AS A RACE — not a `process.exit` inside a timer callback.
   *
   * The old shape exited straight out of the timer, which skipped the `finally`
   * below AND the exit path at the bottom of this file, so a deadline could
   * never produce exit 3 no matter how broken the runtime's credential was — on
   * exactly the run that had least idea what state it had left behind. Its own
   * comment claimed "the run classifies itself first", and it did not.
   *
   * Losing the race REJECTS. Everything after that is the ordinary failure path:
   * the progress line, then {@link classifyRuntimeCredential}, then one exit
   * code. `run()` may still be in flight when we exit; that is fine and it is the
   * point — a step that has overrun cannot be waited for.
   */
  let deadline: NodeJS.Timeout | undefined
  const budget = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      reject(
        new Error(
          `${TAG} BUDGET EXCEEDED: provisioning did not finish within ${
            PROVISION_BUDGET_MS / 1000
          }s and was stopped so it could exit with a code entrypoint.sh understands, rather than being SIGKILLed by the platform's start probe.`,
        ),
      )
    }, PROVISION_BUDGET_MS)
  })
  try {
    await Promise.race([provisionRun(url, password, rotate), budget])
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

async function provisionRun(url: string, password: string, rotate: boolean): Promise<void> {
  // max: 2 — one connection is RESERVED to hold the session advisory lock, and
  // the transaction needs the other. A session lock cannot ride the pool: it
  // belongs to one backend, and postgres.js is free to hand the next query to a
  // different one. connect_timeout, because this now opens a SECOND connection
  // and boot must fail rather than hang if the server will not give it one.
  // statement_timeout as a startup parameter bounds the pre-mutation catalog
  // reads and the verification reads, which are otherwise the only unbounded
  // waits left outside the transaction.
  const sql = createDbClient(url, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { statement_timeout: POOL_STATEMENT_TIMEOUT },
  })
  let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined
  try {
    /*
     * ── SERIALISE REPLICAS ────────────────────────────────────────────────
     * A session-level advisory lock held across the transaction AND the
     * verification, so a second replica cannot interleave with this one's
     * read-back. MEASURED on PG 16.13: `lock_timeout` bounds
     * `pg_advisory_lock`, so the wait needs no polling loop and boot cannot
     * hang on a peer.
     */
    lock = await sql.reserve()
    await lock.unsafe(`SET lock_timeout = '${LOCK_WAIT}'`)
    // …and lift THIS connection's statement bound above the lock wait, or the
    // pool's `statement_timeout` cancels the wait first and the message below
    // reports a wait that never happened. See LOCK_WAIT_STATEMENT_TIMEOUT.
    await lock.unsafe(`SET statement_timeout = '${LOCK_WAIT_STATEMENT_TIMEOUT}'`)
    try {
      await lock`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
    } catch (err) {
      throw new Error(
        `${TAG} another replica holds the provisioning lock and did not release it within ${LOCK_WAIT}${
          pgCode(err) ? ` [SQLSTATE ${pgCode(err)}]` : ''
        }. Nothing was read or written; the next boot retries.`,
        { cause: err },
      )
    }
    // Put the ordinary bound back for everything this connection does after the
    // wait — it is a pooled connection and the unlock rides it too.
    await lock.unsafe(`SET statement_timeout = '${POOL_STATEMENT_TIMEOUT}'`)

    const cap = await resolveProvisionBasis(sql)
    // BEFORE anything is written: a role that can reach a table owner cannot be
    // fixed by this script (see assertNoOwnerPrivileges), so refuse now rather
    // than after committing. The check does not exclude a SUPERUSER app role,
    // which used to slip past it and be caught only after the commit.
    await assertNoOwnerPrivileges(sql, 'refusing to provision')
    const verifier = scramSha256Verifier(password)
    // Everything or nothing: a failure inside here leaves the role and the
    // grants exactly as they were.
    const report = await commitProvisioning(sql, { verifier, cap, rotate })
    /*
     * EVERYTHING PAST THE COMMIT IS INSIDE THIS GUARD, reportProvisioning
     * included. It used to sit outside, so a throw while FORMATTING the report
     * was reported as "the transaction was rolled back" — a false statement
     * about a database that had already been changed.
     */
    try {
      progress.committed = true
      progress.txStarted = false
      progress.passwordSet = report.passwordSet
      reportProvisioning(report)
      await verify(sql, url, password, report)
    } catch (err) {
      throw new Error(`${TAG} the run COMMITTED and then failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  } finally {
    if (lock) {
      await lock`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      lock.release()
    }
    await sql.end({ timeout: 5 })
  }
}

main().catch(async (err: unknown) => {
  // Print the message only. A postgres.js error object can carry the statement
  // it failed on, and one of ours has authentication material in it.
  console.error(err instanceof Error ? err.message : String(err))

  /*
   * WHAT THE DATABASE LOOKS LIKE NOW — stated from what the run actually did,
   * never assumed, and with a THIRD answer for the window the deadline can land
   * in: the transaction issued but not yet returned, where neither "committed"
   * nor "nothing was committed" is a true sentence.
   */
  console.error(`${TAG} ${progressLine()}`)

  /*
   * THE REMAINING QUESTION IS WHETHER BOOT IS SAFE, and it is not about this run
   * at all: it is about whether the runtime is configured to connect as a role
   * whose credential is genuinely broken. {@link abortReason} is the single
   * place that decides, shared with the dormant path.
   */
  const cred = await classifyRuntimeCredential()
  const abort = abortReason(cred)
  if (abort) {
    console.error(`${TAG} AND ${abort.why} Aborting instead.\n${abort.recovery}`)
    process.exit(EXIT_UNSAFE_TO_BOOT)
  }
  if (cred.state === 'ok') {
    console.error(
      `${TAG} TOKENSCOPE_APP_DATABASE_URL still authenticates as '${APP_DB_ROLE}', so the runtime is not stranded. Boot continues; the next boot retries.`,
    )
  } else if (cred.state !== 'absent') {
    console.error(`${TAG} the runtime credential: ${describeCredential(cred)} Boot continues; the next boot retries.`)
  }
  process.exit(1)
})
