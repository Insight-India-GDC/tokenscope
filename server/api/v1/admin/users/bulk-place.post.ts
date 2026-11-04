/*
 * POST /api/v1/admin/users/bulk-place { teammate_ids[], org_unit_id }
 * — place many teammates into one cost centre in a single action.
 *
 * THE GAP THIS CLOSES. A region admin looking at "Unplaced · 290 teammates" had
 * exactly one write available: PATCH /admin/users/:id/org-unit, one person at a
 * time. This is that same write, batched.
 *
 * IT IS THE SAME WRITE, LITERALLY. Every id goes through
 * server/db/place-teammate.ts — the same region-scope check, the same
 * target-unit containment, the same provenance strip, the same audit event
 * type as the single-row move. Nothing about who may move whom is re-decided
 * here. What this handler owns is the batch: the target-unit pre-flight, the
 * per-id failure isolation, and the batch id.
 *
 * ── AUTHORISATION ─────────────────────────────────────────────────────────
 * Two checks that only mean something together:
 *   - up front, once: `requireRegionScope` against the TARGET UNIT's region, so
 *     a region admin cannot place INTO another region's unit — and finds out
 *     before any row moves rather than N times over;
 *   - per id, inside placeTeammate: `requireRegionScope` against the TEAMMATE's
 *     region, plus "the target unit is in the teammate's own region".
 * The first alone would let a caller move another region's people into their own
 * unit; the second alone would 422 late and per-row. Both are pinned by
 * tests/integration/admin/placement-remediation.test.ts against real cross-region
 * fixtures — an authorisation test whose fixture has no foreign data proves
 * nothing — and by the two interleaving tests there, because a check that another
 * transaction can invalidate before the UPDATE lands is advisory, not enforced.
 *
 * `platform-admin` is region-unbounded and passes both scope checks, but is NOT
 * exempt from containment: the target unit must still be in the teammate's own
 * region, so no role can use this endpoint to move a person across regions. That
 * is the region PATCH's job, and it runs a revoke cascade this one must not.
 *
 * ── PARTIAL FAILURE, AND WHAT IS *NOT* ONE ────────────────────────────────
 * One bad id must not discard 39 good placements, so each id runs in its own
 * SAVEPOINT (a nested transaction on the RLS transaction drizzle already opened).
 * A throw rolls back that id ONLY — including its audit row, so the audit never
 * claims a placement that was rolled back — and the loop continues.
 *
 * ONLY A 4xx BECOMES A PER-ID OUTCOME. A deadlock, a lost connection, a
 * constraint violation or a plain programming error is not a refusal of one
 * user's placement: nobody decided anything about that teammate, and the batch's
 * remaining ids ran against a database that had just failed. Catching those
 * turned an infrastructure failure into forty tidy "refused" rows behind a 200,
 * with the driver's own message echoed to the client. They are RETHROWN, the
 * enclosing transaction rolls back, and the request fails as a request.
 *
 * A consequence worth stating: every per-id refusal happens BEFORE that id's
 * audit INSERT, so the SAVEPOINT no longer has an aborted statement to recover
 * from on any reachable path. It is kept as the guarantee that a refusal added
 * LATER — after a write — still cannot leave a half-placement behind; it is no
 * longer load-bearing today. Do not read the savepoint as evidence that DB
 * errors are survivable here. They are not, by design.
 *
 * The batch is capped at BULK_PLACE_MAX ids, which is deliberately the same as
 * the teammates list's maximum page (server/api/v1/admin/teammates.get.ts): the
 * worklist cannot show more than one page, so it cannot select more than one
 * page, and a cap the UI can exceed is a cap that turns into a 400 mid-journey.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { placeTeammate, assertCostOwningTarget, REHOME_REMOVED_DETAIL } from '../../../../db/place-teammate'

/** Max ids per call — matches the teammates list's max page size. */
export const BULK_PLACE_MAX = 200

const Body = z
  .object({
    teammate_ids: z.array(z.string().uuid()).min(1).max(BULK_PLACE_MAX),
    org_unit_id: z.string().uuid(),
    // Accepted only to be refused: see REHOME_REMOVED_DETAIL.
    rehome: z.unknown().optional(),
  })
  .refine((d) => d.rehome === undefined, { message: REHOME_REMOVED_DETAIL })

