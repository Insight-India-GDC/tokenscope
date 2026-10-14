/*
 * Emit-provisioning orchestration (MCP client backbone — provision_emit + redeem).
 *
 * Two-step, secret-isolating device provisioning (docs/design/mcp-client-backbone.md
 * §"One auth → also provisions the device, WITHOUT a durable secret in the LLM"):
 *
 *   1. provision_emit (read-scoped MCP tool) → locateOrCreateInstance + mintEmitHandoff.
 *      Returns ONLY a short-TTL one-time HANDOFF code + redeem URL. The durable
 *      emit refresh token is NEVER minted here, so it can never enter the LLM's
 *      context (the broadly-readable emit credential is the most widely-exposed
 *      secret in the system — it must not transit the agent).
 *   2. redeem (direct process→server call, NOT MCP) → consumeEmitHandoff +
 *      issueEmitCredential. Returns the durable credential + the OTel bundle.
 *
 * Secrets discipline mirrors setup_token / oauth_auth_code: the handoff code is a
 * 32-byte random value; only its HMAC-SHA-256 hash is stored; single-use is an
 * atomic compare-and-swap on consumed_at (like consumeAuthCode), so a replayed or
 * concurrent redeem sees at most one success.
 *
 * The instance_attestation this creates is derived from the BEARER TEAMMATE (the
 * authenticated read identity), NOT a setup token — the teammate binding is the
 * unspoofable join key attribution requires. It is minted 'unassigned' (no
 * project): the device emits untagged and is tagged per-repo/per-session later.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken } from './hmac'
import { advisoryGlobalCapLock, advisoryXactLock } from '../db/advisory-lock'
import { deviceIdleWindowEnd } from './oauth'
import { getPublicRequestURL, assertTrustedPublicOrigin } from '../utils/public-url'
import { currentServerDeployEnv } from '../../shared/env/deploy-env'
// Reach the sibling's shape rather than redefining a second CapExceeded type
// (both files' cap checks return the same discriminated shape; type-only, so
// this is not a runtime circular import — enroll-provision.ts imports
// `type EmitTool` from THIS file the same way).
import type { CapExceeded } from './enroll-provision'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Handoff TTL: ~5 min, single-use (docs §"short-TTL (~5 min) handoff code"). */
export const EMIT_HANDOFF_TTL_MS = 5 * 60 * 1000

/**
 * Per-teammate live-instance cap on the AUTHENTICATED self-provision path
 * (provision_emit → locateOrCreateInstance's create branch) — the mint side
 * had no quota of any kind while its sibling (enroll-provision.ts's
 * locateOrCreateProvisionalInstance, the unauthenticated claimed-email path)
 * has had two since the emit-on-install slice. An instance is per-HOST
 * (AGENTS.md §Domain shortcuts) — one person legitimately holds several
 * (laptop, a couple of CWs, a CI box) — so the ceiling sits in the TENS, not
 * the ones. Env-overridable via MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE.
 *
 * Deliberately NOT folded into the enrol caps' identity_state='provisional'
 * count: this path only ever mints 'confirmed' (authenticated) attestations
 * — a different, much smaller population than the unauthenticated
 * claimed-email enrol path. Widening the enrol caps to include 'confirmed'
 * rows would conflate an unauthenticated-enrolment concern with an
 * authenticated-self-provision one.
 */
export const DEFAULT_MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = 50
/**
 * Global backstop across ALL confirmed (non-provisional) live instances,
 * mirroring DEFAULT_MAX_PROVISIONAL_INSTANCES's role for the enrol path.
 * Generous: real teammates number in the low thousands, and a few dozen
 * devices each still leaves headroom. Env-overridable via
 * MAX_LIVE_EMIT_INSTANCES.
 */
export const DEFAULT_MAX_LIVE_EMIT_INSTANCES = 50_000

