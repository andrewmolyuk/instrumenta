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
  `--ff-only`. Anything that can leave a merge commit is blocked by
  `.claude/hooks/block-merge-commit.mts`.
- **Subscription auth only — never a metered API key.** Minion authenticates Claude Code
  with `CLAUDE_CODE_OAUTH_TOKEN` ([ADR-006](docs/adr/006-minion-auth-is-subscription-not-api-key.md)).
  Never introduce `ANTHROPIC_API_KEY`, never suggest it as a fallback, and never add a
  code path that would use per-token API billing — not for a fix, not for a test, not
  temporarily. Blocked by `.claude/hooks/block-api-key-auth.mts`.
- **Local git only — never `gh`.** Don't push, open, review, or merge pull requests, and
  don't call the GitHub API. Work on a local branch and stop there; a human takes it from
  the branch. This overrides the default guidance to reach for the `gh` CLI. (The merge
  hook still refuses `gh pr merge` as a backstop, but the rule is broader than the hook:
  no `gh` at all.)
