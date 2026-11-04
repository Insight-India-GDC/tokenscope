/*
 * Create one org unit: the validation, LTREE path and audit event of
 * POST /admin/org-units, shared with POST /admin/org-setup/units.
 *
 * LTREE care: the path is built from a derived label (the code, lowercased with
 * any non [a-z0-9_] char folded to '_') because LTREE labels accept only
 * [A-Za-z0-9_]. Two distinct codes can fold to the same label, so the derived
 * path is guarded for uniqueness in the region as well as (region_id, code). The
 * path is written via raw sql with a ::ltree cast (Drizzle's customType can't
 * parameterise the cast).
 *
 * A region's only parentless units are its `default` unit and its holding node
 * (docs/design/org-setup/01-second-run-fixes.md, item 1): a null parent means
 * `default`, and nothing is created at or under the holding node.
 *
 * Every refusal throws before any write, so a caller may retry inside the same
 * savepoint.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from './audit'
import { assertHoldingNodeNotCostOwning } from './org-units'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'

type Tx = PostgresJsDatabase<typeof schema>

/** Org unit codes as the create door accepts them. */
export const ORG_UNIT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const ORG_UNIT_CODE_MIN = 2
export const ORG_UNIT_CODE_MAX = 60

/** 'default' is reserved for a region's root unit, planted by regions.post.ts. */
export const RESERVED_ORG_UNIT_CODE = 'default'

const SLUG_SUFFIX_ROOM = 4

/** "Cloud & Data" → "cloud-data": a legal code with room for a "-NN" suffix. */
export function unitCodeSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, ORG_UNIT_CODE_MAX - SLUG_SUFFIX_ROOM)
    .replace(/^-+|-+$/g, '')
  if (s.length >= ORG_UNIT_CODE_MIN) return s
  return s ? `bu-${s}` : 'bu'
}

export interface OrgUnitCreateInput {
  regionId: string
  parentId: string | null
  code: string
  displayName: string
  unitType: string
  isCostOwningUnit: boolean
}

export interface OrgUnitCreated {
  id: string
  code: string
  path: string
  isCostOwningUnit: boolean
}

/** 'CSL-DRP' → 'csl_drp', 'as.svc' → 'as_svc'. */
export function deriveLabel(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

/** The region's own root, planted with the region; never moved or recoded. */
export function isRegionDefaultUnit(u: { code: string; parent_id: string | null }): boolean {
  return u.code === RESERVED_ORG_UNIT_CODE && u.parent_id === null
}

export function isHoldingUnit(u: { unit_type: string }): boolean {
  return u.unit_type === HOLDING_UNIT_TYPE
}

/** The region's active `default` unit, or null when the region has none. */
export async function regionDefaultUnit(
  tx: Pick<Tx, 'execute'>,
  regionId: string,
): Promise<{ id: string; path: string } | null> {
  const rows = await tx.execute<{ id: string; path: string }>(sql`
    SELECT id::text AS id, path::text AS path FROM org_unit
    WHERE region_id = ${regionId}::uuid AND code = ${RESERVED_ORG_UNIT_CODE}
      AND parent_id IS NULL AND retired_at IS NULL
    LIMIT 1
  `)
  return [...rows][0] ?? null
}

/**
 * Serialises the region's path-changing writes (create, Move, code change): `path` has no
 * unique constraint, so two writers that each pass the collision check could commit the same
 * path. A row lock on the region, not an advisory lock, so it stays outside the advisory
 * namespace ordering the owner assignment after a create depends on. NO KEY UPDATE conflicts
 * with itself but not with the KEY SHARE an ordinary foreign-key insert takes.
 */
export async function lockRegionUnitPaths(tx: Pick<Tx, 'execute'>, regionId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM region WHERE id = ${regionId}::uuid FOR NO KEY UPDATE`)
}

/** True when `path` is one of the region's holding nodes or anywhere beneath one. */
export async function isAtOrUnderHoldingNode(
  tx: Pick<Tx, 'execute'>,
  regionId: string,
  path: string,
): Promise<boolean> {
  const rows = await tx.execute<{ hit: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM org_unit
      WHERE region_id = ${regionId}::uuid AND unit_type = ${HOLDING_UNIT_TYPE}
        AND ${path}::ltree <@ path
    ) AS hit
  `)
  return [...rows][0]?.hit === true
}

