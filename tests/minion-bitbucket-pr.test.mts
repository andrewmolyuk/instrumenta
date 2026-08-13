import { describe, expect, it, vi } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { createPullRequest, type BitbucketPrConfig } from '../minion/bitbucket-pr.mts'

const CONFIG: BitbucketPrConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }
const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', description: 'Fix the thing', attempt_number: 1 }

function fakeFetch(body: unknown, ok = true, status = 201) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'Created' : 'Error',
    json: async () => body,
  }))
}

describe('createPullRequest', () => {
  it('posts to the repo pullrequests endpoint with source/destination/title/description', async () => {
    const fetchImpl = fakeFetch({
      links: { html: { href: 'https://bitbucket.org/andrewmolyuk/target-project/pull-requests/7' } },
    })
    const url = await createPullRequest(CONFIG, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch)

    expect(url).toBe('https://bitbucket.org/andrewmolyuk/target-project/pull-requests/7')
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [reqUrl, init] = call
    expect(reqUrl).toBe('https://api.bitbucket.org/2.0/repositories/andrewmolyuk/target-project/pullrequests')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      title: 'KAZ-1: Fix the thing',
      source: { branch: { name: 'KAZ-1' } },
      destination: { branch: { name: 'main' } },
      description: 'Fix the thing',
    })
  })

  it('uses a configured base branch when given', async () => {
    const fetchImpl = fakeFetch({ links: { html: { href: 'https://x/pr/1' } } })
    await createPullRequest({ ...CONFIG, base: 'develop' }, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch)
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    expect(JSON.parse(call[1].body as string).destination.branch.name).toBe('develop')
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 422)
    await expect(
      createPullRequest(CONFIG, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('Bitbucket PR creation failed: 422')
  })
})
