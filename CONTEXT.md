# Domain Glossary

The ubiquitous language for Instrumenta. Terms here are canonical — ADRs, architecture.md,
vision.md, and code (once written) use these words. Implementation details do not belong in
this file.

> This file is vocabulary only. Architecture, decisions, and workflow policy live in
> [architecture.md](docs/architecture.md), the [ADRs](docs/adr/INDEX.md), and
> [CLAUDE.md](CLAUDE.md). Don't add rules or commands back here — check this file before
> introducing new terminology instead.

## Components

**Foreman**:
The long-running daemon container. Owns the Pick/loop logic, the SQLite task-state database,
and the thin API + Web UI. Never executes target-authored or LLM-directed shell commands
itself.
_Decided in_: [architecture.md](docs/architecture.md#foreman-container-long-running-daemon),
[ADR-002](docs/adr/002-foreman-minion-execution-boundary.md).

**Minion**:
The ephemeral, sandboxed container Foreman spins up one-per-dispatched-task to actually
implement a task and open a PR, then destroys. Runs Claude Code with
`--dangerously-skip-permissions`; the container boundary is the compensating control for that.
_Decided in_: [architecture.md](docs/architecture.md#minion-container-ephemeral-one-per-dispatched-task),
[ADR-002](docs/adr/002-foreman-minion-execution-boundary.md).

**Task Provider**:
The module inside Foreman (not its own container) that adapts one or more sources into a
common backlog-item shape. Jira is the only adapter today; the interface is source-agnostic
so more can be added without changing Foreman's loop.
_Decided in_: [architecture.md](docs/architecture.md#task-provider-module-inside-foreman-not-a-container).

**Target project**:
The external, human-owned repository Instrumenta works against — its code, ADRs, glossary,
notes, `verify` gate, and git/Bitbucket state. Nothing about it is Instrumenta-specific
infrastructure; it makes complete sense with every trace of Instrumenta's involvement removed.
_Decided in_: [architecture.md](docs/architecture.md#target-project-external-repository-human-owned).

## Task lifecycle

**Pick**:
Foreman's loop step that asks the Task Provider for the next eligible task — one Jira's live
query still returns and that isn't Given Up — before dispatching it to a Minion.
_Decided in_: [vision.md](docs/vision.md#the-loop), [ADR-001](docs/adr/001-task-state-three-sources.md).

**Claimed**:
Not a tracked state. ADR-001's context frames the problem as telling claimed / given-up / free
apart, but its Decision only defines eligibility as two checks (Jira still returns it, and it
isn't Given Up) — no separate "claimed" flag exists. Foreman's loop dispatches synchronously
and one Minion at a time (`pick → dispatch → wait → record`, [architecture.md](docs/architecture.md#foreman-container-long-running-daemon)),
so it structurally cannot Pick again until the in-flight attempt has already returned — there is
never a moment a second Pick could race it. At MVP's single-agent, no-parallelism scope
([vision.md](docs/vision.md#scope-now-mvp)) "claimed" reduces to "whichever task Foreman is
currently blocked on," which the loop's own control flow already guarantees is exclusive; no
persisted state is missing.

**Attempt**:
One Minion run against a `jira_key`, recorded in Foreman's SQLite with a `status` and an
`attempt_number`. A task can accumulate multiple attempts across retries before succeeding
or being Given Up.
_Decided in_: [ADR-001](docs/adr/001-task-state-three-sources.md).

**Given Up**:
True the moment Foreman's own SQLite holds one attempt for a `jira_key` with `status` in
(`failed_verify`, `crashed`, `timeout`, `given_up`) — ADR-015 lowered the threshold from
ADR-001's 3, so there are no retries: one failed attempt retires the ticket. ADR-016
removed the second count ADR-001 gave this term, declined PRs on the target repo: a
human declining the agent's work is a verdict on that diff, not on the ticket, and the
ticket goes back into the backlog. Open and merged PRs still keep a ticket out of Pick,
but as a separate check, not as give-up.
_Decided in_: [ADR-001](docs/adr/001-task-state-three-sources.md),
[ADR-015](docs/adr/015-one-attempt-per-ticket.md),
[ADR-016](docs/adr/016-a-declined-pr-does-not-retire-a-ticket.md).

**Verify gate**:
The `verify` mechanism a target project defines for itself and that Minion looks for before
committing anything, together with that project's own `pre-commit` hook — the checks that
would otherwise block the commit — which Minion runs at the same point rather than leaving
to `git commit`. Missing `verify` → Minion stops without committing and reports
`blocked_no_verify`. Either part failing → reports `failed_verify`. Both passing → commit
(with `--no-verify`, since they already ran), open the PR, report `success`.
_Decided in_: [architecture.md](docs/architecture.md#minion-container-ephemeral-one-per-dispatched-task),
[vision.md](docs/vision.md#scope-now-mvp),
[ADR-009](docs/adr/009-gate-runs-target-pre-commit-checks.md).

**Notes path**:
Where Minion writes a `blocked_no_verify` note or a `given_up` note, as an ordinary file in an
ordinary PR. Defaults to `docs/todo/`; a target project can redirect it via a small config
value in its own repository (e.g. `notes_path: instrumenta/review`). Unlike the verify gate, a
missing convention here isn't a hard stop.
_Decided in_: [ADR-002](docs/adr/002-foreman-minion-execution-boundary.md).

**Status**:
The outcome Minion reports at exit, one of: `success` (PR opened), `no_change` (the gate
passed against an unmodified tree — the agent concluded the ticket needs no change; no PR,
and the ticket is not attempted again), `failed_verify` (gate ran
and failed), `blocked_no_verify` (no gate found), `crashed` (exited without a structured
result), `timeout` (Foreman killed it after its time budget with nothing reported — a
kill that lands on a Minion which *had* already reported is recorded under the status it
reported, not as a timeout), `given_up` (final allowed attempt still didn't succeed),
`usage_limit` (the Claude subscription's usage limit was reached, so the agent never worked
on the ticket — nothing committed, no Jira comment, the ticket stays eligible, and the loop
stops the way an exhausted budget stops it).
_Decided in_: [architecture.md](docs/architecture.md#minion-container-ephemeral-one-per-dispatched-task),
[ADR-001](docs/adr/001-task-state-three-sources.md), [ADR-014](docs/adr/014-no-change-is-an-outcome.md),
[ADR-017](docs/adr/017-a-usage-limit-is-not-a-verdict-on-the-ticket.md).

## Human control surface

**Stop**:
Sets Foreman's `stopped` flag. Prevents the *next* Pick only — does not abort a Minion already
in flight.
_Decided in_: [ADR-003](docs/adr/003-foreman-daemon-trigger-control.md).

**Start**:
Clears the `stopped` flag, resuming normal looping — Foreman always boots stopped, so this
is what actually gets it running. Also refills an exhausted budget from the capacity it was
last set to, since a budget caps a run and pressing Start begins one. Named "Continue" in
ADR-003; renamed here to match what it does, since a fresh boot has nothing to "continue."
_Decided in_: [ADR-003](docs/adr/003-foreman-daemon-trigger-control.md),
[ADR-005](docs/adr/005-rename-continue-and-start-ticket.md),
[ADR-010](docs/adr/010-start-refills-an-exhausted-budget.md).

**Queue[ticket]**:
Dispatch a specific `jira_key` on the next iteration, bypassing normal priority ordering, for
that one iteration only. Named "Start[ticket]" in ADR-003; renamed here to free up "Start"
for the control above.
_Decided in_: [ADR-003](docs/adr/003-foreman-daemon-trigger-control.md),
[ADR-005](docs/adr/005-rename-continue-and-start-ticket.md).

**Budget**:
An optional max-tasks-this-run counter, decremented once per completed dispatch cycle;
reaching zero stops the loop the same way `Stop` does. A *run* is one Start-to-stop
stretch, not the lifetime of the database: `Start` refills the counter from the capacity a
human last set. Positive integers only — "no budget" is null, not zero.
_Decided in_: [ADR-003](docs/adr/003-foreman-daemon-trigger-control.md),
[ADR-010](docs/adr/010-start-refills-an-exhausted-budget.md).

This glossary was written from the current docs (`vision.md`, `architecture.md`, ADR-001
through ADR-003) on 2026-08-13, ahead of any application code existing. It replaces an earlier
glossary version tied to a pre-Foreman/Minion design that no longer applies.
