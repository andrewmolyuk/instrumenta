import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import { giveUpAttemptCount, recordAttempt } from '../src/db/queries.mts'
import { MAX_ATTEMPTS } from '../minion/constants.mts'
import { GIVE_UP_THRESHOLD, isGivenUp, pick } from '../src/foreman/pick.mts'
import type { BitbucketConfig } from '../src/bitbucket/closed-prs.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

const BITBUCKET: BitbucketConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

function attempt(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: crypto.randomUUID(),
    jira_key: 'KAZ-1',
    attempt_number: 1,
    status: 'crashed',
    pr_url: null,
    output: null,
    cost_usd: null,
  session: null,
    dispatched_at: '2026-08-13T00:00:00Z',
    finished_at: '2026-08-13T00:05:00Z',
    ...overrides,
  }
}

/**
 * Reads `source.branch.name="<key>"` out of the search query and returns that
 * branch's configured blocking-PR count. Only one query reaches Bitbucket from
 * Pick now (open-or-merged); ADR-016 removed the declined-PR count entirely,
 * so a fake that answered it would be answering nobody.
 */
function fakeBitbucketFetch(blockingCounts: Record<string, number> = {}) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ size: blockingCounts[key] ?? 0 }),
    }
  }) as unknown as typeof fetch
}

function fakeTaskProvider(items: BacklogItem[]): TaskProvider {
  return { listBacklog: async () => items }
}

describe('isGivenUp', () => {
  it('is false with no recorded attempt', () => {
    expect(isGivenUp(db, 'KAZ-1')).toBe(false)
  })

  it('is true from a single failed attempt, with no retry (ADR-015)', () => {
    recordAttempt(db, attempt({ status: 'crashed' }))
    expect(isGivenUp(db, 'KAZ-1')).toBe(true)
  })
})

describe('pick', () => {
  it('returns the first backlog item that is not given up', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'first' },
      { jira_key: 'KAZ-2', summary: 'second' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch())
    expect(result?.jira_key).toBe('KAZ-1')
  })

  it('skips a given-up task and returns the next eligible one', async () => {
    recordAttempt(db, attempt({ jira_key: 'KAZ-1', status: 'crashed' }))
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'given up' },
      { jira_key: 'KAZ-2', summary: 'eligible' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch())
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('returns null when every task is given up', async () => {
    recordAttempt(db, attempt({ jira_key: 'KAZ-1', status: 'crashed' }))
    const backlog = [{ jira_key: 'KAZ-1', summary: 'given up' }]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch())
    expect(result).toBeNull()
  })

  it('picks a ticket whose only PR was declined (ADR-016)', async () => {
    // The live case this came from: every ticket Pick could see had a declined
    // PR and no recorded attempt, so the loop polled an empty-looking queue
    // forever on an unlimited budget. A declined PR is not blocking, so the
    // fake reports no blocking PR for it — and nothing else may stop it.
    const backlog = [{ jira_key: 'KAZ-1', summary: 'a human declined the last PR' }]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch())
    expect(result?.jira_key).toBe('KAZ-1')
  })

  it('returns null for an empty backlog', async () => {
    const result = await pick(db, fakeTaskProvider([]), BITBUCKET, fakeBitbucketFetch())
    expect(result).toBeNull()
  })

  it('skips a task with an open PR (ADR-007) and returns the next eligible one', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'already has an open PR' },
      { jira_key: 'KAZ-2', summary: 'eligible' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({ 'KAZ-1': 1 }))
    expect(result?.jira_key).toBe('KAZ-2')
  })
})

describe('pick and a no_change conclusion', () => {
  it('skips a ticket an earlier attempt concluded needs no change', async () => {
    // ADR-014: terminal after one attempt. Not part of the give-up count, so
    // without this the ticket stays in the backlog with no PR and Pick keeps
    // selecting it — a full-cost attempt every iteration, forever.
    recordAttempt(db, attempt({ task_id: 't1', jira_key: 'KAZ-1', status: 'no_change' }))

    const picked = await pick(
      db,
      fakeTaskProvider([
        { jira_key: 'KAZ-1', summary: 'a' },
        { jira_key: 'KAZ-2', summary: 'b' },
      ]),
      BITBUCKET,
      fakeBitbucketFetch(),
    )

    expect(picked?.jira_key).toBe('KAZ-2')
  })

  it('does not count no_change toward the give-up threshold', async () => {
    // Terminal in its own right — it must not also make two ordinary failures
    // look like three and change what `given_up` means.
    for (let i = 0; i < 3; i++) {
      recordAttempt(db, attempt({ task_id: 'n' + i, jira_key: 'KAZ-9', status: 'no_change' }))
    }
    expect(giveUpAttemptCount(db, 'KAZ-9')).toBe(0)
  })
})

describe('the give-up threshold', () => {
  it('is the same on both sides of the container boundary', () => {
    // Minion enforces it as MAX_ATTEMPTS, Foreman as GIVE_UP_THRESHOLD, from
    // two constants that cannot import each other — the images are built from
    // different subsets of this repo. Nothing but this test stops them drifting.
    expect(GIVE_UP_THRESHOLD).toBe(MAX_ATTEMPTS)
  })
})

describe('pick and a usage_limit attempt (ADR-017)', () => {
  it('leaves the ticket eligible — the limit says nothing about the ticket', async () => {
    recordAttempt(db, attempt({ task_id: 't1', jira_key: 'KAZ-1', status: 'usage_limit' }))

    const picked = await pick(db, fakeTaskProvider([{ jira_key: 'KAZ-1', summary: 'still open' }]), BITBUCKET, fakeBitbucketFetch())

    expect(picked?.jira_key).toBe('KAZ-1')
  })

  it('does not count toward give-up', () => {
    recordAttempt(db, attempt({ task_id: 't1', jira_key: 'KAZ-1', status: 'usage_limit' }))

    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(0)
  })
})
