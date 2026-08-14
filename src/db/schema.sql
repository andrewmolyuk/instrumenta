-- Foreman's own state, per ADR-001 (docs/adr/001-task-state-three-sources.md) and
-- architecture.md's "Foreman (container, long-running daemon)" section.
--
-- Three sources answer different questions about task state (Jira, this database,
-- and the target repo's GitHub history) — this schema only covers what Foreman
-- itself directly observed about its own dispatch attempts.

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  jira_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('success', 'failed_verify', 'blocked_no_verify', 'crashed', 'timeout', 'given_up')
  ),
  pr_url TEXT,
  dispatched_at TEXT NOT NULL,
  finished_at TEXT
);

-- Single-row table: Foreman's own control-surface state (ADR-003), not any one
-- task's. The CHECK on id enforces exactly one row. `budget` is the remaining
-- max-tasks-this-run counter (NULL = unlimited), decremented by the loop on
-- every dispatch; `budget_total` is the capacity it was last set to (only
-- written when a human sets a new budget, never by the loop's own decrement),
-- kept alongside `budget` purely so the API can report "X of Y attempts
-- used" — `budget` alone can't tell used from total once it's been
-- decremented. `start_ticket` is a jira_key queued via start[ticket],
-- consumed (cleared) the next time Pick reads it. `current_jira_key`/
-- `current_dispatched_at` mirror the task the loop is inside `dispatch` for
-- right now, if any — set just before Minion runs, cleared right after, so
-- the API can show "what's Minion doing now" instead of only what's already
-- in `tasks`.
CREATE TABLE IF NOT EXISTS foreman_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0,
  budget INTEGER,
  budget_total INTEGER,
  start_ticket TEXT,
  current_jira_key TEXT,
  current_dispatched_at TEXT
);

INSERT OR IGNORE INTO foreman_state (id, stopped, budget, start_ticket) VALUES (1, 0, NULL, NULL);
