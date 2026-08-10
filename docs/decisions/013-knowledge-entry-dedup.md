# 013 — Knowledge entry dedup: same `key`, no new file, recurrence logged instead

> **Superseded by [ADR-017](017-knowledge-layer.md)**, which restates this decision together with
> the rest of the knowledge layer. Nothing here was reversed — kept on record for the
> reasoning that produced it. Read ADR-017 for what currently holds.

Date: 2026-08-10. Closes a gap between ADR-001's "thin" scope guard and ADR-010's write
mechanism, found on a re-read of all prior ADRs together.

## Context

ADR-010 has the orchestrator write a knowledge entry from every confirmed review finding
or failed gate. Nothing checks whether an entry with the same `key` (ADR-007: a path
prefix for project scope, a `tool:rule` pair for shared) already exists. Left as-is, a
recurring finding class writes a new file every time it recurs — exactly the failure mode
ADR-001 named directly: "a knowledge base that grows on every task becomes noise within
weeks." Worse, it quietly defeats the thesis test in `docs/vision.md` — "a review finding
of the same class must not recur" — because a recurrence would just produce another
entry instead of surfacing as the retrieval failure it actually is.

## Decision

**On a matching `key`, the orchestrator does not write a new file.** It logs the
recurrence to the event store (ADR-005) instead — which entry matched, which task and
commit hit it again. The existing entry's content is left as written.

This makes the thesis test read directly off the event store: count recurrences per
`key` where an entry already existed at retrieval time. A knowledge base that stays thin
by construction (one file per `key`, ever) and a recurrence count that can only mean one
thing — the entry existed and either wasn't retrieved or was retrieved and didn't help —
rather than being masked by a fresh file each time.

**Why not update-in-place or supersede automatically:** `supersedes` (ADR-001, ADR-007)
is deliberately a manual edit — the maintainer revising a stale entry — not a mechanism
the orchestrator drives on every recurrence. Wiring automatic supersession into ADR-010's
write path adds judgment (what changed, is the old text now wrong or just incomplete)
that a template-filling orchestrator step doesn't have and ADR-010 explicitly avoided
needing.

## Reversibility

Two-way door. Recurrence events are already in the event store either way; turning them
into automatic entry revisions later is a new orchestrator step, not a schema change.

## Revisit trigger

Recurrence events pile up against a `key` whose entry is stale or wrong — evidence a
human should have revised it via `supersedes` and didn't notice. That's a Cockpit surfacing
problem first (show recurrence counts per entry), not a reason to automate supersession by
default.
