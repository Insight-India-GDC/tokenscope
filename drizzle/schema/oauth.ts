/*
 * OAuth 2.1 Authorization Server tables (ADR-0005 — the credential pathway).
 *
 * TokenScope is an MCP OAuth provider: Claude Code's MCP client registers
 * dynamically (RFC 7591), runs the authorization-code + PKCE flow (RFC 7636),
 * and exchanges/refreshes tokens. a sibling project's reference stores this in Redis;
 * TokenScope has no Redis in MVP, so the AS state lives in Postgres.
 *
 * Secrets discipline (mirrors instance_attestation.session_token_hash):
 *   - client_secret, auth codes, and access/refresh tokens are NEVER stored in
 *     plaintext. Only the HMAC-SHA-256 hash (server/auth/hmac.ts::hashSessionToken)
 *     lives here. The raw value is returned to the client ONCE.
 *   - auth codes are single-use: consume = UPDATE ... WHERE consumed_at IS NULL
 *     RETURNING (atomic; prevents replay across concurrent exchanges).
 *   - tokens carry an explicit revoked_at + expiry; requireOAuthBearer joins
 *     teammate.revoked_at for the ADR-0005 E2 revocation cascade.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { teammate } from './identity'
import { instanceAttestation } from './instance-attestation'

export const oauthClient = pgTable('oauth_client', {
  // RFC 7591 dynamic registration. client_id is a public identifier; the
  // secret hash is the confidential credential validated at the token endpoint.
  clientId: uuid('client_id').primaryKey().default(sql`gen_random_uuid()`),
  clientSecretHash: text('client_secret_hash').notNull(),
  clientName: text('client_name').notNull().default('MCP Client'),
  // Loopback-only redirect URIs (RFC 8252) for CLI/desktop clients — validated
  // at registration time. Stored as a Postgres text[] array.
  redirectUris: text('redirect_uris').array().notNull(),
  // Server-controlled marker for THE single internal emit client (ADR-0005).
  // Public /oauth/register ALWAYS writes false; only ensureEmitClient writes
  // true. token.post.ts keys its public-emit path off this, never client_name —
  // so an attacker registering the name 'tokenscope-emit' gains nothing. A
  // partial unique index (migration 0024) enforces at most one internal row.
  internal: boolean('internal').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthAuthCode = pgTable('oauth_auth_code', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // HMAC hash of the raw code; the raw 32-byte code goes to the client in the
  // redirect. Unique so a lookup is a single indexed row.
  codeHash: text('code_hash').notNull().unique(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  // Space-delimited granted scope string (RFC 6749 §3.3).
  scope: text('scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Single-use marker. NULL = unconsumed; set atomically on exchange.
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  // Set only when the exchange issued a token (mig 0145); consumed_at is also
  // set by a failed exchange.
  tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
  // Mint time of the cookie session that approved the consent (mig 0168, #431).
  // The exchange refuses the code if teammate.revoked_at is later. NULL only
  // for codes minted before 0168.
  sessionIssuedAt: timestamp('session_issued_at', { withTimezone: true }),
})

export const oauthToken = pgTable('oauth_token', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  accessTokenHash: text('access_token_hash').notNull().unique(),
  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  // accessIssuedAt is the ADR-0005 E2 anchor for the ACCESS token (requireOAuthBearer
  // compares teammate.revoked_at > accessIssuedAt). It is BUMPED on every
  // non-rotating refresh, so it tracks the freshest access token.
  accessIssuedAt: timestamp('access_issued_at', { withTimezone: true }).notNull().defaultNow(),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
  // refreshIssuedAt is the STABLE E2 anchor for the REFRESH credential — set
  // once at issuance, never bumped. refreshAccessToken compares
  // teammate.revoked_at > refreshIssuedAt so a teammate revoked after the
  // credential was granted can no longer mint fresh access tokens (a bumped
  // accessIssuedAt would otherwise let a revoked teammate keep refreshing).
  refreshIssuedAt: timestamp('refresh_issued_at', { withTimezone: true }).notNull().defaultNow(),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
  // Set on revoke OR superseded by a refresh (the old row is revoked when a
  // new token set is issued). NULL = live.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // One-deep refresh grace window (mig 0044, AUTH-3): the refresh UPDATE parks
  // the outgoing access-token hash here with a ~60 s validity horizon, so a
  // concurrent refresher's just-superseded access token keeps working long
  // enough to avoid the invalidation ping-pong (one shared emit refresh token
  // per host — see the 2026-06-05 dogfood incident). requireOAuthBearer accepts
  // prevAccessTokenHash only while prevValidUntil > now().
  prevAccessTokenHash: text('prev_access_token_hash'),
  prevValidUntil: timestamp('prev_valid_until', { withTimezone: true }),
  // Grant-lifecycle activity (mig 0030): last time this credential was used —
  // stamped INSIDE the refresh UPDATE (no extra hot-path write) + best-effort on
  // MCP tool calls. Drives the active/inactive(14d) state. NULL = never used yet
  // (state derives from COALESCE(last_used_at, created_at)).
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // Per-device binding for EMIT credentials provisioned via provision_emit→redeem
  // (mig 0031). Lets re-provisioning the SAME instance rotate-and-revoke the prior
  // emit credential so at most one is live per device ("no unbounded creds",
  // mcp-client-backbone §F2.3). NULL for read/tag credentials and legacy
  // setup-token emit credentials (no MCP instance binding).
  instanceId: uuid('instance_id').references(() => instanceAttestation.instanceId, {
    onDelete: 'set null',
  }),
})

/*
 * emit_handoff — one-time, short-TTL (~5 min) device-provisioning handoff
 * (mcp-client-backbone §"One auth → also provisions the device").
 *
 * provision_emit (read-scoped MCP tool) mints a handoff bound to (teammate,
 * instance) and returns ONLY the raw code + a redeem URL — NEVER the durable emit
 * refresh token (that broadly-readable secret must not enter the LLM's context).
 * The local emit-redeem helper redeems it process→server for the durable
 * credential + the OTel bundle. Same secrets discipline as setup_token /
 * oauth_auth_code: only the HMAC hash is stored, single-use via an atomic CAS on
 * consumed_at.
 */
export const emitHandoff = pgTable('emit_handoff', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // HMAC hash of the raw handoff code; raw value goes to the tool caller once.
  codeHash: text('code_hash').notNull().unique(),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id, { onDelete: 'cascade' }),
  instanceId: uuid('instance_id')
    .notNull()
    .references(() => instanceAttestation.instanceId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Single-use marker. NULL = unconsumed; set atomically on redeem.
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
