---
type: adr-candidate
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# An honest "I could not tell what was being asked" is recorded as `no_change` and retires the ticket

minion/agent-home/CLAUDE.md:117 tells the agent that if a ticket is too ambiguous to act on
at all, it should say *that* rather than invent a plausible-looking change. An agent that
obeys leaves a clean tree, so `runMinion` takes the `hasChanges` branch
(minion/orchestrate.mts:263) and reports `no_change`; `noChangeComment` (line 168) then
posts *"instrumenta made no change … The project's own checks pass against an unmodified
working tree, and the agent produced no edits"*, and `hasNoChangeAttempt`
(src/foreman/pick.mts:42, per ADR-014) makes that terminal — the ticket never comes back.
"The ticket was unreadable" and "nothing needed fixing" therefore land in the same terminal
status under a Jira comment that reads as the second, and the ticket is closed out on the
strength of a conclusion the agent never reached. Guessing pays better: it produces a PR a
human actually reviews, and ADR-016 now returns a declined ticket to the backlog. RPG-6012
is what that incentive buys — a $8.51 13-file diff whose own report asks a human to check
the premise before the details.

Alternatives considered:

- **A sentinel in the agent's report** (e.g. `<!-- underspecified -->`) that switches
  `noChangeComment`'s wording and exempts the attempt from ADR-014's terminal rule. Smallest
  change, no schema movement, and the agent already writes a structured report — but it
  makes a lifecycle decision depend on the agent emitting an exact string, which is the
  same fragility `extractReport` already lives with.
- **A distinct `underspecified` status** alongside `no_change`. Honest in the database and
  reportable in the Cockpit, at the cost of a schema change, a new eligibility branch, and a
  decision about whether it counts toward give-up (it should not — nothing was attempted).
- **Route it to the ticket as a question and leave the ticket eligible.** Closest to what a
  human would do, but with ADR-015's one-attempt rule it means the ticket is re-dispatched
  against an unchanged description and reaches the same conclusion at full cost, forever.
- **Do nothing and rely on the comment's own hedge** ("this is the agent's conclusion, not a
  verified one"). Defensible — the wording is careful — but the reader still sees "checks
  pass, no edits needed" on a ticket nobody looked at, and ADR-014's Decision assumes one
  meaning for an empty diff, so leaving it means leaving that assumption unstated.

Whichever way this goes it amends ADR-014, so it wants a numbered ADR rather than a patch.
