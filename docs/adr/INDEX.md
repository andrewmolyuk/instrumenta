# ADR Index

One topic per file, numbered in the order taken, never inlined into `CLAUDE.md`. A later
ADR amends an earlier one by number rather than editing it — the record stays as written
and dated.

## In force

- [ADR-001](001-task-state-three-sources.md) — claimed/given-up state comes from three
  independent sources (Jira, Foreman's SQLite, target-repo GitHub history), not one
- [ADR-002](002-foreman-minion-execution-boundary.md) — Foreman and Minion are separate
  containers; Minion is ephemeral, sandboxed, and runs unattended
- [ADR-003](003-foreman-daemon-trigger-control.md) — Foreman runs as a self-looping
  daemon, not an externally cron-triggered job

## Superseded

None yet.
