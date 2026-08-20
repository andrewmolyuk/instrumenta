# 010 — Start refills an exhausted budget from the capacity it was last set to

Date: 2026-08-20

## Context

ADR-003 gives Foreman an optional budget: "do at most N tasks, then stop." It's stored in
`foreman_state.budget`, decremented once per completed dispatch, and reaching zero sets
`stopped` — and it's *persisted*, on the same volume as attempt history.

Nothing said what a budget means across runs, and the implementation answered it by
accident. `runLoop` read `budget` once at entry and only checked it *after* a dispatch, so
a loop entered with a persisted 0 dispatched one task, decremented to -1, and stopped
again. Every Start on a spent budget bought exactly one more attempt — reported live as
"the system stops after the first run," and confirmed by test: `budget = 0` in the DB
produced one dispatch.

Two related config defects came out of the same investigation: `optionalInt` turned
`FOREMAN_BUDGET=` (set but empty, which is how "no budget" gets written in an .env file)
into `Number('') === 0` — a real budget of zero, i.e. the same one-dispatch-then-stop
behaviour, from a line a human reads as "unset". And a non-numeric value became `NaN`,
which for a budget silently means unlimited (`NaN <= 0` is false) and for a timeout means
every Minion is killed at once.

## Options considered

- **A** — Start refills `budget` from `budget_total` when the counter is exhausted
- **B** — Start refuses (409) while the budget is exhausted; the human sets a new budget
  or clears it first
- **C** — Start clears the budget to `null` (unlimited)
- **D** — leave the semantics alone and only move the check before the dispatch, so an
  exhausted budget stops immediately with no dispatch at all

## Decision

**A**, with D's fix underneath it.

- `POST /api/start` refills `budget` from `budget_total` when `budget <= 0` and
  `budget_total > 0`, and reports what it did: `{stopped, budget, budgetRefilled}`. A
  budget with capacity left, and an unlimited (`null`) budget, are untouched.
- `runLoop` checks the budget *before* dispatching as well as after decrementing, so a
  loop that somehow starts exhausted (nothing to refill from) stops without spending an
  attempt.
- `POST /api/budget` rejects anything that isn't a positive integer or `null`: a stored 0
  is indistinguishable from an exhausted budget, which Start would then try to refill from
  a capacity of 0 forever. "No budget" is `null`.
- `optionalInt` (config.mts) treats unset and empty-after-trim identically as "not
  configured", and throws on a non-numeric value instead of passing `NaN` down.

`budget_total` already existed for the UI's "X of Y used" display; this makes it the
capacity of record, which is what the name always implied.

**Why not B:** it's the safer reading — nothing re-authorises spend without a human
touching the budget itself — and it stays literal to ADR-003, where the budget is a
one-shot cap. It was rejected because Start is *already* the human authorising a run: this
project boots stopped precisely so that dispatching is never implicit
(`docs/todo/foreman-boots-stopped-enforced-at-composition-root.md`). Making the same human
clear a field before the button they just pressed does anything adds a step without adding
a decision. B remains the right answer if budgets ever become a spend cap rather than an
attempt cap.

## Consequences

- Start on an exhausted budget now spends up to N more attempts, where before it spent
  exactly one. That is the intended behaviour, but it is a real increase in what one
  button press can cost — the response and the UI's budget stat are the only signals, so
  a human who forgot a budget of 20 was set will find out from the attempt history.
- "Budget" now means "at most N tasks per run," where a run is one Start-to-stop stretch,
  not "at most N tasks ever." CONTEXT.md's glossary is updated to say so.
- A budget of 0 is no longer representable through the API. Nothing reads a stored 0 as
  meaningful any more, so an old DB carrying one behaves as exhausted-and-refillable
  (`budget_total > 0`) or as an immediate stop.
- A malformed numeric env var now fails the boot instead of producing a NaN timeout or an
  accidental unlimited run. Loud, and at the only moment it's cheap to fix.

## Reversibility

Two-way door. The refill is six lines in one route; the pre-dispatch check and the
validation are independent of it. Nothing is persisted in a new shape — `budget` and
`budget_total` already existed.

## Revisit trigger

A budget expressed in money rather than attempts (vision.md's cost-per-ticket work heads
that way — see ADR-008), or a second automatic Start (a scheduler, a webhook) that isn't a
human pressing a button. Either one makes B's "no implicit re-authorisation" argument the
stronger one.
