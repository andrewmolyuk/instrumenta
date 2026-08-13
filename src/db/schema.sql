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
-- max-tasks-this-run counter (NULL = unlimited); `start_ticket` is a jira_key
-- queued via start[ticket], consumed (cleared) the next time Pick reads it.
CREATE TABLE IF NOT EXISTS foreman_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0,
  budget INTEGER,
  start_ticket TEXT
);

INSERT OR IGNORE INTO foreman_state (id, stopped, budget, start_ticket) VALUES (1, 0, NULL, NULL);
