import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { openDb, type TaskRow } from '../src/db/index.mts'
import {
  appendCurrentProgress,
  attemptTotals,
  CURRENT_OUTPUT_LINES,
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
    output: null,
    cost_usd: null,
  session: null,
    summary: null,
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

  it('round-trips a jira_key, summary and dispatched_at, including back to null', () => {
    setCurrentTask(db, { jira_key: 'KAZ-42', summary: 'Fix the thing', dispatched_at: '2026-08-14T00:00:00Z' })
    expect(getCurrentTask(db)).toEqual({
      jira_key: 'KAZ-42',
      summary: 'Fix the thing',
      dispatched_at: '2026-08-14T00:00:00Z',
      output: null,
      cost_usd: null,
    })
    setCurrentTask(db, null)
    expect(getCurrentTask(db)).toBeNull()
  })
})

describe('appendCurrentProgress', () => {
  beforeEach(() => {
    setCurrentTask(db, { jira_key: 'KAZ-42', summary: 'Fix the thing', dispatched_at: '2026-08-14T00:00:00Z' })
  })

  it('accumulates reported lines in order', () => {
    appendCurrentProgress(db, { line: 'Read: src/foo.ts' })
    appendCurrentProgress(db, { line: 'Bash: npm run lint' })
    expect(getCurrentTask(db)?.output).toBe('Read: src/foo.ts\nBash: npm run lint')
  })

  it('keeps only the last CURRENT_OUTPUT_LINES lines', () => {
    for (let i = 1; i <= CURRENT_OUTPUT_LINES + 5; i++) appendCurrentProgress(db, { line: 'line ' + i })

    const lines = getCurrentTask(db)?.output?.split('\n') ?? []
    expect(lines).toHaveLength(CURRENT_OUTPUT_LINES)
    expect(lines[0]).toBe('line 6')
    expect(lines.at(-1)).toBe('line ' + (CURRENT_OUTPUT_LINES + 5))
  })

  it('overwrites the running cost rather than accumulating it — Claude Code reports a total, not a delta', () => {
    appendCurrentProgress(db, { cost_usd: 0.5 })
    appendCurrentProgress(db, { cost_usd: 1.83 })
    expect(getCurrentTask(db)?.cost_usd).toBe(1.83)
  })

  it('is dropped once the task is cleared, so a finished Minion leaves no live detail behind', () => {
    appendCurrentProgress(db, { line: 'Read: src/foo.ts', cost_usd: 1.83 })
    setCurrentTask(db, null)
    setCurrentTask(db, { jira_key: 'KAZ-43', summary: 'Another', dispatched_at: '2026-08-14T01:00:00Z' })

    expect(getCurrentTask(db)?.output).toBeNull()
    expect(getCurrentTask(db)?.cost_usd).toBeNull()
  })

  it('does nothing when no task is in flight', () => {
    setCurrentTask(db, null)
    appendCurrentProgress(db, { line: 'stray line', cost_usd: 9 })
    expect(getCurrentTask(db)).toBeNull()
  })
})

describe('attemptTotals', () => {
  it('returns zeros on an empty table', () => {
    expect(attemptTotals(db)).toEqual({
      attempts: 0,
      costTotal: 0,
      costCount: 0,
      durationTotalMs: 0,
      durationCount: 0,
    })
  })

  it('counts and sums every attempt, whatever its status', () => {
    recordAttempt(db, attempt({ task_id: 't1', status: 'success', cost_usd: 2.2, dispatched_at: '2026-08-23T16:40:00Z', finished_at: '2026-08-23T16:50:00Z' }))
    recordAttempt(db, attempt({ task_id: 't2', status: 'crashed', cost_usd: 0.8, dispatched_at: '2026-08-23T17:00:00Z', finished_at: '2026-08-23T17:05:00Z' }))

    const totals = attemptTotals(db)
    expect(totals.attempts).toBe(2)
    expect(totals.costTotal).toBeCloseTo(3)
    expect(totals.costCount).toBe(2)
    expect(totals.durationTotalMs).toBeCloseTo(15 * 60_000, -1)
    expect(totals.durationCount).toBe(2)
  })

  it('reports the counts separately, so an average is not taken over rows without the value', () => {
    // A crash before Claude Code reported anything has a null cost; an attempt
    // still in flight has no finish time. Both must stay out of their divisor.
    recordAttempt(db, attempt({ task_id: 't1', cost_usd: 4, dispatched_at: '2026-08-23T10:00:00Z', finished_at: '2026-08-23T10:10:00Z' }))
    recordAttempt(db, attempt({ task_id: 't2', cost_usd: null, dispatched_at: '2026-08-23T11:00:00Z', finished_at: null }))

    const totals = attemptTotals(db)
    expect(totals.attempts).toBe(2)
    expect(totals.costCount).toBe(1)
    expect(totals.costTotal).toBeCloseTo(4)
    expect(totals.durationCount).toBe(1)
  })

  it('leaves a backwards span out rather than subtracting it', () => {
    recordAttempt(db, attempt({ task_id: 't1', cost_usd: null, dispatched_at: '2026-08-23T12:00:00Z', finished_at: '2026-08-23T11:00:00Z' }))

    expect(attemptTotals(db)).toMatchObject({ attempts: 1, durationCount: 0, durationTotalMs: 0 })
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

  it("round-trips an attempt's session record, for a success as well as a failure", () => {
    // The RPG-5427 gap: `output` is null on success by design, so a successful
    // attempt left no record of what the agent had done. `session` is written
    // for every status precisely so that is no longer true.
    recordAttempt(db, attempt({ task_id: 't1', status: 'success', output: null, session: '## Minion session\nRead: src/foo.ts' }))
    recordAttempt(db, attempt({ task_id: 't2', status: 'crashed', session: null }))

    const rows = listAttempts(db, 10)
    expect(rows.find((r) => r.task_id === 't1')?.session).toContain('Read: src/foo.ts')
    expect(rows.find((r) => r.task_id === 't2')?.session).toBeNull()
  })

  it("round-trips the ticket's title, and leaves it null on rows that never had one", () => {
    recordAttempt(db, attempt({ task_id: 't1', summary: 'Web UI: long tag doesn\u2019t look good' }))
    recordAttempt(db, attempt({ task_id: 't2', summary: null }))

    const rows = listAttempts(db, 10)
    expect(rows.find((r) => r.task_id === 't1')?.summary).toBe('Web UI: long tag doesn\u2019t look good')
    expect(rows.find((r) => r.task_id === 't2')?.summary).toBeNull()
  })

  it('returns every attempt when the limit is null', () => {
    for (let i = 1; i <= 60; i++) {
      recordAttempt(db, attempt({ task_id: 't' + i, dispatched_at: '2026-08-13T00:00:0' + (i % 10) + 'Z' }))
    }
    expect(listAttempts(db, null)).toHaveLength(60)
  })

  it('round-trips a failed attempt\'s captured output, and leaves it null when absent', () => {
    recordAttempt(db, attempt({ task_id: 't1', status: 'failed_verify', output: 'test 1 failed' }))
    recordAttempt(db, attempt({ task_id: 't2', status: 'success', output: null }))
    const rows = listAttempts(db, 10)
    expect(rows.find((r) => r.task_id === 't1')?.output).toBe('test 1 failed')
    expect(rows.find((r) => r.task_id === 't2')?.output).toBeNull()
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
