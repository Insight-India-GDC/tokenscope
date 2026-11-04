/**
 * Where a Copilot CLI install keeps the TokenScope plugin's scripts, as a POSIX
 * `sh` fragment that sets `s` to one script's absolute path (empty when none).
 *
 * Two layouts exist (#458):
 *   - a marketplace install: `~/.copilot/installed-plugins/<marketplace>/tokenscope-copilot/`.
 *     The MARKETPLACE segment varies by how the marketplace was added, so it is
 *     globbed; the plugin segment is the marketplace entry name, a literal.
 *   - a direct (path) install: `~/.copilot/installed-plugins/_direct/<folder>/`,
 *     where <folder> is whatever the source directory was called (this repo's is
 *     `copilot-plugin`). That segment says nothing about which plugin it is, so a
 *     direct folder counts only when its own `plugin.json` has the TOP-LEVEL
 *     `name` `tokenscope` (read with node, which the scripts need anyway; a
 *     line grep would also match an author or dependency named that). Matching
 *     on the folder name alone would hand the one-time handoff code (as argv) to
 *     any other plugin installed from a folder of that name.
 *
 * A marketplace install always wins; a direct one is looked for only when there
 * is none, so a stale direct install never shadows it. Within one layout,
 * `sort -V | tail -n1` is a deterministic tie-break, not a "newest" selector:
 * the Copilot layout carries no version segment.
 *
 * The fragment contains no single quote, so it can sit inside `sh -c '...'`.
 * The skills (`copilot-plugin/skills/*\/SKILL.md`) quote it verbatim, and
 * tests/unit/server/copilot-locator.test.ts holds them to it.
 */
export function copilotScriptLocator(script: string): string {
  if (!/^[a-z0-9-]+\.mjs$/.test(script)) throw new Error(`not a plugin script name: ${script}`)
  const root = '"$HOME"/.copilot/installed-plugins'
  const isOurs =
    'node -e "try{process.exit(JSON.parse(require(\\"fs\\").readFileSync(process.argv[1],\\"utf8\\")).name===\\"tokenscope\\"?0:1)}catch(e){process.exit(1)}" "${d}plugin.json"'
  return (
    // `_direct` is excluded from the marketplace glob: a direct folder that happens
    // to be called tokenscope-copilot must pass the manifest check like any other.
    `s=$(ls -d ${root}/*/tokenscope-copilot/scripts/${script} 2>/dev/null | grep -v "/installed-plugins/_direct/" | sort -V | tail -n1); ` +
    `[ -n "$s" ] || s=$(for d in ${root}/_direct/*/; do ` +
    `[ -f "\${d}scripts/${script}" ] && ${isOurs} 2>/dev/null && echo "\${d}scripts/${script}"; done | sort -V | tail -n1)`
  )
}
