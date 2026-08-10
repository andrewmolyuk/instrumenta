# 008 — Cockpit: server-rendered Bun app, SSE, one write path

Date: 2026-08-10.

## Context

`docs/vision.md` scopes the Cockpit as "read-only ... with an intervene control." ADR-005
already committed to _how_ it reads: WAL mode was chosen specifically so "the Cockpit
read while the orchestrator writes ... without a client-server round trip" — meaning the
Cockpit opens the same SQLite file directly, not through an API. That leaves two things
unpicked: how the UI is rendered and kept live, and how the one write path (intervene)
reaches the orchestrator without creating a second SQLite writer, which ADR-005 already
flagged as the trigger to revisit the storage choice.

## Decision

**Rendering: server-rendered HTML from `Bun.serve`, no frontend framework.** A new
workspace app, `apps/cockpit/`, per ADR-002's `apps/*` convention. No bundler, no build
step — matches the toolchain minimalism ADR-002 already chose (oxlint, oxfmt, Vitest,
`tsc --noEmit`, nothing else). A SPA framework is real cost — a bundler, a second
component model, a second set of lint/format concerns — for a read-only dashboard whose
interactivity is "watch state, click intervene," not one it has today.

**Live updates: Server-Sent Events**, native to `Bun.serve` via a `ReadableStream`, no
added dependency. The Cockpit backend polls its own read connection to the SQLite file on
an interval and pushes diffs to connected browsers over SSE. One-directional server→
client fits a read-only surface; SSE is simpler than a WebSocket for that shape and needs
no separate library.

**The one write path: a small HTTP endpoint on the orchestrator, not a second SQLite
writer.** The intervene control (resume into `Coding` with the retry counter reset, or
move to `Abandoned` — the two exits from `AwaitingIntervention` in ADR-006) is the
Cockpit's only write. It is sent as a request to a minimal internal API the orchestrator
exposes for exactly this, so SQLite keeps the single-writer shape ADR-005 assumed. The
Cockpit process itself never opens the database for writing.

**Consequence:** the Cockpit is two small pieces — a poll-and-push loop reading SQLite,
and a handful of server-rendered routes — not a client application with its own state
management. That is deliberately less capable than a SPA and is the trade being made:
simplicity now over UI headroom that MVP doesn't need yet.

## Reversibility

Two-way door, but asymmetric: dropping a framework in later (once the UI outgrows
templated HTML) is a rewrite of `apps/cockpit/`'s presentation layer only — the read path
(SQLite/WAL) and the one write endpoint don't change shape underneath it.

## Revisit trigger

The UI needs client-side state that survives a page navigation (filters, multi-step
forms, anything beyond "read a snapshot, render it") — that's the signal server-rendered
HTML has run out of headroom, not a target to design toward now.
