/*
 * GET /api/v1/instances/{instanceId}/bearer — refresh Azure Monitor Bearer.
 *
 * Per api-and-connector-interfaces.md §1.2. Auth-only (NOT the cookie); emission
 * stays direct-to-Azure (ADR-0003). OAUTH-ONLY: the presented Bearer must be an
 * OAuth `tokenscope.emit` access token (ADR-0005 — the durable, auto-refreshing
 * credential). The legacy per-instance 12h session token (the dead-end credential
 * superseded by OAuth) has been removed entirely — there is no Path A.
 *
 * Validated via requireOAuthBearer; the bound teammate must OWN this instance
 * (instance_attestation.teammate_id) and the instance must not be ended/revoked.
 *
 * OBO is mocked locally (server/auth/obo.ts); Epic 10 swaps in the real
 * @azure/identity flow.
 *
 * LANES (docs/design/rls-enforcement.md §2). This handler has TWO paths and they
 * do NOT get the same lane, which is the whole point of naming them:
 *
 *   - The AUTHENTICATED path runs in the MACHINE lane (`withMachineRls`) on the
 *     identity `requireOAuthBearer` just resolved. The OBO mint stays OUTSIDE
 *     that transaction — it is third-party HTTP.
 *   - The 401 CATCH path has NO identity, by construction: it exists precisely
 *     because the presented credential was REFUSED. It therefore runs on the
 *     platform pool, and is this file's entry in the CI allowlist. What keeps
 *     that work is that every RLS-enabled table it touches — `oauth_token`,
 *     `teammate`, `org_unit`, `instance_attestation` — is in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and is
 *     explicitly DISABLEd before the app connects as a non-owner.
 *     `instance_attestation` is NOT policy-free (RLS since mig 0002); omission
 *     from a FORCE phase would protect nothing, because ENABLE alone filters a
 *     non-owner. Re-enabling any of them breaks this path: `loadInstance` LEFT
 *     JOINs `teammate`, so the join yields NULLs, `instanceLifecycleSilent` stops
 *     seeing the deactivation/revocation arms, and an intentionally-retired
 *     device starts raising false "your emit credential failed" signals. Phase 2
 *     must answer that before it enables `teammate`.
 */
