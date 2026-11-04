/*
 * drizzle/provision-app-role.ts, run as the entrypoint runs it.
 *
 * WHY A CHILD PROCESS AND NOT AN IMPORTED FUNCTION. The thing that has to be
 * true of this script is a CONTRACT WITH `entrypoint.sh`: `node
 * node_modules/.bin/tsx drizzle/provision-app-role.ts` must exit 0 and touch
 * nothing when the opt-in variable is absent, because that is what every deploy
 * will do until somebody deliberately opts in — and it must exit 3, not 1, when
 * the runtime's own credential is broken, because that is the code the
 * entrypoint aborts boot on. An imported function cannot certify any of that: it
 * skips the env gate, the exit code and the logging, which is the entire surface
 * the entrypoint sees. So every case below spawns the real command line with a
 * controlled environment.
 *
 * THE CUTOVER SWEEP IS NOT HERE ANY MORE. It is `drizzle/cutover-rls-sweep.ts`
 * and `tests/integration/db/cutover-rls-sweep.test.ts`, because its TRIGGER was
 * wrong three adversarial rounds running while it was a side effect of this
 * step. This file's job is now exactly one thing: the ROLE. It asserts that
 * provisioning leaves RLS posture untouched; what the posture SHOULD be is the
 * other file's question.
 *
 * The properties this file exists to hold:
 *   1. DORMANT ONLY WHEN NOBODY ASKED. No opt-in → nothing created, nothing
 *      changed, exit 0. Opt-in WITHOUT a password → exit non-zero, named — and
 *      exit 3, not 1, when the runtime is already pointed at the role.
 *   1b. DORMANT IS NOT BLIND. With `TOKENSCOPE_APP_DATABASE_URL` set — the
 *      `useAppRoleAtRuntime` + no-`provisionAppRole` combination Bicep permits —
 *      a broken runtime credential is still exit 3, not a silent boot into 503s.
 *   2. CORRECT. Opt-in → a non-owner LOGIN role that can really read and write,
 *      including into tables that did not exist when it was granted.
 *   2b. AND IT NEVER TOUCHES RLS. Not on any path, not for any ledger state.
 *   3. WRITES THE API LANE. `provider_usage_fact` is written by the
 *      provider-transform worker, which authenticates as this very role.
 *   4. CONVERGED. A role that already exists carrying SUPERUSER / BYPASSRLS /
 *      INHERIT is brought to the promised posture, not trusted — and one that
 *      can REACH a table owner by a grant shape Postgres HONOURS is refused
 *      BEFORE anything is written, while one that holds a grant Postgres does
 *      NOT honour is provisioned normally.
 *   5. THE PASSWORD IS SET ONCE, WHEN THE ROLE IS CREATED. A later boot never
 *      moves it. `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` is the only path that
 *      does, and it is off by default.
 *   6. ATOMIC, AND SERIALISED. A failure part-way leaves the password and the
 *      grants exactly as they were, and two replicas cannot interleave.
 *   7. BOUNDED. The deadline really fires mid-run, and when it does the run goes
 *      through the SAME credential classifier and exit path as any other
 *      failure — it used to `process.exit` straight out of the timer.
 *   8. QUIET. The password never appears in the output — and never reaches the
 *      server either.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  RLS_APP_ROLE as APP_DB_ROLE,
  RLS_BOOTSTRAP_TABLE_NAMES,
  RLS_PROVISION_LOCK_CLASS,
  RLS_PROVISION_LOCK_KEY,
} from '../../../scripts/rls-roles'

const REPO_ROOT = resolve(__dirname, '../../..')

/*
 * NEEDS A PRISTINE CLUSTER — skipped under TEST_PG_URL, run on CI.
 *
 * Postgres roles are CLUSTER-global, not per-database. A testcontainer gives
 * this file a cluster nobody has touched, and every case below starts from
 * "`tokenscope_app` is ABSENT" (dormant runs must leave it absent; refusals
 * must not half-provision; the first opt-in must CREATE it). On a shared
 * TEST_PG_URL server (the devcontainer's local Postgres) the role survives the
 * first run — with whatever password and posture that run left it — and every
 * later run fails at those assertions, correctly. The per-file throwaway
 * DATABASE the helper provisions cannot isolate this. The suffixed fixture
 * roles further down are the part of the problem that CAN be isolated; the
 * fixed name `tokenscope_app` is the part that cannot.
 *
 * Do not "fix" this by dropping the role in beforeAll: a leaked role is
 * evidence a previous run was killed mid-transaction, and the drop would hide
 * it. CI's testcontainers job keeps full coverage of this file.
 */
const ON_SHARED_CLUSTER = Boolean(process.env.TEST_PG_URL)

/*
 * Walk up for `node_modules/.bin/tsx`: a git worktree has no node_modules of its
 * own and resolves against the checkout it was branched from. Hardcoding
 * `${REPO_ROOT}/node_modules/.bin/tsx` made every case in this file fail with
 * MODULE_NOT_FOUND — including the ones asserting a non-zero exit, which passed
 * for the wrong reason. Same walk as rls-posture-probe.test.ts.
 */
function resolveTsx(): string {
  for (let dir = REPO_ROOT; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules/.bin/tsx')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error('tsx not found — entrypoint.sh runs the script with it')
  }
}
const TSX_BIN = resolveTsx()

/*
 * Deliberately awkward passwords: a quote and a backslash exercise Postgres'
 * `%L` quoting (it renders an E'' literal), and `@ # /` exercise the URL
 * encoding on the way back in. A password that is only [a-z0-9] would let both
 * bugs through.
 */
const PW_FIRST = "9a1e-p@ss'w\\ord-one"
const PW_ROTATED = '9a1e-second#pw/two'
/** Only ever used by the password-observability case; unique so a log grep is unambiguous. */
const PW_LOGGED = '9a1e-cleartext-canary-7f3d'
const PW_SETROLE = '9a1e-set-role#pw'

// Real uuids (v4 nibbles) — a convenient 0000-…-0001 is rejected by z.uuid()
// elsewhere in this codebase, so the fixtures here keep the same shape.
const TEAMMATE_ID = '9a1e0000-0000-4000-8000-000000000101'
const OWNER_GRANT_ID = '9a1e0000-0000-4000-8000-000000000102'

/** Role names are CLUSTER-wide and TEST_PG_URL shares one — suffix the fixtures. */
const sfx = randomUUID().replace(/-/g, '').slice(0, 10)
const SETROLE_ADMIN = `prov_admin_${sfx}`
const SETROLE_OWNER = `prov_owner_${sfx}`
const PLAIN_CREATEROLE = `prov_plain_${sfx}`
const FIXTURE_PW = 'fixture-pw'

let t: TestDb
let postureBefore: Map<string, boolean>
let tableOwner = ''
let accessHash = ''

interface RunResult {
  code: number
  out: string
}

