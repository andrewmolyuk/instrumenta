import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import { setStopped } from '../src/db/queries.mts'
import { noopStatusMirror, runLoop, type StatusMirror } from '../src/foreman/loop.mts'
import type { GitHubConfig } from '../src/github/closed-prs.mts'
import type { MinionRunner } from '../src/minion/types.mts'
import type { BacklogItem, TaskProvider } from '../src/task-provider/types.mts'

const GITHUB: GitHubConfig = { owner: 'andrewmolyuk', repo: 'target-project', token: 'gh-token' }

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
      github: GITHUB,
      runner: fakeRunner(),
      statusMirror: noopStatusMirror,
      timeoutMs: 1000,
      pollIntervalMs: 1000,
      fetchImpl: fakeFetch(),
      sleep: noSleep,
    })

    expect(listBacklog).not.toHaveBeenCalled()
  })

  it('sleeps the poll interval and retries when the backlog is empty', async () => {
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return calls === 1 ? [] : [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
      },
    }
    const sleepCalls: number[] = []

    await runLoop(
      {
        db,
        taskProvider,
        github: GITHUB,
        runner: fakeRunner(),
        statusMirror: noopStatusMirror,
        timeoutMs: 1000,
        pollIntervalMs: 5000,
        fetchImpl: fakeFetch(),
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
      },
      1,
    )

    expect(sleepCalls).toEqual([5000])
    expect(calls).toBe(2)
  })

  it('dispatches until budget reaches zero, recording each attempt and mirroring status', async () => {
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

    await runLoop(
      {
        db,
        taskProvider,
        github: GITHUB,
        runner: fakeRunner('success'),
        statusMirror,
        timeoutMs: 1000,
        pollIntervalMs: 1000,
        fetchImpl: fakeFetch(),
        sleep: noSleep,
      },
      2,
    )

    expect(dispatched).toEqual(['KAZ-1', 'KAZ-2'])
    expect(completed.map((r) => r.jira_key)).toEqual(['KAZ-1', 'KAZ-2'])
    const rows = db.query('SELECT jira_key, status FROM tasks').all()
    expect(rows).toEqual([
      { jira_key: 'KAZ-1', status: 'success' },
      { jira_key: 'KAZ-2', status: 'success' },
    ])
  })

  it('idle iterations do not count against budget', async () => {
    let calls = 0
    const taskProvider: TaskProvider = {
      listBacklog: async () => {
        calls += 1
        return calls <= 2 ? [] : [{ jira_key: 'KAZ-1', summary: 's', description: '' }]
      },
    }

    await runLoop(
      {
        db,
        taskProvider,
        github: GITHUB,
        runner: fakeRunner(),
        statusMirror: noopStatusMirror,
        timeoutMs: 1000,
        pollIntervalMs: 1,
        fetchImpl: fakeFetch(),
        sleep: noSleep,
      },
      1,
    )

    expect(db.query('SELECT * FROM tasks').all()).toHaveLength(1)
  })

  it('calls onDispatch before onComplete for the same task', async () => {
    const events: string[] = []
    const statusMirror: StatusMirror = {
      onDispatch: async (jiraKey) => {
        events.push(`dispatch:${jiraKey}`)
      },
      onComplete: async (row) => {
        events.push(`complete:${row.jira_key}:${row.status}`)
      },
    }

    await runLoop(
      {
        db,
        taskProvider: { listBacklog: async () => [{ jira_key: 'KAZ-1', summary: 's', description: '' }] },
        github: GITHUB,
        runner: fakeRunner('success'),
        statusMirror,
        timeoutMs: 1000,
        pollIntervalMs: 1000,
        fetchImpl: fakeFetch(),
        sleep: noSleep,
      },
      1,
    )

    expect(events).toEqual(['dispatch:KAZ-1', 'complete:KAZ-1:success'])
  })

  it('applies startTicket only on the first eligible iteration', async () => {
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

    await runLoop(
      {
        db,
        taskProvider: { listBacklog: async () => backlog },
        github: GITHUB,
        runner: fakeRunner('success'),
        statusMirror,
        timeoutMs: 1000,
        pollIntervalMs: 1000,
        fetchImpl: fakeFetch(),
        sleep: noSleep,
      },
      2,
      'KAZ-2',
    )

    expect(completed).toEqual(['KAZ-2', 'KAZ-1'])
  })
})
