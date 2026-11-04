/*
 * The placement check's Read directory loop, shared by /admin/placement-check and
 * /admin/org-setup. Passes run until nothing remains, Stop is pressed, the page is
 * left, or a pass reads nobody. Retry runs one pass over the cycle's failed lookups.
 *
 * Progress comes from `refresh()` + `remaining()`, never from summed replies: a pass
 * cut off by a 504 still read people.
 */
import { onUnmounted, ref } from 'vue'
import { apiErrorDetail } from './useApiError'
import type { PlacementPassResponse } from '#shared/placement/placement-check'

// A pass that outlived the gateway (504, or a dropped connection) keeps running on the
// server and holds the worker, so the next request gets 409 worker-already-running.
// Both mean "wait for it", not "failed".
export const STILL_RUNNING_WAIT_MS = 15_000
const STILL_RUNNING_MAX_WAITS = 8

function passStillRunning(e: unknown): boolean {
  const err = e as { statusCode?: number; data?: { data?: { type?: string } } } | null
  if (err?.statusCode === 409) return err.data?.data?.type?.endsWith('/worker-already-running') === true
  return err?.statusCode === 504 || err?.statusCode == null
}

export function usePlacementRead(opts: { refresh: () => Promise<void>; remaining: () => number }) {
  const busy = ref<'pass' | 'retry' | null>(null)
  const error = ref<string | null>(null)
  const stopRequested = ref(false)
  /** `remaining` when the current read run started; null for a retry or before any run. */
  const runStartRemaining = ref<number | null>(null)
  /** A retry re-reads people already counted as read, so it reports its own result. */
  const retryResult = ref<PlacementPassResponse | null>(null)

  onUnmounted(() => (stopRequested.value = true))

  async function runPass(retryFailed: boolean) {
    busy.value = retryFailed ? 'retry' : 'pass'
    error.value = null
    stopRequested.value = false
    runStartRemaining.value = retryFailed ? null : opts.remaining()
    retryResult.value = null
    let waits = 0
    try {
      while (!stopRequested.value) {
        let pass: PlacementPassResponse
        try {
          pass = await $fetch<PlacementPassResponse>('/api/v1/admin/placement-check/pass', {
            method: 'POST',
            body: retryFailed ? { retryFailed: true } : {},
          })
        } catch (e: unknown) {
          if (!passStillRunning(e) || waits >= STILL_RUNNING_MAX_WAITS) throw e
          waits += 1
          await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_WAIT_MS))
          await opts.refresh()
          continue
        }
        waits = 0
        await opts.refresh()
        if (retryFailed) retryResult.value = pass
        if (retryFailed || pass.remaining === 0 || pass.checked === 0) break
      }
    } catch (e: unknown) {
      error.value = apiErrorDetail(e, 'Reading the directory failed.')
    } finally {
      busy.value = null
    }
  }

  return { busy, error, stopRequested, runStartRemaining, retryResult, runPass }
}
