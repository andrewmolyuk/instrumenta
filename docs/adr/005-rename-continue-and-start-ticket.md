# 005 — Rename "continue" to "start" and "start[ticket]" to "queue[ticket]" (amends ADR-003)

Date: 2026-08-14

## Context

ADR-003 named four human controls: **stop**, **continue**, **start[ticket]**, **budget**.
Testing this locally surfaced two problems with that naming, not with the mechanics
behind it:

1. Foreman now always boots with `stopped = true` (a separate change, made the same day
   this was noticed — see the "boot-safety" note in `main.mts`). The first thing a human
   does on a fresh container is clear `stopped` — and "Continue" reads wrong for that:
   there's nothing in progress yet to continue. "Start" is what the button actually does.
2. That collides with the existing **start[ticket]** control, which is a different
   action entirely (queue one specific ticket next, bypassing normal ordering). Two
   controls can't both be called "start."

## Options considered

- **A (chosen)** — rename "continue" to **start**, and rename "start[ticket]" to
  **queue[ticket]** to free up the name. "Queue" matches what it actually does: adds a
  ticket to be picked next, it doesn't dispatch it immediately.
- **B** — rename "continue" to **resume** instead, leaving "start[ticket]" untouched.
  Smaller diff, no collision to resolve. Rejected: "resume" has the same "something was
  already running" connotation as "continue," which is exactly the part that reads wrong
  against a system that now always boots stopped.

## Decision

Renamed, in the API, the Web UI, and this codebase's own identifiers:

- `POST /api/continue` → `POST /api/start`. Same behavior (clears `stopped`), just the
  name.
- `POST /api/start` (queue a specific ticket) → `POST /api/queue-ticket`.
- DB column `foreman_state.start_ticket` → `queue_ticket`; `getStartTicket`/
  `setStartTicket` → `getQueueTicket`/`setQueueTicket`; JSON field `startTicket` →
  `queueTicket`; env var `FOREMAN_START_TICKET` → `FOREMAN_QUEUE_TICKET`.
- UI: "Continue" button → "Start"; "Start ticket" button/form → "Queue ticket".

ADR-003's own text still says "continue" and "start[ticket]" — left as written, per this
project's append-only ADR convention. This document is the current truth for what these
controls are called; ADR-003 is the historical record of why a human control surface
exists at all and what each one affects, which still holds unchanged.

**Why not B:** "resume" avoids the rename cascade into `start[ticket]`/`FOREMAN_START_TICKET`,
but leaves the actual complaint — the verb implying resumption of something already
running — only partially addressed, and doesn't fix the awkwardness of "start[ticket]"
sitting right next to it as a different, unrelated "start."

## Consequences

- Breaking, silently: anyone with an existing `.env` setting `FOREMAN_START_TICKET`
  needs to rename it to `FOREMAN_QUEUE_TICKET` — the old name is no longer read, and
  nothing warns if it's still set. Same for any external script calling
  `POST /api/continue` or `POST /api/start` (old meaning) directly. Acceptable at this
  project's current scale: single operator, single target project, no external
  consumers of the API yet (architecture.md's "no separate CLI artifact" — the API
  itself is the only scriptable surface, and it isn't depended on outside this repo).
- Every file that named these controls needed updating: `src/foreman/{api,loop,main,pick}.mts`,
  `src/db/{schema.sql,queries.mts}`, `src/foreman/config.mts`, `src/foreman/ui.html`,
  their tests, README.md, `.env.example`, and prose mentions in architecture.md,
  vision.md, and CONTEXT.md.

## Reversibility

Two-way door. Pure naming — no schema shape, API contract shape, or control behavior
changed, only the identifiers. Renaming back means repeating this same change, not
undoing something structural.

## Revisit trigger

None expected. If a third "start"-shaped control is ever needed, revisit the whole
naming scheme rather than bolting on a fourth near-synonym.
