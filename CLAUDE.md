# CLAUDE.md — Instrumenta

Instrumenta drives a Coding and a Review agent from GitHub issue to verified PR, with a
Cockpit to watch and steer them. Its thesis: knowledge that accumulates across tasks.
Scope is deliberately narrow — read [`docs/vision.md`](docs/vision.md), which also holds
the success metrics, before building anything not obviously inside the MVP.

## Stack and commands

TypeScript on Bun · workspaces `apps/*` and `packages/*`, both still empty · oxlint ·
oxfmt · Vitest · `tsc --noEmit` on TypeScript 7 (ADR-002 explains why 7 here and `^6`
elsewhere). Hooks are `.mts` so ESM is pinned regardless of `package.json`.
`bun run check` is lint + format:check + typecheck + test — exactly what CI runs.

## Workflow

- **Never commit on local `main`** — branch first, even for doc-only changes. Enforced by
  `.claude/hooks/block-main-commit.mts`, so this fails fast instead of needing an unwind.
- Merge via PR only, **rebase-only** (no merge commits, no squash). Single maintainer:
  merge once the gates are green, nothing waits on a reviewer.
- Conventional commits: `feat:`, `fix:`, `chore:`, …
- **No `Co-Authored-By` trailers.** Blocked by `.claude/hooks/block-co-authored-by.mts`;
  attribution belongs in the event store, not in commit messages.
- **English only in Markdown**, whatever language the conversation is in.

## Verification

Deterministic gates are the product's thesis — hold this repo to the same bar. Run
`bun run check`, show its output, and say plainly when no gate covers what changed.

## Don't

- Let one agent both produce and approve work — code, review, or knowledge entries. That
  separation and the external gates are the architecture, not an implementation detail.
- Route around a red gate. A failing gate stops the task; it is not retried with the
  check disabled.
- Run Instrumenta from the working tree it is editing. It builds itself: always run a
  pinned installed build, or a bug takes out the tool that would fix the bug.

## Decisions

Non-trivial decisions live in `docs/decisions/`, one topic per file, linked from here in
a line — never inlined. This file loads into every session; keep it under 60 lines.

- [ADR-001](docs/decisions/001-mvp-shape.md) — knowledge-first MVP, self-hosted, no graph
- [ADR-002](docs/decisions/002-toolchain-and-task-entry.md) — task entry, layout, toolchain
- [ADR-003](docs/decisions/003-project-ports.md) — three ports, one implementation each
- [ADR-004](docs/decisions/004-knowledge-scopes.md) — shared vs project knowledge scopes
- [ADR-005](docs/decisions/005-event-store.md) — SQLite event store, WAL mode
- [ADR-006](docs/decisions/006-orchestrator-state-machine.md) — states, shared retry cap of 3
- [ADR-007](docs/decisions/007-knowledge-entry-format.md) — Markdown entries, project vs shared dirs
- [ADR-008](docs/decisions/008-cockpit-stack.md) — server-rendered Bun app, SSE, one write path
- [ADR-009](docs/decisions/009-agent-sdk-integration.md) — fresh sessions, permission-scoped roles, both Sonnet 5
- [ADR-010](docs/decisions/010-knowledge-entry-authorship.md) — orchestrator writes entries, not an agent
- [ADR-011](docs/decisions/011-task-queue.md) — `ready` label, one task at a time
- [ADR-012](docs/decisions/012-pinned-build.md) — Docker image tagged per merge, compose pins it
- [ADR-013](docs/decisions/013-knowledge-entry-dedup.md) — same key, no new file, recurrence logged
- [ADR-014](docs/decisions/014-session-end-doc-mining.md) — SessionEnd hook mines transcript into docs/todo/
- [ADR-015](docs/decisions/015-shared-knowledge-write-path.md) — orchestrator never writes shared knowledge directly
- [ADR-016](docs/decisions/016-shared-scope-evidence-corrected.md) — shared-scope evidence is n=1; project scope takes `tool:rule` keys
