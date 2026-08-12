# 003 — Foreman runs as a self-looping daemon, not an externally cron-triggered job

Date: 2026-08-12

## Context

Something has to decide when each Pick happens, and what a human's "stop" or "work on
this one next" actually does to that. The loop described in
[vision.md](../vision.md) ("previous task finished, or a poll interval elapsed") is
agnostic about whether that's driven by an external scheduler invoking Foreman fresh
each time, or a loop Foreman runs internally — this ADR decides which, and what the
human control surface does and doesn't affect as a result.

## Options considered

- **A** — externally cron-triggered: some scheduler invokes Foreman, it picks and
  dispatches at most one task, exits. Crash recovery is free (the next tick just tries
  again), but leaves capacity idle between ticks even when the queue is non-empty, and
  requires scheduler infrastructure outside Foreman itself.
- **B (chosen)** — Foreman is a persistent daemon. Internally: `pick → dispatch → wait
  → record` in a loop while there's eligible work and no stop condition; sleep a poll
  interval only when the queue is empty. Gives continuous throughput without external
  scheduler infrastructure, at the cost of needing a container-runtime restart policy
  to replace the crash recovery A got for free.
- **C** — event-driven: a Jira webhook triggers Foreman directly. Lowest latency, but
  needs a publicly reachable endpoint and Jira-side webhook configuration that isn't
  justified yet at MVP scale; B's poll interval already bounds latency without it.

## Decision

Foreman runs as a long-lived process in its container, with a restart policy
(restart-unless-stopped or equivalent) standing in for the crash recovery an external
scheduler would otherwise provide. Before each loop iteration it checks a `stopped`
flag in its own SQLite ([ADR-001](001-task-state-three-sources.md)); if set, it idles
without picking or dispatching anything new.

The control surface (the same thin API/UI [architecture.md](../architecture.md)
describes) exposes exactly this to a human:

- **stop** — sets the flag. Prevents the *next* Pick. Does not abort a Minion already
  in flight; that run continues to its own timeout or completion regardless.
- **continue** — clears the flag, resuming normal looping.
- **start[ticket]** — dispatch a specific `jira_key` on the next iteration, bypassing
  normal priority ordering, for that one iteration only.
- **budget** (optional) — a max-tasks-this-run counter, decremented per completed task;
  reaching zero stops the loop the same way the `stopped` flag does.

**Why not A:** leaves the queue throttled to one task per external tick even when work
is waiting, and adds scheduler infrastructure to get *less* continuous behavior than B
provides without it.

**Why not C:** no benefit at MVP's operator scale offsets standing up a public endpoint
and Jira-side webhook configuration; B's poll interval already gives bounded latency
when the queue is empty.

## Consequences

- Foreman's restart policy has to actually be configured correctly, or a crash mid-loop
  sits unnoticed until a human happens to check the UI — there's no external tick to
  catch it the way A would have.
- "Stop" is advisory for future work only, not an interrupt of current work. A human
  wanting to hard-cancel a Minion that's already running has no mechanism yet — named
  explicitly in architecture.md's "Known, accepted gaps," not hidden.

## Reversibility

Two-way door. Swapping the internal loop for an external trigger (A or C) later changes
only what decides when Pick runs — it doesn't touch Minion's contract, the SQLite
schema, or anything a target project depends on.

## Revisit trigger

If the "stop doesn't abort in-flight work" gap causes a real incident — a Minion left
running against a task a human specifically wanted stopped — revisit toward an explicit
cancel signal reaching into Minion, not just gating the next Pick.
