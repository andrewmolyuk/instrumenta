import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import {
  type CurrentTask,
  getBudget,
  getCurrentTask,
  getQueueTicket,
  isStopped,
  setBudget,
  setQueueTicket,
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
  return { run: async () => ({ status, pr_url: null, output: null, cost_usd: null, session: null }) }
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
        return [{ jira_key: 'KAZ-1', summary: 's' }]
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
        return calls === 1 ? [] : [{ jira_key: 'KAZ-1', summary: 's' }]
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
      { jira_key: 'KAZ-1', summary: 's1' },
      { jira_key: 'KAZ-2', summary: 's2' },
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
    const backlog: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 's' }]
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

  it('dispatches nothing and stops when the persisted budget is already exhausted', async () => {
    // The "it stops after the first task" report: `budget` survives the run that
    // spent it, and the check used to happen only after a dispatch — so every
    // Start on a spent budget bought one more attempt. /api/start refills it
    // when there is a capacity to refill from (ADR-010).
    setBudget(db, 0)
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return [{ jira_key: 'KAZ-1', summary: 's' }]
      },
    }

    await runLoop({
      db,
      taskProvider,
      bitbucket: BITBUCKET,
      runner: fakeRunner('success'),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(calls).toBe(0)
    expect(db.query('SELECT * FROM tasks').all()).toHaveLength(0)
    expect(isStopped(db)).toBe(true)
  })

  it('runs unlimited when no budget is set, stopping only via the stopped flag', async () => {
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        if (calls >= 3) setStopped(db, true)
        return [{ jira_key: `KAZ-${calls}`, summary: 's' }]
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

  it('keeps running when a human lifts the budget to unlimited mid-run', async () => {
    // Reported live: "unlimited budget stopped execution." The budget was read
    // once when runLoop was entered, so setting it to unlimited while a dispatch
    // was already in flight changed nothing — the loop kept counting its stale
    // copy down to zero and stopped, and its own decrement wrote a finite
    // number back over the null the human had just set.
    setBudget(db, 2)
    let dispatches = 0
    const runner: MinionRunner = {
      run: async () => {
        dispatches += 1
        if (dispatches === 1) setBudget(db, null)
        if (dispatches >= 4) setStopped(db, true)
        return { status: 'success', pr_url: null, output: null, cost_usd: null, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: {
        listBacklog: async () => [{ jira_key: 'KAZ-' + dispatches, summary: 's' }],
      },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(dispatches).toBe(4)
    expect(getBudget(db)).toBeNull()
    expect(isStopped(db)).toBe(true)
  })

  it('picks up a budget a human raises mid-run, rather than its stale copy', async () => {
    setBudget(db, 1)
    let dispatches = 0
    const runner: MinionRunner = {
      run: async () => {
        dispatches += 1
        if (dispatches === 1) setBudget(db, 3)
        return { status: 'success', pr_url: null, output: null, cost_usd: null, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: {
        listBacklog: async () => [{ jira_key: 'KAZ-' + dispatches, summary: 's' }],
      },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    // Raised to 3 during the first dispatch, so that dispatch and two more.
    expect(dispatches).toBe(3)
    expect(getBudget(db)).toBe(0)
    expect(isStopped(db)).toBe(true)
  })

  it('idle iterations do not count against budget', async () => {
    setBudget(db, 1)
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return calls <= 2 ? [] : [{ jira_key: 'KAZ-1', summary: 's' }]
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
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's' }] },
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
        return { status: 'success', pr_url: null, output: null, cost_usd: null, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's' }] },
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

  it("records the in-flight task's Jira title, which the backlog no longer offers once it is In Progress", async () => {
    let sawWhileDispatching = null as CurrentTask | null
    const runner: MinionRunner = {
      run: async () => {
        setStopped(db, true)
        sawWhileDispatching = getCurrentTask(db)
        return { status: 'success', pr_url: null, output: null, cost_usd: null, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: {
        listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 'Fix pagination on the device list' }],
      },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(sawWhileDispatching?.summary).toBe('Fix pagination on the device list')
  })

  it("persists Minion's live progress against the in-flight task as it arrives", async () => {
    let sawWhileDispatching = null as CurrentTask | null
    const runner: MinionRunner = {
      run: async (_input, _timeoutMs, onProgress) => {
        setStopped(db, true)
        onProgress?.({ line: 'Read: src/foo.ts', cost_usd: 0.5 })
        onProgress?.({ line: 'Bash: npm run lint', cost_usd: 1.83 })
        sawWhileDispatching = getCurrentTask(db)
        return { status: 'success', pr_url: null, output: null, cost_usd: 1.83, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's' }] },
      bitbucket: BITBUCKET,
      runner,
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(sawWhileDispatching?.output).toBe('Read: src/foo.ts\nBash: npm run lint')
    expect(sawWhileDispatching?.cost_usd).toBe(1.83)
    // Cleared with the task itself — the finished attempt's record is its `tasks` row.
    expect(getCurrentTask(db)).toBeNull()
  })

  it('clears the current task even when dispatch throws', async () => {
    let calls = 0
    const runner: MinionRunner = {
      run: async () => {
        calls += 1
        if (calls === 1) throw new Error('minion runner exploded')
        setStopped(db, true)
        return { status: 'success', pr_url: null, output: null, cost_usd: null, session: null }
      },
    }

    await runLoop({
      db,
      taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's' }] },
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

  it('consumes queue_ticket on the next iteration, bypassing normal ordering', async () => {
    setBudget(db, 2)
    setQueueTicket(db, 'KAZ-2')
    const backlog: BacklogItem[] = [
      { jira_key: 'KAZ-1', summary: 'normal order first' },
      { jira_key: 'KAZ-2', summary: 'requested via queue[ticket]' },
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
    expect(getQueueTicket(db)).toBeNull()
  })

  it('clears queue_ticket even if the requested task turns out ineligible', async () => {
    setBudget(db, 1)
    setQueueTicket(db, 'KAZ-999')
    const backlog: BacklogItem[] = [{ jira_key: 'KAZ-1', summary: 's' }]

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

    expect(getQueueTicket(db)).toBeNull()
    expect(db.query('SELECT jira_key FROM tasks').all()).toEqual([{ jira_key: 'KAZ-1' }])
  })
})

describe('runLoop and a usage_limit attempt (ADR-017)', () => {
  const backlog = [
    { jira_key: 'KAZ-1', summary: 'first' },
    { jira_key: 'KAZ-2', summary: 'second' },
  ]

  function loopWith(runner: MinionRunner, statusMirror: StatusMirror = noopStatusMirror) {
    return runLoop({
      db,
      taskProvider: { listBacklog: async () => backlog },
      bitbucket: BITBUCKET,
      runner,
      statusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })
  }

  it('stops the run instead of spending the rest of the backlog the same way', async () => {
    const run = vi.fn(fakeRunner('usage_limit').run)
    await loopWith({ run })

    expect(run).toHaveBeenCalledTimes(1)
    expect(isStopped(db)).toBe(true)
  })

  it('stops on an upstream API failure too, which is not this ticket\'s fault either', async () => {
    // ADR-018: RPG-5827's failed attempt still took 3m50s, so carrying on would
    // spend the backlog at four minutes a ticket for nothing.
    const run = vi.fn(fakeRunner('agent_error').run)
    await loopWith({ run })

    expect(run).toHaveBeenCalledTimes(1)
    expect(isStopped(db)).toBe(true)
  })

  it('keeps going on a status that is a verdict on the ticket', async () => {
    // Budgeted at two so the loop ends on its own: what is under test is that a
    // no_change attempt does not stop it, and the budget is then the only thing
    // that does. Without a bound this spins — `pick` returns nothing once both
    // tickets have a no_change attempt, and the empty-queue branch sleeps, which
    // in tests is a resolved promise.
    setBudget(db, 2)
    const run = vi.fn(fakeRunner('no_change').run)
    await loopWith({ run })

    expect(run).toHaveBeenCalledTimes(2)
    expect(getBudget(db)).toBe(0)
  })

  it('does not spend budget on an attempt that never ran', async () => {
    setBudget(db, 5)
    await loopWith(fakeRunner('usage_limit'))

    expect(getBudget(db)).toBe(5)
  })

  it('still records the attempt, and still mirrors it, before stopping', async () => {
    const onComplete = vi.fn(async () => {})
    await loopWith(fakeRunner('usage_limit'), { onDispatch: async () => {}, onComplete })

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'usage_limit' }))
  })

  it('stays stopped even when the mirror fails on the way out', async () => {
    // The mirror walks the ticket back out of "In Progress" here, so it is the
    // one onComplete that can throw — and the catch it lands in must not leave
    // the loop free to pick the next ticket.
    const onComplete = vi.fn(async () => {
      throw new Error('Jira unreachable')
    })
    const run = vi.fn(fakeRunner('usage_limit').run)
    await loopWith({ run }, { onDispatch: async () => {}, onComplete })

    expect(run).toHaveBeenCalledTimes(1)
    expect(isStopped(db)).toBe(true)
  })
})
