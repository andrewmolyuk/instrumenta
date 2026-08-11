# 003 — Pick excludes tasks that hit the give-up threshold

Date: 2026-08-12

## Context

`docs-consistency-check` surfaced a gap between [ADR-001](001-task-queue-state-in-git.md) and
[ADR-002](002-solve-gates-verify-and-give-up.md): ADR-001's concrete picking mechanics ("the
provider lists open branches/PRs by that name to decide claimed vs. free") never consult the
closed-PR count that ADR-002's give-up threshold depends on. As written, a task that has hit 3
closed PRs has no open branch or PR, so ADR-001's algorithm reads it as free and the provider
hands it back out again — exactly the "retry forever" failure ADR-002 rejected as its own
option A. ADR-002 already assumes this is fixed ("What keeps it out of the pick pool is the
closed-PR count against its slug") without saying where that check lives. This ADR is that
missing piece — it supersedes ADR-001's claimed/free mechanics with a version that includes it.

## Options considered

- **A** — leave the gap; rely on the `docs/todo/` bug entry ADR-002 writes at the 3rd closed PR
  to warn a human before the provider re-picks the task again. Fragile: the provider still
  re-picks and re-attempts the task on every loop iteration until a human notices and
  intervenes — exactly the silent-retry failure mode ADR-002 was written to prevent.
- **B** — move the check into solve instead of the provider: leave picking as open-branch/PR-only,
  and have solve itself refuse to work a task whose slug already has 3 closed PRs. Works, but
  means every solve invocation re-derives a check that's really about eligibility to pick, not
  about how to execute — and any other consumer asking "is this task pickable" would need to
  duplicate it.
- **C (chosen)** — fold the check into the provider's claimed/free determination itself, next to
  the open-branch/PR check ADR-001 already established. One place computes eligibility; solve
  and anything else that asks gets the right answer for free.

## Decision

A task is **claimed** if an open branch or open PR exists whose name matches the task file's
slug. A task is **given up** if 3 or more closed (non-merged) PRs exist whose branch name
matches the task file's slug — the threshold [ADR-002](002-solve-gates-verify-and-give-up.md)
defines. A task is **free** only if neither is true: no open branch/PR, and fewer than 3 closed
PRs against its slug. Both `claimed` and `given up` tasks are excluded from picking; only `free`
tasks are eligible.

Concretely: `docs/todo/<slug>.md` maps to branch `<slug>`; the provider lists both open and
closed branches/PRs by that name — open ones decide `claimed`, the closed count decides
`given up` — before returning a task as pickable.

A task is **done** the moment its file is removed from `main`, unchanged from ADR-001 — merging
is what finalizes "done," matching `docs/vision.md`'s "PR is the endpoint."

**Why not A:** the whole point of ADR-002's threshold is to stop the loop from spending budget
on a task that can't succeed; a check that only ever produces a warning after the fact doesn't
stop anything — the provider would keep re-picking the task on every subsequent iteration.

**Why not B:** eligibility belongs with the thing that answers "is this task pickable," which is
the provider defined here — not duplicated into every caller that happens to ask.

## Consequences

- The provider now queries closed PRs per slug on every pick, not just open ones — one more
  GitHub list call, same cost class as what ADR-001 already required for the open check.
- A task stuck at `given up` stays out of the pick pool permanently under this scheme — nothing
  currently un-sticks it. A human resolving the bug entry ADR-002 writes is what allows the work
  to be picked up again, since a fresh task file gets a fresh slug with a zero closed-PR count.
- `CONTEXT.md`'s existing "Free" glossary entry (added under ADR-001) no longer states the full
  rule. `CONTEXT.md` is append-only and can't be corrected in place — a `docs/todo/` entry flags
  the gap per `CLAUDE.md`'s conflict-flagging rule.

## Reversibility

Two-way door, same as ADR-001 — nothing here is a public API or stored schema; changing where
the check lives changes the provider's internals only.

## Revisit trigger

Same as ADR-001's: if a human wants a way to explicitly reclaim a `given up` task without
renaming its file, revisit with an explicit reclaim mechanism.
