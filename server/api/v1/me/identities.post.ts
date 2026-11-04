/*
 * POST /api/v1/me/identities { system, identifier, identifier_kind } — link
 * another identity (a Claude/GitHub/client email) to my account so its sessions
 * attribute to me.
 *
 * Integrity (self-service, trust-the-developer + audited): you cannot claim an
 * identity that is (a) another teammate's PRIMARY email, or (b) already linked
 * to anyone (enforced by the unique index on system+identifier). Linked
 * identities are `source='self'`, unverified (`verified_at IS NULL`) — visible
 * as such — and every link is audited. The poller backstop catches mis-claims
 * for reconciled orgs; indicative-org claims rely on uniqueness + audit. A
 * self-linked GitHub login counts as the claimant's usage, but its share of a
 * billed Copilot overage stays Unallocated until an admin binds it
 * (admin/reconciliation/github/map.post.ts).
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { translatePgConstraintError } from '../../../utils/pg-constraint-error'
import { advisoryXactLock } from '../../../db/advisory-lock'

/**
 * Most self-claimed (`source='self'`) identities one teammate may hold. A person
 * has a handful of Claude/GitHub/client logins; without a ceiling one caller
 * could squat an unbounded slice of the identifier namespace (D5).
 */
export const MAX_SELF_LINKED_IDENTITIES = 10

const Body = z.object({
  system: z.enum(['claude-code', 'github', 'copilot-cli', 'other']),
  // R2: constrain the charset. This value is persisted then interpolated into
  // the reader's KQL `in~ (...)` list on every untagged/telemetry/assign call;
  // the quote-doubling escape is the actual guard, but a charset floor keeps a
  // stored attacker-controlled value off that surface (mirrors resolve-by-repo).
  identifier: z.string().min(3).max(200).regex(/^[\w.@+-]+$/, 'invalid identifier characters'),
  identifier_kind: z.enum(['email', 'username']).default('email'),
})

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const identifier = body.identifier.trim().toLowerCase()

  const conflict = (detail: string) =>
    createError({
      statusCode: 409,
      statusMessage: 'Conflict',
      data: { type: 'https://tokenscope.example.com/errors/identity-conflict', title: 'Cannot link identity', status: 409, detail },
    })

  // Pre-checks + INSERT + audit in ONE transaction (SYS-3 idiom) so a link never
  // lands unaudited, and withRequestRls makes that transaction carry the caller's
  // RLS identity. The friendly pre-checks are racy by nature — a concurrent
  // duplicate claim slips past them and hits the unique index (system +
  // lower(identifier)); translate that 23505 into the same clean 409 instead of a
  // raw 500 (API-10).
  //
  // NOTE the `otherPrimary` probe reads OTHER teammates' rows deliberately: it is
  // an EXISTENCE check the caller is allowed to make (it can only ever say "taken",
  // never by whom). Nothing else backs it: primary emails are not map rows, so no
  // unique index catches the collision. It sees every region only because
  // `teammate` is an RLS bootstrap table (row-level security disabled). If it ever
  // leaves that set, move the probe into a SECURITY DEFINER function like
  // owner_active_unit_counts() (mig 0111).
  try {
    const id = await withRequestRls(event, async (tx) => {
      const [me] = await tx.execute<{ email: string }>(
        sql`SELECT email FROM teammate WHERE id = ${session.teammateId}::uuid`,
      )
      if (me && me.email.toLowerCase() === identifier) throw conflict('That is already your primary identity.')

      const [otherPrimary] = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM teammate
        WHERE lower(email) = ${identifier} AND id <> ${session.teammateId}::uuid LIMIT 1
      `)
      if (otherPrimary) throw conflict('That identity belongs to another teammate.')

      const [existing] = await tx.execute<{ teammate_id: string }>(sql`
        SELECT teammate_id::text AS teammate_id FROM teammate_identity_map
        WHERE system = ${body.system} AND lower(identifier) = ${identifier} LIMIT 1
      `)
      if (existing) {
        throw conflict(
          existing.teammate_id === session.teammateId
            ? 'Already linked to your account.'
            : 'That identity is linked to another teammate.',
        )
      }

      // Per-caller cap (D5). The principal lock serialises this teammate's
      // concurrent links so N parallel requests cannot all read the same
      // pre-insert count and land past the cap. Only self-claimed rows count:
      // directory/admin-sourced rows are not the caller's to spend.
      await tx.execute(advisoryXactLock('principal', session.teammateId))
      const [held] = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM teammate_identity_map
        WHERE teammate_id = ${session.teammateId}::uuid AND source = 'self'
      `)
      if ((held?.n ?? 0) >= MAX_SELF_LINKED_IDENTITIES) {
        throw conflict(
          `You already have ${MAX_SELF_LINKED_IDENTITIES} linked identities, the most allowed. Unlink one before adding another.`,
        )
      }

      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO teammate_identity_map (teammate_id, system, identifier, identifier_kind, source, is_canonical)
        VALUES (${session.teammateId}::uuid, ${body.system}, ${identifier}, ${body.identifier_kind}, 'self', false)
        RETURNING id::text AS id
      `)
      await recordAuditEvent(tx as never, {
        eventType: 'identity-linked',
        actorTeammateId: session.teammateId,
        actorSystem: 'me-identities',
        subjectKind: 'teammate',
        subjectId: session.teammateId,
        payload: { system: body.system, identifier, kind: body.identifier_kind, verified: false },
      })
      return row!.id
    })
    return { id, system: body.system, identifier, kind: body.identifier_kind, verified: false }
  } catch (err: unknown) {
    translatePgConstraintError(err, {
      '23505': {
        title: 'Cannot link identity',
        detail: 'That identity was linked concurrently (it already belongs to a teammate).',
      },
    })
  }
})
