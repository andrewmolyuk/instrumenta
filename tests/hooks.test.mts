import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isGhPrMerge, isGitCommit, isGitMerge, segments, stripQuotes } from '../.claude/hooks/utils/shell.mts'

const HOOKS = join(import.meta.dirname, '..', '.claude', 'hooks')

/** Run a hook the way Claude Code does: JSON on stdin, meaning in the exit code. */
function runHook(name: string, command: string, cwd?: string): number {
  const res = spawnSync(join(HOOKS, name), {
    input: JSON.stringify({ tool_input: { command } }),
    cwd,
    encoding: 'utf8',
  })
  return res.status ?? -1
}

function tempRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'instrumenta-hooktest-'))
  execFileSync('git', ['init', '-b', branch], { cwd: dir, stdio: 'ignore' })
  return dir
}

const tempRepos: string[] = []
afterAll(() => tempRepos.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('stripQuotes', () => {
  it('blanks quoted contents but preserves length and the quote characters', () => {
    expect(stripQuotes('echo "git commit"')).toBe('echo "          "')
    expect(stripQuotes("echo 'git commit'")).toBe("echo '          '")
  })

  it('leaves unquoted text alone and survives an empty quoted string', () => {
    expect(stripQuotes('git commit -m x')).toBe('git commit -m x')
    expect(stripQuotes('echo ""')).toBe('echo ""')
  })
})

describe('segments', () => {
  it('splits on ; && || | and newlines', () => {
    expect(segments('a && b || c; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('does not split on separators inside quotes', () => {
    expect(segments('echo "a && b"')).toEqual(['echo "a && b"'])
  })

  it('drops empty segments', () => {
    expect(segments('  ;  ; git status ;')).toEqual(['git status'])
  })
})

describe('isGitCommit', () => {
  it.each(['git commit', 'git commit -m x', 'git  commit --amend', 'sudo git commit -a'])(
    'recognises %j',
    (cmd) => expect(isGitCommit(cmd)).toBe(true),
  )

  // \b would match at the hyphen and wrongly flag these real subcommands.
  it.each(['git commit-tree abc', 'git commit-graph write', 'git status'])(
    'does not flag %j',
    (cmd) => expect(isGitCommit(cmd)).toBe(false),
  )

  it('ignores the phrase inside a quoted string', () => {
    expect(isGitCommit('grep -rn "git commit" docs/')).toBe(false)
  })
})

describe('isGitMerge', () => {
  it.each(['git merge foo', 'git merge --ff-only foo', 'git  merge --squash foo'])(
    'recognises %j',
    (cmd) => expect(isGitMerge(cmd)).toBe(true),
  )

  // Trailing (\s|$) guard — these are real, unrelated subcommands.
  it.each(['git merge-base a b', 'git merge-tree a b', 'git merge-file a b c', 'git status'])(
    'does not flag %j',
    (cmd) => expect(isGitMerge(cmd)).toBe(false),
  )

  it('ignores the phrase inside a quoted string', () => {
    expect(isGitMerge('grep -rn "git merge" docs/')).toBe(false)
  })
})

describe('isGhPrMerge', () => {
  it.each(['gh pr merge 6 --merge', 'gh pr merge --squash', 'gh  pr  merge --rebase'])(
    'recognises %j',
    (cmd) => expect(isGhPrMerge(cmd)).toBe(true),
  )

  it.each(['gh pr list', 'gh pr view 6', 'gh issue list'])('does not flag %j', (cmd) =>
    expect(isGhPrMerge(cmd)).toBe(false),
  )

  it('ignores the phrase inside a quoted string', () => {
    expect(isGhPrMerge('grep -rn "gh pr merge" docs/')).toBe(false)
  })
})

describe('block-main-commit hook', () => {
  it('blocks a commit on main, including inside an && chain', () => {
    const repo = tempRepo('main')
    tempRepos.push(repo)
    expect(runHook('block-main-commit.mts', 'git commit -m "x"', repo)).toBe(2)
    expect(runHook('block-main-commit.mts', 'git add . && git commit -m "x"', repo)).toBe(2)
  })

  // Regression: `git rev-parse --abbrev-ref HEAD` fails before the first commit,
  // which would silently disable the guard exactly when it first matters.
  it('still blocks in a repository that has no commits yet', () => {
    const repo = tempRepo('main')
    tempRepos.push(repo)
    expect(
      execFileSync('git', ['rev-list', '--count', '--all'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('0')
    expect(runHook('block-main-commit.mts', 'git commit -m "first"', repo)).toBe(2)
  })

  it('allows a commit on a feature branch', () => {
    const repo = tempRepo('feature/x')
    tempRepos.push(repo)
    expect(runHook('block-main-commit.mts', 'git commit -m "x"', repo)).toBe(0)
  })

  it('allows unrelated commands while sitting on main', () => {
    const repo = tempRepo('main')
    tempRepos.push(repo)
    for (const cmd of ['git status --short', 'git commit-tree abc', 'grep -rn "git commit" .']) {
      expect(runHook('block-main-commit.mts', cmd, repo)).toBe(0)
    }
  })
})

describe('block-co-authored-by hook', () => {
  it.each([
    'git commit -m "feat: x\n\nCo-Authored-By: A <a@b.c>"',
    'git commit -m "fix: y\n\nco-authored-by: a <a@b.c>"',
    'git commit -m "feat: x" -m "Co-Authored-By: A <a@b.c>"',
    'git commit --amend -m "x\n\nCo-Authored-By: A <a@b.c>"',
  ])('blocks the trailer in %j', (cmd) => {
    expect(runHook('block-co-authored-by.mts', cmd)).toBe(2)
  })

  it.each([
    'git commit -m "feat: add the thing"',
    'grep -rn "Co-Authored-By" docs/',
    'git log --format=%b | grep -i co-authored-by',
  ])('allows %j', (cmd) => {
    expect(runHook('block-co-authored-by.mts', cmd)).toBe(0)
  })
})

describe('block-merge-commit hook', () => {
  it.each([
    'git merge feature/x',
    'git merge --no-ff feature/x',
    'git merge --squash feature/x',
    'gh pr merge 6',
    'gh pr merge 6 --merge',
    'gh pr merge 6 --squash',
  ])('blocks %j', (cmd) => expect(runHook('block-merge-commit.mts', cmd)).toBe(2))

  it('blocks --merge and --squash even alongside other flags', () => {
    expect(runHook('block-merge-commit.mts', 'gh pr merge 6 --merge --delete-branch')).toBe(2)
    expect(runHook('block-merge-commit.mts', 'gh pr merge 6 --squash --delete-branch')).toBe(2)
  })

  it.each([
    'git merge --ff-only feature/x',
    'gh pr merge 6 --rebase',
    'gh pr merge 6 --rebase --delete-branch',
    'git status',
    'gh pr list',
    'grep -rn "gh pr merge 6" .',
  ])('allows %j', (cmd) => {
    expect(runHook('block-merge-commit.mts', cmd)).toBe(0)
  })
})

describe('all hooks tolerate malformed input', () => {
  it.each(['block-main-commit.mts', 'block-co-authored-by.mts', 'block-merge-commit.mts'])(
    '%s exits 0',
    (hook) => {
      const res = spawnSync(join(HOOKS, hook), { input: 'not json at all', encoding: 'utf8' })
      expect(res.status).toBe(0)
    },
  )
})
