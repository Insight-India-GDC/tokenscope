// @vitest-environment happy-dom
/*
 * Sign-out must reach the provider logout even when the sidecar-clear POST
 * fails; otherwise the OIDC cookie survives a "signed out" click.
 *
 * The navigation itself sits behind `import.meta.client`, which is undefined
 * under plain Vitest, so this asserts what gates it: logout() completes and
 * clears the session instead of rejecting before reaching the redirect.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(fetchImpl: () => Promise<unknown>) {
  const state = ref<unknown>({ authenticated: true })
  vi.stubGlobal('useState', () => state)
  vi.stubGlobal('$fetch', vi.fn(fetchImpl))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { useSession } = await import('../../../app/composables/useSession')
  return { session: useSession(), state }
}

describe('useSession().logout', () => {
  it('completes and clears the session when the sidecar POST fails', async () => {
    const { session, state } = await setup(() => Promise.reject(new Error('500')))
    await expect(session.logout()).resolves.toBeUndefined()
    expect(state.value).toBeNull()
  })

  it('completes and clears the session on success', async () => {
    const { session, state } = await setup(() => Promise.resolve({ ok: true }))
    await session.logout()
    expect(state.value).toBeNull()
  })
})
