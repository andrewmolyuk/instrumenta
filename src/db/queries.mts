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
    `INSERT INTO tasks (task_id, jira_key, attempt_number, status, pr_url, output, cost_usd, session, summary, dispatched_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.task_id,
      row.jira_key,
      row.attempt_number,
      row.status,
      row.pr_url,
      row.output,
      row.cost_usd,
      row.session,
      row.summary,
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
 * already gave up on would look eligible again next Pick. Since ADR-016 this is
 * the whole of give-up: declined PRs on the target repo used to count too, and
 * no longer do — see architecture.md's "Where task/claim state actually lives".
 *
 * `usage_limit` is deliberately absent (ADR-017): the run ended because the
 * subscription had no capacity left, which says nothing about the ticket. Note
 * that the count is a positive list — a status added to the vocabulary is
 * non-terminal here until someone names it, which is the safer default.
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

/**
 * True if any attempt on this ticket concluded that nothing needed changing
 * (ADR-014).
 *
 * Terminal on its own, unlike the give-up count: re-running an agent on a
 * ticket it just decided needs no change reaches the same conclusion for
 * another full attempt's cost. One conclusion, then a human decides — which
 * also means this must make the ticket ineligible, or Pick would keep
 * re-selecting a ticket that is still in the backlog and has no PR, forever.
 */
export function hasNoChangeAttempt(db: Database, jiraKey: string): boolean {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM tasks WHERE jira_key = ? AND status = 'no_change'")
    .get(jiraKey)
  return (row?.n ?? 0) > 0
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

/**
 * How many lines of Minion's live output are kept for the Cockpit.
 *
 * Was 10, when this fed a hover tooltip on a stat card and had to stay glanceable.
 * It now opens in a near-fullscreen, live-updating modal meant for working out
 * what a running agent is doing, and ten lines is a keyhole. Still bounded —
 * this is rewritten in SQLite on every progress line.
 */
export const CURRENT_OUTPUT_LINES = 200

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

/**
 * Most recent attempts first — the history view of the control-surface API.
 * A null `limit` means every attempt ever recorded: SQLite reads a negative
 * LIMIT as no limit, which keeps this one query rather than two.
 */
export function listAttempts(db: Database, limit: number | null): TaskRow[] {
  return db
    .query<TaskRow, [number]>('SELECT * FROM tasks ORDER BY dispatched_at DESC LIMIT ?')
    .all(limit ?? -1)
}

/**
 * What every recorded attempt adds up to: how many, what they cost, and how
 * long they ran.
 *
 * Computed in SQL over the whole table rather than summed from the rows
 * `/api/status` already returns, because that endpoint caps its history at 50
 * (see api.mts). Summing the capped list would give the Cockpit a total that
 * silently stops growing at the cap and disagrees with the Attempts tab — the
 * same shape of bug as the backlog count that reported 50 for a 121-ticket
 * backlog (src/task-provider/jira.mts).
 *
 * The two counts are reported alongside the two sums because the averages are
 * taken over the attempts that actually have the value: an attempt that crashed
 * before Claude Code reported anything has a null cost, and one still in flight
 * has no finish time. Dividing either sum by `attempts` would understate it.
 * Durations come from julianday arithmetic, and the `finished_at >=
 * dispatched_at` guard keeps a clock skew from contributing a negative span —
 * ISO-8601 UTC strings compare correctly as text.
 */
export interface AttemptTotals {
  attempts: number
  costTotal: number
  costCount: number
  durationTotalMs: number
  durationCount: number
}

export function attemptTotals(db: Database): AttemptTotals {
  const row = db
    .query<AttemptTotals, []>(
      `SELECT COUNT(*) AS attempts,
              COALESCE(SUM(cost_usd), 0) AS costTotal,
              COUNT(cost_usd) AS costCount,
              COALESCE(SUM(
                CASE WHEN finished_at IS NOT NULL AND finished_at >= dispatched_at
                     THEN (julianday(finished_at) - julianday(dispatched_at)) * 86400000 END
              ), 0) AS durationTotalMs,
              COUNT(
                CASE WHEN finished_at IS NOT NULL AND finished_at >= dispatched_at THEN 1 END
              ) AS durationCount
       FROM tasks`,
    )
    .get()
  return row ?? { attempts: 0, costTotal: 0, costCount: 0, durationTotalMs: 0, durationCount: 0 }
}

/**
 * Clears a jira_key's recorded attempts, resetting giveUpAttemptCount back to
 * 0 — the way to force a given-up ticket eligible again, since pickSpecific
 * deliberately doesn't bypass the give-up check itself (see its doc comment).
 * A complete undo since ADR-016 dropped the Bitbucket half of give-up: there
 * is no longer a declined-PR count outside this database to survive it.
 * Returns the number of rows removed.
 */
export function deleteAttempts(db: Database, jiraKey: string): number {
  return db.run('DELETE FROM tasks WHERE jira_key = ?', [jiraKey]).changes
}
