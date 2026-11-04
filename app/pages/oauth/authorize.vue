<script setup lang="ts">
/*
 * OAuth consent page. GET /api/v1/oauth/authorize validates the session + client
 * and 302s here; Approve/Deny POSTs back with Accept: application/json and gets
 * the callback URL as DATA. An approved LOOPBACK callback (RFC 8252 native app)
 * is delivered in a small popup opened on the Approve click (a navigation, so
 * Local Network Access does not block it), and this page stays in view behind
 * it. It polls /api/v1/oauth/code-status: redeemed → close the popup, Connected;
 * not redeemed within UNDELIVERED_AFTER_MS → the loopback is unreachable (a
 * client in a container or over SSH), so it closes the popup, whose browser
 * error page would otherwise sit in front, and leads with the paste-back steps
 * (#478). The words follow Claude Code's own prompt for an MCP sign-in, which
 * asks for "the URL from your browser's address bar" at `URL >`.
 *
 * Closing the popup after it has navigated needs the window handle to survive
 * the cross-origin navigation, so this page is served with COOP
 * `same-origin-allow-popups` (nuxt.config.ts routeRules); the site default
 * `same-origin` severs it.
 */
import { isAllowedCallbackScheme, isLoopbackCallback } from '#shared/oauth-callback'
import type { AuthorizeResult } from '#shared/schemas/oauth'
// Shared with the server grant-review UIs so consent + review read the same words.
import { oauthScopeLabel as scopeLabel } from '#shared/oauth-scopes'

definePageMeta({ layout: false })

const route = useRoute()

const responseType = computed(() => (route.query.response_type as string) || '')
const clientId = computed(() => (route.query.client_id as string) || '')
const redirectUri = computed(() => (route.query.redirect_uri as string) || '')
const codeChallenge = computed(() => (route.query.code_challenge as string) || '')
const codeChallengeMethod = computed(() => (route.query.code_challenge_method as string) || '')
const state = computed(() => (route.query.state as string) || '')
const scope = computed(() => (route.query.scope as string) || '')

const paramError = computed(() => {
  if (!clientId.value) return 'Missing client_id parameter'
  if (!redirectUri.value) return 'Missing redirect_uri parameter'
  if (!codeChallenge.value) return 'Missing code_challenge parameter (PKCE required)'
  if (codeChallengeMethod.value && codeChallengeMethod.value !== 'S256')
    return 'Invalid code_challenge_method — only S256 is supported'
  return null
})

/*
 * Client identity + the effective granted scope set (S6) — fetched from the
 * SAME GET /api/v1/oauth/authorize handler that already validated client_id +
 * redirect_uri against the DB (server/api/v1/oauth/authorize.get.ts), never
 * read from route.query. This page is a directly-navigable Nuxt route, so an
 * attacker can link straight to it with any query params they like — a
 * client_name (or scope list) sourced from route.query would be exactly as
 * trustworthy as whatever the attacker put in the link. Sourcing it from this
 * fetch's response instead means the rendered name/host/scopes are always the
 * server's own validated row for the given client_id, and an unknown scope
 * can never reach scopeLabel() from this page.
 */
interface ClientInfo {
  client_name: string
  redirect_host: string
  granted_scopes: string[]
}
type ClientInfoFetcher = (
  path: string,
  opts: { method: 'GET'; query: Record<string, string>; headers: Record<string, string> },
) => Promise<ClientInfo>

const clientInfo = ref<ClientInfo | null>(null)
const clientInfoError = ref<string | null>(null)
const scopes = computed(() => clientInfo.value?.granted_scopes ?? [])

