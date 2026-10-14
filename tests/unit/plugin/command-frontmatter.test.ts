/*
 * command-frontmatter — S1 fix 8: narrow command grants + safe $ARGUMENTS
 * interpolation.
 *
 * A slash command's `allowed-tools: Bash(node:*)` lets the MODEL run ANY
 * node invocation, not just the one the command documents — a hostile repo
 * that gets its own text into the model's context (a comment, a README, an
 * injected instruction) could steer it to run something else entirely under
 * the SAME grant. Every command must narrow its grant to the ONE script it
 * actually runs.
 *
 * Within a command's fenced bash block, `$ARGUMENTS` must be interpolated
 * SAFELY for what the target script expects:
 *   - a script that takes MULTIPLE space-separated flags (backfill.mjs, whose
 *     own parseArgs already rejects an unrecognised flag) needs $ARGUMENTS
 *     BARE/unquoted so the shell splits it into separate argv tokens —
 *     quoting it (statusline.md's shape) would pass the whole thing as ONE
 *     token and break multi-flag use. This is a DOCUMENTED, deliberate
 *     exception, not an oversight.
 *   - a script that takes at most ONE value (statusline-toggle.mjs: on/off)
 *     must double-quote it so a value is never re-split/globbed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

// Vitest runs with cwd at the repo root (see version-sync.test.ts / claude-redeem.test.ts).
const COMMANDS_DIR = join(process.cwd(), 'plugin/commands')

function parseFrontmatter(content: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** Every ```bash ... ``` fenced block's raw content, concatenated. */
function fencedBashBlocks(content: string): string[] {
  return [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
}

const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))

describe('command-frontmatter — allowed-tools is never the blanket Bash(node:*) grant', () => {
  it.each(commandFiles)('%s does not grant bare Bash(node:*)', (file) => {
    const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
    const fm = parseFrontmatter(content)
    expect(fm['allowed-tools'], `${file} has no allowed-tools frontmatter`).toBeDefined()
    // A bare Bash(node:*) entry (optionally comma-separated with others) —
    // reject it as a whole entry, not merely as a substring (a narrowed grant
    // like Bash(node "${CLAUDE_PLUGIN_ROOT}/...":*) legitimately CONTAINS the
    // substring "Bash(node" and must not be flagged).
    const entries = (fm['allowed-tools'] ?? '').split(',').map((s) => s.trim())
    expect(entries, `${file}'s allowed-tools grants bare Bash(node:*)`).not.toContain('Bash(node:*)')
  })

  it('every command narrows to a SPECIFIC script path, not just "not the blanket grant"', () => {
    for (const file of commandFiles) {
      const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
      const fm = parseFrontmatter(content)
      const entries = (fm['allowed-tools'] ?? '').split(',').map((s) => s.trim())
      for (const entry of entries.filter((e) => e.startsWith('Bash('))) {
        // node <script>.mjs, or (Windows without Node, #408) Windows PowerShell,
        // by its ABSOLUTE system path, running ONE plugin .ps1 with the fixed flag set.
        expect(entry, `${file}'s Bash grant "${entry}" does not name a specific script`).toMatch(
          /^Bash\((?:node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w.-]+\.mjs"|C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w.-]+\.ps1"):\*\)$/,
        )
      }
      // The PowerShell tool (Windows without Git Bash): the same one-script
      // invocation, exact, or with the `:*` prefix form for a script that takes
      // arguments (the redeem's handoff code). Claude Code parses the PowerShell
      // AST and requires EVERY subcommand of a compound command (`;`, `|`) to
      // match a rule, so the prefix cannot approve a chained command.
      for (const entry of entries.filter((e) => e.startsWith('PowerShell('))) {
        expect(entry, `${file}'s PowerShell grant "${entry}" does not name a specific script`).toMatch(
          /^PowerShell\(C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w.-]+\.ps1"(?::\*)?\)$/,
        )
      }
    }
  })
})

