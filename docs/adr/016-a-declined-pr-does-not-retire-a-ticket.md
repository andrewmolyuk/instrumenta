# 016 — A declined PR does not retire a ticket

Date: 2026-08-23

## Context

ADR-001 made the target repo's closed-PR history one of three independent give-up
sources. ADR-015 dropped the threshold to 1 and named the consequence outright: "one
closed PR retires a ticket… a human who declines the agent's work once will not have it
redone unasked."

Run against the real backlog, that rule stopped the pipeline dead. Observed on
2026-08-23, with `stopped=0`, `budget=null` (unlimited) and an empty `tasks` table:

- The configured JQL matches 245 tickets.
- `JiraTaskProvider.listBacklog` returns one page — the first 50 — and ignores
  `nextPageToken`, so those 50 are the only tickets Pick can ever see.
- All 50 have a DECLINED PR on a branch named after their `jira_key`.

So `pick()` rejected all 50 on the Bitbucket half of the give-up check, returned `null`,
slept the poll interval, and repeated — indefinitely, on an unlimited budget, with a
Cockpit showing a 245-ticket queue and nothing in flight. Reported as "when budget
unlimited no ticket is taken into the work"; the budget was never involved.

The rule itself is what failed, not just its interaction with the unpaginated backlog.
Early declines are how this project actually runs: a PR is declined because the branch
was noisy, the ticket was misread, the agent was pointed at the wrong module — decisions
about one attempt's diff. Treating each as a permanent verdict on the *ticket* means the
backlog shrinks by one every time a human reviews and says no, and it never grows back:
`deleteAttempts` clears SQLite and has no reach into Bitbucket, so the only route back
was queueing the ticket by name, one at a time, forever.

## Options considered

- **A** — Keep the rule; paginate the backlog so Pick can walk past the declined head.
- **B** — Stop counting declined PRs toward give-up. Foreman's own SQLite becomes the
  only give-up source; OPEN and MERGED still block a dispatch.
- **C** — Keep counting them, but at a threshold of their own (e.g. 3 declines retires).

## Decision

**B.** `isGivenUp` (src/foreman/pick.mts) reads `giveUpAttemptCount` and nothing else:

```ts
export function isGivenUp(db: Database, jiraKey: string): boolean {
  return giveUpAttemptCount(db, jiraKey) >= GIVE_UP_THRESHOLD
}
```

`closedPrCountForBranch` is deleted along with its tests — it had no other caller. This
amends ADR-001's three sources (the third is no longer a give-up input) and ADR-015's
"one closed PR retires a ticket" (no number of closed PRs retires one).

Unchanged: `hasBlockingPrForBranch` and `BLOCKING_STATES` still cover OPEN and MERGED, at
Pick, at `pickSpecific`, and at `/api/queue-ticket`. An open PR is unreviewed commits a
redispatch would push over; a merged one is work already delivered. DECLINED now means
nothing to Foreman at all.

**Why not A:** pagination is a real gap and still worth fixing, but it only buys time
here. It would have moved Pick to ticket 51 of 245 and left the same rule retiring
tickets one review at a time until the backlog was exhausted for good.

**Why not C:** a threshold implies declines accumulate toward a verdict. They don't
accumulate against the same diff — after a decline the agent re-runs from the same
branch and can produce a materially different one. If repeated declines on one ticket do
turn out to be self-similar, the cheap fix is the revisit trigger below, not a count.

## Consequences

- **A declined ticket goes straight back into the backlog.** With SQLite empty of failed
  attempts for it — which is the case for a ticket whose attempt *succeeded* and whose PR
  a human then declined — it becomes eligible on the very next Pick, at roughly $8 an
  attempt. Nothing rate-limits that beyond the budget control and Jira's own query: a
  human who declines a PR should expect the ticket back unless they also take it out of
  the JQL.
- **Give-up now rests entirely on Foreman's SQLite volume.** ADR-001 chose three sources
  precisely so losing that volume degraded give-up rather than erasing it; that backstop
  is gone. Losing `/data/foreman.db` now makes every ticket in the backlog eligible again.
  Accepted: the backstop was retiring live work, which is a worse failure than the one it
  guarded against.
- **`deleteAttempts` is once again a complete undo.** Clearing a ticket's attempts clears
  all of give-up, so ADR-015's "recovering a ticket means a human clearing its attempts"
  is now literally true.
- **One less Bitbucket call per ticket examined at Pick.** Pick made two (declined count,
  blocking check); it now makes one.
- **Minion still resumes the declined branch.** `cloneAndBranch` reuses an existing remote
  branch whenever there is no *open* PR, which now includes the declined case — so a
  re-run continues from the commits a human just rejected and may well conclude
  `no_change` (ADR-014, terminal). Left as-is deliberately: branching fresh from the base
  tip instead would collide non-fast-forward against that branch, which is the collision
  the reuse exists to avoid. This is the next thing to fix if re-runs after a decline turn
  out to go nowhere, and it is a separate decision.

## Reversibility

Two-way door. One function and its tests; nothing persisted encodes the old rule, and the
Bitbucket query it used is four lines to restore from this file's history.

## Revisit trigger

If a ticket is observed cycling — dispatched, PR declined, redispatched, declined again —
without the diff changing meaningfully between attempts, then declines *are* self-similar
and something has to bound them: most likely recording the decline as an attempt in
SQLite, where the existing threshold already applies, rather than reviving the Bitbucket
count. Equally, if re-runs after a decline routinely report `no_change`, fix the branch
reuse named above before touching this decision.
