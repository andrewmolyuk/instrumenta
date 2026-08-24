import { describe, expect, it, vi } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import type { JiraTicket } from '../minion/jira.mts'
import type { MinionDeps } from '../minion/orchestrate.mts'
import { runMinion } from '../minion/orchestrate.mts'

function input(overrides: Partial<MinionInput> = {}): MinionInput {
  return {
    task_id: 't1',
    jira_key: 'KAZ-1',
    attempt_number: 1,
    ...overrides,
  }
}

function ticket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { summary: 'Fix the thing', description: 'Fix the thing', attachments: [], ...overrides }
}

function fakeDeps(overrides: Partial<MinionDeps> = {}): MinionDeps {
  return {
    cloneAndBranch: vi.fn(async () => {}),
    fetchTicket: vi.fn(async () => ticket()),
    hasOpenPrForBranch: vi.fn(async () => false),
    implementTask: vi.fn(async () => ({ output: '', costUsd: null, transcript: [], usageLimited: false, apiError: false })),
    hasVerifyScript: vi.fn(async () => true),
    runVerify: vi.fn(async () => ({ passed: true, output: '' })),
    runPreCommitChecks: vi.fn(async () => ({ ran: true, passed: true, output: '' })),
    hasChanges: vi.fn(async () => true),
    commentOnTicket: vi.fn(async () => true),
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
    expect(deps.implementTask).toHaveBeenCalledWith(
      '/tmp/wd',
      expect.objectContaining({ jira_key: 'KAZ-1' }),
      expect.objectContaining({ summary: 'Fix the thing' }),
    )
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
    expect(deps.createPullRequest).toHaveBeenCalledWith(
      'KAZ-1',
      expect.objectContaining({ jira_key: 'KAZ-1' }),
      expect.objectContaining({ summary: 'Fix the thing' }),
      null,
    )
  })

  it('carries implementTask\'s reported cost through to a successful result', async () => {
    const deps = fakeDeps({ implementTask: vi.fn(async () => ({ output: '', costUsd: 0.42, transcript: [], usageLimited: false, apiError: false })) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.cost_usd).toBe(0.42)
  })

  it('lowercases the first letter of the description in the commit subject, to satisfy commitlint subject-case', async () => {
    const deps = fakeDeps({ fetchTicket: vi.fn(async () => ticket({ summary: 'In previous versions checking the terms and conditions once was enough' })) })
    await runMinion(
      input(),
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
    const deps = fakeDeps({ fetchTicket: vi.fn(async () => ticket({ summary: 'Steps:\nOpen a client, then\tpick a port\n\nExpected: it works' })) })
    await runMinion(
      input(),
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
    const deps = fakeDeps({ fetchTicket: vi.fn(async () => ticket({ summary: `${'a'.repeat(71)} tail that does not fit` })) })
    await runMinion(
      input(),
      'https://x/repo.git',
      '/tmp/wd',
      'docs/todo/',
      deps,
    )

    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', `fix: KAZ-1: ${'a'.repeat(71)}`)
  })

  it('still produces a usable commit message when the summary is blank', async () => {
    const deps = fakeDeps({ fetchTicket: vi.fn(async () => ticket({ summary: '   ' })) })
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    // Trailing space and all — `git commit` strips it from the subject itself.
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', 'fix: KAZ-1: ')
  })

  it('writes a note and commits it with a chore: message, without a PR, when there is no verify script', async () => {
    // At MAX_ATTEMPTS = 1 (ADR-015) the first attempt is also the last, so this
    // reports given_up rather than blocked_no_verify — there is no later
    // attempt for which the ticket could still be merely blocked.
    const deps = fakeDeps({ hasVerifyScript: vi.fn(async () => false) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'given_up',
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
      implementTask: vi.fn(async () => ({ output: 'claude: nothing to change here', costUsd: null, transcript: [], usageLimited: false, apiError: false })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toBe('claude: nothing to change here')
  })

  it('reports given_up with the captured output and writes a note when the gate fails', async () => {
    // ADR-015: one attempt, so a failing gate is terminal immediately. The note
    // is written and pushed because it is the record a human is left with.
    const deps = fakeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result).toEqual({
      status: 'given_up',
      pr_url: null,
      output: expect.stringContaining('test 1 failed'),
      cost_usd: null,
      session: expect.any(String),
    })
    expect(deps.writeNote).toHaveBeenCalledWith('/tmp/wd', 'docs/todo/', 'kaz-1-given-up.md', expect.any(String))
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('combines implementTask output with verify output on failed_verify when there was both', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({ output: 'claude did something', costUsd: null, transcript: [], usageLimited: false, apiError: false })),
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

  it('reports given_up when the pre-commit checks fail', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({ output: 'claude did something', costUsd: 1.5, transcript: [], usageLimited: false, apiError: false })),
      runPreCommitChecks: vi.fn(async () => ({ ran: true, passed: false, output: 'eslint: 2 problems' })),
    })
    const result = await runMinion(input({ attempt_number: 1 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('given_up')
    expect(result.output).toContain('claude did something')
    expect(result.output).toContain('eslint: 2 problems')
    expect(result.cost_usd).toBe(1.5)
    // The give-up note is committed and pushed — at one attempt (ADR-015) this
    // is terminal, and the note is the record a human is left with.
    expect(deps.commitAndPush).toHaveBeenCalledWith('/tmp/wd', 'KAZ-1', expect.stringMatching(/^chore: KAZ-1: giving up/))
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
      output: expect.stringContaining('eslint: 2 problems'),
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
      output: expect.stringContaining('test 1 failed'),
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

describe('runMinion when the agent changed nothing', () => {
  function noChangeDeps(overrides: Partial<MinionDeps> = {}): MinionDeps {
    return fakeDeps({
      hasChanges: vi.fn(async () => false),
      // A report is what makes an empty tree a conclusion rather than an aborted
      // attempt (ADR-018), so every test about the ADR-014 path has to have one.
      implementTask: vi.fn(async () => ({
        output: '<!-- minion-report -->\n## What changed\n\nNothing needed changing.',
        costUsd: null,
        transcript: [],
        usageLimited: false,
        apiError: false,
      })),
      ...overrides,
    })
  }

  it('reports no_change instead of crashing on "nothing to commit"', async () => {
    // ADR-014: the gate passed against an unmodified tree. Before this,
    // `git commit` failed, the attempt was recorded as `crashed`, and the
    // ticket was retried twice more at full cost to reach the same conclusion.
    const deps = noChangeDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('no_change')
    expect(result.pr_url).toBeNull()
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('tells Jira why, since the pipeline cannot verify the claim itself', async () => {
    const deps = noChangeDeps({
      implementTask: vi.fn(async () => ({
        output: 'narration\n<!-- minion-report -->\n## What changed\n\nAlready fixed in ab12cd.',
        costUsd: 1.5,
        transcript: [],
        usageLimited: false,
        apiError: false,
      })),
    })

    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.commentOnTicket).toHaveBeenCalledWith('KAZ-1', expect.stringContaining('made no change'))
    const [, text] = (deps.commentOnTicket as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(text).toContain('Already fixed in ab12cd.')
    // A reader deciding whether to close the ticket must know this is a claim.
    expect(text).toContain("agent's conclusion, not")
    expect(text).not.toContain('narration')
  })

  it('still reports no_change when the Jira comment cannot be posted', async () => {
    const deps = noChangeDeps({ commentOnTicket: vi.fn(async () => false) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('no_change')
  })

  it('records the session, so the conclusion is auditable afterwards', async () => {
    const deps = noChangeDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.session).toContain('Minion session')
  })

  it('does not reach the no-change path when the gate failed', async () => {
    // An empty tree after a failing gate is a failure, not a conclusion.
    const deps = noChangeDeps({ runVerify: vi.fn(async () => ({ passed: false, output: 'test 1 failed' })) })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('given_up')
    expect(deps.commentOnTicket).not.toHaveBeenCalled()
  })
})

describe('runMinion when the usage limit is reached', () => {
  const LIMIT = 'Claude AI usage limit reached|1755000000'

  function limitedDeps(overrides: Partial<MinionDeps> = {}): MinionDeps {
    return fakeDeps({
      implementTask: vi.fn(async () => ({ output: LIMIT, costUsd: null, transcript: [], usageLimited: true, apiError: false })),
      ...overrides,
    })
  }

  it('reports usage_limit and stops before the gate, the commit and the ticket', async () => {
    const deps = limitedDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('usage_limit')
    expect(result.pr_url).toBeNull()
    expect(deps.hasVerifyScript).not.toHaveBeenCalled()
    expect(deps.runVerify).not.toHaveBeenCalled()
    expect(deps.runPreCommitChecks).not.toHaveBeenCalled()
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
    expect(deps.writeNote).not.toHaveBeenCalled()
    expect(deps.commentOnTicket).not.toHaveBeenCalled()
  })

  it('does not become no_change on the exact live shape that produced one', async () => {
    // ADR-017's whole reason: a target whose `verify` is the literal string
    // `true` passes the gate vacuously, a clone with no install has no
    // pre-commit hook to fail, and the tree is empty because the agent never
    // ran — which reported `no_change`, terminal per ADR-014, and told a human
    // on Jira that the ticket needed no change.
    const deps = limitedDeps({
      hasChanges: vi.fn(async () => false),
      runPreCommitChecks: vi.fn(async () => ({ ran: false, passed: true, output: '' })),
    })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('usage_limit')
    expect(deps.commentOnTicket).not.toHaveBeenCalled()
  })

  it('keeps the limit message and the session, so the record says what happened', async () => {
    const deps = limitedDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.output).toContain('usage limit reached')
    expect(result.session).toContain('Minion session')
  })

  it('is not the final-attempt give-up path, however many attempts have run', async () => {
    // MAX_ATTEMPTS is 1 (ADR-015), so every attempt is the final one — routing
    // this through the isFinalAttempt branches would retire the ticket.
    const deps = limitedDeps()
    const result = await runMinion(input({ attempt_number: 9 }), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('usage_limit')
  })
})

describe('runMinion when an upstream API call fails', () => {
  const API_ERROR = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'

  function apiErrorDeps(overrides: Partial<MinionDeps> = {}): MinionDeps {
    return fakeDeps({
      implementTask: vi.fn(async () => ({
        output: API_ERROR,
        costUsd: 0.002208,
        transcript: ['[00:02] session started', '[03:25] ' + API_ERROR, '[03:25] finished'],
        usageLimited: false,
        apiError: true,
      })),
      hasChanges: vi.fn(async () => false),
      ...overrides,
    })
  }

  it('reports agent_error instead of the no_change it recorded on RPG-5827', async () => {
    const deps = apiErrorDeps()
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('agent_error')
    expect(result.pr_url).toBeNull()
    expect(deps.hasVerifyScript).not.toHaveBeenCalled()
    expect(deps.commitAndPush).not.toHaveBeenCalled()
    // The comment that told a human the ticket needed no change.
    expect(deps.commentOnTicket).not.toHaveBeenCalled()
  })

  it('keeps the error text and the session, so the record says what happened', async () => {
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', apiErrorDeps())

    expect(result.output).toContain('529')
    expect(result.session).toContain('Minion session')
    // A cost is still reported: the failed call was billed, however little.
    expect(result.cost_usd).toBeCloseTo(0.002208)
  })

  it('does not discard an attempt that did the work and reported it, whatever the CLI printed after', async () => {
    // The guard that makes this branch safe: a report means a conclusion, and a
    // conclusion goes through the gate like any other.
    const deps = apiErrorDeps({
      implementTask: vi.fn(async () => ({
        output: 'narration\n<!-- minion-report -->\n## What changed\n\nFixed it.\n' + API_ERROR,
        costUsd: 3,
        transcript: [],
        usageLimited: false,
        apiError: true,
      })),
      hasChanges: vi.fn(async () => true),
    })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('success')
    expect(deps.commitAndPush).toHaveBeenCalled()
  })

  it('will not record no_change for an empty tree with no report, whatever the cause', async () => {
    // The durable half of ADR-018: this holds even when nothing recognises the
    // error text, which is how the 529 got through in the first place.
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({
        output: 'Some future error nobody has a pattern for',
        costUsd: 0.01,
        transcript: [],
        usageLimited: false,
        apiError: false,
      })),
      hasChanges: vi.fn(async () => false),
    })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('agent_error')
    expect(deps.commentOnTicket).not.toHaveBeenCalled()
  })

  it('still records no_change when the agent actually concluded that, in the required form', async () => {
    const deps = fakeDeps({
      implementTask: vi.fn(async () => ({
        output: '<!-- minion-report -->\n## What changed\n\nAlready fixed in ab12cd.',
        costUsd: 1.5,
        transcript: [],
        usageLimited: false,
        apiError: false,
      })),
      hasChanges: vi.fn(async () => false),
    })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(result.status).toBe('no_change')
    expect(deps.commentOnTicket).toHaveBeenCalled()
  })

  it('applies the same guard to a usage limit', async () => {
    const deps = apiErrorDeps({
      implementTask: vi.fn(async () => ({
        output: '<!-- minion-report -->\n## What changed\n\nDone.',
        costUsd: 2,
        transcript: [],
        usageLimited: true,
        apiError: false,
      })),
      hasChanges: vi.fn(async () => true),
    })

    expect((await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)).status).toBe('success')
  })
})

describe('runMinion and a flaky gate (ADR-019)', () => {
  /** Fails on its first call, passes on every one after. */
  function flaky(output: string) {
    let call = 0
    return vi.fn(async () => ({ passed: call++ > 0, output, ran: true }))
  }

  it('re-runs a failed verify once, and commits when the second run passes', async () => {
    const runVerify = flaky('3 failed | 760 passed')
    const deps = fakeDeps({ runVerify })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(runVerify).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('success')
    expect(deps.commitAndPush).toHaveBeenCalled()
  })

  it('re-runs failed pre-commit checks once — the half that retired RPG-6062', async () => {
    // The live case: the agent changed one bash script in the legacy app, and
    // the hook failed on vitest cases in another workspace that nothing in the
    // diff could reach.
    const runPreCommitChecks = flaky('husky - pre-commit script failed (code 1)')
    const deps = fakeDeps({ runPreCommitChecks })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(runPreCommitChecks).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('success')
    expect(deps.createPullRequest).toHaveBeenCalled()
  })

  it('gives up when the check fails both times, and says it failed twice', async () => {
    const runVerify = vi.fn(async () => ({ passed: false, output: 'test 1 failed' }))
    const deps = fakeDeps({ runVerify })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(runVerify).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('given_up')
    expect(result.output).toContain('test 1 failed')
    expect(result.output).toContain('failed both times')
    expect(deps.createPullRequest).not.toHaveBeenCalled()
  })

  it('does not retry a check that passed, so the happy path costs nothing extra', async () => {
    const deps = fakeDeps()
    await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(deps.runVerify).toHaveBeenCalledTimes(1)
    expect(deps.runPreCommitChecks).toHaveBeenCalledTimes(1)
  })

  it('retries exactly once rather than until it passes', async () => {
    // A check that only passes on the third run still gives up: a loop here
    // would spend the attempt's timeout finding that out.
    let call = 0
    const runVerify = vi.fn(async () => ({ passed: call++ >= 2, output: 'still failing' }))
    const deps = fakeDeps({ runVerify })
    const result = await runMinion(input(), 'https://x/repo.git', '/tmp/wd', 'docs/todo/', deps)

    expect(runVerify).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('given_up')
  })
})
