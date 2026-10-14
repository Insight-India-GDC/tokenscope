#!/usr/bin/env node
/*
 * PreToolUse gate (Bash matcher, .claude/settings.json): before `git commit`,
 * eslint the files the commit can include, and refuse on errors.
 *
 * Why a gate and not a habit: on 2026-10-08 a commit was made straight after a
 * lint run had printed a failure, because the commit was chained after the
 * check instead of conditioned on it. Lint on a handful of files takes a few
 * seconds; typecheck and tests stay with CI and the integrator (CLAUDE.md 4b).
 *
 * The files: what is staged, plus unstaged and untracked files when the same
 * command stages them (`git add … && git commit`, `git commit -a`). A dirty
 * file the commit cannot include never blocks it. Commands are recognised by
 * the backlink gate's parser (newlines, wrappers, git's global options).
 * Fails OPEN when it cannot start (no eslint, no git, unreadable input); once
 * eslint runs, any failure to finish cleanly refuses the commit.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitOrGh, simpleCommands, unmodelledForm } from './check-no-upstream-backlinks.mjs'

const LINTABLE = /\.(m?js|cjs|ts|mts|vue)$/

/** `{ commit, stages }`: does the command commit, and does it stage first? */
export function commitShape(command) {
  let commit = false
  let stages = false
  for (const words of simpleCommands(command)) {
    const c = gitOrGh(words)
    if (c?.tool !== 'git') continue
    if (c.sub === 'add') stages = true
    if (c.sub === 'commit') {
      commit = true
      if (c.args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) stages = true
    }
  }
  return { commit, stages }
}

export function isCommit(command) {
  return commitShape(command).commit
}

export function changedFiles(stages, git = (args) => execFileSync('git', args, { encoding: 'utf8' })) {
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n')
  if (stages) {
    names.push(...git(['diff', '--name-only', '--diff-filter=ACMR']).split('\n'))
    names.push(...git(['ls-files', '--others', '--exclude-standard']).split('\n'))
  }
  return [...new Set(names.map((n) => n.trim()).filter((n) => LINTABLE.test(n) && existsSync(n)))]
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
}

/** ESLint's own JS entry point, launched with process.execPath on every platform. */
export function eslintEntry() {
  return join('node_modules', 'eslint', 'bin', 'eslint.js')
}

function main() {
  let command
  try {
    command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '')
  } catch {
    return
  }
  const shape = commitShape(command)
  // The files to lint are found in this directory, so a commit the gate cannot
  // model (another checkout, a wrapper, an alias…) is refused rather than waved through.
  if (shape.commit || /\bgit\b/.test(command)) {
    const why = unmodelledForm(command)
    if (why) {
      deny(`Lint gate: cannot check this commit: ${why}.`)
      return
    }
  }
  if (!shape.commit) return
  // ESLint's JS entry run by this Node: the .bin shim is eslint.cmd on Windows,
  // which Node will not spawn without a shell.
  const eslint = eslintEntry()
  if (!existsSync(eslint)) return
  let files
  try {
    files = changedFiles(shape.stages)
  } catch {
    return
  }
  if (!files.length) return
  const r = spawnSync(process.execPath, [eslint, '--no-warn-ignored', ...files], { encoding: 'utf8', timeout: 50_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n')
  if (r.status === 1) deny(`Lint gate: eslint reports errors in files this commit can include. Fix them, then commit.\n${out}`)
  else if (r.status !== 0) {
    deny(`Lint gate: eslint did not finish (${r.error?.message ?? (r.signal ? `signal ${r.signal}` : `exit ${r.status}`)}), so nothing was linted. Fix that, then commit.\n${out}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
