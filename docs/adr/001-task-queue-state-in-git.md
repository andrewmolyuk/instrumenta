# 001 — Git/GitHub state stands in for the task queue, no separate store

Date: 2026-08-12

## Context

The MVP loop ([docs/vision.md](../vision.md)) needs a task-provider step: pick the next
task, and know whether a task is already claimed or already resolved, without picking it
twice. The loop runs as a fresh context on every iteration — nothing keeps state in
process memory between iterations — so whatever answers "is this task free" has to
survive between iterations without a running process behind it.

## Options considered

- **A** — a `status` field in each `docs/todo/` file's frontmatter, updated by commits
  straight to `main`. Requires an exception to `block-main-commit.mts`
  ([CLAUDE.md](../../CLAUDE.md)), which forbids exactly that.
- **B** — the same status field, updated through a small bookkeeping PR the loop merges
  itself. Avoids touching `block-main-commit`, but introduces a PR that merges without a
  human — against `docs/vision.md`'s "PR is the endpoint" boundary.
- **C** — the same status field, but written only inside the task's own branch (set to
  claimed on the first commit, in-review before opening the PR). No rule changes needed,
  but the field lies on `main` for as long as the task is being worked — `main` still
  reads `open` — so picking still has to fall back to checking branches/PRs anyway. The
  field never earns its cost.
- **D** — a provider-owned external store (lock file or service) outside the
  `docs/todo/` files. Naturally supports a timeout on abandoned work, but is a second
  source of truth that can drift from the repository — a human editing or deleting a
  task file directly won't update it.
- **E (chosen)** — no stored state at all. The provider re-derives each task's status
  from git/GitHub on every pick, using the task file's slug as the join key against
  branch and PR names.

## Decision

A task is **claimed** if an open branch or open PR exists whose name matches the task
file's slug. A task is **free** if no such open branch/PR exists — a *closed*
(non-merged) PR does not block picking on its own; it only counts toward the give-up
threshold ([ADR-002](002-solve-gates-verify-and-give-up.md)). A task is **done** the
moment its file is removed from `main`, which happens as part of the same commit/PR that
solves it — merging is what finalizes "done," matching `docs/vision.md`'s "PR is the
endpoint."

Concretely: `docs/todo/<slug>.md` maps to branch `<slug>`; the provider lists open
branches/PRs by that name to decide claimed vs. free.

Before finalizing a PR, solve re-checks that the source `docs/todo/` file it started from
still exists. If it doesn't — a human deleted or resolved the task while work was in
progress — solve stops without opening a PR and leaves the branch for a human to clean
up.

**Why not D:** an external store looks like it buys a timeout on abandoned work for
free, but the MVP has no automated timeout policy to spend it on
([ADR-002](002-solve-gates-verify-and-give-up.md) only caps retries on a task that gets
re-attempted, not one that's silently stalled). At this scope D pays for a capability the
design doesn't use yet, in exchange for a second source of truth that isn't checked
against the repository it's tracking.

## Consequences

- No storage to build, run, or back up for the MVP.
- Task state is always exactly what's visible in git and GitHub — auditable with
  `gh pr list` and `ls docs/todo/`, no separate dashboard needed.
- A task whose branch/PR was abandoned (solve started, crashed, never opened a PR) stays
  claimed indefinitely — nothing currently reclaims it.
- A task source beyond `docs/todo/` (an external tracker, say) has to expose an
  open/closed-PR-equivalent signal per task for this scheme to cover it too.

## Reversibility

Two-way door. Nothing here is a public API or a stored schema — swapping in a
provider-owned store later (option D) changes the provider's internals, not the shape of
`docs/todo/` files or branch naming.

## Revisit trigger

If an abandoned branch/PR with no automated timeout becomes a real operational problem —
tasks stuck claimed with no one noticing — revisit with option D or an explicit
stale-claim sweep.
