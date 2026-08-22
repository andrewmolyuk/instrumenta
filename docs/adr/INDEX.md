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
- [ADR-007](007-success-mirrors-in-progress-not-done.md) — `success` mirrors stay "In
  Progress", not "Done" (amends ADR-001's mirror); pick also skips any branch that
  already has an open PR
- [ADR-008](008-capture-per-attempt-claude-cost.md) — capture Claude Code's own
  `total_cost_usd` estimate per dispatch attempt as `tasks.cost_usd` (amends ADR-001's
  schema), toward filling in vision.md's Claude-cost-per-ticket TBD
- [ADR-009](009-gate-runs-target-pre-commit-checks.md) — the verify gate also runs the
  target project's own `pre-commit` hook, before committing; the commit itself skips git
  hooks (`--no-verify`), so those checks run once per attempt and a failure is a retryable
  `failed_verify` instead of a crash
- [ADR-010](010-start-refills-an-exhausted-budget.md) — Start refills an exhausted budget
  from `budget_total` (a budget caps a run, not a lifetime); the loop checks the budget
  before dispatching, and a budget must be a positive integer or `null` (amends ADR-003's
  budget control)
- [ADR-011](011-minion-reports-live-progress.md) — Minion reports live progress on stderr
  (`@@minion-progress@@` lines) for display only, and Claude Code runs under
  `--output-format stream-json`; Foreman's control flow still reads nothing but the single
  result at exit (amends architecture.md's "no live-progress callback channel")

- [ADR-012](012-minion-reads-its-own-ticket.md) — Minion reads its own ticket from Jira,
  attachments included, and holds Jira credentials to do it; `MinionInput` is reduced to
  the identity of the attempt and `BacklogItem` to key + title (amends ADR-002's
  credential boundary and architecture.md's Minion contract)

## Superseded

None yet.
