# 019 — A failed gate check is run a second time before it retires a ticket

Date: 2026-08-24

## Context

ADR-009 has Minion run the target's own `verify` script and its `pre-commit` hook itself,
before committing, so a failure is reported cleanly instead of crashing the commit. ADR-015
lowered the give-up threshold to one attempt, which makes any gate failure terminal: the
ticket is retired and not attempted again.

Those two decisions compose badly against a flaky test suite, and RPG-6062 is what that
looks like. The agent fixed `apps/webui/public/cgi/download-mibs.cgi` — a bash CGI script
in the legacy AngularJS app — reproduced the hang locally, and ran the target's own checks
itself: `npm run test`, 2m15.8s, `Tasks: 1 successful`. Two minutes later Minion's gate ran
the same command and got:

```
FAIL tests/entities/branding-info/branding-info.spec.ts > fetches branding.yml, parses it, …
FAIL tests/entities/deviceConfig/deviceConfig.spec.ts  > fetches device-cfg.json, resolves …
FAIL tests/entities/deviceConfig/deviceConfig.spec.ts  > shares the same reactive state …
     AssertionError: expected "vi.fn()" to be called 1 times, but got 5 times
Test Files  2 failed | 44 passed (46)
```

Three cases in `apps/webui2`, in a workspace the diff does not touch, all of them about
module-level state leaking between tests — a mock counting five calls where it expected one.
The same suite passed for the agent and failed for the gate on the same tree. The attempt
was recorded `given_up`, the ticket left the backlog for good, and $1.80 of finished work
went with it (recoverable only because `commitAndPush` stages everything, so the fix is
sitting in the give-up commit on the branch).

The flakiness itself belongs to the target project and is theirs to fix. What is Instrumenta's
is how much a single flake costs here.

## Options considered

- **A** — Run a failed gate check once more; give up only if it fails again.
- **B** — Make a gate failure non-terminal, so the ticket is redispatched (amend ADR-015).
- **C** — Compare the failing tests against the diff and ignore failures it cannot reach.
- **D** — Leave it; flaky tests are the target's problem.

## Decision

**A.** `runGateWithRetry` in `minion/orchestrate.mts` wraps each half of the gate: run it,
and if it failed, run it exactly once more. Both halves are covered — `verify` and the
`pre-commit` hook. Nothing else changes: the agent is not re-run, since its work is already
in the working tree, and a check that passes first time is still run once.

A failure that survives the retry has `(this check was run twice — it failed both times, so
it is not a flake)` appended to the captured output, so the record distinguishes a real
failure from the case this ADR is about.

**Why not B:** a redispatch costs another full agent run — ADR-015 lowered the threshold to
one attempt precisely because "the same model rereading the same code tends to fail the same
way, so a retry mostly buys a second bill". Here the work is already done and only the check
is in doubt, so re-running the check is the cheap half of B without the expensive half.

**Why not C:** it needs a reliable mapping from a diff to the tests it can affect, across
workspaces and toolchains Instrumenta knows nothing about. Wrong in the unsafe direction
(ignoring a failure the diff did cause) is much worse than the problem it solves.

## Consequences

A genuinely failing gate now takes twice as long to reach that verdict — about five minutes
instead of two and a half on this target. Paid only on the failure path.

A flake that fails twice in a row still retires the ticket. This buys one retry, not
reliability; a suite that fails half the time will still lose tickets, and the fix for that
is in the target project.

The retry cannot tell a flake from a genuine failure that was fixed in between (nothing
changes the tree between the two runs, so this is theoretical) — and, more usefully, it
cannot tell a flake from a test that fails only under load. Both come out as "passed on the
second run", which is the outcome we want either way.

## Reversibility

Two-way door. One helper and two call sites in `runMinion`.

## Revisit trigger

A `given_up` whose output carries the failed-twice note but whose failing tests still have
nothing to do with the diff — that would mean one retry is not enough for this target's
suite, and the answer then is to press the target project about its tests rather than to
retry a third time.
