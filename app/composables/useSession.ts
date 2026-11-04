/*
 * useSession — client-side composable for the /api/v1/auth/me endpoint.
 *
 * Uses useRequestFetch on the server side so the browser's session cookie
 * is forwarded through SSR. Without this, the global auth middleware
 * runs server-side, fetches /me without the cookie, sees authenticated:false,
 * and redirects back to /login — even for a freshly-signed-in user.
 */
import type { MeResponse } from '#shared/schemas/auth'

export function useSession() {
  const session = useState<MeResponse | null>('ts:session', () => null)

  async function refresh() {
    // useRequestFetch forwards SSR cookies; cast through a narrower call
    // sig to avoid the route-union recursive-type inference Nuxt's typegen
    // produces (TS2321 "excessive stack depth").
    const fetcher = import.meta.server
      ? (useRequestFetch() as (path: string) => Promise<MeResponse>)
      : ($fetch as (path: string) => Promise<MeResponse>)
    session.value = await fetcher('/api/v1/auth/me')
    return session.value
  }

  async function ensure() {
    if (!session.value) return refresh()
    return session.value
  }

  async function devLogin(persona: string) {
    await $fetch('/api/v1/auth/dev-login', {
      method: 'POST',
      body: { persona },
    })
    return refresh()
  }

  async function logout() {
    // 1) Clear the sandbox override sidecar + audit (server-side). Best-effort:
    //    a failure here must not stop the provider logout below.
    try {
      await $fetch('/api/v1/auth/logout', { method: 'POST' })
    } catch (err) {
      console.warn('[logout] sidecar clear failed; continuing to provider logout', err)
    }
    session.value = null
    // 2) Hand off to nuxt-oidc-auth's provider-logout endpoint, which
    //    clears the OIDC cookie and redirects through Entra's logout
    //    URL. MUST be a full browser navigation (not router.push), so
    //    the OIDC module can set Set-Cookie on the response. Without
    //    this, the OIDC cookie survives the "sign out" click and the
    //    next request silently re-authenticates the same user.
    if (import.meta.client) {
      window.location.href = '/auth/entra/logout'
    }
  }

  async function stopImpersonating() {
    const result = await $fetch<{ ok: boolean; landing: string }>(
      '/api/v1/auth/stop-impersonating',
      { method: 'POST' },
    )
    await refresh()
    return result
  }

  return { session, refresh, ensure, devLogin, logout, stopImpersonating }
}
