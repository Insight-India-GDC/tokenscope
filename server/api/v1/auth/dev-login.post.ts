/*
 * POST /api/v1/auth/dev-login — persona override (sandbox) / dev-mode persona switch.
 *
 * ALLOWLIST gate (security contract). The FIRST, structural floor is the env:
 * demo / act-as features run ONLY when the deployment is demo-capable
 * (NUXT_DEPLOY_ENV ∈ {local, sandbox}; shared/env/deploy-env.ts). dev / staging /
 * production / unknown — and a dropped NUXT_DEPLOY_ENV on a deployed container —
 * ALL refuse 404 BEFORE any flag or caller role is consulted, so no single flag
 * (NUXT_ALLOW_PERSONA_OVERRIDE, NUXT_OIDC_AUTH_DEV_MODE) can re-open impersonation
 * on a pilot-prod env. Then, on a demo-capable env:
 *
 *   a) NUXT_OIDC_AUTH_DEV_MODE=true (local-dev fallback — no Entra session) → dev
 *      OR
 *   b) NUXT_ALLOW_PERSONA_OVERRIDE=true AND the caller is a valid Entra-backed
 *      admin / platform-admin → override
 *
 *   Anything else → 404 (hard refuse; no signal-leak to a probing client).
 *
 * On allowed-override path (b), a `ts_persona_override` sidecar cookie is minted
 * carrying the persona's teammate id + the real admin's OID/email as impersonator
 * stamps — HMAC-signed so it can't be tampered with. This is the MINT side; the
 * READ side (server/utils/auth.ts resolveSession) is independently env-gated too —
 * it consults the cookie ONLY on a demo-capable env, so a stale/valid cookie is
 * inert off {local, sandbox}. UI displays "Acting as <admin>" so silent
 * impersonation is impossible.
 *
 * Every override writes an `audit_event` row with
 * `eventType='persona-impersonation'`; if the audit insert fails we
 * fail closed (no override applied).
 *
 * NO RLS LANE (docs/design/rls-enforcement.md; tracked as an explicit residue in
 * scripts/check-handler-rls-context.mjs). This is a LOGIN endpoint: on the
 * dev-mode branch there is no caller session at all — the persona teammate this
 * handler looks up is the identity being MINTED, not one being presented — so
 * there is nothing to put on the connection before the lookup that produces it.
 * The override branch does have an authenticated admin, but splitting one
 * handler across two lanes to convert half of it would leave the file on the
 * pool anyway and make the login path harder to reason about than the debt is
 * worth. What bounds the exposure is that the whole endpoint 404s off a
 * demo-capable env (`isDemoCapableEnv`, {local, sandbox} only), so it does not
 * exist on any environment where FORCE will be enabled.
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { eq } from 'drizzle-orm'
import { DevLoginBody } from '../../../../shared/schemas/auth'
import { getPersona } from '../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../auth/csrf'
import { tryAuth, isPersonaOverrideAllowed } from '../../../utils/auth'
import { setPersonaOverrideCookie } from '../../../utils/persona-override-cookie'
import { evaluatePersonaGate } from '../../../auth/persona-override'
import { currentServerDeployEnv, isDemoCapableEnv } from '../../../../shared/env/deploy-env'
import { getDb, schema } from '../../../db'
import { recordAuditEvent } from '../../../db/audit'

export default defineEventHandler(async (event) => {
  // ── Allowlist gate ──────────────────────────────────────────────
  const caller = await tryAuth(event)
  const verdict = evaluatePersonaGate(
    {
      devMode: process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true',
      allowOverride: isPersonaOverrideAllowed(),
      // ALLOWLIST (shared/env/deploy-env.ts): demo-capable ONLY for {local, sandbox}.
      // dev / staging / production / unknown refuse structurally — and a DROPPED
      // NUXT_DEPLOY_ENV on a deployed container (NODE_ENV=production) classifies to
      // 'unknown', so it fails closed rather than back to 'local'. This is the MINT
      // side of two independent enforcement points (the cookie READ in auth.ts is the
      // other) — both env-gated, either alone sufficient.
      demoCapable: isDemoCapableEnv(currentServerDeployEnv()),
    },
    caller,
  )
  if (!verdict.allowed) {
    if (verdict.status === 401) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthenticated',
        data: {
          type: 'https://tokenscope.example.com/errors/unauthenticated',
          title: 'Unauthenticated',
          status: 401,
          detail: 'Persona override requires a signed-in admin session.',
        },
      })
    }
    if (verdict.status === 403) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Persona override is restricted to Admins.',
        },
      })
    }
    // 404 — no signal leak about why.
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  // CSRF check BEFORE any DB I/O — a cross-origin POST shouldn't be able to
  // trigger a teammate lookup even if it would ultimately be rejected by
  // assertSameOrigin (load + timing-side-channel hardening, R1 F3).
  assertSameOrigin(event)

  // Track the real admin's identity for the impersonation-stamped
  // override + audit row. Empty in dev-mode (no Entra session to capture).
  let impersonatorOid: string | undefined
  let impersonatorEmail: string | undefined
  let actorTeammateId: string | null = null

  if (verdict.mode === 'override' && caller) {
    // Resolve the caller's Entra OID from their teammate row — the
    // tryAuth session carries teammateId, not OID directly (except
    // through impersonatorOid when already impersonating).
    const db = getDb()
    const [callerRow] = await db
      .select({ entraOid: schema.teammate.entraOid })
      .from(schema.teammate)
      .where(eq(schema.teammate.id, caller.teammateId))
      .limit(1)
    if (!callerRow) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Stale session',
        data: {
          type: 'https://tokenscope.example.com/errors/stale-session',
          title: 'Stale session',
          status: 401,
          detail: 'Calling session refers to a teammate that no longer exists.',
        },
      })
    }
    // If the caller is ALREADY impersonating, preserve the original
    // admin's OID — chaining overrides would otherwise lose the real
    // identity. The session.impersonatorOid is the durable anchor.
    impersonatorOid = caller.impersonatorOid ?? callerRow.entraOid
    impersonatorEmail = caller.impersonatorEmail ?? caller.email
    actorTeammateId = caller.teammateId
  }

  const body = await readValidatedBody(event, (data) => DevLoginBody.parse(data))
  const persona = getPersona(body.persona)
  if (!persona) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown persona' })
  }

  const db = getDb()
  const [tm] = await db
    .select({
      id: schema.teammate.id,
      email: schema.teammate.email,
      displayName: schema.teammate.displayName,
      regionId: schema.teammate.regionId,
      orgUnitId: schema.teammate.orgUnitId,
    })
    .from(schema.teammate)
    .where(eq(schema.teammate.email, persona.email))
    .limit(1)
  if (!tm) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Persona teammate row missing — run npm run db:seed',
    })
  }

  // ── Audit FIRST, then mint the new override ────────────────────
  // Recording first means an audit-insert failure aborts the override.
  // The caller's prior cookie state is untouched — fail-closed by
  // construction.
  if (impersonatorOid && impersonatorEmail) {
    await recordAuditEvent(db, {
      eventType: 'persona-impersonation',
      actorTeammateId: actorTeammateId,
      actorSystem: 'dev-login',
      subjectKind: 'teammate',
      subjectId: tm.id,
      payload: {
        actualOid: impersonatorOid,
        actualEmail: impersonatorEmail,
        personaKey: persona.key,
        personaEmail: tm.email,
        personaRole: persona.role,
        env: process.env.NODE_ENV ?? 'unknown',
      },
    })
  } else {
    // Dev-mode path — keep the legacy `dev-login` event shape so the
    // existing audit-stream consumers (tests, dashboards) don't break.
    await recordAuditEvent(db, {
      eventType: 'dev-login',
      actorTeammateId: tm.id,
      actorSystem: 'dev-login',
      subjectKind: 'teammate',
      subjectId: tm.id,
      payload: { persona: persona.key, role: persona.role, mode: 'dev' },
    })
  }

  // Mint the sidecar override cookie. tryAuth() on the next request
  // sees this, validates the impersonatorOid against the OIDC
  // identity (override path) or accepts it as the primary identity
  // (dev-mode path), and returns the persona's session.
  setPersonaOverrideCookie(event, {
    targetTeammateId: tm.id,
    issuedAt: new Date().toISOString(),
    ...(impersonatorOid ? { impersonatorOid } : {}),
    ...(impersonatorEmail ? { impersonatorEmail } : {}),
  })

  return { authenticated: true, landing: persona.landing, role: persona.role }
})
