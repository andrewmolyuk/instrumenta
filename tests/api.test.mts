import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db/index.mts'
import { getBudget, getStartTicket, isStopped, recordAttempt, setBudget, setStartTicket, setStopped } from '../src/db/queries.mts'
import { createApiHandler } from '../src/foreman/api.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

let db: Database
let taskProvider: TaskProvider
let handler: (req: Request) => Promise<Response>

const BACKLOG: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 'do the thing', description: '' }]

beforeEach(() => {
  db = openDb(':memory:')
  taskProvider = { listBacklog: async () => BACKLOG }
  handler = createApiHandler({ db, taskProvider })
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
    expect(body).toContain('/api/continue')
    expect(body).toContain('/api/start')
    expect(body).toContain('/api/budget')
  })
})

describe('GET /api/status', () => {
  it('reports stopped, budget, startTicket, the live queue, and history', async () => {
    setBudget(db, 5)
    setStartTicket(db, 'KAZ-2')
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
      startTicket: string | null
      queue: BacklogItem[]
      history: Array<{ jira_key: string }>
    }
    expect(body.stopped).toBe(false)
    expect(body.budget).toBe(5)
    expect(body.startTicket).toBe('KAZ-2')
    expect(body.queue).toEqual(BACKLOG)
    expect(body.history).toHaveLength(1)
    expect(body.history[0]?.jira_key).toBe('KAZ-1')
  })

  it('returns the rest of the status with an empty queue when the Task Provider fails', async () => {
    const failingHandler = createApiHandler({
      db,
      taskProvider: { listBacklog: () => Promise.reject(new Error('Jira unreachable')) },
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

describe('POST /api/continue', () => {
  it('clears stopped', async () => {
    setStopped(db, true)
    const res = await handler(req('POST', '/api/continue'))
    expect(res.status).toBe(200)
    expect(isStopped(db)).toBe(false)
  })
})

describe('POST /api/start', () => {
  it('sets start_ticket to the given jiraKey', async () => {
    const res = await handler(req('POST', '/api/start', { jiraKey: 'KAZ-42' }))
    expect(res.status).toBe(200)
    expect(getStartTicket(db)).toBe('KAZ-42')
  })

  it('rejects a missing jiraKey', async () => {
    const res = await handler(req('POST', '/api/start', {}))
    expect(res.status).toBe(400)
    expect(getStartTicket(db)).toBeNull()
  })

  it('rejects a non-string jiraKey', async () => {
    const res = await handler(req('POST', '/api/start', { jiraKey: 42 }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/budget', () => {
  it('sets a numeric budget', async () => {
    const res = await handler(req('POST', '/api/budget', { budget: 3 }))
    expect(res.status).toBe(200)
    expect(getBudget(db)).toBe(3)
  })

  it('accepts null to mean unlimited', async () => {
    setBudget(db, 3)
    const res = await handler(req('POST', '/api/budget', { budget: null }))
    expect(res.status).toBe(200)
    expect(getBudget(db)).toBeNull()
  })

  it('rejects a non-numeric, non-null budget', async () => {
    const res = await handler(req('POST', '/api/budget', { budget: 'lots' }))
    expect(res.status).toBe(400)
  })
})

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await handler(req('GET', '/api/nope'))
    expect(res.status).toBe(404)
  })
})
