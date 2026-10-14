// @vitest-environment node
/*
 * setup-prompt-credential-hygiene — S16b.
 *
 * The product's own setup prompts used to instruct the AI agent to OPEN the file
 * that holds this device's durable emit credential, purely to fish one non-secret
 * field out of it:
 *
 *   ~/.claude/settings.json    env.OTEL_RESOURCE_ATTRIBUTES (the instance id) is a
 *                              SIBLING KEY of env.TOKENSCOPE_OAUTH_REFRESH_TOKEN
 *                              (plugin/scripts/claude-redeem.mjs writes both into
 *                              one `env` object).
 *   ~/.tokenscope/config.json  instance_id is a FLAT SIBLING of oauth_refresh_token
 *                              (plugin/scripts/copilot-redeem.mjs writes both).
 *
 * That fired on the NORMAL setup flow — no attacker, every device — and pulled a
 * long-lived credential into the model's context and the session transcript. The
 * fix is plugin/scripts/device-id.mjs: it reads the store out-of-process and
 * prints only non-secret fields, so every prompt can name a COMMAND instead of a
 * credential-bearing file.
 *
 * These assertions pin that across ALL FIVE setup-prompt surfaces, because the
 * same instruction was duplicated into each of them and a fix that reached only
 * one is the failure mode this file exists to catch:
 *   1. plugin/commands/setup.md                        (Claude client copy)
 *   2. docs/skills/tokenscope/tokenscope-setup.md      (server skill SOURCE)
 *   3. server/utils/skill-prompts.gen.ts               (GENERATED, served over MCP)
 *   4. server/utils/mcp.ts provision_emit descriptions (tool + instance_id param)
 *   5. copilot-plugin/skills/tokenscope-setup/SKILL.md (Copilot lane)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'
import { SKILL_SETUP } from '../../../server/utils/skill-prompts.gen'

// Vitest runs with cwd at the repo root (see command-frontmatter.test.ts).
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * The two device stores that hold a durable emit credential. A setup prompt must
 * not name either one: naming it is what makes the agent open it.
 */
const CREDENTIAL_STORES = ['~/.claude/settings.json', '~/.tokenscope/config.json']

/**
 * The provision_emit tool declaration in mcp.ts — the `server.tool('provision_emit', …)`
 * call up to its handler. Scoped rather than scanning the whole file so the
 * assertion means "this tool's prompt text", not "this file happens not to
 * contain a string". mcp.ts is read as TEXT because importing it pulls the whole
 * Nitro/H3 server surface into a unit test; the strings under test are inline
 * literals, so text is the faithful representation of what ships to the client.
 */
function provisionEmitDeclaration(): string {
  const src = read('server/utils/mcp.ts')
  const start = src.indexOf("'provision_emit',")
  expect(start, "mcp.ts no longer registers a tool named 'provision_emit'").toBeGreaterThan(-1)
  const end = src.indexOf('async (args, extra) =>', start)
  expect(end, 'provision_emit declaration has no handler — scoping anchor moved').toBeGreaterThan(start)
  return src.slice(start, end)
}

/*
 * Surface 2 is the ONLY one of the five that is internal-only.
 * `docs/skills/` is dropped from the public mirror
 * (tools/publish/internal-only-paths.txt), so reading it there threw ENOENT and
 * failed this file on every published release.
 *
 * Drop that ONE surface when its source directory is absent rather than skipping
 * the whole suite — the other four still ship and still get asserted. Nothing is lost
 * publicly either, because surface 3 (`SKILL_SETUP`) is this file's GENERATED
 * twin: it is produced from exactly this markdown and it is what the MCP server
 * actually serves, so the prose guarantee stays pinned on the copy that ships.
 * Internally the file is tracked and all five are checked, as before.
 */
const SKILL_SOURCE_MD = 'docs/skills/tokenscope/tokenscope-setup.md'
/*
 * Keyed on the public-snapshot marker, not on the directory or the file: either
 * would make a DELETED prompt look like the mirror, so an internal deletion would
 * silently drop this surface instead of failing. Here `read()` throws, loudly.
 */
