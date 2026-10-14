/*
 * Integration-test DB helper — testcontainers-backed Postgres.
 *
 * Per AGENTS.md anti-pattern §"Never mock Drizzle — use a real test DB
 * via testcontainers". Without TEST_PG_URL each test file spins up its own
 * container and runs migrations once. Slow but honest.
 *
 * Container image is `postgres:16` so the test environment matches prod
 * (data-model.md is PG-16-specific).
 *
 * TEST_PG_URL: point every suite at one PG-16 server with ltree/pgcrypto/
 * btree_gist available (CI's Postgres service, a devcontainer's local server).
 * Each suite still gets its own throwaway database, but the CLUSTER is shared:
 * roles, server settings and advisory locks are visible across suites, so a
 * cluster-global fixture needs a unique name or the pristine job. The
 * migration replay happens ONCE per server and migration set: the
 * first suite migrates a template database (named by a hash of the migration
 * files, so editing a migration builds a fresh one) and every suite copies it
 * with CREATE DATABASE ... TEMPLATE: the same schema, without replaying the
 * migrations for every suite.
 *
 * Suites that need a PRISTINE CLUSTER (cluster-global roles) skip themselves
 * under TEST_PG_URL and run in CI's separate testcontainers job.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Wait } from 'testcontainers'
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../../../drizzle/schema'
import { WORKER_RLS_STARTUP_OPTIONS } from '../../../server/db/worker-db'
import { createDbClient } from '../../../drizzle/connect'
import { closeDispatchLockPool } from '../../../server/workers/dispatch-lock'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
)

export interface TestDb {
  /** null when running against an external server (TEST_PG_URL). */
  container: StartedPostgreSqlContainer | null
  client: ReturnType<typeof postgres>
  db: PostgresJsDatabase<typeof schema>
  url: string
  /** External-server teardown (drops the per-suite database). */
  teardown?: () => Promise<void>
}

async function runMigrations(client: ReturnType<typeof postgres>): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await client.unsafe(body)
  }
}

/*
 * PRODUCTION'S CONNECTION CONFIG, and the suite now runs it.
 *
 * `server/db/index.ts` pins `connection: { TimeZone: 'UTC' }` on the pool that
 * serves every request and every in-process worker. That single line is what
 * holds ~23 bare `timestamptz::date` day-bucket casts correct
 * (`clock-rot-audit.md` §A) — they are LATENT, not broken, and the fix is this
 * pin plus a test, not 23 query rewrites.
 *
 * These helpers omitted it, so 237 integration tests ran a connection
 * configuration production does not use. Two consequences, both bad: the suite
 * could not catch a session-TZ bug, and DELETING THE PRODUCTION PIN TURNED ZERO
 * TESTS RED. `tests/integration/db/utc-pin.test.ts` closes the second half;
 * this closes the first.
 *
 * `postgres.js` sends `connection:` keys as wire-protocol STARTUP PARAMETERS, so
 * this applies to every physical connection the pool opens, reconnects included.
 *
 * ── AND THE WORKER LANE'S RLS IDENTITY ──────────────────────────────────────
 * `t.db` is the handle every worker integration test hands to `runXxx(t.db)`, so
 * it is a worker-handle mint site (docs/design/rls-enforcement.md §2, site 7)
 * and carries the lane's `app.user_role=global-finops` GUC — imported from
 * `server/db/worker-db.ts`, never re-spelled here, so the suite cannot certify
 * an identity production does not use.
 *
 * This does NOT weaken the RLS tests. They connect as a separate NON-OWNER role
 * with its own client (`rls.test.ts`, `aggregate-rollup.test.ts`), and
 * `withRlsContext`'s `SET LOCAL` still narrows a connection carrying a
 * connection-level default — measured, design §1.
 */
const PROD_CONNECTION = {
  TimeZone: 'UTC',
  options: WORKER_RLS_STARTUP_OPTIONS,
} as const

