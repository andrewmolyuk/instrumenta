import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneAndBranch, commitAndPush, writeNote } from '../minion/git.mts'

let remoteDir: string
let workDir: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
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
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir)
    expect(git(['branch', '--show-current'], workDir).trim()).toBe('KAZ-1')
  })

  it('sets a local commit identity so a fresh clone can commit', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir)
    expect(git(['config', 'user.name'], workDir).trim()).toBeTruthy()
    expect(git(['config', 'user.email'], workDir).trim()).toBeTruthy()
  })
})

describe('writeNote', () => {
  it('writes the note file under the given notes path', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir)
    await writeNote(workDir, 'docs/todo/', 'kaz-1-given-up.md', 'note content')
    const path = join(workDir, 'docs/todo/kaz-1-given-up.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('note content')
  })
})

describe('commitAndPush', () => {
  it('commits staged changes and pushes the branch to the remote', async () => {
    await cloneAndBranch(remoteDir, 'KAZ-1', workDir)
    await writeNote(workDir, 'docs/todo/', 'kaz-1-given-up.md', 'note content')
    await commitAndPush(workDir, 'KAZ-1', 'KAZ-1: add note')

    const branches = git(['branch', '--list', 'KAZ-1'], remoteDir)
    expect(branches).toContain('KAZ-1')

    const log = git(['log', 'KAZ-1', '-1', '--format=%s'], remoteDir).trim()
    expect(log).toBe('KAZ-1: add note')
  })
})
