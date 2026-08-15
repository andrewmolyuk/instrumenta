import { describe, expect, it, vi } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import type { MinionDeps } from '../minion/orchestrate.mts'
import { runMinion } from '../minion/orchestrate.mts'

function input(overrides: Partial<MinionInput> = {}): MinionInput {
  return {
    task_id: 't1',
    jira_key: 'KAZ-1',
    description: 'Fix the thing',
    attempt_number: 1,
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<MinionDeps> = {}): MinionDeps {
  return {
    cloneAndBranch: vi.fn(async () => {}),
    implementTask: vi.fn(async () => ''),
    hasVerifyScript: vi.fn(async () => true),
    runVerify: vi.fn(async () => ({ passed: true, output: '' })),
    writeNote: vi.fn(async () => {}),
    commitAndPush: vi.fn(async () => {}),
    createPullRequest: vi.fn(async () => 'https://bitbucket.org/o/r/pull-requests/1'),
    ...overrides,
  }
}

describe('runMinion', () => {
  it('checks out the branch and attempts the task before anything else', async () => {
    const deps = fakeDeps()
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.cloneAndBranch).toHaveBeenCalledWith('https://x/repo.git', 'KAZ-1', '/tmp/wd')
    expect(deps.implementTask).toHaveBeenCalledWith('/tmp/wd', expect.objectContaining({ jira_key: 'KAZ-1' }))
  })

  it('reports success with the PR url when verify passes', async () => {
    const deps = fakeDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'success',
      pr_url: 'https://bitbucket.org/o/r/pull-requests/1',
      output: null,
    })
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', expect.stringContaining('KAZ-1'))
    expect(deps.createPullRequest).toHaveBeenCalledWith('KAZ-1', expect.objectContaining({ jira_key: 'KAZ-1' }))
  })

  it('writes a blocked_no_verify note and commits it, without a PR, when there is no verify script', async () => {
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({ status: 'blocked_no_verify', pr_url: null, output: null })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-blocked-no-verify.md', expect.any(String))
    expect(deps.commitAndPush).toHaveBeenCalledOnce()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('includes implementTask output on blocked_no_verify when there was some', async () => {
    const deps = fakeDeps({
      hasVerifyScript: vi.fn(async () => false),
      implementTask: vi.fn(async () => 'claude: nothing to change here'),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toBe('claude: nothing to change here')
  })

  it('reports failed_verify with the captured output and commits nothing on a non-final attempt', async () => {
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({ status: 'failed_verify', pr_url: null, output: 'test 1 failed' })
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    expect(deps.writeNote).not.toHaveBeenCalled()
  })

  it('combines implementTask output with verify output on failed_verify when there was both', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => 'claude did something'),
      runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toContain('claude did something')
    expect(result.output).toContain('test 1 failed')
  })

  it('reports given_up with the captured output and a note when verify fails on the final (3rd) attempt', async () => {
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({ status: 'given_up', pr_url: null, output: 'test 1 failed' })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-given-up.md', expect.any(String))
    expect(deps.commitAndPush).toHaveBeenCalledOnce()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('reports given_up (not blocked_no_verify) when there is no verify gate on the final attempt', async () => {
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('given_up')
  })
})
