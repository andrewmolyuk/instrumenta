import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import type { BitbucketConfig } from '../src/bitbucket/closed-prs.mts'
import { openDb } from '../src/db/index.mts'
import {
  appendCurrentProgress,
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
import type { ForemanConfig } from '../src/foreman/config.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

let db: Database
let taskProvider: TaskProvider
let handler: (req: Request) => Promise<Response>

const BACKLOG: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 'do the thing' }]
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
    expect(body).toContain('<title>Instrumenta</title>')
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
      output: null,
      cost_usd: null, session: null,
      summary: null,
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
    expect(body.current).toEqual({
      jira_key: 'KAZ-1',
      summary: null,
      dispatched_at: '2026-08-14T00:00:00Z',
      output: null,
      cost_usd: null,
    })
    expect(body.queue).toEqual(BACKLOG)
    expect(body.history).toHaveLength(1)
    expect(body.history[0]?.jira_key).toBe('KAZ-1')
  })

  it("reports the in-flight task's title and Minion's live cost and output tail", async () => {
    setCurrentTask(db, {
      jira_key: 'KAZ-1',
      summary: 'Fix pagination on the device list',
      dispatched_at: '2026-08-14T00:00:00Z',
    })
    appendCurrentProgress(db, { line: 'Read: src/foo.ts', cost_usd: 0.5 })
    appendCurrentProgress(db, { line: 'Bash: npm run lint', cost_usd: 1.83 })

    const res = await handler(new Request('http://x/api/status'))
    const body = (await res.json()) as { current: { summary: string; cost_usd: number; output: string } }

    expect(body.current.summary).toBe('Fix pagination on the device list')
    expect(body.current.cost_usd).toBe(1.83)
    expect(body.current.output).toBe('Read: src/foo.ts\nBash: npm run lint')
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

  it('refills an exhausted budget from budgetTotal, so Start means another full run', async () => {
    setStopped(db, true)
    setBudget(db, 0)
    setBudgetTotal(db, 3)

    const res = await handler(req('POST', '/api/start'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stopped: false, budget: 3, budgetRefilled: true })
    expect(getBudget(db)).toBe(3)
    expect(getBudgetTotal(db)).toBe(3)
  })

  it('leaves a budget with capacity left alone', async () => {
    setStopped(db, true)
    setBudget(db, 2)
    setBudgetTotal(db, 3)

    const res = await handler(req('POST', '/api/start'))
    expect(await res.json()).toEqual({ stopped: false, budget: 2, budgetRefilled: false })
  })

  it('leaves an unlimited budget unlimited', async () => {
    setStopped(db, true)
    const res = await handler(req('POST', '/api/start'))
    expect(await res.json()).toEqual({ stopped: false, budget: null, budgetRefilled: false })
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

  it.each([0, -1, 2.5])('rejects %s — "no budget" is null, not a non-positive number', async (budget) => {
    setBudget(db, 4)
    setBudgetTotal(db, 4)
    const res = await handler(req('POST', '/api/budget', { budget }))
    expect(res.status).toBe(400)
    expect(getBudget(db)).toBe(4)
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
      output: null,
      cost_usd: null, session: null,
      summary: null,
      dispatched_at: '2026-08-13T00:00:00Z',
      finished_at: '2026-08-13T00:01:00Z',
    })
    recordAttempt(db, {
      task_id: 't2',
      jira_key: 'KAZ-1',
      attempt_number: 2,
      status: 'crashed',
      pr_url: null,
      output: null,
      cost_usd: null, session: null,
      summary: null,
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

describe('GET /api/status totals', () => {
  it('counts every attempt, not just the ones the capped history returned', async () => {
    // The reason totals are computed in SQL rather than summed from `history`:
    // that list is capped (default 50), so a card built from it would stop
    // growing at the cap and disagree with the Attempts tab.
    handler = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fakeBitbucketFetch(), historyLimit: 1 })
    for (const [i, cost] of [2.2, 0.8, 5].entries()) {
      recordAttempt(db, {
        task_id: 't' + i, jira_key: 'KAZ-' + i, attempt_number: 1, status: 'success', pr_url: null,
        output: null, cost_usd: cost, session: null, summary: null,
        dispatched_at: '2026-08-23T0' + i + ':00:00Z', finished_at: '2026-08-23T0' + i + ':10:00Z',
      })
    }

    const body = (await (await handler(req('GET', '/api/status'))).json()) as {
      history: unknown[]
      totals: { attempts: number; costTotal: number; costCount: number; durationCount: number }
    }

    expect(body.history).toHaveLength(1)
    expect(body.totals.attempts).toBe(3)
    expect(body.totals.costTotal).toBeCloseTo(8)
    expect(body.totals.costCount).toBe(3)
    expect(body.totals.durationCount).toBe(3)
  })
})

describe('GET /api/attempts and live PR state', () => {
  const PR = {
    values: [
      { state: 'OPEN', source: { branch: { name: 'KAZ-1' } }, participants: [{ approved: true }] },
      { state: 'DECLINED', source: { branch: { name: 'KAZ-1' } }, participants: [] },
    ],
  }

  function bitbucketFetch() {
    return vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => PR }))
  }

  function attempt(taskId: string, jiraKey: string) {
    return {
      task_id: taskId, jira_key: jiraKey, attempt_number: 1, status: 'success' as const,
      pr_url: 'https://bitbucket.org/o/r/pull-requests/1', output: null, cost_usd: null,
      session: null, summary: null, dispatched_at: '2026-08-24T00:00:00Z', finished_at: '2026-08-24T00:10:00Z',
    }
  }

  it('reports the most decisive state per branch, and flags an approval', async () => {
    const fetchImpl = bitbucketFetch()
    handler = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fetchImpl as unknown as typeof fetch })
    recordAttempt(db, attempt('t1', 'KAZ-1'))

    const body = (await (await handler(req('GET', '/api/attempts'))).json()) as {
      prStatus: Record<string, { state: string; approved: boolean }>
      prStatusAt?: string
    }

    expect(body.prStatus['KAZ-1']).toEqual({ state: 'OPEN', approved: true })
    expect(body.prStatusAt).toBeDefined()
  })

  it('reuses the cached state instead of asking Bitbucket on every five-second poll', async () => {
    let now = 1_000_000
    const fetchImpl = bitbucketFetch()
    handler = createApiHandler({
      db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now,
    })
    recordAttempt(db, attempt('t1', 'KAZ-1'))

    await handler(req('GET', '/api/attempts'))
    now += 60_000
    await handler(req('GET', '/api/attempts'))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the five minutes are up', async () => {
    let now = 1_000_000
    const fetchImpl = bitbucketFetch()
    handler = createApiHandler({
      db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now,
    })
    recordAttempt(db, attempt('t1', 'KAZ-1'))

    await handler(req('GET', '/api/attempts'))
    now += 300_001
    await handler(req('GET', '/api/attempts'))

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('re-reads on demand, which is what the page button asks for', async () => {
    const fetchImpl = bitbucketFetch()
    handler = createApiHandler({
      db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000_000,
    })
    recordAttempt(db, attempt('t1', 'KAZ-1'))

    await handler(req('GET', '/api/attempts'))
    await handler(req('GET', '/api/attempts?refreshPrStatus=1'))

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('re-reads when a new attempt appears rather than leaving its column blank', async () => {
    const fetchImpl = bitbucketFetch()
    handler = createApiHandler({
      db, taskProvider, bitbucket: BITBUCKET, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000_000,
    })
    recordAttempt(db, attempt('t1', 'KAZ-1'))
    await handler(req('GET', '/api/attempts'))

    recordAttempt(db, attempt('t2', 'KAZ-2'))
    await handler(req('GET', '/api/attempts'))

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('still returns the attempts when Bitbucket is unreachable, and says why', async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }))
    handler = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, fetchImpl: failing as unknown as typeof fetch })
    recordAttempt(db, attempt('t1', 'KAZ-1'))

    const res = await handler(req('GET', '/api/attempts'))
    const body = (await res.json()) as { attempts: unknown[]; prStatus: Record<string, unknown>; prStatusError?: string }

    expect(res.status).toBe(200)
    expect(body.attempts).toHaveLength(1)
    expect(body.prStatus).toEqual({})
    expect(body.prStatusError).toContain('503')
  })

  it('keeps serving the last good state when a later read fails', async () => {
    let ok = true
    let now = 1_000_000
    const flaky = vi.fn(async () =>
      ok
        ? { ok: true, status: 200, statusText: 'OK', json: async () => PR }
        : { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) },
    )
    handler = createApiHandler({
      db, taskProvider, bitbucket: BITBUCKET, fetchImpl: flaky as unknown as typeof fetch, now: () => now,
    })
    recordAttempt(db, attempt('t1', 'KAZ-1'))
    await handler(req('GET', '/api/attempts'))

    ok = false
    now += 300_001
    const body = (await (await handler(req('GET', '/api/attempts'))).json()) as {
      prStatus: Record<string, { state: string }>
      prStatusError?: string
    }

    expect(body.prStatus['KAZ-1']?.state).toBe('OPEN')
    expect(body.prStatusError).toContain('503')
  })
})

