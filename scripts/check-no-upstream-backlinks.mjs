#!/usr/bin/env node
/*
 * No backlinks from our repository onto someone else's.
 *
 * GitHub turns `owner/repo#123` and issue / PR / commit URLs in a commit
 * message, a PR title or body, or a PR / issue comment into a "mentioned this"
 * entry ON THE REFERENCED ISSUE, naming this repository and the PR. On an
 * upstream issue (anthropics/claude-code, 2026-10-08) that put our org, repo and
 * PR title on a public page, for everyone who can see our repository. Editing
 * the text afterwards does not remove the entry, so this has to be caught
 * BEFORE the text reaches GitHub.
 *
 * A reference to a repository under OUR OWN owner is fine; anything else fails.
 * Write upstream issues as plain text ("Claude Code issue 67657"), without the
 * owner/repo, the URL, or a leading # (which would link to our own repo).
 * Files in the tree do not create backlinks and are not checked.
 *
 * Modes:
 *   --text-file <path>     check a file's text (repeatable)
 *   --stdin                check stdin
 *   --commits <range>      check every commit message in a git range
 *   --github-event         check the pull_request title and body from
 *                          $GITHUB_EVENT_PATH (CI)
 *   --hook                 Claude Code PreToolUse hook (see .claude/settings.json)
 * Exit 1 with the offending references; 0 when clean.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const REPO = '[A-Za-z0-9._-]{1,100}'
const SHORT_REF = new RegExp(`(?<![\\w/.@-])(${OWNER})/(${REPO})(?:#\\d+|@[0-9a-f]{7,40})\\b`, 'g')
const URL_REF = new RegExp(
  `(?<![\\w.-])github\\.com/(${OWNER})/(${REPO})/(?:issues|pull|discussions|commit|commits)/[0-9A-Za-z]+`,
  'gi',
)

/*
 * Our own GitHub owner: GITHUB_REPOSITORY inside GitHub Actions, else the origin
 * remote. Outside Actions the variable is just process env, which a checked-out
 * project's settings can set, so it is not trusted there.
 */
export function ownOwner(env = process.env, git = runGit) {
  const fromEnv = env.GITHUB_ACTIONS === 'true' ? (env.GITHUB_REPOSITORY ?? '').split('/')[0] : ''
  if (fromEnv) return fromEnv
  try {
    const url = git(['remote', 'get-url', 'origin']).trim()
    return url.match(/github\.com[:/]([^/]+)\//)?.[1] ?? null
  } catch {
    return null
  }
}

/** The external references in `text`, as `owner/repo…` strings. Same-owner references pass. */
export function findUpstreamRefs(text, owner) {
  const own = (owner ?? '').toLowerCase()
  const out = new Set()
  for (const re of [SHORT_REF, URL_REF]) {
    for (const m of String(text ?? '').matchAll(re)) {
      if (m[1].toLowerCase() !== own) out.add(m[0])
    }
  }
  return [...out]
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function currentBranch(git = runGit) {
  try {
    return git(['branch', '--show-current']).trim() || null
  } catch {
    return null
  }
}

function commitMessages(range, git = runGit) {
  return git(['log', '--format=%H%x00%B%x1e', range])
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, body] = c.split('\0')
      return { where: `commit ${sha.slice(0, 8)}`, text: body }
    })
}

/*
 * PreToolUse: inspect a Bash command that would publish text to GitHub. This is
 * a guard against slips, not a parser of all shell: it splits on newlines and
 * ; & | ( ), unwraps `command` / `env` / VAR=x prefixes and absolute paths, and
 * skips git's and gh's global options, then classifies the subcommand. The
 * command text itself carries -m / --body / -f values; files named by
 * --body-file, --file, -F, --input (spaced, `=` or joined forms) are read;
 * `git push` and `gh pr create --fill` check the commits they would publish
 * (against the upstream, else origin/main). A body it cannot read (a `$VAR`
 * path, stdin) is an `unreadable` text, which the gate refuses.
 *
 * What it cannot model it REFUSES rather than guesses (`unmodelledForm`, shared
 * with check-external-review.mjs and check-commit-lint.mjs). These hooks guard
 * against slips in an agent session; CI re-checks PR text and commits.
 */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const GH_GLOBAL_WITH_VALUE = new Set(['-R', '--repo', '--hostname'])

