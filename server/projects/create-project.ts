/*
 * createProject — the one way a project comes into existence
 * (docs/design/project-requests/00-spec.md §2, A14). Callers: POST
 * /admin/projects (admin), POST /projects (PMO-list holder), and approving a
 * project request. Each caller does its OWN authorisation first; this service
 * only validates the data and writes, inside the caller's transaction:
 *
 *   project → audit `project-created` → PM assignment → baseline allocation
 *
 * PM and budget are optional for the admin caller (its response shape predates
 * them); the PMO and approval callers always pass both. Without a budget the
 * project stays not-onboarded, exactly as before.
 */
import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { allocation, project } from '../../drizzle/schema'
import { recordAuditEvent, type AuditActor } from '../db/audit'
import { assertOrgUnitInRegion } from '../db/org-units'
import { translatePgConstraintError } from '../utils/pg-constraint-error'
import type { ProjectCreatorActor } from '../auth/org-roles'
import type { BudgetInput } from './schemas'

type Tx = PostgresJsDatabase<typeof schema>

/** Recorded on the audit row: which door the project came through. */
export type CreateProjectSource = 'admin' | 'pmo' | `request:${string}` | `connector:${string}`

export interface CreateProjectInput {
  code: string
  display_name: string
  type: 'billable' | 'pursuit' | 'internal'
  region_id: string
  cost_owning_unit_id: string
  wbs_code?: string | null
  end_date?: string | null
  pm_teammate_id?: string | null
  budget?: BudgetInput | null
  /** Admin-only override for code-burn (D6); other callers never pass it. */
  allow_burned_code?: boolean
}

export interface CreateProjectContext {
  source: CreateProjectSource
  ipAddress?: string | null
  userAgent?: string | null
}

export interface CreateProjectResult {
  project: { id: string; code: string; isOnboarded: boolean }
  allocation: { id: string } | null
  pmAssignmentId: string | null
}

function problem(statusCode: number, title: string, detail: string): never {
  throw createError({
    statusCode,
    statusMessage: title,
    data: {
      type: `https://tokenscope.example.com/errors/${statusCode === 409 ? 'conflict' : 'unprocessable'}`,
      title,
      status: statusCode,
      detail,
    },
  })
}

function auditActor(actor: ProjectCreatorActor): AuditActor {
  return actor.kind === 'teammate'
    ? { actorTeammateId: actor.teammateId }
    : { actorSystem: `connector:${actor.connectorId}` }
}

/** The PM must be an existing, active, confirmed teammate (A2, A13). */
async function assertAssignableTeammate(tx: Tx, teammateId: string): Promise<{ email: string }> {
  const rows = await tx.execute<{ email: string; is_active: boolean; provisional: boolean }>(sql`
    SELECT email, is_active, provisional FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
  `)
  const row = [...rows][0]
  if (!row || !row.is_active || row.provisional) {
    problem(422, 'Invalid project manager', 'The project manager must be an existing, active teammate.')
  }
  return { email: row.email }
}

