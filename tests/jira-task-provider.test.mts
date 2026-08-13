import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { JiraTaskProvider } from '../src/task-provider/jira.mts'

const CONFIG = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: 'secret-token',
  jql: 'project = KAZ AND statusCategory != Done ORDER BY priority DESC',
}

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  }))
}

function provider(config: typeof CONFIG & { maxResults?: number }, fetchImpl: ReturnType<typeof fakeFetch>) {
  return new JiraTaskProvider(config, fetchImpl as unknown as typeof fetch)
}

function lastCall(fetchImpl: ReturnType<typeof fakeFetch>) {
  const call = fetchImpl.mock.calls[0]
  if (!call) throw new Error('fetch was not called')
  return call
}

describe('JiraTaskProvider', () => {
  it('hits /rest/api/3/search/jql, not the deprecated /rest/api/3/search', async () => {
    const fetchImpl = fakeFetch({ issues: [] })
    await provider(CONFIG, fetchImpl).listBacklog()

    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://example.atlassian.net/rest/api/3/search/jql')
    expect(init.method).toBe('POST')
  })

  it('authenticates with basic auth built from email:apiToken', async () => {
    const fetchImpl = fakeFetch({ issues: [] })
    await provider(CONFIG, fetchImpl).listBacklog()

    const [, init] = lastCall(fetchImpl)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('bot@example.com:secret-token').toString('base64')}`)
  })

  it('sends the configured jql and maxResults', async () => {
    const fetchImpl = fakeFetch({ issues: [] })
    await provider({ ...CONFIG, maxResults: 10 }, fetchImpl).listBacklog()

    const [, init] = lastCall(fetchImpl)
    const body = JSON.parse(init.body as string)
    expect(body.jql).toBe(CONFIG.jql)
    expect(body.maxResults).toBe(10)
  })

  it('defaults maxResults to 50 when not configured', async () => {
    const fetchImpl = fakeFetch({ issues: [] })
    await provider(CONFIG, fetchImpl).listBacklog()

    const [, init] = lastCall(fetchImpl)
    expect(JSON.parse(init.body as string).maxResults).toBe(50)
  })

  it('normalizes issues into BacklogItem shape, converting ADF descriptions to text', async () => {
    const fetchImpl = fakeFetch({
      issues: [
        {
          key: 'KAZ-42',
          fields: {
            summary: 'Fix the thing',
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Details here.' }] }],
            },
          },
        },
      ],
    })
    const backlog = await provider(CONFIG, fetchImpl).listBacklog()

    expect(backlog).toEqual([{ jira_key: 'KAZ-42', summary: 'Fix the thing', description: 'Details here.' }])
  })

  it('handles a null description', async () => {
    const fetchImpl = fakeFetch({
      issues: [{ key: 'KAZ-1', fields: { summary: 'No description', description: null } }],
    })
    const backlog = await provider(CONFIG, fetchImpl).listBacklog()

    expect(backlog[0]?.description).toBe('')
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = fakeFetch({}, false, 401)
    await expect(provider(CONFIG, fetchImpl).listBacklog()).rejects.toThrow('Jira search failed: 401')
  })
})
