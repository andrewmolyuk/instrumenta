import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import {
  deleteAttempts,
  getBudget,
  getBudgetTotal,
  getCurrentTask,
  getQueueTicket,
  giveUpAttemptCount,
  isStopped,
  listAttempts,
  newTaskId,
  nextAttemptNumber,
  recordAttempt,
  setBudget,
  setBudgetTotal,
  setCurrentTask,
  setQueueTicket,
  setStopped,
} from '../src/db/queries.mts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

function attempt(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: newTaskId(),
    jira_key: 'KAZ-1',
    attempt_number: 1,
    status: 'success',
    pr_url: null,
    dispatched_at: '2026-08-13T00:00:00Z',
    finished_at: '2026-08-13T00:05:00Z',
    ...overrides,
  }
}

describe('newTaskId', () => {
  it('returns distinct uuids', () => {
    expect(newTaskId()).not.toBe(newTaskId())
  })
})

describe('nextAttemptNumber', () => {
  it('starts at 1 for a jira_key with no attempts yet', () => {
    expect(nextAttemptNumber(db, 'KAZ-1')).toBe(1)
  })

  it('counts only attempts for the same jira_key', () => {
    recordAttempt(db, attempt({ jira_key: 'KAZ-1', attempt_number: 1 }))
    recordAttempt(db, attempt({ jira_key: 'RPG-1', attempt_number: 1 }))
    expect(nextAttemptNumber(db, 'KAZ-1')).toBe(2)
    expect(nextAttemptNumber(db, 'RPG-1')).toBe(2)
  })
})

describe('giveUpAttemptCount', () => {
  it('counts failed_verify, crashed, timeout, and given_up, not success', () => {
    recordAttempt(db, attempt({ attempt_number: 1, status: 'failed_verify' }))
    recordAttempt(db, attempt({ attempt_number: 2, status: 'crashed' }))
    recordAttempt(db, attempt({ attempt_number: 3, status: 'timeout' }))
    recordAttempt(db, attempt({ attempt_number: 4, status: 'given_up' }))
    recordAttempt(db, attempt({ attempt_number: 5, status: 'success' }))
    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(4)
  })

  it('a single given_up attempt on its own still counts toward the total', () => {
    recordAttempt(db, attempt({ attempt_number: 1, status: 'failed_verify' }))
    recordAttempt(db, attempt({ attempt_number: 2, status: 'failed_verify' }))
    recordAttempt(db, attempt({ attempt_number: 3, status: 'given_up' }))
    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(3)
  })

  it('reaches 3 — the ADR-001 give-up threshold — on the third failing attempt', () => {
    recordAttempt(db, attempt({ attempt_number: 1, status: 'crashed' }))
    recordAttempt(db, attempt({ attempt_number: 2, status: 'crashed' }))
    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(2)
    recordAttempt(db, attempt({ attempt_number: 3, status: 'crashed' }))
    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(3)
  })

  it('is 0 for a jira_key with no attempts', () => {
    expect(giveUpAttemptCount(db, 'KAZ-999')).toBe(0)
  })
})

describe('stopped flag', () => {
  it('starts false', () => {
    expect(isStopped(db)).toBe(false)
  })

  it('setStopped(true) then setStopped(false) round-trips', () => {
    setStopped(db, true)
    expect(isStopped(db)).toBe(true)
    setStopped(db, false)
    expect(isStopped(db)).toBe(false)
  })
})

describe('budget', () => {
  it('starts unlimited (null)', () => {
    expect(getBudget(db)).toBeNull()
  })

  it('round-trips a numeric value, including back to null', () => {
    setBudget(db, 5)
    expect(getBudget(db)).toBe(5)
    setBudget(db, null)
    expect(getBudget(db)).toBeNull()
  })
})

describe('budget_total', () => {
  it('starts unset (null)', () => {
    expect(getBudgetTotal(db)).toBeNull()
  })

  it('round-trips a numeric value, including back to null, independently of budget', () => {
    setBudgetTotal(db, 5)
    expect(getBudgetTotal(db)).toBe(5)
    setBudget(db, 2)
    expect(getBudgetTotal(db)).toBe(5)
    setBudgetTotal(db, null)
    expect(getBudgetTotal(db)).toBeNull()
  })
})

describe('queue_ticket', () => {
  it('starts unset (null)', () => {
    expect(getQueueTicket(db)).toBeNull()
  })

  it('round-trips a jira_key, including back to null', () => {
    setQueueTicket(db, 'KAZ-42')
    expect(getQueueTicket(db)).toBe('KAZ-42')
    setQueueTicket(db, null)
    expect(getQueueTicket(db)).toBeNull()
  })
})

describe('current task', () => {
  it('starts unset (null)', () => {
    expect(getCurrentTask(db)).toBeNull()
  })

  it('round-trips a jira_key and dispatched_at, including back to null', () => {
    setCurrentTask(db, { jira_key: 'KAZ-42', dispatched_at: '2026-08-14T00:00:00Z' })
    expect(getCurrentTask(db)).toEqual({ jira_key: 'KAZ-42', dispatched_at: '2026-08-14T00:00:00Z' })
    setCurrentTask(db, null)
    expect(getCurrentTask(db)).toBeNull()
  })
})

describe('listAttempts', () => {
  it('returns most recent first, capped at the limit', () => {
    recordAttempt(db, attempt({ task_id: 't1', dispatched_at: '2026-08-13T00:00:00Z' }))
    recordAttempt(db, attempt({ task_id: 't2', dispatched_at: '2026-08-13T00:01:00Z' }))
    recordAttempt(db, attempt({ task_id: 't3', dispatched_at: '2026-08-13T00:02:00Z' }))

    expect(listAttempts(db, 2).map((r) => r.task_id)).toEqual(['t3', 't2'])
  })

  it('returns an empty list when there are no attempts', () => {
    expect(listAttempts(db, 10)).toEqual([])
  })
})

describe('deleteAttempts', () => {
  it('removes only the given jira_key, resetting its give-up count, and returns the number removed', () => {
    recordAttempt(db, attempt({ task_id: 't1', jira_key: 'KAZ-1', status: 'crashed' }))
    recordAttempt(db, attempt({ task_id: 't2', jira_key: 'KAZ-1', status: 'crashed' }))
    recordAttempt(db, attempt({ task_id: 't3', jira_key: 'KAZ-1', status: 'crashed' }))
    recordAttempt(db, attempt({ task_id: 't4', jira_key: 'KAZ-2', status: 'crashed' }))
    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(3)

    expect(deleteAttempts(db, 'KAZ-1')).toBe(3)

    expect(giveUpAttemptCount(db, 'KAZ-1')).toBe(0)
    expect(giveUpAttemptCount(db, 'KAZ-2')).toBe(1)
    expect(listAttempts(db, 10).map((r) => r.task_id)).toEqual(['t4'])
  })

  it('returns 0 when there is nothing to delete for that jira_key', () => {
    expect(deleteAttempts(db, 'KAZ-999')).toBe(0)
  })
})
