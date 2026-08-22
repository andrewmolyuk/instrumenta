import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneAndBranch, commitAndPush, stageAll, writeNote } from '../minion/git.mts'

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

describe('stageAll', () => {
  it('stages new and untracked files without committing', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    writeFileSync(join(workDir, 'new-file.txt'), 'work')

    await stageAll(workDir)

    expect(git(['diff', '--cached', '--name-only'], workDir)).toContain('new-file.txt')
    expect(git(['log', '-1', '--format=%s'], workDir).trim()).toBe('initial')
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

  it('commits despite a failing pre-commit hook — the gate already ran those checks', async () => {
    // The KAZ-8390 crash: the target repo's Husky pre-commit hook rejected the commit
    // (ESLint errors), commitAndPush threw, and the attempt was recorded as `crashed`
    // with nothing pushed. runPreCommitHook now runs those same checks before this point.
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    const hook = join(workDir, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" 1>&2\nexit 1\n')
    chmodSync(hook, 0o755)
    await writeNote(workDir, 'docs/todo/', 'kaz-1-given-up.md', 'note content')

    await commitAndPush(workDir, 'KAZ-1', 'chore: KAZ-1: add note')

    expect(git(['log', 'KAZ-1', '-1', '--format=%s'], remoteDir).trim()).toBe('chore: KAZ-1: add note')
  })

  it('surfaces stdout in the thrown error when a git command fails without writing to stderr', async () => {
    // `git commit` with nothing staged prints "nothing to commit..." on stdout, not
    // stderr — a real example of the case this is guarding against, not a contrived one.
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    await expect(commitAndPush(workDir, 'KAZ-1', 'KAZ-1: no changes')).rejects.toThrow(/nothing to commit/i)
  })
})

describe('credential redaction', () => {
  it('keeps the embedded token out of the error a failed clone throws', async () => {
    const token = 'ATATT3xFfGF0-super-secret-token'
    const url = `https://x-token-auth:${token}@bitbucket.org/CGS/does-not-exist.git`

    // The RPG-6017 leak: every clone URL carries BITBUCKET_TOKEN, and the failure
    // message was stored verbatim in tasks.output and rendered in the Cockpit.
    const err = await cloneAndBranch(url, 'KAZ-1', workDir, true).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(token)
    expect((err as Error).message).toContain('x-token-auth:***@bitbucket.org')
  })
})

describe('cloneAndBranch through the git cache', () => {
  let cacheDir: string

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'minion-git-cache-'))
    process.env.MINION_GIT_CACHE = cacheDir
  })

  afterEach(() => {
    delete process.env.MINION_GIT_CACHE
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('creates a bare mirror on first use and clones the work tree from it', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)

    const mirrors = readdirSync(cacheDir)
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).toMatch(/\.git$/)
    expect(git(['rev-parse', '--is-bare-repository'], join(cacheDir, mirrors[0]!)).trim()).toBe('true')
    expect(git(['branch', '--show-current'], workDir).trim()).toBe('KAZ-1')
  })

  it('points origin back at the real remote, so pushes do not land in the mirror', async () => {
    // Without the set-url, `git push` would silently update the cache volume
    // and the target repository would never see the branch.
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)

    expect(git(['remote', 'get-url', 'origin'], workDir).trim()).toBe(remoteDir)

    writeFileSync(join(workDir, 'change.txt'), 'work')
    await commitAndPush(workDir, 'KAZ-1', 'fix: KAZ-1: do the thing')
    expect(git(['log', 'KAZ-1', '-1', '--format=%s'], remoteDir).trim()).toBe('fix: KAZ-1: do the thing')
  })

  it('reuses the mirror on the next attempt, picking up commits pushed since', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    const mirrorPath = join(cacheDir, readdirSync(cacheDir)[0]!)
    const before = git(['rev-parse', 'HEAD'], workDir).trim()

    pushBranchWithCommit(remoteDir, 'KAZ-2', 'later work')

    const second = join(mkdtempSync(join(tmpdir(), 'minion-git-work2-')), 'repo')
    await cloneAndBranch(remoteDir, 'KAZ-2', second, true)

    // Same mirror, not a second one, and it saw the branch pushed after it was built.
    expect(readdirSync(cacheDir)).toHaveLength(1)
    expect(git(['rev-parse', '--is-bare-repository'], mirrorPath).trim()).toBe('true')
    expect(git(['log', '-1', '--format=%s'], second).trim()).toBe('later work')
    expect(before).toBeTruthy()
    rmSync(join(second, '..'), { recursive: true, force: true })
  })

  it('never writes credentials into the mirror it leaves on the volume', async () => {
    // The mirror outlives the container; a token in its config would too.
    const withToken = remoteDir
    await cloneAndBranch(withToken, 'KAZ-1', workDir, true)

    const mirrorPath = join(cacheDir, readdirSync(cacheDir)[0]!)
    expect(readFileSync(join(mirrorPath, 'config'), 'utf-8')).not.toMatch(/:[^/@\s]+@/)
  })

  it('rebuilds a half-written mirror instead of failing against it forever', async () => {
    // Building a mirror takes minutes, so being killed part-way through is the
    // realistic failure. Left in place, the directory exists but no fetch can
    // succeed against it, and every later attempt falls back to a direct clone.
    const mirrorPath = join(cacheDir, 'localhost-' + 'x'.repeat(4) + '.git')
    mkdirSync(mirrorPath, { recursive: true })
    writeFileSync(join(mirrorPath, 'HEAD'), 'garbage')

    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)

    const built = readdirSync(cacheDir).filter((d) => !d.startsWith('localhost-'))
    expect(built).toHaveLength(1)
    expect(git(['rev-parse', '--is-bare-repository'], join(cacheDir, built[0]!)).trim()).toBe('true')
    expect(git(['branch', '--show-current'], workDir).trim()).toBe('KAZ-1')
  })

  it('replaces a corrupt mirror sitting at the real path', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)
    const mirrorPath = join(cacheDir, readdirSync(cacheDir)[0]!)
    rmSync(join(mirrorPath, 'objects'), { recursive: true, force: true })

    const second = join(mkdtempSync(join(tmpdir(), 'minion-git-work3-')), 'repo')
    await cloneAndBranch(remoteDir, 'KAZ-2', second, true)

    expect(git(['branch', '--show-current'], second).trim()).toBe('KAZ-2')
    rmSync(join(second, '..'), { recursive: true, force: true })
  })

  it('leaves no half-built mirror at the real path when the clone fails', async () => {
    await expect(
      cloneAndBranch(join(cacheDir, 'no-such-remote'), 'KAZ-1', workDir, true),
    ).rejects.toThrow()

    // A `.partial-*` leftover is fine — one at the real path is not.
    expect(readdirSync(cacheDir).filter((d) => d.endsWith('.git'))).toEqual([])
  })

  it('falls back to a direct clone when the cache cannot be used', async () => {
    // A stale or unwritable mirror costs minutes, never the attempt.
    process.env.MINION_GIT_CACHE = join(cacheDir, 'nope', 'deeper')
    writeFileSync(join(cacheDir, 'nope'), 'not a directory')

    await cloneAndBranch(remoteDir, 'KAZ-1', workDir, true)

    expect(git(['branch', '--show-current'], workDir).trim()).toBe('KAZ-1')
    expect(git(['remote', 'get-url', 'origin'], workDir).trim()).toBe(remoteDir)
  })
})