/**
 * A Bash command split into simple commands the way the shell splits it, quotes
 * removed and NOTHING expanded. Each segment records what the gates cannot see
 * through: `expands` ($ or a backtick outside single quotes), `grouped`
 * (parentheses, braces or a background &), `stdin` (< or <<), and `afterPipe`
 * (it reads the previous command's output).
 */
export function lex(command) {
  const s = String(command)
  const segs = []
  const fresh = (afterPipe) => ({ words: [], dynamic: [], raw: '', expands: false, grouped: false, stdin: false, afterPipe })
  let cur = fresh(false)
  let word = null
  let dyn = false // this word is built by expansion or globbing at run time
  const endWord = () => {
    if (word !== null) {
      cur.words.push(word)
      cur.dynamic.push(dyn)
    }
    word = null
    dyn = false
  }
  const endSeg = (afterPipe) => {
    endWord()
    if (cur.words.length) segs.push(cur)
    cur = fresh(afterPipe)
  }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") {
      const j = s.indexOf("'", i + 1)
      const end = j < 0 ? s.length : j
      word = (word ?? '') + s.slice(i + 1, end)
      cur.raw += s.slice(i, end + 1)
      i = end
    } else if (ch === '"') {
      let j = i + 1
      let buf = ''
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) buf += s[++j]
        else {
          if (s[j] === '$' || s[j] === '`') cur.expands = dyn = true
          buf += s[j]
        }
      }
      word = (word ?? '') + buf
      cur.raw += s.slice(i, j + 1)
      i = j
    } else if (ch === '\\') {
      if (s[i + 1] !== '\n') word = (word ?? '') + (s[i + 1] ?? '')
      cur.raw += s.slice(i, i + 2)
      i++
    } else if (ch === '\n' || ch === ';') {
      endSeg(false)
    } else if (ch === '&' && s[i + 1] === '&') {
      i++
      endSeg(false)
    } else if (ch === '&' && s[i + 1] === '>') {
      // &> and &>> redirect both outputs: not a background job.
      i++
      endWord()
      let k = i + 1
      while (k < s.length && s[k] === '>') k++
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++
      while (k < s.length && !/[\s;&|()<>]/.test(s[k])) k++
      cur.raw += s.slice(i - 1, k)
      i = k - 1
    } else if (ch === '>' || ch === '<') {
      // A redirection is not an argument: drop an fd number before it and its
      // target after it (2>&1, >> log, < body.md). Reading stdin is recorded.
      if (ch === '<') cur.stdin = true
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      let j = i + 1
      while (j < s.length && '<>&'.includes(s[j])) j++
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++
      let k = j
      while (k < s.length && !/[\s;&|()<>]/.test(s[k])) k++
      cur.raw += s.slice(i, k)
      i = k - 1
    } else if (ch === '&') {
      cur.grouped = true
      endSeg(false)
    } else if (ch === '|') {
      if (s[i + 1] === '|') {
        i++
        endSeg(false)
      } else endSeg(true)
    } else if ('(){}'.includes(ch)) {
      cur.grouped = true
      endWord()
      cur.raw += ch
    } else if (/\s/.test(ch)) {
      endWord()
      cur.raw += ch
    } else {
      if (ch === '$' || ch === '`') cur.expands = dyn = true
      if ('*?['.includes(ch)) dyn = true
      word = (word ?? '') + ch
      cur.raw += ch
    }
  }
  endSeg(false)
  return segs
}

