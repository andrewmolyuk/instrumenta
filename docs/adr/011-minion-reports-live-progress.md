# 011 — Minion reports live progress on stderr, for display only

Date: 2026-08-21

## Context

Foreman's Cockpit has a "Minion now" card. Until now it could show two things, because
two things were all Foreman had: the `jira_key` and the dispatch timestamp. An attempt
runs for tens of minutes — on the long end, closer to an hour — and for that entire
window the card said nothing about whether the run was progressing, stuck, or already
burning cost on the wrong file. The only way to find out was to wait for it to finish and
read `tasks.output`, which is to say: find out when it no longer matters.

Two of the three things a human actually wants there — what it's doing, what it has cost
so far, how long it's been going — did not exist anywhere in the system while a Minion was
in flight. Claude Code ran under `--output-format json`, which emits nothing until exit,
and `ProcessMinionRunner` read Minion's pipes only after `proc.exited`.

This runs straight into a decision architecture.md states outright: *"Minion has no API of
its own and doesn't push status anywhere mid-run … There is deliberately no live-progress
callback channel here — that machinery is exactly the piece that never got finished in the
prior art this design was checked against."* That warning is the reason this is an ADR and
not a UI commit.

## Options considered

- **A** — Leave it. The card keeps showing a key and a timestamp; a human who wants detail
  waits for the attempt to end.
- **B** — Show the *previous* attempt's cost and output on the card, labelled as such.
  Needs no new channel at all — the data is already in `tasks`.
- **C** — Give Minion a real status API (a port, or a shared volume Foreman polls) that
  Foreman queries mid-run.
- **D** — A one-directional, display-only progress side-channel on Minion's stderr, which
  Foreman already owns.

## Decision

**D.** Minion writes marker-prefixed progress lines to its own stderr; Foreman reads them
off the pipe it already has and stores them for display only.

Concretely:

- Claude Code runs with `--output-format stream-json --verbose`
  (`minion/implement-task.mts`). The final `result` event carries the same `.result` text
  and `.total_cost_usd` that the single-object `json` form did, so ADR-008's cost capture
  is unchanged.
- Each stream event is summarised into one short line and written to Minion's stderr as
  `@@minion-progress@@ {"line":…,"cost_usd":…}` (`src/minion/progress.mts`). Minion's
  *stdout* stays exactly one `MinionResult` JSON — unchanged, and the reason stderr is
  used at all.
- `ProcessMinionRunner` drains stdout and stderr concurrently while the child runs,
  instead of reading them after exit, and hands decoded progress to an optional
  `onProgress` callback on `MinionRunner.run`. Marker lines are stripped from the captured
  crash/timeout output.
- The loop writes each update to `foreman_state`: `current_output` (a rolling tail of the
  last `CURRENT_OUTPUT_LINES` = 10 lines) and `current_cost_usd`. It also records
  `current_summary`, the task's Jira title, at dispatch — mirroring to "In Progress"
  (ADR-001) drops the task out of the backlog JQL, so it cannot be looked up later.
- All three are cleared when the task clears, and are reported by `GET /api/status` under
  `current`.

**Why not C, a real status API:** this is the machinery architecture.md warns about, and
the warning is right. A port or a shared volume is a new failure mode (bind failures, mount
permissions, a Minion that can't report and a Foreman that can't tell that from a Minion
that's hung), a new thing to configure, and a new thing to secure — all to populate a
tooltip. Stderr is a pipe Foreman opened itself when it spawned the container; it cannot
fail independently of the process it belongs to.

**Why not B, the previous attempt's data:** it answers a different question. "What did the
last attempt cost" is genuinely useful, but it tells you nothing about whether the Minion
running *now* is stuck in a loop, and a card that looks live while showing stale numbers is
worse than one that shows nothing.

The part of architecture.md's warning that still stands, and is preserved here: **Foreman's
control flow does not read this channel.** Pick, the give-up count, the budget, the status
mirror, and the recorded `TaskRow` all still come from the single structured result at
exit. Progress is display-only. If every progress line were dropped, every decision Foreman
makes would be identical — which is precisely what the prior art could not say about its
own channel, and why it had to be finished before anything else could work.

## Consequences

- Minion's contract gains a second, optional output stream. Anything parsing Minion's
  stderr must tolerate marker lines; `decodeProgress` returning null (never throwing) is
  what keeps a target project's own stderr noise from being mistaken for progress.
- `--output-format stream-json` is now load-bearing. If Claude Code changes that format,
  cost capture degrades to null and the card loses its live lines — but the attempt itself
  still runs, because `summarizeEvent` skips shapes it doesn't recognise and the output
  falls back to raw text.
- `foreman_state` gains three nullable columns. Foreman's database is on a persistent
  volume, so `openDb` now carries an additive migration; `CREATE TABLE IF NOT EXISTS`
  alone cannot add a column to a table that already exists.
- The rolling tail is written to SQLite on every progress line. Safe only because Foreman
  dispatches exactly one Minion at a time — a concurrent Foreman would need this rethought.
- The part we'd rather not write down: this is a step down the road architecture.md warned
  about. The discipline that keeps it from becoming that road is the display-only rule
  above, and it is not enforced by anything except review.

## Reversibility

Two-way door. Deleting `src/minion/progress.mts`, the `onProgress` parameter, and the three
columns returns the system to a single result at exit; nothing else reads them. The one
sticky part is `--output-format stream-json`, which ADR-008's cost capture now goes through
— reverting that means reverting to the `json` form in the same commit.

## Revisit trigger

If Foreman ever needs to *act* on progress — killing a Minion that has stopped reporting,
say, or a per-attempt cost ceiling that aborts mid-run — this stops being display-only and
the case for C should be re-argued from scratch, because that is the exact point at which
the prior art's failure mode becomes reachable.
