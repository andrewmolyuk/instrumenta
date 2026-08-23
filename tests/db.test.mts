import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.mts'
import { appendCurrentProgress, getCurrentTask, listAttempts, recordAttempt, setCurrentTask } from '../src/db/queries.mts'

describe('openDb', () => {
  it('creates the tasks table with ADR-001\'s columns, plus ADR-008\'s cost_usd and the session record', () => {
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
      'session',
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

  it('adds the session column to a tasks table that predates it', () => {
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    const old = new Database(path, { create: true })
    old.run(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      jira_key TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      pr_url TEXT,
      output TEXT,
      cost_usd REAL,
      dispatched_at TEXT NOT NULL,
      finished_at TEXT
    )`)
    old.run("INSERT INTO tasks (task_id, jira_key, attempt_number, status, dispatched_at) VALUES ('t0','KAZ-1',1,'success','2026-08-01T00:00:00Z')")
    old.close()

    const db = openDb(path)

    // The pre-existing row survives, reporting null for the new column.
    expect(listAttempts(db, 10)[0]).toMatchObject({ task_id: 't0', session: null })
    recordAttempt(db, {
      task_id: 't1', jira_key: 'KAZ-2', attempt_number: 1, status: 'success', pr_url: null,
      output: null, cost_usd: null, session: '## Minion session', dispatched_at: '2026-08-02T00:00:00Z', finished_at: null,
    })
    expect(listAttempts(db, 10).find((r) => r.task_id === 't1')?.session).toBe('## Minion session')
  })

  it('widens the status CHECK constraint on a database that predates no_change', () => {
    // SQLite cannot ALTER a CHECK constraint, so this one rebuilds the table.
    // The rows must survive it — there were 114 real attempts in the database
    // when no_change was added.
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    const old = new Database(path, { create: true })
    old.run(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      jira_key TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('success', 'failed_verify', 'blocked_no_verify', 'crashed', 'timeout', 'given_up')
      ),
      pr_url TEXT,
      output TEXT,
      cost_usd REAL,
      dispatched_at TEXT NOT NULL,
      finished_at TEXT
    )`)
    old.run(
      "INSERT INTO tasks (task_id, jira_key, attempt_number, status, cost_usd, dispatched_at) VALUES ('t0','KAZ-1',1,'success',9.69,'2026-08-01T00:00:00Z')",
    )
    old.close()

    const db = openDb(path)

    // The pre-existing row survived the rebuild, values intact.
    expect(listAttempts(db, 10)[0]).toMatchObject({ task_id: 't0', status: 'success', cost_usd: 9.69 })
    // And the new status is now accepted.
    recordAttempt(db, {
      task_id: 't1', jira_key: 'KAZ-2', attempt_number: 1, status: 'no_change', pr_url: null,
      output: null, cost_usd: null, session: null, dispatched_at: '2026-08-02T00:00:00Z', finished_at: null,
    })
    expect(listAttempts(db, 10).find((r) => r.task_id === 't1')?.status).toBe('no_change')
  })

  it('widens it again for usage_limit, on a database the previous release built', () => {
    // This is the migration that actually runs on the live database: the whole
    // current schema minus the one status ADR-017 added. It rebuilds `tasks` a
    // second time, and every column of every existing row has to come through.
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    const old = new Database(path, { create: true })
    old.run(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      jira_key TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('success', 'no_change', 'failed_verify', 'blocked_no_verify', 'crashed', 'timeout', 'given_up')
      ),
      pr_url TEXT,
      output TEXT,
      cost_usd REAL,
      session TEXT,
      dispatched_at TEXT NOT NULL,
      finished_at TEXT
    )`)
    old.run(
      `INSERT INTO tasks (task_id, jira_key, attempt_number, status, pr_url, output, cost_usd, session, dispatched_at, finished_at)
       VALUES ('t0', 'RPG-6012', 1, 'success', 'https://bitbucket.org/o/r/pull-requests/9', 'gate output', 8.51,
               '## Minion session', '2026-08-23T00:00:00Z', '2026-08-23T00:16:00Z')`,
    )
    old.run(
      "INSERT INTO tasks (task_id, jira_key, attempt_number, status, dispatched_at) VALUES ('t1', 'RPG-6006', 2, 'no_change', '2026-08-23T01:00:00Z')",
    )
    old.close()

    const db = openDb(path)

    const rows = listAttempts(db, 10)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.task_id === 't0')).toEqual({
      task_id: 't0',
      jira_key: 'RPG-6012',
      attempt_number: 1,
      status: 'success',
      pr_url: 'https://bitbucket.org/o/r/pull-requests/9',
      output: 'gate output',
      cost_usd: 8.51,
      session: '## Minion session',
      dispatched_at: '2026-08-23T00:00:00Z',
      finished_at: '2026-08-23T00:16:00Z',
    })
    expect(rows.find((r) => r.task_id === 't1')).toMatchObject({ status: 'no_change', attempt_number: 2 })

    recordAttempt(db, {
      task_id: 't2', jira_key: 'RPG-6004', attempt_number: 1, status: 'usage_limit', pr_url: null,
      output: 'Claude AI usage limit reached', cost_usd: null, session: null,
      dispatched_at: '2026-08-23T02:00:00Z', finished_at: null,
    })
    expect(listAttempts(db, 10).find((r) => r.task_id === 't2')?.status).toBe('usage_limit')
  })

  it('still rejects a status outside the widened vocabulary', () => {
    const db = openDb(':memory:')
    expect(() =>
      recordAttempt(db, {
        task_id: 't1', jira_key: 'KAZ-1', attempt_number: 1, status: 'invented' as never, pr_url: null,
        output: null, cost_usd: null, session: null, dispatched_at: '2026-08-01T00:00:00Z', finished_at: null,
      }),
    ).toThrow()
  })

  it('leaves an already-migrated database alone when reopened', () => {
    dir = mkdtempSync(join(tmpdir(), 'instrumenta-db-'))
    const path = join(dir, 'foreman.db')
    openDb(path).close()

    expect(() => openDb(path).close()).not.toThrow()
  })
})
