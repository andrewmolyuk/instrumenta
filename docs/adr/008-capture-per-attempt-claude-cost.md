# 008 — Capture Claude Code's own cost estimate per attempt

Date: 2026-08-16

## Context

`docs/vision.md`'s Success signal defines a human-cost baseline (~290–435 ILS/ticket)
but leaves "Claude API cost per ticket" as TBD, since instrumenta hadn't done any real
dispatches to measure it from
(`docs/todo/measure-claude-api-cost-per-ticket.md`). Nothing in Minion currently records
what a dispatch cost — `implement-task.mts` invokes `claude -p` in plain-text mode and
only keeps the printed transcript for diagnostics (ADR-006's doc comment). Filling in
that TBD needs per-attempt cost data collected as real dispatches happen; it can't be
computed after the fact.

ADR-006 already established that Minion authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (a
Pro/Max/Team/Enterprise subscription), not a metered `ANTHROPIC_API_KEY` — deliberately,
so running cost doesn't scale with dispatch volume. That means there is no metered bill
to read per attempt. Claude Code's `--output-format json` result still reports
`total_cost_usd` — its own estimate of what the turn would have cost at standard API
list rates — regardless of which credential authenticated it. That figure is exactly
the "Claude API cost per ticket" vision.md is waiting on: not what was actually billed
(a flat subscription fee), but the comparison point against the human-cost baseline,
which is itself list-rate reasoning (an hourly rate × hours), not an invoice.

## Options considered

- **A (chosen)** — switch `defaultImplementCommand` to `--output-format json`, parse
  `.result` (human-readable text, replacing the raw transcript as the stored diagnostic
  `output`) and `.total_cost_usd` (the new `cost_usd`), and carry `cost_usd` through
  `MinionResult` → `TaskRow` → SQLite → the status API/UI, alongside every existing
  status.
- **B** — switch Minion's auth back to a metered `ANTHROPIC_API_KEY` so cost could be
  read from Anthropic's own usage records instead of Claude Code's self-reported
  estimate. Rejected: reopens ADR-006's own tradeoff (cost scaling with dispatch volume)
  purely to source a number Claude Code already reports for free.
- **C** — leave cost uncaptured until vision.md's TBD is actually being filled in, and
  backfill by re-running a sample of tickets later just to measure cost. Rejected:
  "later" runs would be dispatched under different conditions (repo state, prompt
  wording, model version) than the real backlog runs the comparison is supposed to
  describe — the number would describe a synthetic benchmark, not the thing vision.md
  asks for.

## Decision

`minion/implement-task.mts`'s `defaultImplementCommand` adds `--output-format json` to
the `claude` invocation. `implementTask` now returns `{ output, costUsd }`
(`ImplementResult`) instead of a bare string: `output` is Claude Code's `.result` text
when stdout parses as that JSON shape, falling back to the old raw stdout+stderr text
otherwise (crash, missing binary, a test double that doesn't speak JSON); `costUsd` is
`.total_cost_usd` when present, else `null` — not zero, since a null here means "no
usable estimate," not "this attempt was free."

`costUsd` is threaded through unconditionally — every branch of `orchestrate.mts`'s
`runMinion` (success, blocked_no_verify, failed_verify, given_up, and every crashed
variant) returns it as `cost_usd` on `MinionResult`, because Claude Code can spend real
tokens investigating a task even on an attempt that doesn't end in success.
`src/minion/process-runner.mts` parses `cost_usd` back out of Minion's own
whole-process JSON result the same way it already parses `status`/`pr_url`/`output`.

Storage amends ADR-001's schema: `tasks.cost_usd REAL`, nullable, alongside the existing
columns. `src/foreman/dispatch.mts` copies `result.cost_usd` onto the `TaskRow` it
returns; `recordAttempt` inserts it. Foreman's history API and the web UI need no new
endpoint — `GET /api/status`'s existing `history: listAttempts(...)` already
round-trips the full `TaskRow`, so `ui.html` only needed a new "Cost" column reading the
same field.

This ADR captures the field; it doesn't fill in vision.md's TBD. That still waits on
enough real dispatches to average over — see
`docs/todo/measure-claude-api-cost-per-ticket.md`, still open.

**Why not B:** ADR-006's flat-rate reasoning is unaffected by this — the whole point is
a number decoupled from dispatch volume, and Claude Code already computes the
list-rate-equivalent figure needed here without paying anything metered for it.

## Consequences

- `cost_usd` is null for every attempt where Claude Code never produced a parseable
  JSON result — timeouts killed before printing, a crashed `claude` binary, a Minion
  process that itself crashed before finishing. Averaging "cost per ticket" later has to
  either exclude those rows or treat them explicitly as missing data, not zero-cost.
- `total_cost_usd` is Claude Code's own estimate against standard API list pricing, not
  a real invoice line — Minion's subscription billing (ADR-006) doesn't move with it.
  Anyone reading this column later should read it as "what this would have cost as a
  metered call," matching how vision.md's human-cost side is itself a rate-times-hours
  estimate, not an invoice either.
- The stored diagnostic `output` text changes shape: it's now Claude Code's own final
  message text (`.result`) instead of a raw transcript dump, on any attempt where the
  JSON parsed. Existing `docs/todo/*.md` notes and human debugging via the history UI
  see cleaner text, not raw JSON — but any tooling that assumed the old free-form
  transcript shape would need to adjust (none currently exists outside this codebase).
- No schema migration exists for a database created before this column — matches the
  project's existing practice (`CREATE TABLE IF NOT EXISTS`, no `ALTER TABLE` anywhere
  in `schema.sql`); a persisted dev-container volume created before this change needs
  to be recreated, same as any other schema change so far.

## Reversibility

Two-way door. `--output-format json` and the extra field are additive — reverting means
dropping the flag, the parsing, and the column; nothing external depends on this shape
yet (no public API, no target-project-facing convention).

## Revisit trigger

Once enough real dispatches exist to compute an actual average and fill in vision.md's
TBD (the trigger `docs/todo/measure-claude-api-cost-per-ticket.md` already names).
Also revisit if `claude --output-format json`'s result shape changes field names —
`parseClaudeCodeResult` in `implement-task.mts` is the one place that would need to
change.