describe('GET /api/attempts', () => {
  it('returns every attempt, past the 50 that /api/status caps at', async () => {
    // The bug this endpoint exists for: the Attempts tab rendered
    // /api/status's `history`, so it showed 50 rows and no more — and its
    // "N attempts · $X total" summary was computed from that same slice, so
    // both the count and the cost were quietly wrong.
    for (let i = 1; i <= 60; i++) {
      recordAttempt(db, {
        task_id: 't' + i,
        jira_key: 'KAZ-' + i,
        attempt_number: 1,
        status: 'success',
        pr_url: null,
        output: null,
        cost_usd: 1, session: null,
        summary: null,
        dispatched_at: '2026-08-' + String((i % 28) + 1).padStart(2, '0') + 'T00:00:00Z',
        finished_at: null,
      })
    }

    const statusBody = (await (await handler(new Request('http://x/api/status'))).json()) as {
      history: unknown[]
    }
    const attemptsBody = (await (await handler(new Request('http://x/api/attempts'))).json()) as {
      attempts: unknown[]
    }

    expect(statusBody.history).toHaveLength(50)
    expect(attemptsBody.attempts).toHaveLength(60)
  })

  it('returns an empty list rather than failing when nothing has been attempted', async () => {
    const res = await handler(new Request('http://x/api/attempts'))
    expect(res.status).toBe(200)
    // Not an exact shape: the response also carries the timestamp of the PR-state
    // read, which is a clock value and not what this test is about.
    expect(await res.json()).toMatchObject({ attempts: [], prStatus: {} })
  })

  it('orders most recent first, like the history it replaces', async () => {
    recordAttempt(db, {
      task_id: 'old', jira_key: 'KAZ-1', attempt_number: 1, status: 'success', pr_url: null,
      output: null, cost_usd: null, session: null, summary: null, dispatched_at: '2026-08-01T00:00:00Z', finished_at: null,
    })
    recordAttempt(db, {
      task_id: 'new', jira_key: 'KAZ-2', attempt_number: 1, status: 'success', pr_url: null,
      output: null, cost_usd: null, session: null, summary: null, dispatched_at: '2026-08-20T00:00:00Z', finished_at: null,
    })

    const body = (await (await handler(new Request('http://x/api/attempts'))).json()) as {
      attempts: Array<{ task_id: string }>
    }
    expect(body.attempts.map((a) => a.task_id)).toEqual(['new', 'old'])
  })
})

