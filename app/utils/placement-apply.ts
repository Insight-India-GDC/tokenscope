/*
 * POST /api/v1/admin/placement-check/apply in batches of PLACEMENT_APPLY_MAX.
 * A failed batch stops the run and leaves the earlier batches applied; the caller
 * reports both what moved and the error.
 */
import {
  PLACEMENT_APPLY_MAX,
  type PlacementApplyItem,
  type PlacementApplyResponse,
  type PlacementCheckResponse,
  type PlacementCheckRow,
} from '#shared/placement/placement-check'
import { buildPlacementApplyItems } from './placement-check-view'

export async function applyPlacementInBatches(
  items: readonly PlacementApplyItem[],
): Promise<{ done: PlacementApplyResponse; error: unknown }> {
  const done: PlacementApplyResponse = { batchId: '', results: [] }
  try {
    for (let i = 0; i < items.length; i += PLACEMENT_APPLY_MAX) {
      const res = await $fetch<PlacementApplyResponse>('/api/v1/admin/placement-check/apply', {
        method: 'POST',
        body: { items: items.slice(i, i + PLACEMENT_APPLY_MAX) },
      })
      done.batchId ||= res.batchId
      done.results.push(...res.results)
    }
  } catch (e: unknown) {
    return { done, error: e }
  }
  return { done, error: null }
}

/**
 * Re-reads the live placement check and returns the rows `select` picks: what a
 * confirmation shows, and later exactly what is applied. The rows come from the
 * server now, so Apply's own seen-state guard still protects them.
 */
export async function readLiveCheck(
  select: (rows: PlacementCheckRow[]) => PlacementCheckRow[],
): Promise<{ rows: PlacementCheckRow[]; error: unknown }> {
  try {
    return { rows: select((await $fetch<PlacementCheckResponse>('/api/v1/admin/placement-check')).rows), error: null }
  } catch (e: unknown) {
    return { rows: [], error: e }
  }
}

/** Applies the rows a confirmation showed. `confirmManual` is sent for every manual row among them. */
export async function applyShownRows(rows: readonly PlacementCheckRow[]): Promise<{ done: PlacementApplyResponse; error: unknown }> {
  return applyPlacementInBatches(buildPlacementApplyItems(rows, true))
}
