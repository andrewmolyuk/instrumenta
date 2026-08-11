# CLAUDE.md

## Workflow

- **Never commit on local main.** Branch first — committing directly on `main` is blocked
  by `.claude/hooks/block-main-commit.mts`.
- **No Co-Authored-By trailers.** Not used in this repository, even added by hand — blocked
  by `.claude/hooks/block-co-authored-by.mts`.
- **Keep history linear.** No merge commits, on any branch: `git merge` requires
  `--ff-only`; `gh pr merge` requires `--rebase` — anything else (a bare invocation, or one
  with `--merge`/`--squash`) is blocked, since it can still leave a merge commit. Blocked by
  `.claude/hooks/block-merge-commit.mts`.
