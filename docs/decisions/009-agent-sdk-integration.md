# 009 — Claude Agent SDK: fresh sessions, permission-scoped roles, both Sonnet 5

Date: 2026-08-10. Makes ADR-001's "wrap the SDK, don't write agents" concrete.

## Context

ADR-001 chose to wrap the Claude Agent SDK rather than write agent runtimes, and
`CLAUDE.md` already forbids one agent both producing and approving work. Neither says
how that separation holds at the SDK level, how much conversation state a retry within
ADR-006's retry cap carries forward, or which model powers which role.

## Decision

**Coding and Review are permission-scoped SDK sessions, not just separately prompted
ones.** The Review session's tool config excludes Edit/Write and any Bash invocation that
mutates the working tree — it can read, grep, and run gates read-only, nothing else. This
follows the same pattern already in the repo: `block-main-commit.mts` and
`block-co-authored-by.mts` enforce rules structurally instead of leaving them to prompt
text, and the Coding/Review separation gets the same treatment. A Review session that
cannot write code cannot approve its own fix by construction.

**A fresh SDK session per `Coding` attempt, not one dialogue spanning the retry cap.**
Each entry into `Coding` (ADR-006) starts a new session with context assembled by the
orchestrator: the issue, the current diff, the specific gate failure or review finding
that sent it back, and whatever knowledge entries retrieval selected (ADR-017). This is
the same choice already made everywhere else in the design — SQLite over conversation
memory for state (ADR-005), path/finding-class retrieval over embedding recall
(ADR-017) — applied to the agent loop itself. A persistent dialogue would let context grow
with every retry, which is exactly what the Context guardrail in `docs/vision.md` exists
to catch. Selecting what a session needs and handing it over is "retrieval without
recall," this project's second thesis component, not just the knowledge layer's.

**Gates run outside both sessions.** `GateCheck` (ADR-006) is the orchestrator invoking
the fixed check list as its own process, after a Coding session ends — never a tool the
agent calls and self-reports on. `CLAUDE.md`'s "route around a red gate" rule holds at
the architecture level: an agent has no path to mark its own gate green.

**Both agents run Sonnet 5.** `docs/vision.md`'s baselines already measure Claude
Code — Sonnet-class — output as "near its ceiling" on quality; the project's stated bet is
on effort, not on buying quality with a stronger model per role. One model for both roles
is also one thing to tune instead of two.

**Not decided here:** SDK version. Pinned in `package.json` like every other dependency
(ADR-002's pattern — exact versions, not ranges, where the tool allows it), decided at
implementation time against whatever the SDK's current release is.

## Reversibility

Two-way door. Splitting models by role later is a config change, not a redesign — nothing
above depends on both roles sharing a model. Session lifecycle is more load-bearing:
switching to persistent dialogues after code exists means rebuilding how retries source
their context, not a flag flip.

## Revisit trigger

Same as ADR-001's SDK choice: the first requirement the SDK cannot express — permission
scoping a session down to read-only tools, or context injection per session, are both
assumed to be things the SDK supports. If either isn't, that's a reason to revisit this
ADR specifically, not just ADR-001's broader wrap-vs-write choice.
