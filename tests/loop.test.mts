import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import {
  type CurrentTask,
  getBudget,
  getCurrentTask,
  getStartTicket,
  isStopped,
  setBudget,
  setStartTicket,
  setStopped,
} from '../src/db/queries.mts'
import { noopStatusMirror, runLoop, type StatusMirror } from '../src/foreman/loop.mts'
import type { BitbucketConfig } from '../src/bitbucket/closed-prs.mts'
import type { MinionRunner } from '../src/minion/types.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

const BITBUCKET: BitbucketConfig = { workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' }

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

function fakeFetch(totalCount = 0): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ total_count: totalCount }),
  })) as unknown as typeof fetch
}

function fakeRunner(status: TaskRow['status'] = 'success'): MinionRunner {
  return { run: async () => ({ status, pr_url: null }) }
}

const noSleep = async () => {}

describe('runLoop', () => {
  it('does nothing when already stopped', async () => {
    setStopped(db, true)
    const listBacklog = vi.fn(async () => [])

    await runLoop({
      db,
      taskProvider: { listBacklog },
      bitbucket: BITBUCKET,
      runner: fakeRunner(),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(listBacklog).not.toHaveBeenCalled()
  })

  it('backs off and continues instead of crashing when an iteration throws', async () => {
    setBudget(db, 1)
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        if (calls <= 2) throw new Error('Jira unreachable')
        return [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
      },
    }
    const errors: unknown[] = []
    const sleepCalls: number[] = []

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 250,
      fetchImpl: fakeFetch(),
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      onIterationError: (err) => {
        errors.push(err)
      },
    })

    expect(errors).toHaveLength(2)
    expect(sleepCalls).toEqual([250, 250])
    expect(getBudget(db)).toBe(0)
    expect(isStopped(db)).toBe(true)
  })

  it('sleeps the poll interval and retries when the backlog is empty', async () => {
    setBudget(db, 1)
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return calls === 1 ? [] : [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
      },
    }
    const sleepCalls: number[] = []

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner(),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 5000,
      fetchImpl: fakeFetch(),
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
    })

    expect(sleepCalls).toEqual([5000])
    expect(calls).toBe(2)
  })

  it('dispatches until budget reaches zero, recording each attempt and mirroring status', async () => {
    setBudget(db, 2)
    const backlog: BacklogItem[] = [
      { jira_key: 'KAZ-1', summary: 's1', description: '' },
      { jira_key: 'KAZ-2', summary: 's2', description: '' },
    ]
    let call = 0
    const taskProvider: TaskProvider = {
      // Simulate KAZ-1 leaving the live backlog once it's been dispatched.
      listBacklog: async () => (call++ === 0 ? backlog : [backlog[1] as BacklogItem]),
    }
    const dispatched: string[] = []
    const completed: TaskRow[] = []
    const statusMirror: StatusMirror = {
      onDispatch: async (jiraKey) => {
        dispatched.push(jiraKey)
      },
      onComplete: async (row) => {
        completed.push(row)
      },
    }

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(dispatched).toEqual(['KAZ-1', 'KAZ-2'])
    expect(completed.map((r) => r.jira_key)).toEqual(['KAZ-1', 'KAZ-2'])
    const rows = db.query('SELECT jira_key, status FROM tasks').all()
    expect(rows).toEqual([
      { jira_key: 'KAZ-1', status: 'success' },
      { jira_key: 'KAZ-2', status: 'success' },
    ])
  })

  it('persists remaining budget after each dispatch and sets stopped at zero', async () => {
    setBudget(db, 2)
    const backlog: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
    const seenBudgets: Array<number | null> = []
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        seenBudgets.push(getBudget(db))
        return backlog
      },
    }

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(seenBudgets).toEqual([2, 1])
    expect(getBudget(db)).toBe(0)
    expect(isStopped(db)).toBe(true)
  })

  it('runs unlimited when no budget is set, stopping only via the stopped flag', async () => {
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        if (calls >= 3) setStopped(db, true)
        return [{ jira_key: `KAZ-${calls}`, summary: 's', description: '' }]
      },
    }

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(calls).toBe(3)
    expect(getBudget(db)).toBeNull()
  })

  it('idle iterations do not count against budget', async () => {
    setBudget(db, 1)
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return calls <= 2 ? [] : [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
      },
    }

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner(),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(db.query('SELECT * FROM tasks').all()).toHaveLength(1)
  })

  it('calls onDispatch before onComplete for the same task', async () => {
    setBudget(db, 1)
    const events: string[] = []
    const statusMirror: StatusMirror = {
      onDispatch: async (jiraKey) => {
        events.push(`dispatch:${jiraKey}`)
      },
      onComplete: async (row) => {
        events.push(`complete:${row.jira_key}:${row.status}`)
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's', description: '' }] },
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(events).toEqual(['dispatch:KAZ-1', 'complete:KAZ-1:success'])
  })

  it('records the current task while dispatch is in flight, then clears it', async () => {
    setBudget(db, 1)
    let sawWhileDispatching = null as CurrentTask | null
    const runner: MinionRunner = {
      run: async () => {
        sawWhileDispatching = getCurrentTask(db)
        return { status: 'success', pr_url: null }
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's', description: '' }] },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(sawWhileDispatching?.jira_key).toBe('KAZ-1')
    expect(getCurrentTask(db)).toBeNull()
  })

  it('clears the current task even when dispatch throws', async () => {
    let calls = 0
    const runner: MinionRunner = {
      run: async () => {
        calls += 1
        if (calls === 1) throw new Error('minion runner exploded')
        setStopped(db, true)
        return { status: 'success', pr_url: null }
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's', description: '' }] },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(getCurrentTask(db)).toBeNull()
  })

  it('consumes start_ticket on the next iteration, bypassing normal ordering', async () => {
    setBudget(db, 2)
    setStartTicket(db, 'KAZ-2')
    const backlog: BacklogItem[] = [
      { jira_key: 'KAZ-1', summary: 'normal order first', description: '' },
      { jira_key: 'KAZ-2', summary: 'requested via start[ticket]', description: '' },
    ]
    const completed: string[] = []
    const statusMirror: StatusMirror = {
      onDispatch: async () => {},
      onComplete: async (row) => {
        completed.push(row.jira_key)
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => backlog },
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(completed).toEqual(['KAZ-2', 'KAZ-1'])
    expect(getStartTicket(db)).toBeNull()
  })

  it('clears start_ticket even if the requested task turns out ineligible', async () => {
    setBudget(db, 1)
    setStartTicket(db, 'KAZ-999')
    const backlog: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 's', description: '' }]

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => backlog },
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(getStartTicket(db)).toBeNull()
    expect(db.query('SELECT jira_key FROM tasks').all()).toEqual([{ jira_key: 'KAZ-1' }])
  })
})
