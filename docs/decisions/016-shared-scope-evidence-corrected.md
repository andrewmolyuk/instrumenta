# 016 — Shared-scope evidence corrected; a project home for `tool:rule` findings

Date: 2026-08-10. Amends the evidence and the hand-seeded corpus in ADR-004. The decision
ADR-004 made — two scopes, keyed differently — stands unchanged.

## Context

ADR-004 justifies a shared scope with a measured claim, quoted from `../vision.md`:

> The recurrence documented in vision.md — seven corrective commits, all one class of
> security-scanner false positive — spans **two separate codebases**.

`docs/todo/verify-security-finding-tool-rule-granularity.md` was opened to check that
claim against the real repositories once they were reachable. It does not hold, and it
fails in the one direction that matters to ADR-004.

Those seven commits span **six** distinct `tool:rule` keys across three engines, not one
class. Two keys recur across separate PRs; the rest are singletons, and one of the
singletons — an Opengrep pwn-request finding — was a real vulnerability rather than a
false positive. A full in-window sweep also found two corrective commits the original
tally missed, both of them recurrences.

The load-bearing part: under the old count, seven commits sat in two codebases but **no
single key crossed the boundary**. Each repository had its own rules. So the sentence
ADR-004 rests on described a cross-codebase recurrence that the data did not contain.

The corrected sweep does contain one. `xss/no-mixed-html` fires in both repositories
(Repo A twice, Repo B once). That is now the entire empirical case for a scope that is
shared rather than per-project — one observation across seventy PRs, not seven.

## Decision

**1. The two-scope split stands, on thinner evidence, recorded as thin.** One
cross-project recurrence is enough to keep the split — the alternative, discovering the
need after retrieval is built around a single path key, is the expensive direction
ADR-004's own reversibility note already calls out. But "measured rather than assumed" in
ADR-004 now means _n = 1_, and nothing downstream should quote it as more.

**2. Project scope accepts `tool:rule`-keyed entries, not only path-keyed ones.** The
corrected data exposes a gap ADR-004 did not cover: `security/detect-object-injection`
recurs three times, all inside one repository. It is not path-bound — it is a code shape
— so project scope as ADR-004 describes it ("keyed by path") has no room for it, while
the promotion bar ("confirmed in a second project") keeps it out of shared. It would have
no home, and ADR-004's own word _promotion_ presumes one: an entry cannot be promoted from
a place it was never stored. So the first project to confirm a `tool:rule` finding stores
it project-scoped, retrieved when a gate fires in that project; a second project
confirming the same key is what promotes it.

**3. The hand-seeded MVP corpus is one shared entry, not one class covering seven
commits.** ADR-004 states the seed "already exists" as that one class. Corrected, and
applying ADR-004's own promotion bar: `xss/no-mixed-html` is the only key confirmed in a
second project, so it is the whole shared seed. `security/detect-object-injection` seeds
project scope for the second codebase. The other four keys seed nothing — a singleton is
not knowledge yet.

**4. The addressable ceiling is 4 corrections in 70 PRs (5.7%), and 1 of the 4 needs
shared scope.** Knowledge can only help from a key's second occurrence onward: two for
each recurring key. `../vision.md`'s 8.6% counts PRs _touched by_ a recurring key, not
turns a knowledge layer could have saved — the thesis test must not be read against the
larger number.

## Consequences

The shared scope is the more expensive half of ADR-004 — versioned in this repository,
promoted by PR, visible to other projects only after a release — and it is now carried by
a single data point. That is a live risk, not a settled question, and it is why the
revisit trigger below is sharper than ADR-004's.

Point 2 changes what ADR-007's project entries must be able to express, and gives
ADR-013's dedup a project-scoped `tool:rule` key to count recurrences against before
anything reaches ADR-015's shared write path. It does not change any write path.

## Reversibility

Two-way door, and cheaper than ADR-004's version: collapsing shared into project scope now
means moving one seeded entry, since point 2 gives project scope the key shape to hold it.

## Revisit trigger

No second cross-project recurrence by the time a second project has run thirty tasks. One
observation would then have been a coincidence, and the split should collapse to project
scope while it still costs one entry to undo.