/** Spawn the script exactly as entrypoint.sh does, with a controlled env. */
function runProvision(env: Record<string, string>): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    execFile(
      process.execPath,
      [TSX_BIN, 'drizzle/provision-app-role.ts'],
      {
        cwd: REPO_ROOT,
        // NOT process.env: an ambient DATABASE_URL or opt-in flag would make
        // these cases lie in either direction.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as { code?: number | string }).code : 0
        done({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

/** `relrowsecurity` for every ordinary table in public, keyed by name. */
async function rlsPosture(): Promise<Map<string, boolean>> {
  const rows = await t.client<{ relname: string; enabled: boolean }[]>`
    SELECT c.relname, c.relrowsecurity AS enabled
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `
  return new Map(rows.map((r) => [r.relname, r.enabled]))
}

interface AppRoleRow {
  canlogin: boolean
  issuper: boolean
  bypassrls: boolean
  inherits: boolean
}

async function appRoleRow(): Promise<AppRoleRow | undefined> {
  const [row] = await t.client<AppRoleRow[]>`
    SELECT rolcanlogin AS canlogin, rolsuper AS issuper,
           rolbypassrls AS bypassrls, rolinherit AS inherits
      FROM pg_roles WHERE rolname = ${APP_DB_ROLE}
  `
  return row
}

/** The app-role URL, built the way the script builds it. */
function appUrl(password: string): string {
  const u = new URL(t.url)
  u.username = encodeURIComponent(APP_DB_ROLE)
  u.password = encodeURIComponent(password)
  return u.toString()
}

/** A URL for an arbitrary fixture role on the same server. */
function roleUrl(role: string, password: string): string {
  const u = new URL(t.url)
  u.username = encodeURIComponent(role)
  u.password = encodeURIComponent(password)
  return u.toString()
}

/** A context-less connection AS the app role — no RLS GUCs, like a cold request. */
function appClient(password: string): postgres.Sql {
  return postgres(appUrl(password), { max: 1, idle_timeout: 5, connection: { TimeZone: 'UTC' } })
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'pr-app-role', displayName: 'Provision' })
    .returning()
  const [unit] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'prappRole',
      code: 'default',
      displayName: 'Provision (default)',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  await t.db.insert(schema.teammate).values({
    id: TEAMMATE_ID,
    entraOid: 'oid-provision-app-role',
    email: 'provision@x.test',
    displayName: 'Provision Dev',
    regionId: region!.id,
    orgUnitId: unit!.id,
    role: 'developer',
  })
  // A row in an RLS-ENABLED, non-bootstrap table. It is what proves the created
  // role is genuinely bound by RLS rather than quietly bypassing it — once that
  // table's RLS is put back, which the sweep turns off.
  await t.db.insert(schema.couOwner).values({
    id: OWNER_GRANT_ID,
    orgUnitId: unit!.id,
    teammateId: TEAMMATE_ID,
  })

  const [client] = await t.db
    .insert(schema.oauthClient)
    .values({
      clientSecretHash: 'csh-provision',
      clientName: 'provision',
      redirectUris: ['http://127.0.0.1:7777/callback'],
    })
    .returning()
  accessHash = 'provision-access-hash'
  const now = Date.now()
  await t.db.insert(schema.oauthToken).values({
    accessTokenHash: accessHash,
    refreshTokenHash: 'provision-refresh-hash',
    clientId: client!.clientId,
    teammateId: TEAMMATE_ID,
    scope: 'tokenscope.emit',
    accessIssuedAt: new Date(now),
    accessExpiresAt: new Date(now + 3_600_000),
    refreshIssuedAt: new Date(now),
    refreshExpiresAt: new Date(now + 86_400_000),
  })

  postureBefore = await rlsPosture()
  const [owner] = await t.client<{ owner: string }[]>`
    SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'teammate'
  `
  tableOwner = owner!.owner
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe.skipIf(ON_SHARED_CLUSTER)('dormant only when nobody asked — all four combinations', () => {
  // These run FIRST and assert the role does not exist. They are the reason the
  // change can be merged and deployed while the measurement it depends on is
  // still being built.
  it('the migrations left every bootstrap table RLS-ENABLED (otherwise the cases below prove nothing)', () => {
    for (const table of RLS_BOOTSTRAP_TABLE_NAMES) {
      expect(postureBefore.get(table), `${table} should start RLS-enabled`).toBe(true)
    }
  })

  const dormantCases: Array<[string, Record<string, string>]> = [
    ['neither variable', {}],
    ['the password alone', { TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST }],
    [
      'the flag set to something other than true',
      { TOKENSCOPE_PROVISION_APP_ROLE: '1', TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST },
    ],
  ]

  it.each(dormantCases)('with %s it exits 0, says so, and touches nothing', async (_label, env) => {
    const r = await runProvision({ DATABASE_URL: t.url, ...env })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('dormant')
    expect(await appRoleRow()).toBeUndefined()
    expect(await rlsPosture()).toEqual(postureBefore)
  })

  /*
   * THE FOURTH COMBINATION, and the one that used to lie. An explicit opt-in
   * with no password logged "dormant" and exited 0, so the app booted with no
   * role while the operator who set the flag believed they had enabled one — a
   * successful deploy that silently did not do the thing it was asked to do.
   */
  const loudCases: Array<[string, Record<string, string>]> = [
    ['the flag alone (password not set)', { TOKENSCOPE_PROVISION_APP_ROLE: 'true' }],
    ['the flag with an EMPTY password', { TOKENSCOPE_PROVISION_APP_ROLE: 'true', TOKENSCOPE_APP_DB_PASSWORD: '' }],
    [
      'the flag with a whitespace-only password',
      { TOKENSCOPE_PROVISION_APP_ROLE: 'true', TOKENSCOPE_APP_DB_PASSWORD: '   ' },
    ],
  ]

  it.each(loudCases)('with %s it FAILS loudly and names the cause', async (_label, env) => {
    const r = await runProvision({ DATABASE_URL: t.url, ...env })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('TOKENSCOPE_APP_DB_PASSWORD')
    expect(r.out).not.toContain('dormant')
    expect(await appRoleRow(), 'a refusal must not half-provision').toBeUndefined()
    expect(await rlsPosture()).toEqual(postureBefore)
  })

  it('opted in with no DATABASE_URL it fails loudly instead of pretending', async () => {
    const r = await runProvision({
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('DATABASE_URL')
    expect(await appRoleRow()).toBeUndefined()
  })
})

/** The output of the ONE run that creates the role. */
let createRunOut = ''

describe.skipIf(ON_SHARED_CLUSTER)('opted in: it creates the role, and changes nothing else', () => {
  it('creates a NON-SUPERUSER login role and reports what it did', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
    })
    createRunOut = r.out
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`role '${APP_DB_ROLE}' created`)
    expect(r.out).toContain('verified')

    const role = await appRoleRow()
    expect(role?.canlogin).toBe(true)
    // A superuser bypasses RLS unconditionally — enforcement would be inert.
    expect(role?.issuper).toBe(false)
    expect(role?.bypassrls).toBe(false)
    expect(role?.inherits).toBe(false)
  })

  /*
   * ── THE WHOLE POINT OF THE SPLIT, AS ONE ASSERTION ────────────────────────
   *
   * The cutover DISABLE sweep used to run from here, and its trigger was wrong
   * three adversarial rounds running: on every boot (which undid design §7 phase
   * 2 at the next restart), only when this boot created the role (which could
   * never fire past an environment's first boot), then on a version ledger that
   * could authorise reverting a phase and stamp the result as done.
   *
   * Provisioning does not sweep. Not on the create path, not on the update path,
   * not for any ledger state. THE POSTURE IT FOUND IS THE POSTURE IT LEAVES, and
   * that is what makes the fourth recurrence impossible rather than merely
   * unlikely.
   */
  it('leaves EVERY table’s RLS posture exactly as it found it — the create path', async () => {
    expect(await rlsPosture(), 'creating a role is not a cutover').toEqual(postureBefore)
    // Non-vacuity: the fixture really does start with RLS-enabled tables, so
    // "unchanged" is a claim about something.
    const enabled = [...postureBefore].filter(([, on]) => on).map(([name]) => name)
    expect(enabled.length, 'a database with no RLS-enabled tables would pass this vacuously').toBeGreaterThan(5)
    expect(enabled).toContain('inbox_item')
    for (const table of RLS_BOOTSTRAP_TABLE_NAMES) expect(enabled).toContain(table)
  })

  it('…and the update path leaves it alone too, ledger or no ledger', async () => {
    // A stale sweep stamp under the OLD key must not resurrect the behaviour
    // either — the ledger moved to the sweep script with the sweep.
    await t.client`
      INSERT INTO seed_state (name, version, applied_at) VALUES ('rls-app-role', 0, now())
      ON CONFLICT (name) DO UPDATE SET version = 0
    `
    const before = await rlsPosture()
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`role '${APP_DB_ROLE}' updated`)
    expect(await rlsPosture()).toEqual(before)
    await t.client`DELETE FROM seed_state WHERE name = 'rls-app-role'`
  })

  /*
   * IT STILL REPORTS THE POSTURE, and that report must not be an assertion.
   * Making it fatal would turn design §7 phase 2 — which deliberately re-ENABLEs
   * org_unit, teammate and instance_attestation — into an un-bootable image, and
   * nobody on this project has the database access to break that loop.
   */
  it('reports the posture it found, as a note, and still exits 0', () => {
    expect(createRunOut).toContain('RLS posture NOTE (reported, not enforced')
    expect(createRunOut, 'the bootstrap tables are still enabled here, and that is worth saying').toContain(
      'oauth_token',
    )
    expect(createRunOut, 'and it names the flag that would fix it').toContain('TOKENSCOPE_RLS_CUTOVER_SWEEP')
    expect(createRunOut).toContain('verified')
  })

  it('says the password was SET because the role was created, not "rotated"', () => {
    expect(createRunOut).toContain('password set (the role was created by this run)')
  })

  it('never prints the password', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
    })
    expect(r.out).not.toContain(PW_FIRST)
    expect(r.out).not.toContain(encodeURIComponent(PW_FIRST))
  })
})


