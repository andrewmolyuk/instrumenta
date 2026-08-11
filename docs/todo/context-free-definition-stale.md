---
type: bug
status: open
date: 2026-08-12
source: docs-consistency-check + ADR-003
---

# CONTEXT.md's "Free" glossary entry is stale after ADR-003

`CONTEXT.md`'s "Free" entry (added alongside ADR-001) defines free as "no open branch or PR
matching the task's slug." [ADR-003](../adr/003-pick-excludes-given-up-tasks.md) narrows this:
a task also needs fewer than 3 closed PRs against its slug to be free — a task with 3+ closed
PRs is `given up`, not free, even with no open branch/PR.

`CONTEXT.md` is append-only per `CLAUDE.md` and this entry can't be edited or removed in place.
A human should reconcile it — either through whatever exception process the append-only rule
allows, or by adding a new "Given up" term that narrows "Free" going forward.