export function maxLiveInstancesPerTeammate(): number {
  const raw = Number(process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
}
export function maxLiveInstancesGlobal(): number {
  const raw = Number(process.env.MAX_LIVE_EMIT_INSTANCES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LIVE_EMIT_INSTANCES
}

/** The teammate identity provision_emit derives an attestation from (the bearer). */
export interface ProvisioningTeammate {
  teammateId: string
  principalOid: string
  email: string | null
  regionId: string
  orgUnitId: string
}

/**
 * Load the columns provision_emit needs to mint an attestation, straight from the
 * teammate row (the BearerTeammate carries region but not org_unit / entra_oid).
 * Returns null if the teammate vanished.
 */
export async function loadProvisioningTeammate(
  db: Db,
  teammateId: string,
): Promise<ProvisioningTeammate | null> {
  const rows = await db.execute<{
    entra_oid: string
    email: string | null
    region_id: string
    org_unit_id: string
  }>(sql`
    SELECT entra_oid, email, region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) return null
  return {
    teammateId,
    principalOid: row.entra_oid,
    email: row.email,
    regionId: row.region_id,
    orgUnitId: row.org_unit_id,
  }
}

/** The tool emitting telemetry. Determines which OTel bundle shape redeem returns. */
export type EmitTool = 'claude-code' | 'copilot-cli'

/**
 * The tools buildOtelBundle actually knows how to serve.
 *
 * This is the SINGLE source of the list. It had been written out separately in
 * the MCP tool's Zod enum and in the database trigger; three copies of a closed
 * set drift, and each copy that lags admits a value the others reject, which is
 * how a row reaches a reader that cannot serve it. The Zod enum now derives
 * from here, and tests/integration/setup/cross-tool-guard.test.ts pins the
 * trigger's list against it, so adding a tool in one place fails loudly until
 * it is added in all of them.
 */
export const EMIT_TOOLS = ['claude-code', 'copilot-cli'] as const satisfies readonly EmitTool[]

/**
 * Narrow a stored `instance_attestation.tool` to a tool we can serve.
 *
 * The read sites used to cast (`as 'claude-code' | 'copilot-cli'`), which
 * asserts rather than checks: the value comes from the database, TypeScript
 * erases at runtime, and the column's trigger only required non-blank until
 * migration 0100. An unknown value therefore satisfied the cast, missed the
 * 'copilot-cli' branch, and fell through to the CLAUDE bundle -- a device that
 * looks enrolled, is handed endpoints and an env block shaped for a client that
 * is not running, and never emits.
 *
 * Fails closed for the same reason the cross-tool guard does: serving the wrong
 * bundle is worse than refusing, because refusing is visible and has a recovery
 * (re-run provision_emit for a fresh device) while the silent version is only
 * ever found by someone noticing missing spend weeks later.
 */
export function requireEmitTool(stored: string | null | undefined): EmitTool {
  const tool = stored ?? 'claude-code'
  if ((EMIT_TOOLS as readonly string[]).includes(tool)) return tool as EmitTool
  throw createError({
    statusCode: 409,
    statusMessage: `This device is bound to an unrecognised tool, so no emit configuration can be built for it; re-run provision_emit to mint a fresh device.`,
  })
}

/**
 * Locate-or-create the instance_attestation for (teammate, instanceId).
 *
 * Idempotency (docs §F2.3): if `instanceId` is supplied AND a LIVE attestation
 * (ts_actual_end IS NULL) for that id is owned by THIS teammate, reuse it — re-
 * provisioning the same device must NOT mint unbounded attestations. Otherwise
 * mint a fresh one (a supplied id NOT owned by this teammate is treated as absent:
 * we never adopt another teammate's instance, and we never leak that it exists).
 *
 * CROSS-ENVIRONMENT REUSE GUARD (mig 0060): an instance belongs to the deployment
 * environment that minted it (`deployment_env`, the NUXT_DEPLOY_ENV-classified
 * label). If a client re-provisions against a DIFFERENT deployment (Sandbox → Dev,
 * later Dev → Production) while still carrying the OLD environment's
 * tokenscope.instance_id, that id usually won't exist in the new DB at all and we'd
 * silently mint a duplicate. But if a row IS found and owned by this teammate yet
 * its stored deploy-env differs from this deployment's, we REJECT loudly (409)
 * rather than silently re-mint — a stale id pointed at the wrong environment is an
 * operator-visible error, not something to paper over. Legacy rows (deployment_env
 * NULL, pre-0060) are treated as same-env and back-filled on reuse.
 *
 * The attestation is 'unassigned' — provision_emit derives identity from the
 * bearer, which has no project. ts_expected_end is the device's idle window
 * (`deviceIdleWindowEnd`, renewed by every /bearer mint and by reuse here);
 * session-gc closes the device once it passes.
 *
 * @param deployEnv this deployment's environment label, classified from
 *   NUXT_DEPLOY_ENV via the canonical currentServerDeployEnv() (the same resolver
 *   dev-login / admin-settings / obo use). Stable across a custom-domain cutover,
 *   unlike the public origin host (container-app.bicep:223: host is NOT the env
 *   signal, NUXT_DEPLOY_ENV is). Defaults to the running deployment's env — callers
 *   (e.g. tests) MAY override.
 * @param tx MUST be an open transaction. The advisory lock taken at the very
 *   top is pg_advisory_xact_lock (released at commit/rollback), and — because
 *   the create branch's INSERT now runs in the SAME transaction as the
 *   caller's downstream work (mcp.ts's provision_emit: handoff rotate, mint,
 *   audit) — a mid-sequence failure anywhere in that sequence rolls the
 *   INSERT back too. Previously this ran against a bare (autocommitting) db
 *   handle OUTSIDE the caller's transaction, so a downstream failure (e.g.
 *   the audit write) left a committed orphan instance_attestation with no
 *   handoff ever issued for it — a leak that compounds every time the cap
 *   below is exercised. Passing a non-transaction handle (as the
 *   cross-env-guard tests do, which never race and never fail
 *   mid-sequence) still works — pg_advisory_xact_lock is valid on any
 *   connection — it just loses the cross-statement locking guarantee.
 * @returns the instance_id to mint the handoff against and whether it was
 *   reused, OR CapExceeded when the CREATE branch would exceed the
 *   per-teammate or global live-instance cap (idempotent reuse never
 *   consumes quota — see below). The caller maps CapExceeded to a
 *   quota-exceeded tool response.
 */
export async function locateOrCreateInstance(
  tx: Db,
  tm: ProvisioningTeammate,
  instanceId: string | undefined,
  tool: EmitTool = 'claude-code',
  deployEnv: string = currentServerDeployEnv(),
): Promise<{ instanceId: string; reused: boolean } | CapExceeded> {
  const currentEnv = deployEnv?.trim() || null

  // Advisory lock FIRST — before any read, and before the cap-gated INSERT —
  // so the whole locate-or-create decision is serialized. Keyed on the
  // supplied instanceId when re-provisioning (the SAME key mcp.ts's handoff
  // rotate+mint used to take in a SEPARATE, later transaction; folded in here
  // now that the whole sequence shares one transaction, so a concurrent
  // re-provision of the SAME device can no longer interleave with it), or on
  // the teammate id for a fresh mint. Namespaced via server/db/advisory-lock.ts:
  // the previous single-argument hashtext form put instance ids and teammate
  // ids in ONE key space, so a collision between the two could invert lock
  // order between transactions and deadlock. Namespaces are acquired in
  // ascending order (instance, then principal, then globalCap).
  await tx.execute(advisoryXactLock('instance', instanceId ?? tm.teammateId))

  // THE PLACEMENT A DEVICE IS WRITTEN WITH (#417). `tm` was read before this
  // transaction (mcp.ts), so a placement move committing in between would leave
  // a new device on the old one. Lock the teammate row and re-read it here,
  // before any device lock or insert: FOR NO KEY UPDATE conflicts with the lock
  // every placement move holds, so a move and a provision serialise. Move first:
  // this read sees the new placement. Provision first: the move's
  // followPlacement re-homes the device this commits.
  //
  // ORDER: instance key, then this row, then the principal and global-cap keys
  // (create branch below), then devices. Identity confirmation takes the
  // teammate, then principal and global cap, the same way round. The global
  // cap comes after the teammate so that waiting on a busy teammate (a bulk
  // placement) never holds the one key every provision shares.
  const placedRows = await tx.execute<{ region_id: string; org_unit_id: string }>(sql`
    SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM teammate WHERE id = ${tm.teammateId}::uuid
       FOR NO KEY UPDATE
  `)
  const placed = [...placedRows][0]
  const regionId = placed?.region_id ?? tm.regionId
  const orgUnitId = placed?.org_unit_id ?? tm.orgUnitId

  if (instanceId) {
    const existing = await tx.execute<{
      instance_id: string
      deployment_env: string | null
      tool: string | null
    }>(sql`
      SELECT instance_id::text AS instance_id, deployment_env, tool
        FROM instance_attestation
       WHERE instance_id = ${instanceId}::uuid
         AND teammate_id = ${tm.teammateId}::uuid
         AND ts_actual_end IS NULL
         AND ts_purged IS NULL
       LIMIT 1
         FOR UPDATE
    `)
    const row = [...existing][0]
    if (row) {
      const storedEnv = row.deployment_env?.trim() || null
      const storedTool = row.tool?.trim() || null
      // Cross-TOOL guard: an instance is bound to ONE emit tool. Re-provisioning
      // it under a DIFFERENT tool used to fall through to `reused: true`, and the
      // caller then rotated the durable credential and built a bundle for the
      // wrong tool. The redeem helper rejected that bundle CLIENT-side — after
      // the rotation had already committed — so the old secret was dead on disk
      // and the new one was never written. Net effect: attempting to set up one
      // CLI silently destroyed the OTHER CLI's working emitting on the same host
      // (instances are per-HOST, `tool` is per-instance). Reproduced live
      // 2026-07-28: a copilot-cli provision against a claude-code instance broke
      // Claude Code emitting. Refuse BEFORE any rotation; the message names the
      // recovery exactly as the cross-env guard does.
      if (storedTool !== null && storedTool !== tool) {
        throw createError({
          statusCode: 409,
          statusMessage: `This device id is already provisioned for '${storedTool}'; omit instance_id to mint a fresh device for '${tool}'. Re-provisioning it under a different tool would revoke the '${storedTool}' credential.`,
        })
      }
      // Cross-env guard: a non-null stored deploy-env that differs from this
      // deployment means the id was minted elsewhere. Refuse — do NOT silently
      // mint a duplicate (the old silent fall-through). The message tells the
      // client exactly how to recover (omit instance_id to mint fresh).
      if (storedEnv !== null && currentEnv !== null && storedEnv !== currentEnv) {
        throw createError({
          statusCode: 409,
          statusMessage:
            'This device id belongs to a different TokenScope environment; omit instance_id to mint a fresh device for this environment.',
        })
      }
      // Legacy null-env row (pre-0060): treat as same-env and back-fill so a
      // subsequent re-provision is guarded too. Only stamps when we actually
      // know the current env.
      if (storedEnv === null && currentEnv !== null) {
        await tx.execute(sql`
          UPDATE instance_attestation
             SET deployment_env = ${currentEnv}
           WHERE instance_id = ${row.instance_id}::uuid
             AND deployment_env IS NULL
        `)
      }
      // A stored tool we cannot read is a tool we cannot prove ownership of.
      // `tool` is NOT NULL and every writer goes through the `EmitTool` union, so
      // a blank/whitespace value should be unreachable — but that is a
      // compile-time guarantee, not a database one. Migration 0099 adds a
      // BEFORE INSERT OR UPDATE OF tool trigger behind it — a trigger rather
      // than a CHECK because a CHECK re-validates the whole row on EVERY
      // update, which would make a pre-existing blank row impossible to revoke,
      // purge, or otherwise maintain. This branch still covers rows written
      // before that migration, and any future raw-SQL backfill.
      //
      // The earlier version of this branch ADOPTED the caller's tool here and
      // returned `reused: true`, which fails OPEN: the caller then rotates the
      // durable credential of an instance whose owning tool is unknown, which is
      // precisely the destructive outcome the guard above exists to prevent. A
      // degenerate row must fail CLOSED. Refusing costs nothing, because the
      // recovery is the same one every other 409 here names and it always works:
      // omit instance_id and mint a fresh device.
      if (storedTool === null) {
        throw createError({
          statusCode: 409,
          statusMessage: `This device id has no readable tool binding, so re-provisioning it could revoke another CLI's credential; omit instance_id to mint a fresh device for '${tool}'.`,
        })
      }
      // Re-provisioning is the owner explicitly renewing this device, and the
      // caller is about to issue it a fresh credential: renew the device's idle
      // window with it, or a device first enrolled 90 days ago is closed by
      // session-gc under its brand-new credential. The SELECT's row lock keeps
      // session-gc from ending the row between that check and this renewal.
      // The placement goes with the renewal: a re-provisioned device carries the
      // teammate's placement as read under the lock above.
      await tx.execute(sql`
        UPDATE instance_attestation
           SET ts_expected_end = GREATEST(ts_expected_end, ${deviceIdleWindowEnd()}),
               region_id = ${regionId}::uuid,
               org_unit_id = ${orgUnitId}::uuid
         WHERE instance_id = ${row.instance_id}::uuid
      `)
      return { instanceId: row.instance_id, reused: true }
    }
  }

  // We are now committed to the CREATE branch, and the lock taken at the top of
  // this function does not bound it. That lock keys on `instanceId ?? teammateId`,
  // so a caller supplying an instance id we do NOT own (or one already ended)
  // holds a lock on that UUID, falls through to here, and never serialises
  // against anything. N concurrent requests carrying N distinct unknown UUIDs
  // therefore each take a different lock, all read the same pre-insert counts,
  // and all insert: both caps below are bypassed by an authenticated caller who
  // simply varies the id. The comment on that lock claimed it "bounds concurrent
  // creates by the SAME teammate against the cap below", which is true only when
  // no instance id was supplied.
  //
  // Take the teammate key explicitly before counting. pg_advisory_xact_lock is
  // re-entrant within a transaction, so the no-instance-id path (which already
  // holds the equivalent key in the `instance` namespace) pays nothing here.
  await tx.execute(advisoryXactLock('principal', tm.teammateId))

  // The GLOBAL cap needs its own lock, and a per-teammate one cannot supply it.
  // The count below reads the whole table, so N concurrent creates by N
  // DIFFERENT teammates hold N different principal locks, all read the same
  // pre-insert total, and all insert past the cap. A fixed key is the point:
  // every caller must contend on the same one. Acquired after `principal` to
  // hold the ascending namespace order that keeps these three locks
  // deadlock-free (see server/db/advisory-lock.ts).
  await tx.execute(advisoryGlobalCapLock('confirmed'))

  // Caps apply ONLY to the create branch — idempotent reuse above never
  // consumes quota (mirrors enroll-provision.ts's
  // locateOrCreateProvisionalInstance). Per-teammate first, then a global
  // backstop. Both counts filter to LIVE rows only (ts_actual_end IS NULL AND
  // ts_purged IS NULL) — counting ENDED instances would refuse
  // re-provisioning for anyone who has ever revoked a device.
  const liveRows = await tx.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation
     WHERE teammate_id = ${tm.teammateId}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL
  `)
  if (Number([...liveRows][0]?.count ?? 0) >= maxLiveInstancesPerTeammate()) {
    return { capExceeded: true }
  }
  // identity_state='confirmed' is LOAD-BEARING, not decoration. This cap's own
  // docstring says it covers confirmed instances and is deliberately NOT folded
  // in with the provisional population — but an unfiltered COUNT(*) counts both.
  // Provisional rows come from the UNAUTHENTICATED enrol door, which an attacker
  // drives with arbitrary claimed emails up to that door's own 50k cap. Without
  // this filter, filling the provisional cap also fills this one, and
  // authenticated self-provisioning stops working deployment-wide for everyone.
  // That is precisely the conflation the docstring promises to avoid.
  const globalRows = await tx.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation
     WHERE identity_state = 'confirmed' AND ts_actual_end IS NULL AND ts_purged IS NULL
  `)
  if (Number([...globalRows][0]?.count ?? 0) >= maxLiveInstancesGlobal()) {
    return { capExceeded: true }
  }

  // Fresh device. Mint a new instance id (server-chosen, a real UUIDv4 — the
  // instance_id column is uuid and the client/redeem args validate .uuid()).
  // A supplied-but-unowned/ended id falls through to here — we DON'T reuse it.
  // Stamp deployment_env so a later re-provision against another environment
  // is detected (the cross-env guard above).
  const newId = randomUUID()
  await tx.execute(sql`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool,
       ts_expected_end, region_id, org_unit_id, attestation_state, deployment_env)
    VALUES (${newId}::uuid, ${tm.principalOid}, ${tm.email}, ${tm.teammateId}::uuid, ${tool},
            ${deviceIdleWindowEnd()}, ${regionId}::uuid, ${orgUnitId}::uuid,
            'unassigned', ${currentEnv})
  `)
  return { instanceId: newId, reused: false }
}