import { createError, defineEventHandler, getRouterParam, getRequestHeaders, setResponseHeader, type H3Event } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { withMachineRls } from '../../../../db/machine-rls'
import { requireOAuthBearer, presentedTokenInfo } from '../../../../auth/oauth-bearer'
import { mintAzureMonitorBearer } from '../../../../auth/obo'
import { deviceIdleWindowEnd } from '../../../../auth/oauth'
import { recordBearerAuthFailed, resolveBearerAuthFailed } from '../../../../db/instance-health'
import { assertInstanceLive, deviceEnded, instanceLifecycleSilent, loadInstance, type InstanceRow } from '../../../../auth/instance-lifecycle'
import { readClientVersionHeaders } from '../../../../utils/client-version'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  // safeParse → 400 (AUTH-7): a bare .parse throws a raw ZodError, which h3
  // surfaces as a 500.
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  const db = getDb()

  // ── OAuth emit-scoped access token — BEFORE any instance lookup ───────────
  // Authenticating first kills the unauthenticated existence oracle (AUTH-7):
  // an unauthenticated caller gets 401 for existing AND non-existing ids alike.
  //
  // Validate the token (signature/expiry/revocation + E2 teammate anchor vs
  // issuance) and require the tokenscope.emit scope. requireOAuthBearer throws a
  // 401 on any failure (incl. "not recognised" / missing header).
  //
  // A 401 here is the went-silent DISASTER signal (ADR-0005 d4): the durable emit
  // credential was REJECTED, so OTLP export silently stops. Record it as an
  // instance-health signal — but ONLY when (a) the instance is LIVE (a 401 on an
  // ended / E2-revoked instance is EXPECTED, not an anomaly), (b) the rejected
  // token genuinely belongs to THIS instance's owner, AND (c) it actually carries
  // tokenscope.emit and (when bound) is bound to THIS instance (AUTH-6 — a
  // rejected read/tag token is a misconfigured helper, not the emission disaster,
  // and must not open a false "your emit credential failed" alert). The
  // owner-check is the abuse guard: without it, anyone could POST a garbage token
  // to /bearer/{anyId} and forge a "your credential failed" alert to that
  // instance's teammate. A token hash that matches a stored oauth_token row for
  // the owner is un-forgeable proof it's the owner's real (now-failing)
  // credential — not a probe.
  let teammate
  try {
    // Pass `sid` so requireOAuthBearer's per-DEVICE binding check applies: an
    // emit credential minted for a DIFFERENT instance now 401s here instead
    // of silently degrading to a per-teammate check (the ADR-0008 §2 fix).
    teammate = await requireOAuthBearer(event, 'tokenscope.emit', db as never, sid)
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode === 401) {
      const row = await loadInstance(db, sid)
      const token = row ? await presentedTokenInfo(event, db as never) : null
      const isOwner = Boolean(row && token && token.teammateId === row.teammateId)
      const isEmit = Boolean(token?.scope.split(' ').includes('tokenscope.emit'))
      const boundHere = token?.instanceId === null || token?.instanceId === sid
      if (row && isOwner && isEmit && boundHere) {
        // Ending a device revokes its credential (mig 0141), so the owner's
        // token is refused above before the lifecycle gate can say why. Say it
        // here, to the owner only: an ended device is the diagnosis, and a
        // non-owner still gets the uniform 401.
        if (deviceEnded(row)) throw createError({ statusCode: 401, statusMessage: 'Session ended' })
        if (!instanceLifecycleSilent(row)) await recordBearerAuthFailed(db, sid)
      }
    }
    throw err
  }

  // From here the caller IS authenticated, so every DB statement runs in the
  // MACHINE lane on the credential's own identity. The OBO mint is deliberately
  // left until after the transaction commits — it is third-party HTTP, and
  // holding a request transaction across it is the anti-pattern design §2 names.
  const row = await withMachineRls(teammate, async (tx) => {
  // Row lock from the lifecycle check through the renewal below: session-gc
  // closing this device mid-request either lands first (the gate refuses) or
  // waits and re-checks the renewed window. Never a mint for an ended device.
  const row = await loadInstance(tx, sid, { lock: true })
  // Not-found AND not-owned collapse to the SAME 404 (mirrors
  // me/instances/[instanceId]/revoke.post.ts's "don't leak a peer's instance
  // existence with a 403" rule) — an unknown id and a peer's real instance
  // are now indistinguishable. The requireOAuthBearer binding check above
  // already turned a WRONG-instance credential into a 401 before we ever get
  // here; this 404 is reached only for a credential correctly bound to (or
  // permissively unbound from) `sid` whose TEAMMATE still doesn't own it.
  if (!row || !row.teammateId || row.teammateId !== teammate.teammateId) {
    throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
  }

  // The OWNER's credential is valid → clear any prior bearer-auth-failed signal
  // (recovery). After the ownership check, so a stranger's valid token can't
  // resolve someone else's open failure (the mirror of the record abuse guard).
  await resolveBearerAuthFailed(tx, sid)

  // Lifecycle gate (ended / E2-revoked). ts_expected_end is not read here; it is
  // session-gc's abandonment cue, and the stamp below renews it on every mint.
  assertInstanceLive(row)

  // Heartbeat (0030) + idle-window renewal. REQUIRED, not best-effort: this is
  // the write that keeps a device in use from being closed by session-gc
  // (`ts_expected_end`, `last_bearer_at`), and heartbeat-coverage verifies
  // emitted spend against it. If it fails, the mint fails and the helper
  // retries, rather than handing out a bearer while the device ages out.
  await tx
    .update(schema.instanceAttestation)
    .set({
      lastBearerAt: new Date(),
      tsExpectedEnd: sql`GREATEST(${schema.instanceAttestation.tsExpectedEnd}, ${deviceIdleWindowEnd()})`,
    })
    .where(eq(schema.instanceAttestation.instanceId, sid))

  // CLIENT VERSION (mig 0092) + PLATFORM / SURFACE (mig 0150): the client states
  // its plugin and CLI versions, `<os>-<arch>` and launch surface in request
  // headers; recording them here costs nothing extra per live device and
  // captures the version of the code that ACTUALLY minted this bearer. The rules
  // below apply to all four fields alike.
  //
  // The values are CLIENT-ASSERTED and are stored as diagnostic hints ONLY. Note
  // where this write sits: AFTER requireOAuthBearer, AFTER the ownership check.
  // That is deliberate — an unauthenticated or non-owning caller must not be able
  // to write a version claim onto someone else's instance row (the same abuse
  // guard the bearer-auth-failed signal above carries). It is still not a trust
  // upgrade: the OWNER can claim any version. Nothing may gate on these.
  //
  // Each field is written ONLY when that field was reported, and nothing is ever
  // nulled by a mint:
  //   - reports nothing (an old build predating the headers) → both columns keep
  //     whatever they held. Nulling would erase a previous reading the moment a
  //     device downgraded, collapsing "was on 0.1.27, stopped reporting" into
  //     "never reported" — different diagnoses. client_version_at is what tells
  //     them apart.
  //   - reports one field only (e.g. a Copilot CLI client, or a launch where the
  //     CLI version is not discoverable from the environment) → that field is
  //     updated and the other is preserved rather than blanked.
  // Consequence to know when reading the data: client_version_at is "when a
  // version claim was last recorded", not a per-column timestamp, so on a
  // partially-reporting client the un-updated column may be older than the stamp.
  //
  // Best-effort, in a savepoint: a caught SQL error inside a transaction leaves
  // the backend in 25P02 and would fail every later statement, so without the
  // savepoint "never fail the mint over a version claim" would be a comment,
  // not a behaviour.
  const claim = readClientVersionHeaders(getRequestHeaders(event))
  if (claim.reported) {
    try {
      await tx.transaction(async (sp) => {
        await sp
          .update(schema.instanceAttestation)
          .set({
            ...(claim.pluginVersion !== null ? { clientPluginVersion: claim.pluginVersion } : {}),
            ...(claim.cliVersion !== null ? { clientCliVersion: claim.cliVersion } : {}),
            ...(claim.platform !== null ? { clientPlatform: claim.platform } : {}),
            ...(claim.surface !== null ? { clientSurface: claim.surface } : {}),
            clientVersionAt: new Date(),
          })
          .where(eq(schema.instanceAttestation.instanceId, sid))
      })
    } catch {
      /* version capture is a diagnostic hint */
    }
  }

    return row
  })

  return mintFor(event, row)
})

/** Response header carrying the minted bearer's expiry, epoch seconds. */
export const BEARER_EXPIRES_AT_HEADER = 'X-TokenScope-Bearer-Expires-At'

async function mintFor(event: H3Event, row: InstanceRow) {
  const obo = await mintAzureMonitorBearer({
    principalOid: row.principalOid,
    sessionId: row.instanceId,
  })
  // The body is printed VERBATIM by the helper as Claude Code's header JSON, so
  // the expiry travels as a response header instead. The helper caches the
  // bearer against it and, when this endpoint is unreachable, keeps handing the
  // cached bearer back until Azure itself rejects it (#409) — the expiry is
  // diagnostics for the sentinel/status, never a gate on that fallback.
  setResponseHeader(event, BEARER_EXPIRES_AT_HEADER, String(Math.floor(Date.now() / 1000) + obo.expiresInSeconds))
  setResponseHeader(event, 'cache-control', 'no-store')
  return { Authorization: `Bearer ${obo.bearer}` }
}
