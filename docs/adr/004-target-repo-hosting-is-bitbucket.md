# 004 — The target repo's hosting is Bitbucket, not GitHub (amends ADR-001)

Date: 2026-08-14

## Context

ADR-001 named the target repo's PR-history backstop "GitHub" specifically — closed
(non-merged) PR count via GitHub's search API — and that assumption carried through
architecture.md, CONTEXT.md, and the Foreman/Minion implementation built on top of it
(`src/github/`, `minion/github-pr.mts`, `GITHUB_*` config). The actual target project
this MVP is being built for hosts its repository on Bitbucket, not GitHub. Nothing
about ADR-001's three-source architecture, its give-up threshold, or its combination
rule depends on which host it is — only the API calls and identifiers the third source
uses need to change.

## Options considered

- **A** — support both GitHub and Bitbucket via a pluggable git-hosting-provider
  interface, mirroring the Task Provider abstraction. More work now, and nothing at
  MVP's single-target-project scope needs a second host supported yet — no case for it
  has appeared, unlike Task Provider's abstraction, which vision.md already commits to
  needing a second source later.
- **B (chosen)** — replace GitHub with Bitbucket outright. Simplest change matching
  actual current scope: one target project, on Bitbucket.

## Decision

ADR-001's third source — "GitHub: count of closed (non-merged) PRs whose branch name
matches jira_key" — is Bitbucket instead: count of PRs in state `DECLINED` (Bitbucket's
direct analog of "closed, not merged" — `MERGED` and `SUPERSEDED` are the other two
non-open terminal states, and `SUPERSEDED` isn't counted, since a PR replaced by a
newer one isn't the same as the attempt having failed) whose source branch matches
`jira_key`, via Bitbucket Cloud's REST API v2.0
(`GET /repositories/{workspace}/{repo_slug}/pullrequests?q=...`).

Config changes: `GITHUB_OWNER`/`GITHUB_REPO`/`GITHUB_TOKEN` become
`BITBUCKET_WORKSPACE`/`BITBUCKET_REPO_SLUG`/`BITBUCKET_TOKEN`. Auth is a bearer access
token, same shape as before. PR creation (Minion's side) moves from
`POST /repos/{owner}/{repo}/pulls` to
`POST /repositories/{workspace}/{repo_slug}/pullrequests`, with Bitbucket's nested
`source.branch.name` / `destination.branch.name` request shape and
`links.html.href` response shape in place of GitHub's flat `head`/`base`/`html_url`.

`minion/git.mts` (checkout, commit, push) needed no changes at all — git operations
are host-agnostic; only the two REST-API touchpoints (closed-PR count, PR creation)
were GitHub-specific.

**Why not A:** nothing currently justifies carrying two git-hosting adapters when only
one is in use. If a second target project on a different host appears, that's the
trigger to build the abstraction — not before.

## Consequences

- Every file that named GitHub explicitly needed updating: `src/github/` renamed to
  `src/bitbucket/`, `minion/github-pr.mts` renamed to `minion/bitbucket-pr.mts`, plus
  config, tests, README.md, `.env.example`, and prose mentions in architecture.md and
  CONTEXT.md.
- ADR-001's own text still says "GitHub" — left as written, per this project's
  append-only ADR convention. This document is the current truth; ADR-001 is the
  historical record of the three-source reasoning, which still holds.

## Reversibility

Two-way door. Nothing about the config shape or API calls is a public contract outside
this codebase — swapping hosts again means repeating this same change, not undoing
something structural.

## Revisit trigger

If a second target project on a different host (GitHub, GitLab, or another Bitbucket
workspace with a materially different auth model) needs supporting at the same time as
this one, revisit toward Option A's pluggable interface.
