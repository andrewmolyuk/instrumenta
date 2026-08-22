# 014 — "Nothing needed changing" is an outcome, not a crash

Date: 2026-08-22

## Context

A Minion clones the target repo, runs the agent, runs the verify gate and the target's
pre-commit checks, and commits. If the agent made no edits, `git commit` fails with
"nothing to commit", `tryCommitAndPush` returns that as an error, and the attempt is
recorded as `crashed`.

So the case where the checks pass against an unmodified tree — the ticket is already
fixed, or genuinely needs no code change — was reported as the worst status in the
vocabulary. Worse, `crashed` is in the give-up set, so the ticket was dispatched twice
more, reached the same conclusion each time at roughly $10 an attempt, and ended
`given_up`: about $30 to establish three times over that there was nothing to do, leaving
a ticket that looks like a pipeline failure.

The vocabulary had no way to say it: `success | failed_verify | blocked_no_verify |
crashed | timeout | given_up`.

One thing cannot be engineered away. **An empty diff does not say why it is empty.**
"Already fixed" and "the agent achieved nothing useful" are indistinguishable to the
pipeline; the only account of which it was is the agent's own, and RPG-5427 (ADR-012) is
the standing reminder that an agent's account of its own work is not evidence.

## Options considered

- **A** — New status `no_change`, terminal after one attempt.
- **B** — New status `no_change`, counted toward the three-strike give-up.
- **C** — Record it as `success` with a null `pr_url`.

## Decision

**A**, with the conclusion sent to a human.

- New status `no_change`, added to `TaskStatus`, the schema's CHECK constraint, and
  CONTEXT.md's Status glossary.
- `runMinion` asks `hasChanges` (a `git status --porcelain` check) *before* committing,
  rather than inferring the case from `git commit`'s error text — matching on git's
  wording to tell a real outcome from a real error breaks on a git upgrade or a
  non-English locale.
- One `no_change` attempt makes the ticket ineligible for Pick (`hasNoChangeAttempt`).
  It is deliberately **not** in the give-up count: it is terminal on its own, and adding
  it there would also make two ordinary failures plus one `no_change` look like a
  three-strike give-up, which is a different statement.
- Minion posts a Jira comment saying it made no change, that the checks pass against an
  unmodified tree, that this is *the agent's conclusion and not a verified one*, and that
  the ticket will not be retried automatically — followed by the agent's own report.
  It already holds Jira credentials (ADR-012), so this needs no new access.
- The status records only what was observed: gate passed, diff empty. The claim lives in
  the comment and in `tasks.session`, attributed to the agent.

**Why not B, counting toward give-up:** re-running an agent on a ticket it just concluded
needs no change reaches the same conclusion for another full attempt's cost. Three
independent runs would raise confidence, but at roughly $30 a ticket to confirm the
cheapest possible outcome — and if the agent is wrong, it is likely to be wrong the same
way all three times, because it is the same model reading the same code.

**Why not C, `success` with no PR:** `success` currently means a pull request exists.
Overloading it makes the Cockpit's success count stop meaning work delivered, and the
first thing anyone asks of this pipeline is how much work it delivered.

**Because terminal must mean ineligible:** if `no_change` neither counted toward give-up
nor blocked Pick, the ticket would stay in the backlog with no PR and be re-selected on
the very next loop iteration — a full-cost attempt every iteration, indefinitely. That is
strictly worse than the bug this ADR fixes.

## Consequences

- A wrong "already fixed" call parks a real ticket after one attempt, and only a human
  looking at the Jira comment will unpark it. That is the accepted cost of not paying
  three times for the same conclusion; the comment exists so the human has something to
  act on.
- `no_change` is terminal in the database, so re-dispatching means clearing the attempt
  (`/api/delete-attempts`, which already exists for `given_up`).
- Minion now writes to Jira, where before it only read. ADR-001 defines Foreman as the
  component that mirrors status; this is a comment rather than a transition, and Minion's
  credentials already allowed it, but it is a second writer to the same tickets.
- The status vocabulary is enforced by a CHECK constraint, which SQLite cannot alter — so
  `openDb` now rebuilds `tasks` when the stored constraint predates a status. That
  rewrites every row, and runs only when the constraint is actually out of date.

## Reversibility

Two-way door for the code; the schema is stickier. Removing the status means another table
rebuild, and any `no_change` rows would need mapping to something else first. Nothing
outside this repository depends on the value.

## Revisit trigger

If humans are routinely re-dispatching tickets the pipeline called `no_change`, the
agent's judgement is not good enough to be terminal and this should become B — or the
conclusion should require corroboration (a second attempt, or a check that the ticket's
described symptom is genuinely absent) before it parks anything.
