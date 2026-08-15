# ADR Index

One topic per file, numbered in the order taken, never inlined into `CLAUDE.md`. A later
ADR amends an earlier one by number rather than editing it — the record stays as written
and dated.

## In force

- [ADR-001](001-task-state-three-sources.md) — claimed/given-up state comes from three
  independent sources (Jira, Foreman's SQLite, target-repo PR history), not one. The
  third source's identity (originally written as GitHub) is amended by ADR-004 — it's
  Bitbucket
- [ADR-002](002-foreman-minion-execution-boundary.md) — Foreman and Minion are separate
  containers; Minion is ephemeral, sandboxed, and runs unattended
- [ADR-003](003-foreman-daemon-trigger-control.md) — Foreman runs as a self-looping
  daemon, not an externally cron-triggered job. Its control names "continue" and
  "start[ticket]" are amended by ADR-005 — they're "start" and "queue[ticket]"
- [ADR-004](004-target-repo-hosting-is-bitbucket.md) — the target repo's hosting is
  Bitbucket, not GitHub (amends ADR-001's third source)
- [ADR-005](005-rename-continue-and-start-ticket.md) — rename "continue" to "start" and
  "start[ticket]" to "queue[ticket]" (amends ADR-003's control names)
- [ADR-006](006-minion-auth-is-subscription-not-api-key.md) — Minion authenticates
  Claude Code via a subscription's `CLAUDE_CODE_OAUTH_TOKEN`, not `ANTHROPIC_API_KEY`

## Superseded

None yet.
