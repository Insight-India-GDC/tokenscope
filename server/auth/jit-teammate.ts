/*
 * JIT teammate creator — invoked on the first Entra OIDC sign-in.
 *
 * Wave-V deliverable. On every fetch of the nuxt-oidc-auth session
 * (sessionHooks.hook('fetch', ...)), we resolve the OIDC claims to an
 * app-side teammate row:
 *
 *   - If a teammate with entra_oid = claims.oid exists, reuse it.
 *   - Otherwise JIT-create with role 'platform-admin' when the email matches
 *     the bootstrapAdminEmail env var; 'developer' otherwise. The home is what
 *     the directory derives within a short budget (server/auth/jit-placement.ts):
 *     a cost-owning unit, or a region's `__UNPLACED__` holding node; when it
 *     places nothing in time, the default region's holding node. Never a region ROOT:
 *     its subtree is the whole region, and an org node's subtree is an RLS
 *     boundary (S3).
 *
 * The resulting teammate's identity is then minted into our HMAC'd
 * `ts_session` cookie via setSession(). This keeps app-level RBAC + RLS
 * uniform across dev-mode and Entra: every downstream request reads the
 * same Session interface regardless of how it got there.
 */
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import * as schema from '../../drizzle/schema'
import { isRole, type Role } from '../../shared/auth/roles'
import { recordAuditEvent } from '../db/audit'
import { isExcludedUpn, loadDirectoryExclusionPatterns } from '../utils/directory-exclusions'
import { pinJitHome, resolveJitPlacement, type JitPlacementOptions } from './jit-placement'

// Read the bootstrap-admin email at function-call time rather than module
// load (R1 F10 was a LOW finding; moving to module-scope const broke the
// existing per-test env-mutation pattern in persona-override.test.ts).
// The env-var read is one string trim + lowercase, called at most once
// per OIDC session-fetch — the hot-path cost is negligible. The DURABLE
// anchor is teammate.role (migration 0005); this env var only seeds the
// FIRST sign-in's role.
function getBootstrapAdminEmail(): string {
  return process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL?.toLowerCase().trim() ?? ''
}

/** Postgres unique-violation (SQLSTATE 23505). Drizzle WRAPS the postgres-js error
 *  ("Failed query: …") with the real `.code` on `.cause`, so walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e != null && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') return true
  }
  return false
}

export interface OidcClaims {
  oid: string
  email: string
  name?: string
  /** The sign-in UPN (Entra `preferred_username`), lowercased — the axis the
   *  directory-exclusion policy matches on (#121). Optional: if the token
   *  doesn't carry it the JIT guard fails open (matches nobody). */
  upn?: string
}

export interface ResolvedTeammate {
  teammateId: string
  email: string
  displayName: string
  role: Role
  regionId: string
  orgPath: string
  /**
   * Revocation columns, read in the SAME query as the identity so the normal
   * session path can judge revocation without a re-read
   * (docs/design/request-floor-performance.md F2). Semantics are the caller's
   * (server/utils/auth.ts isRevoked doc): `revokedAt` is a session ANCHOR,
   * `isActive` is durable deactivation.
   */
  revokedAt: Date | null
  isActive: boolean
  created: boolean
}

/**
 * resolveOrCreateTeammate — idempotent. Safe to call on every session
 * fetch. The lookup is by entra_oid (unique-indexed), so multiple
 * concurrent first-touch requests for the same OID race onto the same
 * row via ON CONFLICT DO NOTHING.
 */