/**
 * Invalidate any UNCONSUMED, still-live handoffs for an instance (rotate). Called
 * before minting a fresh handoff so a re-provision can't leave multiple redeemable
 * codes outstanding for one device.
 */
export async function revokePriorHandoffsForInstance(db: Db, instanceId: string): Promise<void> {
  await db.execute(sql`
    UPDATE emit_handoff SET consumed_at = now()
     WHERE instance_id = ${instanceId}::uuid AND consumed_at IS NULL
  `)
}

export interface MintedHandoff {
  /** Raw handoff code — returned to the tool caller ONCE, never persisted. */
  code: string
  expiresAt: Date
}

/**
 * Mint a one-time, short-TTL handoff bound to (teammate, instance). Stores only
 * the HMAC hash; returns the raw code for the redeem helper.
 */
export async function mintEmitHandoff(
  db: Db,
  teammateId: string,
  instanceId: string,
): Promise<MintedHandoff> {
  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + EMIT_HANDOFF_TTL_MS)
  await db.execute(sql`
    INSERT INTO emit_handoff (code_hash, teammate_id, instance_id, expires_at)
    VALUES (${hashSessionToken(code)}, ${teammateId}::uuid, ${instanceId}::uuid,
            ${expiresAt.toISOString()}::timestamptz)
  `)
  return { code, expiresAt }
}