describe('GET /api/config', () => {
  const CONFIG: ForemanConfig = {
    dbPath: '/data/foreman.db',
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.io', apiToken: 'secret-jira-token', jql: 'project = PLAT' },
    jiraAuth: { baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.io', apiToken: 'secret-jira-token' },
    bitbucket: BITBUCKET,
    minionCommand: ['docker', 'run', '--rm', 'minion:latest'],
    timeoutMs: 600_000,
    pollIntervalMs: 60_000,
    apiPort: 3000,
  }

  it('returns an allowlisted, secret-free subset of the config', async () => {
    const withConfig = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, config: CONFIG })
    const res = await withConfig(req('GET', '/api/config'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      dbPath: '/data/foreman.db',
      jira: { baseUrl: 'https://acme.atlassian.net', jql: 'project = PLAT', email: 'bot@acme.io' },
      bitbucket: { workspace: BITBUCKET.workspace, repoSlug: BITBUCKET.repoSlug },
      minionCommand: ['docker', 'run', '--rm', 'minion:latest'],
      timeoutMs: 600_000,
      pollIntervalMs: 60_000,
      apiPort: 3000,
    })
  })

  it('never includes jiraAuth.apiToken or bitbucket.token', async () => {
    const withConfig = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, config: CONFIG })
    const res = await withConfig(req('GET', '/api/config'))
    const text = await res.text()
    expect(text).not.toContain('secret-jira-token')
    expect(text).not.toContain(BITBUCKET.token)
  })

  it('404s when no config was supplied', async () => {
    const res = await handler(req('GET', '/api/config'))
    expect(res.status).toBe(404)
  })
})

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await handler(req('GET', '/api/nope'))
    expect(res.status).toBe(404)
  })
})

