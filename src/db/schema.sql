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

-- Single-row table: the `stopped` flag gates Foreman's own loop, not any one task
-- (ADR-001, ADR-003). The CHECK on id enforces exactly one row.
CREATE TABLE IF NOT EXISTS foreman_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO foreman_state (id, stopped) VALUES (1, 0);