/** A hash of every migration file's name and content: the template's identity. */
async function migrationsHash(): Promise<string> {
  const h = createHash('sha256')
  for (const f of (await readdir(MIGRATIONS_DIR)).filter((x) => x.endsWith('.sql')).sort()) {
    h.update(f).update('\0').update(await readFile(join(MIGRATIONS_DIR, f))).update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

/* Serialises template creation and copies across every vitest worker sharing
 * the server: CREATE DATABASE ... TEMPLATE needs the template idle. */
const TEMPLATE_LOCK_KEY = 7_424_001

/** Ensure the migrated template for this migration set exists; return its name. */
async function ensureTemplate(external: string, admin: ReturnType<typeof postgres>): Promise<string> {
  const name = `tokenscope_tmpl_${await migrationsHash()}`
  if (!/^tokenscope_tmpl_[0-9a-f]{12}$/.test(name)) throw new Error(`template name escaped its shape: ${name}`)
  // A killed build leaves its temporary database behind; we hold the lock, so
  // any that exist now are orphans.
  const orphans = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname ~ '^tokenscope_tmpl_[0-9a-f]{12}_b[0-9a-f]{6}$'`
  for (const o of orphans) await admin.unsafe(`DROP DATABASE IF EXISTS ${o.datname} WITH (FORCE)`)
  const [found] = await admin<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS ok`
  if (found?.ok) return name
  // Build under a temporary name and rename when complete, so a crashed build
  // never leaves a half-migrated template that later suites would copy.
  const building = `${name}_b${randomUUID().replace(/-/g, '').slice(0, 6)}`
  await admin.unsafe(`CREATE DATABASE ${building}`)
  let built = false
  try {
    const u = new URL(external)
    u.pathname = `/${building}`
    const c = createDbClient(u.toString(), { max: 1, idle_timeout: 5, connection: PROD_CONNECTION })
    try {
      await runMigrations(c)
    } finally {
      await c.end({ timeout: 5 })
    }
    await admin.unsafe(`ALTER DATABASE ${building} RENAME TO ${name}`)
    built = true
  } finally {
    if (!built) await admin.unsafe(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`)
  }
  return name
}

export async function startTestDb(): Promise<TestDb> {
  const external = process.env.TEST_PG_URL
  if (external) {
    const dbName = `tokenscope_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    // dbName is self-generated hex, but it is interpolated into unsafe() DDL
    // (CREATE/DROP DATABASE cannot be parameterised) — pin the shape so a
    // future edit to the generation can't turn this into identifier injection.
    if (!/^tokenscope_test_[0-9a-f]{12}$/.test(dbName)) {
      throw new Error(`test db name escaped its expected shape: ${dbName}`)
    }
    const admin = postgres(external, { max: 1 })
    try {
      // One session-level advisory lock around build-or-find and the copy: the
      // copy needs the template idle, and only one worker should ever build it.
      await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY})`
      try {
        const template = await ensureTemplate(external, admin)
        await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE ${template}`)
      } finally {
        await admin`SELECT pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`
      }
    } finally {
      await admin.end({ timeout: 5 })
    }
    let u: URL
    try {
      u = new URL(external)
    } catch {
      throw new Error(`TEST_PG_URL is not a valid URL: ${external}`)
    }
    u.pathname = `/${dbName}`
    const url = u.toString()
    const client = createDbClient(url, { max: 4, idle_timeout: 5, connection: PROD_CONNECTION })
    const db = drizzle(client, { schema })
    return {
      container: null,
      client,
      db,
      url,
      teardown: async () => {
        const adm = postgres(external, { max: 1 })
        try {
          await adm.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
        } finally {
          await adm.end({ timeout: 5 })
        }
      },
    }
  }

  // Disable Ryuk — rootless podman in the cw worker can't bind-mount the
  // docker socket into Ryuk's container (statfs perm denied). Our afterAll
  // hooks own teardown explicitly, so the reaper isn't load-bearing here.
  // RYUK IS DISABLED — and that makes container cleanup entirely dependent on
  // stopTestDb() running in afterAll. Ryuk is testcontainers' reaper sidecar; it
  // needs to bind-mount the container runtime socket, which does not work in this
  // rootless-podman setup. The consequence to know about: if a test process is
  // KILLED (SIGKILL, a killed CI step, `pkill -f vitest`), afterAll never runs and
  // the postgres container LEAKS. One interrupted mutation-sweep left 100 orphans
  // saturating the host's podman healthchecks. Reap with:
  //     npm run test:reap
  // (tools/mutation-sweep.mjs reaps automatically between mutations.)
  if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'
  }

  // Two paths:
  //   1. cw worker (CW_NETWORK set + the worker owns host ports 3451-3455):
  //      attach to the cw network, use container DNS, log-message wait.
  //   2. anywhere else (GitHub Actions, plain docker): default host-port
  //      mapping + HostPortWaitStrategy.
  const cwNetwork = process.env.CW_NETWORK
  const usingCw = Boolean(cwNetwork) && cwNetwork !== 'bridge'

  let builder = new PostgreSqlContainer('postgres:16')
    .withDatabase('tokenscope_test')
    .withUsername('tokenscope')
    .withPassword('tokenscope')
    /*
     * AUTO-REMOVE IS THE ONLY CLEANUP THAT SURVIVES SIGKILL.
     *
     * Ryuk is disabled above (rootless podman cannot bind-mount the socket into
     * it), so cleanup otherwise depends entirely on stopTestDb() in afterAll —
     * and afterAll does not run when the process is SIGKILLed. That is not a
     * hypothetical: on 2026-08-02 five parallel agents ran full suites, the host
     * ran out of memory, the OOM killer SIGKILLed vitest, and 17 postgres
     * containers leaked (three of them Exited(137) — killed mid-run). The leak
     * then held the memory that caused the next kill, and the host's window
     * manager went down with it.
     *
     * withAutoRemove puts removal in the DAEMON's hands: the container is torn
     * down when it exits, whatever happened to the process that started it. Our
     * explicit teardown still runs on the happy path and still drops the DB.
     */
    .withAutoRemove(true)

  // OWNERSHIP LABEL. With Ryuk disabled (above), orphan cleanup is manual — and a
  // cleaner that reaps by the generic org.testcontainers label cannot tell OUR
  // container from one another CW on this shared host started a second ago. Stamp
  // the owning session so a reaper can scope precisely to what it created.
  // tools/mutation-sweep.mjs sets TOKENSCOPE_TEST_SESSION and reaps only that value.
  // ALWAYS label, not only when a sweep set the env var. The generic
  // `org.testcontainers=true` label cannot distinguish OUR container from one
  // another CW started on this shared host a second ago, so a reaper scoped to it
  // is a cross-project kill. `tokenscope.test=true` is ours and only ours;
  // `tokenscope.test-session` narrows further to one run.
  const sessionLabel = process.env.TOKENSCOPE_TEST_SESSION ?? `pid-${process.pid}`
  builder = builder.withLabels({
    'tokenscope.test': 'true',
    'tokenscope.test-session': sessionLabel,
  })

  if (usingCw) {
    builder = builder
      .withNetworkMode(cwNetwork!)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  }

  const container = await builder.start()

  let url: string
  if (usingCw) {
    const containerName = container.getName().replace(/^\//, '')
    url = `postgresql://tokenscope:tokenscope@${containerName}:5432/tokenscope_test`
  } else {
    url = container.getConnectionUri()
  }
  const client = createDbClient(url, { max: 4, idle_timeout: 5, connection: PROD_CONNECTION })
  const db = drizzle(client, { schema })

  await runMigrations(client)

  return { container, client, db, url }
}

export async function stopTestDb(t: TestDb): Promise<void> {
  // The dispatch lock opens a sibling pool on first use (server/workers/
  // dispatch-lock.ts); close it before the parent so vitest has no open handle.
  await closeDispatchLockPool(t.db)
  await t.client.end({ timeout: 5 })
  if (t.container) await t.container.stop()
  if (t.teardown) await t.teardown()
}