/** Each simple command as words (quotes stripped, not shell-expanded). */
export function simpleCommands(command) {
  return lex(command).map((g) => g.words)
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** `{ tool: 'git'|'gh', sub, args, globals, env }` when the command word is exactly git or gh, else null. */
export function gitOrGh(words) {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i])) i++
  const env = words.slice(0, i)
  const exe = words[i]
  if (exe !== 'git' && exe !== 'gh') return null
  const withValue = exe === 'git' ? GIT_GLOBAL_WITH_VALUE : GH_GLOBAL_WITH_VALUE
  const g0 = ++i
  while (i < words.length && words[i].startsWith('-')) i += withValue.has(words[i]) ? 2 : 1
  return { tool: exe, sub: words[i], args: words.slice(i + 1), globals: words.slice(g0, i), env }
}

const GIT_PUBLISH = ['commit', 'push', 'tag']
const GH_PUBLISH = ['pr', 'issue', 'release', 'api', 'gist']

/** `{ tool, sub, args, … }` for a command that publishes text to GitHub, else null. */
export function classify(words) {
  const c = gitOrGh(words)
  return c && (c.tool === 'git' ? GIT_PUBLISH : GH_PUBLISH).includes(c.sub) ? c : null
}

/** Any mention of a git or gh publish, quoted or not: what a wrapper would hide. */
const MENTION = /\bgit\b[\s\S]*?\b(?:commit|push|tag)\b|\bgh\b[\s\S]*?\b(?:pr|issue|release|api|gist)\b/
export const mentionsPublish = (text) => MENTION.test(String(text))

/* A command that changes the directory or environment later commands run in. */
const STATE_CHANGERS = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'alias', 'source', '.', 'set', 'declare', 'typeset', 'local', 'readonly', 'shopt', 'eval', 'exec', 'builtin', 'command', 'trap', 'hash', 'enable'])
/* gh's own commands; anything else is an alias or an extension. */
const GH_COMMANDS = new Set(['alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'copilot', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow', 'version'])

/*
 * Pushes are ALLOW-LISTED: `git push [plain flags] [origin] [HEAD|<current branch>]`.
 * The gates compare HEAD in this directory with the branch's upstream and cannot
 * tell what anything else would publish.
 */
const PUSH_PLAIN_FLAGS = /^(?:-u|--set-upstream|-q|--quiet|-v|--verbose|--progress|--porcelain|--no-verify|-f|--force|--force-with-lease(?:=[^\s]*)?|--force-if-includes)$/

/** True when git config would make a ref-less push publish other refs. */
export function pushConfigRedirects(git = runGit) {
  try {
    if (/^matching$/i.test(git(['config', '--get', 'push.default']).trim())) return true
  } catch {
    /* unset */
  }
  try {
    return git(['config', '--get-regexp', '^remote\\..*\\.push$']).trim() !== ''
  } catch {
    return false
  }
}

/** The git alias `name` stands for, or null. */
export function gitAlias(name, git = runGit) {
  try {
    return git(['config', '--get', `alias.${name}`]).trim() || null
  } catch {
    return null
  }
}

function pushRefusal(c, branch, pushRedirected) {
  const positional = []
  for (const a of c.args) {
    if (a.startsWith('-')) {
      if (!PUSH_PLAIN_FLAGS.test(a)) return `\`git push ${a}\` is not a plain push of the current branch; push the branch alone`
    } else positional.push(a)
  }
  if (positional.length > 2) return 'it pushes several refs; push the current branch alone'
  if (positional[0] && positional[0] !== 'origin') return 'it pushes to a remote other than origin'
  if (positional[1] && positional[1] !== 'HEAD' && positional[1] !== branch) {
    return 'it pushes a ref other than the current branch; check out that branch and push it'
  }
  if (!positional[1] && pushRedirected) {
    return 'git config (push.default=matching or remote.*.push) would push other refs; name the branch: git push origin HEAD'
  }
  return null
}

