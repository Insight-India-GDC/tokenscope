/*
 * require-front-door — Azure Front Door header enforcement.
 *
 * AFD injects an `X-Azure-FDID` header carrying its instance ID, and this
 * middleware rejects any request that lacks it or carries another value.
 *
 * WHAT IT IS WORTH DEPENDS ON THE POSTURE:
 *   - VNet + Front Door Premium over Private Link: the environment is
 *     internal, so only Front Door's private endpoint reaches the app. The
 *     network is the boundary; this check is defence in depth.
 *   - Public ingress + Front Door Standard (the sandbox example): the app's
 *     own address stays public and this check is the ONLY thing keeping
 *     callers on Front Door. It is not a network boundary. The FDID is not a
 *     secret (it is in deployment outputs, workflow inputs and parameter
 *     files), so a direct caller who has it skips the WAF, and also chooses
 *     the X-Azure-SocketIP the rate limiter and the OAuth registration ceiling
 *     key on. App authentication still applies to every route. Accepted for an
 *     example deployment; production uses the VNet posture.
 *
 * Three-apply rollout (docs/DEPLOY-AZURE.md §Front Door):
 *   Apply 1: no Front Door. AZURE_FRONT_DOOR_ID empty; no-op.
 *   Apply 2: Front Door created, AZURE_FRONT_DOOR_ID still empty; still a
 *            no-op, so on public ingress the app is reachable directly and
 *            the WAF can be walked around until apply 3.
 *   Apply 3: frontDoorId set. Middleware enforces; direct hits get 403.
 *
 * The env var rather than a hard-coded value lets the same image deploy
 * to sandbox / staging / production with each env's own AFD instance.
 *
 * AZURE_FRONT_DOOR_REQUIRED: when `'true'` AND `AZURE_FRONT_DOOR_ID` is
 * still empty, the middleware REFUSES every request except EXCLUDED_PATHS
 * instead of no-op'ing. No template sets it: an operator would have to set it
 * on the revision by hand, and the next apply's env list drops it. It would
 * also 403 Front Door itself until apply 3. Unset, the no-op above holds — do
 * not remove that no-op, initial provisioning depends on it.
 *
 * Excluded paths (allowed to bypass the check):
 *   - /api/health — Container Apps' internal LB calls this directly
 *     (not via AFD); blocking it would loop-restart the replicas.
 *     Note: the CA probe doesn't carry the X-Azure-FDID header, hence
 *     the bypass.
 *
 * Note on logging: we log the request path and a coarse signal of
 * whether the header was present, but NOT the expected/received ID,
 * following the codebase convention "don't log known-good values".
 *
 * RFC-9457 error shape: matches validate-session.ts + the rest of the
 * codebase. type/title/status/detail under `data`.
 */
import { defineEventHandler, getHeader, createError, type H3Event } from 'h3'

const FRONT_DOOR_HEADER = 'x-azure-fdid'

// Paths that bypass the FDID check. /api/health is hit by ACA's internal
// load balancer (probes don't transit AFD); enforcing here would mark
// replicas unhealthy and trigger a restart loop. Keep this list tight —
// every excluded path is an attack surface that skips the WAF.
const EXCLUDED_PATHS = new Set<string>(['/api/health'])

// The exemption must compare the path the router dispatches (event.path up to
// '?', not URL-normalised): getRequestURL resolves dot segments, so
// `/api/v1/mcp/x/../../../health` would read as `/api/health` here while the
// router serves the MCP catch-all. No other path rejection: `.well-known`,
// OAuth query strings, MCP subpaths and /_nuxt assets must keep passing.
function routedPath(event: H3Event): string {
  const path = event.path
  const q = path.indexOf('?')
  return q === -1 ? path : path.slice(0, q)
}

// Reject. Log path + coarse header-presence signal so an operator can
// debug "the API stopped responding from my laptop" without us dumping
// the expected value to logs.
//
// We `throw createError(...)` rather than `sendError(...)`. The h3
// dispatcher catches the thrown H3Error and writes the RFC-9457 response
// envelope; using sendError() here would write the response but let
// middleware execution fall through, which can produce double-responses
// in downstream handlers. h3's own docstring recommends throw createError
// for the rejection path.
function reject(path: string, headerPresent: boolean): never {
  console.warn(`[require-front-door] rejected request path=${path} headerPresent=${headerPresent}`)
  throw createError({
    statusCode: 403,
    statusMessage:
      'Direct access to the Container App is not permitted; route via Azure Front Door.',
    data: {
      type: 'https://tokenscope.example.com/errors/front-door-required',
      title: 'Front Door required',
      status: 403,
      detail:
        'This request did not arrive through the Azure Front Door distribution that fronts TokenScope. The Container App rejects direct-to-origin traffic. If you are an operator debugging from the *.azurecontainerapps.io URL, hit /api/health (excluded) or unset AZURE_FRONT_DOOR_ID locally.',
    },
  })
}

export default defineEventHandler((event) => {
  const expected = process.env.AZURE_FRONT_DOOR_ID
  const required = process.env.AZURE_FRONT_DOOR_REQUIRED === 'true'

  // Empty env var = applies 1 and 2 of the rollout, or no Front Door at
  // all. A deliberate no-op unless AZURE_FRONT_DOOR_REQUIRED='true'.
  if (!expected || expected.length === 0) {
    if (!required) return
    const path = routedPath(event)
    if (EXCLUDED_PATHS.has(path)) return
    reject(path, false)
  }

  const path = routedPath(event)
  if (EXCLUDED_PATHS.has(path)) return

  const received = getHeader(event, FRONT_DOOR_HEADER)

  // Header present AND matches → allow. Plain equality: the AFD instance ID
  // is not a secret, so there is nothing for a timing attack to recover.
  if (typeof received === 'string' && received === expected) return

  reject(path, typeof received === 'string')
})