export async function resolveOrCreateTeammate(
  db: PostgresJsDatabase<typeof schema>,
  claims: OidcClaims,
  placementOpts: JitPlacementOptions = {},
): Promise<ResolvedTeammate> {
  // Fast path — existing teammate by OID. (No exclusion query on the hot path;
  // an already-provisioned privileged row is retired by the
  // privileged-identity-cleanup worker + is_active gate, not here.)
  const existing = await loadTeammateByOid(db, claims.oid)
  if (existing) return { ...existing, created: false }

  // DIRECTORY-EXCLUSION guard (#121): a privileged/service account (matched by
  // an admin exclusion pattern on its UPN) must never BECOME a teammate — not
  // via a picker, not via assign, and not via its own interactive sign-in. We
  // check here, on the first-touch (adopt/create) path only, BEFORE the
  // bootstrap-admin role resolution below — so a privileged account can't
  // self-provision even a developer row, let alone match the bootstrap email
  // and mint platform-admin. Fail-open (no patterns / no UPN → not excluded).
  const patterns = await loadDirectoryExclusionPatterns(db)
  // Observability (the service-principal / mutable-claim gap): when a policy is
  // configured but this token carries no UPN, the guard CANNOT evaluate and
  // fails open — record it so an operator can see how often the guard is blind
  // (an app-only / service-principal token is the likeliest to slip silently).
  if (patterns.length > 0 && !claims.upn) {
    await recordAuditEvent(db, {
      eventType: 'teammate-jit-no-upn',
      actorSystem: 'oidc-callback',
      subjectKind: 'teammate',
      subjectId: null,
      payload: { oid: claims.oid, email: claims.email },
    })
  }
  if (isExcludedUpn(claims.upn, patterns)) {
    await recordAuditEvent(db, {
      eventType: 'teammate-jit-excluded',
      actorSystem: 'oidc-callback',
      subjectKind: 'teammate',
      subjectId: null,
      payload: { oid: claims.oid, upn: claims.upn ?? null, email: claims.email },
    })
    throw createError({
      statusCode: 403,
      statusMessage: 'Excluded identity',
      data: {
        type: 'https://tokenscope.example.com/errors/excluded-identity',
        title: 'Excluded identity',
        status: 403,
        detail: `${claims.upn ?? claims.email} is a privileged/service account and cannot be used with TokenScope. Sign in with your standard account.`,
      },
    })
  }

  // BIND-OR-ADOPT (bill-driven placement, H2): a user may already exist as a REAL
  // (non-provisional) teammate provisioned from a provider bill, keyed on a
  // placeholder `entra_oid='bill:'||uuid`. Adopt that row — set its real oid — so
  // bill-existence and this login converge on ONE teammate (else the create below
  // would hit the email partial-unique and 500 the sign-in). Guarded to ONLY
  // overwrite a `bill:` placeholder, never a real oid (no identity hijack).
  try {
    const adopted = await db.execute<{ id: string }>(sql`
      UPDATE teammate
      SET entra_oid = ${claims.oid}, source = 'entra',
          display_name = COALESCE(display_name, ${claims.name ?? null}), last_sync_at = now()
      WHERE lower(email) = lower(${claims.email}) AND NOT provisional AND entra_oid LIKE 'bill:%'
      RETURNING id::text AS id`)
    if (adopted.length > 0) {
      const reloaded = await loadTeammateByOid(db, claims.oid)
      if (reloaded) {
        await recordAuditEvent(db, {
          eventType: 'teammate-bill-adopted',
          actorTeammateId: reloaded.teammateId,
          actorSystem: 'oidc-callback',
          subjectKind: 'teammate',
          subjectId: reloaded.teammateId,
          payload: { oid: claims.oid, email: claims.email },
        })
        return { ...reloaded, created: false }
      }
    }
  } catch (err) {
    // 23505 on entra_oid = a concurrent first-login already took claims.oid; fall
    // through and reload-by-oid below. Anything else is a real error.
    if (!isUniqueViolation(err)) throw err
    const raced = await loadTeammateByOid(db, claims.oid)
    if (raced) return { ...raced, created: false }
  }

  const placement = await resolveJitPlacement(db, claims.oid, placementOpts)

  // The bootstrap email is the platform super-admin; everyone else is 'developer'.
  const bootstrapEmail = getBootstrapAdminEmail()
  const resolvedRole: Role =
    bootstrapEmail && claims.email.toLowerCase() === bootstrapEmail ? 'platform-admin' : 'developer'

  // INSERT ... ON CONFLICT (entra_oid) DO NOTHING handles the race
  // where two concurrent first-touch requests for the same OID land
  // simultaneously. `.returning({ id })` makes the race-winner detectable:
  // - non-empty → THIS caller's insert created the row → audit fires
  // - empty     → THIS caller lost the race → reload + skip audit
  // (R1 F4 — without this, concurrent first-touch produced duplicate
  // `teammate-jit-created` audit rows.)
  let inserted: { id: string }[]
  let home = placement
  try {
    inserted = await db.transaction(async (tx) => {
      home = await pinJitHome(tx, placement)
      return tx
        .insert(schema.teammate)
        .values({
          entraOid: claims.oid,
          email: claims.email,
          displayName: claims.name ?? claims.email,
          role: resolvedRole,
          regionId: home.regionId,
          orgUnitId: home.orgUnitId,
          metadata: sql`(${JSON.stringify(home.provenance)}::jsonb || jsonb_build_object('placedAt', now()))`,
        })
        .onConflictDoNothing({ target: schema.teammate.entraOid })
        .returning({ id: schema.teammate.id })
    })
  } catch (err) {
    // onConflictDoNothing only absorbs the entra_oid conflict. A 23505 here is the
    // EMAIL partial-unique: a real, non-`bill:` teammate already owns this email
    // under a different oid (the adopt above only takes `bill:` placeholders). That
    // is an admin-actionable identity collision, not a transient — surface it
    // clearly rather than 500 with a raw constraint name (H2 terminal state).
    if (isUniqueViolation(err)) {
      // Record the collision so an admin can SEE the cause (M4). Without this, the
      // caller swallows the throw into a silent 401 loop with no operator signal. The
      // colliding teammate's id is looked up cheaply (lower(email), NOT provisional,
      // not a `bill:` placeholder — the real-identity slots the adopt above could not
      // take); if it can't be resolved we leave subjectId null and keep the email in
      // the payload. Audit BEFORE the throw so the row is written even though the
      // sign-in fails.
      const [collider] = await db
        .select({ id: schema.teammate.id })
        .from(schema.teammate)
        .where(
          sql`lower(${schema.teammate.email}) = lower(${claims.email})
              AND NOT ${schema.teammate.provisional}
              AND ${schema.teammate.entraOid} NOT LIKE 'bill:%'`,
        )
        .limit(1)
      await recordAuditEvent(db, {
        eventType: 'teammate-bind-collision',
        actorSystem: 'oidc-callback',
        subjectKind: 'teammate',
        subjectId: collider?.id ?? null,
        payload: { email: claims.email, oid: claims.oid },
      })
      throw new Error(
        `JIT teammate bind failed: email ${claims.email} is already owned by another identity (oid ${claims.oid} differs). Resolve the duplicate teammate before this user can sign in.`,
        { cause: err },
      )
    }
    throw err
  }

  const reloaded = await loadTeammateByOid(db, claims.oid)
  if (!reloaded) {
    throw new Error(
      `JIT teammate creation failed: insert succeeded but row not visible for oid=${claims.oid}.`,
    )
  }

  // Audit only when THIS caller actually created the row (race winner).
  // The race loser observed a row created by a concurrent caller, who is
  // responsible for emitting the audit event — they have the same claims.
  if (inserted.length > 0) {
    await recordAuditEvent(db, {
      eventType: 'teammate-jit-created',
      actorTeammateId: reloaded.teammateId,
      actorSystem: 'oidc-callback',
      subjectKind: 'teammate',
      subjectId: reloaded.teammateId,
      payload: {
        oid: claims.oid,
        email: claims.email,
        name: claims.name ?? null,
        role: reloaded.role,
        bootstrapMatch: resolvedRole === 'platform-admin',
        placement: { ...home.outcome, regionId: home.regionId, orgUnitId: home.orgUnitId },
      },
    })
  }

  return { ...reloaded, created: inserted.length > 0 }
}

