/*
 * useDebouncedSearch — ~250 ms debounce + sequence-token stale guard for
 * type-ahead searches (FE-7).
 *
 * House pattern: the request-id guard in admin/reconciliation.vue `openRun`.
 * Out-of-order responses (slow request for an earlier term resolving after a
 * faster one for the current term) are dropped instead of overwriting the
 * results; `cancel()` bumps the sequence so an in-flight response is also
 * dropped when the caller clears the search.
 */
import { getCurrentScope, onScopeDispose, ref } from 'vue'

export function useDebouncedSearch<T>(options: {
  search: (term: string) => Promise<T>
  /** Applied only when the response is still the latest one. */
  apply: (result: T) => void
  /** Called only when the FAILED request is still the latest one. */
  onError: (err: unknown) => void
  delayMs?: number
}) {
  const delayMs = options.delayMs ?? 250
  const pending = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function run(term: string) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const token = ++seq
      pending.value = true
      options
        .search(term)
        .then((result) => {
          if (token !== seq) return // superseded — drop the stale result
          options.apply(result)
        })
        .catch((err: unknown) => {
          if (token !== seq) return // a stale failure is not an error
          options.onError(err)
        })
        .finally(() => {
          if (token === seq) pending.value = false
        })
    }, delayMs)
  }

  /** Drop the pending debounce AND any in-flight response (e.g. input cleared). */
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    seq++
    pending.value = false
  }

  // A debounce still pending when the component goes away would fire a search
  // for a page nobody is on (and, in tests, after the globals are unstubbed).
  if (getCurrentScope()) onScopeDispose(cancel)

  return { run, cancel, pending }
}
