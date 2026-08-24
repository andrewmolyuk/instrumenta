import { describe, expect, it, vi } from 'vitest'
import {
  branchesWithBlockingPr,
  hasBlockingPrForBranch,
  hasOpenPrForBranch,
  prStatusByBranch,
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

describe('prStatusByBranch', () => {
  /** One PR as the list endpoint returns it under the requested `fields`. */
  function pr(branch: string, state: string, approvals: boolean[] = []) {
    return { state, source: { branch: { name: branch } }, participants: approvals.map((approved) => ({ approved })) }
  }

  it('asks about many branches in one request, not one request per branch', async () => {
    const fetchImpl = fakeFetch({ values: [] })
    await prStatusByBranch(CONFIG, ['RPG-1', 'RPG-2', 'RPG-3'], fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const q = new URL(fetchImpl.mock.calls[0]![0]).searchParams.get('q')
    expect(q).toBe('source.branch.name="RPG-1" OR source.branch.name="RPG-2" OR source.branch.name="RPG-3"')
  })

  it('does not filter by state — declined and superseded are the point', async () => {
    const fetchImpl = fakeFetch({ values: [] })
    await prStatusByBranch(CONFIG, ['RPG-1'], fetchImpl as unknown as typeof fetch)

    const params = new URL(fetchImpl.mock.calls[0]![0]).searchParams
    expect(params.get('q')).not.toContain('state=')
    expect(params.get('fields')).toContain('values.state')
    expect(params.get('fields')).toContain('values.participants.approved')
  })

  it('reports each branch its state, and leaves out branches with no PR', async () => {
    const fetchImpl = fakeFetch({
      values: [pr('RPG-1', 'MERGED'), pr('RPG-2', 'DECLINED'), pr('RPG-3', 'SUPERSEDED')],
    })
    const byBranch = await prStatusByBranch(CONFIG, ['RPG-1', 'RPG-2', 'RPG-3', 'RPG-4'], fetchImpl as unknown as typeof fetch)

    expect(byBranch.get('RPG-1')).toEqual({ state: 'MERGED', approved: false })
    expect(byBranch.get('RPG-2')).toEqual({ state: 'DECLINED', approved: false })
    expect(byBranch.get('RPG-3')).toEqual({ state: 'SUPERSEDED', approved: false })
    expect(byBranch.has('RPG-4')).toBe(false)
  })

  it('flags an approval, which Bitbucket does not model as a state', async () => {
    const fetchImpl = fakeFetch({ values: [pr('RPG-1', 'OPEN', [false, true])] })
    const byBranch = await prStatusByBranch(CONFIG, ['RPG-1'], fetchImpl as unknown as typeof fetch)

    expect(byBranch.get('RPG-1')).toEqual({ state: 'OPEN', approved: true })
  })

  it('takes the most decisive PR when a branch has several', async () => {
    // A branch redispatched after a decline (ADR-016) ends up with both.
    const fetchImpl = fakeFetch({ values: [pr('RPG-1', 'DECLINED'), pr('RPG-1', 'MERGED')] })
    expect((await prStatusByBranch(CONFIG, ['RPG-1'], fetchImpl as unknown as typeof fetch)).get('RPG-1')?.state).toBe('MERGED')

    const reversed = fakeFetch({ values: [pr('RPG-2', 'MERGED'), pr('RPG-2', 'DECLINED')] })
    expect((await prStatusByBranch(CONFIG, ['RPG-2'], reversed as unknown as typeof fetch)).get('RPG-2')?.state).toBe('MERGED')
  })

  it('batches past 25 branches instead of building one enormous query', async () => {
    const branches = Array.from({ length: 60 }, (_, i) => 'RPG-' + i)
    const fetchImpl = fakeFetch({ values: [] })
    await prStatusByBranch(CONFIG, branches, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const terms = fetchImpl.mock.calls.map((c) => new URL(c[0]).searchParams.get('q')!.split(' OR ').length)
    expect(terms).toEqual([25, 25, 10])
  })

  it('asks each branch once even when an attempt is listed twice', async () => {
    const fetchImpl = fakeFetch({ values: [] })
    await prStatusByBranch(CONFIG, ['RPG-1', 'RPG-1', 'RPG-2'], fetchImpl as unknown as typeof fetch)

    const q = new URL(fetchImpl.mock.calls[0]![0]).searchParams.get('q')
    expect(q).toBe('source.branch.name="RPG-1" OR source.branch.name="RPG-2"')
  })

  it('follows pagination within a batch', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        call++ === 0
          ? { values: [pr('RPG-1', 'OPEN')], next: 'https://api.bitbucket.org/next-page' }
          : { values: [pr('RPG-2', 'MERGED')] },
    }))
    const byBranch = await prStatusByBranch(CONFIG, ['RPG-1', 'RPG-2'], fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(byBranch.get('RPG-2')?.state).toBe('MERGED')
  })

  it('makes no request at all when there are no attempts to ask about', async () => {
    const fetchImpl = fakeFetch({ values: [] })
    expect((await prStatusByBranch(CONFIG, [], fetchImpl as unknown as typeof fetch)).size).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when Bitbucket rejects the request', async () => {
    const fetchImpl = fakeFetch({}, false, 401)
    await expect(prStatusByBranch(CONFIG, ['RPG-1'], fetchImpl as unknown as typeof fetch)).rejects.toThrow(/401/)
  })
})
