// Scheduled worker jobs (Container Apps Jobs, Schedule trigger).
//
// Each job runs `node scripts/cron-trigger.mjs` with WORKER_NAME=<key>, which
// calls the internal /api/v1/internal/run-worker/<name> endpoint (HMAC-authed)
// on the web app. The worker keys + intended cadence are the source of truth in
// server/workers/registry.ts (recommendedCron); this module materialises the
// subset that should run on the deployed env.
//
// A re-apply converges every job declared here (cron, replicaTimeout, retry
// limit, resources, env) and overwrites any drift made outside IaC; preview with
// `az deployment group what-if` first (the example workflow
// examples/github-actions/tokenscope-infra.yml does).
//
// NOT every registered worker is scheduled on this env (intentional). These are
// DELIBERATELY left unscheduled here (shared/workers/unscheduled.ts, enforced by
// tests/unit/workers/worker-schedule-lockstep.test.ts):
//   - archive-ledger     — a hard no-op until LEDGER_ARCHIVE_ENABLED=true, and
//                          ENABLING is blocked on an unbuilt v_complete_usage §A
//                          cold-fallback (archival would blind §A usage reporting).
// Everything else registered IS scheduled below — the lockstep test fails CI if a
// registered worker is neither scheduled nor in the KNOWN_UNSCHEDULED list, so the
// silent-no-op trap (a worker that exists but never runs) cannot recur.

@description('Resource group location.')
param location string = resourceGroup().location

@description('Container Apps managed environment resource id (containerApp.outputs.environmentId).')
param environmentId string

@description('User-assigned managed identity resource id (registry pull + KV secret access).')
param userAssignedIdentityId string

@description('ACR login server, e.g. crtokenscopesandboxaue.azurecr.io')
param acrLoginServer string

@description('Container image (registry/repo:tag) — same image as the web app.')
param image string

@description('Base URL the worker jobs call: the Front Door endpoint when Front Door is enforced, otherwise the Container App FQDN (see main.bicep workerBaseUrl).')
param tokenscopeBaseUrl string

@description('Key Vault URL of the internal-worker HMAC key secret.')
param internalWorkerHmacKeyVaultUrl string

@description('How long cron-trigger.mjs waits for the run-worker response, in ms. MUST stay below replicaTimeout (240s) so the trigger\'s clean exit(1) wins the race against a hard replica kill. Lockstepped to DISPATCH_TIMEOUT_MS in shared/workers/dispatch-budget.ts.')
param dispatchTimeoutMs int = 200000

@description('Prefix of every job name: <prefix>-<worker>. Job names are capped at 32 characters and the longest worker name is 23, so at most 8.')
@minLength(1)
@maxLength(8)
param namePrefix string = 'caj-ts'