describe('command-frontmatter — $ARGUMENTS is never interpolated unsafely for its target script', () => {
  // The ONE documented exception: backfill.mjs takes MULTIPLE space-separated
  // flags and its own parseArgs rejects an unrecognised one — bare/unquoted
  // $ARGUMENTS is REQUIRED there (quoting would break multi-flag use).
  const ALLOWS_BARE_ARGUMENTS = new Set(['backfill.md'])

  it.each(commandFiles)('%s: $ARGUMENTS in a fenced bash block is either double-quoted, or the documented bare exception', (file) => {
    const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
    for (const block of fencedBashBlocks(content)) {
      if (!block.includes('$ARGUMENTS')) continue
      const bareUsage = /(?<!")\$ARGUMENTS(?!")/.test(block) && !block.includes('"$ARGUMENTS"')
      if (bareUsage) {
        expect(ALLOWS_BARE_ARGUMENTS.has(file), `${file} interpolates $ARGUMENTS unquoted but is not the documented backfill.md exception`).toBe(true)
      }
    }
  })

  it('backfill.md really is bare (multi-flag) — a regression pin so "fixing" it to quoted silently breaks multi-flag use', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'backfill.md'), 'utf8')
    const [block] = fencedBashBlocks(content)
    expect(block).toContain(' $ARGUMENTS')
    expect(block).not.toContain('"$ARGUMENTS"')
  })

  it('statusline.md is double-quoted (a single on/off value, never split/globbed)', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'statusline.md'), 'utf8')
    const [block] = fencedBashBlocks(content)
    expect(block).toContain('"$ARGUMENTS"')
  })
})

describe('command-frontmatter — setup.md step 4 is a FIXED command, not the old "authoritative tool response" prose', () => {
  it('the documented redeem invocation passes only --handoff-code — never --redeem-url or --api-base', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
    // Select the redeem block by IDENTITY, not by position. setup.md now opens
    // with the device-id.mjs block (S16b — step 2 asks the credential-free
    // helper for the instance id instead of telling the model to open
    // ~/.claude/settings.json, which holds the durable emit credential), so
    // "the first fenced block" is no longer the redeem command.
    const blocks = fencedBashBlocks(content).filter((b) => b.includes('claude-redeem.mjs'))
    expect(blocks, 'setup.md documents no claude-redeem.mjs invocation').toHaveLength(1)
    expect(blocks[0]).toContain('--handoff-code')
    // Checked across EVERY block, not just the redeem one: the grant is scoped to
    // the script, so a stray --api-base in any documented invocation is reachable.
    for (const block of fencedBashBlocks(content)) {
      expect(block).not.toContain('--redeem-url')
      expect(block).not.toContain('--api-base')
    }
  })

  it('no longer defers to "the tool response is the authoritative command"', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
    expect(content).not.toMatch(/authoritative command/i)
  })

  it('the PowerShell lane redeem (#408) is the same fixed --handoff-code invocation, and is granted', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
    const blocks = fencedBashBlocks(content).filter((b) => b.includes('claude-redeem.ps1'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].trim()).toBe(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1" --handoff-code <code>',
    )
    expect(parseFrontmatter(content)['allowed-tools']).toContain(
      'Bash(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1":*)',
    )
  })

  it('every PowerShell-lane script is granted to the PowerShell tool too, in the Bash grant\'s shape', () => {
    // On Windows the model may run the step through the PowerShell tool rather
    // than Bash; without the grant the redeem stops on a permission prompt.
    // Every command file, not only setup.md: the class is "a .ps1 granted to Bash only".
    for (const file of readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))) {
      const fileTools = String(parseFrontmatter(readFileSync(join(COMMANDS_DIR, file), 'utf8'))['allowed-tools'] ?? '')
      for (const [, cmd] of fileTools.matchAll(/Bash\(((?:[A-Za-z]:\/[^ ]*\/)?powershell\.exe [^)]*)\)/g)) {
        const bare = cmd.replace(/:\*$/, '')
        const grants = [`PowerShell(${cmd})`, `PowerShell(${bare})`]
        expect(grants.some((g) => fileTools.includes(g)), `${file}: no PowerShell grant for ${bare}`).toBe(true)
      }
    }
    const tools = String(parseFrontmatter(readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8'))['allowed-tools'])
    expect(tools).toContain(
      'PowerShell(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1":*)',
    )
  })
})

