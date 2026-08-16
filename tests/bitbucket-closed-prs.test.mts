import { describe, expect, it, vi } from 'vitest'
import { closedPrCountForBranch, hasOpenPrForBranch } from '../src/bitbucket/closed-prs.mts'

const CONFIG = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  }))
}

describe('closedPrCountForBranch', () => {
  it('queries Bitbucket for DECLINED PRs on the given branch', async () => {
    const fetchImpl = fakeFetch({ size: 0 })
    await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)

    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [url] = call
    expect(url).toContain('/repositories/andrewmolyuk/target-project/pullrequests')
    const q = new URL(url).searchParams.get('q')
    expect(q).toContain('source.branch.name="KAZ-1"')
    expect(q).toContain('state="DECLINED"')
  })

  it('authenticates with a bearer token', async () => {
    const fetchImpl = fakeFetch({ size: 0 })
    await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)

    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [, init] = call
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bb-token')
  })

  it('returns size from the response', async () => {
    const fetchImpl = fakeFetch({ size: 2 })
    const count = await closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)
    expect(count).toBe(2)
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 403)
    await expect(
      closedPrCountForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('Bitbucket search failed: 403')
  })
})

describe('hasOpenPrForBranch', () => {
  it('queries Bitbucket for OPEN PRs on the given branch', async () => {
    const fetchImpl = fakeFetch({ size: 0 })
    await hasOpenPrForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)

    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [url] = call
    const q = new URL(url).searchParams.get('q')
    expect(q).toContain('source.branch.name="KAZ-1"')
    expect(q).toContain('state="OPEN"')
  })

  it('returns true when at least one open PR exists', async () => {
    const fetchImpl = fakeFetch({ size: 1 })
    expect(await hasOpenPrForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)).toBe(true)
  })

  it('returns false when there are none', async () => {
    const fetchImpl = fakeFetch({ size: 0 })
    expect(await hasOpenPrForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch)).toBe(false)
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 403)
    await expect(
      hasOpenPrForBranch(CONFIG, 'KAZ-1', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('Bitbucket search failed: 403')
  })
})