export interface ConsumedHandoff {
  teammateId: string
  instanceId: string
}

/**
 * Consume a handoff atomically: mark it consumed iff it was unconsumed AND not
 * expired, returning its binding. A single-statement CAS (UPDATE ... WHERE
 * consumed_at IS NULL AND expires_at > now() RETURNING) — concurrent/replayed
 * redeems see at most one success (replay-safe, like consumeAuthCode). Returns
 * null for an unknown / expired / already-used code.
 */
export async function consumeEmitHandoff(db: Db, rawCode: string): Promise<ConsumedHandoff | null> {
  const codeHash = hashSessionToken(rawCode)
  // LOCK ORDER: device, then handoff, then oauth_token. Ending a device (mig
  // 0141's trigger), provision_emit and the credential binder all take them in
  // that order, so claim the device row the handoff names BEFORE the handoff.
  // Claiming the handoff first deadlocks against a concurrent device end.
  await db.execute(sql`
    SELECT 1 FROM instance_attestation
     WHERE instance_id = (SELECT instance_id FROM emit_handoff WHERE code_hash = ${codeHash})
       FOR UPDATE
  `)
  const rows = await db.execute<{ teammate_id: string; instance_id: string }>(sql`
    UPDATE emit_handoff SET consumed_at = now()
     WHERE code_hash = ${codeHash}
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING teammate_id::text AS teammate_id, instance_id::text AS instance_id
  `)
  const row = [...rows][0]
  if (!row) return null
  return { teammateId: row.teammate_id, instanceId: row.instance_id }
}

