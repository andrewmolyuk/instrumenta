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
    `INSERT INTO tasks (task_id, jira_key, attempt_number, status, pr_url, output, dispatched_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.task_id,
      row.jira_key,
      row.attempt_number,
      row.status,
      row.pr_url,
      row.output,
      row.dispatched_at,
      row.finished_at,
    ],
  )
}

/**
 * SQLite half of ADR-001's give-up check: attempts whose status means the run
 * ended without a PR (failed_verify, crashed, timeout), plus given_up itself —
 * Minion can self-report given_up on its final allowed attempt
 * (architecture.md's Minion section), and that has to count too, or a task it
 * already gave up on would look eligible again next Pick. The Bitbucket half
 * (closed PRs matching jira_key) lives outside this database — see
 * architecture.md's "Where task/claim state actually lives".
 */
export function giveUpAttemptCount(db: Database, jiraKey: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) as n FROM tasks
       WHERE jira_key = ? AND status IN ('failed_verify', 'crashed', 'timeout', 'given_up')`,
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

/** The capacity `budget` was last set to — only moves when a human sets a new budget, unlike `budget` itself. */
export function getBudgetTotal(db: Database): number | null {
  const row = db.query<{ budget_total: number | null }, []>('SELECT budget_total FROM foreman_state WHERE id = 1').get()
  return row?.budget_total ?? null
}

export function setBudgetTotal(db: Database, budgetTotal: number | null): void {
  db.run('UPDATE foreman_state SET budget_total = ? WHERE id = 1', [budgetTotal])
}

/** ADR-005's queue[ticket] (amends ADR-003's start[ticket]): the jira_key queued for the next Pick, if any. */
export function getQueueTicket(db: Database): string | null {
  const row = db.query<{ queue_ticket: string | null }, []>('SELECT queue_ticket FROM foreman_state WHERE id = 1').get()
  return row?.queue_ticket ?? null
}

export function setQueueTicket(db: Database, jiraKey: string | null): void {
  db.run('UPDATE foreman_state SET queue_ticket = ? WHERE id = 1', [jiraKey])
}

export interface CurrentTask {
  jira_key: string
  dispatched_at: string
}

/** The task the loop is inside `dispatch` for right now, if any (ADR-003's control surface). */
export function getCurrentTask(db: Database): CurrentTask | null {
  const row = db
    .query<{ current_jira_key: string | null; current_dispatched_at: string | null }, []>(
      'SELECT current_jira_key, current_dispatched_at FROM foreman_state WHERE id = 1',
    )
    .get()
  if (!row?.current_jira_key || !row.current_dispatched_at) return null
  return { jira_key: row.current_jira_key, dispatched_at: row.current_dispatched_at }
}

export function setCurrentTask(db: Database, task: CurrentTask | null): void {
  db.run('UPDATE foreman_state SET current_jira_key = ?, current_dispatched_at = ? WHERE id = 1', [
    task?.jira_key ?? null,
    task?.dispatched_at ?? null,
  ])
}

/** Most recent attempts first — the history view of the control-surface API. */
export function listAttempts(db: Database, limit: number): TaskRow[] {
  return db
    .query<TaskRow, [number]>('SELECT * FROM tasks ORDER BY dispatched_at DESC LIMIT ?')
    .all(limit)
}

/**
 * Clears a jira_key's recorded attempts, resetting giveUpAttemptCount back to
 * 0 — the only way to force a given-up ticket eligible again, since
 * pickSpecific deliberately doesn't bypass the give-up check itself (see its
 * doc comment). Only the SQLite half: a closed-PR count on Bitbucket that
 * alone crosses GIVE_UP_THRESHOLD still leaves the ticket given-up after
 * this. Returns the number of rows removed.
 */
export function deleteAttempts(db: Database, jiraKey: string): number {
  return db.run('DELETE FROM tasks WHERE jira_key = ?', [jiraKey]).changes
}
