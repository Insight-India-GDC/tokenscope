/*
 * GET /api/v1/admin/diagnostics/instance-telemetry?instanceId=…&hours=…
 *
 * THE NEXT STEP after an attribution gap. The attribution-gap card tells an
 * operator "this device is N days behind". Until now their next move was a KQL
 * query against a workspace that is NSP-locked to the app's managed identity —
 * i.e. a shell they do not have and cannot be given. So the single question that
 * splits the outage in half went unanswered during exactly the incidents it
 * exists for.
 *
 * That question: is this instance's telemetry in ingest AT ALL for the window?
 *   - IN, and unattributed          → the loss is OURS (the joiner). Recover it.
 *   - ABSENT                        → the loss is the CLIENT's. Look at the
 *                                     device, starting with the plugin/CLI
 *                                     versions this same instance now reports.
 * The two facts come from two independent sources on purpose — the ingest store
 * and our own ledger. Reasoning from the ledger alone cannot distinguish them,
 * because "no rows" is equally consistent with both.
 *
 * RBAC: admin / platform-admin — the same tier as the attribution-gaps card this
 * hangs off, and the same class of data (one instance id, its counts, its
 * self-reported versions). Deliberately NOT the platform-admin tier that
 * otel-logs.get.ts uses: that endpoint returns RAW Azure result and error packets
 * (status codes, the inner NspValidationFailedError, the exact KQL); this one
 * returns counts, timestamps and a verdict, and its error path is a redacted
 * reason code (server/utils/redact-probe-error.ts), never a raw message. If
 * that ever changes — if raw packets start flowing through here — this gate
 * must move up with it.
 *
 * REGION CLAMP: the instance lookup is hoisted to the top of the handler and
 * gated with an EXPLICIT `requireRegionScope` on the region its teammate sits
 * in NOW (current-org-lens §3.2, the same clamp as attribution-gaps, whose
 * "Diagnose" lands here) before either the ledger count or the ingest probe runs. This is NOT backstopped by
 * RLS — the app connects as the table owner, which Postgres never subjects to
 * RLS regardless of policy or GUCs (see instances/[instanceId].delete.ts's
 * identical note) — so the app-level check is the only gate.
 *
 * Read-only. No caller-supplied KQL: the instance id is validated as a UUID and
 * charset-guarded again inside the reader, and the window is a clamped integer.
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { getValidated } from '../../../../utils/validated-body'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getTelemetryReader, type InstancePresence } from '../../../../azure/reader'
import { classifyTelemetry } from '../../../../utils/telemetry-verdict'
import { classifyProbeError } from '../../../../utils/redact-probe-error'

const Query = z.object({
  instanceId: z.string().uuid(),
  /*
   * Window in hours. Default 168 (7 days) — wide enough to cover the gap the
   * detector reports (it alerts at 72h) without being so wide that a single probe
   * scans a quarter. Capped at 90 days, the longest retention we provision:
   * beyond that the query can only scan empty range and bill query time for it.
   */
  hours: z.coerce.number().int().min(1).max(24 * 90).default(168),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const { instanceId, hours } = await getValidated(event, Query)

  return withRequestRls(event, async (db) => {
    // ── The instance itself, HOISTED to the top: liveness, what it CLAIMS to be
    // running, and its teammate's current region — fetched BEFORE anything else this endpoint
    // does. RLS on instance_attestation is INERT at runtime (the app connects
    // as the table owner, which Postgres never subjects to RLS regardless of
    // policy or GUCs — see instances/[instanceId].delete.ts's identical note),
    // so an `inst === null` check can never stand in for a region check: the
    // row comes back regardless of which region it belongs to. The explicit
    // requireRegionScope call right below is the actual gate.
    //
    // The version columns (mig 0092) and platform / surface / setup mode (mig
    // 0150) are client-asserted and are shown here as
    // diagnostic hints, never as a basis for any decision this endpoint makes.
    // They are the first thing an operator wants once the verdict says 'client'.
    const instRows = await db.execute<{
      instance_id: string
      region_id: string
      teammate_email: string | null
      last_bearer_at: string | null
      ts_actual_end: string | null
      client_plugin_version: string | null
      client_cli_version: string | null
      client_version_at: string | null
      client_platform: string | null
      client_surface: string | null
      setup_mode: string | null
    }>(sql`
      SELECT ia.instance_id::text        AS instance_id,
             t.region_id::text           AS region_id,
             t.email                     AS teammate_email,
             ia.last_bearer_at::text     AS last_bearer_at,
             ia.ts_actual_end::text      AS ts_actual_end,
             ia.client_plugin_version    AS client_plugin_version,
             ia.client_cli_version       AS client_cli_version,
             ia.client_version_at::text  AS client_version_at,
             ia.client_platform          AS client_platform,
             ia.client_surface           AS client_surface,
             ia.setup_mode               AS setup_mode
        FROM instance_attestation ia
        LEFT JOIN teammate t ON t.id = ia.teammate_id
       WHERE ia.instance_id = ${instanceId}::uuid
       LIMIT 1
    `)
    const inst = [...instRows][0] ?? null

    // EXPLICIT app-level region clamp, BEFORE the ledger count and BEFORE the
    // ingest probe — clamping after either would leave the disclosure intact
    // (the count/probe would already have run). No-op for platform-admin /
    // platform-admin; throws 403 for a region-scoped admin outside their
    // region. A genuinely unknown instance (inst === null) has no region to
    // clamp against — it degrades to "unanswerable" below without a leak,
    // since there is nothing region-specific to disclose.
    if (inst !== null) {
      await requireRegionScope(event, inst.region_id)
    }

    // ── OUR side: what the ledger holds for this instance in the SAME window ──
    // Same instance, same window as the ingest probe below — a comparison across
    // two different windows would be worse than no comparison, because it would
    // look authoritative while contrasting unrelated populations. No placement
    // predicate: the instance gate above is the clamp, and a row's stamped
    // region would hide the records of someone who has since moved.
    const ledgerRows = await db.execute<{
      records: string
      first_ts: string | null
      last_ts: string | null
    }>(sql`
      SELECT COUNT(*)::text        AS records,
             MIN(ts_event)::text   AS first_ts,
             MAX(ts_event)::text   AS last_ts
        FROM attribution_record
       WHERE instance_id = ${instanceId}::uuid
         AND ts_event >= NOW() - (${hours} * INTERVAL '1 hour')
    `)
    const ledger = [...ledgerRows][0]
    const attributedRecords = Number(ledger?.records ?? 0)

    // ── INGEST side: what Log Analytics holds, read independently ─────────────
    // `presence === null` is the honest "could not read" and is NEVER collapsed
    // into zero: identical numbers, opposite verdicts (see telemetry-verdict.ts).
    let presence: InstancePresence | null = null
    let ingestError: string | null = null
    let ingestErrorCorrelationId: string | null = null
    /*
     * `inst === null` here means the instance id genuinely does not exist —
     * NOT "exists but is region-hidden" (that case already threw a 403 above,
     * via requireRegionScope, before any of this runs). Probing Log Analytics
     * for a genuinely unknown id would still answer "does telemetry exist for
     * this UUID" for an id nobody has issued, so it degrades to unanswerable
     * here rather than probing.
     */
    if (inst === null) {
      ingestError = 'instance not found'
    } else try {
      const reader = getTelemetryReader()
      if (typeof reader.instancePresence !== 'function') {
        // A reader that cannot answer this question must not be made to look like
        // one that answered "nothing".
        //
        // UNTESTED, deliberately (mutation sweep: this line survives). Both
        // shipped readers implement instancePresence, so no configuration this
        // build can produce reaches here — reaching it would need a reader that
        // does not exist yet. The guard exists because the interface member is
        // OPTIONAL: a future reader that omits it must degrade to "unanswerable"
        // rather than throwing a TypeError that the catch below would then
        // render as if it were an Azure failure. Cost of being wrong here is a
        // worse error message, never a wrong verdict.
        ingestError = 'the configured telemetry reader cannot answer instance-presence queries'
      } else {
        presence = await reader.instancePresence(instanceId, hours)
      }
    } catch (err) {
      // Redacted reason, not the raw message — this tier does not receive raw
      // Azure packets (see the RBAC note in the header); the operator's
      // escalation path for the raw packet is Admin → Diagnostics → OTel
      // telemetry (platform-admin). The correlation id ties this back to the
      // full-fidelity server log line.
      const classified = classifyProbeError(err, 'instance-telemetry:ingest-probe')
      ingestError = classified.reason
      ingestErrorCorrelationId = classified.correlationId
    }

    const outcome = classifyTelemetry({
      ingest: presence ? { records: presence.records, usageRecords: presence.usageRecords } : null,
      attributedRecords,
    })

    return {
      instanceId,
      windowHours: hours,
      known: inst !== null,
      instance: inst
        ? {
            teammateEmail: inst.teammate_email,
            lastBearerAt: inst.last_bearer_at,
            endedAt: inst.ts_actual_end,
            // CLIENT-ASSERTED. Null = this device has never reported a version,
            // which itself means it is running a build older than the one that
            // started reporting — usually the most actionable line on this page.
            clientPluginVersion: inst.client_plugin_version,
            clientCliVersion: inst.client_cli_version,
            clientVersionAt: inst.client_version_at,
            // CLIENT-ASSERTED as well (mig 0150). Platform / surface follow the
            // version rules; setupMode is the latest setup redeem's own claim.
            clientPlatform: inst.client_platform,
            clientSurface: inst.client_surface,
            setupMode: inst.setup_mode,
          }
        : null,
      ingest: presence
        ? {
            reachable: true,
            records: presence.records,
            usageRecords: presence.usageRecords,
            firstSeen: presence.firstSeen,
            lastSeen: presence.lastSeen,
          }
        : { reachable: false, error: ingestError, errorCorrelationId: ingestErrorCorrelationId },
      attribution: {
        records: attributedRecords,
        firstTsEvent: ledger?.first_ts ?? null,
        lastTsEvent: ledger?.last_ts ?? null,
      },
      verdict: outcome.verdict,
      side: outcome.side,
      interpretation: outcome.interpretation,
    }
  })
})
