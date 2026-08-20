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
    `INSERT INTO tasks (task_id, jira_key, attempt_number, status, pr_url, output, cost_usd, dispatched_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.task_id,
      row.jira_key,
      row.attempt_number,
      row.status,
      row.pr_url,
      row.output,
      row.cost_usd,
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

/** How many lines of Minion's live output the Cockpit's "Minion now" card keeps. */
export const CURRENT_OUTPUT_LINES = 10

export interface CurrentTask {
  jira_key: string
  /** The task's Jira title, captured at dispatch — see schema.sql on why it isn't looked up later. */
  summary: string | null
  dispatched_at: string
  /** The last CURRENT_OUTPUT_LINES lines Minion reported, newline-joined; null until it reports anything. */
  output: string | null
  /** Claude Code's running cost for the in-flight attempt; null until it reports one. */
  cost_usd: number | null
}

interface CurrentTaskRow {
  current_jira_key: string | null
  current_summary: string | null
  current_dispatched_at: string | null
  current_output: string | null
  current_cost_usd: number | null
}

/** The task the loop is inside `dispatch` for right now, if any (ADR-003's control surface). */
export function getCurrentTask(db: Database): CurrentTask | null {
  const row = db
    .query<CurrentTaskRow, []>(
      `SELECT current_jira_key, current_summary, current_dispatched_at, current_output, current_cost_usd
       FROM foreman_state WHERE id = 1`,
    )
    .get()
  if (!row?.current_jira_key || !row.current_dispatched_at) return null
  return {
    jira_key: row.current_jira_key,
    summary: row.current_summary ?? null,
    dispatched_at: row.current_dispatched_at,
    output: row.current_output ?? null,
    cost_usd: row.current_cost_usd ?? null,
  }
}

/**
 * Sets (or, with null, clears) the in-flight task. Clearing wipes the live
 * progress fields too: they describe the attempt that just ended, and leaving
 * them behind would have the card show a finished Minion's last line as though
 * something were still running.
 */
export function setCurrentTask(db: Database, task: { jira_key: string; summary?: string | null; dispatched_at: string } | null): void {
  db.run(
    `UPDATE foreman_state
     SET current_jira_key = ?, current_summary = ?, current_dispatched_at = ?, current_output = NULL, current_cost_usd = NULL
     WHERE id = 1`,
    [task?.jira_key ?? null, task?.summary ?? null, task?.dispatched_at ?? null],
  )
}

/**
 * Appends one live output line and/or a new running cost to the in-flight task,
 * keeping only the last CURRENT_OUTPUT_LINES lines.
 *
 * The tail is kept in the database rather than in the loop's memory so the API
 * has a single place to read it from — and read-modify-write is safe here
 * because exactly one loop dispatches at a time (architecture.md: Foreman runs
 * one Minion, synchronously). A progress update that arrives after the task was
 * cleared updates nothing, since the WHERE clause no longer matches.
 */
export function appendCurrentProgress(db: Database, progress: { line?: string; cost_usd?: number }): void {
  if (progress.line !== undefined) {
    const row = db
      .query<{ current_output: string | null }, []>('SELECT current_output FROM foreman_state WHERE id = 1')
      .get()
    const lines = row?.current_output ? row.current_output.split('\n') : []
    lines.push(progress.line)
    db.run('UPDATE foreman_state SET current_output = ? WHERE id = 1 AND current_jira_key IS NOT NULL', [
      lines.slice(-CURRENT_OUTPUT_LINES).join('\n'),
    ])
  }
  if (progress.cost_usd !== undefined) {
    db.run('UPDATE foreman_state SET current_cost_usd = ? WHERE id = 1 AND current_jira_key IS NOT NULL', [
      progress.cost_usd,
    ])
  }
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
