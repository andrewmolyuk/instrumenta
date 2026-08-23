# 017 — An exhausted usage limit is its own outcome, and it stops the run

Date: 2026-08-23

## Context

Minion authenticates Claude Code against a subscription rather than a metered API key
(ADR-006), so the subscription's rolling five-hour window and its weekly cap are ordinary
operating conditions, not exotic failures. Nothing in the pipeline knew they existed:
there was no check for a `429`, none for the CLI's own "usage limit reached" message, and
`captureImplementOutput` read the child's exit code and discarded it — deliberately, so
that a missing or broken `claude` binary could not abort a run.

The result was that an exhausted limit was indistinguishable from a successful attempt
that found nothing to fix, and took the worst path in the vocabulary:

- `claude -p` fails at once; `implementTask` returns the error text, a null cost and an
  empty transcript.
- `hasVerifyScript` is true and `runVerify` passes — CGS/webui's `verify` script is the
  literal string `true` (ADR-009's gate, discussed in minion/verify-gate.mts).
- `runPreCommitChecks` finds no hook: husky installs `core.hooksPath` from its `prepare`
  script during the target's `npm install`, which an attempt with no agent never ran.
- `hasChanges` is false, so the attempt reported `no_change` — terminal after one attempt
  by ADR-014 — and posted a Jira comment saying the project's checks pass against an
  unmodified tree and the agent produced no edits.

So a ticket was retired permanently, on a conclusion no agent ever reached, with a comment
telling a human the opposite of what happened. And the loop kept going: an iteration with
no agent in it costs seconds, so on an unlimited budget Foreman would work through every
ticket it could see — in practice the first ~50, since `listBacklog` does not paginate —
retiring each one. A five-hour window means one such sweep; a weekly cap means one per
Start, for days.

## Options considered

- **A** — Detect it, report a distinct non-terminal status, and stop the loop.
- **B** — Detect "the agent never ran at all" (empty transcript, null cost) rather than the
  limit specifically, and treat that as the non-terminal outcome.
- **C** — Leave it; rely on the operator noticing `Cost: unknown` and an empty step list on
  the Cockpit's card.
- **D** — Make `no_change` non-terminal in general, so nothing is lost permanently.

## Decision

**A.** A usage limit is a fact about the subscription, not about the ticket, so it gets its
own status and ends the run rather than the ticket.

- New status `usage_limit`, added to `TASK_STATUSES` and the `TaskStatus` union
  (src/db/index.mts), the schema's CHECK constraint (src/db/schema.sql — `openDb`'s
  existing `widenTaskStatusCheck` rebuilds `tasks` on an older database), CONTEXT.md's
  Status glossary, and the Cockpit's filter and tag styling (src/foreman/ui.html).
- `ImplementResult` gains `usageLimited`, set in `captureImplementOutput` when the child
  exits non-zero **and** its output matches `/usage limit|rate limit|too many requests|\b429\b/i`.
  The exit code is the guard, not decoration: an attempt that finished normally exits 0, so
  a report discussing the *target's* rate limiting can never be read as our own exhausted
  quota, and no real work is ever discarded by this branch.
- `runMinion` reports `usage_limit` immediately after `implementTask`, before the gate:
  nothing is committed, nothing is pushed, no note is written, no PR is opened, and — the
  point of the whole change — no Jira comment is posted. The session record is still built
  and returned, so the attempt is auditable.
- `usage_limit` is absent from `giveUpAttemptCount`'s status list and is not `no_change`,
  so Pick still considers the ticket eligible.
- `runLoop` sets `stopped` and breaks when it records a `usage_limit` row — the same way an
  exhausted budget stops it (ADR-003) — before the mirror call, so a Jira failure landing
  in the iteration's catch still leaves the loop stopped, and before the budget decrement,
  so an attempt that never ran does not spend one.
- `JiraStatusMirror.onComplete` moves the ticket back to the first of `To Do`, `Open`,
  `Backlog` the workflow offers. This is a narrow exception to ADR-007's "onComplete is a
  no-op for every status": `onDispatch` has already moved the ticket to "In Progress",
  which drops it out of the target's backlog JQL, and ADR-001 makes that live query the
  authority on eligibility — so without walking the transition back, "the ticket is not
  retired" would be true only inside Foreman's own database. Best-effort and name-based
  like every other transition here; a workflow offering none of those names leaves the
  ticket in "In Progress" for a human.

**Why not B:** it is the better *guard* and a worse *report*. "The agent never ran" cannot
say why, and the two things Foreman must do differ by cause — a missing binary or a broken
container should not silently un-retire tickets and stop the run on a schedule nobody can
predict, while a usage limit should. B also cannot be checked against reality: we have
observed the limit's wording, and not observed what an empty transcript means in general.
The narrow rule ships now; B remains the obvious hardening once there is a second cause
worth naming, and the exit-code guard is already the half of B that matters.

## Consequences

The text match is on Anthropic's wording. If the CLI rewords its message, detection stops
working and the old behaviour returns — `no_change`, a misleading Jira comment, and a
retired ticket per dispatch. That is the part worth writing down: the failure mode of this
decision is silent and identical to the bug it fixes. The exit-code guard means a rewording
costs detection, never a false positive on real work, but nothing here alarms on "we
stopped detecting something."

A limit reached *mid*-attempt now discards whatever the agent had already edited: the tree
is not committed, so partial work is lost rather than shipped as a finished PR. That is the
intended trade — an unfinished diff reported as `success` was the worse of the two — but it
does mean paying for the tokens twice when the ticket is re-attempted.

`/api/start` will happily restart into a still-exhausted window and stop again after one
dispatch. Acceptable: the operator is present by definition, and the Cockpit now shows a
`usage_limit` attempt as the reason.

Everything else in the pipeline still treats a nonzero exit from `claude` as non-fatal, so
this closes one cause and leaves the general "the agent produced nothing" case exactly as
it was.

## Reversibility

Two-way door. The status is additive, the migration copies rows rather than dropping them
(covered by a test that opens a database built with the previous release's constraint), and
an older build reading a widened database is unaffected — the constraint only ever accepts
more. Reverting means deleting a branch in `runMinion`, one in `runLoop`, and the mirror's
exception.

## Revisit trigger

The first `usage_limit` attempt observed in production: check that the Jira transition
actually moved the ticket back (the three status names are a guess about the target's
workflow), and that the loop stopped where the Cockpit says it did. Revisit sooner if a
`no_change` attempt ever appears with a null cost and an empty transcript — that is this
bug returning through a reworded message, and the signal to implement option B.
