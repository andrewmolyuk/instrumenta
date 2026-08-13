import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import {
  giveUpAttemptCount,
  isStopped,
  newTaskId,
  nextAttemptNumber,
  recordAttempt,
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
  it('counts failed_verify, crashed, and timeout, not success', () => {
    recordAttempt(db, attempt({ attempt_number: 1, status: 'failed_verify' }))
    recordAttempt(db, attempt({ attempt_number: 2, status: 'crashed' }))
    recordAttempt(db, attempt({ attempt_number: 3, status: 'timeout' }))
    recordAttempt(db, attempt({ attempt_number: 4, status: 'success' }))
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
