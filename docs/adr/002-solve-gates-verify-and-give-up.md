# 002 — Solve requires a project verify skill and gives up after 3 closed PRs

Date: 2026-08-12

## Context

The loop's solve step ([docs/vision.md](../vision.md)) implements a task, commits, and
opens a PR. Two things were undecided: what "done" means before committing — whether
anything checks the agent's own judgment — and what happens when solve genuinely can't
finish a task, since the MVP carries no `AwaitingIntervention`-style state
([ADR-001](001-task-queue-state-in-git.md) covers picking a task, not finishing one).

## Options considered

**Verify gate, before committing:**

- **A** — no gate; solve commits whenever it believes the task is done. Nothing catches
  an agent that's wrong about its own work.
- **B** — a new instrumenta-specific config file naming the verify command per project.
  Works, but invents a config format instrumenta doesn't otherwise have — every other
  piece of project-specific behavior here goes through hooks or skills, not a bespoke
  config surface.
- **C (chosen)** — a project-specific skill named `verify`, following the lookup pattern
  the `run` skill already uses in this environment: check for a project skill first, and
  only fall back to generic detection if the project hasn't defined one. Chosen because,
  unlike `run`, there's no safe generic fallback for "did this pass" across arbitrary
  project types — a missing `verify` skill is treated as a hard stop, not a silent skip.

**Give-up threshold, when solve can't finish a task:**

- **A** — retry forever. A task that genuinely can't complete (ambiguous requirement,
  missing access) gets re-picked every iteration indefinitely, spending budget on the
  same failure with nothing surfaced to a human.
- **B** — track an attempt counter in provider-owned state. Rejected for the same reason
  as [ADR-001](001-task-queue-state-in-git.md)'s rejected option D: a counter that isn't
  derived from the repository is a second source of truth that can drift from it.
- **C (chosen)** — count closed (non-merged) PRs whose branch name matches the task's
  slug; GitHub already keeps this history, so it costs nothing to store. At 3, solve
  stops retrying that task.

## Decision

Before committing, solve looks for a project-specific skill named `verify`. If the
project doesn't have one, solve does not invent a verify command itself, does not commit,
and does not open a PR for the task at hand. Instead it writes a `docs/todo/` entry
recording that the project has no `verify` skill and the gate can't run, then stops — a
human has to add the skill before solve can complete anything in that project. If a
`verify` skill exists, solve runs it before committing; a failing verify blocks the
commit exactly like an unfinished task would.

Each time solve opens a PR for a task and that PR is later closed without merging, it
counts toward that task's slug (per [ADR-001](001-task-queue-state-in-git.md), a closed
PR doesn't block re-picking on its own — only the count matters here). On the 3rd closed
PR, solve does not attempt that task again. Instead, at the point the threshold is
crossed, solve itself — synchronously, not deferred to `document-session-learnings`,
whose `SessionEnd` mining is deliberately best-effort and may write nothing — writes a
`docs/todo/` entry (`type: bug`) stating the task was not resolved after 3 attempts and
needs a human, linking the three closed PRs.

The original `docs/todo/<slug>.md` file is left untouched. What keeps it out of the pick
pool is the closed-PR count against its slug, not a field written on the file itself.

**Why not A (no verify gate):** the loop is meant to run unattended; without a gate,
"solve believes it's done" is the only bar a commit clears, which is exactly the judgment
this whole design distrusts enough to build a loop with PRs and gates in the first place.

**Why not B (config file) for the verify gate:** every other piece of project-specific
behavior here — commit rules, doc mining, `run` — is a hook or a skill, not a config
schema instrumenta invents and owns. A skill gets everything skills already get for
free: discoverability, versioning alongside `.claude/skills/`, no new lookup mechanism to
build.

**Why not A (retry forever) for give-up:** spends budget on tasks that can't succeed
without ever surfacing that a human is needed — silent by construction.

**Why not B (provider-owned counter) for give-up:** identical reasoning to
[ADR-001](001-task-queue-state-in-git.md) — GitHub already tracks closed-PR history
reliably; a separate counter is one more thing that can disagree with it.

## Consequences

- A project with no `verify` skill never gets an autonomous PR from instrumenta until
  one is added — onboarding a new project starts with that skill existing, one way or
  another, before solve can finish anything else.
- 3 unsuccessful attempts at a task always produces a visible `docs/todo/` bug entry — a
  stuck task is never silently dropped.
- The threshold (3) is shared across every task and every project; there's no per-task
  override for something known up front to need more attempts.

## Reversibility

Two-way door for the threshold value — it's a constant, change it. The choice of a skill
over a config file for `verify` is a lighter one-way door in convention rather than
mechanism: switching later means rewriting every project's verify definition, not just a
number.

## Revisit trigger

If 3 turns out to be miscalibrated once the loop has actually run — tasks abandoned that
would have succeeded on a 4th attempt, or genuinely stuck tasks burning all 3 before
anyone notices — revisit the constant using those runs as evidence.
