/*
 * POST /api/v1/admin/projects — register a new project (Journey 3a
 * onboarding, Screen 5 admin Projects tab).
 *
 * Admin / platform-admin only; a region admin is bound to their own
 * region (requireRegionScope). The cost-owning unit must belong to the
 * same region. code_hash = SHA-256(code) per data-model.md §project.
 * Created authorised + not-yet-onboarded; the first allocation flips
 * is_onboarded (see POST /api/v1/allocations).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { assertOrgUnitInRegion } from '../../../db/org-units'
import { project } from '../../../../drizzle/schema'
import { displayText, PROJECT_NAME_MAX } from '#shared/schemas/display-text'

const Body = z.object({
  code: z.string().min(2).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid project code'),
  display_name: displayText(PROJECT_NAME_MAX),
  type: z.enum(['billable', 'pursuit', 'internal']),
  region_id: z.string().uuid(),
  cost_owning_unit_id: z.string().uuid(),
  // Optional finance-system WBS code (correlation only). Structured-identifier
  // charset; '' is accepted and stored as NULL ("not set").
  wbs_code: z
    .union([
      z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid WBS code'),
      z.literal(''),
    ])
    .optional(),
  // Admin override for code-burn (D6) — typo recovery. Lets a code that
  // previously belonged to an attributed-then-deleted project be reused.
  allow_burned_code: z.boolean().optional(),
})

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  await requireRegionScope(event, body.region_id)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // The cost-owning unit must exist AND be in the requested region.
    // The cost-owning unit (an ORG_UNIT) must be ACTIVE (org_unit.retired_at IS
    // NULL — distinct from project.end_date) — parking a new project on a retired
    // cost centre is the same "spend on a dead unit" hazard the project-edit path
    // already blocks (adversarial R1 M4); the two paths must be consistent.
    await assertOrgUnitInRegion(tx, {
      orgUnitId: body.cost_owning_unit_id,
      regionId: body.region_id,
      mustBeActive: true,
      statusMessage: 'cost_owning_unit_id is not an active org unit in this region',
    })

    // Unique code guard (the table has a UNIQUE constraint; pre-check for
    // a clean 409 instead of a raw constraint error).
    const dupe = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM project WHERE code = ${body.code} LIMIT 1
    `)
    if ([...dupe][0]) {
      throw createError({ statusCode: 409, statusMessage: `Project code '${body.code}' already exists` })
    }

    // Code-burn (D6) — a code whose code_hash once belonged to a project that
    // accrued PROJECT-ATTRIBUTED rows must not be silently reused, or the new
    // project would inherit the dead one's history. Detected from the deletion
    // audit trail (the project row itself is gone). BACKSTOP: under the strict
    // four-way DELETE (D4) an attributed project can't be removed at all, so
    // had_attribution is always false today — this only bites once an
    // admin-override delete path records had_attribution: true. Override with
    // allow_burned_code for typo recovery.
    if (!body.allow_burned_code) {
      const burned = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM audit_event
         WHERE event_type = 'project-deleted'
           AND payload->>'code' = ${body.code}
           AND (payload->>'had_attribution') = 'true'
         LIMIT 1
      `)
      if ([...burned][0]) {
        throw createError({
          statusCode: 409,
          statusMessage: `Project code '${body.code}' is burned`,
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Project code is burned',
            status: 409,
            detail:
              `Code '${body.code}' previously belonged to a project that accrued attributed spend; reusing it would silently re-attribute that history. Choose a new code, or set allow_burned_code to override (typo recovery).`,
          },
        })
      }
    }

    const [created] = await tx
      .insert(project)
      .values({
        code: body.code,
        codeHash: sha256Hex(body.code),
        displayName: body.display_name,
        type: body.type,
        regionId: body.region_id,
        costOwningUnitId: body.cost_owning_unit_id,
        wbsCode: body.wbs_code ? body.wbs_code : null,
        isAuthorised: true,
        isOnboarded: false,
        allocationMode: 'shared_pool',
        source: 'manual',
      })
      .returning({ id: project.id, code: project.code })

    await recordAuditEvent(tx, {
      eventType: 'project-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: created!.id,
      payload: {
        code: body.code,
        display_name: body.display_name,
        type: body.type,
        region_id: body.region_id,
        cost_owning_unit_id: body.cost_owning_unit_id,
        // Forensic: record when a code-burn (D6) was overridden, so a reused
        // code that re-inherits attributed history is traceable to a decision.
        ...(body.allow_burned_code ? { allow_burned_code: true } : {}),
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: created!.id, code: created!.code, is_onboarded: false }
  })
})
