# Decisions

One topic per file, numbered in the order taken, never inlined into `CLAUDE.md`. A later
ADR amends an earlier one by number rather than editing it — the record stays as written
and dated.

## In force

- [ADR-001](001-mvp-shape.md) — knowledge-first MVP, self-hosted, no graph
- [ADR-002](002-toolchain-and-task-entry.md) — task entry, layout, toolchain
- [ADR-003](003-project-ports.md) — three ports, one implementation each
- [ADR-005](005-event-store.md) — SQLite event store, WAL mode
- [ADR-006](006-orchestrator-state-machine.md) — states, shared retry cap of 3
- [ADR-008](008-cockpit-stack.md) — server-rendered Bun app, SSE, one write path
- [ADR-009](009-agent-sdk-integration.md) — fresh sessions, permission-scoped roles, both Sonnet 5
- [ADR-011](011-task-queue.md) — `ready` label, one task at a time
- [ADR-012](012-pinned-build.md) — Docker image tagged per merge, compose pins it
- [ADR-014](014-session-end-doc-mining.md) — SessionEnd hook mines transcript into docs/todo/
- [ADR-017](017-knowledge-layer.md) — **the knowledge layer, whole**: scopes, keys, format, write path, promotion

## Superseded

Kept on record for the reasoning that produced each step — nothing in them was reversed.
[ADR-017](017-knowledge-layer.md) restates all six as one design and carries a provenance
table mapping each one forward.

- [ADR-004](004-knowledge-scopes.md) — shared vs project knowledge scopes
- [ADR-007](007-knowledge-entry-format.md) — Markdown entries, project vs shared dirs
- [ADR-010](010-knowledge-entry-authorship.md) — orchestrator writes entries, not an agent
- [ADR-013](013-knowledge-entry-dedup.md) — same key, no new file, recurrence logged
- [ADR-015](015-shared-knowledge-write-path.md) — orchestrator never writes shared knowledge directly
- [ADR-016](016-shared-scope-evidence-corrected.md) — shared-scope evidence is n=1; scope and key shape split
