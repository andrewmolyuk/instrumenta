# 004 — Knowledge has two scopes, retrieved by different keys

> **Superseded by [ADR-017](017-knowledge-layer.md)**, which restates this decision together with
> the rest of the knowledge layer. Nothing here was reversed — kept on record for the
> reasoning that produced it. Read ADR-017 for what currently holds.

Date: 2026-08-10. Amends the knowledge design in ADR-001; follows from ADR-003.

## Context

ADR-001 specified one kind of knowledge entry, scoped to a path. ADR-003 then established
that a second project brings its own tasks, its own docs, and its own output. Path
scoping only works inside a project — paths mean nothing across repositories.

But not all knowledge is project-bound, and this is measured rather than assumed. The
recurrence documented in [`../vision.md`](../vision.md) — seven corrective commits, all
one class of security-scanner false positive — spans **two separate codebases**. The
knowledge that would have prevented those recurrences is not about any file in either
repository. It is about a tool, a rule, and a shape of code.

## Decision

Two scopes, owned in different places and retrieved with different keys.

|                | Shared                                                                                      | Project                                           |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Owned by       | Instrumenta                                                                                 | the target repository                             |
| Keyed by       | finding class — tool plus rule identifier                                                   | path                                              |
| Retrieved when | a gate fires                                                                                | the agent touches files                           |
| Example        | "this scanner's XSS rule on generated HTML is a known false positive; suppress it this way" | "these views share a form shell; change it there" |

Shared knowledge is **not** behind ADR-003's knowledge-source port. That port is per
project; shared knowledge belongs to the tool and travels with it.

**Promotion has a bar.** A project entry becomes shared only when the same class is
confirmed in a second project. Without that rule every local quirk leaks into the shared
base, and the shared base is the one loaded for every task on every project — the exact
place where noise is most expensive. This mirrors the constraint that keeps the
project-scoped layer thin.

## Where shared knowledge lives

Versioned data in this repository, released with the build. Promotion opens a PR against
Instrumenta, so every entry in the base that all projects read has passed the same
external review the architecture demands everywhere else — nothing writes to it unseen.

This works with ADR-001's pinned-build rule rather than against it: code and shared
knowledge are versioned and released together, so a given build always carries a known
body of knowledge and a run stays reproducible.

The cost is that another project sees a new entry only after a release. Acceptable while
promotion is rare and evidence-gated. If release lag ever starts to hurt, that is the
signal to revisit — and probably also a signal that the promotion bar has been set too
low.

## Learning from projects

Shared knowledge is meant to improve as projects run. The mechanism stays deliberately
dumb: count confirmed recurrences of a finding class and promote at a threshold. No model
generalises entries into rules, and nothing is inferred from embeddings.

That restraint is the point. A generalised entry cannot be verified against anything, and
a wrong entry in the shared base is loaded for every task on every project — the most
expensive place in the system to be wrong. Evidence-based promotion is slower and it is
the only kind that can be audited.

**Honest limit during MVP:** promotion requires a second project, and MVP has exactly one.
So the shared base does not learn yet — during MVP it is **seeded by hand**, and the seed
already exists: the finding classes measured in [`../vision.md`](../vision.md), where one
class of scanner false positive accounted for seven corrective commits across two
codebases. Calling MVP's shared base "learned" would be a lie; it is a starting corpus
with a learning path attached.

## Consequence for the cold start

ADR-001 accepted that targeting Instrumenta itself leaves nothing to accumulate against.
The shared scope softens that: cross-project findings and process conventions are useful
from the first task and do not depend on this repository having history. It does not
remove the risk — project-scoped knowledge still starts empty — but it means the thesis
has something to demonstrate before the codebase has a past.

## Reversibility

Two-way door. Collapsing two scopes into one is a migration of stored rows; splitting one
into two after retrieval has been built around a single key is a redesign.

## Revisit trigger

Shared entries that keep needing project-specific exceptions. That would mean the split
was drawn between the wrong things — the real axis being something other than
project-boundedness.
