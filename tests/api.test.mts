import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import type { BitbucketConfig } from '../src/bitbucket/closed-prs.mts'
import { openDb } from '../src/db/index.mts'
import {
  getBudget,
  getBudgetTotal,
  getQueueTicket,
  isStopped,
  recordAttempt,
  setBudget,
  setBudgetTotal,
  setCurrentTask,
  setQueueTicket,
  setStopped,
} from '../src/db/queries.mts'
import { createApiHandler } from '../src/foreman/api.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

let db: Database
let taskProvider: TaskProvider
let handler: (req: Request) => Promise<Response>

const BACKLOG: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 'do the thing', description: '' }]
const BITBUCKET: BitbucketConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }

function fakeBitbucketFetch(counts: Record<string, number> = {}) {
  return vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const key = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size: counts[key] ?? 0 }) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  db = openDb(':memory:')
  taskProvider = { listBacklog: async () => BACKLOG }
  handler = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fakeBitbucketFetch() })
})

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('GET /', () => {
  it('serves the Web UI as HTML', async () => {
    const res = await handler(req('GET', '/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('<title>Foreman</title>')
    expect(body).toContain('/api/status')
    expect(body).toContain('/api/stop')
    expect(body).toContain('/api/start')
    expect(body).toContain('/api/queue-ticket')
    expect(body).toContain('/api/budget')
    expect(body).toContain('/api/delete-attempts')
  })
})

describe('GET /api/status', () => {
  it('reports stopped, budget, budgetTotal, queueTicket, current, the live queue, and history', async () => {
    setBudget(db, 5)
    setBudgetTotal(db, 10)
    setQueueTicket(db, 'KAZ-2')
    setCurrentTask(db, { jira_key: 'KAZ-1', dispatched_at: '2026-08-14T00:00:00Z' })
    recordAttempt(db, {
      task_id: 't1',
      jira_key: 'KAZ-1',
      attempt_number: 1,
      status: 'success',
      pr_url: 'https://x/pr/1',
      dispatched_at: '2026-08-13T00:00:00Z',
      finished_at: '2026-08-13T00:05:00Z',
    })

    const res = await handler(req('GET', '/api/status'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stopped: boolean
      budget: number | null
      budgetTotal: number | null
      queueTicket: string | null
      current: { jira_key: string; dispatched_at: string } | null
      queue: BacklogItem[]
      history: Array<{ jira_key: string }>
    }
    expect(body.stopped).toBe(false)
    expect(body.budget).toBe(5)
    expect(body.budgetTotal).toBe(10)
    expect(body.queueTicket).toBe('KAZ-2')
    expect(body.current).toEqual({ jira_key: 'KAZ-1', dispatched_at: '2026-08-14T00:00:00Z' })
    expect(body.queue).toEqual(BACKLOG)
    expect(body.history).toHaveLength(1)
    expect(body.history[0]?.jira_key).toBe('KAZ-1')
  })

  it('returns the rest of the status with an empty queue when the Task Provider fails', async () => {
    const failingHandler = createApiHandler({
      db,
      taskProvider: { listBacklog: () => Promise.reject(new Error('Jira unreachable')) },
      bitbucket: BITBUCKET,
    })

    const res = await failingHandler(req('GET', '/api/status'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stopped: boolean; queue: unknown[]; queueError?: string }
    expect(body.stopped).toBe(false)
    expect(body.queue).toEqual([])
    expect(body.queueError).toBe('Jira unreachable')
  })
})

describe('POST /api/stop', () => {
  it('sets stopped', async () => {
    const res = await handler(req('POST', '/api/stop'))
    expect(res.status).toBe(200)
    expect(isStopped(db)).toBe(true)
  })
})

describe('POST /api/start', () => {
  it('clears stopped', async () => {
    setStopped(db, true)
    const res = await handler(req('POST', '/api/start'))
    expect(res.status).toBe(200)
    expect(isStopped(db)).toBe(false)
  })
})

describe('POST /api/queue-ticket', () => {
  it('sets queue_ticket to the given jiraKey when it is in the live backlog', async () => {
    const res = await handler(req('POST', '/api/queue-ticket', { jiraKey: 'KAZ-1' }))
    expect(res.status).toBe(200)
    expect(getQueueTicket(db)).toBe('KAZ-1')
  })

  it('rejects a missing jiraKey', async () => {
    const res = await handler(req('POST', '/api/queue-ticket', {}))
    expect(res.status).toBe(400)
    expect(getQueueTicket(db)).toBeNull()
  })

  it('rejects a non-string jiraKey', async () => {
    const res = await handler(req('POST', '/api/queue-ticket', { jiraKey: 42 }))
    expect(res.status).toBe(400)
  })

  it('rejects a jiraKey not in the live backlog with a visible error', async () => {
    const res = await handler(req('POST', '/api/queue-ticket', { jiraKey: 'KAZ-999' }))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('KAZ-999')
    expect(getQueueTicket(db)).toBeNull()
  })

  it('rejects a jiraKey that has already been given up on', async () => {
    const givenUpHandler = createApiHandler({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      fetchImpl: fakeBitbucketFetch({ 'KAZ-1': 3 }),
    })
    const res = await givenUpHandler(req('POST', '/api/queue-ticket', { jiraKey: 'KAZ-1' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('KAZ-1')
    expect(getQueueTicket(db)).toBeNull()
  })
})

describe('POST /api/budget', () => {
  it('sets a numeric budget, also setting budgetTotal to the same value', async () => {
    const res = await handler(req('POST', '/api/budget', { budget: 3 }))
    expect(res.status).toBe(200)
    expect(getBudget(db)).toBe(3)
    expect(getBudgetTotal(db)).toBe(3)
  })

  it('accepts null to mean unlimited, clearing budgetTotal too', async () => {
    setBudget(db, 3)
    setBudgetTotal(db, 3)
    const res = await handler(req('POST', '/api/budget', { budget: null }))
    expect(res.status).toBe(200)
    expect(getBudget(db)).toBeNull()
    expect(getBudgetTotal(db)).toBeNull()
  })

  it('resets budgetTotal to the new value, discarding a previous run\'s progress', async () => {
    setBudget(db, 1)
    setBudgetTotal(db, 5)
    const res = await handler(req('POST', '/api/budget', { budget: 10 }))
    expect(res.status).toBe(200)
    expect(getBudget(db)).toBe(10)
    expect(getBudgetTotal(db)).toBe(10)
  })

  it('rejects a non-numeric, non-null budget', async () => {
    const res = await handler(req('POST', '/api/budget', { budget: 'lots' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/delete-attempts', () => {
  it('deletes recorded attempts for the given jiraKey and reports how many', async () => {
    recordAttempt(db, {
      task_id: 't1',
      jira_key: 'KAZ-1',
      attempt_number: 1,
      status: 'crashed',
      pr_url: null,
      dispatched_at: '2026-08-13T00:00:00Z',
      finished_at: '2026-08-13T00:01:00Z',
    })
    recordAttempt(db, {
      task_id: 't2',
      jira_key: 'KAZ-1',
      attempt_number: 2,
      status: 'crashed',
      pr_url: null,
      dispatched_at: '2026-08-13T00:02:00Z',
      finished_at: '2026-08-13T00:03:00Z',
    })

    const res = await handler(req('POST', '/api/delete-attempts', { jiraKey: 'KAZ-1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { jiraKey: string; deleted: number }
    expect(body).toEqual({ jiraKey: 'KAZ-1', deleted: 2 })

    const status = await handler(req('GET', '/api/status'))
    const statusBody = (await status.json()) as { history: unknown[] }
    expect(statusBody.history).toEqual([])
  })

  it('reports 0 deleted when the jiraKey has no recorded attempts', async () => {
    const res = await handler(req('POST', '/api/delete-attempts', { jiraKey: 'KAZ-999' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { jiraKey: string; deleted: number }
    expect(body).toEqual({ jiraKey: 'KAZ-999', deleted: 0 })
  })

  it('rejects a missing jiraKey', async () => {
    const res = await handler(req('POST', '/api/delete-attempts', {}))
    expect(res.status).toBe(400)
  })

  it('rejects a non-string jiraKey', async () => {
    const res = await handler(req('POST', '/api/delete-attempts', { jiraKey: 42 }))
    expect(res.status).toBe(400)
  })
})

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await handler(req('GET', '/api/nope'))
    expect(res.status).toBe(404)
  })
})