/**
 * Why this command is beyond what the gates can check, or null.
 *
 * ALLOW-LIST, not a list of known-bad forms. A command that touches git or gh
 * publishing at all must be made of plain simple commands: every publish is a
 * direct `git`/`gh` invocation with no env prefix (bar the review escape on a
 * push), no git global options, no expansion, grouping, stdin or pipe input,
 * and nothing before it that changes directory or environment. Anything that
 * MENTIONS a publish without being one (sh -c, xargs, env, sudo, $(...)…) is
 * refused, as are a git alias, an unknown gh command, and a command whose name
 * is built at run time, which can each stand for one.
 *
 * Its limit: it reads the command TEXT before it runs, so a program assembled at
 * run time from data it cannot see (`env $CMD`, a script that pushes) is out of
 * its reach. It catches the slips an agent makes writing commands, not a
 * deliberate evasion; CI's check of the PR text and commits is the control.
 */
export function unmodelledForm(command, branch = null, pushRedirected = false, aliasOf = gitAlias) {
  let changed = false
  for (const seg of lex(command)) {
    const words = seg.words
    let i = 0
    while (i < words.length && ASSIGNMENT.test(words[i])) i++
    const head = words[i]
    if (seg.dynamic[i]) return 'its command name is built at run time ($…, backticks or a glob); run git or gh by name'
    if (head === undefined || STATE_CHANGERS.has(head)) {
      // A bare assignment can rewrite an exported variable (GIT_DIR, …).
      changed = true
      if (mentionsPublish(seg.raw)) return `it runs git or gh through \`${head ?? words[0]}\`; run the git or gh command directly`
      continue
    }
    const c = gitOrGh(words)
    if (!c) {
      if (mentionsPublish(seg.raw)) return `it runs git or gh through \`${head}\`; run the git or gh command directly`
      continue
    }
    const pub = (c.tool === 'git' ? GIT_PUBLISH : GH_PUBLISH).includes(c.sub)
    if (!pub) {
      if (c.tool === 'gh' && c.sub && !GH_COMMANDS.has(c.sub)) return `\`gh ${c.sub}\` is an alias or extension the gate cannot see through; run the gh command it stands for`
      if (c.tool === 'git' && c.sub && aliasOf(c.sub)) return `\`git ${c.sub}\` is a git alias the gate cannot see through; run the git command it stands for`
      if (c.tool === 'git' && c.globals.length && mentionsPublish(seg.raw)) return 'it passes git options that can define commands; run the git command directly'
      continue
    }
    if (changed) return 'something before it changes the directory or environment; run it on its own from the checkout'
    if (seg.expands) return 'it uses shell expansion ($VAR, $(...) or backticks) the gate cannot see through; write the text to a file and pass the literal path'
    if (seg.grouped) return 'it runs inside a group, subshell or background job; run it on its own'
    if (seg.stdin || seg.afterPipe) return 'it reads its input from the shell (<, << or a pipe); pass a literal file path instead'
    const envOk = c.tool === 'git' && c.sub === 'push' && c.env.every((e) => e === 'SKIP_EXTERNAL_REVIEW=1')
    if (c.env.length && !envOk) return 'it sets environment variables on the command; run it without them'
    if (c.tool === 'git' && c.globals.length) return `it passes git options before \`${c.sub}\` (${c.globals.join(' ')}); run it without them from the checkout`
    if (c.tool === 'git' && c.sub === 'push') {
      const r = pushRefusal(c, branch, pushRedirected)
      if (r) return r
    }
  }
  return null
}

