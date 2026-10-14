/*
 * GET /api/v1/plugin/<tokenscope-<version>-<sha8>.zip> — the plugin archive
 * that marketplace.json pins (docs/design/self-served-marketplace.md).
 *
 * Only the exact name this replica builds is served. During a rollout a
 * marketplace.json from the new image can reach an old replica, and handing
 * it different bytes would fail Claude Code's sha256 check with a confusing
 * error. A 404 is honest, and the name changes with the bytes, so the
 * immutable cache header can never pin stale bytes.
 */
import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { trustedPublicOrigin } from '../../../utils/public-url'
import { PluginArchiveError, pluginArchiveFor } from '../../../utils/plugin-marketplace'
import { servedMarketplaceRefusal } from '../../../../shared/connect'

export default defineEventHandler((event) => {
  const origin = trustedPublicOrigin(event)
  const refusal = servedMarketplaceRefusal(origin)
  if (refusal || !origin) {
    setHeader(event, 'cache-control', 'no-store')
    throw createError({ statusCode: 503, statusMessage: 'Marketplace unavailable', data: { detail: refusal } })
  }
  let archive
  try {
    archive = pluginArchiveFor(origin)
  } catch (err) {
    setHeader(event, 'cache-control', 'no-store')
    if (err instanceof PluginArchiveError) {
      throw createError({ statusCode: 503, statusMessage: 'Marketplace unavailable' })
    }
    throw err
  }
  if (getRouterParam(event, 'file') !== archive.fileName) {
    setHeader(event, 'cache-control', 'no-store')
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  setHeader(event, 'content-type', 'application/zip')
  setHeader(event, 'content-disposition', `attachment; filename="${archive.fileName}"`)
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return archive.bytes
})
