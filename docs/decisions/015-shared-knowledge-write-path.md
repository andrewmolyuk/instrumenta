# 015 — Orchestrator never writes shared knowledge directly

Date: 2026-08-10. Resolves a contradiction between ADR-004 and ADR-010/013, found by the
`docs-consistency-check` skill.

## Context

ADR-010 has the orchestrator write a confirmed finding's entry to `docs/knowledge/` _or_
`packages/knowledge-shared/entries/` depending on scope, with ADR-013 layering dedup on
top of the same write path. Neither distinguishes the two destinations by anything other
than which directory the `scope`/`key` points at.

ADR-004 already put real conditions on the shared destination specifically: "a project
entry becomes shared only when the same class is confirmed **in a second project**," and
promotion "**opens a PR** against Instrumenta... nothing writes to it unseen." It also
states outright that "promotion requires a second project, and MVP has exactly one. So
the shared base does not learn yet." ADR-010's write path has no such gate — a finding
whose key happens to take the shared shape (`tool:rule`, exactly what a security-scanner
false positive looks like, `docs/vision.md`'s own motivating example) would be written
straight to `packages/knowledge-shared/entries/` on its first confirmed occurrence,
skipping both the second-project bar and the PR review ADR-004 calls non-negotiable. It
also sits awkwardly against ADR-012: that directory ships inside a pinned, tagged build,
not a location a running instance can durably rewrite in place.

## Decision

**The orchestrator's direct-write path (ADR-010, ADR-013) only ever targets
`docs/knowledge/` — project scope. It never writes to
`packages/knowledge-shared/entries/`.**

When a confirmed finding or failed gate has a key shaped for shared scope (`tool:rule`),
the orchestrator still does exactly what it already does for any other confirmed
finding: write (or, per ADR-013, skip and log the recurrence of) the project-scoped
entry. In addition, it logs a **shared-candidate event** to the event store (ADR-005) —
the `tool:rule` key, the project, task, and commit — regardless of whether a matching
project entry already existed. That event log is the record ADR-004's promotion bar
reads from: "confirmed in a second project" means two different projects' event logs
carry a shared-candidate event for the same key, not that a file appeared twice.

**Promotion itself is exactly what ADR-004 already specified, unchanged: a human opens a
PR against Instrumenta once the bar is met.** This ADR does not build that mechanism —
MVP has one project, so the bar can't be met yet regardless (ADR-004's own honest limit,
consistent with ADR-011's single-project scope). It only makes sure automation added
after ADR-004 doesn't silently route around the gate ADR-004 already decided.

## Reversibility

Two-way door. A future automated-but-reviewed promotion flow (still ending in a
human-approved PR, per ADR-004) can consume the same shared-candidate events without
changing what the orchestrator's direct-write path does today.

## Revisit trigger

Same as ADR-003/004's second-project trigger. That's also the first point this ADR's
event-logging-only behavior for shared candidates gets a real test — right now it's
unverifiable with one project in play.