describe.skipIf(ON_SHARED_CLUSTER)('the role it creates actually works', () => {
  /*
   * THESE CASES NEED RLS OFF ON THE TABLES THEY READ, AND PROVISIONING NO LONGER
   * TURNS IT OFF. In production that is `drizzle/cutover-rls-sweep.ts`, proven
   * end to end in `tests/integration/db/cutover-rls-sweep.test.ts` — including
   * the pre-identity bearer read this used to piggy-back on. Here the posture is
   * a FIXTURE, arranged explicitly, so a change in what the sweep decides cannot
   * quietly turn a role test green or red.
   */
  const NEEDS_RLS_OFF = ['oauth_token', 'teammate', 'org_unit', 'audit_event', 'cou_owner']
  beforeAll(async () => {
    for (const table of NEEDS_RLS_OFF) {
      await t.client.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    }
  })
  afterAll(async () => {
    for (const table of NEEDS_RLS_OFF) {
      await t.client.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).catch(() => undefined)
    }
  })

  it('is a genuine non-owner: it can log in, and it does NOT own the tables', async () => {
    const app = appClient(PW_FIRST)
    try {
      const [who] = await app<{ me: string; owner: string; su: boolean }[]>`
        SELECT current_user::text AS me,
               (SELECT tableowner FROM pg_tables WHERE tablename = 'oauth_token') AS owner,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su
      `
      expect(who!.me).toBe(APP_DB_ROLE)
      expect(who!.owner).not.toBe(APP_DB_ROLE)
      expect(who!.su).toBe(false)
    } finally {
      await app.end({ timeout: 5 })
    }
  })

  it('runs the pre-identity paths with no RLS context (once the sweep has run)', async () => {
    const app = appClient(PW_FIRST)
    try {
      // The bearer bootstrap read (oauth_token ⋈ teammate ⋈ org_unit).
      const bearer = await app<{ teammate_id: string; org_path: string }[]>`
        SELECT tok.teammate_id::text AS teammate_id, ou.path::text AS org_path
          FROM oauth_token tok
          JOIN teammate tm ON tm.id = tok.teammate_id
          JOIN org_unit ou ON ou.id = tm.org_unit_id
         WHERE tok.access_token_hash = ${accessHash}
         LIMIT 1
      `
      expect(bearer).toHaveLength(1)
      expect(bearer[0]!.teammate_id).toBe(TEAMMATE_ID)

      // The /setup/enroll audit write, which happens before any identity exists.
      await expect(
        app`INSERT INTO audit_event (event_type, payload) VALUES ('provision-probe', '{}'::jsonb)`,
      ).resolves.toBeDefined()
    } finally {
      await app.end({ timeout: 5 })
    }
  })

  it('can append to audit_event but neither update nor delete it', async () => {
    const [priv] = await t.client<{ ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege(${APP_DB_ROLE}, 'audit_event', 'INSERT') AS ins,
             has_table_privilege(${APP_DB_ROLE}, 'audit_event', 'UPDATE') AS upd,
             has_table_privilege(${APP_DB_ROLE}, 'audit_event', 'DELETE') AS del`
    expect(priv).toEqual({ ins: true, upd: false, del: false })
  })

  /*
   * THE API LANE'S WRITER IS THIS ROLE — SO IT MUST BE ABLE TO WRITE.
   *
   * A previous version of the provisioning script ran
   * `REVOKE INSERT, UPDATE, DELETE ON provider_usage_fact FROM tokenscope_app`,
   * reading migration 0118's "REVOKE … FROM <joiner-role>" as though the joiner
   * and the writer were different roles. They are not: `getWorkerDb()`
   * (server/db/worker-db.ts) resolves the same TOKENSCOPE_APP_DATABASE_URL as
   * the request lane, so `server/workers/provider-fact.ts` INSERTs and
   * `server/workers/provider-transform.ts` DELETEs as THIS role. The revoke did
   * not enforce the invariant; it turned the model axis off after cutover.
   *
   * With one runtime role the invariant is not expressible as a grant at all —
   * it needs a second login role or an RLS write policy. This case is what goes
   * red if anyone re-adds the revoke on the strength of 0118's header.
   */
  it('CAN insert, update and delete provider_usage_fact — the provider-transform worker runs as this role', async () => {
    const app = appClient(PW_FIRST)
    try {
      // A COST row: cost_type non-NULL carries cost_usd and no tokens
      // (provider_usage_fact_measure_chk), and actor_ref supplies the identity
      // key (provider_usage_fact_identity_chk).
      const [inserted] = await app<{ id: string }[]>`
        INSERT INTO provider_usage_fact (source, provider, date, tool, model, cost_type, cost_usd, actor_ref)
        VALUES ('prov-app-role-test', 'anthropic', DATE '2026-08-01', 'claude_code', 'sonnet', 'tokens', 1.25, 'provision@x.test')
        RETURNING id::text AS id
      `
      expect(inserted?.id).toBeTruthy()
      const updated = await app`
        UPDATE provider_usage_fact SET cost_usd = 2.50 WHERE id = ${inserted!.id}::uuid RETURNING id
      `
      expect(updated).toHaveLength(1)
      const deleted = await app`
        DELETE FROM provider_usage_fact WHERE id = ${inserted!.id}::uuid RETURNING id
      `
      expect(deleted).toHaveLength(1)
    } finally {
      await app.end({ timeout: 5 })
    }
  })

  it('IS bound by RLS when a table has it enabled — the point of the whole exercise', async () => {
    // The fixture above turned cou_owner's RLS off, so put it back for this one
    // check: with RLS ENABLEd and no GUCs a non-owner sees nothing, while the
    // owner connection sees the row that is really there.
    await t.client.unsafe(`ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY`)
    const app = appClient(PW_FIRST)
    try {
      const asApp = await app`SELECT id FROM cou_owner WHERE id = ${OWNER_GRANT_ID}::uuid`
      const asOwner = await t.client`SELECT id FROM cou_owner WHERE id = ${OWNER_GRANT_ID}::uuid`
      expect(asOwner).toHaveLength(1)
      expect(asApp).toHaveLength(0)
    } finally {
      await app.end({ timeout: 5 })
      await t.client.unsafe(`ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY`)
    }
  })

  it('reaches tables created AFTER it was granted (the ALTER DEFAULT PRIVILEGES half)', async () => {
    // A role that works today and breaks on the next migration is worse than no
    // role: the failure would land at boot, on whoever deployed an unrelated
    // schema change. This is that migration.
    await t.client.unsafe(`
      CREATE TABLE later_migration_table (id bigserial PRIMARY KEY, note text NOT NULL)
    `)
    const app = appClient(PW_FIRST)
    try {
      await expect(app`INSERT INTO later_migration_table (note) VALUES ('written by the app role')`).resolves.toBeDefined()
      const rows = await app<{ note: string }[]>`SELECT note FROM later_migration_table`
      expect(rows).toHaveLength(1)
    } finally {
      await app.end({ timeout: 5 })
      await t.client.unsafe('DROP TABLE later_migration_table')
    }
  })
})

/*
 * THE PASSWORD NEVER REACHES THE SERVER.
 *
 * `ALTER ROLE … PASSWORD '<cleartext>'` puts the password in the statement text,
 * where `pg_stat_activity.query` and `log_statement` can see it. The script
 * pre-computes a SCRAM-SHA-256 verifier instead, which Postgres stores verbatim.
 *
 * The only way to PROVE that is to look at what the server received, so this
 * turns `log_statement = 'all'` on for the duration and reads the container's
 * log. Asserting the stored `rolpassword` is a SCRAM verifier would prove
 * nothing — the server produces exactly that shape when it hashes a cleartext
 * password itself, so the assertion would stay green with the fix reverted.
 *
 * The role already exists by this point, so the run has to be a DELIBERATE
 * ROTATION — a boot no longer moves a password on its own. That is also the only
 * remaining path where an operator's cleartext reaches this code at all.
 */
describe.skipIf(ON_SHARED_CLUSTER)('the cleartext password never reaches the server', () => {
  const canReadLogs = () => Boolean(t.container)

  afterAll(async () => {
    await t.client.unsafe(`ALTER SYSTEM RESET log_statement`).catch(() => undefined)
    await t.client.unsafe(`SELECT pg_reload_conf()`).catch(() => undefined)
  })

  it('sends a SCRAM verifier, not the password — read off the server log', async () => {
    if (!canReadLogs()) {
      // TEST_PG_URL: an external server whose log this process cannot read.
      expect(true).toBe(true)
      return
    }
    await t.client.unsafe(`ALTER SYSTEM SET log_statement = 'all'`)
    await t.client.unsafe(`SELECT pg_reload_conf()`)
    // pg_reload_conf is asynchronous per backend; a fresh connection is
    // guaranteed to pick the new value up.
    const since = Math.floor(Date.now() / 1000) - 1

    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_LOGGED,
      TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
    })
    expect(r.code, r.out).toBe(0)

    const logs = await collectLogs(await t.container!.logs({ since }), 3_000)
    // Non-vacuity: the capture really did see this run's statements.
    expect(logs, 'log capture caught nothing — the assertion below would be vacuous').toContain('ALTER ROLE')
    expect(logs, 'the derived verifier is what rides the statement').toContain('SCRAM-SHA-256$4096:')
    expect(logs, 'the CLEARTEXT password must never reach the server').not.toContain(PW_LOGGED)

    // …and the credential the server ended up with still authenticates.
    const app = appClient(PW_LOGGED)
    try {
      const [who] = await app<{ me: string }[]>`SELECT current_user::text AS me`
      expect(who!.me).toBe(APP_DB_ROLE)
    } finally {
      await app.end({ timeout: 5 })
    }

    await t.client.unsafe(`ALTER SYSTEM RESET log_statement`)
    await t.client.unsafe(`SELECT pg_reload_conf()`)
  }, 60_000)
})

/** Drain a docker log stream for `ms`, then let go of it. */
function collectLogs(stream: Readable, ms: number): Promise<string> {
  return new Promise((done) => {
    let buf = ''
    const finish = (): void => {
      clearTimeout(timer)
      stream.destroy()
      done(buf)
    }
    const timer = setTimeout(finish, ms)
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString()
    })
    stream.on('end', finish)
    stream.on('error', finish)
  })
}

/*
 * ── THE PASSWORD IS SET ONCE, AND A LATER BOOT NEVER MOVES IT ───────────────
 *
 * Every opted-in boot used to re-run `ALTER ROLE … PASSWORD`, and the machinery
 * that made that survivable was most of this script: a login probe whose only
 * job was to skip the rotation, a guard reading the DATABASE's clock to spot a
 * peer that had rotated while we booted, a documented residual about which
 * replica loses, and an exit code for "we moved the password and could not prove
 * the result". All of it existed to make a restart safe at doing something a
 * restart should never do.
 *
 * So the behaviour went, and the machinery with it. The password is set when the
 * role is CREATED. `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` is the only other
 * path, it is off by default, and it is meant to be on for one deliberate boot.
 */
describe.skipIf(ON_SHARED_CLUSTER)('the password is set once, and a later boot never moves it', () => {
  /*
   * The log-statement case above ROTATED the role to PW_LOGGED, so pin the
   * starting credential rather than inheriting it — and pin it the only way
   * there is now, which is itself a small proof that the flag works.
   */
  beforeAll(async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
      TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
    })
    expect(r.code, r.out).toBe(0)
  }, 60_000)

  it('a second run is a clean no-op-shaped success that reports the role as updated', async () => {
    const before = await rlsPosture()
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_FIRST,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`role '${APP_DB_ROLE}' updated`)
    expect(await rlsPosture()).toEqual(before)

    const app = appClient(PW_FIRST)
    try {
      await expect(app`SELECT 1 AS ok`).resolves.toBeDefined()
    } finally {
      await app.end({ timeout: 5 })
    }
  })

  /*
   * THE RULE ITSELF. A replica booting with a DIFFERENT secret from the one the
   * role holds is exactly the rolling-revision case the clock guard was built
   * for: two replicas, two secrets, and whichever wins takes the credential out
   * from under the other. The answer is not to arbitrate — it is not to rotate.
   *
   * The run still SAYS what it found, because a silent divergence between Key
   * Vault and the role is a real thing an operator needs to see.
   */
  it('a run carrying a DIFFERENT password does NOT move it — the live credential survives', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('password untouched')
    expect(r.out, 'and it names the flag that WOULD roll it').toContain('TOKENSCOPE_ROTATE_APP_DB_PASSWORD')

    // The credential a live replica is holding still works…
    const live = appClient(PW_FIRST)
    try {
      const [who] = await live<{ me: string }[]>`SELECT current_user::text AS me`
      expect(who!.me).toBe(APP_DB_ROLE)
    } finally {
      await live.end({ timeout: 5 })
    }
    // …and the one this run was handed was NOT applied.
    const notApplied = appClient(PW_ROTATED)
    try {
      await expect(notApplied`SELECT 1 AS ok`).rejects.toThrow()
    } finally {
      await notApplied.end({ timeout: 5 }).catch(() => undefined)
    }
  })

  /*
   * …AND THE DERIVED-URL PROBE MUST NOT TURN THAT INTO A BOOT FAILURE. With no
   * TOKENSCOPE_APP_DATABASE_URL nothing connects as this role yet, so a probe
   * built from a password the role does not hold is asking about Key Vault
   * drift, not about this run. Reported, exit 0 — making it fatal would abort
   * boot over a credential nothing uses.
   */
  it('reports the drift instead of failing verification on it', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('NOTE (not a failure)')
    expect(r.out).toContain('verified')
  })

  it('rotates it only when TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true — the old one stops working, the new one starts', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
      TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('password ROTATED')
    // A flag left on turns every restart back into a rotation, so the run has to
    // say so where an operator will read it.
    expect(r.out, 'it must tell the operator to turn it back off').toContain('Turn it back off after this boot')

    const fresh = appClient(PW_ROTATED)
    try {
      const [who] = await fresh<{ me: string }[]>`SELECT current_user::text AS me`
      expect(who!.me).toBe(APP_DB_ROLE)
    } finally {
      await fresh.end({ timeout: 5 })
    }

    const stale = appClient(PW_FIRST)
    try {
      await expect(stale`SELECT 1 AS ok`).rejects.toThrow()
    } finally {
      await stale.end({ timeout: 5 }).catch(() => undefined)
    }
  })

  it('refuses to run as the app role itself — migrations must own their objects', async () => {
    const r = await runProvision({
      DATABASE_URL: appUrl(PW_ROTATED),
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('must stay the OWNER')
  })
})

/*
 * ── EXIT 3 — THE CODE THAT EXISTS BECAUSE EXIT 1 BOOTS ──────────────────────
 *
 * A deploy with provisioning AND the runtime cutover both on, and provisioning
 * cannot proceed, used to exit 1: "nothing committed", so "non-fatal", so the
 * container started and reported healthy while `TOKENSCOPE_APP_DATABASE_URL`
 * named a role that was never created.
 *
 * The discriminator is not what provisioning did — it is whether the credential
 * the RUNTIME is configured to use actually works. And "works" has three
 * distinguishable ways of failing, which the first version of this collapsed
 * into one boolean. Each case below is one of them; the failure that triggers
 * the classification is the same in all four (opted in, no password), so the
 * only variable is the runtime URL.
 */
describe.skipIf(ON_SHARED_CLUSTER)('exit 3 is about the RUNTIME credential, and only when it is really broken', () => {
  it('a credential the SERVER REFUSES is exit 3, and names the recovery', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DATABASE_URL: appUrl('9a1e-not-the-password'),
    })
    expect(r.code, r.out).toBe(3)
    expect(r.out).toContain('TOKENSCOPE_APP_DB_PASSWORD')
    expect(r.out, 'the server answered — this is authentication, not connectivity').toContain(
      'the server REFUSED the credential',
    )
    expect(r.out).toContain('28P01')
    expect(r.out, 'and it says WHY that is the auth answer').toContain('SQLSTATE class 28')
    // The lever, because nobody on this project has database access.
    expect(r.out).toContain('useAppRoleAtRuntime = false')
    expect(r.out).toContain('infra/parameters/dev.bicepparam')
  })

  /*
   * ── "THE SERVER ANSWERED" IS NOT AN AUTHENTICATION CLASSIFIER ─────────────
   *
   * The discriminator used to be `severity !== undefined`, i.e. "did the server
   * reply at all". `53300 too many connections for role` is a server reply and
   * says NOTHING about the credential, so a role sitting at its CONNECTION LIMIT
   * aborted the boot and the recovery told the operator to roll a password that
   * could not possibly help. MEASURED on PG 16.13 via `CONNECTION LIMIT 0`:
   * PostgresError, code 53300, severity FATAL.
   */
  it('a 53300 (too many connections) is exit 1, NOT a credential problem', async () => {
    await t.client.unsafe(`ALTER ROLE ${APP_DB_ROLE} CONNECTION LIMIT 0`)
    try {
      // Non-vacuity: the credential itself is the RIGHT one, so anything this
      // case reports about it is a classification error, not a real refusal.
      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DATABASE_URL: appUrl(PW_ROTATED),
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('53300')
      expect(r.out, 'it must say the answer was not about identity').toContain('not about identity')
      expect(r.out, 'rotating a password cannot clear a connection limit').not.toContain('useAppRoleAtRuntime = false')
      expect(r.out).not.toContain('the server REFUSED the credential')
    } finally {
      await t.client.unsafe(`ALTER ROLE ${APP_DB_ROLE} CONNECTION LIMIT -1`)
    }
  })

  /*
   * ── AND `3D000` IS UNSAFE TO BOOT, BUT NOT FOR THE CREDENTIAL REASON ──────
   *
   * The URL names a database that does not exist. Every runtime pool fails for
   * as long as that URL is in use, so booting is genuinely unsafe — but the old
   * single bucket then printed the password-rotation recovery at it. The abort
   * has to be right about the CAUSE as well as the verdict.
   */
  it('a 3D000 (no such database) is exit 3, and the recovery does NOT say "rotate"', async () => {
    const wrongDb = new URL(appUrl(PW_ROTATED))
    wrongDb.pathname = '/no_such_database_9a1e'
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DATABASE_URL: wrongDb.toString(),
    })
    expect(r.code, r.out).toBe(3)
    expect(r.out).toContain('3D000')
    expect(r.out).toContain('names a database that does not exist')
    expect(r.out, 'the lever is still the lever').toContain('useAppRoleAtRuntime = false')
    expect(r.out, 'but the cause is the database NAME').toContain('DATABASE NAME')
    expect(r.out, 'and it must say so explicitly, because the old text did the opposite').toContain(
      "Do NOT roll the role's password",
    )
  })

  /*
   * ── THE MALFORMED URL, WHICH USED TO ESCAPE THE CLASSIFIER ENTIRELY ───────
   *
   * `createDbClient(configured)` sat OUTSIDE the classifier's `try`, and
   * postgres.js parses the URL in its constructor — so `TypeError: Invalid URL`
   * was thrown past the classifier, past the top-level `.catch`, and Node exited
   * 1. entrypoint.sh boots on a 1, so the most certainly-broken credential there
   * is — one the runtime pools cannot even parse — was the one that booted.
   */
  it('a MALFORMED runtime URL is exit 3 too', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DATABASE_URL: 'not-a-url',
    })
    expect(r.code, r.out).toBe(3)
    expect(r.out).toContain('not a usable connection URL')
    expect(r.out).toContain('useAppRoleAtRuntime = false')
  })

  /*
   * ── AND UNREACHABLE IS NOT THE SAME FAULT ─────────────────────────────────
   *
   * DNS, a firewall, a private endpoint, TLS, a server that is down: the probe
   * cannot reach Postgres at all. The old classifier returned `true` for every
   * one of those, so the abort told an operator to switch CREDENTIALS when the
   * probe had gathered no evidence about the credential at all.
   *
   * CONTINUING IS THE DELIBERATE CHOICE, and the message has to carry the reason
   * or it reads as an oversight — the earlier version simply said "boot
   * continues; the next boot retries", which is what the code does, not why it
   * is safe. If the fault persists, every runtime query fails, `/api/health`
   * (which pings through `getDb()`, i.e. the app URL) answers 503, the revision
   * fails its readiness probe and Container Apps keeps the previous revision. If
   * it was a blip that clears before Nitro binds, the app serves. Aborting would
   * buy neither, and it would turn a network blip into a crash loop nobody here
   * has the database access to inspect.
   */
  it('an UNREACHABLE database is exit 1, not 3 — and the message says why that is safe', async () => {
    // A port nothing listens on, on the same host: reachable stack, closed door.
    const dead = new URL(t.url)
    dead.port = '1'
    dead.username = encodeURIComponent(APP_DB_ROLE)
    dead.password = encodeURIComponent(PW_ROTATED)

    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DATABASE_URL: dead.toString(),
    })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('could NOT BE TESTED')
    expect(r.out, 'and it points at the network, not at the credential').toContain('private endpoint')
    expect(r.out, 'the recovery for a credential is the WRONG advice here').not.toContain(
      'useAppRoleAtRuntime = false',
    )
    /*
     * The half that used to be missing: WHY continuing is safe. Without it the
     * comment claimed a decision the message did not explain, and the next
     * reviewer reasonably asks whether exit 1 here is an oversight.
     */
    expect(r.out, 'the consequence of continuing has to be stated, not assumed').toContain('readiness probe')
    expect(r.out).toContain('keeps the previous revision')
  })

  it('…and a WORKING runtime credential is still exit 1 — a blip must not gate a deploy', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DATABASE_URL: appUrl(PW_ROTATED),
    })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('TOKENSCOPE_APP_DB_PASSWORD')
    expect(r.out).toContain('nothing was committed')
    expect(r.out, 'the runtime is fine, so the boot must not be aborted').toContain('still authenticates')
  })
})

/*
 * ── TWO REPLICAS MUST NOT INTERLEAVE ────────────────────────────────────────
 *
 * A session-level advisory lock, held across the transaction AND the read-back.
 * Proven by holding the key from another session and watching the run WAIT for
 * it — not by waiting for its timeout, which would put a minute on the suite.
 *
 * The waiter row in `pg_locks` is what makes this non-vacuous: without it the
 * assertion "the new password has not landed yet" would also pass against a run
 * that had not started, or one that took no lock at all and simply happened to
 * be slow. The run is a deliberate ROTATION for the same reason — it needs a
 * write whose arrival is observable from outside, and an ordinary boot no longer
 * has one.
 *
 * Two replicas racing to CREATE the role is still a real event (that is what the
 * lock is for), even though neither of them will ever rotate the other's
 * password now.
 */
describe.skipIf(ON_SHARED_CLUSTER)('provisioning serialises across replicas', () => {
  it('waits on the advisory lock another replica holds, then completes when it is released', async () => {
    const holder = postgres(t.url, { max: 1, idle_timeout: 5 })
    let run: Promise<RunResult> | undefined
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`

      const newPw = '9a1e-lock-race#pw'
      run = runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: newPw,
        TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
      })

      // NON-VACUITY: wait until the script is provably BLOCKED on our key.
      let waiters = 0
      for (let i = 0; i < 60 && waiters === 0; i++) {
        const [row] = await t.client<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = ${RLS_PROVISION_LOCK_CLASS}
             AND objid = ${RLS_PROVISION_LOCK_KEY} AND NOT granted
        `
        waiters = row?.n ?? 0
        if (waiters === 0) await new Promise((done) => setTimeout(done, 500))
      }
      expect(waiters, 'the run must be WAITING on the provisioning lock, not merely slow').toBeGreaterThan(0)

      // …and while it waits, it has changed nothing.
      const early = appClient(newPw)
      try {
        await expect(early`SELECT 1 AS ok`).rejects.toThrow()
      } finally {
        await early.end({ timeout: 5 }).catch(() => undefined)
      }

      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
      const r = await run
      run = undefined
      expect(r.code, r.out).toBe(0)

      const after = appClient(newPw)
      try {
        const [who] = await after<{ me: string }[]>`SELECT current_user::text AS me`
        expect(who!.me).toBe(APP_DB_ROLE)
      } finally {
        await after.end({ timeout: 5 })
      }

      // Put the password back for the cases that follow.
      const restore = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
        TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
      })
      expect(restore.code, restore.out).toBe(0)
    } finally {
      await holder.end({ timeout: 5 }).catch(() => undefined)
      await run?.catch(() => undefined)
    }
  }, 120_000)

  /*
   * ── AND WHEN THE PEER NEVER LETS GO, THE MESSAGE HAS TO BE TRUE ────────────
   *
   * This one deliberately WAITS OUT the whole lock timeout, which the case above
   * avoids. It is worth the seconds because the sentence it checks was false and
   * nothing could see it: the pool carries a `statement_timeout` and it applies
   * to the lock connection too, so the SHORTER bound wins. Measured on PG 16.13
   * — statement 4s against lock 15s cancels at 4.0s with `57014 canceling
   * statement due to statement timeout` — while the code reported "did not
   * release it within 15s".
   *
   * SQLSTATE is the assertion, because it is the one thing that distinguishes
   * the two: 55P03 means the LOCK wait ran its course, 57014 means the statement
   * bound cut it short and the duration in the message is fiction.
   */
  it('times out on the LOCK, not on the statement bound, and says so with the right SQLSTATE', async () => {
    /*
     * NO `idle_timeout` HERE. An advisory lock is SESSION state, so a holder that
     * lets postgres.js reap its idle connection releases the lock — and the run
     * then sails through and reports success, which is a green for the wrong
     * reason (it happened, and cost 5s of confusion).
     */
    const holder = postgres(t.url, { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
      const started = Date.now()
      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
      })
      const waited = (Date.now() - started) / 1000

      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('another replica holds the provisioning lock')
      expect(r.out, '55P03 = lock_timeout; 57014 would mean the wait was cut short').toContain('SQLSTATE 55P03')
      // …and the duration the message names is one the run actually spent.
      const claimed = Number(r.out.match(/did not release it within (\d+)s/)![1])
      expect(waited, `it claims ${claimed}s, so it must have waited at least that`).toBeGreaterThanOrEqual(claimed)
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 120_000)
})

/*
 * A ROLE THAT ALREADY EXISTS IS CONVERGED, NOT TRUSTED.
 *
 * The quietest way for this whole exercise to be pointless: a `tokenscope_app`
 * created by hand (or by an earlier version of this script) that carries
 * BYPASSRLS, SUPERUSER, INHERIT or membership of the table owner. Provisioning
 * used to set only LOGIN and the password, and verification checked SUPERUSER
 * alone — so a "verified" cutover could leave every policy bypassed.
 *
 * Two outcomes, and the difference is whether the script CAN fix it: the
 * attributes are converged, the owner membership is refused. The second case
 * below measures why.
 */
describe.skipIf(ON_SHARED_CLUSTER)('a pre-existing role is converged to the promised posture', () => {
  it('clears SUPERUSER, BYPASSRLS and INHERIT, and verifies the result', async () => {
    await t.client.unsafe(`ALTER ROLE ${APP_DB_ROLE} SUPERUSER BYPASSRLS INHERIT`)
    // Non-vacuity: the bad posture is really in place before the run.
    expect(await appRoleRow()).toMatchObject({ issuper: true, bypassrls: true, inherits: true })

    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('verified')
    expect(await appRoleRow()).toMatchObject({
      canlogin: true,
      issuper: false,
      bypassrls: false,
      inherits: false,
    })
  })

  /*
   * MEMBERSHIP OF THE OWNER ROLE IS THE ONE `NOINHERIT` DOES NOT CLOSE.
   *
   * MEASURED on PG 16.13, because the obvious assumption is wrong: PG 16 made
   * INHERIT a property of each GRANT, defaulted from the member's `rolinherit`
   * AT GRANT TIME, and `ALTER ROLE … NOINHERIT` does not revisit existing
   * memberships. The assertions below pin the mechanism — `rolinherit` goes
   * false while `pg_auth_members.inherit_option` stays true and
   * `pg_has_role(app, owner, 'USAGE')` stays true, which IS the RLS owner
   * bypass (Postgres decides it with has_privs_of_role()).
   *
   * So the script REFUSES rather than certifying a role it cannot fix — and it
   * refuses BEFORE the transaction, so the password is not rotated on the way
   * to a failure.
   */
  it('REFUSES a role that inherits the table owner — and does so before rotating anything', async () => {
    // The hand-created shape: an INHERIT role granted the owner. PG 16 fixes a
    // membership's INHERIT from the member's `rolinherit` AT GRANT TIME, which
    // is exactly why ALTER ROLE cannot undo it afterwards.
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} INHERIT;
      GRANT ${tableOwner} TO ${APP_DB_ROLE};
    `)
    try {
      const [before] = await t.client<{ inheritopt: boolean; usage: boolean }[]>`
        SELECT m.inherit_option AS inheritopt,
               pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'USAGE') AS usage
          FROM pg_auth_members m
          JOIN pg_roles g ON g.oid = m.roleid
          JOIN pg_roles u ON u.oid = m.member
         WHERE g.rolname = ${tableOwner} AND u.rolname = ${APP_DB_ROLE}
      `
      expect(before!.inheritopt, 'the grant took its INHERIT from rolinherit at grant time').toBe(true)
      expect(before!.usage, 'membership of the owner IS the owner bypass').toBe(true)

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-owner-grant',
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('refusing to provision')
      expect(r.out).toContain('can reach the owner of')
      expect(r.out, 'and by WHICH route, because the fix differs').toContain('by INHERIT')
      expect(r.out, 'it must not claim NOINHERIT would fix this').toContain('NOINHERIT does NOT clear it')

      // The measured mechanism, so the refusal's reason is pinned and not folklore.
      await t.client.unsafe(`ALTER ROLE ${APP_DB_ROLE} NOINHERIT`)
      const [after] = await t.client<{ rolinherit: boolean; inheritopt: boolean; usage: boolean }[]>`
        SELECT u.rolinherit, m.inherit_option AS inheritopt,
               pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'USAGE') AS usage
          FROM pg_auth_members m
          JOIN pg_roles g ON g.oid = m.roleid
          JOIN pg_roles u ON u.oid = m.member
         WHERE g.rolname = ${tableOwner} AND u.rolname = ${APP_DB_ROLE}
      `
      expect(after!.rolinherit, 'the ROLE attribute did change').toBe(false)
      expect(after!.inheritopt, 'the GRANT option did NOT — this is the whole point').toBe(true)
      expect(after!.usage, 'so the owner bypass survives NOINHERIT').toBe(true)

      // Nothing was rotated on the way to the refusal.
      const attempted = appClient('never-committed-owner-grant')
      try {
        await expect(attempted`SELECT 1 AS ok`).rejects.toThrow()
      } finally {
        await attempted.end({ timeout: 5 }).catch(() => undefined)
      }
    } finally {
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${APP_DB_ROLE}`).catch(() => undefined)
    }
  })

  /*
   * ── THE SET-ONLY MEMBERSHIP, WHICH `pg_has_role(…, 'USAGE')` CALLS FALSE ───
   *
   * `GRANT owner TO app WITH INHERIT FALSE, SET TRUE` is a bypass and the check
   * that only asked about `'USAGE'` passed it: the role does not INHERIT the
   * owner's privileges, it simply becomes the owner with one statement.
   *
   * That is the SAME `MEMBER`-vs-`SET` confusion `CREATEROLE_VIA_SET_ROLE_SQL`
   * exists to document, reintroduced in the other direction. So this case does
   * not assert the refusal alone — it first MEASURES the three answers and the
   * bypass itself, so a future edit cannot "simplify" the predicate back.
   */
  it('REFUSES a SET-only member of the table owner — measured as a real bypass first', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} NOINHERIT;
      GRANT ${tableOwner} TO ${APP_DB_ROLE} WITH INHERIT FALSE, SET TRUE;
    `)
    try {
      const [modes] = await t.client<{ member: boolean; usage: boolean; setmode: boolean }[]>`
        SELECT pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'MEMBER') AS member,
               pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'USAGE')  AS usage,
               pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'SET')    AS setmode
      `
      expect(modes!.member, 'it IS a member').toBe(true)
      expect(modes!.usage, 'and USAGE says no — which is why the old check passed it').toBe(false)
      expect(modes!.setmode, 'while SET says yes').toBe(true)

      // THE BYPASS ITSELF, end to end: RLS on, no GUCs. As itself the role sees
      // nothing; one `SET ROLE` later it is the owner and sees the row.
      await t.client.unsafe(`ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY`)
      const app = appClient(PW_ROTATED)
      try {
        const asApp = await app`SELECT id FROM cou_owner WHERE id = ${OWNER_GRANT_ID}::uuid`
        expect(asApp, 'bound by RLS while it is itself').toHaveLength(0)
        await app.unsafe(`SET ROLE ${tableOwner}`)
        const asOwner = await app`SELECT id FROM cou_owner WHERE id = ${OWNER_GRANT_ID}::uuid`
        expect(asOwner, 'and every policy is inert one statement later').toHaveLength(1)
      } finally {
        await app.end({ timeout: 5 }).catch(() => undefined)
        await t.client.unsafe(`ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY`)
      }

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-set-only',
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('refusing to provision')
      expect(r.out).toContain('can reach the owner of')
      expect(r.out, 'and it names the route, which is not INHERIT').toContain('by SET ROLE')

      // Nothing was rotated on the way to the refusal.
      const attempted = appClient('never-committed-set-only')
      try {
        await expect(attempted`SELECT 1 AS ok`).rejects.toThrow()
      } finally {
        await attempted.end({ timeout: 5 }).catch(() => undefined)
      }
    } finally {
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${APP_DB_ROLE}`).catch(() => undefined)
    }
  })

  /*
   * ── AND THE PRE-CHECK MUST BE PRE-MUTATION FOR A SUPERUSER TOO ────────────
   *
   * `pg_has_role` is VACUOUSLY TRUE for a superuser, so the check excluded one —
   * otherwise it would fire on the superuser attribute and pre-empt the
   * convergence that CAN clear it. The consequence was that a pre-existing
   * SUPERUSER `tokenscope_app` skipped the pre-check entirely: provisioning
   * cleared SUPERUSER, ROTATED THE PASSWORD, committed, and only post-commit
   * verification noticed the membership — exit 2, boot aborted, password moved.
   *
   * The recursive `pg_auth_members` walk answers the membership question without
   * asking `pg_has_role` anything, so the refusal lands before the transaction.
   */
  it('REFUSES a SUPERUSER role that is a member of the owner — before rotating, not after committing', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} SUPERUSER;
      GRANT ${tableOwner} TO ${APP_DB_ROLE} WITH INHERIT FALSE, SET TRUE;
    `)
    try {
      // Non-vacuity: pg_has_role cannot see this, so only the walk can.
      const [modes] = await t.client<{ issuper: boolean }[]>`
        SELECT rolsuper AS issuper FROM pg_roles WHERE rolname = ${APP_DB_ROLE}
      `
      expect(modes!.issuper).toBe(true)

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-superuser-grant',
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out, 'PRE-mutation: it must be the refusal, not the verification').toContain('refusing to provision')
      expect(r.out).toContain('can reach the owner of')
      expect(r.out, 'nothing may have been committed').toContain('nothing was committed')
      expect(r.out).not.toContain('PASSWORD WAS CHANGED')

      // The password did NOT move, and the role is exactly as it was.
      const attempted = appClient('never-committed-superuser-grant')
      try {
        await expect(attempted`SELECT 1 AS ok`).rejects.toThrow()
      } finally {
        await attempted.end({ timeout: 5 }).catch(() => undefined)
      }
      expect(await appRoleRow(), 'and SUPERUSER was not cleared either — nothing ran').toMatchObject({
        issuper: true,
      })
    } finally {
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${APP_DB_ROLE}`).catch(() => undefined)
      await t.client.unsafe(`ALTER ROLE ${APP_DB_ROLE} NOSUPERUSER`).catch(() => undefined)
    }
  })

  it('and provisions cleanly again once the grant is gone', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('verified')
  })

  /*
   * ── THE GRANT THAT REACHES NOTHING, AND THE ONE THAT REACHES EVERYTHING ────
   *
   * This check has now been wrong three times in three directions: it asked
   * `pg_has_role(…, 'USAGE')` and missed SET-only members; it was corrected to
   * ask USAGE *or* SET; then a recursive `pg_auth_members` walk was added beside
   * those arms to catch what `pg_has_role` cannot see, and that walk followed
   * EVERY edge regardless of its options — so a grant that can neither inherit,
   * nor SET ROLE, nor re-grant became a refusal to provision.
   *
   * Every shape below was executed end to end against a real RLS-enabled table
   * owned by another role on PostgreSQL 16.13, and each case MEASURES the bypass
   * (or its absence) before asserting what the script does about it. That order
   * matters: an assertion about the predicate proves the predicate; an assertion
   * about a `SELECT` through the grant proves the thing the predicate is for.
   */
  const ATTACK_SQL = `SELECT id FROM cou_owner WHERE id = '${OWNER_GRANT_ID}'::uuid`

  /**
   * Run one statement AS THE APP ROLE and say how many rows came back; -1 when
   * the server refused it.
   *
   * ONE STATEMENT PER CALL, deliberately. `sql.unsafe('a; b')` uses the simple
   * query protocol and returns an ARRAY OF RESULT SETS, so `.length` counts
   * statements rather than rows — an assertion written against it reads "2" for
   * a single row and passes or fails for reasons that have nothing to do with
   * RLS. `SET ROLE` is session state and this pool is `max: 1`, so sequential
   * calls on one handle compose exactly as a session would.
   */
  async function rowsAs(app: postgres.Sql, sql: string): Promise<number> {
    try {
      return (await app.unsafe(sql)).length
    } catch {
      return -1
    }
  }

  /*
   * ── ADMIN OPTION ALONE ────────────────────────────────────────────────────
   *
   * `pg_has_role` says NO on both 'USAGE' and 'SET', and the role reads the
   * estate anyway: it grants itself `SET` and becomes the owner. This is the
   * shape the catalog walk exists for, and the reason it cannot be "simplified"
   * back to the two pg_has_role arms.
   *
   * THE OWNER HERE IS A PURPOSE-BUILT NON-SUPERUSER, and that is load-bearing.
   * MEASURED on PG 16.13: against a SUPERUSER owner the escalating `GRANT` is
   * refused — "Only roles with the SUPERUSER attribute may grant roles with the
   * SUPERUSER attribute" — so a fixture using the default testcontainers user as
   * the owner shows no bypass and the case would certify nothing. Azure's
   * `administratorLogin`, which owns the real tables, is NOT a superuser, so the
   * escalation is available exactly where it matters.
   */
  const DOWNSTREAM_OWNER = `prov_downowner_${sfx}`

  it('REFUSES an ADMIN-OPTION-only member — both pg_has_role arms say no, and it is a bypass anyway', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} NOINHERIT;
      CREATE ROLE ${DOWNSTREAM_OWNER} NOLOGIN NOINHERIT;
      CREATE TABLE admin_only_probe (id int PRIMARY KEY);
      INSERT INTO admin_only_probe VALUES (1);
      ALTER TABLE admin_only_probe OWNER TO ${DOWNSTREAM_OWNER};
      ALTER TABLE admin_only_probe ENABLE ROW LEVEL SECURITY;
      GRANT ${DOWNSTREAM_OWNER} TO ${APP_DB_ROLE} WITH INHERIT FALSE, SET FALSE, ADMIN TRUE;
    `)
    try {
      const [modes] = await t.client<{ usage: boolean; setmode: boolean; issuper: boolean }[]>`
        SELECT pg_has_role(${APP_DB_ROLE}::name, ${DOWNSTREAM_OWNER}::name, 'USAGE') AS usage,
               pg_has_role(${APP_DB_ROLE}::name, ${DOWNSTREAM_OWNER}::name, 'SET')   AS setmode,
               (SELECT rolsuper FROM pg_roles WHERE rolname = ${DOWNSTREAM_OWNER}) AS issuper
      `
      expect(modes!.usage, 'USAGE says no').toBe(false)
      expect(modes!.setmode, 'and so does SET — neither arm can see this').toBe(false)
      expect(modes!.issuper, 'the owner must NOT be a superuser or the escalation is refused').toBe(false)

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-admin-only',
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('refusing to provision')
      expect(r.out).toContain('admin_only_probe')
      expect(r.out, 'and it names the option that makes it reachable').toContain('by ADMIN OPTION')

      /*
       * THE BYPASS ITSELF, end to end — AFTER the refusal, because the
       * escalation permanently adds a second `pg_auth_members` row (grantor =
       * the app role, `set_option` true) that the superuser's `REVOKE SET OPTION
       * FOR` does not touch, and the message would then read "SET ROLE / ADMIN
       * OPTION". Measuring second keeps the assertion above about the shape the
       * fixture actually set up.
       */
      const app = appClient(PW_ROTATED)
      try {
        expect(await rowsAs(app, 'SELECT id FROM admin_only_probe'), 'bound by RLS while it is itself').toBe(0)
        expect(await rowsAs(app, `SET ROLE ${DOWNSTREAM_OWNER}`), 'and it may not SET ROLE directly').toBe(-1)
        expect(
          await rowsAs(app, `GRANT ${DOWNSTREAM_OWNER} TO ${APP_DB_ROLE} WITH SET TRUE`),
          'but ADMIN OPTION lets it grant itself SET',
        ).toBe(0)
        expect(await rowsAs(app, `SET ROLE ${DOWNSTREAM_OWNER}`), 'and then it may become the owner').toBe(0)
        expect(await rowsAs(app, 'SELECT id FROM admin_only_probe'), 'and every policy is inert').toBe(1)
      } finally {
        await app.end({ timeout: 5 }).catch(() => undefined)
      }
    } finally {
      await t.client.unsafe(`DROP TABLE IF EXISTS admin_only_probe`).catch(() => undefined)
      await t.client.unsafe(`REVOKE ${DOWNSTREAM_OWNER} FROM ${APP_DB_ROLE}`).catch(() => undefined)
      await t.client.unsafe(`DROP OWNED BY ${DOWNSTREAM_OWNER}`).catch(() => undefined)
      await t.client.unsafe(`DROP ROLE IF EXISTS ${DOWNSTREAM_OWNER}`).catch(() => undefined)
    }
  })

  /*
   * ── THE OVER-REJECTION, WHICH BLOCKED PROVISIONING OUTRIGHT ───────────────
   *
   * `WITH INHERIT FALSE, SET FALSE, ADMIN FALSE`. The member cannot inherit the
   * role's privileges, cannot become it, and cannot re-grant it. Measured: no
   * bypass by any route. The walk called it one and refused to provision, on a
   * grant an operator may perfectly well have made for some other reason.
   */
  it('PROVISIONS NORMALLY through a grant that can neither inherit, SET ROLE nor re-grant', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} NOINHERIT;
      GRANT ${tableOwner} TO ${APP_DB_ROLE} WITH INHERIT FALSE, SET FALSE, ADMIN FALSE;
    `)
    try {
      // NON-VACUITY: the membership really is there, and pg_has_role's MEMBER —
      // which is what a bare pg_auth_members walk approximates — says yes to it.
      const [modes] = await t.client<{ member: boolean }[]>`
        SELECT pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'MEMBER') AS member
      `
      expect(modes!.member, 'it IS a member — which is exactly why the naive walk refused').toBe(true)

      // MEASURED: no route, by any of the three.
      await t.client.unsafe(`ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY`)
      const app = appClient(PW_ROTATED)
      try {
        expect(await rowsAs(app, ATTACK_SQL), 'no inherited privileges').toBe(0)
        expect(await rowsAs(app, `SET ROLE ${tableOwner}`), 'no SET ROLE').toBe(-1)
        expect(
          await rowsAs(app, `GRANT ${tableOwner} TO ${APP_DB_ROLE} WITH SET TRUE`),
          'and no ADMIN OPTION to escalate with',
        ).toBe(-1)
      } finally {
        await app.end({ timeout: 5 }).catch(() => undefined)
        await t.client.unsafe(`ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY`)
      }

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
      })
      expect(r.code, r.out).toBe(0)
      expect(r.out, 'a grant Postgres does not honour is not a bypass').not.toContain('refusing to provision')
      expect(r.out).toContain('verified')
    } finally {
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${APP_DB_ROLE}`).catch(() => undefined)
    }
  })

  /*
   * ── AND THE TWO CHAINS THAT DECIDE THE SHAPE OF THE WALK ───────────────────
   *
   * app -SET-> mid -INHERIT-> owner IS a bypass and BOTH pg_has_role arms are
   * false for it (measured: USAGE f, SET f, and the owner's row read anyway
   * after one `SET ROLE mid`). app -INHERIT-> mid -SET-> owner is NOT, because
   * inheriting a role's privileges does not lend you its ability to SET ROLE.
   *
   * They are the two ends of the same edge rule, so they are asserted together:
   * a walk that follows every edge gets the second wrong, and a predicate built
   * only from pg_has_role gets the first wrong.
   */
  const MID = `prov_mid_${sfx}`

  it('REFUSES a SET → INHERIT chain, which no pg_has_role arm can see', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} NOINHERIT;
      CREATE ROLE ${MID} NOLOGIN NOINHERIT;
      GRANT ${tableOwner} TO ${MID} WITH INHERIT TRUE, SET FALSE;
      GRANT ${MID} TO ${APP_DB_ROLE} WITH INHERIT FALSE, SET TRUE;
    `)
    try {
      const [modes] = await t.client<{ usage: boolean; setmode: boolean }[]>`
        SELECT pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'USAGE') AS usage,
               pg_has_role(${APP_DB_ROLE}::name, ${tableOwner}::name, 'SET')   AS setmode
      `
      expect(modes!.usage).toBe(false)
      expect(modes!.setmode, 'the chain is invisible to both arms').toBe(false)

      // THE BYPASS ITSELF: one SET ROLE to the middle role, which inherits.
      await t.client.unsafe(`ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY`)
      const app = appClient(PW_ROTATED)
      try {
        expect(await rowsAs(app, ATTACK_SQL), 'bound by RLS while it is itself').toBe(0)
        expect(await rowsAs(app, `SET ROLE ${MID}`), 'it CAN become the middle role').toBe(0)
        expect(await rowsAs(app, ATTACK_SQL), 'and every policy is inert one SET ROLE later').toBe(1)
      } finally {
        await app.end({ timeout: 5 }).catch(() => undefined)
        await t.client.unsafe(`ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY`)
      }

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-chain',
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('refusing to provision')
      expect(r.out).toContain('can reach the owner of')
    } finally {
      await t.client.unsafe(`REVOKE ${MID} FROM ${APP_DB_ROLE}`).catch(() => undefined)
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${MID}`).catch(() => undefined)
      await t.client.unsafe(`DROP ROLE IF EXISTS ${MID}`).catch(() => undefined)
    }
  })

  it('PROVISIONS NORMALLY through an INHERIT → SET chain, the one combination that does not compose', async () => {
    await t.client.unsafe(`
      ALTER ROLE ${APP_DB_ROLE} NOINHERIT;
      CREATE ROLE ${MID} NOLOGIN NOINHERIT;
      GRANT ${tableOwner} TO ${MID} WITH INHERIT FALSE, SET TRUE;
      GRANT ${MID} TO ${APP_DB_ROLE} WITH INHERIT TRUE, SET FALSE;
    `)
    try {
      // MEASURED: no route. Inheriting the middle role's privileges does not
      // give the app role the middle role's ability to SET ROLE.
      await t.client.unsafe(`ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY`)
      const app = appClient(PW_ROTATED)
      try {
        expect(await rowsAs(app, ATTACK_SQL), 'nothing inherited').toBe(0)
        expect(await rowsAs(app, `SET ROLE ${MID}`), 'and it cannot become the middle role').toBe(-1)
        expect(await rowsAs(app, `SET ROLE ${tableOwner}`), 'nor the owner').toBe(-1)
      } finally {
        await app.end({ timeout: 5 }).catch(() => undefined)
        await t.client.unsafe(`ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY`)
      }

      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
      })
      expect(r.code, r.out).toBe(0)
      expect(r.out).not.toContain('refusing to provision')
      expect(r.out).toContain('verified')
    } finally {
      await t.client.unsafe(`REVOKE ${MID} FROM ${APP_DB_ROLE}`).catch(() => undefined)
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${MID}`).catch(() => undefined)
      await t.client.unsafe(`DROP ROLE IF EXISTS ${MID}`).catch(() => undefined)
    }
  })

  /*
   * WHY THE NEGATIVE CLAUSES ARE CONDITIONAL, measured rather than asserted.
   * `ALTER ROLE … NOSUPERUSER` / `NOBYPASSRLS` are refused to a caller that does
   * not itself hold the attribute — EVEN when the clause is a no-op. An
   * unconditional `ALTER ROLE app NOSUPERUSER NOBYPASSRLS` would therefore fail
   * on every instance whose admin is not a superuser, which is the only kind
   * this ever runs on (Azure Flexible Server's administratorLogin). Emitting
   * them only when there is something to clear is what keeps the common path
   * working AND makes the uncommon one loud.
   */
  it('a CREATEROLE-only caller may not state NOSUPERUSER/NOBYPASSRLS at all — the reason they are conditional', async () => {
    await t.client.unsafe(`CREATE ROLE ${PLAIN_CREATEROLE} LOGIN PASSWORD '${FIXTURE_PW}' CREATEROLE NOINHERIT`)
    const caller = postgres(roleUrl(PLAIN_CREATEROLE, FIXTURE_PW), { max: 1, idle_timeout: 5 })
    // The caller CREATEs the target itself, so it holds ADMIN OPTION on it —
    // otherwise every ALTER below is refused for that reason instead and the
    // case would prove something else entirely.
    await caller.unsafe(`CREATE ROLE ${PLAIN_CREATEROLE}_target NOLOGIN`)
    const detailOf = async (ddl: string): Promise<string> => {
      try {
        await caller.unsafe(ddl)
        return ''
      } catch (err) {
        // postgres.js keeps the server's DETAIL beside the primary message; the
        // primary is only "permission denied to alter role" for both cases, so
        // the DETAIL is what distinguishes them.
        const e = err as { message?: string; detail?: string }
        return `${e.message ?? ''} | ${e.detail ?? ''}`
      }
    }
    try {
      expect(await detailOf(`ALTER ROLE ${PLAIN_CREATEROLE}_target NOSUPERUSER`)).toMatch(
        /permission denied to alter role \| Only roles with the SUPERUSER attribute/,
      )
      expect(await detailOf(`ALTER ROLE ${PLAIN_CREATEROLE}_target NOBYPASSRLS`)).toMatch(
        /permission denied to alter role \| Only roles with the BYPASSRLS attribute/,
      )
      // …while the clauses the script always emits are fine.
      expect(await detailOf(`ALTER ROLE ${PLAIN_CREATEROLE}_target WITH LOGIN NOINHERIT`)).toBe('')
    } finally {
      await caller.end({ timeout: 5 }).catch(() => undefined)
      await t.client.unsafe(`
        DROP ROLE IF EXISTS ${PLAIN_CREATEROLE}_target;
        DROP ROLE IF EXISTS ${PLAIN_CREATEROLE};
      `)
    }
  })
})

/**
 * Hold a lock in an open transaction, run something against it, then let go.
 * Returns once the blocker's statement has definitely taken effect, so the run
 * under test cannot slip past it.
 */
async function whileBlocking<T>(lockStatement: string, body: () => Promise<T>): Promise<T> {
  const blocker = postgres(t.url, { max: 1, idle_timeout: 5 })
  try {
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    const taken = new Promise<void>((done) => {
      void blocker
        .begin(async (tx) => {
          await tx.unsafe(lockStatement)
          done()
          await held
        })
        .catch(() => done())
    })
    await taken
    try {
      return await body()
    } finally {
      release()
    }
  } finally {
    await blocker.end({ timeout: 5 }).catch(() => undefined)
  }
}

/*
 * ATOMICITY. Provisioning used to be a sequence of independent statements, so a
 * rotation could change the password and then fail a LATER statement — leaving
 * replicas holding a credential the role no longer has while the app started
 * anyway. It is now one transaction.
 *
 * The failure has to land AFTER the password statement or the case proves
 * nothing, and the sweep's `seed_state` stamp — which is what the previous
 * version of this blocked — is not in this transaction any more. The statement
 * after the password is the first GRANT.
 *
 * MEASURED on PG 16.13 rather than assumed, because a GRANT's locking is not
 * obvious: an uncommitted `GRANT USAGE ON SCHEMA public TO <other role>` in
 * another session BLOCKS ours on a tuple lock (55P03 after lock_timeout), while
 * `GRANT … ON ALL TABLES` takes NO relation lock at all — a `LOCK TABLE … IN
 * ACCESS SHARE MODE` blocker left it completely unblocked (17ms). Blocking the
 * SCHEMA grant is what puts the failure in the right place.
 */
describe.skipIf(ON_SHARED_CLUSTER)('the whole run is one transaction', () => {
  const BLOCKER_ROLE = `prov_grantblock_${sfx}`

  beforeAll(async () => {
    await t.client.unsafe(`CREATE ROLE ${BLOCKER_ROLE} NOLOGIN`)
  })
  afterAll(async () => {
    await t.client.unsafe(`DROP OWNED BY ${BLOCKER_ROLE}`).catch(() => undefined)
    await t.client.unsafe(`DROP ROLE IF EXISTS ${BLOCKER_ROLE}`).catch(() => undefined)
  })

  it('a failure AFTER the password statement rolls the PASSWORD back too', async () => {
    const r = await whileBlocking(`GRANT USAGE ON SCHEMA public TO ${BLOCKER_ROLE}`, () =>
      runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: 'never-committed-9a1e',
        TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
      }),
    )

    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('nothing was committed')
    /*
     * NON-VACUITY: it must have failed on the LOCK, at the grant, not somewhere
     * earlier for an unrelated reason — a run that never reached the password
     * statement would satisfy every assertion below while proving nothing about
     * atomicity.
     */
    expect(r.out, 'the failure must be the lock timeout at the first GRANT').toMatch(/lock timeout/i)

    // THE POINT: the password that the failed run tried to set never took, and
    // the one from before the run still works.
    const attempted = appClient('never-committed-9a1e')
    try {
      await expect(attempted`SELECT 1 AS ok`).rejects.toThrow()
    } finally {
      await attempted.end({ timeout: 5 }).catch(() => undefined)
    }
    const previous = appClient(PW_ROTATED)
    try {
      const [who] = await previous<{ me: string }[]>`SELECT current_user::text AS me`
      expect(who!.me).toBe(APP_DB_ROLE)
    } finally {
      await previous.end({ timeout: 5 })
    }
  }, 90_000)
})

/*
 * ── THE DEADLINE, FIRED FOR REAL ───────────────────────────────────────────
 *
 * `PROVISION_BUDGET_MS` used to `process.exit(1)` from inside its timer
 * callback, which skipped the `finally` AND the exit path — so a deadline could
 * never produce exit 3 however broken the runtime's credential was, on the run
 * with the least idea what it had left behind. Its own comment claimed "the run
 * classifies itself first".
 *
 * Static arithmetic about the constant cannot see any of that, so these cases
 * make the timer actually fire mid-run (`TOKENSCOPE_PROVISION_BUDGET_MS`, the
 * same test seam `PREFLIGHT_TIMEOUT_MS` uses in scripts/preflight.ts) and read
 * what the process did.
 */
describe.skipIf(ON_SHARED_CLUSTER)('the startup deadline fires mid-run and still classifies the credential', () => {
  const SHORT_BUDGET = '2000'

  it('fires while waiting on the provisioning lock, and reports honestly', async () => {
    const holder = postgres(t.url, { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
      const started = Date.now()
      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
        TOKENSCOPE_PROVISION_BUDGET_MS: SHORT_BUDGET,
      })
      const elapsed = Date.now() - started

      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(r.out).toContain('did not finish within 2s')
      /*
       * NON-VACUITY, twice over. The DEADLINE has to be what ended the run, not
       * the 15s lock wait — so the run must be shorter than that wait — and the
       * run must really have been stuck, not merely fast.
       */
      expect(elapsed, 'LOCK_WAIT is 15s; a run that took that long ended on the lock, not the deadline').toBeLessThan(
        12_000,
      )
      expect(r.out, 'the lock wait never completed, so no transaction can have started').toContain(
        'nothing was committed',
      )
      expect(r.out).not.toContain('OUTCOME IS UNKNOWN')
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 60_000)

  /*
   * THE FIX ITSELF: a deadline that lands while the runtime is pointed at a
   * broken credential must still abort the boot. Under the old shape this was
   * exit 1 — boot continues — because the timer exited before the classifier
   * could run.
   */
  it('still reaches the credential classifier, so a deadline can exit 3', async () => {
    const holder = postgres(t.url, { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
      const r = await runProvision({
        DATABASE_URL: t.url,
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
        TOKENSCOPE_APP_DATABASE_URL: appUrl('9a1e-not-the-password'),
        TOKENSCOPE_PROVISION_BUDGET_MS: SHORT_BUDGET,
      })
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(r.code, r.out).toBe(3)
      expect(r.out).toContain('the server REFUSED the credential')
      expect(r.out, 'and the recovery an operator can actually perform').toContain('useAppRoleAtRuntime = false')
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 60_000)

  /*
   * ── AND THE COMMIT WINDOW, WHICH USED TO BE REPORTED AS A CERTAINTY ───────
   *
   * `progress.committed` only goes true once `sql.begin()` RETURNS. A deadline
   * that lands while Postgres is completing the COMMIT therefore saw `false` and
   * printed "Nothing was committed" about a database that may well have been
   * changed — on the exit code that tells the entrypoint to boot anyway.
   *
   * The transaction is stalled at its first GRANT (measured above), so it is
   * provably open and provably not returned when the deadline fires.
   */
  it('says the outcome is UNKNOWN when it fires with the transaction still open', async () => {
    const blockerRole = `prov_deadlineblock_${sfx}`
    await t.client.unsafe(`CREATE ROLE ${blockerRole} NOLOGIN`)
    try {
      const r = await whileBlocking(`GRANT USAGE ON SCHEMA public TO ${blockerRole}`, () =>
        runProvision({
          DATABASE_URL: t.url,
          TOKENSCOPE_PROVISION_APP_ROLE: 'true',
          TOKENSCOPE_APP_DB_PASSWORD: PW_ROTATED,
          TOKENSCOPE_ROTATE_APP_DB_PASSWORD: 'true',
          TOKENSCOPE_PROVISION_BUDGET_MS: SHORT_BUDGET,
        }),
      )
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(r.out, 'the honest answer for the commit window').toContain('OUTCOME IS UNKNOWN')
      expect(r.out, 'claiming this rolled back would be a false statement about the database').not.toContain(
        'nothing was committed',
      )
      // …and it says which way the credential could have gone, because the run
      // carried a rotation.
      expect(r.out).toContain('if it rolled back')
    } finally {
      await t.client.unsafe(`DROP OWNED BY ${blockerRole}`).catch(() => undefined)
      await t.client.unsafe(`DROP ROLE IF EXISTS ${blockerRole}`).catch(() => undefined)
    }
  }, 60_000)
})

/*
 * ── DORMANT IS NOT BLIND ───────────────────────────────────────────────────
 *
 * `useAppRoleAtRuntime=true` with `provisionAppRole=false` is a combination
 * infra/main.bicep permits. It used to log "dormant", exit 0, and let Nitro
 * start on a credential the database rejects — `/api/health` pings through
 * `getDb()`, which prefers TOKENSCOPE_APP_DATABASE_URL, so the revision then
 * 503s with none of the targeted recovery guidance in the log.
 *
 * The check belongs to the CREDENTIAL, not to the flag: the role can be dropped
 * or the secret can drift with provisioning firmly on, so it has to exist
 * anyway, and once it does, coupling the two flags in Bicep buys nothing.
 */
describe.skipIf(ON_SHARED_CLUSTER)('dormant provisioning still refuses to boot on a broken runtime credential', () => {
  it('exit 3 when TOKENSCOPE_APP_DATABASE_URL is set and broken, with no opt-in at all', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_APP_DATABASE_URL: appUrl('9a1e-not-the-password'),
    })
    expect(r.code, r.out).toBe(3)
    expect(r.out, 'it must say it was dormant, or the operator hunts for a provisioning failure').toContain('dormant')
    expect(r.out).toContain('the server REFUSED the credential')
    expect(r.out).toContain('useAppRoleAtRuntime = false')
    expect(r.out, 'nothing may be written on a dormant path').toContain('Nothing was written')
  })

  it('exit 0, and says what it probed, when that credential works', async () => {
    const r = await runProvision({
      DATABASE_URL: t.url,
      TOKENSCOPE_APP_DATABASE_URL: appUrl(PW_ROTATED),
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('dormant')
    expect(r.out).toContain(`it authenticates as '${APP_DB_ROLE}'`)
  })

  it('and with no runtime URL it is still a pure no-op — the state every environment is in', async () => {
    const before = await rlsPosture()
    const r = await runProvision({ DATABASE_URL: t.url })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Nothing was read or written')
    expect(await rlsPosture()).toEqual(before)
  })
})

/*
 * The other half of the change: a provisioned role nothing connects with is not
 * a feature. These import the REAL pools — `getDb()` and `getWorkerDb()` — with
 * the env set both ways, because the resolver having the right `if` in it says
 * nothing about whether the pools call it.
 */
describe.skipIf(ON_SHARED_CLUSTER)('the runtime pools take the app role only when it is configured', () => {
  const saved = { db: process.env.DATABASE_URL, app: process.env.TOKENSCOPE_APP_DATABASE_URL }

  afterAll(() => {
    if (saved.db === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved.db
    if (saved.app === undefined) delete process.env.TOKENSCOPE_APP_DATABASE_URL
    else process.env.TOKENSCOPE_APP_DATABASE_URL = saved.app
  })

  it('the request pool (getDb) connects as the app role when the URL is set, and as the owner when it is not', async () => {
    process.env.DATABASE_URL = t.url
    process.env.TOKENSCOPE_APP_DATABASE_URL = appUrl(PW_ROTATED)
    vi.resetModules()
    const withApp = (await import('../../../server/db/index')).getDb()
    try {
      const [row] = await withApp.execute<{ me: string }>(sql`SELECT current_user::text AS me`)
      expect(row!.me).toBe(APP_DB_ROLE)
    } finally {
      await withApp.$client.end({ timeout: 5 })
    }

    // The rollback: one variable unset, and it is the owner again.
    delete process.env.TOKENSCOPE_APP_DATABASE_URL
    vi.resetModules()
    const withOwner = (await import('../../../server/db/index')).getDb()
    try {
      const [row] = await withOwner.execute<{ me: string }>(sql`SELECT current_user::text AS me`)
      expect(row!.me).not.toBe(APP_DB_ROLE)
    } finally {
      await withOwner.$client.end({ timeout: 5 })
    }
  })

  it('the worker pool (getWorkerDb) does the same AND keeps its lane identity', async () => {
    process.env.DATABASE_URL = t.url
    process.env.TOKENSCOPE_APP_DATABASE_URL = appUrl(PW_ROTATED)
    vi.resetModules()
    const worker = await (await import('../../../server/db/worker-db')).getWorkerDb()
    try {
      // The credential changed; the `options=-c app.user_role=…` startup
      // parameter and the UTC pin must survive it — the readback assertion in
      // getWorkerDb() would have thrown before this line if they had not.
      const [row] = await worker.execute<{ me: string; role: string; tz: string }>(sql`
        SELECT current_user::text AS me,
               current_setting('app.user_role', true) AS role,
               current_setting('TimeZone') AS tz
      `)
      expect(row!.me).toBe(APP_DB_ROLE)
      expect(row!.role).toBe('global-finops')
      expect(row!.tz).toBe('UTC')
    } finally {
      await worker.$client.end({ timeout: 5 })
    }

    delete process.env.TOKENSCOPE_APP_DATABASE_URL
    vi.resetModules()
    const owner = await (await import('../../../server/db/worker-db')).getWorkerDb()
    try {
      const [row] = await owner.execute<{ me: string }>(sql`SELECT current_user::text AS me`)
      expect(row!.me).not.toBe(APP_DB_ROLE)
    } finally {
      await owner.$client.end({ timeout: 5 })
    }
  })
})

/*
 * ── PROVISIONING WHERE `CREATEROLE` IS ONLY REACHABLE THROUGH `SET ROLE` ─────
 *
 * THE AZURE SHAPE, and the one the probe already reported while provisioning
 * could not do it. Postgres does NOT inherit role ATTRIBUTES through
 * membership — "you must actually SET ROLE to a specific role having such an
 * attribute in order to make use of the attribute" — so an `administratorLogin`
 * whose `CREATEROLE` comes from `azure_pg_admin` cannot `CREATE ROLE` directly.
 * `scripts/preflight-rls.ts` has always reported `provisionBasis: 'set-role'`
 * for exactly that connection; this script ran `CREATE ROLE` as `current_user`
 * regardless, so diagnostics said yes and provisioning failed.
 *
 * The fixture reproduces it precisely:
 *   - a login role with NEITHER superuser NOR createrole,
 *   - membership of a CREATEROLE role it MAY `SET ROLE` to,
 *   - and the table owner's OBJECT privileges by inheritance (`WITH INHERIT
 *     TRUE, SET FALSE`), because the grants and the RLS sweep run as the owner
 *     after `RESET ROLE` — SET ROLE replaces the privilege set rather than
 *     adding to it, so leaving it on would silently grant nothing.
 *
 * It runs last: it drops and re-creates the app role so the assumed CREATEROLE
 * role holds ADMIN OPTION on it, which is what a non-superuser needs to ALTER it.
 */
describe.skipIf(ON_SHARED_CLUSTER)('provisioning agrees with the probe: SET ROLE when that is the only route', () => {
  afterAll(async () => {
    // Roles are CLUSTER-wide, so on a shared TEST_PG_URL server a leaked
    // fixture role outlives the per-suite database. DROP OWNED BY first —
    // a role that has granted anything cannot be dropped while those grants
    // still name it as grantor.
    for (const stmt of [
      `DROP OWNED BY ${APP_DB_ROLE}`,
      `DROP ROLE IF EXISTS ${APP_DB_ROLE}`,
      `DROP OWNED BY ${SETROLE_OWNER}`,
      `REVOKE ${tableOwner} FROM ${SETROLE_OWNER}`,
      `DROP ROLE IF EXISTS ${SETROLE_OWNER}`,
      `DROP OWNED BY ${SETROLE_ADMIN}`,
      `DROP ROLE IF EXISTS ${SETROLE_ADMIN}`,
    ]) {
      await t.client.unsafe(stmt).catch(() => undefined)
    }
  })

  it('SET ROLEs for the role DDL, RESETs for the grants, and comes out verified', async () => {
    await t.client.unsafe(`
      DROP OWNED BY ${APP_DB_ROLE};
      DROP ROLE IF EXISTS ${APP_DB_ROLE};
      CREATE ROLE ${SETROLE_ADMIN} NOLOGIN CREATEROLE;
      CREATE ROLE ${SETROLE_OWNER} LOGIN PASSWORD '${FIXTURE_PW}' NOINHERIT;
      GRANT ${SETROLE_ADMIN} TO ${SETROLE_OWNER};
      GRANT ${tableOwner} TO ${SETROLE_OWNER} WITH INHERIT TRUE, SET FALSE;
      GRANT USAGE, CREATE ON SCHEMA public TO ${SETROLE_OWNER} WITH GRANT OPTION;
    `)

    // Non-vacuity: the fixture connection really cannot create a role itself.
    const asOwner = postgres(roleUrl(SETROLE_OWNER, FIXTURE_PW), { max: 1, idle_timeout: 5 })
    try {
      const [attrs] = await asOwner<{ issuper: boolean; cancreate: boolean }[]>`
        SELECT rolsuper AS issuper, rolcreaterole AS cancreate FROM pg_roles WHERE rolname = current_user
      `
      expect(attrs).toMatchObject({ issuper: false, cancreate: false })
      await expect(asOwner.unsafe(`CREATE ROLE ${SETROLE_ADMIN}_nope NOLOGIN`)).rejects.toThrow(
        /permission denied to create role/,
      )
    } finally {
      await asOwner.end({ timeout: 5 }).catch(() => undefined)
    }

    const r = await runProvision({
      DATABASE_URL: roleUrl(SETROLE_OWNER, FIXTURE_PW),
      TOKENSCOPE_PROVISION_APP_ROLE: 'true',
      TOKENSCOPE_APP_DB_PASSWORD: PW_SETROLE,
    })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`basis: set-role via ${SETROLE_ADMIN}`)
    expect(r.out).toContain('verified')

    const app = appClient(PW_SETROLE)
    try {
      const [who] = await app<{ me: string }[]>`SELECT current_user::text AS me`
      expect(who!.me).toBe(APP_DB_ROLE)
      // The grants landed — which is what proves RESET ROLE happened before them.
      await expect(app`SELECT count(*) FROM teammate`).resolves.toBeDefined()
    } finally {
      await app.end({ timeout: 5 })
    }
  }, 120_000)

  it('a connection with no route to CREATEROLE at all fails with a named cause, not a raw permission error', async () => {
    const noRoute = `prov_noroute_${sfx}`
    await t.client.unsafe(`
      CREATE ROLE ${noRoute} LOGIN PASSWORD '${FIXTURE_PW}' NOINHERIT;
      GRANT ${tableOwner} TO ${noRoute} WITH INHERIT TRUE, SET FALSE;
    `)
    try {
      const r = await runProvision({
        DATABASE_URL: roleUrl(noRoute, FIXTURE_PW),
        TOKENSCOPE_PROVISION_APP_ROLE: 'true',
        TOKENSCOPE_APP_DB_PASSWORD: PW_SETROLE,
      })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('cannot create roles')
      expect(r.out).toContain('SET ROLE')
    } finally {
      await t.client.unsafe(`REVOKE ${tableOwner} FROM ${noRoute}; DROP ROLE IF EXISTS ${noRoute};`)
    }
  })
})
