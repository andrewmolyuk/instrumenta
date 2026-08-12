# Instrumenta — vision

## Why it exists

Instrumenta is a pipeline of agents — one, for the MVP — that autonomously works a
target project's issue queue: it picks up the next task or bug from an external source
(Jira, to start), implements or fixes it in that project's codebase, opens a PR, and
moves to the next task. When the queue is empty, it waits and checks again
periodically. The point is continuous, unattended operation against a project someone
else owns — not one-off help inside a session a human has to keep driving.

## The loop

1. **Trigger** — the previous task finished, or a poll interval elapsed since the last
   check found nothing to pick.
2. **Pick** the next task from the task provider (Jira, for the MVP).
3. **Solve** it in the target project: implement, verify, commit, open a PR. If it can't
   be finished, that's a real outcome, not a silent failure — see
   [ADR-002](adr/002-foreman-minion-execution-boundary.md) and
   [ADR-001](adr/001-task-state-three-sources.md) for what happens after repeated
   failure.
4. **Leave knowledge** behind — ADR candidates, glossary terms, todo/bug entries, in the
   target project itself, alongside the code they're about — so the next task is faster
   than this one was.
5. Wait for the next trigger. If the queue was empty, that means polling again later
   rather than sitting idle indefinitely.

## Task provider

The queue is not one hardcoded source. A provider aggregates tasks from wherever they
legitimately come from — Jira first, with room for others (a different tracker,
`docs/todo/`-style local entries) added later as the need appears. The loop only deals
in "the next task"; it doesn't need to know which source it came from.

## Human control

Two separate channels, not one:

- **Instrumenta's own control surface** — stop, resume, point it at a specific task
  next, or cap how much it does in one go, without redesigning anything. Concretely:
  **stop** (don't pick anything new), **continue** (resume normal operation),
  **start with a specific ticket** (work this one next, bypassing normal ordering),
  and an optional **budget** (do at most N tasks, then stop on its own). See
  [ADR-003](adr/003-foreman-daemon-trigger-control.md) for how this is exposed and what
  it does and doesn't interrupt.
- **Everything else goes through the systems the human already uses.** Reordering or
  cancelling a task happens in Jira, the same way it always would. Adding a constraint,
  a decision record, or a new gate a task must pass happens by editing the target
  project directly — the next task picked up reads whatever is currently there.
  Instrumenta does not invent a separate channel for either of these; there's nothing
  to redesign when a human wants to add a gate or a piece of knowledge, because it was
  never instrumenta's to own in the first place.

## Success signal

Checked once, 30 days after the loop is running in production against a real
backlog — not before, and not left unchecked indefinitely:

- **% of tasks reaching a merged PR** — throughput baseline from the target project's
  own history (direct-to-git commits, no PR step yet): 1,260 distinct tickets closed
  over Jan 2020–Jun 2025 (66 months), ~19/month, 97% of them 1–2 commits — the task
  shape the MVP can realistically attempt. Completion/abandonment rate itself isn't
  in git history (a ticket a human started and dropped leaves no commit) — that
  baseline still needs Jira's own status history, not just commits.
- **Hours saved** — rough floor from the same history, across all 3,546 commits
  (not just ticket-linked ones — untagged commits made the same day as ticket work
  are still plausibly part of it): summing gaps between commits made on the same
  calendar day (ignoring overnight gaps) over Jan 2020–Jun 2025 and dividing by the
  1,260 tickets gives **~1.8–2.7h/ticket**, depending on whether same-day gaps over
  4h are trimmed as context-switches rather than continuous work. Still a lower
  bound, not a real average — a ticket closed in a single commit that day with no
  other commits around it contributes zero measured time even though work clearly
  happened.
- **Cost vs. a human doing the same work** — baseline: ~30,000 ILS/month average
  senior developer salary in Israel across 2020–2025 (extrapolated from ~25–28k in
  2020–2022 to ~35k+ by 2024 — public sources give the trend, not a clean
  year-by-year series) over 186h = 161 ILS/h, × the 1.8–2.7h/ticket estimate above
  → **~290–435 ILS/ticket** human cost. Compared against Claude API cost per
  ticket, which is still TBD — no real runs yet to measure it from.

Baselines above are final — the full 66-month history available from the target
project, not to be recomputed on a narrower window. Only the Claude-side cost per
ticket stays open, pending real runs.

Guardrails — must not get worse even if the above look good: give-up rate (the % of
tasks hitting the 3-attempt threshold in [ADR-001](adr/001-task-state-three-sources.md))
staying low, and the post-merge revert/hotfix rate on instrumenta's PRs staying
comparable to human-authored ones.

## Scope now (MVP)

- **One target project, one agent, no parallelism.** A single agent instance works a
  single project's queue serially. Multiple target projects, or multiple tasks at once
  within one project, are out of scope for the MVP.
- **One task source.** Jira is the only task provider for the MVP; the provider
  abstraction exists so more sources can be added later without changing the loop.
- **PR is the endpoint.** The agent opens the PR; merging into the target project's
  branch stays a human action. Autonomy stops at the PR, for now.
- **The target project supplies its own gate.** Before anything is committed, solve
  looks for a verify mechanism already defined in the target project. If there isn't
  one, instrumenta does not invent its own definition of "done" — it stops and says so.
  Instrumenta never modifies the target project except through the same kind of PR a
  human contributor would open.
- **Runs as two containers**, not one — a long-running control process and a disposable,
  isolated execution sandbox spun up per task. See
  [architecture.md](architecture.md) for the full shape and
  [ADR-002](adr/002-foreman-minion-execution-boundary.md) for why they're split.
