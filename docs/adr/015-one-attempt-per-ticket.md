# 015 — One attempt per ticket

Date: 2026-08-22

## Context

ADR-001 set the give-up threshold at 3: a ticket was retried until three attempts had
failed, or three PRs on its branch had been closed.

Two things have changed since. Attempts are expensive and now measurable — the recorded
history before it was wiped showed 114 attempts at $890.47, averaging $7.81 and ranging
to $34.51. And retries are not independent trials: the same model, at the same effort,
reading the same repository, tends to fail the same way. A second attempt mostly buys a
second bill.

## Options considered

- **A** — Keep 3.
- **B** — Lower the threshold to 1.
- **C** — Make it configurable per deployment.

## Decision

**B.** `MAX_ATTEMPTS` (minion/constants.mts) and `GIVE_UP_THRESHOLD`
(src/foreman/pick.mts) both drop from 3 to 1. They are separate constants enforcing the
same rule from either side of the container boundary, and a test asserts they agree.

Two consequences follow directly and are accepted rather than worked around:

- **`failed_verify` and `blocked_no_verify` become unreachable.** Both were reported only
  when `attempt_number < MAX_ATTEMPTS`; at 1, every first attempt is also the final one,
  so a failing gate or a missing gate now reports `given_up`. The *reason* is not lost —
  it is in `output` and in `session` — but the status column no longer distinguishes
  them, and the Cockpit's filters for those two statuses will stay empty. They are left
  in the vocabulary because they become reachable again the moment the threshold moves.
- **One closed PR retires a ticket.** The same threshold governs the Bitbucket count, so a
  human who declines the agent's work once will not have it redone unasked. This is a
  fair reading of a decline, but it is a behaviour change beyond "fewer retries" and is
  worth knowing.

A give-up note is still written and pushed on a failed gate, because the first attempt is
now the last one — so every failing ticket leaves a note in the target repo rather than
only those that failed three times.

**Why not C, configurable:** the threshold is already duplicated across two constants
that must agree; making it an environment variable means a third place it can disagree,
and an operational knob nobody has yet asked to turn. The constants are one edit away if
that changes.

**Why not A:** three attempts at ~$8 to reach the same conclusion three times is the
expensive way to learn nothing. If a retry were likely to succeed where the first failed,
this would be wrong — see the revisit trigger.

## Consequences

- Per-ticket spend on failure drops by roughly two thirds.
- A transient failure — Jira unreachable, a flaky test in the target project, a Bitbucket
  hiccup — now retires the ticket permanently instead of being absorbed by a retry. This
  is the real cost of this decision. `crashed` is in the give-up set, so an infrastructure
  failure is indistinguishable from a bad attempt, and both are terminal.
- Recovering a ticket means a human clearing its attempts (`/api/delete-attempts`).
- Throughput rises: the queue is not spending three slots on tickets that will not pass.

## Reversibility

Two-way door, and trivially so: two constants. Nothing persisted depends on the value, and
tickets already retired can be freed with the existing delete-attempts control.

## Revisit trigger

If tickets that failed once are routinely succeeding when a human re-runs them, retries do
add information and this should go back up — but to 2, not 3, and with the closed-PR
threshold kept at 1. Equally, if transient infrastructure failures turn out to retire real
tickets often, the fix is to stop counting `crashed` toward give-up rather than to raise
the threshold for everything.
