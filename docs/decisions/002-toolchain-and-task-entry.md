# 002 — Task entry, repository layout, and toolchain

Date: 2026-08-10. Taken together while scaffolding the repository, before any product
code exists.

---

## Decision: tasks enter through GitHub Issues

**Context:** The pipeline is "issue to verified PR", and the entry point was unspecified —
the first framing said Jira. For a single-maintainer public repository that means an
external API, a token to hold, and ticket-writing discipline maintained in a second
system, all to carry a title and a description.

**Options considered:** GitHub Issues · Jira · Markdown task files in the repository.

**Choice: GitHub Issues.** Issues live where the code and the PRs already live, so the
whole loop closes inside one system and one credential. `gh` is installed and
authenticated, so there is nothing to build before the first task can be read. Markdown
task files were cheaper still but give the Cockpit no queue or status to read from
outside the repository.

**Reversibility:** two-way door if the orchestrator reads tasks behind a small interface
rather than calling `gh` from everywhere. That constraint is the price of the choice, and
it is worth paying.

**Revisit trigger:** work arriving from somewhere that is not this repository.

---

## Decision: Bun workspaces with turbo

**Context:** The orchestrator and the Cockpit are separate runtimes that will share types
and the knowledge model.

**Options considered:** Bun workspaces + turbo · one flat Bun package.

**Choice: workspaces + turbo**, matching the layout used across my other repositories, so
one habit covers all of them. `apps/*` and `packages/*` are declared but empty — turbo
has nothing to orchestrate until the first member lands, and that is expected.

**Reversibility:** two-way door, and cheap in this direction: collapsing to one package
later is easier than splitting one apart.

---

## Decision: oxlint, oxfmt, Vitest, TypeScript 7

**Context:** The repository's own thesis is deterministic gates, and it had none. Every
line of `CLAUDE.md` about running checks was unenforceable.

**Choice:** oxlint and oxfmt (the same pair used across my other repositories), Vitest as
the runner, and `tsc --noEmit` for types — wired into a `check` script and into CI as four
separately-named steps, so a red run says which gate failed without opening the log.

**On TypeScript 7:** my other repositories pin TypeScript to `^6`, because `vue-tsc`
cannot bootstrap against the Go-based rewrite. Nothing here uses `vue-tsc`, so that
constraint does not apply and this repository takes `^7.0.2`. Verified: `tsc --noEmit`
passes on the existing hooks. Faster type checking matters for a gate that runs on every
change.

**Revisit trigger:** anything landing here that depends on `vue-tsc` or another tool that
cannot bootstrap against TypeScript 7 — at that point pin back to `^6`.

---

## Consequence: the hooks are now tested

The two `.claude/hooks` guards were previously verified with an ad-hoc shell harness that
lived nowhere. They now have 26 Vitest cases covering the shell-parsing helpers and both
hooks end to end, including the regression that started it: `git rev-parse --abbrev-ref
HEAD` fails in a repository with no commits, which would have silently disabled the
main-branch guard at exactly the moment of the first commit. The end-to-end cases run
against throwaway `git init` repositories, so the branch-dependent behaviour is
deterministic rather than dependent on whatever branch the suite happens to run on.
