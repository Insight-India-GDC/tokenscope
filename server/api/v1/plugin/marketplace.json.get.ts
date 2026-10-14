/*
 * GET /api/v1/plugin/marketplace.json — this deployment's own Claude Code
 * marketplace (docs/design/self-served-marketplace.md).
 *
 *   /plugin marketplace add https://<deployment>/api/v1/plugin/marketplace.json
 *
 * Anonymous: Claude Code fetches it without credentials, and it holds nothing
 * the public repository does not. The origin is the one the server vouches for
 * (trustedPublicOrigin), never the request's Host. no-store, because the sha256
 * pin changes with each image and a cached copy would name a zip no replica
 * serves any more.
 */
import { createError, defineEventHandler, setHeader } from 'h3'
import { trustedPublicOrigin } from '../../../utils/public-url'
import { PluginArchiveError, pluginArchiveFor, servedMarketplace } from '../../../utils/plugin-marketplace'
import { servedMarketplaceRefusal } from '../../../../shared/connect'

export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  const origin = trustedPublicOrigin(event)
  const refusal = servedMarketplaceRefusal(origin)
  if (refusal || !origin) throw createError({ statusCode: 503, statusMessage: 'Marketplace unavailable', data: { detail: refusal } })
  try {
    return servedMarketplace(origin, pluginArchiveFor(origin))
  } catch (err) {
    if (err instanceof PluginArchiveError) {
      throw createError({ statusCode: 503, statusMessage: 'Marketplace unavailable', data: { detail: 'The plugin could not be packaged on this deployment.' } })
    }
    throw err
  }
})