async function loadClientInfo() {
  if (paramError.value) return
  // useRequestFetch forwards the SSR cookie (mirrors useSession.ts) — without
  // it this call would look unauthenticated during server rendering.
  const fetcher: ClientInfoFetcher = import.meta.server
    ? (useRequestFetch() as ClientInfoFetcher)
    : ($fetch as ClientInfoFetcher)
  try {
    clientInfo.value = await fetcher('/api/v1/oauth/authorize', {
      method: 'GET',
      query: {
        response_type: responseType.value || 'code',
        client_id: clientId.value,
        redirect_uri: redirectUri.value,
        code_challenge: codeChallenge.value,
        code_challenge_method: codeChallengeMethod.value || 'S256',
        scope: scope.value,
        state: state.value,
      },
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    const e = err as { data?: { error_description?: string; error?: string }; message?: string }
    clientInfoError.value =
      e?.data?.error_description || e?.data?.error || e?.message || 'Could not verify this client.'
  }
}
await loadClientInfo()

const submitting = ref(false)
const callbackUrl = ref<string | null>(null)
const submitError = ref<string | null>(null)
const copied = ref(false)
const submitAction = ref<'approve' | 'deny' | null>(null)

// Fast while the client should be answering, then slow for a manual paste: ~35
// requests per consent, inside the per-IP 150/5 min limiter the rest of the app
// shares. A failed poll (429, 5xx, timeout) waits the slow interval.
const FAST_POLL_MS = 1000
const SLOW_POLL_MS = 5000
const UNDELIVERED_AFTER_MS = 8000
const POLL_UNTIL_MS = 2 * 60 * 1000
// A stalled request must not freeze polling, the deadline, or the consent itself.
const STATUS_TIMEOUT_MS = 4000
const AUTHORIZE_TIMEOUT_MS = 15_000
const delivery = ref<'none' | 'delivering' | 'delivered' | 'undelivered'>('none')
// A popup, not a tab, so this page stays visible behind it. Opened as
// about:blank in the click (popup blockers allow it) and navigated once the
// callback URL passes the scheme guard.
const DELIVERY_POPUP = 'popup,width=480,height=360'
let blankTab: Window | null = null
// The popup the code was delivered in, kept to close it once the outcome is
// known: on redeemed (the client's own page has done its job) and on undelivered
// (it shows a browser error that would hide the paste-back steps).
let deliveryPopup: Window | null = null
// The popup never opened (blocked) or was closed before it could deliver: the
// cause is the browser, not a container, and the copy says so.
const popupMissing = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let undeliveredTimer: ReturnType<typeof setTimeout> | null = null
let statusAbort: AbortController | null = null
let authorizeAbort: AbortController | null = null
let unmounted = false
// A deny/error callback for the waiting client, for every scheme the guard
// allows. Nothing can confirm a client received it (there is no code to poll),
// so Copy URL stays even after it was sent: an unreachable (e.g. containerized)
// client can only get it by paste. Open is a click, a user gesture that popup
// blockers allow.
const handoffUrl = ref<string | null>(null)
const handoffSent = ref(false)

function closeDeliveryPopup() {
  try {
    deliveryPopup?.close()
  } catch {
    /* a severed handle: nothing to close from here */
  }
  deliveryPopup = null
}

onBeforeUnmount(() => {
  unmounted = true
  if (pollTimer) clearTimeout(pollTimer)
  if (undeliveredTimer) clearTimeout(undeliveredTimer)
  statusAbort?.abort()
  authorizeAbort?.abort()
})

/** The pre-opened tab, if the user has not closed it; navigating a closed one is silently ignored. */
function takeBlankTab(): Window | null {
  const tab = blankTab && !blankTab.closed ? blankTab : null
  blankTab = null
  return tab
}

/** Navigate `tab` to `url`; false if it could not be done. */
function navigate(tab: Window | null, url: string): boolean {
  if (!tab) return false
  try {
    tab.location.href = url
    return true
  } catch {
    return false
  }
}

function pollRedeemed(code: string, startedAt: number, lastFailed = false) {
  const elapsedNow = Date.now() - startedAt
  const wait = lastFailed || elapsedNow >= UNDELIVERED_AFTER_MS ? SLOW_POLL_MS : FAST_POLL_MS
  pollTimer = setTimeout(async () => {
    pollTimer = null
    if (unmounted || Date.now() - startedAt >= POLL_UNTIL_MS) return
    const abort = (statusAbort = new AbortController())
    const timeout = setTimeout(() => abort.abort(), STATUS_TIMEOUT_MS)
    let failed = false
    try {
      const res = await $fetch<{ redeemed: boolean }>('/api/v1/oauth/code-status', {
        method: 'POST',
        body: { code },
        signal: abort.signal,
      })
      if (res.redeemed && !unmounted) {
        if (undeliveredTimer) clearTimeout(undeliveredTimer)
        closeDeliveryPopup()
        delivery.value = 'delivered'
        return
      }
    } catch {
      failed = true // rate-limited, errored or timed out: unknown, not "not redeemed"
    } finally {
      clearTimeout(timeout)
      statusAbort = null
    }
    if (unmounted) return
    if (Date.now() - startedAt < POLL_UNTIL_MS) pollRedeemed(code, startedAt, failed)
  }, wait)
}

/** Loopback only. `code` is null for a deny / error callback: hand it over so the client stops waiting, nothing to watch. */
function startDelivery(url: string, code: string | null) {
  if (unmounted) return
  const popup = takeBlankTab()
  const delivered = navigate(popup, url)
  if (!code) {
    handoffSent.value = delivered
    return
  }
  if (delivered) {
    deliveryPopup = popup
    delivery.value = 'delivering'
    undeliveredTimer = setTimeout(() => {
      undeliveredTimer = null
      if (delivery.value === 'delivering') {
        closeDeliveryPopup()
        delivery.value = 'undelivered'
      }
    }, UNDELIVERED_AFTER_MS)
  } else {
    popupMissing.value = true
    delivery.value = 'undelivered'
  }
  pollRedeemed(code, Date.now())
}

async function handleSubmit(action: 'approve' | 'deny') {
  submitting.value = true
  submitError.value = null
  handoffUrl.value = null
  handoffSent.value = false
  popupMissing.value = false
  submitAction.value = action
  // Opened synchronously inside the click so popup blockers allow it; it is
  // navigated only once the callback URL passes the scheme guard.
  if (isLoopbackCallback(redirectUri.value)) {
    blankTab = window.open('', '_blank', DELIVERY_POPUP)
    if (blankTab) blankTab.opener = null
  }
  const abort = (authorizeAbort = new AbortController())
  const timeout = setTimeout(() => abort.abort(), AUTHORIZE_TIMEOUT_MS)
  try {
    const body = await $fetch<AuthorizeResult>(
      '/api/v1/oauth/authorize',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: abort.signal,
        body: {
          response_type: responseType.value || 'code',
          client_id: clientId.value,
          redirect_uri: redirectUri.value,
          code_challenge: codeChallenge.value,
          code_challenge_method: codeChallengeMethod.value || 'S256',
          state: state.value,
          scope: scope.value,
          action,
        },
      },
    )
    if (unmounted) return
    if (body.outcome !== 'code' && isAllowedCallbackScheme(body.redirect_url, window.location.origin)) {
      handoffUrl.value = body.redirect_url
    }
    if (isLoopbackCallback(body.redirect_url)) {
      startDelivery(body.redirect_url, body.outcome === 'code' ? body.code : null)
    }
    if (body.outcome === 'error') submitError.value = body.error_description
    else callbackUrl.value = body.redirect_url
  } catch (err) {
    if (unmounted) return
    const e = err as { data?: { error_description?: string; error?: string }; message?: string }
    submitError.value = abort.signal.aborted
      ? 'The request took too long. Please try again.'
      : e?.data?.error_description || e?.data?.error || e?.message || 'Request failed'
  } finally {
    clearTimeout(timeout)
    authorizeAbort = null
    submitting.value = false
    blankTab?.close()
    blankTab = null
  }
}

function handOffToClient() {
  const url = handoffUrl.value
  if (!url || !isAllowedCallbackScheme(url, window.location.origin)) return
  // No 'noopener' feature: with it window.open always returns null, so a block
  // could not be told apart. The opener is severed before the tab runs script.
  const tab = window.open(url, '_blank')
  if (!tab) return
  tab.opener = null
  handoffSent.value = true
}

async function copyHandoffUrl() {
  if (!handoffUrl.value) return
  try {
    await navigator.clipboard.writeText(handoffUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* clipboard unavailable — the URL is selectable in the box */
  }
}

function openCallback() {
  if (!callbackUrl.value) return
  if (!isAllowedCallbackScheme(callbackUrl.value, window.location.origin)) {
    submitError.value = 'Refusing to open callback URL with a disallowed scheme.'
    return
  }
  window.open(callbackUrl.value, '_blank', 'noopener,noreferrer')
}

async function copyCallbackUrl() {
  if (!callbackUrl.value) return
  try {
    await navigator.clipboard.writeText(callbackUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* clipboard unavailable — the URL is selectable in the box */
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-calm p-4">
    <div class="w-full max-w-sm p-7 bg-white rounded-xl shadow-lg border border-calm-2">
      <div class="mb-5 text-center">
        <p class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">TokenScope</p>
        <h1 class="text-lg font-bold text-carbon mt-1">Authorize application</h1>
        <p class="mt-1 text-sm text-carbon-2">An MCP client wants to connect to your TokenScope account.</p>
      </div>

      <!-- Server-verified client identity — NEVER sourced from route.query
           (see loadClientInfo). "Self-registered, unverified" is honest: RFC
           7591 registration is open, so this is what the registrant CALLED
           itself, not a vetted identity. -->
      <div
        v-if="clientInfo"
        class="mb-4 rounded-lg border border-rag-amber/40 bg-rag-amber/10 px-3 py-2.5"
        data-testid="authorize-client-identity"
      >
        <p class="text-sm font-semibold text-carbon">{{ clientInfo.client_name }}</p>
        <p class="mt-0.5 text-[11px] text-[#92400E]">
          Self-registered, unverified — TokenScope hasn't vetted this application's identity.
          It will receive the authorization code at
          <span class="font-mono" data-testid="authorize-redirect-host">{{ clientInfo.redirect_host }}</span>.
        </p>
      </div>

      <div v-if="scopes.length" class="mb-5">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-carbon-3">Requested permissions</p>
        <ul class="space-y-1.5">
          <li v-for="s in scopes" :key="s" class="flex items-start gap-2 rounded-md border border-calm-2 bg-calm px-3 py-2">
            <span class="mt-0.5 text-brand-harmony">✓</span>
            <span class="text-sm text-carbon">{{ scopeLabel(s) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="paramError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" data-testid="authorize-param-error">
        {{ paramError }}
      </div>
      <div v-else-if="clientInfoError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" data-testid="authorize-client-info-error">
        {{ clientInfoError }}
      </div>
      <div v-else-if="submitError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" role="alert">
        {{ submitError }}
      </div>

      <!-- Approved + redeemed: the client has its token -->
      <div v-else-if="callbackUrl && submitAction === 'approve' && delivery === 'delivered'" class="rounded-lg border border-rag-green/30 bg-rag-green/5 p-3" data-testid="authorize-delivered">
        <p class="text-sm font-semibold text-rag-green">Connected</p>
        <p class="mt-1 text-xs text-carbon-2">Your MCP client is signed in. You can close this window.</p>
      </div>

      <!-- Approved, not picked up: the paste-back steps lead (#478), in Claude Code's words -->
      <div v-else-if="callbackUrl && submitAction === 'approve' && delivery === 'undelivered'" class="space-y-3" data-testid="authorize-approved">
        <div class="rounded-lg border border-rag-amber/40 bg-rag-amber/10 p-3" data-testid="authorize-undelivered">
          <p class="text-sm font-semibold text-carbon">Finish signing in from your terminal</p>
          <p v-if="popupMissing" class="mt-1 text-xs text-carbon-2" data-testid="authorize-popup-missing">
            Your browser blocked the window that hands the sign-in to your MCP client, or it was closed.
          </p>
          <p v-else class="mt-1 text-xs text-carbon-2">
            Your MCP client didn't pick up the sign-in by itself. That is normal when it runs in a container or over SSH.
          </p>
          <ol class="mt-2 list-decimal space-y-1 pl-4 text-xs text-carbon-2">
            <li>Copy the URL below.</li>
            <li>
              Paste it into your MCP client where it asks for the URL from your browser's address bar (Claude Code shows
              <span class="font-mono">URL &gt;</span>) and press Enter.
            </li>
          </ol>
          <p class="mt-2 text-xs text-carbon-2">If you paste it within two minutes, this page shows Connected once your client has signed in.</p>
        </div>
        <UiButton kind="primary" class="w-full" data-testid="authorize-copy" @click="copyCallbackUrl">
          {{ copied ? 'Copied!' : 'Copy URL' }}
        </UiButton>
        <p class="break-all rounded-lg border border-calm-2 bg-calm p-3 text-xs font-mono text-carbon-2" data-testid="authorize-callback-url">{{ callbackUrl }}</p>
        <p class="text-xs font-semibold text-carbon" data-testid="authorize-url-warning">
          This URL works like a password. Paste it only into the session that asked you to sign in, never for anyone else.
        </p>
        <button class="block w-full text-center text-[11px] text-carbon-3 hover:text-carbon-2" data-testid="authorize-open" @click="openCallback">
          Or try opening the callback in a new tab
        </button>
      </div>

      <!-- Approved → callback URL; Copy URL is the paste-back path while delivering, or when delivery is not attempted -->
      <div v-else-if="callbackUrl && submitAction === 'approve'" class="space-y-3" data-testid="authorize-approved">
        <div class="rounded-lg border border-rag-green/30 bg-rag-green/5 p-3">
          <p class="text-sm font-semibold text-rag-green">Authorization approved</p>
          <p v-if="delivery === 'delivering'" class="mt-1 text-xs text-carbon-2" data-testid="authorize-delivering">
            Sending the sign-in to your MCP client…
          </p>
          <p v-else class="mt-1 text-xs text-carbon-2">Copy the URL below and paste it into your MCP client when prompted.</p>
          <p v-if="delivery !== 'delivering'" class="mt-1 text-xs font-semibold text-carbon" data-testid="authorize-url-warning">
            This URL works like a password. Paste it only into the session that asked you to sign in, never for anyone else.
          </p>
        </div>
        <div class="relative rounded-lg border border-calm-2 bg-calm p-3">
          <button class="absolute right-2 top-2 rounded px-2 py-0.5 text-[11px] font-medium bg-calm-2 text-carbon-2 hover:bg-calm" data-testid="authorize-copy" @click="copyCallbackUrl">
            {{ copied ? 'Copied!' : 'Copy URL' }}
          </button>
          <p class="break-all pr-16 text-xs font-mono text-carbon-2" data-testid="authorize-callback-url">{{ callbackUrl }}</p>
        </div>
        <button v-if="delivery !== 'delivering'" class="block w-full text-center text-[11px] text-carbon-3 hover:text-carbon-2" data-testid="authorize-open" @click="openCallback">
          Or try opening the callback in a new tab
        </button>
      </div>

      <!-- Denied -->
      <div v-else-if="callbackUrl && submitAction === 'deny'" class="rounded-lg border border-rag-red/30 bg-rag-red/5 p-3" data-testid="authorize-denied">
        <p class="text-sm font-semibold text-rag-red">Authorization denied.</p>
        <p class="mt-1 text-xs text-carbon-2">You may close this window.</p>
      </div>

      <!-- Deny / error callback: kept, since nothing can confirm the client received it -->
      <div v-if="handoffUrl" class="mt-3 space-y-2" data-testid="authorize-handoff">
        <p v-if="handoffSent" class="text-xs text-carbon-2" data-testid="authorize-handoff-sent">
          Sent to your MCP client. If it didn't get it (for example, it runs in a container), copy the URL and paste it into the client.
        </p>
        <p v-else class="text-xs text-carbon-2">Your MCP client is still waiting for this answer. Open it, or copy the URL and paste it into the client.</p>
        <div class="flex gap-2">
          <button class="rounded px-2 py-1 text-xs font-medium bg-calm-2 text-carbon-2 hover:bg-calm" data-testid="authorize-handoff-open" @click="handOffToClient">
            Open in a new tab
          </button>
          <button class="rounded px-2 py-1 text-xs font-medium bg-calm-2 text-carbon-2 hover:bg-calm" data-testid="authorize-handoff-copy" @click="copyHandoffUrl">
            {{ copied ? 'Copied!' : 'Copy URL' }}
          </button>
        </div>
        <p class="break-all rounded border border-calm-2 bg-calm p-2 text-xs font-mono text-carbon-2" data-testid="authorize-handoff-url">{{ handoffUrl }}</p>
      </div>

      <!-- Consent buttons: also after a failed request, so the user can retry -->
      <div v-if="!paramError && !clientInfoError && !callbackUrl && !handoffUrl" class="flex gap-3">
        <UiButton kind="ghost" class="flex-1" :disabled="submitting" data-testid="authorize-deny" @click="handleSubmit('deny')">Deny</UiButton>
        <UiButton kind="primary" class="flex-1" :disabled="submitting" data-testid="authorize-approve" @click="handleSubmit('approve')">
          {{ submitting ? 'Authorizing…' : 'Approve' }}
        </UiButton>
      </div>
      <p v-if="!paramError && !clientInfoError && !callbackUrl && !handoffUrl && isLoopbackCallback(redirectUri)" class="mt-3 text-center text-[11px] text-carbon-2" data-testid="authorize-paste-hint">
        If your MCP client runs in a container or over SSH, you'll be asked to paste a URL back into it.
      </p>

      <p class="mt-4 text-center text-[11px] text-carbon-3">You can revoke access any time from your account settings.</p>
    </div>
  </div>
</template>
