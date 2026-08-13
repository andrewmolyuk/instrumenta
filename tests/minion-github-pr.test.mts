import { describe, expect, it, vi } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { createPullRequest, type GitHubPrConfig } from '../minion/github-pr.mts'

const CONFIG: GitHubPrConfig = { owner: 'andrewmolyuk', repo: 'target-project', token: 'gh-token' }
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
  it('posts to the repo pulls endpoint with head/base/title/body', async () => {
    const fetchImpl = fakeFetch({ html_url: 'https://github.com/andrewmolyuk/target-project/pull/7' })
    const url = await createPullRequest(CONFIG, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch)

    expect(url).toBe('https://github.com/andrewmolyuk/target-project/pull/7')
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const [reqUrl, init] = call
    expect(reqUrl).toBe('https://api.github.com/repos/andrewmolyuk/target-project/pulls')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ title: 'KAZ-1: Fix the thing', head: 'KAZ-1', base: 'main', body: 'Fix the thing' })
  })

  it('uses a configured base branch when given', async () => {
    const fetchImpl = fakeFetch({ html_url: 'https://x/pull/1' })
    await createPullRequest({ ...CONFIG, base: 'develop' }, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch)
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    expect(JSON.parse(call[1].body as string).base).toBe('develop')
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 422)
    await expect(
      createPullRequest(CONFIG, 'KAZ-1', INPUT, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('GitHub PR creation failed: 422')
  })
})
