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
 * Reads `source.branch.name="<key>"` and `state="<STATE>"` out of the search
 * query and returns that key+state's configured count — declined and open
 * are separate queries (closedPrCountForBranch vs. hasOpenPrForBranch), so
 * this has to distinguish them rather than keying on branch alone.
 */
function fakeBitbucketFetch(declinedCounts: Record<string, number>, openCounts: Record<string, number> = {}) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
    const state = q.match(/state="([^"]+)"/)?.[1] ?? ''
    const counts = state === 'OPEN' ? openCounts : declinedCounts
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ size: counts[key] ?? 0 }),
    }
  }) as unknown as typeof fetch
}

function fakeTaskProvider(items: BacklogItem[]): TaskProvider {
  return { listBacklog: async () => items }
}

describe('isGivenUp', () => {
  it('is false when both sources are below the threshold', async () => {
    // ADR-015 put the threshold at 1, so "below" is zero on both sides: no
    // recorded failure and no closed PR.
    const result = await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 0 }))
    expect(result).toBe(false)
  })

  it('is true from a single failed attempt, with no retry (ADR-015)', async () => {
    recordAttempt(db, attempt({ status: 'crashed' }))
    expect(await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 0 }))).toBe(true)
  })

  it('is true from a single closed PR — a human declined this work once', async () => {
    expect(await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 1 }))).toBe(true)
  })

  it('is true from SQLite alone, even with zero closed PRs', async () => {
    recordAttempt(db, attempt({ attempt_number: 1, status: 'crashed' }))
    recordAttempt(db, attempt({ attempt_number: 2, status: 'crashed' }))
    recordAttempt(db, attempt({ attempt_number: 3, status: 'crashed' }))
    const result = await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 0 }))
    expect(result).toBe(true)
  })

  it('is true from Bitbucket alone, even with zero SQLite attempts', async () => {
    const result = await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 3 }))
    expect(result).toBe(true)
  })
})

describe('pick', () => {
  it('returns the first backlog item that is not given up', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'first' },
      { jira_key: 'KAZ-2', summary: 'second' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({}))
    expect(result?.jira_key).toBe('KAZ-1')
  })

  it('skips a given-up task and returns the next eligible one', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'given up' },
      { jira_key: 'KAZ-2', summary: 'eligible' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({ 'KAZ-1': 3 }))
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('returns null when every task is given up', async () => {
    const backlog = [{ jira_key: 'KAZ-1', summary: 'given up' }]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({ 'KAZ-1': 3 }))
    expect(result).toBeNull()
  })

  it('returns null for an empty backlog', async () => {
    const result = await pick(db, fakeTaskProvider([]), BITBUCKET, fakeBitbucketFetch({}))
    expect(result).toBeNull()
  })

  it('skips a task with an open PR (ADR-007) and returns the next eligible one', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'already has an open PR' },
      { jira_key: 'KAZ-2', summary: 'eligible' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({}, { 'KAZ-1': 1 }))
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
      fakeBitbucketFetch({}),
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
