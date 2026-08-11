# NNN — <short title: the choice, not the topic>

Date: YYYY-MM-DD

## Context

What forced a decision now — the problem, the constraints, and what was already decided
elsewhere that this has to fit. A reader who wasn't there should understand why this
couldn't just be left alone.

## Options considered

- **A** — <option>
- **B** — <option>
- **C** — <option>

List the ones that were genuinely in play. If there was only ever one option, this isn't a
decision — it's a note, and it belongs somewhere else.

## Decision

<The choice, stated in one sentence, then what it means concretely — names, paths, fields,
numbers. Enough that someone can implement it without asking.>

**Why not <the strongest rejected option>:** the real reason, not a strawman. Someone who
preferred it should still recognise their own argument here.

## Consequences

What this costs, what it rules out, and what now depends on it. Include the part you'd
rather not write down.

## Reversibility

Two-way door (cheap to undo — decide fast and move on) or one-way door (costly: public
APIs, data schemas, anything users learn). If one-way, say what makes it expensive and
confirm the choice was made deliberately rather than by default.

## Revisit trigger

The condition, metric, or date that reopens this. Without one, a decision quietly becomes
an unquestioned default — and nobody remembers it was ever a choice.

---

Conventions: one topic per file, numbered in the order taken. A later ADR amends an earlier
one **by number** rather than editing it, so the record stays as written and dated. A
superseded ADR keeps its file and gains a banner under the title:

> **Superseded by [ADR-NNN](NNN-slug.md)** — kept on record for the reasoning that produced
> it. Read ADR-NNN for what currently holds.
