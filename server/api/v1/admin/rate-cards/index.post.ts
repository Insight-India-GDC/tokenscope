/*
 * POST /api/v1/admin/rate-cards — create a rate card WITH its lines in one
 * transaction (PRD COST-5, safe half).
 *
 * Invariants this endpoint must keep (COST-7 / resolveRateCard in
 * server/workers/azure-monitor-reader.ts):
 *   - A card's rate_line rows are written ONCE, here, atomically with the
 *     card. There is NO line-mutation endpoint — costed attribution records
 *     pin (rate_card_id, rate_card_version), so editing lines would silently
 *     rewrite history. Pricing changes = new card (new period or new version
 *     tier); mistakes = retire.
 *   - Versioning is per scope TIER: 1 + max(version) over the same
 *     (scope_key, region_id, cou_id). The joiner breaks within-tier ties to
 *     the highest version.
 *   - Overlap protection is the 0050 EXCLUDE (same tier + && effective):
 *     its 23P01 surfaces here as a clean 409. Different tiers (e.g. a region
 *     card alongside the global card) may legitimately share a period.
 *
 * Authority: region admins create cards for their OWN region only; a GLOBAL
 * card (region_id null) — which would reprice every region without an own-
 * region card — is platform-admin only. The CoU tier is not
 * creatable via the API yet (resolveRateCard excludes it — documented TODO).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { EffectiveRangeSchema, parseBound } from '../../../../utils/allocation-validation'
import { rateCard, rateLine } from '../../../../../drizzle/schema'

const LineSchema = z.object({
  unit: z.string().min(1).max(64),
  // NUMERIC(20,6) holds far more, but 1e12 units-per-price is already absurd;
  // capping app-side keeps an oversized qty a clean 400 instead of a PG 22003.
  unit_qty: z.number().int().positive().max(1_000_000_000_000),
  // NUMERIC(14,8): at most 6 integer digits + 8 decimals, strictly positive.
  unit_cost_usd: z
    .string()
    .regex(
      /^\d{1,6}(\.\d{1,8})?$/,
      'unit_cost_usd must be a positive USD amount with at most 8 decimals and at most 6 integer digits',
    )
    .refine((v) => Number(v) > 0, 'unit_cost_usd must be greater than zero'),
  model: z.string().min(1).max(120).nullable(),
})

const Body = z.object({
  scope_key: z
    .string()
    .max(120)
    .regex(/^[a-z0-9-]+:[a-z0-9-]+$/, "scope_key must look like 'provider:tool' (lowercase)"),
  // Version-agnostic UUID shape (the require-uuid-param rationale). null /
  // omitted = a GLOBAL card.
  region_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .nullable()
    .optional(),
  // Day-aligned bounds are LOAD-BEARING, not cosmetic (R1 F6): the joiner
  // caches the resolved card per (tool, region, UTC day), so a mid-day
  // effective boundary would price that whole day by whichever card the
  // day's FIRST event resolved — non-deterministic by arrival order.
  // Rejecting non-midnight-UTC bounds makes the cache's day granularity
  // exactly equal to the selection granularity.
  effective: EffectiveRangeSchema.refine((v: string) => {
    const m = /^\[([^,]+),([^)]*)\)$/.exec(v)
    if (!m) return true // shape errors are EffectiveRangeSchema's job
    const midnightUtc = (s: string) => {
      if (s.trim() === '') return true // open upper bound
      // Same normaliser as EffectiveRangeSchema (R2 F2): a bespoke
      // new Date() here rejected the documented `+00` bound form.
      const d = parseBound(s)
      return (
        d !== null &&
        d.getUTCHours() === 0 &&
        d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0 &&
        d.getUTCMilliseconds() === 0
      )
    }
    return midnightUtc(m[1]!) && midnightUtc(m[2]!)
  }, 'effective bounds must be midnight UTC (day-aligned) — the costing cache resolves cards per UTC day'),
  basis: z.enum(['list', 'negotiated', 'invoice-derived']),
  provenance: z.record(z.string(), z.unknown()),
  lines: z.array(LineSchema).min(1).max(20),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid rate card',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid rate card',
      status: 400,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const regionId = body.region_id ?? null

  // Duplicate (unit, model) pairs would be ambiguous for computeCost. Checked
  // app-side because the rate_line UNIQUE treats NULL models as distinct —
  // the DB would happily accept two model-less 'input' lines.
  const seen = new Set<string>()
  for (const line of body.lines) {
    // '\u0000' as the escape, never a literal NUL: a raw byte makes this file
    // binary to ripgrep and grep, so text-based sweeps skip it silently.
    const key = `${line.unit}\u0000${line.model ?? ''}`
    if (seen.has(key)) {
      badRequest(`Duplicate line for unit '${line.unit}'${line.model ? ` and model '${line.model}'` : ''}.`)
    }
    seen.add(key)
  }

  // Scope authority: a global card reprices every region without an own-region
  // card — not a region admin's to create.
  if (regionId === null) {
    if (!(isPlatformAdmin(caller.role))) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'A global rate card requires an Admin.',
        },
      })
    }
  } else {
    await requireRegionScope(event, regionId)
  }

  return await withRequestRls(event, async (tx) => {
    if (regionId) {
      // Existence check (API-9 posture): without it a POST against any UUID
      // hits the region FK → 23503 → raw 500 instead of this 404.
      const regionRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM region WHERE id = ${regionId}::uuid LIMIT 1
      `)
      if (![...regionRows][0]) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Region not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Region not found',
            status: 404,
            detail: 'No region matches the supplied id.',
          },
        })
      }
    }

    // Version = 1 + max(version) over the SAME tier (scope_key, region, cou).
    // IS NOT DISTINCT FROM so the global tier (region_id NULL) versions too.
    const versionRows = await tx.execute<{ next_version: number }>(sql`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM rate_card
       WHERE scope_key = ${body.scope_key}
         AND region_id IS NOT DISTINCT FROM ${regionId}::uuid
         AND cou_id IS NULL
    `)
    const version = [...versionRows][0]!.next_version

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(rateCard)
        .values({
          scopeKey: body.scope_key,
          effective: body.effective,
          basis: body.basis,
          provenance: body.provenance,
          version,
          regionId,
          couId: null,
          createdBy: caller.teammateId,
        })
        .returning({ id: rateCard.id })
      await tx.insert(rateLine).values(
        body.lines.map((line) => ({
          rateCardId: created!.id,
          unit: line.unit,
          unitQty: String(line.unit_qty),
          unitCostUsd: line.unit_cost_usd,
          model: line.model,
        })),
      )
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        // The 0050 EXCLUDE: same (scope_key, region, cou) tier + && effective.
        '23P01': {
          title: 'Rate-card period overlaps',
          detail: 'A card already covers this period for this scope.',
        },
        // Concurrent-race backstop for the app-side duplicate-line check.
        '23505': {
          title: 'Duplicate rate line',
          detail: 'Two lines share the same (unit, model) pair.',
        },
        // Region hard-deleted between the check and the insert (TOCTOU).
        '23503': {
          status: 404,
          title: 'Region not found',
          detail: 'The region was deleted while creating the rate card.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'rate-card-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'rate-card',
      subjectId: created!.id,
      payload: {
        scope_key: body.scope_key,
        region_id: regionId,
        cou_id: null,
        effective: body.effective,
        basis: body.basis,
        provenance: body.provenance,
        version,
        lines: body.lines,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      scope_key: body.scope_key,
      region_id: regionId,
      version,
      line_count: body.lines.length,
    }
  })
})
