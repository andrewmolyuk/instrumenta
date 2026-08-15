import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { TaskRow } from '../src/db/index.mts'
import { JiraStatusMirror } from '../src/foreman/jira-status-mirror.mts'

const CONFIG = { baseUrl: 'https://example.atlassian.net', email: 'bot@example.com', apiToken: 'secret-token' }

const TRANSITIONS = {
  transitions: [
    { id: '11', to: { name: 'To Do' } },
    { id: '21', to: { name: 'In Progress' } },
    { id: '31', to: { name: 'Done' } },
  ],
}

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: 't1',
    jira_key: 'KAZ-1',
    attempt_number: 1,
    status: 'success',
    pr_url: null,
    output: null,
    dispatched_at: '2026-08-13T00:00:00Z',
    finished_at: '2026-08-13T00:05:00Z',
    ...overrides,
  }
}

/** GET returns the transitions list; POST records the chosen transition id. */
function fakeFetch(transitions: typeof TRANSITIONS = TRANSITIONS, postOk = true) {
  const posted: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => transitions }
    }
    posted.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> })
    return { ok: postOk, status: postOk ? 204 : 400, statusText: postOk ? 'No Content' : 'Bad Request', json: async () => ({}) }
  })
  return { fn: fn as unknown as typeof fetch, posted }
}

describe('JiraStatusMirror', () => {
  describe('onDispatch', () => {
    it('transitions the issue to the transition whose target status is "In Progress"', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onDispatch('KAZ-1')

      expect(posted).toHaveLength(1)
      expect(posted[0]?.url).toBe('https://example.atlassian.net/rest/api/3/issue/KAZ-1/transitions')
      expect(posted[0]?.body).toEqual({ transition: { id: '21' } })
    })

    it('authenticates with basic auth', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onDispatch('KAZ-1')
      expect(posted[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('bot@example.com:secret-token').toString('base64')}`)
    })

    it('does nothing when the workflow has no "In Progress" status', async () => {
      const { fn, posted } = fakeFetch({ transitions: [{ id: '11', to: { name: 'To Do' } }] })
      await new JiraStatusMirror(CONFIG, fn).onDispatch('KAZ-1')
      expect(posted).toHaveLength(0)
    })

    it('throws when the transition POST fails', async () => {
      const { fn } = fakeFetch(TRANSITIONS, false)
      await expect(new JiraStatusMirror(CONFIG, fn).onDispatch('KAZ-1')).rejects.toThrow('Jira transition failed: 400')
    })
  })

  describe('onComplete', () => {
    it('transitions to "Done" on success', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'success' }))
      expect(posted[0]?.body).toEqual({ transition: { id: '31' } })
    })

    it('does nothing for a non-success status', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'failed_verify' }))
      expect(posted).toHaveLength(0)
    })
  })
})
