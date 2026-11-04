/*
 * PATCH /api/v1/admin/projects/:id — edit a project (admin-project-lifecycle,
 * Screen 5 admin Projects tab).
 *
 * Admin / platform-admin only; a region admin is bounded to the project's own
 * region (requireRegionScope, applied after we read region_id inside the tx).
 *
 * All body fields are optional but at least one must be present (zod refine).
 * If cost_owning_unit_id is supplied it must be an ACTIVE (retired_at IS NULL)
 * org_unit in the SAME region as the project — same COU rule as
 * projects.post.ts, plus the soft-retire guard so spend can't be parked on a
 * retired cost centre. The UPDATE is built dynamically from the fields the
 * caller actually sent.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { assertOrgUnitInRegion } from '../../../../db/org-units'
import { applyRehome, RehomePlanStale, type RehomeRange } from '../../../../governance/rehome-spend'
import { resetReportCache } from '../../../../reporting/report-cache'
import { isRealUtcDay } from '#shared/schemas/activity'
import { displayText, PROJECT_NAME_MAX } from '#shared/schemas/display-text'
import { ProjectEndDateSchema } from '#shared/schemas/project-budget'
import { endDateAssignment } from '../../../../projects/end-date'

/**
 * The fields that actually WRITE to `project`. Named because the body also
 * carries migrate INSTRUCTIONS, which must not satisfy "you changed something".
 */
const MUTABLE_FIELDS = [
  'display_name',
  'client_facing_name',
  'type',
  'cost_owning_unit_id',
  'wbs_code',
  'is_authorised',
  'end_date',
] as const

