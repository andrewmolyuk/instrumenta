# CLAUDE.md

Instrumenta is an agent pipeline that autonomously works a target project's Jira
backlog: picks a task, implements or fixes it in that project's codebase, opens a PR.
See [docs/vision.md](docs/vision.md) for why, [docs/architecture.md](docs/architecture.md)
for how the pieces (Foreman, Minion) fit together, and [docs/adr/INDEX.md](docs/adr/INDEX.md)
for the decisions behind them. [CONTEXT.md](CONTEXT.md) is the project's domain glossary —
check it before introducing new terminology.

## Commands

- `bun run check` — typecheck + the full test suite. Run after touching
  `.claude/hooks/` or `tests/`.
- `bun run typecheck` / `bun run test` — either alone, when you only need one.

## Docs conventions

- ADRs are append-only once merged: never edit a past ADR's Decision — write a new
  numbered one that amends it instead. Format and rationale are in
  [docs/adr/_template.md](docs/adr/_template.md).
- A SessionEnd hook writes to `docs/todo/` and `CONTEXT.md` on its own after some
  sessions. Entries or glossary terms you didn't write yourself are expected, not a bug.

## Workflow

- **Never commit on local main.** Branch first — committing directly on `main` is blocked
  by `.claude/hooks/block-main-commit.mts`.
- **No Co-Authored-By trailers.** Not used in this repository, even added by hand — blocked
  by `.claude/hooks/block-co-authored-by.mts`.
- **Keep history linear.** No merge commits, on any branch: `git merge` requires
  `--ff-only`; `gh pr merge` requires `--rebase` — anything else (a bare invocation, or one
  with `--merge`/`--squash`) is blocked, since it can still leave a merge commit. Blocked by
  `.claude/hooks/block-merge-commit.mts`.