const HAS_SKILL_SOURCE = !PUBLIC_SNAPSHOT

const SURFACES: Array<{ label: string; text: () => string }> = [
  { label: 'plugin/commands/setup.md (Claude client copy)', text: () => read('plugin/commands/setup.md') },
  ...(HAS_SKILL_SOURCE
    ? [
        {
          label: `${SKILL_SOURCE_MD} (server skill source)`,
          text: () => read(SKILL_SOURCE_MD),
        },
      ]
    : []),
  { label: 'SKILL_SETUP (generated, served over MCP)', text: () => SKILL_SETUP },
  { label: 'mcp.ts provision_emit descriptions', text: provisionEmitDeclaration },
  {
    label: 'copilot-plugin/skills/tokenscope-setup/SKILL.md (Copilot lane)',
    text: () => read('copilot-plugin/skills/tokenscope-setup/SKILL.md'),
  },
]

describe('setup prompts never name a file that holds the durable emit credential', () => {
  for (const { label, text } of SURFACES) {
    for (const store of CREDENTIAL_STORES) {
      it(`${label} does not name ${store}`, () => {
        expect(
          text(),
          `${label} names ${store}. That file holds TOKENSCOPE_OAUTH_REFRESH_TOKEN as a sibling of the instance id, so pointing the model at it leaks a durable credential into the transcript on the NORMAL setup flow. Use the device-id helper instead.`,
        ).not.toContain(store)
      })
    }
  }
})

describe('setup prompts point at the credential-free device-id helper instead', () => {
  it('the Claude client copy runs device-id.mjs and grants exactly that command', () => {
    const content = read('plugin/commands/setup.md')
    expect(content).toContain('scripts/device-id.mjs')
    // The grant must name the ONE script the command runs (the narrow-grant rule
    // command-frontmatter.test.ts enforces for every other command).
    expect(content).toContain('Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.mjs":*)')
  })

  it('the generated server prompt runs device-id.mjs', () => {
    expect(SKILL_SETUP).toContain('scripts/device-id.mjs')
  })

  it('the Copilot skill runs device-id.mjs with --tool copilot-cli', () => {
    const content = read('copilot-plugin/skills/tokenscope-setup/SKILL.md')
    expect(content).toContain('device-id.mjs')
    expect(content).toContain('--tool copilot-cli')
  })

  it('the provision_emit tool description sends the caller to the helper, not a file', () => {
    expect(provisionEmitDeclaration()).toContain('device-id helper')
  })
})

describe('the SERVER skill copy carries the round-1 S1 prose fix too', () => {
  /*
   * Round 1 removed "the tool response is the authoritative command" from the
   * CLIENT copy (plugin/commands/setup.md) and pinned it there
   * (command-frontmatter.test.ts), but never reached this SERVER copy — which
   * ships to every MCP client, including Copilot CLI. Pin both halves here so the
   * pair can't drift apart again.
   */
  // `.skipIf` for the same reason surface 2 is conditional above: this markdown
  // is internal-only and absent from the published mirror. Its GENERATED twin is
  // asserted immediately below and does ship, so the pair is still pinned there.
  it.skipIf(!HAS_SKILL_SOURCE)('the skill source no longer defers to "the authoritative command"', () => {
    expect(read(SKILL_SOURCE_MD)).not.toMatch(/authoritative command/i)
  })

  it('the generated prompt no longer defers to "the authoritative command"', () => {
    expect(SKILL_SETUP).not.toMatch(/authoritative command/i)
  })

  it('the generated prompt documents a FIXED redeem invocation (--handoff-code only)', () => {
    expect(SKILL_SETUP).toContain('--handoff-code')
    expect(SKILL_SETUP).not.toContain('--redeem-url')
    expect(SKILL_SETUP).not.toContain('--api-base')
  })
})
