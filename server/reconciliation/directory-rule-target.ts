/*
 * Resolve a directory rule's target: a unit rule's region is the unit's own (read,
 * never supplied), and the unit must be able to receive spend. Shared by the rule
 * upsert and the placement-check rule preview.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { assertCostOwningTarget } from '../db/place-teammate'

type Tx = PostgresJsDatabase<typeof schema>

export interface DirectoryRuleTarget {
  regionId: string
  regionCode: string
  orgUnitId: string | null
}

function unprocessable(detail: string): never {
  throw createError({
    statusCode: 422,
    statusMessage: detail,
    data: { type: 'https://tokenscope.example.com/errors/unprocessable', title: 'Unprocessable', status: 422, detail },
  })
}

/** Takes the unit FOR SHARE, so a writer's assert holds until its commit. */
export async function resolveDirectoryRuleTarget(
  tx: Tx,
  body: { region_id?: string; org_unit_id?: string },
): Promise<DirectoryRuleTarget> {
  let regionId: string
  let orgUnitId: string | null = null
  if (body.org_unit_id) {
    const unitRows = await tx.execute<{ region_id: string }>(sql`
      SELECT region_id::text AS region_id
      FROM org_unit WHERE id = ${body.org_unit_id}::uuid LIMIT 1 FOR SHARE
    `)
    const unit = [...unitRows][0]
    if (!unit) unprocessable('org_unit_id must reference an org unit that exists.')
    await assertCostOwningTarget(tx, body.org_unit_id)
    regionId = unit.region_id
    orgUnitId = body.org_unit_id
  } else {
    regionId = body.region_id!
  }
  const regionRows = await tx.execute<{ code: string }>(sql`
    SELECT code FROM region WHERE id = ${regionId}::uuid LIMIT 1
  `)
  const region = [...regionRows][0]
  if (!region) unprocessable('Region not found')
  return { regionId, regionCode: region.code, orgUnitId }
}
