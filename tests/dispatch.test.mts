import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/db/index.mts'
import { recordAttempt } from '../src/db/queries.mts'
import { dispatch } from '../src/foreman/dispatch.mts'
import type { MinionInput, MinionResult, MinionRunner } from '../src/minion/types.mts'
import type { BacklogItem } from '../src/task-provider/types.mts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

const TASK: BacklogItem = { jira_key: 'KAZ-1', summary: 'Fix it', description: 'Details.' }

function fakeRunner(result: MinionResult, capture?: (input: MinionInput, timeoutMs: number) => void): MinionRunner {
  return {
    async run(input, timeoutMs) {
      capture?.(input, timeoutMs)
      return result
    },
  }
}

describe('dispatch', () => {
  it('returns a row with a fresh task_id and attempt_number 1 for a new jira_key', async () => {
    const row = await dispatch(
      db,
      fakeRunner({ status: 'success', pr_url: 'https://x/pr/1', output: null }),
      TASK,
      60_000,
    )
    expect(row.task_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.jira_key).toBe('KAZ-1')
    expect(row.attempt_number).toBe(1)
    expect(row.status).toBe('success')
    expect(row.pr_url).toBe('https://x/pr/1')
  })

  it('carries the runner-reported output through to the returned row', async () => {
    const row = await dispatch(
      db,
      fakeRunner({ status: 'failed_verify', pr_url: null, output: 'test 1 failed' }),
      TASK,
      60_000,
    )
    expect(row.output).toBe('test 1 failed')
  })

  it('increments attempt_number on a retry', async () => {
    recordAttempt(db, {
      task_id: 'prior',
      jira_key: 'KAZ-1',
      attempt_number: 1,
      status: 'crashed',
      pr_url: null,
      output: null,
      dispatched_at: '2026-08-13T00:00:00Z',
      finished_at: '2026-08-13T00:01:00Z',
    })
    const row = await dispatch(db, fakeRunner({ status: 'success', pr_url: null, output: null }), TASK, 60_000)
    expect(row.attempt_number).toBe(2)
  })

  it('passes task_id, jira_key, description, and attempt_number to the runner', async () => {
    let captured: MinionInput | undefined
    await dispatch(
      db,
      fakeRunner({ status: 'success', pr_url: null, output: null }, (input) => (captured = input)),
      TASK,
      60_000,
    )
    expect(captured).toMatchObject({ jira_key: 'KAZ-1', description: 'Details.', attempt_number: 1 })
    expect(captured?.task_id).toBeTruthy()
  })

  it('passes the timeout through to the runner', async () => {
    let capturedTimeout: number | undefined
    await dispatch(
      db,
      fakeRunner(
        { status: 'success', pr_url: null, output: null },
        (_input, timeoutMs) => (capturedTimeout = timeoutMs),
      ),
      TASK,
      12_345,
    )
    expect(capturedTimeout).toBe(12_345)
  })

  it('sets dispatched_at and finished_at as ISO timestamps with finished_at not before dispatched_at', async () => {
    const row = await dispatch(db, fakeRunner({ status: 'success', pr_url: null, output: null }), TASK, 60_000)
    expect(new Date(row.finished_at as string).getTime()).toBeGreaterThanOrEqual(new Date(row.dispatched_at).getTime())
  })

  it('does not write to the database itself — the caller records the returned row', async () => {
    await dispatch(db, fakeRunner({ status: 'success', pr_url: null, output: null }), TASK, 60_000)
    const rows = db.query('SELECT * FROM tasks').all()
    expect(rows).toEqual([])
  })
})
