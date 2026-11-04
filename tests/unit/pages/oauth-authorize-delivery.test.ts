// @vitest-environment happy-dom
/*
 * OAuth consent page loopback delivery: the callback goes to a small popup
 * opened on the Approve click (this page never navigates away, and stays in view
 * behind it), /oauth/code-status decides delivered vs undelivered, the popup is
 * closed once that is known (#478), and nothing outside the scheme guard is
 * opened.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, ref, computed, onBeforeUnmount } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import AuthorizePage from '../../../app/pages/oauth/authorize.vue'
import type { AuthorizeResult } from '../../../shared/schemas/oauth'

const LOOPBACK = 'http://127.0.0.1:53682/'
const CODE = 'a'.repeat(64)
const CB = `${LOOPBACK}?code=${CODE}&state=s1`

interface FakeTab {
  opener: unknown
  closed: boolean
  location: { href: string }
  close: ReturnType<typeof vi.fn>
}
let tab: FakeTab | null
let open: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>
let redeemed: boolean
let statusCalls: number
let statusTimes: number[]
let statusGate: Promise<void> | null
let statusHangs: boolean
let statusFails: boolean

async function mountAndSubmit(
  opts: {
    redirectUri?: string
    redirectUrl?: string
    result?: Partial<AuthorizeResult>
    action?: 'approve' | 'deny'
    postFails?: boolean
    postHangs?: boolean
    beforePostResolves?: () => void
  } = {},
) {
  const redirectUri = opts.redirectUri ?? LOOPBACK
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useRoute', () => ({
    query: { client_id: 'c1', redirect_uri: redirectUri, code_challenge: 'x'.repeat(43), state: 's1', scope: 'tokenscope.read' },
  }))
  vi.stubGlobal('useRequestFetch', () => vi.fn())
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (path: string, o: { method: string; signal?: AbortSignal }) => {
      if (path === '/api/v1/oauth/code-status') {
        statusCalls++
        statusTimes.push(Date.now())
        if (statusHangs) {
          await new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        }
        if (statusGate) await statusGate
        if (statusFails) throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 })
        return { redeemed }
      }
      if (o.method === 'GET') return { client_name: 'GitHub Copilot', redirect_host: '127.0.0.1:53682', granted_scopes: ['tokenscope.read'] }
      if (opts.postFails) throw new Error('boom')
      if (opts.postHangs) {
        await new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      opts.beforePostResolves?.()
      const outcome = opts.action === 'deny' ? { outcome: 'denied' } : { outcome: 'code', code: CODE }
      return { redirect_url: opts.redirectUrl ?? CB, ...outcome, ...opts.result }
    }),
  )
  const Parent = defineComponent({ components: { AuthorizePage }, template: '<Suspense><AuthorizePage /></Suspense>' })
  const w = mount(Parent, { global: { stubs: { UiButton: { template: '<button v-bind="$attrs"><slot /></button>' } } } })
  await flushPromises()
  await w.find(`[data-testid="authorize-${opts.action ?? 'approve'}"]`).trigger('click')
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  redeemed = false
  statusCalls = 0
  statusTimes = []
  statusGate = null
  statusHangs = false
  statusFails = false
  tab = { opener: 'page', closed: false, location: { href: 'about:blank' }, close: vi.fn() }
  open = vi.fn(() => tab)
  assign = vi.fn()
  vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open)
  vi.spyOn(window.location, 'assign').mockImplementation(assign)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('/oauth/authorize — loopback delivery', () => {
  it('delivers in a popup opened on the click; this page stays, then closes it and shows Connected once redeemed', async () => {
    const w = await mountAndSubmit()
    expect(open).toHaveBeenCalledWith('', '_blank', 'popup,width=480,height=360')
    expect(tab!.opener).toBeNull()
    expect(tab!.location.href).toBe(CB)
    expect(assign).not.toHaveBeenCalled()
    expect(w.find('[data-testid="authorize-delivering"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-callback-url"]').text()).toBe(CB)

    expect(tab!.close).not.toHaveBeenCalled()

    redeemed = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.find('[data-testid="authorize-delivered"]').exists()).toBe(true)
    expect(tab!.close).toHaveBeenCalledTimes(1)
    const calls = statusCalls
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBe(calls)
  })

  it('unreachable loopback: leads with paste-back, and still flips to Connected after a paste', async () => {
    const w = await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(7000)
    expect(w.find('[data-testid="authorize-delivering"]').exists()).toBe(true)
    expect(tab!.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(w.find('[data-testid="authorize-undelivered"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-copy"]').exists()).toBe(true)
    // The popup's browser error page would sit in front of these steps (#478).
    expect(tab!.close).toHaveBeenCalledTimes(1)
    // The steps lead, in the words of Claude Code's own `URL >` prompt.
    const steps = w.find('[data-testid="authorize-undelivered"]').text()
    expect(steps).toContain('Finish signing in from your terminal')
    expect(steps).toContain("the URL from your browser's address bar")
    expect(steps).toContain('URL >')
    expect(w.find('[data-testid="authorize-delivering"]').exists()).toBe(false)

    redeemed = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.find('[data-testid="authorize-delivered"]').exists()).toBe(true)
  })

  it('popup blocked: goes straight to paste-back and keeps polling', async () => {
    tab = null
    const w = await mountAndSubmit()
    expect(w.find('[data-testid="authorize-undelivered"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-callback-url"]').text()).toBe(CB)
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(1)
  })

  it('the paste-back URL carries a "works like a password" warning in both approved branches', async () => {
    tab = null
    const undelivered = await mountAndSubmit()
    expect(undelivered.find('[data-testid="authorize-undelivered"]').exists()).toBe(true)
    expect(undelivered.find('[data-testid="authorize-url-warning"]').text()).toContain('works like a password')
    undelivered.unmount()

    const https = await mountAndSubmit({ redirectUri: 'https://client.example/cb', redirectUrl: `https://client.example/cb?code=${CODE}` })
    expect(https.find('[data-testid="authorize-callback-url"]').exists()).toBe(true)
    expect(https.find('[data-testid="authorize-url-warning"]').text()).toContain('works like a password')
  })

  it('no status request starts at or after the 2-minute deadline', async () => {
    const t0 = Date.now()
    await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10_000)
    expect(statusTimes.length).toBeGreaterThan(0)
    expect(Math.max(...statusTimes) - t0).toBeLessThan(2 * 60 * 1000)
  })

  it('polling stays well inside the 150/5 min rate limit and then stops', async () => {
    await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 5000)
    expect(statusCalls).toBeLessThanOrEqual(40)
    const calls = statusCalls
    await vi.advanceTimersByTimeAsync(60_000)
    expect(statusCalls).toBe(calls)
  })

  it('stalled status requests still reach the paste-back fallback and keep polling', async () => {
    statusHangs = true
    const w = await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(8000)
    expect(w.find('[data-testid="authorize-undelivered"]').exists()).toBe(true)
    const calls = statusCalls
    await vi.advanceTimersByTimeAsync(20_000)
    expect(statusCalls).toBeGreaterThan(calls)
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
    const final = statusCalls
    await vi.advanceTimersByTimeAsync(60_000)
    expect(statusCalls).toBe(final)
  })

  it('a status response landing after unmount schedules no further polls', async () => {
    let release!: () => void
    statusGate = new Promise((r) => (release = r))
    const w = await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(1)
    w.unmount()
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(statusCalls).toBe(1)
  })

  it('a failed POST closes the pre-opened tab', async () => {
    await mountAndSubmit({ postFails: true })
    expect(tab!.close).toHaveBeenCalled()
    expect(tab!.location.href).toBe('about:blank')
  })

  it('never navigates the tab to a URL failing the scheme guard', async () => {
    const w = await mountAndSubmit({ redirectUrl: 'javascript:alert(1)' })
    expect(tab!.location.href).toBe('about:blank')
    expect(tab!.close).toHaveBeenCalled()
    await w.find('[data-testid="authorize-open"]').trigger('click')
    expect(open).toHaveBeenCalledTimes(1)
    expect(assign).not.toHaveBeenCalled()
  })

  it('the server outcome decides, not the URL: a registered `?error=` param on a success is still polled', async () => {
    const uri = `${LOOPBACK}?error=registered`
    const cb = `${uri}&code=${CODE}&state=s1`
    const w = await mountAndSubmit({ redirectUri: uri, redirectUrl: cb })
    expect(tab!.location.href).toBe(cb)
    redeemed = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.find('[data-testid="authorize-delivered"]').exists()).toBe(true)
  })

  it('…and a registered `?code=` param on a deny is not polled', async () => {
    const uri = `${LOOPBACK}?code=registered`
    const denied = `${uri}&error=access_denied&state=s1`
    await mountAndSubmit({ redirectUri: uri, action: 'deny', redirectUrl: denied })
    expect(tab!.location.href).toBe(denied)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBe(0)
  })

  it('an Approve that the server answers with an error (invalid_scope) shows the error, not "approved"', async () => {
    const errUrl = `${LOOPBACK}?error=invalid_scope&state=s1`
    const w = await mountAndSubmit({
      redirectUrl: errUrl,
      result: { outcome: 'error', error: 'invalid_scope', error_description: 'At least one valid scope is required' } as Partial<AuthorizeResult>,
    })
    expect(tab!.location.href).toBe(errUrl)
    expect(w.find('[data-testid="authorize-approved"]').exists()).toBe(false)
    expect(w.find('[role="alert"]').text()).toContain('At least one valid scope is required')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBe(0)
  })

  it('https callbacks open no tab and do not poll (unchanged behaviour)', async () => {
    await mountAndSubmit({ redirectUri: 'https://client.example/cb', redirectUrl: `https://client.example/cb?code=${CODE}` })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(open).not.toHaveBeenCalled()
    expect(statusCalls).toBe(0)
  })

  it('Deny on a loopback callback hands the error to the client so it stops waiting, without polling', async () => {
    const denied = `${LOOPBACK}?error=access_denied&state=s1`
    const w = await mountAndSubmit({ action: 'deny', redirectUrl: denied })
    expect(tab!.location.href).toBe(denied)
    expect(tab!.close).not.toHaveBeenCalled()
    expect(w.find('[data-testid="authorize-denied"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBe(0)
  })
  it('Deny with the popup blocked keeps Open + Copy URL, and still offers Copy URL once sent', async () => {
    open.mockImplementationOnce(() => null) // the pre-opened tab is blocked
    const denied = `${LOOPBACK}?error=access_denied&state=s1`
    const w = await mountAndSubmit({ action: 'deny', redirectUrl: denied })
    expect(w.find('[data-testid="authorize-handoff"]').exists()).toBe(true)

    open.mockImplementationOnce(() => null) // blocked again
    await w.find('[data-testid="authorize-handoff-open"]').trigger('click')
    expect(open).toHaveBeenLastCalledWith(denied, '_blank')
    expect(w.find('[data-testid="authorize-handoff-copy"]').exists()).toBe(true) // still recoverable

    await w.find('[data-testid="authorize-handoff-open"]').trigger('click') // this one opens
    await flushPromises()
    expect(tab!.opener).toBeNull()
    expect(w.find('[data-testid="authorize-handoff-sent"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-handoff-copy"]').exists()).toBe(true) // unconfirmable: paste stays
    expect(statusCalls).toBe(0)
  })

  it('an error outcome with the popup blocked offers the same hand-off beside the error', async () => {
    open.mockImplementationOnce(() => null)
    const errUrl = `${LOOPBACK}?error=invalid_scope&state=s1`
    const w = await mountAndSubmit({
      redirectUrl: errUrl,
      result: { outcome: 'error', error: 'invalid_scope', error_description: 'bad scope' } as Partial<AuthorizeResult>,
    })
    expect(w.text()).toContain('bad scope')
    await w.find('[data-testid="authorize-handoff-open"]').trigger('click')
    expect(open).toHaveBeenLastCalledWith(errUrl, '_blank')
  })

  it('an https deny also gets the hand-off (there is no automatic delivery for it), URL selectable for a manual copy', async () => {
    const denied = 'https://client.example/cb?error=access_denied&state=s1'
    const w = await mountAndSubmit({ redirectUri: 'https://client.example/cb', action: 'deny', redirectUrl: denied })
    expect(open).not.toHaveBeenCalled() // no pre-opened tab for https
    expect(w.find('[data-testid="authorize-handoff"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-handoff-url"]').text()).toBe(denied)
  })

  it('the hand-off never offers a URL failing the scheme guard', async () => {
    const w = await mountAndSubmit({ action: 'deny', redirectUrl: 'javascript:alert(1)' })
    expect(w.find('[data-testid="authorize-handoff"]').exists()).toBe(false)
  })

  it('a loopback Deny auto-delivered through the tab still offers Copy URL (an unreachable client can only paste)', async () => {
    const denied = `${LOOPBACK}?error=access_denied&state=s1`
    const w = await mountAndSubmit({ action: 'deny', redirectUrl: denied })
    expect(tab!.location.href).toBe(denied)
    expect(w.find('[data-testid="authorize-handoff-sent"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-handoff-copy"]').exists()).toBe(true)
  })

  it('a tab the user closed while the request ran counts as not delivered (deny keeps the hand-off)', async () => {
    const denied = `${LOOPBACK}?error=access_denied&state=s1`
    const w = await mountAndSubmit({ action: 'deny', redirectUrl: denied, beforePostResolves: () => { tab!.closed = true } })
    expect(tab!.location.href).toBe('about:blank') // a closed window is never navigated
    expect(w.find('[data-testid="authorize-handoff"]').exists()).toBe(true)
  })

  it('…and on approve goes straight to the paste-back fallback, still polling', async () => {
    const w = await mountAndSubmit({ beforePostResolves: () => { tab!.closed = true } })
    expect(w.find('[data-testid="authorize-undelivered"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBeGreaterThan(0)
  })

  it('a stalled authorize request times out: the error is shown, the tab closed, and Approve/Deny are offered again', async () => {
    const w = await mountAndSubmit({ postHangs: true })
    expect(w.find('[data-testid="authorize-approve"]').text()).toContain('Authorizing')
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect(w.text()).toContain('took too long')
    expect(tab!.close).toHaveBeenCalled()
    expect(w.find('[data-testid="authorize-approve"]').text()).toContain('Approve')
  })

  it('leaving the page mid-request cancels it and closes the pre-opened tab', async () => {
    const w = await mountAndSubmit({ postHangs: true })
    w.unmount()
    await flushPromises()
    expect(tab!.close).toHaveBeenCalled()
    expect(tab!.location.href).toBe('about:blank')
  })

  it('failed status polls (e.g. 429) back off to the slow interval instead of retrying every second', async () => {
    statusFails = true
    await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(1000) // first poll fails
    const afterFirst = statusCalls
    await vi.advanceTimersByTimeAsync(4000) // inside the 5 s back-off
    expect(statusCalls).toBe(afterFirst)
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(afterFirst + 1)
  })


})

describe('/oauth/authorize — the paste-back is expected, not a surprise (#478)', () => {
  it('a loopback client gets the container/SSH hint under Approve, gone once approved', async () => {
    const w = await mountAndSubmit({ postHangs: true })
    // Still submitting: the buttons and hint are up.
    expect(w.find('[data-testid="authorize-paste-hint"]').exists()).toBe(true)
    const done = await mountAndSubmit()
    expect(done.find('[data-testid="authorize-paste-hint"]').exists()).toBe(false)
  })

  it('an https client gets no hint (it is never asked to paste)', async () => {
    const w = await mountAndSubmit({ redirectUri: 'https://client.example/cb', postHangs: true })
    expect(w.find('[data-testid="authorize-paste-hint"]').exists()).toBe(false)
  })

  it('a blocked popup names the browser as the cause, not a container', async () => {
    tab = null
    const w = await mountAndSubmit()
    expect(w.find('[data-testid="authorize-popup-missing"]').exists()).toBe(true)
    expect(w.find('[data-testid="authorize-undelivered"]').text()).not.toContain('container')
  })

  it('an unreachable client (popup opened, nothing redeemed) names the container/SSH cause', async () => {
    const w = await mountAndSubmit()
    await vi.advanceTimersByTimeAsync(9000)
    expect(w.find('[data-testid="authorize-popup-missing"]').exists()).toBe(false)
    expect(w.find('[data-testid="authorize-undelivered"]').text()).toContain('container or over SSH')
  })

  it('a close() that throws (a severed handle) does not stop Connected', async () => {
    const w = await mountAndSubmit()
    tab!.close.mockImplementation(() => {
      throw new Error('severed')
    })
    redeemed = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.find('[data-testid="authorize-delivered"]').exists()).toBe(true)
  })
})
