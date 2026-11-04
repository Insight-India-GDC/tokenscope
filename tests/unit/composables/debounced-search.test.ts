/*
 * useDebouncedSearch (FE-7) — debounce coalescing + the sequence-token stale
 * guard. The guard is the important part: an out-of-order response for an
 * EARLIER term must never overwrite the results of the current one, and
 * cancel() must drop an in-flight response (input cleared mid-flight).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { useDebouncedSearch } from '../../../app/composables/useDebouncedSearch'

// A search stub whose promises resolve only when the test says so.
function deferredSearch() {
  const pending = new Map<string, { resolve: (v: string[]) => void; reject: (e: unknown) => void }>()
  const calls: string[] = []
  const search = (term: string) =>
    new Promise<string[]>((resolve, reject) => {
      calls.push(term)
      pending.set(term, { resolve, reject })
    })
  return { search, pending, calls }
}

describe('useDebouncedSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces keystrokes inside the debounce window into one request', async () => {
    const { search, pending, calls } = deferredSearch()
    const applied: string[][] = []
    const s = useDebouncedSearch<string[]>({
      search,
      apply: (r) => applied.push(r),
      onError: () => {},
    })

    s.run('a')
    vi.advanceTimersByTime(100)
    s.run('ab')
    vi.advanceTimersByTime(100)
    s.run('abc')
    vi.advanceTimersByTime(250)

    expect(calls).toEqual(['abc'])
    pending.get('abc')!.resolve(['match'])
    await vi.runAllTimersAsync()
    expect(applied).toEqual([['match']])
  })

  it('drops a stale response that resolves after a newer request', async () => {
    const { search, pending, calls } = deferredSearch()
    const applied: string[][] = []
    const errors: unknown[] = []
    const s = useDebouncedSearch<string[]>({
      search,
      apply: (r) => applied.push(r),
      onError: (e) => errors.push(e),
    })

    s.run('old')
    vi.advanceTimersByTime(250) // 'old' request in flight
    s.run('new')
    vi.advanceTimersByTime(250) // 'new' request in flight
    expect(calls).toEqual(['old', 'new'])

    // Out-of-order: the NEWER response lands first, then the stale one.
    pending.get('new')!.resolve(['new-results'])
    await vi.runAllTimersAsync()
    pending.get('old')!.resolve(['old-results'])
    await vi.runAllTimersAsync()

    expect(applied).toEqual([['new-results']])
    expect(s.pending.value).toBe(false)
    expect(errors).toEqual([])
  })

  it('a stale failure is silently dropped; a current failure reaches onError', async () => {
    const { search, pending } = deferredSearch()
    const errors: unknown[] = []
    const s = useDebouncedSearch<string[]>({
      search,
      apply: () => {},
      onError: (e) => errors.push(e),
    })

    s.run('first')
    vi.advanceTimersByTime(250)
    s.run('second')
    vi.advanceTimersByTime(250)

    pending.get('first')!.reject(new Error('stale failure'))
    await vi.runAllTimersAsync()
    expect(errors).toEqual([]) // superseded — not surfaced

    pending.get('second')!.reject(new Error('current failure'))
    await vi.runAllTimersAsync()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('current failure')
  })

  it('cancel() drops both the queued debounce and an in-flight response', async () => {
    const { search, pending, calls } = deferredSearch()
    const applied: string[][] = []
    const s = useDebouncedSearch<string[]>({
      search,
      apply: (r) => applied.push(r),
      onError: () => {},
    })

    // Queued-but-not-fired debounce is dropped.
    s.run('queued')
    s.cancel()
    vi.advanceTimersByTime(250)
    expect(calls).toEqual([])

    // In-flight response is dropped after cancel (input cleared mid-flight).
    s.run('flying')
    vi.advanceTimersByTime(250)
    s.cancel()
    pending.get('flying')!.resolve(['late'])
    await vi.runAllTimersAsync()
    expect(applied).toEqual([])
    expect(s.pending.value).toBe(false)
  })
})

describe('useDebouncedSearch inside a component scope', () => {
  it('drops a pending debounce when the scope is disposed (the page unmounts)', async () => {
    vi.useFakeTimers()
    try {
      const search = vi.fn(() => Promise.resolve('r'))
      const scope = effectScope()
      scope.run(() => useDebouncedSearch({ search, apply: () => {}, onError: () => {} }))!.run('abc')
      scope.stop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(search).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