export function orgUnitProblem(statusCode: 409 | 422, statusMessage: string, detail: string) {
  const conflict = statusCode === 409
  return createError({
    statusCode,
    statusMessage,
    data: {
      type: `https://tokenscope.example.com/errors/${conflict ? 'conflict' : 'unprocessable'}`,
      title: conflict ? 'Conflict' : 'Unprocessable',
      status: statusCode,
      detail,
    },
  })
}

/** The caller checks RBAC and region scope; this checks the unit itself. */
export async function createOrgUnit(
  tx: Tx,
  input: OrgUnitCreateInput,
  audit: { actorTeammateId: string; ipAddress: string | null; userAgent: string | null },
): Promise<OrgUnitCreated> {
  // Without this, a non-root unit coded 'default' would blind
  // placedBelowRegionRootPredicate()'s naming arm (see org-subtree-scope.ts).
  if (input.code === RESERVED_ORG_UNIT_CODE) {
    throw orgUnitProblem(
      409,
      `Org unit code 'default' is reserved`,
      `The code 'default' is reserved for a region's root org unit (created automatically when the region is created) and cannot be assigned to another unit.`,
    )
  }
  assertHoldingNodeNotCostOwning({ unitType: input.unitType, isCostOwningUnit: input.isCostOwningUnit })

  await lockRegionUnitPaths(tx, input.regionId)
  const label = deriveLabel(input.code)
  let parentId = input.parentId
  let parentPath: string
  if (parentId) {
    const parentRows = await tx.execute<{ path: string; region_id: string; retired_at: string | null }>(sql`
      SELECT path::text AS path, region_id::text AS region_id, retired_at
      FROM org_unit WHERE id = ${parentId}::uuid LIMIT 1
    `)
    const parent = [...parentRows][0]
    if (!parent) throw orgUnitProblem(422, 'parent_id does not exist', 'parent_id does not reference an existing org unit.')
    if (parent.retired_at) throw orgUnitProblem(422, 'parent org unit is retired', 'Cannot create a child under a retired org unit.')
    if (parent.region_id !== input.regionId) {
      throw orgUnitProblem(422, 'parent org unit is in a different region', 'parent_id must belong to the same region as region_id.')
    }
    if (await isAtOrUnderHoldingNode(tx, input.regionId, parent.path)) {
      throw orgUnitProblem(
        422,
        'parent org unit is the Unplaced holding node',
        'Nothing can be created under the Unplaced holding node. Choose a real Business Unit as the parent.',
      )
    }
    parentPath = parent.path
  } else {
    const root = await regionDefaultUnit(tx, input.regionId)
    if (!root) {
      throw orgUnitProblem(
        422,
        'region has no default unit',
        `This region has no active 'default' unit to place a new unit under. Choose a parent.`,
      )
    }
    parentId = root.id
    parentPath = root.path
  }
  const path = `${parentPath}.${label}`

  const dupeCode = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE region_id = ${input.regionId}::uuid AND code = ${input.code} LIMIT 1
  `)
  if ([...dupeCode][0]) {
    throw orgUnitProblem(
      409,
      `Org unit code '${input.code}' already exists in this region`,
      `An org unit with code '${input.code}' already exists in this region.`,
    )
  }
  const dupePath = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE region_id = ${input.regionId}::uuid AND path = ${path}::ltree LIMIT 1
  `)
  if ([...dupePath][0]) {
    throw orgUnitProblem(
      409,
      `Org unit path '${path}' already exists in this region`,
      `The code '${input.code}' derives LTREE path '${path}', which already exists in this region. Choose a code that yields a distinct label.`,
    )
  }

  const insertedRows = await tx.execute<{ id: string }>(sql`
    INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, source)
    VALUES (
      ${input.regionId}::uuid,
      ${parentId}::uuid,
      ${path}::ltree,
      ${input.code},
      ${input.displayName},
      ${input.unitType},
      ${input.isCostOwningUnit},
      'manual'
    )
    RETURNING id::text AS id
  `)
  const created = [...insertedRows][0]
  if (!created) throw createError({ statusCode: 500, statusMessage: 'org unit insert returned no row' })

  await recordAuditEvent(tx, {
    eventType: 'org-unit-created',
    actorTeammateId: audit.actorTeammateId,
    actorSystem: 'admin-ui',
    subjectKind: 'org-unit',
    subjectId: created.id,
    payload: {
      code: input.code,
      path,
      region_id: input.regionId,
      parent_id: parentId,
      display_name: input.displayName,
      unit_type: input.unitType,
      is_cost_owning_unit: input.isCostOwningUnit,
    },
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
  })
  return { id: created.id, code: input.code, path, isCostOwningUnit: input.isCostOwningUnit }
}
