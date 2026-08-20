# 009 — the verify gate also runs the target project's pre-commit checks, and the commit skips git hooks

Date: 2026-08-20

## Context

Minion's gate was `npm run verify` only (architecture.md step 3). A target project's
`verify` script is not necessarily everything that project enforces at commit time: the
current target repo's Husky `pre-commit` hook runs `npm run lint` (and `npm run test`),
and its `verify` script doesn't cover lint. So `git commit` ran checks that nothing before
it had run.

Three attempts in a row died there, at a combined ~$14 of Claude Code time, with nothing
pushed:

- **KAZ-8390** — verify passed; `pre-commit` (`eslint`) rejected the commit over two
  `no-explicit-any` errors in a test file Claude Code had just written. Claude Code's own
  summary claimed `npm run lint` was clean; it wasn't.
- **KAZ-8739** — same shape, with the hook's ESLint failing on a broken toolchain.
- **KAZ-8701** — one hook further: `commit-msg` (commitlint) rejected the subject, because
  the subject starts with the upper-case Jira key. Same class as the crash already recorded
  in `docs/todo/foreman-container-crashed-after-dispatch-cause-unknown.md`, which lowercased
  the description's first character but can't do anything about the key itself.

In every case the failure surfaced as `crashed` (ADR-001's "exited without reporting a
structured result", reported directly by orchestrate.mts) at the one point in the run where
nothing can be salvaged: after the work was done, before anything was pushed. Retrying
reproduces it exactly, since nothing tells the next attempt what the hook objected to and
the branch has no commit to resume from.

## Options considered

- **A** — leave the hooks at commit time, but classify a commit-time hook failure as
  `failed_verify` instead of `crashed`
- **B** — run the target project's `pre-commit` hook as part of the gate, before
  committing, and commit with `--no-verify`
- **C** — trust Claude Code: instruct it in the prompt to run the project's checks and
  fix them, and change nothing else
- **D** — a per-target-project config value listing the commands the gate should run
  (`MINION_VERIFY_COMMANDS=...`), instead of discovering them

## Decision

**B**, plus C's prompt instruction as the cheap inner loop.

Concretely:

- `runPreCommitHook(workDir)` (`minion/verify-gate.mts`) resolves the repo's hooks
  directory via `git rev-parse --git-path hooks` — which honours `core.hooksPath`, i.e.
  finds Husky's `.husky/_` — and executes `pre-commit` there if it exists and is
  executable, capturing its output under the same cap as `runVerify`. No hook means
  `ran: false, passed: true`: nothing extra to gate on.
- `runMinion` runs it after `runVerify` passes and before `commitAndPush`. A failure takes
  the identical path a failed `verify` takes: `failed_verify`, nothing committed, output
  captured — or, on the final allowed attempt, the give-up note plus `given_up`.
- The caller stages the working tree first (`stageAll`, `minion/git.mts`), because
  `lint-staged`-style hooks only inspect the index.
- `commitAndPush` commits with `--no-verify`. Those checks already ran, once; the commit
  re-running them is pure duplication of the project's whole lint/test toolchain, and the
  note-only commits (`blocked_no_verify`, `given_up`) must land regardless of the state
  Claude Code left the tree in.
- `defaultImplementCommand`'s prompt now tells Claude Code that the project's own checks
  (including its pre-commit hook's) are re-run before its work is committed, that a failure
  wastes the whole attempt, and not to report a check as passing without having run it.

**Why not A:** it turns a crash into a retry, which is a strictly better record, but the
retry is blind — the checks still only run inside a commit that can only fail, so the same
attempt burns another full Claude Code run to rediscover the same lint error. And it keeps
the duplicated run: verify, then the same suite again inside `git commit`.

**Why not D:** it's the same information the repo already states in its own hook, restated
in Foreman's environment, where it silently goes stale the moment the target project
changes its hook. Discovery has no such drift.

## Consequences

- `--no-verify` skips `commit-msg` as well, so commitlint no longer validates Minion's
  commit messages at all. The message is still built to conform (ADR: `fix:`/`chore:`,
  lowercased description), but a rule it trips — the upper-case Jira key in KAZ-8701's
  subject, a header over the length limit, a subject built from a multi-line Jira
  description — now lands in the branch instead of failing the attempt. That is the
  deliberate trade: a non-conforming commit message in a PR a human reviews anyway, in
  exchange for never losing a completed attempt to it.
- The gate can now run the target project's test suite twice per attempt when its `verify`
  script and its `pre-commit` hook overlap (the current target repo's hook runs both lint
  and the full suite, ~1.5 min). Not free: attempts here already hit Foreman's timeout, and
  this makes each one longer. A target project dedupes it by splitting the two roles — a
  fast, staged-only `pre-commit` (lint-staged) and `verify` as the full suite — which is
  what the convention asks for anyway. If that isn't enough, D is still available as an
  opt-out.
- Whatever the hook rewrites while it runs (`eslint --fix`, prettier) is picked up by
  `commitAndPush`'s own `git add -A` and lands in the commit.
- A hook that does something other than check (pushes, mutates state, prompts) now runs
  once per attempt where it previously ran once per commit. Both are inside Minion's
  container (ADR-002), which is what bounds this.

## Reversibility

Two-way door. Deleting `runPreCommitHook` and the `--no-verify` flag restores the previous
behaviour exactly; nothing persisted depends on either. No new status, no schema change —
a pre-commit failure reuses `failed_verify`.

## Revisit trigger

An attempt that fails its gate for a reason the target repo's `pre-commit` hook doesn't
cover (a `pre-push` hook, a CI-only check), or the duplicated suite run pushing attempts
into Foreman's timeout — either one reopens whether the gate should be discovered from the
hooks or declared per project (option D).
