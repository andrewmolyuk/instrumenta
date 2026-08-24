# 018 — An upstream API failure is not a conclusion, and a conclusion needs a report

Date: 2026-08-24

## Context

ADR-017 gave an exhausted usage limit its own outcome so it could not be recorded as
`no_change` and retire a ticket. Its Revisit trigger said: *"Revisit sooner if a
`no_change` attempt ever appears with a null cost and an empty transcript — that is this
bug returning through a reworded message."* It came back the next day, through a different
door, and both halves of that sentence were wrong about how it would look.

RPG-5827, recorded by the build that already had ADR-017's fix:

- `status: no_change`, terminal per ADR-014 — the ticket will not be attempted again
- `cost_usd: 0.002208` — not null; the failed call was billed
- three transcript steps: `session started`, the error, `finished` — not empty
- `output`, in full: `API Error: 529 Overloaded. This is a server-side issue, usually
  temporary — try again in a moment. If it persists, check https://status.claude.com.`
- a Jira comment on the ticket saying the project's checks pass against an unmodified tree
  and the agent produced no edits

So Claude Code reported the outage as a well-formed *result*: a `result` event, a cost, a
transcript. ADR-017's own detection missed it (529 is not a usage limit and not 429), and
the fallback ADR-017 named as the robust alternative — no cost, no transcript — would have
missed it too. Pattern-matching the provider's prose was never going to be enough, because
the thing that distinguishes an aborted attempt from a real one is not the wording of the
error.

What does distinguish them is already in the contract. The implement prompt requires the
agent to end with a report in an exact form; `extractReport` looks for its marker;
`buildPrDescription` treats its absence as notable. And ADR-014's whole justification for
making `no_change` terminal is that *the agent concluded* the ticket needs no change. A
conclusion nobody wrote down is not a conclusion.

## Options considered

- **A** — Recognise `API Error: <status>` and report a new `agent_error`, stopping the run.
- **B** — Refuse to record `no_change` for an empty tree with no report, whatever the cause.
- **C** — Retry the agent inside the attempt when the API fails.
- **D** — Record it as `crashed`, a status that already exists.

## Decision

**A and B together.** A names the cause while it is recognisable; B is what makes the fix
survive the next rewording.

- New status `agent_error`, added to `TASK_STATUSES`, the schema's CHECK constraint,
  CONTEXT.md's Status glossary and the Cockpit's filters. Like `usage_limit` it is absent
  from `giveUpAttemptCount`, so the ticket stays eligible.
- `ImplementResult` gains `apiError`, set when the output matches `/^API Error: \d{3}\b/m`.
  Anchored to the start of a line, since the agent's own report may quote an API error it
  read in a log and only the CLI puts one where its result belongs. Deliberately *not*
  guarded on the exit code, unlike `usageLimited` — RPG-5827 showed the CLI reporting this
  as a normal result.
- `runMinion` reports `usage_limit` or `agent_error` before the gate **only when
  `extractReport` finds no report**. That guard replaces the exit code: an attempt that did
  the work and wrote it up goes through the gate as usual whatever the CLI printed
  afterwards, so neither branch can discard real work. Nothing is committed, pushed,
  noted or commented on either path.
- The `hasChanges` branch requires a report too: an empty tree with no report is
  `agent_error`, not `no_change`. This is the half that holds when no pattern matches.
- `runLoop` stops the run on either status (`ABORTED_STATUSES`), and `JiraStatusMirror`
  walks both back out of "In Progress". Stopping rather than continuing is deliberate:
  RPG-5827's failed attempt still took 3m50s, so carrying on spends the backlog at four
  minutes a ticket for nothing, and a human pressing Start once the outage passes is the
  cheapest possible retry.

**Why not D:** `crashed` is in the give-up set, so a 529 would retire the ticket after one
attempt (ADR-015) — the same harm as `no_change`, wearing a more honest label.

**Why not C:** retrying inside the attempt hides the outage from the record, spends the
attempt's timeout on something that may not clear, and answers a question nobody asked —
the operator wants the run to stop, not to grind. Worth reconsidering if 529s turn out to
be brief and frequent rather than occasional.

## Consequences

`agent_error` is broad by design: an API failure, a CLI that dies quietly, and an agent
that returns having done nothing all land there. That breadth is the point of B, and the
cost is that the status alone does not say which — the `output` and the session record do,
and they are one click away in the Cockpit.

The part worth writing down: B changes when `no_change` can be recorded at all. An agent
that genuinely concludes nothing needs changing but omits the required report is now an
`agent_error`, its ticket stays eligible, and the run stops. That is a real regression for
a real case, accepted because the alternative is what this ADR exists to fix — and because
the report is not optional in the prompt, the gate, or the pull-request body.

Attempts already recorded as `no_change` are not revisited. RPG-5827 keeps a status that is
wrong, plus a Jira comment that is wrong, until someone corrects them by hand
(`/api/delete-attempts` makes the ticket eligible again).

## Reversibility

Two-way door. Additive status, same migration path as ADR-017's (`widenTaskStatusCheck`
rebuilds the CHECK constraint and the copy is covered by tests), and the behaviour is three
guarded branches in `runMinion` plus one set in `runLoop`.

## Revisit trigger

The first `agent_error` in production: check that the run stopped, the ticket came back into
Pick, and Jira shows it out of "In Progress". Revisit the decision itself if `agent_error`
starts arriving for a cause that is neither an outage nor a quota — that would mean B is
catching something it should be naming instead.
