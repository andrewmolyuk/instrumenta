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

function fakeBitbucketFetch(counts: Record<string, number>) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size: counts[key] ?? 0 }) }
  }) as unknown as typeof fetch
}

function fakeTaskProvider(items: BacklogItem[]): TaskProvider {
  return { listBacklog: async () => items }
}

const BACKLOG: BacklogItem[] = [
  { jira_key: 'KAZ-1', summary: 'first in priority order', description: '' },
  { jira_key: 'KAZ-2', summary: 'requested out of order', description: '' },
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

  it('returns null when the requested key is already given up', async () => {
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), BITBUCKET, 'KAZ-2', fakeBitbucketFetch({ 'KAZ-2': 3 }))
    expect(result).toBeNull()
  })
})
