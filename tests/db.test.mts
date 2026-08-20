import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.mts'
import { appendCurrentProgress, getCurrentTask, setCurrentTask } from '../src/db/queries.mts'

describe('openDb', () => {
  it('creates the tasks table with ADR-001\'s columns, plus ADR-008\'s cost_usd', () => {
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
      'cost_usd',
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

describe('openDb migrations', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('adds the live-progress columns to a database that predates them', () => {
    // Foreman's database lives on a persistent volume by design, so this — not
    // a fresh file — is what an upgrade actually meets. schema.sql alone cannot
    // do it: its CREATE TABLE IF NOT EXISTS is a no-op against an existing table.
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    const old = new Database(path, { create: true })
    old.run(`CREATE TABLE foreman_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      stopped INTEGER NOT NULL DEFAULT 0,
      budget INTEGER,
      budget_total INTEGER,
      queue_ticket TEXT,
      current_jira_key TEXT,
      current_dispatched_at TEXT
    )`)
    old.run('INSERT INTO foreman_state (id, stopped) VALUES (1, 1)')
    old.close()

    const db = openDb(path)

    setCurrentTask(db, { jira_key: 'KAZ-1', summary: 'Fix the thing', dispatched_at: '2026-08-20T00:00:00Z' })
    appendCurrentProgress(db, { line: 'Read: src/foo.ts', cost_usd: 1.83 })
    expect(getCurrentTask(db)).toMatchObject({
      summary: 'Fix the thing',
      output: 'Read: src/foo.ts',
      cost_usd: 1.83,
    })
  })

  it('leaves an already-migrated database alone when reopened', () => {
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    openDb(path).close()

    expect(() => openDb(path).close()).not.toThrow()
  })
})
