---
name: docs-consistency-check
description: 'Cross-checks docs/adr/*.md, docs/vision.md, and CLAUDE.md against each other for contradictions and stale references — one ADR assuming something another ADR later decided differently, a claim attributed to the wrong document, or a path/command that no longer matches the repo. Use when asked to review documentation or ADRs for consistency, after adding a new ADR that touches ground an earlier one already covered, or before starting a new batch of decisions.'
---

# docs-consistency-check: finding contradictions and stale claims across the docs

Why this exists: each ADR is written in isolation, arguing from decisions already on record. As the
set grows, a later ADR can silently assume something an earlier one decided differently, or restate a
constraint that actually lives elsewhere and has drifted out of sync with it. This isn't caught by
reading any one ADR on its own — only by holding several at once.

The failure has a shape worth recognising early: a decision gets patched by a follow-up ADR, that
patch conflicts with a third, and soon several documents exist only to reconcile the others. When
that pattern appears, the fix is not another patch — it is one document restating the whole subject,
with the superseded ones kept on record for the reasoning that produced them.

## What to read

Everything that states policy, not just `docs/adr/`:

- `docs/adr/*.md`, in number order — each one is a claim about how the system works.
  **Skip any file carrying a `> **Superseded by ...**` banner under its title.** Those are
  kept for the reasoning that produced them, not as live claims; a retired ADR disagreeing
  with its successor is what supersession means, not a finding. `docs/adr/INDEX.md`
  lists which are in force.
- Whatever states the project's goal and metrics (`docs/vision.md` or equivalent) — every ADR
  should still serve it.
- `docs/adr/INDEX.md` — the index. Confirm every link resolves, that each ADR is filed
  under the right heading (a superseded one still listed as in force is a finding), and that
  nothing on disk is missing from it.
- `CLAUDE.md` — the standing rules; confirm its links resolve to files that still
  exist, and that its own text (stack, workflow, don'ts) isn't contradicted by any ADR.
- `README.md`, if present, for anything maintainer-facing that an ADR has since changed underneath.

## What counts as a finding

- **Contradiction** — two docs make claims that can't both be true (one ADR removes a role's write
  access; another requires that same role to write something).
- **Silent narrowing/reversal** — a later ADR treats an earlier one's open question as settled,
  differently from how it was actually settled elsewhere — or not settled at all.
- **Attribution drift** — a rule stated as global that's actually scoped elsewhere (one component's
  local behavior described as a system-wide rule; a decision credited to the wrong document).
- **Stale reference** — a path, command, field name, or file a doc names that a later decision
  renamed, moved, or dropped.
- **Unresolved thread** — a "not decided here" or "revisit trigger" that a later doc's design quietly
  depends on being resolved a particular way, without saying so.

Not a finding: two ADRs simply both being true, or an open question already flagged as open in the
document that raises it. Flagging every deferred detail as a "gap" produces noise the maintainer has
to re-triage — the bar is a claim that conflicts with another claim, not one that's merely
incomplete.

## Process

1. Build an index of each ADR's concrete claims — state names, field names, file paths, directory
   locations, numeric constants, who does what. The goal document's metrics and horizons count as
   claims too.
2. For each claim, check every other document that touches the same subject. Two ADRs about the same
   component or subsystem are the highest-yield pairs to check line by line against each other.
3. For anything a doc says isn't decided yet, check whether a _later_ doc silently assumed an answer
   anyway.
4. Grep the repo for paths, commands, and filenames the docs claim exist (`.claude/hooks/`,
   `package.json` scripts, directory names) — a doc goes stale the moment code changes without the
   doc following.
5. Report each finding: which two documents conflict (a short quote or line reference from each),
   what the conflict actually is, and why it matters — not just "these differ" but what breaks if it
   ships unresolved. Rank findings touching the goal document's metrics highest — those are
   silent failures of the thing the whole project measures itself against.

## What this skill does not do

Findings are reported, not silently fixed. A contradiction between two decisions is itself a decision
that needs making — which one wins, or a new ADR resolving both — and that's the maintainer's call,
the same way every other ADR here required an explicit choice. Pure wording drift (a rule attributed
to the wrong document, no actual behavior conflict) can be corrected inline once flagged; an actual
behavioral contradiction gets a new numbered ADR.