export interface BulkPlaceOutcome {
  teammate_id: string
  /**
   * 'noop' — already in the target unit, so nothing was written and nothing was
   * stripped (server/db/place-teammate.ts). Not counted as placed: reporting a
   * write that did not happen is how a re-place looks like progress.
   */
  status: 'placed' | 'noop' | 'failed'
  /** Where they were before — lets the caller see a no-op re-place for what it is. */
  previous_org_unit_id?: string
  /** The refusal, verbatim from the shared placement rule. */
  reason?: string
  status_code?: number
}

/**
 * Is this a REFUSAL of one placement, or did the request break?
 *
 * Only an h3 4xx qualifies: those are the ones this endpoint's own rules raise
 * (404 no such teammate, 403 not your region, 422 illegal target), each already
 * carrying a sentence written for an admin. Everything else — no statusCode at
 * all, or a 5xx — is a failure of the request, not a decision about a user.
 */
function isPerIdRefusal(err: unknown): boolean {
  const status = (err as { statusCode?: unknown })?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  // De-dupe while preserving the caller's order — a repeated id would otherwise
  // write two audit rows for one placement and inflate the `placed` count.
  const ids = [...new Set(body.teammate_ids)]
  const batchId = randomUUID()

  return await withRequestRls(event, async (tx) => {
    /*
     * Pre-flight: resolve the target unit's region and check the caller may
     * administer THAT region. Deliberately before any placement — a region admin
     * aiming at another region's unit is refused as a request, not reported as
     * 40 identical per-id failures.
     *
     * A unit that does not exist is a 422 here rather than a 404: the id came
     * from a picker, and telling an unauthorised caller apart "no such unit" from
     * "not your unit" is an existence oracle. Both land on the same refusal.
     */
    const unitRows = await tx.execute<{ region_id: string }>(sql`
      SELECT region_id::text AS region_id FROM org_unit WHERE id = ${body.org_unit_id}::uuid LIMIT 1
    `)
    const unit = [...unitRows][0]
    if (!unit) {
      throw createError({
        statusCode: 422,
        statusMessage: 'org_unit_id must reference an org unit that exists',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Unprocessable',
          status: 422,
          detail: 'org_unit_id must reference an org unit that exists.',
        },
      })
    }
    await requireRegionScope(event, unit.region_id)
    // The SAME function the per-id path applies (see place-teammate.ts) — called
    // here only so a target that can never be legal for ANY id is one legible
    // refusal instead of forty identical per-id ones.
    await assertCostOwningTarget(tx, body.org_unit_id)

    const results: BulkPlaceOutcome[] = []
    for (const teammateId of ids) {
      try {
        // SAVEPOINT per id: a refusal rolls back this id's audit row and nothing
        // else, so the good placements in the same batch survive it.
        const placed = await tx.transaction(async (sp) =>
          placeTeammate(event, sp as unknown as Parameters<typeof placeTeammate>[1], {
            teammateId,
            orgUnitId: body.org_unit_id,
            targetPolicy: 'cost-owning-only',
            caller: { teammateId: caller.teammateId },
            batchId,
            ipAddress: ip,
            userAgent: ua,
          }),
        )
        results.push({
          teammate_id: teammateId,
          status: placed.outcome,
          previous_org_unit_id: placed.previousOrgUnitId,
        })
      } catch (err) {
        // Not a refusal → not this teammate's outcome. Let it out: the enclosing
        // transaction rolls back and the caller gets a failed request.
        if (!isPerIdRefusal(err)) throw err
        results.push({
          teammate_id: teammateId,
          status: 'failed',
          reason: refusalDetail(err),
          status_code: (err as { statusCode: number }).statusCode,
        })
      }
    }

    return {
      batch_id: batchId,
      org_unit_id: body.org_unit_id,
      placed: results.filter((r) => r.status === 'placed').length,
      /** Already in the target unit — nothing written, nothing stripped. */
      noop: results.filter((r) => r.status === 'noop').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    }
  })
})

/**
 * The human-readable refusal for one id. Prefers the RFC-9457 `detail` the
 * shared placement rule attaches, so a per-id outcome says the same sentence the
 * single-row move would have shown — never a bare status code.
 *
 * Reached only for a 4xx (see isPerIdRefusal), so every string it can return is
 * one of OUR sentences. It deliberately does NOT fall back to `err.message`: that
 * is the field a driver error populates, and this value goes to the client.
 */
function refusalDetail(err: unknown): string {
  const e = err as { data?: { detail?: string }; statusMessage?: string }
  return e?.data?.detail ?? e?.statusMessage ?? 'Placement refused.'
}