async function loadTeammateByOid(
  db: PostgresJsDatabase<typeof schema>,
  oid: string,
): Promise<Omit<ResolvedTeammate, 'created'> | null> {
  // ONE query: teammate + org_unit.path + revocation columns
  // (docs/design/request-floor-performance.md F2). LEFT JOIN, not INNER: a
  // missing org_unit is data corruption and must throw loudly below — an INNER
  // JOIN would silently drop the row and turn corruption into a 401.
  const [row] = await db
    .select({
      id: schema.teammate.id,
      email: schema.teammate.email,
      displayName: schema.teammate.displayName,
      role: schema.teammate.role,
      regionId: schema.teammate.regionId,
      orgUnitId: schema.teammate.orgUnitId,
      revokedAt: schema.teammate.revokedAt,
      isActive: schema.teammate.isActive,
      orgPath: schema.orgUnit.path,
    })
    .from(schema.teammate)
    .leftJoin(schema.orgUnit, eq(schema.orgUnit.id, schema.teammate.orgUnitId))
    .where(eq(schema.teammate.entraOid, oid))
    .limit(1)
  if (!row) return null

  if (row.orgPath == null) {
    throw new Error(
      `Teammate ${row.id} references missing org_unit ${row.orgUnitId} — investigate before continuing.`,
    )
  }

  // Stored role wins. Defensive: if the DB ever carries an unexpected
  // value (manual SQL, future migration drift), fall back to 'developer'
  // rather than letting RBAC fail open.
  const role: Role = isRole(row.role) ? row.role : 'developer'

  return {
    teammateId: row.id,
    email: row.email,
    displayName: row.displayName ?? row.email,
    role,
    regionId: row.regionId,
    orgPath: row.orgPath,
    revokedAt: row.revokedAt,
    isActive: row.isActive,
  }
}
