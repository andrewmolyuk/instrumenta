# 005 — Event store: SQLite, WAL mode

Date: 2026-08-10.

## Context

ADR-001 through ADR-004 all lean on "the event store" as an already-scoped MVP component
without picking a technology: attribution for the north star (which commits each task
produced), project records so the Cockpit can enumerate projects without cloning
(ADR-003), and provenance on knowledge entries — commit, scope, `supersedes` (ADR-001,
ADR-004). Nothing is chosen yet, and the orchestrator can't be built without it.

The system runs locally under docker-compose: one orchestrator process, one maintainer,
no multi-host or multi-writer requirement — the same single-instance shape ADR-003
already assumed for the task and work-sink ports.

## Options considered

- **SQLite** — embedded, file-based.
- **Postgres in docker-compose** — a separate service, client-server.
- **Flat JSON/JSONL files** — no database at all.

## Choice: SQLite, WAL mode

- **Zero new dependency.** Bun ships a native driver (`bun:sqlite`) — no client library,
  no connection pool, nothing added to `package.json` beyond what ADR-002 already picked.
- **Matches the deployment shape.** One orchestrator process writing, docker-compose
  mounts the file as a volume, and there is nothing to provision, migrate as a service, or
  back up beyond that one file. A separate database service would be infrastructure for a
  multi-writer requirement this MVP does not have (ADR-003: single maintainer, single
  orchestrator instance).
- **WAL mode lets the Cockpit read while the orchestrator writes**, without a
  client-server round trip — the read-only Cockpit in MVP scope (`docs/vision.md`) is a
  concurrent reader by design.
- **Real transactions and indexes**, unlike flat files: "which commits did task X
  produce" and "enumerate projects" (ADR-003) are queries, not full-file scans, and
  concurrent-append safety (orchestrator plus any hook writing at the same time) is
  handled by the engine instead of hand-rolled file locking.

**Rejected — Postgres:** a real service to run, migrate, and back up, for concurrency and
multi-host access this MVP doesn't need. Against the MVP-shape discipline in ADR-001: no
infrastructure for a requirement that doesn't exist yet.

**Rejected — flat JSONL:** cheapest to start, but no indexes or transactions. The
Cockpit and orchestrator would each need full scans to answer "which commits" or
"enumerate projects," and concurrent writers need manual locking that SQLite already
provides for free.

**Not decided here:** table/event schema. That's implementation, not architecture, and
belongs with the orchestrator code that first needs it.

## Reversibility

Two-way door on schema details. One-way-ish on "embedded vs client-server" once real data
has accumulated — migrating a populated SQLite file to Postgres is real work, not a
config change.

## Revisit trigger

A second concurrent writer process, or the orchestrator splitting into multiple replicas
under docker-compose — SQLite's single-writer model stops fitting at that point.
