# 007 — `success` mirrors stay "In Progress", not "Done"; pick skips branches with an open PR (amends ADR-001)

Date: 2026-08-16

## Context

ADR-001 decided Foreman mirrors "In Progress" on dispatch and "Done" on `success`,
write-only, purely for human visibility. Running this against a real target project
surfaced a problem that isn't about the mirror being write-only — it's about what
`success` actually means. A `success` result only means Minion opened a PR that passed
`verify`; no human has reviewed or merged anything yet. Mirroring "Done" at that point
is simply wrong: the ticket reads as finished before anyone looked at the PR.

That wrongness compounds once the target project's Jira query does what
architecture.md always assumed it would — exclude Done tickets (`... AND statusCategory
!= Done`). Between a PR being opened and a human actually merging it and moving the
ticket to Done themselves, the ticket's Jira status has nowhere else to go: it's not
Done (nothing marks it that, correctly, per this decision), but it's also not
excluded by anything else. `pick()` (ADR-001's eligibility check) only excludes on
"given up" — 3+ `failed_verify`/`crashed`/`timeout` attempts, or 3+ *closed* PRs — it
has no notion of "already succeeded, awaiting review." Left alone, Foreman would
redispatch the same ticket, redo the implementation from scratch, and fail pushing to
a branch that already has an open PR on it — observed directly: KAZ-8280 succeeded,
then got redispatched and crashed on a non-fast-forward push against its own
already-open branch.

## Options considered

- **A (chosen)** — `success` mirrors nothing beyond what `onDispatch` already set
  ("In Progress"); `onComplete` becomes a full no-op, for every attempt status, not
  just the four ADR-001 already left unmapped. Separately, `pick`/`pickSpecific` skip
  any candidate whose branch already has an OPEN Bitbucket PR, via a new
  `hasOpenPrForBranch` (same module and shape as the existing `closedPrCountForBranch`).
  "Done" becomes exclusively something a human sets, after actually merging.
- **B** — keep mirroring "Done" on success, but only after confirming the PR is
  merged. Rejected: Foreman has no polling loop watching PRs after opening them —
  dispatch is synchronous and finishes the moment Minion exits. Adding one is a much
  bigger change, and blurs a boundary vision.md draws deliberately: a human reviewing
  and merging is outside Foreman's automation, not a step it waits on.
- **C** — leave the mirror as ADR-001 specified it, and treat the redispatch loop as
  purely a target-project JQL configuration problem (add the status filter and stop
  there). Rejected: even with the JQL "fixed," "Done" on an unmerged PR is still
  factually wrong, and the redispatch loop would just resurface the moment a real
  reviewer takes more than a poll cycle to get to the PR — which is the normal case,
  not an edge case.

## Decision

- `src/foreman/jira-status-mirror.mts`: `onComplete` no longer transitions anything on
  `success`. It's a no-op for every `TaskRow.status` now. A ticket stays at whatever
  `onDispatch` left it ("In Progress") until a human moves it to Done themselves.
- `src/bitbucket/closed-prs.mts`: new `hasOpenPrForBranch(config, branchName,
  fetchImpl?)`, same shape as `closedPrCountForBranch` — `state="OPEN"` instead of
  `state="DECLINED"`, returns a boolean.
- `src/foreman/pick.mts`: both `pick` and `pickSpecific` now route through a shared
  `isEligible` check — `isGivenUp` (unchanged) **and** not `hasOpenPrForBranch`. An open
  PR excludes a task from being picked, independent of Jira status and independent of
  the give-up count.

**Why not B:** correct in principle — "Done" really should mean merged — but requires
Foreman to take on watching external review state it currently has no mechanism for
and vision.md deliberately keeps outside its automation. Bigger change, different
tradeoff, not what this fix needs.

**Why not C:** doesn't fix the actual defect (a ticket reported "Done" when it isn't),
only papers over the one symptom (the immediate redispatch loop) that happened to be
visible first.

## Consequences

- One more Bitbucket read call per pick candidate — same cost class ADR-001 already
  accepted for `isGivenUp`'s own closed-PR check ("negligible at MVP scale").
- A human must now transition a ticket to Done by hand after merging; Foreman never
  does it automatically. This doesn't change what Foreman *observes* (it never watched
  merges before either), only that the Jira mirror no longer papers over that gap with
  an incorrect auto-Done.
- Any workflow relying on the old auto-Done-on-success mirror loses it, silently — same
  acceptable-breaking-change reasoning ADR-005 used for its own rename, at this
  project's current single-operator scale.
- `docs/adr/001-task-state-three-sources.md`'s Decision section still says "'Done' on
  success" — left as written, per this project's append-only ADR convention. This
  document is the current truth for what the mirror does; ADR-001 remains the record of
  why the mirror exists and what it's authoritative for (nothing — it's write-only).

## Reversibility

Two-way door. Pure mirror-logic and pick-eligibility behavior — no schema or API
contract shape changed.

## Revisit trigger

If Foreman ever gains a way to observe PR merges itself (a webhook, a polling job),
revisit whether "Done" should be mirrored automatically again at that point, instead of
requiring a human to set it by hand.
