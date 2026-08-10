# 006 — Orchestrator state machine: shared retry cap of 3

Date: 2026-08-10.

## Context

The pipeline is "issue to verified PR" (`CLAUDE.md`), built from pieces already decided:
task source is GitHub Issues (ADR-002/003), work sink is GitHub PR (ADR-003), gates are a
fixed list that must all pass — no policy engine (ADR-001) — and Coding and Review must
stay separate agents; neither may approve its own work (`CLAUDE.md`, Don't). None of that
adds up to a state machine yet, and the orchestrator can't run without one.

The open question wasn't the happy path — it was how long the orchestrator keeps looping
an agent against gate failures and review findings before it stops and asks the
maintainer, since ADR-001 already ruled out a policy engine to make that call
per-task.

## Decision

**States:** `Queued` → `Coding` → `GateCheck` → `PROpened` → `Reviewing` → `Merging` →
`Done`, with `AwaitingIntervention` and `Abandoned` as the two ways out of the happy path.

- `GateCheck` runs the fixed local gate list (`bun run check`-equivalent for the target
  repo). Fail → back to `Coding` with the failure as input.
- `PROpened` pushes the branch and opens/updates the PR so CI re-runs the same gates as
  the source of truth — no route around a red gate (`CLAUDE.md`, Don't) means CI red
  behaves exactly like a local gate fail: back to `Coding`.
- `Reviewing` only starts once gates are green. Findings → back to `Coding`. Approval →
  `Merging` → `Done`. Merge strategy comes from the work-sink port (ADR-003) — it varies
  per project, not a rule this state machine fixes. For MVP the target is Instrumenta
  itself, so that means rebase-only per `CLAUDE.md`; a second project's work-sink carries
  its own convention.
- `AwaitingIntervention` is reachable from any active state — automatically on the retry
  cap (below), or manually, at any time, via the Cockpit's intervene control
  (`docs/vision.md`). From there the maintainer resumes into `Coding` (counter reset) or
  moves the task to `Abandoned`.

**Retry cap: 3, one shared counter.** A gate fail, a CI fail, and a review finding all
increment the same per-task counter. On the third, the task moves to
`AwaitingIntervention` instead of back to `Coding`.

- **Why capped at all:** an uncapped loop can spend unbounded time and tokens re-failing
  the same class of problem — exactly the failure mode the knowledge layer exists to
  prevent recurring, not to loop through indefinitely (ADR-001, ADR-004).
- **Why 3:** enough room for an agent to correct itself without the task silently
  consuming the maintainer's time budget — the same time budget the north-star metric in
  `docs/vision.md` measures.
- **Why one shared counter, not per-source:** a task alternating between one gate fail and
  one review finding is exhibiting the same "not converging" signal either way — splitting
  the count adds a state dimension to track without changing when a human should look.

**Not decided here:** how knowledge entries get written during a run. ADR-001 already
settled that they come only from a confirmed review finding or a failed gate — this ADR
just fixes how many of those a task gets before a human is pulled in.

## Reversibility

Two-way door. The cap is a constant, changeable without a data migration; collapsing a
shared counter back into per-source counters is a small logic change, not a schema one.

## Revisit trigger

Read at the same 20-task horizon as ADR-001. If `AwaitingIntervention` fires on most
tasks, the cap is too tight (or the agents aren't converging, which is a different
problem). If it almost never fires, the cap has room to widen — but widening it trades
away the maintainer's chance to catch a task before it burns further effort, so raise it
deliberately, not by default.
