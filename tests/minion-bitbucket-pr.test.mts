import { describe, expect, it, vi } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { buildCloneUrl, createPullRequest, type BitbucketPrConfig } from '../minion/bitbucket-pr.mts'
import type { JiraTicket } from '../minion/jira.mts'

const CONFIG: BitbucketPrConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }
const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', attempt_number: 1 }
const TICKET: JiraTicket = { summary: 'Fix the thing', description: 'Fix the thing', attachments: [] }
const REPORT = '## What changed\n\nRewrote the pager.'

function fakeFetch(body: unknown, ok = true, status = 201) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'Created' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }))
}

describe('buildCloneUrl', () => {
  it('builds an x-token-auth HTTPS clone URL from workspace/repoSlug/token', () => {
    expect(buildCloneUrl(CONFIG)).toBe('https://x-token-auth:bb-token@bitbucket.org/andrewmolyuk/target-project.git')
  })
})

describe('createPullRequest', () => {
  it('posts to the repo pullrequests endpoint with source/destination/title/description', async () => {
    const fetchImpl = fakeFetch({
      links: { html: { href: 'https://bitbucket.org/andrewmolyuk/target-project/pull-requests/7' } },
    })
    const url = await createPullRequest(CONFIG, 'KAZ-1', INPUT, TICKET, REPORT, fetchImpl as unknown as typeof fetch)

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
      // The agent's own report plus a link back to the ticket.
      description: expect.stringContaining(REPORT),
    })
  })

  it('uses a configured base branch when given', async () => {
    const fetchImpl = fakeFetch({ links: { html: { href: 'https://x/pr/1' } } })
    await createPullRequest({ ...CONFIG, base: 'develop' }, 'KAZ-1', INPUT, TICKET, REPORT, fetchImpl as unknown as typeof fetch)
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    expect(JSON.parse(call[1].body as string).destination.branch.name).toBe('develop')
  })

  it('includes reviewers by uuid when configured', async () => {
    const fetchImpl = fakeFetch({ links: { html: { href: 'https://x/pr/1' } } })
    await createPullRequest(
      { ...CONFIG, reviewers: ['{uuid-1}', '{uuid-2}'] },
      'KAZ-1',
      INPUT,
      TICKET,
      REPORT,
      fetchImpl as unknown as typeof fetch,
    )
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const body = JSON.parse(call[1].body as string)
    expect(body.reviewers).toEqual([{ uuid: '{uuid-1}' }, { uuid: '{uuid-2}' }])
  })

  it('omits the reviewers field entirely when none are configured', async () => {
    const fetchImpl = fakeFetch({ links: { html: { href: 'https://x/pr/1' } } })
    await createPullRequest(CONFIG, 'KAZ-1', INPUT, TICKET, REPORT, fetchImpl as unknown as typeof fetch)
    const call = fetchImpl.mock.calls[0]
    if (!call) throw new Error('fetch was not called')
    const body = JSON.parse(call[1].body as string)
    expect(body).not.toHaveProperty('reviewers')
  })

  it('throws on a non-ok response, including the response body so the real reason is visible', async () => {
    const fetchImpl = fakeFetch({ error: { message: 'destination: branch not found: main' } }, false, 400)
    await expect(
      createPullRequest(CONFIG, 'KAZ-1', INPUT, TICKET, REPORT, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/Bitbucket PR creation failed: 400.*destination: branch not found: main/s)
  })
})
