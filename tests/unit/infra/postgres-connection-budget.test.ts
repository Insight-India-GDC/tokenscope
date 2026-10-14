/*
 * The Postgres connection budget (docs/design/scaling-to-1000-users.md 0.4).
 *
 * Every replica can hold its request pool, its worker pool and its
 * dispatch-lock pool at once (the lock pool is per replica: both dispatch
 * surfaces lock through the one worker-lane client). So for every parameter
 * file that manages max_connections:
 *
 *   maxReplicas × (request pool + worker pool + DISPATCH_LOCK_POOL_MAX) + 15 ≤ postgresMaxConnections
 *
 * 15 is the reserve for superuser slots, migrations, the boot steps and an
 * operator's psql. Each term is read from where it is defined, so changing a
 * pool size or the replica ceiling re-checks the budget.
 *
 * The budget is for ONE revision's replicas. During a rollout the old and new
 * revisions' replicas overlap, and their pools together can exceed it. That is
 * ASSUMED to be absorbed in practice by the pools being lazy — connections are
 * opened on demand, and the dispatch-lock pool closes after 30 s idle — so an
 * overlapping replica rarely holds its full pools at once. It is an assumption,
 * not something this test (or anything else) checks.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DISPATCH_LOCK_POOL_MAX } from '../../../server/workers/dispatch-lock'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const RESERVED = 15

function requestPoolMax(): number {
  const m = read('server/db/index.ts').match(/client = createDbClient\(url, \{\s*max:\s*(\d+)/)
  expect(m, 'server/db/index.ts: the request pool max').not.toBeNull()
  return Number(m![1])
}

function workerPoolMax(): number {
  const src = read('server/db/worker-db.ts')
  const fn = src.slice(src.indexOf('export function workerConnectionOptions'))
  const m = fn.match(/return \{\s*max:\s*(\d+)/)
  expect(m, 'server/db/worker-db.ts workerConnectionOptions: the worker pool max').not.toBeNull()
  return Number(m![1])
}

/** maxReplicas for an environment name, evaluated from the container-app module's own expression. */
function maxReplicasFor(env: string): number {
  const m = read('infra/modules/container-app.bicep').match(
    /maxReplicas:\s*environment == '(\w+)' \? (\d+) : (\d+)/,
  )
  expect(m, 'container-app.bicep: maxReplicas expression changed shape; update this test').not.toBeNull()
  return env === m![1] ? Number(m![2]) : Number(m![3])
}

function bicepparamValue(src: string, name: string): string | null {
  return src.match(new RegExp(`^param\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1] ?? null
}

const PARAM_FILES = readdirSync(resolve(ROOT, 'infra/parameters')).filter((f) => f.endsWith('.bicepparam'))
// dev.bicepparam is internal-only: the Dev cases skip in the public snapshot.
const HAS_DEV = !PUBLIC_SNAPSHOT

describe('postgres connection budget', () => {
  it('main.bicep defaults to unmanaged and forwards the value to the PG module', () => {
    const main = read('infra/main.bicep')
    expect(main).toMatch(/^param postgresMaxConnections int = 0$/m)
    expect(main).toMatch(/^\s*maxConnections:\s*postgresMaxConnections$/m)
  })

  it('the PG module emits max_connections only when managed', () => {
    const pg = read('infra/modules/postgresql.bicep')
    expect(pg).toMatch(/^param maxConnections int = 0$/m)
    expect(pg).toMatch(
      /resource maxConnectionsSetting 'Microsoft\.DBforPostgreSQL\/flexibleServers\/configurations@[\d-]+' = if \(maxConnections > 0\) \{\s*parent: postgresql\s*name: 'max_connections'/,
    )
  })

  it.skipIf(!HAS_DEV)('at least one parameter file manages it (Dev)', () => {
    const managing = PARAM_FILES.filter((f) => bicepparamValue(read(`infra/parameters/${f}`), 'postgresMaxConnections') !== null)
    expect(managing).toContain('dev.bicepparam')
  })

  it.each(PARAM_FILES)('%s: every replica\'s pools plus the reserve fit under max_connections', (file) => {
    const src = read(`infra/parameters/${file}`)
    const raw = bicepparamValue(src, 'postgresMaxConnections')
    if (raw === null) return // unmanaged: the server's own value applies
    const maxConnections = Number(raw)
    expect(Number.isInteger(maxConnections), `${file}: postgresMaxConnections must be an integer literal`).toBe(true)
    if (maxConnections === 0) return

    const env = bicepparamValue(src, 'env')?.replace(/'/g, '')
    expect(env, `${file}: env`).toBeTruthy()
    const perReplica = requestPoolMax() + workerPoolMax() + DISPATCH_LOCK_POOL_MAX
    const needed = maxReplicasFor(env!) * perReplica + RESERVED
    expect(needed, `${file}: ${maxReplicasFor(env!)} × ${perReplica} + ${RESERVED}`).toBeLessThanOrEqual(maxConnections)
  })

  it.skipIf(!HAS_DEV)('Dev today: 3 × (10 + 10 + 24) + 15 = 147 ≤ 200', () => {
    // The numbers the plan states, so a drift in any one is named here too.
    expect([maxReplicasFor('dev'), requestPoolMax(), workerPoolMax(), DISPATCH_LOCK_POOL_MAX]).toEqual([3, 10, 10, 24])
    expect(Number(bicepparamValue(read('infra/parameters/dev.bicepparam'), 'postgresMaxConnections'))).toBe(200)
  })
})