export async function createProject(
  tx: Tx,
  actor: ProjectCreatorActor,
  input: CreateProjectInput,
  ctx: CreateProjectContext,
): Promise<CreateProjectResult> {
  const actorTeammateId = actor.kind === 'teammate' ? actor.teammateId : null
  const audit = { ...auditActor(actor), ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null }

  // A retired or non-cost-owning unit is the "spend on a dead unit" hazard the
  // project-edit path also blocks; the two paths must agree.
  await assertOrgUnitInRegion(tx, {
    orgUnitId: input.cost_owning_unit_id,
    regionId: input.region_id,
    mustBeActive: true,
    mustBeCostOwning: true,
    statusMessage: 'cost_owning_unit_id is not an active Business Unit in this region',
    data: {
      type: 'https://tokenscope.example.com/errors/unprocessable',
      title: 'Invalid Business Unit',
      status: 422,
      detail: 'cost_owning_unit_id must reference an active Business Unit in the project\'s region.',
    },
  })

  const dupe = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM project WHERE code = ${input.code} LIMIT 1
  `)
  if ([...dupe][0]) {
    throw createError({ statusCode: 409, statusMessage: `Project code '${input.code}' already exists` })
  }

  // Code-burn (D6): a code that once carried attributed spend must not be reused
  // silently, or the new project inherits the dead one's history.
  if (!input.allow_burned_code) {
    const burned = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM audit_event
       WHERE event_type = 'project-deleted'
         AND payload->>'code' = ${input.code}
         AND (payload->>'had_attribution') = 'true'
       LIMIT 1
    `)
    if ([...burned][0]) {
      problem(
        409,
        'Project code is burned',
        `Code '${input.code}' previously belonged to a project that accrued attributed spend; reusing it would silently re-attribute that history. Choose a new code, or set allow_burned_code to override (typo recovery).`,
      )
    }
  }

  const pm = input.pm_teammate_id ? await assertAssignableTeammate(tx, input.pm_teammate_id) : null

  let created: { id: string; code: string } | undefined
  try {
    ;[created] = await tx
      .insert(project)
      .values({
        code: input.code,
        codeHash: createHash('sha256').update(input.code).digest('hex'),
        displayName: input.display_name,
        type: input.type,
        regionId: input.region_id,
        costOwningUnitId: input.cost_owning_unit_id,
        wbsCode: input.wbs_code ? input.wbs_code : null,
        endDate: input.end_date ? new Date(input.end_date) : null,
        isAuthorised: true,
        isOnboarded: !!input.budget,
        allocationMode: 'shared_pool',
        source: 'manual',
      })
      .returning({ id: project.id, code: project.code })
  } catch (err: unknown) {
    translatePgConstraintError(err, {
      '23505': {
        title: `Project code '${input.code}' already exists`,
        detail: 'A project with this code was created concurrently. Choose another code.',
      },
    })
  }
  const projectId = created!.id

  await recordAuditEvent(tx, {
    ...audit,
    eventType: 'project-created',
    subjectKind: 'project',
    subjectId: projectId,
    payload: {
      code: input.code,
      display_name: input.display_name,
      type: input.type,
      region_id: input.region_id,
      cost_owning_unit_id: input.cost_owning_unit_id,
      source: ctx.source,
      ...(input.pm_teammate_id ? { pm_teammate_id: input.pm_teammate_id } : {}),
      ...(input.end_date ? { end_date: input.end_date } : {}),
      // Forensic: a reused burned code is traceable to a decision.
      ...(input.allow_burned_code ? { allow_burned_code: true } : {}),
    },
  })

  let pmAssignmentId: string | null = null
  if (input.pm_teammate_id && pm) {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO project_assignment (project_id, teammate_id, effective, role, source)
      VALUES (${projectId}::uuid, ${input.pm_teammate_id}::uuid, tstzrange(now(), NULL, '[)'), 'manager', 'manual')
      RETURNING id::text AS id
    `)
    pmAssignmentId = [...rows][0]!.id
    await recordAuditEvent(tx, {
      ...audit,
      eventType: 'project-member-added',
      subjectKind: 'project',
      subjectId: projectId,
      payload: { teammate_id: input.pm_teammate_id, email: pm.email, role: 'manager', source: ctx.source },
    })
  }

  let baseline: { id: string } | null = null
  if (input.budget) {
    const effective = `[${input.budget.from},${input.budget.to})`
    // The allocation row carries its audit event id, so the audit row is written first.
    const evt = await recordAuditEvent(tx, {
      ...audit,
      eventType: 'allocation-created',
      subjectKind: 'project',
      subjectId: projectId,
      payload: { budget_usd: input.budget.amount_usd, effective, scope: 'project-pool', source: ctx.source },
    })
    const [row] = await tx
      .insert(allocation)
      .values({
        scopeType: 'project',
        scopeId: projectId,
        teammateId: null,
        budgetUsd: input.budget.amount_usd,
        effective,
        allocationKind: 'baseline',
        createdBy: actorTeammateId,
        auditEventId: evt.id,
        source: 'manual',
      })
      .returning({ id: allocation.id })
    baseline = { id: row!.id }
  }

  return {
    project: { id: projectId, code: created!.code, isOnboarded: !!input.budget },
    allocation: baseline,
    pmAssignmentId,
  }
}