describe('command-frontmatter — setup.md step 0 picks the lane BEFORE the consent (#408 S6)', () => {
  const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
  const at = (s: string) => {
    const i = content.indexOf(s)
    expect(i, `setup.md does not contain ${JSON.stringify(s)}`).toBeGreaterThan(-1)
    return i
  }

  it('the runtime check comes before step 1 (my_usage, which can start the OAuth consent)', () => {
    expect(at('### 0. Detect the platform and runtime')).toBeLessThan(at('### 1. Ensure the MCP connection'))
    expect(at('scripts/device-id.mjs" --tool claude-code')).toBeLessThan(at('### 1. Ensure the MCP connection'))
  })

  it('POSIX without Node stops before provision_emit and names the install line per OS', () => {
    const step0 = content.slice(at('### 0.'), at('### 1.'))
    expect(step0).toMatch(/STOP here/)
    expect(step0).toMatch(/Do not call\s+`my_usage` or `provision_emit`/)
    expect(step0).toContain('sudo apt-get install -y nodejs')
    expect(step0).toContain('brew install node')
    expect(step0).toMatch(/container/)
  })

  it('Windows without Node takes the PowerShell lane and explains emit-only before step 1', () => {
    const step0 = content.slice(at('### 0.'), at('### 1.'))
    expect(step0).toContain('scripts/device-id.ps1"')
    expect(step0).toContain('emit-only')
    expect(step0).toContain('winget install OpenJS.NodeJS.LTS')
  })
})

describe('command-frontmatter — Windows PowerShell is never resolved through PATH', () => {
  // The redeem invocation carries a one-time handoff code in argv. Claude Code
  // runs it with the session's merged env, where a repository can set PATH, so
  // a bare `powershell.exe` could resolve to a planted binary that captures and
  // redeems the code. Every documented invocation and every grant names the
  // absolute system path, in the unquoted forward-slash form that runs verbatim
  // in both Git Bash and the PowerShell tool.
  const ABSOLUTE = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  // docs/skills is internal-only: in the public snapshot only the shipped
  // command files are checked.
  const SKILLS_DIR = join(process.cwd(), 'docs/skills/tokenscope')
  const HAS_SKILLS = !PUBLIC_SNAPSHOT
  const docs = [
    ...commandFiles.map((f) => join(COMMANDS_DIR, f)),
    ...(HAS_SKILLS ? readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md')).map((f) => join(SKILLS_DIR, f)) : []),
  ]
  // An invocation is the interpreter name followed by a flag. Prose that only
  // names the executable (the troubleshooting row) is not one.
  const invocation = /\b(?:powershell|pwsh)(?:\.exe)?\s+-/gi

  it.each(docs)('%s starts every PowerShell invocation with the absolute system path', (file) => {
    const content = readFileSync(file, 'utf8')
    for (const m of content.matchAll(invocation)) {
      const start = m.index
      const prefix = content.slice(Math.max(0, start - (ABSOLUTE.length - 'powershell.exe'.length)), start)
      expect(`${prefix}${m[0]}`, `${file} runs PowerShell by bare name: ${JSON.stringify(m[0])}`).toMatch(
        /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe\s+-$/,
      )
    }
  })

  it.each(commandFiles)('%s grants PowerShell only by its absolute path', (file) => {
    const entries = String(parseFrontmatter(readFileSync(join(COMMANDS_DIR, file), 'utf8'))['allowed-tools'] ?? '')
      .split(',')
      .map((s) => s.trim())
    for (const entry of entries) {
      const inner = /^(?:Bash|PowerShell)\((.*)\)$/.exec(entry)?.[1] ?? ''
      if (!/powershell|pwsh/i.test(inner)) continue
      expect(inner.startsWith(`${ABSOLUTE} `), `${file}: grant "${entry}" does not start with ${ABSOLUTE}`).toBe(true)
    }
  })

  it('names the fallback for a Windows not installed on C:', () => {
    const files = [join(COMMANDS_DIR, 'setup.md'), join(COMMANDS_DIR, 'status.md')]
    if (HAS_SKILLS) files.push(join(SKILLS_DIR, 'tokenscope-setup.md'))
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).toContain('$env:SystemRoot')
    }
  })
})
