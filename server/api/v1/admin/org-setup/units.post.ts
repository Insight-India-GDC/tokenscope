/*
 * POST /api/v1/admin/org-setup/units — create Business Units, each with its owner
 * picked from the tree (docs/design/org-setup/00-spec.md, Screen 3). Each item runs
 * in its own savepoint through the same create and owner-assign code as
 * POST /admin/org-units and POST /admin/org-units/{id}/owners, so one refusal
 * leaves the others in place: the owner's directory lookup, a directory error and
 * a database error are all that item's refusal, never the request's failure.
 * Nobody moves here. Platform-admin only.
 */
import { createError, defineEventHandler, getHeader, getRequestIP, isError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../../../../drizzle/schema'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { getDirectoryUserByOidStrict, type DirectoryUser } from '../../../../azure/directory'
import { fetchRegionOptions } from '../../../../reporting/regional'
import { createOrgUnit, unitCodeSlug } from '../../../../db/org-unit-create'
import { ALREADY_OWNS_A_BU_TYPE, assignUnitOwner } from '../../../../db/org-unit-owner-assign'
import {
  ORG_SETUP_UNITS_MAX,
  type OrgSetupUnitResult,
  type OrgSetupUnitsResponse,
} from '../../../../../shared/org-setup/contract'

const Body = z
  .object({
    items: z
      .array(
        z
          .object({
            ownerOid: z.string().trim().min(1).max(200),
            name: z.string().trim().min(1).max(200),
            regionId: z.string().uuid(),
            parentUnitId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(ORG_SETUP_UNITS_MAX),
  })
  .strict()

/** Codes tried per item before giving up: base, base-2 … */
const CODE_ATTEMPTS = 50

/**
 * The request's budget. Up to ORG_SETUP_UNITS_MAX strict lookups run one after
 * another inside one transaction, each allowed GRAPH_TIMEOUT_MS, so a slow directory
 * could otherwise keep the handler committing items long after the front door gave
 * up on the page (Dev's WAF answers 504 at about 60 s). No lookup starts or waits
 * past the deadline, and an item not started before it is refused `not-started`.
 */
export const UNITS_REQUEST_BUDGET_MS = 20_000

const NOT_STARTED: Problem = { reason: 'not-started', detail: 'Ran out of time before this one; save again for the rest.' }

interface Problem {
  reason: string
  detail: string
}

function problemOf(err: unknown): Problem | null {
  if (!isError(err)) return null
  const data = (err.data ?? {}) as { type?: unknown; detail?: unknown }
  const type = typeof data.type === 'string' ? data.type : ''
  return {
    reason: type ? type.slice(type.lastIndexOf('/') + 1) : `http-${err.statusCode}`,
    detail: typeof data.detail === 'string' ? data.detail : err.statusMessage || 'Refused.',
  }
}

const refused = (ownerOid: string, p: Problem): OrgSetupUnitResult => ({ ownerOid, status: 'refused', ...p })

const messageOf = (err: unknown) => (err instanceof Error && err.message ? err.message : String(err))

export default defineEventHandler(async (event): Promise<OrgSetupUnitsResponse> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ipAddress = getRequestIP(event, { xForwardedFor: true }) ?? null
  const userAgent = getHeader(event, 'user-agent') ?? null
  const deadline = Date.now() + UNITS_REQUEST_BUDGET_MS

  return withRequestRls(event, async (tx) => {
    const regions = new Set((await fetchRegionOptions(tx)).map((r) => r.id))
    const results: OrgSetupUnitResult[] = []
    for (const item of body.items) {
      // Items already processed keep their results; this one and the rest are not
      // started.
      if (Date.now() >= deadline) {
        results.push(refused(item.ownerOid, NOT_STARTED))
        continue
      }
      if (!regions.has(item.regionId)) {
        results.push(refused(item.ownerOid, { reason: 'unprocessable', detail: 'That region does not exist.' }))
        continue
      }
      // One lookup per item, in turn: a lookup that fails refuses this item only and
      // nothing of it has been written yet. The Graph call holds the transaction
      // open for its duration. The STRICT lookup, one attempt like every request
      // handler: a throttle or timeout is this item's `directory-error`, and null
      // means only "no such user" — the lenient wrapper would report both as that.
      let dir: DirectoryUser | null
      try {
        dir = await getDirectoryUserByOidStrict(item.ownerOid, { deadline })
      } catch (err) {
        results.push(refused(item.ownerOid, { reason: 'directory-error', detail: messageOf(err) }))
        continue
      }
      if (!dir) {
        results.push(refused(item.ownerOid, { reason: 'directory-user', detail: 'No directory user matches that object id.' }))
        continue
      }
      const owner = dir
      try {
        const created = await tx.transaction(async (sp) => {
          const base = unitCodeSlug(item.name)
          for (let n = 1; n <= CODE_ATTEMPTS; n++) {
            const code = n === 1 ? base : `${base}-${n}`
            let unit
            try {
              unit = await createOrgUnit(
                sp,
                {
                  regionId: item.regionId,
                  parentId: item.parentUnitId,
                  code,
                  displayName: item.name,
                  unitType: 'bu',
                  isCostOwningUnit: true,
                },
                { actorTeammateId: caller.teammateId, ipAddress, userAgent },
              )
            } catch (err) {
              // Every 409 from createOrgUnit is about the code; it throws before writing.
              if (isError(err) && err.statusCode === 409) continue
              throw err
            }
            await assignUnitOwner(
              sp,
              { orgUnitId: unit.id, owner: { dir: owner } },
              {
                caller: { teammateId: caller.teammateId, role: caller.role },
                assertRegionScope: async () => {},
                ipAddress,
                userAgent,
              },
            )
            return unit
          }
          throw createError({
            statusCode: 409,
            statusMessage: 'No free code',
            data: { type: 'https://tokenscope.example.com/errors/conflict', detail: `No free code for "${item.name}" in this region.` },
          })
        })
        results.push({ ownerOid: item.ownerOid, status: 'created', orgUnitId: created.id, code: created.code })
      } catch (err) {
        // The savepoint has rolled this item back; anything that is not an HTTP
        // refusal (a database error, say) is reported the same way, so the items
        // already created in this request are kept.
        const p = problemOf(err) ?? { reason: 'error', detail: messageOf(err) }
        if (isError(err) && (err.data as { type?: string } | undefined)?.type === ALREADY_OWNS_A_BU_TYPE) {
          p.detail = await alreadyOwnsDetail(tx, owner)
        }
        results.push(refused(item.ownerOid, p))
      }
    }
    return { results }
  })
})

/** Names the unit: this route is platform-admin only, so every region is visible. */
async function alreadyOwnsDetail(
  tx: Pick<PostgresJsDatabase<typeof schema>, 'execute'>,
  dir: { oid: string; email: string; displayName: string },
): Promise<string> {
  const rows = await tx.execute<{ unit: string; region: string }>(sql`
    SELECT ou.display_name AS unit, r.display_name AS region
    FROM cou_owner co
    JOIN teammate t ON t.id = co.teammate_id
    JOIN org_unit ou ON ou.id = co.org_unit_id
    JOIN region r ON r.id = ou.region_id
    WHERE co.revoked_at IS NULL AND ou.retired_at IS NULL AND ou.is_cost_owning_unit
      AND (t.entra_oid = ${dir.oid} OR lower(t.email) = lower(${dir.email}))
    ORDER BY ou.display_name`)
  const owned = [...rows].map((r) => `${r.unit} (${r.region})`).join(', ')
  const who = dir.displayName || dir.email
  return owned
    ? `${who} already owns ${owned}. A person may own at most one Business Unit.`
    : `${who} already owns a Business Unit. A person may own at most one.`
}