const Body = z
  .object({
    display_name: displayText(PROJECT_NAME_MAX).optional(),
    client_facing_name: displayText(PROJECT_NAME_MAX).optional(),
    type: z.enum(['billable', 'pursuit', 'internal']).optional(),
    cost_owning_unit_id: z.string().uuid().optional(),
    /*
     * MIGRATE (docs/design/rehome-spend-on-manual-move.md). Re-home the §A usage
     * already recorded against this project onto the new Business Unit.
     *
     * ABSENT ⇒ today's behaviour exactly: the BU changes for FUTURE usage only,
     * because `attribution_record.cost_owning_unit_id` is stamped at write time
     * and never refreshed. That default is deliberate — an automated graph move
     * is a REORG and must never rewrite history.
     *
     * PRESENT ⇒ a human in admin is correcting what automation got wrong, which
     * is a different act. Only reachable here; `placement-service.ts` cannot
     * see this field.
     *
     * `from: 'all'` needs `confirm_unbounded` because "every month this project
     * has ever had" is a materially different request from "since March", and an
     * unbounded restatement should be stated rather than defaulted into.
     */
    migrate_spend: z
      .union([
        z.object({
          // A REAL day, not just the shape: the regex alone admits 2026-02-31,
          // which reaches Postgres's ::date cast and aborts the query — a 500
          // on a plain caller error. `isRealUtcDay` is the repo's boundary
          // check for exactly this.
          from: z.string().refine(isRealUtcDay, 'not a real calendar day'),
        }),
        z.object({ from: z.literal('all'), confirm_unbounded: z.literal(true) }),
      ])
      .optional(),
    /**
     * The token from the preview. MANDATORY whenever `migrate_spend` is present
     * (refined below): optional, it let a caller restate spend having never been
     * shown what would move, which defeats the preview entirely.
     */
    migrate_expect_token: z.string().optional(),
    // Finance-system WBS code. A non-empty string sets it; null or '' clears it.
    wbs_code: z
      .union([
        z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid WBS code'),
        z.literal(''),
        z.null(),
      ])
      .optional(),
    is_authorised: z.boolean().optional(),
    // Project end (D1). An ISO timestamp sets the end (now = "retire now",
    // a future value = a planned end); null clears it (re-open / un-end).
    // Setting end_date is NOT retroactive over already-frozen attribution rows
    // — only future events spill (D2). See docs/design/project-lifecycle.md.
    // Shared with the PM's PATCH /projects/{id}/timeline.
    end_date: ProjectEndDateSchema.optional(),
  })
  /*
   * "At least one field" is not enough once the migrate fields exist: they are
   * INSTRUCTIONS, not columns. `{ migrate_expect_token: 'x' }` satisfied the
   * check, contributed nothing to the SET list, and produced `UPDATE project
   * SET  WHERE …` — a 500 from a request that validated.
   */
  .refine((d) => MUTABLE_FIELDS.some((k) => d[k] !== undefined), {
    message: 'At least one project field must be provided',
  })
  // The preview is the whole safety mechanism; a migrate without its token has
  // restated spend nobody was shown.
  .refine((d) => d.migrate_spend === undefined || d.migrate_expect_token !== undefined, {
    message: 'migrate_spend requires migrate_expect_token from a preview',
    path: ['migrate_expect_token'],
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid project id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid project id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const projectId = parsedId.data

  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  /*
   * Captured OUT of the transaction so the post-commit cache drop below can be
   * a plain read rather than a cast back through the response shape.
   */
  let migratedRows = 0

  const result = await withRequestRls(event, async (tx) => {
    // `cost_owning_unit_id` is read too: a migrate has to name the BU it moved
    // spend AWAY from, and after the UPDATE that value is gone.
    const existing = await tx.execute<{ id: string; region_id: string; cost_owning_unit_id: string | null }>(sql`
      SELECT id::text AS id, region_id::text AS region_id,
             cost_owning_unit_id::text AS cost_owning_unit_id
      FROM project WHERE id = ${projectId}::uuid LIMIT 1
    `)
    const projectRow = [...existing][0]
    if (!projectRow) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project matches the supplied id (or RLS denied access).',
        },
      })
    }

    // Region-scope check — admin caller cannot mutate a project outside
    // their home region. (platform-admin is unbounded.)
    await requireRegionScope(event, projectRow.region_id)

    // Migrating spend without saying where to is not a request anyone can mean.
    if (body.migrate_spend !== undefined && body.cost_owning_unit_id === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage: 'migrate_spend requires cost_owning_unit_id',
        data: {
          type: 'https://tokenscope.example.com/errors/invalid-input',
          title: 'Nothing to migrate to',
          status: 400,
          detail:
            'migrate_spend re-homes recorded usage onto the project\'s NEW Business Unit, so cost_owning_unit_id must be supplied in the same request.',
        },
      })
    }

    // If reassigning the cost-owning unit it must exist, be ACTIVE
    // (retired_at IS NULL) AND live in the project's region.
    if (body.cost_owning_unit_id !== undefined) {
      await assertOrgUnitInRegion(tx, {
        orgUnitId: body.cost_owning_unit_id,
        regionId: projectRow.region_id,
        mustBeActive: true,
        mustBeCostOwning: true,
        statusMessage: 'cost_owning_unit_id is not an active Business Unit in this region',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Invalid Business Unit',
          status: 422,
          detail:
            'cost_owning_unit_id must reference an active (not retired) org unit in the project\'s region.',
        },
      })
    }

    // Build the UPDATE dynamically from the provided fields only.
    const sets: SQL[] = []
    const changed: Record<string, unknown> = {}
    if (body.display_name !== undefined) {
      sets.push(sql`display_name = ${body.display_name}`)
      changed.display_name = body.display_name
    }
    if (body.client_facing_name !== undefined) {
      sets.push(sql`client_facing_name = ${body.client_facing_name}`)
      changed.client_facing_name = body.client_facing_name
    }
    if (body.wbs_code !== undefined) {
      // '' / null both clear it; a value sets it.
      const wbs = body.wbs_code ? body.wbs_code : null
      sets.push(wbs === null ? sql`wbs_code = NULL` : sql`wbs_code = ${wbs}`)
      changed.wbs_code = wbs
    }
    if (body.type !== undefined) {
      sets.push(sql`type = ${body.type}`)
      changed.type = body.type
    }
    if (body.cost_owning_unit_id !== undefined) {
      sets.push(sql`cost_owning_unit_id = ${body.cost_owning_unit_id}::uuid`)
      changed.cost_owning_unit_id = body.cost_owning_unit_id
    }
    if (body.is_authorised !== undefined) {
      sets.push(sql`is_authorised = ${body.is_authorised}`)
      changed.is_authorised = body.is_authorised
    }
    if (body.end_date !== undefined) {
      sets.push(endDateAssignment(body.end_date))
      changed.end_date = body.end_date
    }

    const updated = await tx.execute<{
      id: string
      code: string
      display_name: string
      type: string
      cost_owning_unit_id: string
      is_authorised: boolean
      end_date: string | null
    }>(sql`
      UPDATE project
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${projectId}::uuid
      RETURNING id::text AS id, code, display_name, type,
                cost_owning_unit_id::text AS cost_owning_unit_id, is_authorised,
                end_date::text AS end_date
    `)
    const updatedRow = [...updated][0]!

    /*
     * MIGRATE — after the project's own BU is set, in the SAME transaction. A
     * re-home that commits without its move (or the reverse) leaves the ledger
     * disagreeing with the org, which is the exact failure this feature exists
     * to end.
     */
    let migrated: Awaited<ReturnType<typeof applyRehome>> | null = null
    if (body.migrate_spend !== undefined) {
      try {
        migrated = await applyRehome(tx, {
          projectId,
          toCostOwningUnitId: body.cost_owning_unit_id!,
          range: body.migrate_spend as RehomeRange,
          expectToken: body.migrate_expect_token,
        })
      } catch (e) {
        if (e instanceof RehomePlanStale) {
          /*
           * 409, not 500: nothing is wrong, the world moved between preview and
           * apply. The CURRENT plan rides along so the UI can re-confirm rather
           * than making the admin start again blind.
           *
           * NAME THE CASE THAT ACTUALLY HAPPENS. `scopePredicate` excludes rows
           * already sitting on the destination, so a re-plan finding NOTHING
           * means the spend is already there. The most common way to reach that
           * is a first attempt whose transaction committed after the browser
           * gave up waiting — a large migration takes minutes and nothing on
           * the server aborts it. Telling that admin "usage was recorded, moved
           * or closed" describes three things that did not happen and hides the
           * one that did: their change landed.
           *
           * `refused` MUST be empty for that claim to hold. `totalRows` counts
           * `affected` only, so a plan whose rows all fell below the archive
           * floor between preview and apply also reads zero — and those rows did
           * NOT move. Promising an admin their change landed when it was refused
           * is worse than the vague message this replaces.
           */
          const alreadyThere = e.current.totalRows === 0 && e.current.refused.length === 0
          throw createError({
            statusCode: 409,
            statusMessage: 'Migration preview is stale',
            data: {
              type: 'https://tokenscope.example.com/errors/conflict',
              title: alreadyThere ? 'That spend has already moved' : 'The spend to migrate changed',
              status: 409,
              detail: alreadyThere
                ? 'Every record in that range is already on the new Business Unit, so there was nothing left to move and nothing was applied. If an earlier attempt appeared to time out, it did land.'
                : 'Usage was recorded, moved or closed since the preview, so the migration was not applied. Re-check the figures and confirm again.',
              current_plan: e.current,
            },
          })
        }
        throw e
      }
      migratedRows = migrated?.updated ?? 0
    }

    await recordAuditEvent(tx, {
      eventType: 'project-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: projectId,
      payload: {
        region_id: projectRow.region_id,
        changed,
        /*
         * A RESTATEMENT OF ATTRIBUTED SPEND, so the audit row has to be able to
         * reconstruct it: where it came FROM (gone from `project` after the
         * UPDATE above, which is why it was read before), where it went, the
         * range asked for, what actually moved, and what was refused and why.
         */
        ...(migrated
          ? {
              migrate_spend: {
                /*
                 * EVERY source, not the project's current one. A project's
                 * history can carry several BUs, so auditing "B → C" off the
                 * project's present value loses that A moved too — and a
                 * finance reconstruction would look for the money in the wrong
                 * place. `project_from` is kept beside it because the project's
                 * own field is a different fact from the rows' stamps.
                 */
                from_cost_owning_units: migrated.fromCostOwningUnits,
                project_from_cost_owning_unit_id: projectRow.cost_owning_unit_id,
                to_cost_owning_unit_id: body.cost_owning_unit_id,
                range: body.migrate_spend,
                // MEASURED, not planned: a period can close while this waits on
                // its lock, and the plan's dollars would then claim money moved
                // that did not.
                rows_updated: migrated.updated,
                usd_moved: migrated.appliedUsd,
                usd_planned: migrated.totalUsd,
                periods_affected: migrated.affected.map((p) => p.periodMonth),
                periods_refused: migrated.refused,
                days_affected: migrated.affectedDays,
              },
            }
          : {}),
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: updatedRow.id,
      code: updatedRow.code,
      display_name: updatedRow.display_name,
      type: updatedRow.type,
      cost_owning_unit_id: updatedRow.cost_owning_unit_id,
      is_authorised: updatedRow.is_authorised,
      end_date: updatedRow.end_date,
      // Present only when a migrate ran, so an untouched caller's response shape
      // is byte-identical to before.
      ...(migrated
        ? {
            migrated: {
              rows_updated: migrated.updated,
              usd_moved: migrated.appliedUsd,
              periods_affected: migrated.affected,
              periods_refused: migrated.refused,
            },
          }
        : {}),
    }
  })

  /*
   * DROP THE REPORT CACHE — AFTER THE COMMIT, and the ordering is the whole
   * point.
   *
   * Reports are cached for 60s, so without this an admin who has just corrected
   * a Business Unit reloads and sees the OLD figure — indistinguishable from
   * the change having done nothing, which is the entire reason this feature
   * exists.
   *
   * Clearing it INSIDE the transaction (where this first lived) is worse than
   * not clearing it at all: the reset lands while the migrate is still
   * uncommitted, any request in that window reads the PRE-migrate ledger and
   * re-populates the cache from it, and the commit then leaves that stale
   * answer pinned for the full TTL. A cache invalidation that runs before its
   * own write is visible is an invalidation that guarantees the stale read.
   *
   * PER-PROCESS, and honestly so: other instances keep their own entries until
   * the TTL expires, and the ADMIN'S OWN BROWSER holds the response under
   * `Cache-Control: private, max-age=60`, which no server-side reset can reach.
   * The dialog says a minute rather than implying an atomic cutover.
   */
  if (migratedRows > 0) resetReportCache()

  return result
})