// name = the registry worker key (WORKER_NAME); cron = registry recommendedCron.
var workers = [
  { name: 'analytics-poll', cron: '*/15 * * * *' }
  { name: 'azure-monitor-read', cron: '*/5 * * * *' }
  { name: 'mitigation-query', cron: '*/30 * * * *' }
  { name: 'reconciliation', cron: '0 */1 * * *' }
  { name: 'session-gc', cron: '0 2 * * *' }
  { name: 'soft-purge', cron: '0 3 * * *' }
  // Observability safety nets:
  { name: 'went-silent', cron: '0 */1 * * *' }
  { name: 'reconciliation-gap', cron: '0 */6 * * *' }
  // Reconciliation engine (Phase 0 foundation). Clean no-op until adapters register
  // (no reconciled provider scope / no resolver) — safe to schedule now.
  { name: 'reconciliation-sync', cron: '0 */1 * * *' }
  { name: 'identity-sync', cron: '0 3 * * *' }
  // §A usage completeness: per-(teammate, day) API-vs-OTel reconciliation (unaccounted +
  // over-emission).
  { name: 'usage-reconciliation', cron: '0 */2 * * *' }
  // On-demand backfill queue (mig 0074): drain admin-requested historical pulls, one per tick.
  { name: 'reconciliation-backfill', cron: '*/15 * * * *' }
  // Admin widened-read queue (mig 0093): drain an admin-requested recovery — scoped
  // instances re-read at a wider reader lookback than the 7-day default, in resumable
  // slices so no invocation meets the ~120s gateway ceiling. WITHOUT this scheduled,
  // an admin's recovery request is accepted, shown as 'pending', and NEVER drained —
  // the silent-no-op trap, and the worst possible version of it, because the operator
  // would believe a recovery was under way while nothing ran.
  { name: 'telemetry-recovery', cron: '*/5 * * * *' }
  // Reporting-consolidation Wave 0: read the enterprise billing usage report → write the POOLED
  // Copilot chargeback (copilot_pool_bill), homed org→CoU. A reader, not a calculator
  // (§B). Month-grain + slow-settling → daily. WITHOUT
  // this scheduled, the Copilot chargeback lane is empty and the Finance Σ=bill check has no
  // Copilot term (the silent-no-op trap).
  { name: 'copilot-pool-bill', cron: '0 5 * * *' }
  // Consumption-dashboard read path: materialises
  // attribution_aggregate; self-bootstraps a 90-day backfill on first run.
  { name: 'aggregate-rollup', cron: '*/15 * * * *' }
  // Region-reporting read path: materialises usage_rollup_daily from
  // v_complete_usage; full-history backfill resumes across runs. Minutes ≡ 2
  // (mod 5) avoid simultaneous STARTS with the */5 and */15 pollers — starts
  // only, NOT overlap: dispatches can run ~200 s.
  { name: 'usage-rollup', cron: '7,22,37,52 * * * *' }
  // Read-path outage detector (safety-net sibling of went-silent):
  // scans the worker_run ledger and inbox-alerts platform-admins when the
  // azure-monitor-read gatherer is silently failing (rows not landing while
  // emissions still arrive). went-silent catches emit/WRITE silence; this
  // catches READ-path failure.
  { name: 'read-path-health', cron: '*/15 * * * *' }
  // PER-INSTANCE counterpart to read-path-health. That worker gates on FLEET-wide
  // signals (a zero-write streak, MAX(last_bearer_at) across every instance), so a
  // SINGLE starved device (one instance emitting, its spend attributing nowhere)
  // never moves it. This alerts on the gap between a device's last bearer mint and its
  // last attributed spend. WITHOUT this scheduled there is NO detector for that
  // outage class at all (the silent-no-op trap).
  { name: 'attribution-gap', cron: '*/30 * * * *' }
  // Bill-driven placement pipeline ("a user in a provider bill is provisioned, not
  // skipped"). analytics-poll ENQUEUES owed bills for provider-billed
  // users who have no teammate yet → placement-sync DRAINS pending_placement, mints
  // source='bill' teammates (provisionAndPlace; falls back to __unassigned__ if directory
  // is unwired) + replays into actual_spend → region-reenrichment homes them by
  // directory attributes → pending-placement-gc prunes the drained queue. WITHOUT
  // placement-sync scheduled, the queue never drains, NO bill teammates are minted, and
  // reconciliation-sync records ONLY pre-existing teammates.
  { name: 'placement-sync', cron: '*/30 * * * *' }
  { name: 'region-reenrichment', cron: '0 */6 * * *' }
  // Org setup's automatic directory re-read: a no-op until the top of the
  // organisation is set; then starts a cycle when the monthly (or weekly) re-read is
  // due, runs one pass, and once read checks every unit owner and region leader is
  // still in the directory. Off the hour, away from the :00 Graph callers.
  { name: 'placement-check', cron: '17 * * * *' }
  // ── Lifecycle and governance workers ──
  // Proactive "your project ends in N days — re-tag" warning (D3). Reachable via
  // the admin PATCH end_date API (a future value = a planned end); near-no-op
  // until a project has a future end_date set.
  { name: 'ending-soon', cron: '0 8 * * *' }
  // Owed-bill aging alarm (pending_placement un-placed past the grace window) —
  // the only detector for stuck/un-placed owed spend; reads the live table
  // analytics-poll feeds. Also emits sync-conflict (dormant: seed-only source).
  { name: 'connector-health', cron: '*/30 * * * *' }
  // Cross-instance-spoof early-warning (detect leg; claude-only — Copilot
  // spoof-defense is §A reconciliation). Informational quarantine badges; never revokes.
  // Note: /tokenscope:backfill re-emits with ORIGINAL timestamps, which read as
  // uncovered if they predate the current enrolment.
  { name: 'heartbeat-coverage', cron: '*/30 * * * *' }
  // Retroactive directory-exclusion enforcement. REPORT-ONLY from cron (destructive
  // apply is signed-HMAC-body-only + UI-excluded); single-query no-op until a
  // directory_exclusion_pattern is configured.
  { name: 'privileged-identity-cleanup', cron: '30 4 * * *', jobName: 'priv-identity-cleanup' }
  // Over-budget pages to PMs/Business Unit owners. Reads §A COMPLETE spend (v_complete_usage)
  // so a Copilot-funded project trips its budget — reading raw attribution_record
  // made it silently blind to Copilot, which is why it stayed unscheduled.
  { name: 'budget-alert', cron: '0 * * * *' }
  // Weekly per-teammate burn-rate spike nudge (governance-dial threshold, region
  // overridable). Same §A COMPLETE spend source.
  { name: 'velocity-watch', cron: '50 23 * * 0' }
  { name: 'pending-placement-gc', cron: '0 4 * * *' }
  // Workstream B (governance is data): bounded/resumable historical
  // governance-key backfill (provider_org_id/provider_enterprise_id on
  // actual_spend/reconciliation_record/pending_placement). Converges to a
  // near-empty backlog within the first few runs post-deploy; hourly is ample.
  { name: 'governance-key-backfill', cron: '0 * * * *' }
  // Workstream B: periodic open-period chargeback-verdict recompute (design
  // §4.1). A scoped recompute already runs inline on a billing PATCH; this is
  // the unscoped catch-up sweep (new ingest, a just-unparked governance-key
  // resweep). Money-adjacent bulk UPDATE — cron/HMAC-only, never UI-triggerable.
  { name: 'governance-recompute', cron: '*/15 * * * *' }
  // Workstream D: GitHub enterprise-org coverage detection (design §6) — compute +
  // persist mislinked/coverage-unknown/stale/not-installed/suspended/not-onboarded/
  // connected for every registered GitHub enterprise; dispatches a deduplicated admin
  // inbox alert on a transition into a non-connected state or a capability loss.
  // Hourly comfortably undercuts the persisted-observation TTL (3h) so one missed
  // tick never flips the UI to "unknown". Read-mostly + idempotent — also
  // UI-triggerable (shared/workers/ui-triggerable.ts).
  { name: 'github-coverage-sweep', cron: '0 * * * *' }
  // Target-state data architecture T0: derive the API lane (provider_usage_fact) at teammate/day/tool/MODEL/
  // cost_type grain from actual_spend.raw_payload. T0 is INERT — nothing reads the
  // table yet — but it must still RUN: T2 repoints the model axis at it, and an
  // unscheduled derive would hand T2 an empty table (the silent-no-op trap). Hourly,
  // not the poller's */15: the grain is a DAY and each tick re-derives the same
  // 30-day revision window the poller re-polls. Money-adjacent bulk derive, so
  // cron/HMAC-only — never UI-triggerable.
  { name: 'provider-transform', cron: '0 * * * *' }
  // Ops-alerting evaluator: probes the read
  // path + private-link routes, detects attribution stalls / fleet failures /
  // inbox aging, and pages the external ntfy channel. Cron ≡4 mod 5 — off the 5-
  // and 15-minute tick grids. Its OWN
  // liveness is the A4 dead-man metric alert on this job's execution count.
  { name: 'ops-alert', cron: '9,24,39,54 * * * *' }
]

