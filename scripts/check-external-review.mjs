#!/usr/bin/env node
/*
 * External review before push (CLAUDE.md "Review shapes": internal agents
 * prove, external agents judge; one build, one external review, one fix pass).
 *
 * PreToolUse gate (Bash matcher, .claude/settings.json): `git push` is refused
 * when it would publish CODE that no external review has been recorded for.
 * On 2026-10-08 two follow-on builds were pushed on internal tests alone, and
 * the PR reviewer then found four trust-boundary bugs an external pass would
 * have caught first.
 *
 * Cheap where it can be: it keys on the CODE trees only (CODE_PATHS), so a
 * docs, copy or test-only push needs nothing, and a pure history rewrite (same
 * trees) passes. A recorded review covers that exact code state.
 *
 *   node scripts/check-external-review.mjs --hook            (the gate)
 *   node scripts/check-external-review.mjs --record <file>   (after the review
 *        and its fix pass: records the current code state as reviewed, citing
 *        the external review's output file)
 *   node scripts/check-external-review.mjs --status          (what a push needs)
 *
 * Emergency escape, visible in the transcript: prefix the push with
 * SKIP_EXTERNAL_REVIEW=1. The ledger lives in the git common dir, so every
 * worktree of the clone shares it and nothing is committed.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classify, currentBranch, pushConfigRedirects, simpleCommands, unmodelledForm } from './check-no-upstream-backlinks.mjs'

/** Directories and root files whose change is a change of behaviour. */
export const CODE_PATHS = [
  'app',
  'server',
  'shared',
  'lib',
  'plugin',
  'copilot-plugin',
  'drizzle',
  'scripts',
  'tools',
  'infra',
  '.github/workflows',
  '.claude-plugin',
  '.claude/settings.json',
  'package.json',
  'package-lock.json',
  'nuxt.config.ts',
  'tsconfig.json',
  'eslint.config.mjs',
  'vitest.config.ts',
  'Dockerfile',
]

export function isPush(command) {
  // A push the parser cannot see (a wrapper, an alias…) still counts, so decide() refuses it.
  return pushCommands(command).length > 0 || (/\bgit\b/.test(command) && unmodelledForm(command) !== null)
}

function pushCommands(command) {
  return simpleCommands(command).filter((w) => {
    const c = classify(w)
    return c?.tool === 'git' && c.sub === 'push'
  })
}

/** The escape counts only as an environment assignment on the push itself. */
export function pushSkipsReview(command) {
  const pushes = pushCommands(command)
  return (
    pushes.length > 0 &&
    pushes.every((words) => {
      const prefix = []
      for (const w of words) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) break
        prefix.push(w)
      }
      return prefix.includes('SKIP_EXTERNAL_REVIEW=1')
    })
  )
}
const MIN_REVIEW_BYTES = 200

const gitDefault = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A digest of the code trees at `ref`: equal digests mean equal code. */
export function codeFingerprint(ref, git = gitDefault) {
  const trees = CODE_PATHS.map((p) => {
    try {
      return `${p}:${git(['rev-parse', `${ref}:${p}`])}`
    } catch {
      return `${p}:-`
    }
  })
  return createHash('sha256').update(trees.join('\n')).digest('hex')
}

function ledgerPath(git = gitDefault) {
  return join(resolve(git(['rev-parse', '--git-common-dir'])), 'tokenscope-reviewed-code')
}

export function reviewedFingerprints(text) {
  return new Set(
    String(text ?? '')
      .split('\n')
      .map((l) => l.split('\t')[0].trim())
      .filter(Boolean),
  )
}

/** The ref a push is compared against: the branch's upstream, else origin/main. */
function pushBase(git = gitDefault) {
  try {
    return git(['rev-parse', '--abbrev-ref', '@{upstream}'])
  } catch {
    return 'origin/main'
  }
}

/**
 * Pure decision. `allow` with a reason, or `deny` with what to do.
 */
export function decide({ command, head, base, reviewed, branch = null, pushRedirected = false }) {
  if (!isPush(command)) return { allow: true, reason: 'not a push' }
  if (pushSkipsReview(command)) return { allow: true, reason: 'skipped explicitly' }
  // HEAD and the base are read in this directory: a push of another checkout
  // or other refs would be compared against the wrong code.
  const unmodelled = unmodelledForm(command, branch, pushRedirected)
  if (unmodelled) return { allow: false, unmodelled }
  if (head === base) return { allow: true, reason: 'no code change' }
  if (reviewed.has(head)) return { allow: true, reason: 'reviewed' }
  return { allow: false }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
}

function main(argv) {
  if (argv[0] === '--hook') {
    let command
    try {
      command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '')
    } catch {
      return 0
    }
    if (!isPush(command)) return 0
    try {
      const base = pushBase()
      const ledger = ledgerPath()
      const d = decide({
        command,
        head: codeFingerprint('HEAD'),
        base: codeFingerprint(base),
        reviewed: reviewedFingerprints(existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''),
        branch: currentBranch(gitDefault),
        pushRedirected: pushConfigRedirects(gitDefault),
      })
      if (d.unmodelled) {
        deny(`External-review gate: cannot check this push: ${d.unmodelled}.`)
      } else if (!d.allow) {
        deny(
          `External-review gate: this push changes code (${CODE_PATHS.join(', ')}) against ${base} and no external review is recorded for it. ` +
            `Run an external review of \`git diff ${base}...HEAD\` (CLAUDE.md "Review shapes": copilot or another non-Claude executor), ` +
            'do ONE fix pass, then `node scripts/check-external-review.mjs --record <review-output-file>` and push again. ' +
            'Emergency only: prefix the push with SKIP_EXTERNAL_REVIEW=1.',
        )
      }
    } catch {
      /* no git / no base: fail open, CI and the PR reviewer still run */
    }
    return 0
  }
  if (argv[0] === '--record') {
    const file = argv[1]
    if (!file || !existsSync(file) || statSync(file).size < MIN_REVIEW_BYTES) {
      console.error(`--record needs the external review's output file (at least ${MIN_REVIEW_BYTES} bytes)`)
      return 2
    }
    const fp = codeFingerprint('HEAD')
    appendFileSync(ledgerPath(), `${fp}\t${gitDefault(['rev-parse', 'HEAD'])}\t${new Date().toISOString()}\t${resolve(file)}\n`)
    console.log(`recorded: code state ${fp.slice(0, 12)} reviewed (${file})`)
    return 0
  }
  if (argv[0] === '--status') {
    const base = pushBase()
    const ledger = ledgerPath()
    const d = decide({
      command: 'git push',
      head: codeFingerprint('HEAD'),
      base: codeFingerprint(base),
      reviewed: reviewedFingerprints(existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''),
    })
    console.log(d.allow ? `push allowed (${d.reason}, against ${base})` : `push needs an external review (code changed against ${base})`)
    return 0
  }
  console.error('usage: --hook | --record <review-output-file> | --status')
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
