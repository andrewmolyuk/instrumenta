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
    hasOpenPrForBranch: vi.fn(async () => false),
    implementTask: vi.fn(async () => ({ output: '', costUsd: null, transcript: [] })),
    hasVerifyScript: vi.fn(async () => true),
    runVerify: vi.fn(async () => ({ passed: true, output: '' })),
    runPreCommitChecks: vi.fn(async () => ({ ran: true, passed: true, output: '' })),
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

    expect(deps.cloneAndBranch).toHaveBeenCalledWith('https://x/repo.git', 'KAZ-1', '/tmp/wd', true)
    expect(deps.implementTask).toHaveBeenCalledWith('/tmp/wd', expect.objectContaining({ jira_key: 'KAZ-1' }))
  })

  it('checks for an open PR on this jira_key before cloning', async () => {
    const deps = fakeDeps()
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.hasOpenPrForBranch).toHaveBeenCalledWith('KAZ-1')
  })

  it('tells cloneAndBranch not to reuse an existing branch when one has an open PR', async () => {
    const deps = fakeDeps({ hasOpenPrForBranch: vi.fn(async () => true) })
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.cloneAndBranch).toHaveBeenCalledWith('https://x/repo.git', 'KAZ-1', '/tmp/wd', false)
  })

  it('reports success with the PR url when verify passes', async () => {
    const deps = fakeDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'success',
      pr_url: 'https://bitbucket.org/o/r/pull-requests/1',
      output: null,
      // Reported even here, where `output` is deliberately null: a successful
      // attempt used to leave no record of what the agent actually did.
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', expect.stringMatching(/^fix: KAZ-1:/))
    expect(deps.createPullRequest).toHaveBeenCalledWith('KAZ-1', expect.objectContaining({ jira_key: 'KAZ-1' }))
  })

  it('carries implementTask\'s reported cost through to a successful result', async () => {
    const deps = fakeDeps({ implementTask: vi.fn(async () => ({ output: '', costUsd: 0.42, transcript: [] })) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.cost_usd).toBe(0.42)
  })

  it('lowercases the first letter of the description in the commit subject, to satisfy commitlint subject-case', async () => {
    const deps = fakeDeps()
    await runMinion(
      input({ description: 'In previous versions checking the terms and conditions once was enough' }),
      'https://x/repo.git',
      '/tmp/wd',
      'docs/todo/',
      deps,
    )

    expect(deps.commitAndPush).toHaveBeenCalledWith(
      '/tmp/wd',
      'KAZ-1',
      'fix: KAZ-1: in previous versions checking the terms and conditions once was enough',
    )
  })

  it('collapses a multi-line description into a single-line commit subject', async () => {
    // KAZ-8390's real description, whose first line alone made the subject
    // `fix: KAZ-8390: steps:` and pushed the rest into an unblank-lined body.
    const deps = fakeDeps()
    await runMinion(
      input({ description: 'Steps:\nOpen a client, then\tpick a port\n\nExpected: it works' }),
      'https://x/repo.git',
      '/tmp/wd',
      'docs/todo/',
      deps,
    )

    expect(deps.commitAndPush).toHaveBeenCalledWith(
      '/tmp/wd',
      'KAZ-1',
      'fix: KAZ-1: steps: Open a client, then pick a port Expected: it works',
    )
  })

  it('truncates a long description at 72 characters, without a trailing space', async () => {
    const deps = fakeDeps()
    await runMinion(
      input({ description: `${'a'.repeat(71)} tail that does not fit` }),
      'https://x/repo.git',
      '/tmp/wd',
      'docs/todo/',
      deps,
    )

    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', `fix: KAZ-1: ${'a'.repeat(71)}`)
  })

  it('still produces a usable commit message when the description is blank', async () => {
    const deps = fakeDeps()
    await runMinion(input({ description: '   ' }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    // Trailing space and all — `git commit` strips it from the subject itself.
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', 'fix: KAZ-1: ')
  })

  it('writes a blocked_no_verify note and commits it with a chore: message, without a PR, when there is no verify script', async () => {
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'blocked_no_verify',
      pr_url: null,
      output: null,
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-blocked-no-verify.md', expect.any(String))
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', expect.stringMatching(/^chore: KAZ-1:/))
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('includes implementTask output on blocked_no_verify when there was some', async () => {
    const deps = fakeDeps({
      hasVerifyScript: vi.fn(async () => false),
      implementTask: vi.fn(async () => ({ output: 'claude: nothing to change here', costUsd: null, transcript: [] })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toBe('claude: nothing to change here')
  })

  it('reports failed_verify with the captured output and commits nothing on a non-final attempt', async () => {
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'failed_verify',
      pr_url: null,
      output: 'test 1 failed',
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    expect(deps.writeNote).not.toHaveBeenCalled()
  })

  it('combines implementTask output with verify output on failed_verify when there was both', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({ output: 'claude did something', costUsd: null, transcript: [] })),
      runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toContain('claude did something')
    expect(result.output).toContain('test 1 failed')
  })

  it('runs the pre-commit checks after verify passes and before committing', async () => {
    const order: string[] = []
    const deps = fakeDeps({
      runVerify: vi.fn(async () => {
        order.push('verify')
        return { passed: true, output: '' }
      }),
      runPreCommitChecks: vi.fn(async () => {
        order.push('pre-commit')
        return { ran: true, passed: true, output: '' }
      }),
      commitAndPush: vi.fn(async () => {
        order.push('commit')
      }),
    })
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(order).toEqual(['verify', 'pre-commit', 'commit'])
  })

  it('reports failed_verify and commits nothing when the pre-commit checks fail on a non-final attempt', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({ output: 'claude did something', costUsd: 1.5, transcript: [] })),
      runPreCommitChecks: vi.fn(async () => ({ ran: true, passed: false, output: 'eslint: 2 problems' })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('failed_verify')
    expect(result.output).toContain('claude did something')
    expect(result.output).toContain('eslint: 2 problems')
    expect(result.cost_usd).toBe(1.5)
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('reports given_up with a note when the pre-commit checks fail on the final attempt', async () => {
    const deps = fakeDeps({
      runPreCommitChecks: vi.fn(async () => ({ ran: true, passed: false, output: 'eslint: 2 problems' })),
    })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'given_up',
      pr_url: null,
      output: 'eslint: 2 problems',
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-given-up.md', expect.any(String))
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('commits and opens the PR when the repo has no pre-commit hook to run', async () => {
    const deps = fakeDeps({ runPreCommitChecks: vi.fn(async () => ({ ran: false, passed: true, output: '' })) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('success')
  })

  it('skips the pre-commit checks entirely when verify already failed', async () => {
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.runPreCommitChecks).not.toHaveBeenCalled()
  })

  it('does not gate the note-only commits on the pre-commit checks — a give-up note has to land regardless', async () => {
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.runPreCommitChecks).not.toHaveBeenCalled()
    expect(deps.commitAndPush).toHaveBeenCalled()
  })

  it('reports given_up with the captured output and a note when verify fails on the final (3rd) attempt', async () => {
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'given_up',
      pr_url: null,
      output: 'test 1 failed',
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-given-up.md', expect.any(String))
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', expect.stringMatching(/^chore: KAZ-1:/))
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('reports given_up (not blocked_no_verify) when there is no verify gate on the final attempt', async () => {
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('given_up')
  })

  it('reports crashed with the error, instead of throwing, when the success-path commit fails', async () => {
    const deps = fakeDeps({ commitAndPush: vi.fn(async () => { throw new Error('commit-msg hook rejected') }) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('crashed')
    expect(result.pr_url).toBeNull()
    expect(result.output).toContain('commit-msg hook rejected')
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('reports crashed with the error when the blocked_no_verify commit fails', async () => {
    const deps = fakeDeps({
      hasVerifyScript: vi.fn(async () => false),
      commitAndPush: vi.fn(async () => { throw new Error('commit-msg hook rejected') }),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('crashed')
    expect(result.output).toContain('commit-msg hook rejected')
  })

  it('reports crashed with the error, instead of throwing, when PR creation fails after a successful commit', async () => {
    const deps = fakeDeps({
      createPullRequest: vi.fn(async () => { throw new Error('Bitbucket PR creation failed: 400 Bad Request\ndestination: branch not found: main') }),
    })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('crashed')
    expect(result.pr_url).toBeNull()
    expect(result.output).toContain('branch not found: main')
    expect(deps.commitAndPush).toHaveBeenCalled()
  })

  it('reports crashed with the error when the given_up commit fails on the final attempt', async () => {
    const deps = fakeDeps({
      runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })),
      commitAndPush: vi.fn(async () => { throw new Error('commit-msg hook rejected') }),
    })
    const result = await runMinion(input({ attempt_number: 3 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('crashed')
    expect(result.output).toContain('test 1 failed')
    expect(result.output).toContain('commit-msg hook rejected')
  })
})
