# 001 — Claimed/given-up state comes from three independent sources, not one

Date: 2026-08-12

## Context

Foreman needs to know, before picking a task, whether it's already claimed, already
given up on, or free — without picking the same task twice or retrying a dead end
forever. Two earlier framings each broke on a real case:

Deriving everything live from the target repository's git/GitHub state (branches, PRs)
alone — reconstructing "claimed" and "given up" purely from what's visible there — can't
see a Minion that crashed or timed out before ever opening a PR. Nothing in git records
that attempt; the task looks neither claimed nor given up, and stays silently pickable
forever, or silently stuck, with no automatic recovery either way.

Storing all of this in Foreman's own database instead — instead of deriving it — solves
that, since Foreman is the one thing that directly observed the dispatch and its
outcome. But taken as the *only* source, it's a single point of failure: if that data
is ever lost (volume issue, migration bug), the give-up history disappears silently and
a dead task can be retried indefinitely. It also can't see a human acting outside
Foreman entirely — resolving the Jira ticket by hand, or pushing and merging a fix
directly — since none of that touches Foreman's database.

## Options considered

- **A** — derive everything from git/GitHub state only, no stored state. Can't detect a
  crashed/timed-out run that never produced a PR; that failure mode is invisible to git
  by construction.
- **B** — store all state in Foreman's own database exclusively. Solves A's blind spot,
  but is a single source of truth that can silently drift from reality: lost on data
  loss, and blind to anything a human does directly in Jira or the target repository.
- **C (chosen)** — three sources, each authoritative for a different question, not
  copies of the same fact: Jira (is this task still wanted at all), Foreman's own
  SQLite (what Foreman itself observed about its dispatch attempts), and the target
  repository's closed-PR history (a resilient backstop for give-up specifically).

## Decision

`task_id` is a UUID Foreman generates internally — the primary key in its own
bookkeeping, never shown to a human. `jira_key` is the human-facing identifier, used as
the branch name in the target repository (`<jira-key>`, optionally with a short
suffix) — a human reviewing a PR should never see a raw UUID.

Foreman's SQLite schema: `task_id (uuid, pk) | jira_key | attempt_number | status |
pr_url | dispatched_at | finished_at`, plus a single `stopped` flag (not per-task —
it gates Foreman's own loop; see
[ADR-003](003-foreman-daemon-trigger-control.md)).

A task is eligible to pick only if Jira's live query still returns it (open, in the
current sprint/priority view — a human resolving or cancelling the ticket directly
removes it from this result with no extra step needed) **and** it isn't given up.

**Given up** = true the moment either of these crosses 3, whichever happens first:

- SQLite: count of attempts for that `jira_key` with `status` in
  (`failed_verify` — Minion ran and reported the gate didn't pass; `crashed` — Minion
  exited without reporting a structured result at all; `timeout` — Foreman killed the
  container itself after its time budget elapsed, per
  [ADR-002](002-foreman-minion-execution-boundary.md)), or
- GitHub: count of closed (non-merged) PRs whose branch name matches `jira_key`.

Foreman mirrors status back into Jira (e.g. "In Progress" on dispatch, "Done" on
success) purely for human visibility. This is write-only: Jira's *authority* here is
only "does the live query still return this task," not the face value of whatever
status a human or Foreman last set on it.

**Why not A:** the exact failure this design most needs to catch — a Minion that dies
mid-work with no PR to show for it — is invisible to git/GitHub by construction. A
design that can't see its own crashes isn't safe to run unattended.

**Why not B:** turns Foreman's own database into a single point of failure for
something that determines whether a task gets silently retried forever or silently
abandoned — and it can't see legitimate work a human did directly against Jira or the
target repository, outside Foreman's involvement.

## Consequences

- Foreman requires a persistent volume for SQLite (see
  [ADR-002](002-foreman-minion-execution-boundary.md)); losing it degrades give-up
  detection to the GitHub-only backstop until history rebuilds, rather than causing
  silent total loss.
- Two extra read calls per Pick (Jira query, GitHub PR count) — negligible at MVP scale
  (one project, one agent, no parallelism).
- A crash Foreman's own process doesn't observe (not just Minion's) is still an open
  gap — see architecture.md's "Known, accepted gaps."

## Reversibility

Two-way door. The schema, the UUID scheme, and the threshold are internal to Foreman —
none of it is a public API or a convention the target project has to know about.

## Revisit trigger

If SQLite-derived and GitHub-derived give-up ever disagree in a way that causes visible
harm (duplicate PRs, a task retried well past 3 real attempts), revisit whether "first
to reach 3" is the right combination rule, or whether give-up should instead require
agreement between both sources.
