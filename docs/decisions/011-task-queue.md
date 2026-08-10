# 011 — Task queue: `ready` label, one task at a time

Date: 2026-08-10. Makes ADR-002/003's GitHub Issues task source concrete.

## Context

ADR-002/003 picked GitHub Issues as the task source but left "what counts as ready" and
how many tasks run at once unspecified. Both are needed before the orchestrator can pull
its first issue.

## Decision

**Readiness:** an issue is ready when it is open, unassigned to the orchestrator's
tracking, and carries the `ready` label. The label is the only signal — no separate
query language or scoring, matching ADR-001's rejection of a policy engine for anything a
fixed rule already covers.

**Concurrency: one task at a time, FIFO by issue creation date.** The orchestrator
finishes (or parks, via `AwaitingIntervention`) a task before starting the next. This
keeps the design ADR-006 already assumed — one active state machine to reason about,
one thing the Cockpit's SSE loop (ADR-008) has to render — and avoids resource
contention (SDK rate limits, concurrent gate runs) that a parallel pool would need to
manage. It also matches the north star: `docs/vision.md` measures human hours per task,
not throughput, so parallelism buys a metric this project isn't optimizing for yet.

## Reversibility

Two-way door. A worker pool replacing the single active task is a scheduling change
inside the orchestrator; nothing in the event store (ADR-005), state machine (ADR-006),
or Cockpit (ADR-008) assumes single-task in a way that would need to be undone.

## Revisit trigger

The queue backs up faster than one task at a time can clear it — visible directly in the
Cockpit as a growing `Queued` list with real wait time. That's the signal throughput has
become the bottleneck, not effort per task.
