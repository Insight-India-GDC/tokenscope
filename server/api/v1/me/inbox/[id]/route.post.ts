/*
 * POST /api/v1/me/inbox/{id}/route — forward an inbox item to another
 * recipient.
 *
 * Inserts a new inbox_item row addressed to the target recipient with
 * the same category + severity + body; marks the source item
 * `ack_state = 'resolved'` with the audit trail noting the forward.
 *
 * Common use: an over-budget alert routed to the wrong manager gets
 * forwarded to the correct one; admin re-routes a sync-conflict to the
 * right SRE.
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { InboxRouteBody } from '../../../../../../shared/schemas/inbox'
import { schema } from '../../../../../db'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

interface SourceRow extends Record<string, unknown> {
  id: string
  category: string
  severity: string
  subject: string
  body: unknown
  related_entity_kind: string | null
  related_entity_id: string | null
  region_id: string
}

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  // Admin-only. NOTE: RLS is still inert in every deployed environment (no
  // FORCE ROW LEVEL SECURITY; the app connects as the table owner), so the
  // inbox_item `FOR ALL` policy does not execute TODAY — this requireRole, plus
  // the explicit requireRegionScope calls below on BOTH the source item's
  // recipient and the forward target, are the live gates. Every query below
  // nonetheless carries the caller's RLS identity, so the day `inbox_item` gets
  // FORCE (design §Rollout, phase 2) the policy composes with these checks rather than
  // meeting a context-less connection. See the phase-2 note on the forward.
  const session = await requireRole(event, 'admin')
  const sourceId = requireUuidParam(event, 'id', 'inbox item id')
  const body = await readValidatedBody(event, (data) => InboxRouteBody.parse(data))

  // Read the source inside the RLS context. `inbox_item_self` admits it via the
  // per-recipient arm for one's own item, or the role arm (platform-admin /
  // platform-admin post-0098) for someone else's.
  const sources = await withRequestRls(event, async (tx) =>
    tx.execute<SourceRow>(sql`
      SELECT ii.id::text AS id, ii.category, ii.severity, ii.subject, ii.body,
             ii.related_entity_kind, ii.related_entity_id::text AS related_entity_id,
             t.region_id::text AS region_id
      FROM inbox_item ii
      JOIN teammate t ON t.id = ii.recipient_teammate_id
      WHERE ii.id = ${sourceId}::uuid
      LIMIT 1
    `),
  )
  const source = sources[0]
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: 'Inbox item not found' })
  }
  // Region-scope the SOURCE: a region admin may only read (and therefore
  // forward) an item addressed to a recipient in their own region. An unknown
  // id is a 404 and another region's id is a 403, so the status does tell a
  // region admin that a foreign id exists. Accepted: ids are v4 uuids the
  // caller must already hold, and an item's existence is not sensitive here.
  await requireRegionScope(event, source.region_id)

  // Validate the target teammate is active, then forward — ONE transaction for
  // the target check + forward + resolve + audit (API-2): a partial failure
  // would otherwise leave a forwarded copy with the source still open
  // (double-forwarding) or an unaudited cross-recipient insert.
  //
  // THE CROSS-RECIPIENT INSERT, MADE EXPLICIT. This handler writes an
  // inbox_item addressed to SOMEONE ELSE, which is the one thing the
  // `inbox_item_self` policy's per-recipient arm exists to stop. It was
  // previously done on the bare pool ("Insert outside RLS — the new recipient
  // isn't this session's user"), i.e. by having no RLS identity at all; under
  // FORCE that INSERT simply errors. It now runs under the ADMIN's identity and
  // is authorised by the policy's ROLE arm, not by an absence of context.
  //
  // KNOWN PHASE-2 GAP, stated so it is not discovered in production: mig 0098
  // rewrote `inbox_item_self`'s role arm from `IN ('global-finops','admin')` to
  // `IN ('global-finops','platform-admin')`, and `FOR ALL` with no WITH CHECK
  // means that USING expression also gates INSERT. So once `inbox_item` enters
  // the FORCE set (design §Rollout, phase 2) a REGION `admin` — whom requireRole above
  // still admits — will be refused by the policy, while platform-admin /
  // platform-admin succeed. That is a policy question for phase 2, not
  // something a handler can paper over: reaching for the context-less pool to
  // dodge it is exactly the leak this change removes.
  const forwardedId = await withRequestRls(event, async (tx) => {
    const [target] = await tx
      .select({
        id: schema.teammate.id,
        isActive: schema.teammate.isActive,
        regionId: schema.teammate.regionId,
      })
      .from(schema.teammate)
      .where(eq(schema.teammate.id, body.recipient_teammate_id))
      .limit(1)
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'Target teammate not found' })
    }
    // Region-scope the TARGET: stops the mirror-image leak — a region-A admin
    // injecting a forwarded item into region B.
    await requireRegionScope(event, target.regionId)
    if (!target.isActive) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Target teammate is inactive',
        data: {
          type: 'https://tokenscope.example.com/errors/inactive-teammate',
          title: 'Cannot forward inbox item to inactive teammate',
          status: 422,
          detail:
            `Teammate ${body.recipient_teammate_id} is is_active=false. ` +
            'Pick an active teammate or reactivate the target first.',
        },
      })
    }

    const [forwarded] = await tx
      .insert(schema.inboxItem)
      .values({
        recipientTeammateId: body.recipient_teammate_id,
        category: source.category,
        severity: source.severity,
        subject: `[Forwarded] ${source.subject}`,
        body: {
          forwarded_from_teammate_id: session.teammateId,
          forwarded_from_inbox_item_id: source.id,
          reason: body.reason ?? null,
          original_body: source.body,
        },
        relatedEntityKind: source.related_entity_kind,
        relatedEntityId: source.related_entity_id,
      })
      .returning({ id: schema.inboxItem.id })

    // Mark source resolved.
    await tx.execute(sql`
      UPDATE inbox_item
      SET ack_state = 'resolved', ack_at = NOW(), ack_by = ${session.teammateId}::uuid
      WHERE id = ${sourceId}::uuid
    `)

    await recordAuditEvent(tx as never, {
      eventType: 'inbox-routed',
      actorTeammateId: session.teammateId,
      actorSystem: 'inbox',
      subjectKind: 'inbox_item',
      subjectId: sourceId,
      payload: {
        forwarded_to_teammate_id: body.recipient_teammate_id,
        new_inbox_item_id: forwarded?.id ?? null,
        reason: body.reason ?? null,
      },
    })

    return forwarded?.id ?? null
  })

  return { source_id: sourceId, forwarded_id: forwardedId }
})
