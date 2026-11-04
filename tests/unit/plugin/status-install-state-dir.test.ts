/*
 * #449: /tokenscope:status in a Claude Desktop session (its own
 * CLAUDE_CONFIG_DIR) reads the store that install's helper names, not the
 * default ~/.tokenscope one the CLI uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../plugin/scripts/plugin-runtime.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../plugin/scripts/plugin-runtime.mjs')>()
  return { ...real, runEmitHelper: () => ({ ran: true, status: 0, hasAuth: true }) }
})

const { probeEmissionAuth } = await import('../../../plugin/scripts/status.mjs')
const { realHome } = await import('../../../plugin/scripts/plugin-runtime.mjs')
const { buildHelperCommand } = await import('../../../plugin/scripts/env-builder.mjs')

const iid = '9a1e0000-0000-4000-8000-000000000449'
const bearer = `https://ts.example/api/v1/instances/${iid}/bearer`
let root: string
const saved = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  // Under the passwd home: CLAUDE_CONFIG_DIR and --state-dir are confined to it.
  root = mkdtempSync(join(realHome(), '.ts-status-install-'))
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved
  rmSync(root, { recursive: true, force: true })
})

describe('status reads this install’s store', () => {
  it('a Desktop config folder whose helper names its own --state-dir is configured from that store', () => {
    const cfg = join(root, '.claude-desktop')
    const state = join(root, 'desktop-state')
    mkdirSync(cfg)
    mkdirSync(state)
    writeFileSync(
      join(cfg, 'settings.json'),
      JSON.stringify({
        otelHeadersHelper: buildHelperCommand(
          { tool: 'claude-code', platform: process.platform, stateDir: state },
          { scriptsDir: join(realHome(), 'plugin', 'scripts') },
        ),
      }),
    )
    writeFileSync(
      join(state, 'config.claude-code.json'),
      JSON.stringify({
        version: 2,
        tool: 'claude-code',
        instance_id: iid,
        bearer_endpoint: bearer,
        oauth_token_endpoint: 'https://ts.example/api/v1/oauth/token',
        oauth_client_id: 'cid',
        oauth_refresh_token: 'rt_in_store',
        otel_resource_attributes: `tokenscope.instance_id=${iid},tool=claude-code`,
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = cfg
    const v = probeEmissionAuth({ TOKENSCOPE_BEARER_ENDPOINT: bearer })
    expect(v.message).toMatch(/^OK:/)
  })
})
