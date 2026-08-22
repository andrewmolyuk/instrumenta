import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db/index.mts'
import { pickSpecific } from '../src/foreman/pick.mts'
import type { BitbucketConfig } from '../src/bitbucket/closed-prs.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

const BITBUCKET: BitbucketConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

function fakeBitbucketFetch(declinedCounts: Record<string, number>, openCounts: Record<string, number> = {}) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
    const state = q.match(/state="([^"]+)"/)?.[1] ?? ''
    const counts = state === 'OPEN' ? openCounts : declinedCounts
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size: counts[key] ?? 0 }) }
  }) as unknown as typeof fetch
}

function fakeTaskProvider(items: BacklogItem[]): TaskProvider {
  return { listBacklog: async () => items }
}

const BACKLOG: BacklogItem[] = [
  { jira_key: 'KAZ-1', summary: 'first in priority order' },
  { jira_key: 'KAZ-2', summary: 'requested out of order' },
]

describe('pickSpecific', () => {
  it('returns the requested key even though it is not first in the backlog', async () => {
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), BITBUCKET, 'KAZ-2', fakeBitbucketFetch({}))
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('returns null when the key is not in the live backlog', async () => {
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), BITBUCKET, 'KAZ-999', fakeBitbucketFetch({}))
    expect(result).toBeNull()
  })

  it('returns a key that automatic Pick has given up on — naming it is the override', async () => {
    // A declined PR retires a ticket for automatic Pick, and deleteAttempts
    // cannot clear that (it only reaches SQLite). Queueing by name is the only
    // way back, so it must not re-apply the verdict it exists to overrule.
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), BITBUCKET, 'KAZ-2', fakeBitbucketFetch({ 'KAZ-2': 3 }))
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('still returns null when the key has an open PR, approved or not', async () => {
    // Not a verdict on the work — a collision. Approval is a participant flag
    // in Bitbucket, not a state, so an approved-but-unmerged PR is still OPEN
    // and lands here too.
    const result = await pickSpecific(
      db,
      fakeTaskProvider(BACKLOG),
      BITBUCKET,
      'KAZ-2',
      fakeBitbucketFetch({ 'KAZ-2': 3 }, { 'KAZ-2': 1 }),
    )
    expect(result).toBeNull()
  })

  it('returns null when the requested key already has an open PR (ADR-007)', async () => {
    const result = await pickSpecific(
      db,
      fakeTaskProvider(BACKLOG),
      BITBUCKET,
      'KAZ-2',
      fakeBitbucketFetch({}, { 'KAZ-2': 1 }),
    )
    expect(result).toBeNull()
  })
})
