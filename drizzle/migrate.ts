// TokenScope migration runner.
//
// Runs all numbered .sql files in drizzle/migrations/ in lexical order
// against $DATABASE_URL. Hand-written migrations (not drizzle-kit-managed)
// because the data model uses PG-native constructs Drizzle's diff doesn't
// render cleanly (EXCLUDE USING gist, RLS policies, custom triggers).
//
// Records applied migrations in `_drizzle_migrations(name TEXT PRIMARY KEY,
// applied_at TIMESTAMPTZ)` so re-runs skip already-applied steps.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDbClient } from './connect'
import { RLS_PROVISION_LOCK_CLASS, MIGRATE_LOCK_KEY } from '../scripts/rls-roles'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

// Every replica runs this at boot, so they serialise on an advisory lock. A
// replica that cannot get it in LOCK_WAIT exits non-zero and the next boot
// retries. lock_timeout bounds pg_advisory_lock (measured, see
// provision-app-role.ts LOCK_WAIT).
const LOCK_WAIT = '120s'
// Bounds each migration's wait for a table lock, so DDL queued behind a long
// query on the serving revision fails the boot instead of blocking that
// revision's traffic behind its ACCESS EXCLUSIVE request.
const MIGRATION_LOCK_TIMEOUT = '5s'
// A lock timeout is retried, so one slow reader on the serving revision does
// not fail the boot. Worst case ~45s, inside the other replicas' LOCK_WAIT.
const MIGRATION_LOCK_ATTEMPTS = 6
const LOCK_NOT_AVAILABLE = '55P03'

function isLockTimeout(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  // max: 1 — the advisory lock belongs to one backend session.
  const sql = createDbClient(url, { max: 1, idle_timeout: 5 })
  let locked = false
  try {
    await sql.unsafe(`SET lock_timeout = '${LOCK_WAIT}'`)
    await sql`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int)`
    locked = true

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _drizzle_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const applied = new Set(
      (await sql`SELECT name FROM _drizzle_migrations`).map((r) => r.name as string),
    )

    let appliedCount = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      console.warn(`Applying ${file}...`)
      for (let attempt = 1; ; attempt += 1) {
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`)
            await tx.unsafe(body)
            await tx`INSERT INTO _drizzle_migrations (name) VALUES (${file})`
          })
          break
        } catch (err) {
          if (!isLockTimeout(err) || attempt >= MIGRATION_LOCK_ATTEMPTS) throw err
          console.warn(`${file}: lock timeout, retry ${attempt}/${MIGRATION_LOCK_ATTEMPTS - 1}`)
          await new Promise((r) => setTimeout(r, attempt * 1000 + Math.random() * 500))
        }
      }
      appliedCount += 1
    }

    console.warn(
      appliedCount
        ? `Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}.`
        : 'All migrations already applied.',
    )
  } finally {
    if (locked) {
      await sql`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${MIGRATE_LOCK_KEY}::int)`.catch(() => undefined)
    }
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
