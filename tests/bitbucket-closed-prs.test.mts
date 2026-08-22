import { describe, expect, it, vi } from 'vitest'
import {
  branchesWithBlockingPr,
  closedPrCountForBranch,
  hasBlockingPrForBranch,
  hasOpenPrForBranch,
} from '../src/bitbucket/closed-prs.mts'

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

describe('request shape Bitbucket actually accepts', () => {
  /** Captures the URL each helper requests, so the query can be asserted. */
  function capturing() {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(String(url))
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size: 0, values: [] }) }
    }) as unknown as typeof fetch
    return { urls, fetchImpl }
  }

  it('never asks for more than 50 per page', async () => {
    // Bitbucket does not clamp an oversized pagelen, it answers
    // `400 Invalid pagelen` — which took /api/queue-ticket down live.
    const { urls, fetchImpl } = capturing()
    await hasBlockingPrForBranch(CONFIG, 'KAZ-1', fetchImpl)
    await branchesWithBlockingPr(CONFIG, fetchImpl)

    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(Number(new URL(url).searchParams.get('pagelen'))).toBeLessThanOrEqual(50)
    }
  })

  it('asks for open and merged, and never for declined', async () => {
    // Declined is the give-up signal, not a reason to refuse a run.
    const { urls, fetchImpl } = capturing()
    await hasBlockingPrForBranch(CONFIG, 'KAZ-1', fetchImpl)

    const q = new URL(urls[0]!).searchParams.get('q') ?? ''
    expect(q).toContain('state="OPEN"')
    expect(q).toContain('state="MERGED"')
    expect(q).not.toContain('DECLINED')
    expect(q).toContain('source.branch.name="KAZ-1"')
  })

  it('follows the next cursor when the sweep is paginated', async () => {
    const pages = [
      { values: [{ source: { branch: { name: 'KAZ-1' } } }], next: 'https://api.bitbucket.org/next-page' },
      { values: [{ source: { branch: { name: 'KAZ-2' } } }] },
    ]
    let i = 0
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => pages[i++],
    })) as unknown as typeof fetch

    expect(await branchesWithBlockingPr(CONFIG, fetchImpl)).toEqual(new Set(['KAZ-1', 'KAZ-2']))
  })
})
