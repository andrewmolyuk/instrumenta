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
  -- Captured diagnostic text, tail-truncated: Claude Code's own stdout+stderr
  -- (minion/implement-task.mts) combined with the verify gate's stdout+stderr on
  -- failed_verify and the given_up that follows it (minion/verify-gate.mts), or
  -- Minion's own process stdout+stderr on crashed or timeout
  -- (src/minion/process-runner.mts) — null for every other status, including a
  -- passing verify.
  output TEXT,
  -- Claude Code's own total_cost_usd for this attempt (minion/implement-task.mts),
  -- carried through MinionResult regardless of outcome — null when Claude Code
  -- never produced a parseable result (crash, timeout, missing binary).
  cost_usd REAL,
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
-- decremented. `queue_ticket` is a jira_key queued via queue[ticket],
-- consumed (cleared) the next time Pick reads it. `current_jira_key`/
-- `current_dispatched_at` mirror the task the loop is inside `dispatch` for
-- right now, if any — set just before Minion runs, cleared right after, so
-- the API can show "what's Minion doing now" instead of only what's already
-- in `tasks`. `current_summary` is that task's Jira title, copied from the
-- BacklogItem at dispatch rather than looked up on demand: mirroring the task
-- to "In Progress" (ADR-001) drops it out of the backlog JQL, so by the time
-- anyone asks, the live queue no longer has a title to offer.
-- `current_output`/`current_cost_usd` are the live side-channel Minion reports
-- while it runs (src/minion/progress.mts) — a rolling tail of the last few
-- things it did, and Claude Code's running cost. All three are display-only and
-- are cleared with the rest of the current-task fields; the authoritative
-- record of an attempt is still the `tasks` row written when it finishes.
CREATE TABLE IF NOT EXISTS foreman_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0,
  budget INTEGER,
  budget_total INTEGER,
  queue_ticket TEXT,
  current_jira_key TEXT,
  current_dispatched_at TEXT,
  current_summary TEXT,
  current_output TEXT,
  current_cost_usd REAL
);

INSERT OR IGNORE INTO foreman_state (id, stopped, budget, queue_ticket) VALUES (1, 0, NULL, NULL);
