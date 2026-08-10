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

Non-trivial decisions live in `docs/decisions/`, one topic per file, never inlined here —
this file loads into every session, so keep it under 60 lines. The numbered index, which
grows by a line per decision and is what pushed it out of this file, is
[`docs/decisions/README.md`](docs/decisions/README.md). Read it before deciding anything
architectural; a later ADR amends an earlier one by number rather than editing it.