/** File arguments that carry published text, in every spelling the CLIs accept. */
function bodyFiles(args, cmd = {}) {
  const out = []
  // `gh gist create a.md b.md`: every positional argument is published.
  if (cmd.tool === 'gh' && cmd.sub === 'gist' && args[0] === 'create') {
    for (let i = 1; i < args.length; i++) {
      if (['-d', '--desc', '-f', '--filename'].includes(args[i])) i++
      else if (!args[i].startsWith('-')) out.push(args[i])
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    let m
    if ((m = a.match(/^--(?:body-file|file|input|notes-file)=(.*)$/))) out.push(m[1])
    else if (['--body-file', '--file', '--input', '--notes-file', '-F'].includes(a)) out.push(args[++i] ?? '')
    else if ((m = a.match(/^-F(.+)$/))) out.push(m[1])
  }
  // -F key=@path (gh api) names a file; -F key=value is a literal already in the command.
  return out
    .map((v) => (v.includes('=@') ? v.slice(v.indexOf('=@') + 2) : v.includes('=') ? null : v))
    .filter((v) => v !== null)
}

export function hookTexts(command, { read = (p) => readFileSync(p, 'utf8'), git = runGit } = {}) {
  const cmds = simpleCommands(command).map(classify).filter(Boolean)
  const unmodelled = unmodelledForm(command, currentBranch(git), pushConfigRedirects(git), (n) => gitAlias(n, git))
  if (!cmds.length && !unmodelled) return []
  const texts = [{ where: 'command', text: command }]
  if (unmodelled) texts.push({ where: 'command', unreadable: unmodelled, text: '' })
  let scanCommits = false
  for (const c of cmds) {
    for (const path of bodyFiles(c.args, c)) {
      if (!path || path === '-' || path.includes('$')) {
        texts.push({ where: `${c.tool} ${c.sub}: body from ${path || 'stdin'}`, unreadable: true, text: '' })
        continue
      }
      try {
        texts.push({ where: path, text: read(path) })
      } catch {
        texts.push({ where: path, unreadable: true, text: '' })
      }
    }
    if (c.tool === 'git' && c.sub === 'push') scanCommits = true
    if (c.tool === 'gh' && c.sub === 'pr' && c.args[0] === 'create' && c.args.some((a) => /^--fill/.test(a))) scanCommits = true
  }
  if (scanCommits) {
    try {
      texts.push(...commitMessages('@{upstream}..HEAD', git))
    } catch {
      try {
        texts.push(...commitMessages('origin/main..HEAD', git))
      } catch {
        /* no upstream to compare against */
      }
    }
  }
  return texts
}

function report(findings) {
  return findings.map((f) => `  ${f.where}: ${f.refs.join(', ')}`).join('\n')
}

const ADVICE =
  'GitHub would post a "mentioned this" backlink naming our repository on that issue, and editing later does not remove it. ' +
  'Write upstream issues as plain text, e.g. "Claude Code issue 67657": no owner/repo, no URL, no leading #.'

function check(texts, owner) {
  return texts
    .map((t) => ({
      where: t.where,
      refs: t.unreadable
        ? [typeof t.unreadable === 'string' ? `(cannot check: ${t.unreadable})` : '(cannot read this body: use a literal file path the gate can open)']
        : findUpstreamRefs(t.text, owner),
    }))
    .filter((f) => f.refs.length)
}

function main(argv) {
  const owner = ownOwner()
  if (argv.includes('--hook')) {
    let input
    try {
      input = JSON.parse(readFileSync(0, 'utf8'))
    } catch {
      return 0 // fail open on unreadable hook input, like the other Bash gates
    }
    const findings = check(hookTexts(String(input?.tool_input?.command ?? '')), owner)
    if (findings.length) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Upstream-backlink gate: this would publish references to another repository:\n${report(findings)}\n${ADVICE}`,
          },
        }),
      )
    }
    return 0
  }

  const texts = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--text-file') texts.push({ where: argv[++i], text: readFileSync(argv[i], 'utf8') })
    else if (a === '--stdin') texts.push({ where: 'stdin', text: readFileSync(0, 'utf8') })
    else if (a === '--commits') texts.push(...commitMessages(argv[++i]))
    else if (a === '--github-event') {
      const pr = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request
      if (pr) texts.push({ where: 'PR title', text: pr.title ?? '' }, { where: 'PR body', text: pr.body ?? '' })
    } else {
      console.error(`unknown argument: ${a}`)
      return 2
    }
  }
  if (!argv.length) {
    console.error('usage: --text-file <path> | --stdin | --commits <range> | --github-event | --hook (nothing was checked)')
    return 2
  }
  const findings = check(texts, owner)
  if (!findings.length) return 0
  console.error(`References to another repository (own owner: ${owner ?? 'unknown'}):\n${report(findings)}\n${ADVICE}`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