export interface OtelBundle {
  OTEL_LOGS_EXPORTER: 'otlp'
  OTEL_METRICS_EXPORTER: 'none'
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: string
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf'
  otel_headers_helper_url: string
  OTEL_RESOURCE_ATTRIBUTES: string
}

/**
 * The Copilot-specific provisioning bundle.
 *
 * Unlike Claude (which reads env from ~/.claude/settings.json), Copilot CLI has no
 * app-managed env block. The bundle therefore carries the shell-rc env vars the
 * redeem helper writes to ~/.bashrc / ~/.zshrc (inside a delimited removable block),
 * plus the durable emit credential for ~/.tokenscope/config.json. The forwarder
 * lifecycle hooks are declared by the plugin's own hooks.json (NOT written by redeem).
 * See spec §2a and Slice 1.
 */
export interface CopilotBundle {
  /** Durable emit credential endpoints — the helper writes these to ~/.tokenscope/config.json. */
  TOKENSCOPE_BEARER_ENDPOINT: string
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: string
  TOKENSCOPE_OAUTH_CLIENT_ID: string
  /** The Azure Monitor DCR logs ingest URL for the file-forwarder. */
  TOKENSCOPE_LOGS_ENDPOINT: string
  /**
   * ADVISORY ONLY — a home-agnostic logical path (`~/.tokenscope/...`). The client
   * (copilot-redeem.mjs) MUST resolve its OWN absolute path from the client's home;
   * do NOT write this string to the filesystem as-is (the `~` will not expand). The
   * server cannot know the client's $HOME — this field exists for the bundle shape.
   */
  COPILOT_OTEL_FILE_EXPORTER_PATH: string
  /** Shell-rc env var the helper appends alongside the client-resolved path export. */
  OTEL_RESOURCE_ATTRIBUTES: string
  /** The attested instance UUID — the helper must emit EXACTLY this value. Security invariant. */
  instance_id: string
}

