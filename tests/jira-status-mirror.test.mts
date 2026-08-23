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
    cost_usd: null,
  session: null,
    summary: null,
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

/**
 * Simulates a workflow whose GET response changes after each successful POST —
 * `transitionsByStep[n]` is what's available from wherever the issue lands after
 * the nth POST (`transitionsByStep[0]` is the starting status's transitions).
 */
function fakeFetchStateful(transitionsByStep: Array<typeof TRANSITIONS>) {
  const posted: Array<{ url: string; body: unknown }> = []
  let step = 0
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => transitionsByStep[step] }
    }
    posted.push({ url, body: JSON.parse(init.body as string) })
    step += 1
    return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}) }
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

    it('falls back through "Approved" when "In Progress" is not a direct transition', async () => {
      const { fn, posted } = fakeFetchStateful([
        // from "To Do": only "Approved" is reachable directly
        { transitions: [{ id: '11', to: { name: 'To Do' } }, { id: '15', to: { name: 'Approved' } }] },
        // from "Approved": "In Progress" is now reachable
        { transitions: [{ id: '15', to: { name: 'Approved' } }, { id: '21', to: { name: 'In Progress' } }] },
      ])
      await new JiraStatusMirror(CONFIG, fn).onDispatch('KAZ-1')

      expect(posted).toHaveLength(2)
      expect(posted[0]?.body).toEqual({ transition: { id: '15' } })
      expect(posted[1]?.body).toEqual({ transition: { id: '21' } })
    })
  })

  describe('onComplete', () => {
    it('does nothing on success (ADR-007) — Done is a human call after the PR is actually merged', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'success' }))
      expect(posted).toHaveLength(0)
    })

    it('does nothing for a non-success status', async () => {
      const { fn, posted } = fakeFetch()
      await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'failed_verify' }))
      expect(posted).toHaveLength(0)
    })
  })
})

describe('onComplete and a usage_limit attempt (ADR-017)', () => {
  it('walks the ticket back out of In Progress, so Pick can see it again', async () => {
    const { fn, posted } = fakeFetch()
    await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'usage_limit' }))

    expect(posted).toHaveLength(1)
    expect(posted[0]?.body).toEqual({ transition: { id: '11' } })
  })

  it('leaves every other status where onDispatch left it (ADR-007)', async () => {
    const { fn, posted } = fakeFetch()
    const mirror = new JiraStatusMirror(CONFIG, fn)
    await mirror.onComplete(row({ status: 'success' }))
    await mirror.onComplete(row({ status: 'no_change' }))
    await mirror.onComplete(row({ status: 'crashed' }))

    expect(posted).toHaveLength(0)
  })

  it('does nothing when the workflow offers no backlog status to go back to', async () => {
    const { fn, posted } = fakeFetch({ transitions: [{ id: '31', to: { name: 'Done' } }] })
    await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'usage_limit' }))

    expect(posted).toHaveLength(0)
  })

  it('takes the first backlog name the workflow actually offers', async () => {
    const { fn, posted } = fakeFetch({ transitions: [{ id: '41', to: { name: 'Backlog' } }] })
    await new JiraStatusMirror(CONFIG, fn).onComplete(row({ status: 'usage_limit' }))

    expect(posted[0]?.body).toEqual({ transition: { id: '41' } })
  })
})
