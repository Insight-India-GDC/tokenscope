/*
 * POST /api/v1/instances/{instanceId}/claude-sessions — "Claude session S runs
 * on this instance" (#494). Body `{ "claudeSessionId": "<uuid>" }`, 204.
 *
 * Sent by the plugin's SessionStart hook with THIS install's emit credential. A
 * tagged repo's settings carry the whole OTEL_RESOURCE_ATTRIBUTES, instance id
 * included, so when Claude Code CLI and Claude Desktop open one repo both emit
 * with whichever install wrote the file last. This report is how the read-joiner
 * learns which install a session really ran on; it books the session's rows to
 * the reported instance only when that is the same teammate's as the instance
 * the records name (docs/design/session-instance-report.md). A report about
 * another teammate's session therefore moves nothing: it is counted and ignored.
 *
 * Auth as /end and /bearer: an OAuth `tokenscope.emit` Bearer bound to THIS
 * instance, checked before any lookup (AUTH-7: no unauthenticated existence
 * oracle); the bound teammate must own the instance (not-found and not-owned
 * are the same 404) and the instance must be live (the /bearer lifecycle gate).
 *
 * LANE: machine (docs/design/rls-enforcement.md §2), one withMachineRls
 * transaction for lookup, rate check and insert.
 *
 * Idempotent: SessionStart fires again on resume, /clear and compaction with the
 * same session id, and each repeat is a no-op. Not audited: one row per session
 * per install, and the row itself is the record.
 *
 * Rate limit: REPORTS_PER_HOUR new sessions per instance per hour, else 429. A
 * teammate can only report on their own instance, so the limit bounds table
 * growth from a looping client, not an attack on anyone else.
 */
import { createError, defineEventHandler, getRouterParam, readValidatedBody, setResponseStatus } from 'h3'
import { and, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { withMachineRls } from '../../../../db/machine-rls'
import { requireOAuthBearer } from '../../../../auth/oauth-bearer'
import { assertInstanceLive, loadInstance } from '../../../../auth/instance-lifecycle'

const SidSchema = z.string().uuid()

/*
 * Claude Code's session.id is a lowercase UUID. The joiner matches it byte for
 * byte against the record's Attributes['session.id'], so it is normalised here
 * and held to the same shape the table's CHECK enforces. Not z.uuid(): that
 * also demands version and variant nibbles, which is a claim about Claude Code
 * we do not need to make.
 */
const Body = z.object({
  claudeSessionId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
})

export const REPORTS_PER_HOUR = 60

export default defineEventHandler(async (event) => {
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  // Authenticate FIRST, before the body is read or any row is looked up.
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', getDb() as never, sid)

  const body = await readValidatedBody(event, (d) => Body.safeParse(d))
  if (!body.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid claudeSessionId' })
  }
  const claudeSessionId = body.data.claudeSessionId

  await withMachineRls(teammate, async (tx) => {
    // FOR UPDATE on the instance row: serialises this instance's reports, so two
    // concurrent ones cannot both pass the rate check below at the limit.
    const row = await loadInstance(tx, sid, { lock: true })
    if (!row || !row.teammateId || row.teammateId !== teammate.teammateId) {
      throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
    }
    assertInstanceLive(row)

    const [existing] = await tx
      .select({ one: sql<number>`1` })
      .from(schema.sessionInstanceReport)
      .where(
        and(
          eq(schema.sessionInstanceReport.instanceId, sid),
          eq(schema.sessionInstanceReport.claudeSessionId, claudeSessionId),
        ),
      )
      .limit(1)
    if (existing) return

    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.sessionInstanceReport)
      .where(
        and(
          eq(schema.sessionInstanceReport.instanceId, sid),
          gt(schema.sessionInstanceReport.reportedAt, sql`now() - interval '1 hour'`),
        ),
      )
    if ((recent?.n ?? 0) >= REPORTS_PER_HOUR) {
      throw createError({ statusCode: 429, statusMessage: 'Too many session reports' })
    }

    await tx
      .insert(schema.sessionInstanceReport)
      .values({ claudeSessionId, instanceId: sid })
      .onConflictDoNothing()
  })

  setResponseStatus(event, 204)
  return null
})