// One at a time. Created eight at a time, one job in a fresh environment
// regularly failed on the platform's own "caj-ts-<job>--msi" secret while its
// siblings on the same identity succeeded (and 32 at once had some refused
// by the registry through a private endpoint).
@batchSize(1)
resource jobs 'Microsoft.App/jobs@2024-03-01' = [
  for w in workers: {
    // ACA job names are capped at 32 chars, but a WORKER_NAME can be longer
    // ('caj-ts-privileged-identity-cleanup' = 34 → ARM rejects the whole module
    // deployment). `jobName` is an optional per-entry override; WORKER_NAME below
    // still carries the real registry key. The lockstep test asserts the derived
    // name fits, so a long new worker fails CI instead of failing the deploy.
    name: '${namePrefix}-${contains(w, 'jobName') ? w.jobName : w.name}'
    location: location
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${userAssignedIdentityId}': {}
      }
    }
    properties: {
      environmentId: environmentId
      configuration: {
        triggerType: 'Schedule'
        replicaTimeout: 240
        replicaRetryLimit: 1
        scheduleTriggerConfig: {
          cronExpression: w.cron
          parallelism: 1
          replicaCompletionCount: 1
        }
        registries: [
          {
            server: acrLoginServer
            identity: userAssignedIdentityId
          }
        ]
        secrets: [
          {
            name: 'internal-worker-hmac-key'
            keyVaultUrl: internalWorkerHmacKeyVaultUrl
            identity: userAssignedIdentityId
          }
        ]
      }
      template: {
        containers: [
          {
            name: 'worker'
            image: image
            command: [ 'node' ]
            args: [ 'scripts/cron-trigger.mjs' ]
            resources: {
              cpu: json('0.25')
              memory: '0.5Gi'
            }
            env: [
              { name: 'WORKER_NAME', value: w.name }
              { name: 'TOKENSCOPE_BASE_URL', value: tokenscopeBaseUrl }
              { name: 'NUXT_INTERNAL_WORKER_HMAC_KEY', secretRef: 'internal-worker-hmac-key' }
              // How long cron-trigger.mjs waits for the run-worker response. SET
              // EXPLICITLY, not left to the script's fallback: leaving it unset gave
              // every job a 120s wait against a 240s replicaTimeout, so a worker
              // taking >120s completed, logged `success`, and was STILL reported as a
              // failed execution and retried (Dev 2026-07: region-reenrichment 73
              // consecutive false failures at 134.5s; analytics-poll ~50% at 108.3s).
              // Kept below replicaTimeout on purpose -- the trigger aborting is a
              // clean exit(1) naming the worker, the platform killing the replica is
              // not. Value + ordering are lockstepped in
              // tests/unit/workers/dispatch-budget-lockstep.test.ts.
              { name: 'CRON_TRIGGER_TIMEOUT_MS', value: '${dispatchTimeoutMs}' }
            ]
          }
        ]
      }
    }
  }
]
