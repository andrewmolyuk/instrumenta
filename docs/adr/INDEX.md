# ADR Index

One topic per file, numbered in the order taken, never inlined into `CLAUDE.md`. A later
ADR amends an earlier one by number rather than editing it — the record stays as written
and dated.

## In force

- [ADR-002](002-solve-gates-verify-and-give-up.md) — solve requires a project verify
  skill and gives up after 3 closed PRs
- [ADR-003](003-pick-excludes-given-up-tasks.md) — pick excludes tasks that hit the
  give-up threshold, superseding ADR-001's claimed/free mechanics

## Superseded

- [ADR-001](001-task-queue-state-in-git.md) — superseded by
  [ADR-003](003-pick-excludes-given-up-tasks.md)
