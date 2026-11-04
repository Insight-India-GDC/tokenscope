// @vitest-environment node
/*
 * drizzle/migrate.ts runs on every replica at boot. Two replicas booting
 * together must not both apply the same migration (the loser used to abort its
 * boot on a duplicate), and a migration whose DDL queues behind a long query on
 * the serving revision must give up instead of holding an ACCESS EXCLUSIVE
 * request that blocks that revision's traffic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

const ROOT = resolve(__dirname, '../../..')
const DB_NAME = 'tokenscope_migrate_lock'
const REWRITTEN_VIEW_MIGRATION = '0159_quarantine_conversation_key.sql'

let t: TestDb
let url = ''

function runMigrate(timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/.bin/tsx'), 'drizzle/migrate.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
    })
    let out = ''
    child.stdout.on('data', (b) => (out += String(b)))
    child.stderr.on('data', (b) => (out += String(b)))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, out, timedOut })
    })
  })
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`CREATE DATABASE ${DB_NAME}`)
  const u = new URL(t.url)
  u.pathname = `/${DB_NAME}`
  url = u.toString()
}, 180_000)

afterAll(async () => {
  if (t) {
    await t.client.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined)
    await stopTestDb(t)
  }
}, 60_000)

describe('migrate.ts across replicas', () => {
  it('two runs against a fresh database both succeed and record each migration once', async () => {
    const [a, b] = await Promise.all([runMigrate(170_000), runMigrate(170_000)])
    expect(a.code, a.out).toBe(0)
    expect(b.code, b.out).toBe(0)
    const db = postgres(url, { max: 1 })
    try {
      const dupes = await db`SELECT name FROM _drizzle_migrations GROUP BY name HAVING COUNT(*) > 1`
      expect(dupes).toHaveLength(0)
      const [row] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM _drizzle_migrations WHERE name = ${REWRITTEN_VIEW_MIGRATION}`
      expect(row!.n).toBe(1)
    } finally {
      await db.end({ timeout: 5 })
    }
  }, 180_000)

  it('a migration whose DDL waits on a lock held by a live query gives up after its retries instead of hanging', async () => {
    const db = postgres(url, { max: 2 })
    try {
      await db`DELETE FROM _drizzle_migrations WHERE name = ${REWRITTEN_VIEW_MIGRATION}`
      const reader = await db.reserve()
      try {
        // A long-running read on the serving revision: holds ACCESS SHARE on the
        // view that migration rewrites (CREATE OR REPLACE VIEW needs ACCESS EXCLUSIVE).
        await reader`BEGIN`
        await reader`SELECT 1 FROM v_complete_usage LIMIT 0`
        const started = Date.now()
        const run = await runMigrate(90_000)
        expect(run.timedOut, 'migrate hung behind the lock').toBe(false)
        expect(run.code).not.toBe(0)
        expect(run.out).toMatch(/retry 5\/5/)
        expect(run.out).toMatch(/lock timeout/)
        expect(Date.now() - started).toBeLessThan(80_000)
      } finally {
        await reader`ROLLBACK`.catch(() => undefined)
        reader.release()
      }
      const [row] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM _drizzle_migrations WHERE name = ${REWRITTEN_VIEW_MIGRATION}`
      expect(row!.n, 'the failed migration rolled back and stays pending').toBe(0)
    } finally {
      await db.end({ timeout: 5 })
    }
  }, 120_000)

  it('a migration blocked by a reader that finishes within the retries is applied', async () => {
    const db = postgres(url, { max: 2 })
    try {
      await db`DELETE FROM _drizzle_migrations WHERE name = ${REWRITTEN_VIEW_MIGRATION}`
      const reader = await db.reserve()
      await reader`BEGIN`
      await reader`SELECT 1 FROM v_complete_usage LIMIT 0`
      const release = setTimeout(() => {
        void reader`ROLLBACK`.finally(() => reader.release())
      }, 8_000)
      const run = await runMigrate(90_000)
      clearTimeout(release)
      expect(run.code, run.out).toBe(0)
      expect(run.out).toMatch(/lock timeout, retry 1\//)
      const [row] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM _drizzle_migrations WHERE name = ${REWRITTEN_VIEW_MIGRATION}`
      expect(row!.n).toBe(1)
    } finally {
      await db.end({ timeout: 5 })
    }
  }, 120_000)
})
