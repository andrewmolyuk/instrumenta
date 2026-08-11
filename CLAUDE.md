# CLAUDE.md

Instrumenta is an agent that autonomously runs a technical project: pick up the next
task, solve it end to end (code → commit → PR), leave behind knowledge that makes the
next task faster. See @docs/vision.md for the full picture and @docs/adr/INDEX.md for
decisions already made — check there before treating a design question as still open.

## Commands

- `bun run typecheck` — `tsc --noEmit`
- `bun run test` — Vitest (`tests/**/*.mts`)
- `bun run check` — both; run before committing
- No linter or formatter is configured — don't assume one exists.

## Architecture

- `.claude/hooks/` — deterministic guards (`PreToolUse`, `SessionEnd`); enforced, not
  advisory.
- `.claude/skills/` — reusable procedures, e.g. `docs-consistency-check`.
- `docs/adr/` — one decision per numbered file, indexed in `INDEX.md`.
- `docs/todo/` — the task backlog (`type: adr-candidate | bug | todo`).
- `CONTEXT.md` — domain glossary; appended to by the `SessionEnd` hook.
- `tests/` — one Vitest file per hook/util module.

## Workflow

- **Never commit on local main.** Branch first — committing directly on `main` is blocked
  by `.claude/hooks/block-main-commit.mts`.
- **No Co-Authored-By trailers.** Not used in this repository, even added by hand — blocked
  by `.claude/hooks/block-co-authored-by.mts`.
- **Keep history linear.** No merge commits, on any branch: `git merge` requires
  `--ff-only`; `gh pr merge` requires `--rebase` — anything else (a bare invocation, or one
  with `--merge`/`--squash`) is blocked, since it can still leave a merge commit. Blocked by
  `.claude/hooks/block-merge-commit.mts`.
- **Never edit a merged ADR.** `docs/adr/*.md` files are numbered and append-only — a
  later decision supersedes an earlier one with a new file and a "Superseded by" banner
  on the old one, never a rewrite. Update `docs/adr/INDEX.md` when adding or superseding
  one.
- **CONTEXT.md is append-only.** Add new glossary terms; never edit or remove an existing
  one, even a wrong one — flag conflicts in `docs/todo/` instead.