/**
 * Build the OTel telemetry bundle for an instance — the EXACT shape
 * setup/exchange.post returns (so the redeem endpoint mirrors it).
 * `projectCodeHash` null ⇒ untagged (no project.code_hash in the resource attrs).
 *
 * Takes the EVENT, not an origin string, deliberately. What this function bakes
 * is DURABLE: the bearer and OTLP endpoints land in the device's
 * `~/.claude/settings.json` / `~/.tokenscope/config.json` and are re-read for
 * the life of the enrolment, long after this request is forgotten. An origin
 * that is merely wrong (Container Apps rewrites `Host` to the internal CA FQDN,
 * which no developer machine can resolve) produces an enrolment that reports
 * success and then emits nothing, forever, with no error surfaced anywhere —
 * the failure mode that motivated APP_PUBLIC_ORIGIN in the first place. An
 * origin that is attacker-influenced is worse.
 *
 * Deriving it here rather than accepting a caller-supplied string means a future
 * third call site cannot forget the trust check: there is no parameter to get
 * wrong. Callers previously computed an identical
 * `getPublicRequestURL(event).origin` and passed it in, so this costs them
 * nothing.
 */
export function buildOtelBundle(
  event: H3Event,
  instanceId: string,
  projectCodeHash: string | null,
  tool: EmitTool = 'claude-code',
): { bearerEndpoint: string; oauthTokenEndpoint: string; bundle: OtelBundle | CopilotBundle } {
  // Belt and braces: both callers assert this at the top of the request, before
  // anything is consumed. Repeating it here means a future caller that forgets
  // cannot bake an untrusted origin into a durable credential.
  assertTrustedPublicOrigin(event)
  const origin = getPublicRequestURL(event).origin
  const bearerEndpoint = `${origin}/api/v1/instances/${instanceId}/bearer`
  const oauthTokenEndpoint = `${origin}/api/v1/oauth/token`
  const logsEndpoint =
    process.env.NUXT_AZURE_MONITOR_LOGS_ENDPOINT ??
    (process.env.NUXT_AZURE_MONITOR_ENDPOINT
      ? `${process.env.NUXT_AZURE_MONITOR_ENDPOINT}/v1/logs`
      : `${origin}/azmon-stub/v1/logs`)

  if (tool === 'copilot-cli') {
    // Copilot has no app-managed env block. The redeem helper writes these to:
    //   - ~/.tokenscope/config.json (durable emit credential)
    //   - ~/.bashrc / ~/.zshrc (shell-rc env vars, in a delimited block)
    // The forwarder lifecycle hooks come from the plugin's own hooks.json (NOT redeem).
    // CLIENT-local path: the redeem helper resolves the absolute path from the
    // CLIENT's own home. The server cannot know the client's $HOME — baking the
    // server container's $HOME here shipped `/home/tokenscope/...` to every client
    // (Copilot then wrote spans to a dir the forwarder never tailed → zero
    // telemetry). Send a home-agnostic logical path; copilot-redeem.mjs owns the
    // absolute resolution (from its own homedir) for both config.json and the rc env.
    const otelFilePath = '~/.tokenscope/copilot-otel.jsonl'
    const resourceAttrs = projectCodeHash
      ? `tokenscope.instance_id=${instanceId},project.code_hash=${projectCodeHash},tool=copilot-cli`
      : `tokenscope.instance_id=${instanceId},tool=copilot-cli`
    return {
      bearerEndpoint,
      oauthTokenEndpoint,
      bundle: {
        TOKENSCOPE_BEARER_ENDPOINT: bearerEndpoint,
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: oauthTokenEndpoint,
        TOKENSCOPE_OAUTH_CLIENT_ID: process.env.NUXT_OAUTH_CLIENT_ID ?? '',
        TOKENSCOPE_LOGS_ENDPOINT: logsEndpoint,
        COPILOT_OTEL_FILE_EXPORTER_PATH: otelFilePath,
        OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
        instance_id: instanceId,
      } satisfies CopilotBundle,
    }
  }

  // claude-code bundle (the existing shape — unchanged)
  const resourceAttrs = projectCodeHash
    ? `tokenscope.instance_id=${instanceId},project.code_hash=${projectCodeHash},tool=claude-code`
    : `tokenscope.instance_id=${instanceId},tool=claude-code`
  return {
    bearerEndpoint,
    oauthTokenEndpoint,
    bundle: {
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsEndpoint,
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      otel_headers_helper_url: bearerEndpoint,
      OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
    } satisfies OtelBundle,
  }
}

