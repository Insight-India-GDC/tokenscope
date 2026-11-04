/*
 * POST /api/v1/admin/placement-check/apply { items: PlacementApplyItem[] }
 * (docs/design/placement-check/00-spec.md P7). Platform-admin only.
 *
 * Each item runs in its own savepoint under the teammate's row lock and moves
 * only if, at that moment: the teammate is active; region, unit and provenance
 * still equal `seen`; a manual home was confirmed; `target` is valid
 * (targetValid); and the stored evidence, judged under the config loaded inside
 * that lock, still derives exactly `target` with an applicable verdict. A
 * region-only derivation targets the region's holding node (`orgUnitId` null).
 * A refusal is reported, never retried. Any other throw rolls back that item
 * alone and reports `error`.
 *
 * The move is the existing write: reassignTeammateRegion across regions (with
 * its revoke cascade), placeTeammate within one. Recorded spend stays where it
 * is, as with bulk place by default; devices follow. Provenance becomes
 * `placedVia: placement-check` with the deciding step; the move's one audit row
 * carries it.
 */
import { defineEventHandler, getHeader, getRequestIP, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { describeError } from '../../../../utils/redact-probe-error'
import { placeTeammate } from '../../../../db/place-teammate'
import { reassignTeammateRegion } from '../../../../db/reassign-teammate-region'
import { manualPlacementSql } from '../../../../reconciliation/placement-manual'
import {
  PLACED_VIA_PLACEMENT_CHECK,
  provenanceOf,
  stripProvenanceKeys,
} from '../../../../reconciliation/placement-provenance'
import { evidenceFromRow, loadPlacementConfig } from '../../../../reconciliation/placement-check-store'
import { classifyPlacement } from '../../../../reconciliation/placement-verdict'
import { decidePlacement, type PlacementDecision } from '../../../../reconciliation/region-derivation'
import { HOLDING_UNIT_TYPE } from '#shared/placement/holding-nodes'
import {
  APPLICABLE_VERDICTS,
  PLACEMENT_APPLY_MAX,
  type PlacementApplyItem,
  type PlacementApplyRefusal,
  type PlacementApplyResponse,
} from '#shared/placement/placement-check'

type Tx = Parameters<typeof placeTeammate>[1]
type ConfigDb = Parameters<typeof loadPlacementConfig>[0]

const Item = z.object({
  teammateId: z.string().uuid(),
  seen: z.object({
    regionId: z.string().uuid().nullable(),
    orgUnitId: z.string().uuid().nullable(),
    provenance: z.record(z.string(), z.string()).nullable(),
  }),
  target: z.object({ regionId: z.string().uuid(), orgUnitId: z.string().uuid().nullable() }),
  confirmManual: z.boolean().optional(),
})

const Body = z
  .object({ items: z.array(Item).min(1).max(PLACEMENT_APPLY_MAX) })
  .refine((d) => new Set(d.items.map((i) => i.teammateId)).size === d.items.length, {
    message: 'each teammate may appear once',
    path: ['items'],
  })

class Refused extends Error {
  constructor(readonly reason: PlacementApplyRefusal) {
    super(reason)
  }
}

interface Ctx {
  event: H3Event
  callerId: string
  batchId: string
  ip: string | null
  ua: string | null
}

export default defineEventHandler(async (event): Promise<PlacementApplyResponse> => {
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const batchId = randomUUID()

  return await withRequestRls(event, async (tx) => {
    const ctx: Ctx = {
      event,
      callerId: caller.teammateId,
      batchId,
      ip: getRequestIP(event, { xForwardedFor: true }) ?? null,
      ua: getHeader(event, 'user-agent') ?? null,
    }

    const results: PlacementApplyResponse['results'] = []
    for (const item of body.items) {
      try {
        await tx.transaction((sp) => applyOne(sp as unknown as Tx, item, ctx))
        results.push({ teammateId: item.teammateId, outcome: 'moved' })
      } catch (err) {
        if (err instanceof Refused) {
          results.push({ teammateId: item.teammateId, outcome: 'refused', reason: err.reason })
        } else {
          console.warn(`[placement-check-apply] ${item.teammateId}: ${describeError(err)}`)
          results.push({ teammateId: item.teammateId, outcome: 'refused', reason: 'error' })
        }
      }
    }
    return { batchId, results }
  })
})

async function applyOne(sp: Tx, item: PlacementApplyItem, ctx: Ctx): Promise<void> {
  const { teammateId, seen, target } = item

  const [locked] = await sp.execute<{ is_active: boolean }>(
    sql`SELECT is_active FROM teammate WHERE id = ${teammateId}::uuid FOR NO KEY UPDATE`,
  )
  if (!locked?.is_active) throw new Refused('not-found')
  const [cur] = await sp.execute<{
    region_id: string
    org_unit_id: string
    on_holding: boolean
    metadata: string | null
    manual: boolean
  }>(sql`
    SELECT t.region_id::text AS region_id, t.org_unit_id::text AS org_unit_id,
           (ou.unit_type = ${HOLDING_UNIT_TYPE}) AS on_holding, t.metadata::text AS metadata,
           ${manualPlacementSql(sql`t`)} AS manual
    FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.id = ${teammateId}::uuid`)
  const provenance = provenanceOf(cur!.metadata ? JSON.parse(cur!.metadata) : null)
  if (cur!.region_id !== seen.regionId || cur!.org_unit_id !== seen.orgUnitId || !sameProvenance(provenance, seen.provenance)) {
    throw new Refused('changed-since-check')
  }
  if (cur!.manual && !item.confirmManual) throw new Refused('manual-not-confirmed')

  if (!(await targetValid(sp, target, cur!))) throw new Refused('target-invalid')

  // Loaded under the lock, so a rule or owner change committed since the page loaded is seen.
  const config = await loadPlacementConfig(sp as unknown as ConfigDb)
  const [evRow] = await sp.execute<{ attributes: unknown; chain: unknown; walk_end: string }>(sql`
    SELECT attributes, chain, walk_end FROM placement_evidence WHERE teammate_id = ${teammateId}::uuid`)
  if (!evRow) throw new Refused('derivation-changed')
  const evidence = evidenceFromRow(evRow)
  const decision = decidePlacement(evidence, config)
  const verdict = classifyPlacement({
    walkEnd: evidence.walkEnd,
    decision,
    current: { regionId: cur!.region_id, orgUnitId: cur!.org_unit_id, onHolding: cur!.on_holding },
    manual: cur!.manual,
  })
  if (
    !(APPLICABLE_VERDICTS as readonly string[]).includes(verdict) ||
    (decision.orgUnitId ?? null) !== target.orgUnitId ||
    decision.regionId !== target.regionId
  ) {
    throw new Refused('derivation-changed')
  }

  const placed = provenanceFields(decision)
  const auditContext = { source: PLACED_VIA_PLACEMENT_CHECK, step: decision.step, provenance: placed }
  if (target.orgUnitId === null || target.regionId !== cur!.region_id) {
    await reassignTeammateRegion(sp, {
      teammateId,
      regionId: target.regionId,
      orgUnitId: target.orgUnitId ?? undefined,
      caller: { teammateId: ctx.callerId },
      batchId: ctx.batchId,
      auditContext,
      ipAddress: ctx.ip,
      userAgent: ctx.ua,
    })
  } else {
    await placeTeammate(ctx.event, sp, {
      teammateId,
      orgUnitId: target.orgUnitId,
      targetPolicy: 'cost-owning-only',
      caller: { teammateId: ctx.callerId },
      batchId: ctx.batchId,
      auditContext,
      ipAddress: ctx.ip,
      userAgent: ctx.ua,
    })
  }
  await sp.execute(sql`
    UPDATE teammate
    SET metadata = (coalesce(metadata, '{}'::jsonb) ${stripProvenanceKeys()})
                   || ${JSON.stringify(placed)}::jsonb || jsonb_build_object('placedAt', now())
    WHERE id = ${teammateId}::uuid`)
}

/**
 * A unit target must be an active cost-owning unit in `target.regionId`, held FOR
 * SHARE so it cannot be retired or un-flagged before commit. A region-only target
 * (holding node) must be another existing region: within one region it would
 * take a person out of their unit.
 */
async function targetValid(
  sp: Tx,
  target: PlacementApplyItem['target'],
  cur: { region_id: string; org_unit_id: string },
): Promise<boolean> {
  if (target.orgUnitId === null) {
    if (target.regionId === cur.region_id) return false
    const region = await sp.execute(sql`SELECT 1 FROM region WHERE id = ${target.regionId}::uuid`)
    return [...region].length > 0
  }
  if (target.orgUnitId === cur.org_unit_id) return false
  const [unit] = await sp.execute<{ ok: boolean }>(sql`
    SELECT (region_id = ${target.regionId}::uuid AND retired_at IS NULL AND is_cost_owning_unit) AS ok
    FROM org_unit WHERE id = ${target.orgUnitId}::uuid FOR SHARE`)
  return unit?.ok === true
}

/** The deciding step, plus the owner (chain-unit) or the rule attribute (unit-rule, region-rule). */
function provenanceFields(d: PlacementDecision): Record<string, string> {
  const out: Record<string, string> = { placedVia: PLACED_VIA_PLACEMENT_CHECK, placedStep: String(d.step) }
  if (d.step === 'chain-unit' && d.ownerOid) out.placedOwnerOid = d.ownerOid
  else if (d.rule) out.placedAttribute = d.rule.attribute
  return out
}

function sameProvenance(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  const ka = Object.keys(a ?? {})
  return ka.length === Object.keys(b ?? {}).length && ka.every((k) => a![k] === b?.[k])
}
