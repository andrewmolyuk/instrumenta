import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import { recordAttempt } from '../src/db/queries.mts'
import { isGivenUp, pick } from '../src/foreman/pick.mts'
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
    dispatched_at: '2026-08-13T00:00:00Z',
    finished_at: '2026-08-13T00:05:00Z',
    ...overrides,
  }
}

/** Reads `source.branch.name="<key>"` out of the search query and returns that key's configured count. */
function fakeBitbucketFetch(counts: Record<string, number>) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const match = q.match(/source\.branch\.name="([^"]+)"/)
    const key = match?.[1] ?? ''
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
    recordAttempt(db, attempt({ status: 'crashed' }))
    const result = await isGivenUp(db, BITBUCKET, 'KAZ-1', fakeBitbucketFetch({ 'KAZ-1': 1 }))
    expect(result).toBe(false)
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
      { jira_key: 'KAZ-1', summary: 'first', description: '' },
      { jira_key: 'KAZ-2', summary: 'second', description: '' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({}))
    expect(result?.jira_key).toBe('KAZ-1')
  })

  it('skips a given-up task and returns the next eligible one', async () => {
    const backlog = [
      { jira_key: 'KAZ-1', summary: 'given up', description: '' },
      { jira_key: 'KAZ-2', summary: 'eligible', description: '' },
    ]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({ 'KAZ-1': 3 }))
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('returns null when every task is given up', async () => {
    const backlog = [{ jira_key: 'KAZ-1', summary: 'given up', description: '' }]
    const result = await pick(db, fakeTaskProvider(backlog), BITBUCKET, fakeBitbucketFetch({ 'KAZ-1': 3 }))
    expect(result).toBeNull()
  })

  it('returns null for an empty backlog', async () => {
    const result = await pick(db, fakeTaskProvider([]), BITBUCKET, fakeBitbucketFetch({}))
    expect(result).toBeNull()
  })
})
