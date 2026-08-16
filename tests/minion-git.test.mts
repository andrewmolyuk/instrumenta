import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneAndBranch, commitAndPush, writeNote } from '../minion/git.mts'

let remoteDir: string
let workDir: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Simulates an earlier Minion attempt that already pushed real work to `branch`. */
function pushBranchWithCommit(remote: string, branch: string, message: string): void {
  const dir = join(mkdtempSync(join(tmpdir(), 'minion-git-earlier-')), 'repo')
  git(['clone', remote, dir], tmpdir())
  git(['checkout', '-b', branch], dir)
  writeFileSync(join(dir, 'change.txt'), message)
  git(['add', '-A'], dir)
  git(['commit', '-m', message], dir)
  git(['push', 'origin', branch], dir)
  rmSync(join(dir, '..'), { recursive: true, force: true })
}

beforeEach(() => {
  remoteDir = mkdtempSync(join(tmpdir(), 'minion-git-remote-'))
  git(['init', '-b', 'main'], remoteDir)
  git(['commit', '--allow-empty', '-m', 'initial'], remoteDir)
  workDir = join(mkdtempSync(join(tmpdir(), 'minion-git-work-')), 'repo')
})

afterEach(() => {
  rmSync(remoteDir, { recursive: true, force: true })
  rmSync(join(workDir, '..'), { recursive: true, force: true })
})

describe('cloneAndBranch', () => {
  it('clones the repo and checks out a branch named after jira_key', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    expect(git(['branch', '--show-current'], workDir).trim()).toBe('KAZ-1')
  })

  it('sets a local commit identity so a fresh clone can commit', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    expect(git(['config', 'user.name'], workDir).trim()).toBeTruthy()
    expect(git(['config', 'user.email'], workDir).trim()).toBeTruthy()
  })

  it('checks out an existing remote branch instead of branching fresh, when reuseExisting is true', async () => {
    pushBranchWithCommit(remoteDir, 'KAZ-1', 'earlier attempt work')

    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    expect(git(['log', '-1', '--format=%s'], workDir).trim()).toBe('earlier attempt work')
  })

  it('branches fresh from the base tip when reuseExisting is false, even if the remote branch exists', async () => {
    pushBranchWithCommit(remoteDir, 'KAZ-1', 'earlier attempt work')

    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, false)
    expect(git(['log', '-1', '--format=%s'], workDir).trim()).toBe('initial')
  })
})

describe('writeNote', () => {
  it('writes the note file under the given notes path', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    await writeNote(workDir, 'docs/todo/', 'kaz-1-given-up.md', 'note content')
    const path = join(workDir, 'docs/todo/kaz-1-given-up.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('note content')
  })
})

describe('commitAndPush', () => {
  it('commits staged changes and pushes the branch to the remote', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    await writeNote(workDir, 'docs/todo/', 'kaz-1-given-up.md', 'note content')
    await commitAndPush(workDir, 'KAZ-1', 'KAZ-1: add note')

    const branches = git(['branch', '--list', 'KAZ-1'], remoteDir)
    expect(branches).toContain('KAZ-1')

    const log = git(['log', 'KAZ-1', '-1', '--format=%s'], remoteDir).trim()
    expect(log).toBe('KAZ-1: add note')
  })

  it('surfaces stdout in the thrown error when a git command fails without writing to stderr', async () => {
    // `git commit` with nothing staged prints "nothing to commit..." on stdout, not
    // stderr — a real example of the case this is guarding against, not a contrived one.
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    await expect(commitAndPush(workDir, 'KAZ-1', 'KAZ-1: no changes')).rejects.toThrow(/nothing to commit/i)
  })
})
