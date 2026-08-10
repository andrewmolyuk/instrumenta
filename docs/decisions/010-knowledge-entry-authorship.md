# 010 — Knowledge entries are written by the orchestrator, not an agent

> **Superseded by [ADR-017](017-knowledge-layer.md)**, which restates this decision together with
> the rest of the knowledge layer. Nothing here was reversed — kept on record for the
> reasoning that produced it. Read ADR-017 for what currently holds.

Date: 2026-08-10. Resolves a conflict between ADR-001/004/007 and ADR-009.

## Context

ADR-001 requires every knowledge entry to come from a confirmed review finding or a
failed gate, and never from the Coding agent describing its own work. ADR-009 then
scoped the Review session's tools down to read-only — no Edit, no Write — so it cannot
approve its own fix. Put together, nothing in the design can write the entry file ADR-007
defines: the Coding agent is excluded by ADR-001, and the Review session is excluded by
ADR-009. This wasn't visible until ADR-009 existed.

## Decision

**The orchestrator writes the file.** A `Reviewing` finding that sends the task back to
`Coding` (ADR-006) — the signal ADR-001 already treats as "confirmed," since it caused a
real fix rather than a passing comment — comes back from the Review session as
structured output: what the finding is, its scope key (path or `tool:rule`), and the
commit it applies to. The orchestrator, not an agent, formats that into the frontmatter
and body ADR-007 specifies and writes it to `docs/knowledge/`. The same applies to a
failed gate: gate output is already structured (tool, rule, file), so the orchestrator
formats an entry from it without needing an agent step at all. (A shared-scope key does
not get the same direct write — see ADR-015.)

This keeps the Review session exactly as read-only as ADR-009 already committed to — it
returns data, not files — and needs no third agent role or third permission set, which
ADR-001 already ruled against by dropping the policy engine for the sake of a fixed,
small set of gates rather than more configurable machinery.

**Consequence:** the Review session's output contract now matters architecturally, not
just for display. It must return findings as structured data (finding text, scope key,
commit), not prose the orchestrator would have to parse — this is an SDK-integration
detail for whoever implements ADR-009, not a new decision here.

## Reversibility

Two-way door. A future scribe session (the rejected option) could take over formatting
without changing what triggers an entry or where it's stored — only who performs the
write.

## Revisit trigger

The orchestrator's formatting turns out to need judgment an agent has and templating
doesn't — e.g., the same finding class needing meaningfully different write-ups per
occurrence. That would be a reason to add a scribe role; nothing in the design today
suggests it's needed.
