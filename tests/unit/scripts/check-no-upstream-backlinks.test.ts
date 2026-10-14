/*
 * scripts/check-no-upstream-backlinks.mjs: no `owner/repo#N` or issue / PR URL
 * to another owner's repository in text GitHub turns into a backlink.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { findUpstreamRefs, hookTexts, ownOwner, prTexts, unmodelledForm } from '../../../scripts/check-no-upstream-backlinks.mjs'

const OWN = 'Home-Org'

describe('findUpstreamRefs', () => {
  it('flags short refs and URLs to another owner, the forms that leaked on 2026-10-08', () => {
    const text = [
      'Upstream: anthropics/claude-code#67657 (root cause).',
      'See [the bug](https://github.com/anthropics/claude-code/issues/16870).',
      'Fixed upstream in some-org/some-repo@0123abcd and https://github.com/x/y/pull/9.',
    ].join('\n')
    expect(findUpstreamRefs(text, OWN).sort()).toEqual(
      [
        'anthropics/claude-code#67657',
        'github.com/anthropics/claude-code/issues/16870',
        'some-org/some-repo@0123abcd',
        'github.com/x/y/pull/9',
      ].sort(),
    )
  })

  it("passes a Dependabot commit message, whose only link is a ref's commit list, and still flags a single commit", () => {
    // The shape of a Dependabot commit message. A commits list on a ref is not
    // an item with a timeline, so it cannot get a backlink.
    const dependabot = [
      'Bumps [vitest](https://github.com/vitest-dev/vitest/tree/HEAD/packages/vitest) from 5.0.2 to 5.0.3.',
      '- [Release notes](https://github.com/vitest-dev/vitest/releases)',
      '- [Changelog](https://github.com/vitest-dev/vitest/blob/main/docs/releases.md)',
      '- [Commits](https://github.com/vitest-dev/vitest/commits/v5.0.3/packages/vitest)',
    ].join('\n')
    expect(findUpstreamRefs(dependabot, OWN)).toEqual([])
    expect(findUpstreamRefs('https://github.com/vitest-dev/vitest/commit/0123abcd', OWN)).toEqual([
      'github.com/vitest-dev/vitest/commit/0123abcd',
    ])
  })

  it('lets our own owner, plain text, bare numbers and look-alikes through', () => {
    const text = [
      'Home-Org/widgets#422 and home-org/other#1',
      'https://github.com/Home-Org/widgets/pull/423',
      'Claude Code issue 67657, our #423',
      'bump @nuxt/ui@4.11.2 and @testcontainers/postgresql@12.2.0',
      'path plugin/scripts/status.mjs, a/b ratio, docs/design#section',
    ].join('\n')
    expect(findUpstreamRefs(text, OWN)).toEqual([])
  })

  it('with no known owner, every owner/repo reference is external', () => {
    expect(findUpstreamRefs('Home-Org/widgets#1', null)).toEqual(['Home-Org/widgets#1'])
  })
})

describe('prTexts: the pull_request text CI checks', () => {
  const body = '<a href="https://redirect.github.com/actions/setup-node/pull/1421">actions/setup-node#1421</a>'

  it('checks the title and body of a PR a person opened', () => {
    const texts = prTexts({ title: 't', body, user: { login: 'someone', type: 'User' } })
    expect(texts.map((t) => t.where)).toEqual(['PR title', 'PR body'])
    expect(findUpstreamRefs(texts[1].text, 'Home-Org')).toEqual(['actions/setup-node#1421'])
  })

  const bot = { login: 'dependabot[bot]', type: 'Bot' }
  const refsIn = (pr: Parameters<typeof prTexts>[0]) => prTexts(pr).flatMap((t) => findUpstreamRefs(t.text, 'Home-Org'))
  // The two generated shapes, as in the setup-node 7.1.0 PR body.
  const generated = [
    body,
    '<li><a href="https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1"><code>949feb2</code></a> Bump eslint</li>',
  ].join('\n')

  it("drops only the link shapes Dependabot generates from Dependabot's PR body", () => {
    expect(refsIn({ title: 't', body: generated, user: bot })).toEqual([])
  })

  it('still scans the rest of a Dependabot PR: its title and any plain reference in the body', () => {
    const quoted = `${generated}\nFixes some-org/some-repo#12, see https://github.com/x/y/issues/3`
    expect(refsIn({ title: 'bump, see x/y#9', body: quoted, user: bot }).sort()).toEqual(
      ['x/y#9', 'some-org/some-repo#12', 'github.com/x/y/issues/3'].sort(),
    )
  })

  it('cannot drop a reference by spanning to a later </a>, across lines or another anchor', () => {
    const unclosedThenRef = [
      '```',
      '<a href="https://redirect.github.com/x/y/pull/1">open',
      '```',
      'Fixes some-org/some-repo#12',
      'closing</a>',
    ].join('\n')
    expect(refsIn({ title: 't', body: unclosedThenRef, user: bot })).toEqual(['some-org/some-repo#12'])
    const commitThenRef =
      '<a href="https://github.com/x/y/commit/0123abcd">c <a href="#">x</a> some-org/some-repo#13 </a>'
    expect(refsIn({ title: 't', body: commitThenRef, user: bot })).toContain('some-org/some-repo#13')
  })

  it("drops nothing from anyone else's PR, a lookalike login or a non-bot type included", () => {
    for (const user of [{ login: 'dependabot', type: 'User' }, { login: 'dependabot[bot]', type: 'User' }]) {
      expect(refsIn({ title: 't', body: generated, user })).toEqual([
        'actions/setup-node#1421',
        'github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1',
      ])
    }
  })

  it('has nothing to check outside a pull_request event', () => {
    expect(prTexts(undefined)).toEqual([])
  })
})

describe('ownOwner', () => {
  it('takes GITHUB_REPOSITORY in GitHub Actions, else the origin remote', () => {
    expect(ownOwner({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/widgets' })).toBe('acme')
    // Outside Actions it is plain process env a project's settings can set.
    expect(ownOwner({ GITHUB_REPOSITORY: 'anthropics/claude-code' }, () => 'git@github.com:Home-Org/widgets.git\n')).toBe(OWN)
    expect(ownOwner({}, () => 'git@github.com:Home-Org/widgets.git\n')).toBe(OWN)
    expect(ownOwner({}, () => 'https://github.com/Home-Org/widgets\n')).toBe(OWN)
  })
})

describe('hookTexts: which Bash commands publish text to GitHub', () => {
  const noFiles = { read: () => { throw new Error('no file') }, git: () => '' }

  it('ignores commands that publish nothing', () => {
    expect(hookTexts('grep -rn anthropics/claude-code#1 docs', noFiles)).toEqual([])
  })

  it('refuses text that merely MENTIONS a publish: the gate cannot tell echo from sh -c', () => {
    expect(hookTexts('echo "git commit" > notes.txt', noFiles).some((t) => t.unreadable)).toBe(true)
  })

  it('checks commit, PR, issue and API commands, including after && and env prefixes', () => {
    for (const c of [
      'git commit -m "x"',
      'cd repo && git add -A && git commit -q -F - <<EOF\nmsg\nEOF',
      'GH_TOKEN=x gh pr create --title t --body b',
      'gh pr edit 423 --body-file body.md',
      'gh issue comment 1 -R a/b --body hi',
      'gh api -X PATCH repos/o/r/issues/comments/1 -F body=@c.md',
    ]) {
      expect(hookTexts(c, noFiles).length).toBeGreaterThan(0)
    }
  })

  it('reads the files a command publishes from', () => {
    const read = (p: string) => (p === 'body.md' ? 'body anthropics/claude-code#1' : p === 'c.md' ? 'comment' : '')
    expect(hookTexts('gh pr edit 1 --body-file body.md', { read, git: () => '' }).map((t) => t.text)).toContain(
      'body anthropics/claude-code#1',
    )
    expect(hookTexts('gh api x -F body=@c.md', { read, git: () => '' }).map((t) => t.where)).toContain('c.md')
  })

  it('git push checks the commits it would send', () => {
    const git = () => 'abc123\u0000feat: thing\n\nsee anthropics/claude-code#67657\n\u001e'
    const texts = hookTexts('git push -q', { read: noFiles.read, git })
    expect(texts.map((t) => t.where)).toContain('commit abc123')
    expect(findUpstreamRefs(texts.map((t) => t.text).join('\n'), OWN)).toEqual(['anthropics/claude-code#67657'])
  })
})

describe('hookTexts: command forms the first version missed', () => {
  const files: Record<string, string> = { 'b.md': 'body anthropics/claude-code#1', 'p.json': '{"body":"x/y#2"}', 'm.txt': 'msg' }
  const opts = { read: (p: string) => { if (p in files) return files[p]!; throw new Error('no file') }, git: () => 'abc\u0000feat\n\nsee x/y#3\n\u001e' }
  const refs = (c: string) => findUpstreamRefs(hookTexts(c, opts).map((t) => t.text).join('\n'), OWN)
  const unreadable = (c: string) => hookTexts(c, opts).some((t) => (t as { unreadable?: boolean }).unreadable)

  it('newline-separated, wrapped, absolute-path and global-option forms are publishing commands', () => {
    for (const c of [
      'echo preparing\ngit commit -m "anthropics/claude-code#1"',
      'git -C repo commit -m "anthropics/claude-code#1"',
      'git --no-pager -c user.name=x commit -m "anthropics/claude-code#1"',
      'command git commit -m "anthropics/claude-code#1"',
      '/usr/bin/git commit -m "anthropics/claude-code#1"',
      'gh --repo o/r pr create --title t --body "anthropics/claude-code#1"',
      'gh -R o/r issue comment 1 --body "anthropics/claude-code#1"',
    ]) {
      expect(refs(c), c).toContain('anthropics/claude-code#1')
    }
  })

  it('reads bodies from every file-option spelling', () => {
    expect(refs('gh pr create --body-file=b.md')).toContain('anthropics/claude-code#1')
    expect(refs('git commit --file=b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh api x -Fbody=@b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh api x -F body=@b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh api x --input p.json')).toContain('x/y#2')
    expect(refs('gh api x --input=p.json')).toContain('x/y#2')
  })

  it('reads release notes files and every file a gist publishes', () => {
    expect(refs('gh release create v1 --notes-file b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh release edit v1 --notes-file=b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh release create v1 -F b.md')).toContain('anthropics/claude-code#1')
    expect(refs('gh gist create -d "notes" m.txt b.md')).toContain('anthropics/claude-code#1')
  })

  it('gh pr create --fill checks the commits it turns into the PR text', () => {
    expect(refs('gh pr create --fill')).toContain('x/y#3')
    expect(refs('gh pr create --fill-verbose --base main')).toContain('x/y#3')
  })

  it('a body the gate cannot read is refused, not passed', () => {
    expect(unreadable('gh pr edit 1 --body-file "$BODY"')).toBe(true)
    expect(unreadable('cat b.md | gh pr edit 1 --body-file -')).toBe(true)
    expect(unreadable('gh pr edit 1 --body-file missing.md')).toBe(true)
    expect(unreadable('gh pr edit 1 --body-file b.md')).toBe(false)
  })

  it('github.com matches case-insensitively, and only as a host', () => {
    expect(findUpstreamRefs('https://GitHub.com/anthropics/claude-code/issues/9', OWN)).toEqual(['GitHub.com/anthropics/claude-code/issues/9'])
    expect(findUpstreamRefs('https://notgithub.com/a/b/issues/1', OWN)).toEqual([])
  })
})

describe('unmodelledForm: what the gates refuse instead of guessing', () => {
  const branch = 'feat/x'
  it('refuses a directory change, another checkout, shell expansion and other refs', () => {
    for (const c of [
      'cd repo && gh pr create --body-file body.md',
      'pushd ../other; git push',
      'git -C ../other push',
      'git --work-tree=../o push',
      'GIT_DIR=../o/.git git push',
      'git -C../other push',
      'git -Crepo commit -m x',
      'gh pr create --title t --body "$BODY"',
      'gh pr comment 1 --body "$(cat notes.md)"',
      'git commit -m "see `cat ref`"',
      'git push origin feature:main',
      'git push origin other-branch',
      'git push --all',
      'git push --tags origin',
      'git push origin --delete feat/x',
      // Wrappers the parser does not see through.
      'sh -c "git push origin main"',
      'bash -lc "gh pr create --body-file b.md"',
      'env --chdir=../other git push',
      'xargs git push < refs.txt',
      // Flags and config that change what a push sends.
      'git push --repo origin other-branch',
      'git push --repo=origin other-branch',
      'git -c push.default=matching push',
      'GIT_CONFIG_COUNT=1 git push',
      'env FOO=1 git push',
      'FOO=1 git push',
      'export GIT_DIR=../o/.git; git push',
      'GIT_DIR=../o/.git; git push',
      '(git push)',
      '{ git push; }',
      'git push &',
      'gh pr create --body-file - < body.md',
      'cat body.md | gh pr create --body-file -',
      'echo $(git push)',
      'gh mypublish',
      'command git push',
      'g${PATH:+}it push origin HEAD',
      '/usr/bin/g?t push origin HEAD',
      '$(echo git) push',
      'X=git; $X push',
      'command sh -c "git push"',
      'nohup bash -c "gh pr create --body x"',
      'time git push origin feat/x:main',
      '/usr/bin/git push',
      'git --config-env=push.default=PD push',
      'git --config-env push.default=PD push',
      'FOO=1 sh -c "git push"',
      'FOO=1 bash -lc "gh pr create --body x"',
      'FOO=1 cd ../other && git push',
      'git push -o ci.skip origin feat/x',
      'git push other HEAD',
      'git push origin HEAD feat/y',
    ]) expect(unmodelledForm(c, branch, false, () => null), c).not.toBeNull()
  })

  it('allows the plain forms, and ignores commands that publish nothing', () => {
    for (const c of [
      'git push',
      'git push -u origin feat/x',
      'git push --force-with-lease origin HEAD',
      "git commit -m 'costs $5, literally'",
      'gh pr create --title t --body-file body.md',
      'cd docs && ls $HOME',
      // Expansion or cd outside the publishing command cannot change it.
      'echo "$PWD" && git push origin feat/x',
      'git push origin feat/x && cd ..',
      'git commit -m "costs \\$5"',
      'bash scripts/build.sh',
      // The everyday plain forms.
      'git add -A && git commit -q -m "fix: x"',
      "gh pr view 1 --json reviews --jq '.reviews[]|.body'",
      'gh pr create --title t --body-file b.md 2>&1 | grep -v fsmonitor',
      'git push -q --force-with-lease origin HEAD 2>&1 | grep -v remote',
      'SKIP_EXTERNAL_REVIEW=1 git push',
      'git commit -m fix &>/tmp/commit.out',
      'git push --porcelain origin HEAD',
      'ls *.md && git push',
      'git status --short; git log --oneline -3',
    ]) expect(unmodelledForm(c, branch, false, () => null), c).toBeNull()
  })

  it('refuses a git alias or an unknown gh command, which can stand for a publish', () => {
    const aliases: Record<string, string> = { p: 'push origin feat/x:main' }
    expect(unmodelledForm('git p', branch, false, (n) => aliases[n] ?? null)).toMatch(/alias/)
    expect(unmodelledForm('git status', branch, false, (n) => aliases[n] ?? null)).toBeNull()
  })

  it('a ref-less push is refused when git config would push other refs', () => {
    expect(unmodelledForm('git push', branch, true)).not.toBeNull()
    expect(unmodelledForm('git push -u origin', branch, true)).not.toBeNull()
    expect(unmodelledForm('git push origin HEAD', branch, true)).toBeNull()
  })

  it('makes hookTexts refuse the command', () => {
    const opts = { read: () => 'clean', git: (a: string[]) => (a[0] === 'branch' ? 'feat/x\n' : '') }
    expect(hookTexts('gh pr create --body "$BODY"', opts).some((t) => t.unreadable)).toBe(true)
    expect(hookTexts('git push origin feat/x:main', opts).some((t) => t.unreadable)).toBe(true)
    expect(hookTexts('git push -u origin feat/x', opts).some((t) => t.unreadable)).toBe(false)
    // Wrapped: no directly parsed publish, but the hook must still refuse it.
    expect(hookTexts('sh -c "gh pr create --body x"', opts).some((t) => t.unreadable)).toBe(true)
    expect(hookTexts('bash -lc "git push"', opts).some((t) => t.unreadable)).toBe(true)
  })
})

describe('the CLI never passes having checked nothing', () => {
  it('exits 2 with no mode, and the npm script names a commit range', () => {
    const r = spawnSync(process.execPath, ['scripts/check-no-upstream-backlinks.mjs'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('nothing was checked')
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['check:upstream-backlinks']).toContain('--commits origin/main..HEAD')
  })
})