describe('queue filtering by PR state', () => {
  /** Answers both shapes: the bulk sweep (values) and a single-branch check (size). */
  function bitbucketWith(blockedBranches: string[]) {
    return vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get('q') ?? ''
      const branch = q.match(/source\.branch\.name="([^"]+)"/)?.[1]
      if (branch) {
        const blocking = /state="OPEN" OR state="MERGED"/.test(q)
        const size = blocking && blockedBranches.includes(branch) ? 1 : 0
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size }) }
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ values: blockedBranches.map((b) => ({ source: { branch: { name: b } } })) }),
      }
    }) as unknown as typeof fetch
  }

  const twoTickets: TaskProvider = {
    listBacklog: async () => [
      { jira_key: 'KAZ-1', summary: 'do the thing' },
      { jira_key: 'KAZ-2', summary: 'do the other thing' },
    ],
  }

  function handlerFor(fetchImpl: typeof fetch, now?: () => number) {
    return createApiHandler({ db, taskProvider: twoTickets, bitbucket: BITBUCKET, fetchImpl, now })
  }

  async function queueKeys(h: ReturnType<typeof createApiHandler>): Promise<string[]> {
    const body = (await (await h(req('GET', '/api/status'))).json()) as { queue: Array<{ jira_key: string }> }
    return body.queue.map((i) => i.jira_key)
  }

  it('hides tickets whose branch already has an open or merged PR', async () => {
    const h = handlerFor(bitbucketWith(['KAZ-1']))
    expect(await queueKeys(h)).toEqual(['KAZ-2'])
  })

  it('leaves the queue alone when nothing is blocked', async () => {
    const h = handlerFor(bitbucketWith([]))
    expect(await queueKeys(h)).toEqual(['KAZ-1', 'KAZ-2'])
  })

  it('sweeps Bitbucket once a minute, not once a poll', async () => {
    // The UI polls every five seconds; re-listing every PR in the repo that
    // often would be hundreds of requests a minute.
    let clock = 1_000_000
    const fetchImpl = bitbucketWith(['KAZ-1'])
    const h = handlerFor(fetchImpl, () => clock)

    await queueKeys(h)
    const afterFirst = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    clock += 5_000
    await queueKeys(h)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(afterFirst)

    clock += 60_000
    expect(await queueKeys(h)).toEqual(['KAZ-2'])
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(afterFirst)
  })
})

describe('POST /api/queue-ticket and PR state', () => {
  function bitbucketWith(blockedBranches: string[], declined: Record<string, number> = {}) {
    return vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get('q') ?? ''
      const branch = q.match(/source\.branch\.name="([^"]+)"/)?.[1] ?? ''
      if (/state="DECLINED"/.test(q)) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size: declined[branch] ?? 0 }) }
      }
      const size = blockedBranches.includes(branch) ? 1 : 0
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ size, values: [] }) }
    }) as unknown as typeof fetch
  }

  it('refuses a ticket whose branch has an open or merged PR', async () => {
    const h = createApiHandler({ db, taskProvider, bitbucket: BITBUCKET, fetchImpl: bitbucketWith(['KAZ-1']) })
    const res = await h(req('POST', '/api/queue-ticket', { jiraKey: 'KAZ-1' }))

    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('open or merged PR')
  })

  it('accepts a ticket that was given up on — queueing by name is the override', async () => {
    // The reported dead end: a declined PR retired the ticket, delete-attempts
    // cannot clear the Bitbucket half, and queueing was refused too — so there
    // was no way to run it ever again.
    const h = createApiHandler({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      fetchImpl: bitbucketWith([], { 'KAZ-1': 5 }),
    })
    const res = await h(req('POST', '/api/queue-ticket', { jiraKey: 'KAZ-1' }))

    expect(res.status).toBe(200)
    expect(getQueueTicket(db)).toBe('KAZ-1')
  })
})

describe('backlog total', () => {
  it('reports the whole backlog, not the page listBacklog returned', async () => {
    // Jira's /search/jql carries no total at all — counting its issues yields
    // maxResults, which is how the Cockpit came to show "5 of 50" for a
    // backlog of 121.
    const provider: TaskProvider = {
      listBacklog: async () => Array.from({ length: 50 }, (_, i) => ({ jira_key: 'KAZ-' + i, summary: 's' })),
      backlogCount: async () => 121,
    }
    const h = createApiHandler({ db, taskProvider: provider, bitbucket: BITBUCKET, fetchImpl: fakeBitbucketFetch() })

    const body = (await (await h(req('GET', '/api/status'))).json()) as { queue: unknown[]; queueTotal?: number }
    expect(body.queue).toHaveLength(50)
    expect(body.queueTotal).toBe(121)
  })

  it('leaves the total out for a source that cannot count cheaply', async () => {
    // backlogCount is optional; the UI falls back to the page size.
    const body = (await (await handler(req('GET', '/api/status'))).json()) as { queueTotal?: number }
    expect(body.queueTotal).toBeUndefined()
  })
})