/**
 * Mint a durable EMIT credential bound to a specific instance, rotating out any
 * prior LIVE emit credential for that device (revoke them) so at most ONE is live
 * per instance ("no unbounded creds"). The new oauth_token row carries
 * instance_id (mig 0031). Scope stays tokenscope.emit ONLY — no widening.
 *
 * Imported lazily by the redeem endpoint via issueEmitCredential; this wrapper
 * adds the instance binding + rotation that the setup-token path doesn't need.
 */
export async function issueInstanceEmitCredential(
  db: Db,
  teammateId: string,
  instanceId: string,
  issue: (
    db: Db,
    teammateId: string,
  ) => Promise<{ clientId: string; tokens: { refresh_token: string } }>,
): Promise<{ clientId: string; refreshToken: string }> {
  // ONE transaction, serialized per instance. The rotate→issue→bind sequence has a
  // TOCTOU window: the freshly-INSERTed credential is invisible to the rotate's
  // `WHERE instance_id = X` until the bind sets it, so two concurrent redeems for
  // the SAME instance could each leave a live emit credential (R2 F1). An advisory
  // xact lock keyed on the instance makes the rotate see the in-flight insert; the
  // partial-unique index (mig 0033) is the hard backstop if a future path forgets.
  return db.transaction(async (tx) =>
    issueInstanceEmitCredentialTx(tx as unknown as Db, teammateId, instanceId, issue),
  )
}

