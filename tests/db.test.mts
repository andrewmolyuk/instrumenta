import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.mts'

describe('openDb', () => {
  it('creates the tasks table with ADR-001\'s exact columns', () => {
    const db = openDb(':memory:')
    const columns = db
      .query('PRAGMA table_info(tasks)')
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toEqual([
      'task_id',
      'jira_key',
      'attempt_number',
      'status',
      'pr_url',
      'output',
      'dispatched_at',
      'finished_at',
    ])
  })

  it('rejects a status outside CONTEXT.md\'s Status vocabulary', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.run(
        `INSERT INTO tasks (task_id, jira_key, attempt_number, status, dispatched_at)
         VALUES ('t1', 'KAZ-1', 1, 'not_a_real_status', '2026-08-13T00:00:00Z')`,
      ),
    ).toThrow()
  })

  it('accepts each status in the vocabulary', () => {
    const db = openDb(':memory:')
    const statuses = ['success', 'failed_verify', 'blocked_no_verify', 'crashed', 'timeout', 'given_up']
    for (const [i, status] of statuses.entries()) {
      expect(() =>
        db.run(
          `INSERT INTO tasks (task_id, jira_key, attempt_number, status, dispatched_at)
           VALUES (?, 'KAZ-1', 1, ?, '2026-08-13T00:00:00Z')`,
          [`t${i}`, status],
        ),
      ).not.toThrow()
    }
  })

  it('seeds foreman_state with a single not-stopped row', () => {
    const db = openDb(':memory:')
    const rows = db.query('SELECT id, stopped FROM foreman_state').all()
    expect(rows).toEqual([{ id: 1, stopped: 0 }])
  })

  it('keeps foreman_state to exactly one row', () => {
    const db = openDb(':memory:')
    expect(() => db.run('INSERT INTO foreman_state (id, stopped) VALUES (2, 0)')).toThrow()
  })
})
