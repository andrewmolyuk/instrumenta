import { describe, expect, it, vi } from 'vitest'
import { closedPrCountForBranch } from '../src/github/closed-prs.mts'

const CONFIG = { owner: 'andrewmolyuk', repo: 'target-project', token: 'gh-token' }

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  }))
}

describe('closedPrCountForBranch', () => {
  it('queries GitHub search with is:closed is:unmerged so merged PRs are excluded', async () => {
    const fetchImpl = fakeFetch({ total_count: 0 })
    await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)

    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [url] = call
    const q = new URL(url).searchParams.get('q')
    expect(q).toContain('repo:andrewmolyuk/target-project')
    expect(q).toContain('is:closed')
    expect(q).toContain('is:unmerged')
    expect(q).toContain('head:KAZ-1')
  })

  it('authenticates with a bearer token', async () => {
    const fetchImpl = fakeFetch({ total_count: 0 })
    await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)

    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [, init] = call
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gh-token')
  })

  it('returns total_count from the response', async () => {
    const fetchImpl = fakeFetch({ total_count: 2 })
    const count = await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)
    expect(count).toBe(2)
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 403)
    await expect(
      closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('GitHub search failed: 403')
  })
})