/**
 * Transaction-participating body of issueInstanceEmitCredential (AUTH-1): the
 * redeem endpoint runs consume→check→mint→audit inside ONE transaction so a
 * mid-sequence failure rolls everything back to a redeemable handoff with the
 * old credential still live. `tx` MUST be an open transaction — the advisory
 * lock is pg_advisory_xact_lock (released at commit/rollback) and the
 * rotate→issue→bind sequence relies on the caller's atomicity.
 */
export async function issueInstanceEmitCredentialTx(
  tx: Db,
  teammateId: string,
  instanceId: string,
  issue: (
    db: Db,
    teammateId: string,
  ) => Promise<{ clientId: string; tokens: { refresh_token: string } }>,
): Promise<{ clientId: string; refreshToken: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${instanceId}))`)
  // A credential is bound only to a LIVE device of this teammate, under its row
  // lock. Ending a device revokes what is bound to it (mig 0141), so binding
  // after the end would mint a credential nothing ever revokes; the lock
  // orders a concurrent end after this bind, whose revoke then covers it.
  const live = await tx.execute(sql`
    SELECT 1 FROM instance_attestation
     WHERE instance_id = ${instanceId}::uuid
       AND teammate_id = ${teammateId}::uuid
       AND ts_actual_end IS NULL
       AND ts_purged IS NULL
       FOR UPDATE
  `)
  if ([...live].length === 0) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This device has ended; run setup again to enrol a fresh device.',
    })
  }
  await tx.execute(sql`
    UPDATE oauth_token SET revoked_at = now()
     WHERE instance_id = ${instanceId}::uuid
       AND revoked_at IS NULL
       AND scope = 'tokenscope.emit'
  `)
  const cred = await issue(tx, teammateId)
  // Bind the freshly-minted credential to this instance (issue() can't set it).
  await tx.execute(sql`
    UPDATE oauth_token SET instance_id = ${instanceId}::uuid
     WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}
  `)
  return { clientId: cred.clientId, refreshToken: cred.tokens.refresh_token }
}
