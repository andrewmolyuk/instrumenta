import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db/index.mts'
import { pickSpecific } from '../src/foreman/pick.mts'
import type { GitHubConfig } from '../src/github/closed-prs.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

const GITHUB: GitHubConfig = { owner: 'andrewmolyuk', repo: 'target-project', token: 'gh-token' }

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

function fakeGithubFetch(counts: Record<string, number>) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/head:(\S+)/)?.[1] ?? ''
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ total_count: counts[key] ?? 0 }) }
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
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), GITHUB, 'KAZ-2', fakeGithubFetch({}))
    expect(result?.jira_key).toBe('KAZ-2')
  })

  it('returns null when the key is not in the live backlog', async () => {
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), GITHUB, 'KAZ-999', fakeGithubFetch({}))
    expect(result).toBeNull()
  })

  it('returns null when the requested key is already given up', async () => {
    const result = await pickSpecific(db, fakeTaskProvider(BACKLOG), GITHUB, 'KAZ-2', fakeGithubFetch({ 'KAZ-2': 3 }))
    expect(result).toBeNull()
  })
})
