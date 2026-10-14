/*
 * GET /api/v1/connect/config — what the connect dialog needs to tell a developer
 * how to connect a client to THIS deployment (#415).
 *
 * The admin "Client connection" policy (mig 0151, defaults when unset) plus this
 * deployment's public origin. The origin is the pinned APP_PUBLIC_ORIGIN, else the
 * trusted request origin (Front Door / loopback). When the server cannot vouch for
 * its own origin it returns `origin: null` with a reason rather than echoing the
 * request's Host: a user would register that URL as their MCP server, and on an
 * unpinned Container App it is the internal `*.azurecontainerapps.io` name.
 *
 * Any authenticated user: nothing here is sensitive.
 */
import { defineEventHandler, setHeader } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { getClientConnectionPolicy } from '../../../db/client-connection'
import { trustedPublicOrigin } from '../../../utils/public-url'
import { servedMarketplaceUrlIfBuildable } from '../../../utils/plugin-marketplace'
import {
  CLAUDE_PLUGIN_DEFAULT_ORIGIN,
  COPILOT_PLUGIN_BUNDLED_ORIGIN,
  ORIGIN_NOT_PINNED_REASON,
  type ConnectConfig,
} from '../../../../shared/connect'

export default defineEventHandler(async (event): Promise<ConnectConfig> => {
  await requireAuth(event)
  setHeader(event, 'cache-control', 'no-store')
  const policy = await withRequestRls(event, (tx) => getClientConnectionPolicy(tx))
  const origin = trustedPublicOrigin(event)
  return {
    ...policy,
    origin,
    originMissingReason: origin ? null : ORIGIN_NOT_PINNED_REASON,
    mcpUrl: origin ? `${origin}/api/v1/mcp` : null,
    claudeBundledOrigin: CLAUDE_PLUGIN_DEFAULT_ORIGIN,
    copilotBundledOrigin: COPILOT_PLUGIN_BUNDLED_ORIGIN,
    claudeMarketplaceUrl: servedMarketplaceUrlIfBuildable(origin),
  }
})
