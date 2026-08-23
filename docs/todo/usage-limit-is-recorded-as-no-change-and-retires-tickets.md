---
type: adr-candidate
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# An exhausted Claude usage limit is recorded as `no_change`, retiring one ticket per dispatch

Minion authenticates against a subscription, not a metered key (ADR-006), so it is subject
to that subscription's rolling five-hour window and its weekly cap — and nothing in the
pipeline knows those exist. There is no check for a `429`, none for the CLI's own
"usage limit reached" message, and `captureImplementOutput` does not even look at the exit
code: it awaits `proc.exited` and discards the result (minion/implement-task.mts:450),
deliberately, so that a missing or broken `claude` binary cannot abort the run.

The consequence is that an exhausted limit is indistinguishable from a successful attempt
that found nothing to fix. `claude -p` fails immediately, `implementTask` returns the error
text as `output` with `costUsd = null` and an empty transcript, and `runMinion` walks the
ordinary path: `hasVerifyScript` is true, `runVerify` runs CGS/webui's literal `true` and
passes, `runPreCommitChecks` finds no hooks (husky sets `core.hooksPath` from its `prepare`
script during `npm install`, which never ran in this attempt) and passes, `hasChanges` is
false — so minion/orchestrate.mts:263 reports `no_change`, posts *"instrumenta made no
change … the project's own checks pass against an unmodified working tree, and the agent
produced no edits"* to Jira, and `hasNoChangeAttempt` (src/foreman/pick.mts:42, ADR-014)
makes that terminal. The ticket is retired permanently on the strength of a conclusion no
agent ever reached, and the Jira comment tells a human the opposite of what happened.

Blast radius is the loop, not the attempt. `runLoop` records the attempt, decrements the
budget and immediately picks again; an iteration with no agent in it costs seconds (clone
from the shared mirror, `verify` = `true`), so on an unlimited budget Foreman burns through
every eligible ticket it can see — in practice the first ~50, since `listBacklog` does not
paginate (docs/todo/jira-backlog-pagination-ignored.md) — retiring each one and commenting
on each one, until nothing is eligible and it falls back to `pollIntervalMs`. A five-hour
window means one such sweep; the weekly cap means the same sweep every time anyone presses
Start, for days. The mid-attempt case is worse in kind rather than in volume: the limit
lands part-way through, the work tree holds half the edits, `hasChanges` is true, and the
attempt commits and opens a PR with an unfinished diff and reports `success` (mirrored to
Done per ADR-007). The only signal is the absence of an agent report, which
`buildPrDescription` renders as *"The agent did not produce a report for this attempt."*

What a human can see after the fact: `Cost: unknown`, `(the agent reported no steps)`, and
Claude Code's own error text, which reaches `tasks.session` and the Jira comment. Worth
fixing on the same pass: that comment path (`noChangeComment` → `commentOnTicket`) is the
one egress that does not run through `redactCredentials` — minion/session.mts:81 and :106
both do, minion/jira.mts does not.

Alternatives considered:

- **Detect it and stop the loop.** Return the exit code from `captureImplementOutput`,
  recognise the limit in the output, and report a distinct outcome that (a) does not comment
  on Jira, (b) is *not* terminal for the ticket, and (c) sets `stopped` in `foreman_state`
  the way an exhausted budget already does (src/foreman/loop.mts:96). Correct on all three
  counts, and the third is what turns 50 lost tickets back into zero. Cost: a new status
  through the DB, the API and the Cockpit, plus a decision on whether `/api/start` may
  restart into a still-exhausted window (it will, and will fail the same way — probably
  acceptable, since the operator is present by definition).
- **Guard on "the agent never ran" instead of on the limit.** An empty transcript with a
  null cost means no agent work happened, whatever the reason — limit, missing binary,
  container misconfiguration. More robust than matching a message string that Anthropic may
  reword, and it covers failure modes we have not seen yet; it cannot say *why*, which
  matters less for the lifecycle decision than for the operator's Jira comment.
- **Probe the remaining quota before dispatching.** Cleanest in principle, but a
  subscription exposes no quota endpoint to check, so this would mean inferring capacity
  from the last attempt's outcome — which is the previous option with extra steps.
- **Make `no_change` non-terminal in general.** Rejected: ADR-014 made it terminal precisely
  because a re-eligible `no_change` ticket is picked again forever. The fix has to
  distinguish the causes, not relax the rule.
- **Do nothing; rely on the operator watching the Cockpit.** The live card does show
  `Cost: unknown` and an empty step list. But the damage is silent, permanent per ticket,
  and fastest exactly when nobody is watching — a limit reached overnight retires the head
  of the backlog before anyone reads a dashboard.

This shares its root with docs/todo/underspecified-ticket-is-indistinguishable-from-no-change.md
— ADR-014 gives an empty diff a single meaning — but it is kept separate because the failure
is external and mechanical rather than a judgement call, and because it needs the loop to
stop, which that one does not.
