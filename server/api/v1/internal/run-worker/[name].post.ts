/*
 * POST /api/v1/internal/run-worker/{name} — machine-to-machine
 * entrypoint for the worker scheduler.
 *
 * Authentication: HMAC-SHA-256 signed request via
 * server/auth/internal-request.ts. The external scheduler (Azure
 * Function timer, k8s CronJob, or equivalent) signs each request with
 * NUXT_INTERNAL_WORKER_HMAC_KEY and the (timestamp, method, path,
 * body-sha256) tuple. Replay window: +/- 300 seconds.
 *
 * Worker selection: by URL parameter {name}, looked up in the
 * static registry (server/workers/registry.ts). Unknown names are
 * rejected with 404 BEFORE any worker code is loaded — auditable
 * surface, no dynamic discovery.
 *
 * Execution health: each dispatch is wrapped in worker_run bookkeeping
 * (insert a 'running' row before, transition to 'success'/'failure'
 * after) so admin diagnostics can surface a FAILING worker. The
 * freshness panel measures data recency and stayed green while the
 * joiner cron failed every run — this is the missing per-worker signal.
 * Bookkeeping is best-effort: it MUST NOT break the worker (own
 * try/catch) and MUST NOT swallow the worker's own error (re-thrown).
 *
 * Why machine-to-machine endpoint instead of in-process cron:
 *   - Multi-instance safe (no boot-time singleton race)
 *   - Observable (HTTP logs, status code, duration metrics)
 *   - Same control plane for dev (curl + signed body) and prod (Azure
 *     Function timer)
 *
 * Why a static registry instead of dynamic file load:
 *   - The set of runnable worker names is auditable in one place
 *   - Unknown names short-circuit at the registry without touching
 *     worker code (defense in depth if HMAC ever leaks)
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { verifyInternalRequest } from '../../../../auth/internal-request'
import { getWorkerDb } from '../../../../db/worker-db'
import { dispatchWorker } from '../../../../workers/dispatch'
import { getWorker, listWorkerNames } from '../../../../workers/registry'
import { parseWorkerOpts } from '../../../../workers/run-worker-opts'

export default defineEventHandler(async (event) => {
  await verifyInternalRequest(event)

  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Missing worker name' })
  }
  const entry = getWorker(name)
  if (!entry) {
    throw createError({
      statusCode: 404,
      statusMessage: `Unknown worker: ${name}. Known: ${listWorkerNames().join(', ')}`,
    })
  }

  // THE WORKER LANE'S POOL, not the request pool (docs/design/rls-enforcement.md
  // §2). There is no identity to derive here — the HMAC authenticates the
  // SCHEDULER, not a person — and every worker reachable from this surface is
  // estate-wide by definition. The handle therefore carries the connection-level
  // `app.user_role=global-finops` GUC, so under FORCE ROW LEVEL SECURITY a
  // reconciliation tick sees the whole estate instead of silently returning zero
  // rows and reporting success.
  const db = await getWorkerDb()

  // Operator-forceable per-dispatch options (currently just deepRescan). Parsed
  // AFTER verifyInternalRequest (which validated the body-sha256 inside the
  // signature) from the cached raw body — tamper-proof, and fail-soft so a
  // malformed body degrades to no-opts rather than 500ing the dispatch.
  const opts = await parseWorkerOpts(event)

  // Lock + ING-7 reap + worker_run bookkeeping + execution live in the shared
  // dispatchWorker core (identical to the admin UI trigger). A concurrent
  // dispatch (scheduler overlap/retry, or an HMAC replay in the ±300 s window)
  // gets the 409 no-op from there.
  // `scheduled` marks a scheduler dispatch for workers that also run from an admin
  // page (placement-check); it is set here, never read from the body.
  return dispatchWorker(db, entry, { ...opts, scheduled: true })
})
