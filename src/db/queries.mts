import type { Database } from 'bun:sqlite'
import type { TaskRow } from './index.mts'

/** `task_id` is a UUID Foreman generates internally, never shown to a human (ADR-001). */
export function newTaskId(): string {
  return crypto.randomUUID()
}

export function nextAttemptNumber(db: Database, jiraKey: string): number {
  const row = db
    .query<{ n: number }, [string]>('SELECT COUNT(*) as n FROM tasks WHERE jira_key = ?')
    .get(jiraKey)
  return (row?.n ?? 0) + 1
}

export function recordAttempt(db: Database, row: TaskRow): void {
  db.run(
    `INSERT INTO tasks (task_id, jira_key, attempt_number, status, pr_url, dispatched_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.task_id, row.jira_key, row.attempt_number, row.status, row.pr_url, row.dispatched_at, row.finished_at],
  )
}

/**
 * SQLite half of ADR-001's give-up check: attempts whose status means the run
 * ended without a PR (failed_verify, crashed, timeout). The GitHub half (closed
 * PRs matching jira_key) lives outside this database — see architecture.md's
 * "Where task/claim state actually lives".
 */
export function giveUpAttemptCount(db: Database, jiraKey: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) as n FROM tasks
       WHERE jira_key = ? AND status IN ('failed_verify', 'crashed', 'timeout')`,
    )
    .get(jiraKey)
  return row?.n ?? 0
}

export function isStopped(db: Database): boolean {
  const row = db.query<{ stopped: number }, []>('SELECT stopped FROM foreman_state WHERE id = 1').get()
  return row?.stopped === 1
}

export function setStopped(db: Database, stopped: boolean): void {
  db.run('UPDATE foreman_state SET stopped = ? WHERE id = 1', [stopped ? 1 : 0])
}

/** Remaining max-tasks-this-run counter (ADR-003). `null` means unlimited. */
export function getBudget(db: Database): number | null {
  const row = db.query<{ budget: number | null }, []>('SELECT budget FROM foreman_state WHERE id = 1').get()
  return row?.budget ?? null
}

export function setBudget(db: Database, budget: number | null): void {
  db.run('UPDATE foreman_state SET budget = ? WHERE id = 1', [budget])
}

/** ADR-003's start[ticket]: the jira_key queued for the next Pick, if any. */
export function getStartTicket(db: Database): string | null {
  const row = db.query<{ start_ticket: string | null }, []>('SELECT start_ticket FROM foreman_state WHERE id = 1').get()
  return row?.start_ticket ?? null
}

export function setStartTicket(db: Database, jiraKey: string | null): void {
  db.run('UPDATE foreman_state SET start_ticket = ? WHERE id = 1', [jiraKey])
}

/** Most recent attempts first — the history view of the control-surface API. */
export function listAttempts(db: Database, limit: number): TaskRow[] {
  return db
    .query<TaskRow, [number]>('SELECT * FROM tasks ORDER BY dispatched_at DESC LIMIT ?')
    .all(limit)
}
