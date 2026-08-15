---
type: adr-candidate
status: open
date: 2026-08-15
source: session 9a0228cc-6161-4015-af15-104cc8f10b51
---

# Foreman now forces `stopped = true` on every boot, enforced in main.mts

Prompted by repeated accidental live dispatches against the real Jira/Bitbucket backlog
during this session's manual verification (forced-start and dev-server testing both fired
real Minion containers before anyone could hit Stop). `foreman_state.stopped` defaults to
`0` in `src/db/schema.sql` (unstopped) — that default was left alone. Instead, `src/foreman/main.mts`
now unconditionally sets `stopped = true` as the first thing it does on every container
start, before the loop or API server come up, so a human always has to explicitly hit
Start.

Alternatives considered:
- **Change the SQLite schema default itself** (`DEFAULT 0` → `DEFAULT 1`) — rejected
  because several `loop.test.mts` cases construct the DB via `openDb` and rely on it
  starting unstopped; changing the schema default would have coupled test setup to this
  safety behavior and forced those tests to explicitly un-stop first.
- **Composition-root override (chosen)** — `main.mts` forces the flag after opening the
  DB, before starting the loop/API. Keeps `openDb`/the schema neutral for tests while
  guaranteeing every real container boot is safe by default.

This is a real behavioral decision (not just a bug fix) that a future ADR touching
ADR-003's control-surface design should account for — ADR-003's own Decision text
doesn't specify the boot-time default, and CONTEXT.md's "Start" glossary entry already
asserts "Foreman always boots stopped" attributed to ADR-003, which is only true as of
this change.
