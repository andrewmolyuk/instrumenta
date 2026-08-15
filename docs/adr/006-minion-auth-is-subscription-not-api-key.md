# 006 — Minion authenticates Claude Code via subscription token, not API key

Date: 2026-08-15

## Context

`minion/implement-task.mts` runs `claude --dangerously-skip-permissions -p <prompt>`
unattended, once per dispatched task (ADR-002: Minion is ephemeral, sandboxed, runs
unattended). That invocation needs to authenticate. The original wiring used
`ANTHROPIC_API_KEY`, forwarded from Foreman's environment into Minion's container the
same way `BITBUCKET_TOKEN` and the others are (README.md's `-e VAR`-with-no-value
pattern) — chosen implicitly, without a documented tradeoff, when the stub was first
written.

`ANTHROPIC_API_KEY` bills per token against Anthropic Console usage. Instrumenta's
whole premise is many autonomous task dispatches over time (docs/vision.md); metered
billing means cost scales directly with backlog size and Minion's `--dangerously-skip-permissions`,
best-effort retry shape (implement-task.mts's own doc comment: failures aren't fatal,
downstream verify-gate judges success). A flat-rate subscription decouples cost from
dispatch volume.

Claude Code supports both: `ANTHROPIC_API_KEY` (metered) and a long-lived OAuth token
tied to a Claude Pro/Max/Team/Enterprise subscription (flat-rate), generated via
`claude setup-token` and read from `CLAUDE_CODE_OAUTH_TOKEN`. Both work identically in
headless/print mode with `--dangerously-skip-permissions` — no functional gap forcing
the choice either way.

## Options considered

- **A (chosen)** — `CLAUDE_CODE_OAUTH_TOKEN`, generated once via `claude setup-token`
  against a Pro/Max/Team/Enterprise subscription, forwarded into Minion the same way
  `ANTHROPIC_API_KEY` was.
- **B** — keep `ANTHROPIC_API_KEY`. Simpler mental model (one obvious "the API key"
  credential, no separate CLI step to generate it, no expiry to track), but ties running
  cost directly to how many tickets Foreman dispatches — the opposite of what a
  single-operator, backlog-churning pipeline wants.

## Decision

Minion's Claude Code invocation authenticates via `CLAUDE_CODE_OAUTH_TOKEN`, not
`ANTHROPIC_API_KEY`. Concretely:

- `.env.example`: `ANTHROPIC_API_KEY=` → `CLAUDE_CODE_OAUTH_TOKEN=`, with a comment
  pointing at `claude setup-token`.
- `MINION_COMMAND`'s example argv (`.env.example`, README.md): `-e ANTHROPIC_API_KEY` →
  `-e CLAUDE_CODE_OAUTH_TOKEN`.
- README.md's env var table: row renamed, with a note on how to generate the token and
  its one-year expiry.
- `minion/implement-task.mts`'s doc comment updated to name the new variable.

If both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are set, Claude Code prefers
the API key — so this is an exclusive swap, not an addition. Operators must not also set
`ANTHROPIC_API_KEY` in Foreman's environment, or it silently reverts Minion to metered
billing.

**Why not B:** the API key's simplicity is real, but it's the wrong default for a
system whose entire point is dispatching many tasks unattended over an extended period
— metered cost there is a recurring operational bill that scales with success, not a
one-time setup cost like generating a token.

## Consequences

- One-time manual step required per deployment: someone with browser access and a
  qualifying subscription must run `claude setup-token` and place the result in
  Foreman's environment. This can't be automated inside the container the way an API
  key (created via a web console, no CLI round-trip) could be.
- The token expires after one year with no rotation mechanism (confirmed: Claude Code
  docs). Nothing in this codebase detects or warns on expiry — a stale token will
  surface at runtime as this same stub's already-best-effort failure mode
  (`docs/todo/minion-claude-code-invocation-is-a-stub.md`), not a distinct error.
  Revisit if/when the stub is wired up for real and failures need to be distinguishable.
- `.env`-file secrets stay the operating model either way (per README's existing
  `-e VAR`-inheritance pattern) — this ADR changes which credential flows through it,
  not the mechanism.

## Reversibility

Two-way door. Same shape as ADR-005: an identifier/config-value swap, not a structural
change — reverting means setting `ANTHROPIC_API_KEY` again and reverting the docs.

## Revisit trigger

The token's one-year expiry, whenever this is deployed long enough to hit it: revisit
whether a rotation reminder or automated re-issuance is worth building versus just
re-running `claude setup-token` by hand. Also revisit if usage volume ever exceeds what
a single subscription's flat-rate tier comfortably covers — at that point metered
billing (or a pooled/enterprise arrangement) may become cheaper again.
