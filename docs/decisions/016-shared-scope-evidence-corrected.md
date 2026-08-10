# 016 — Shared-scope evidence corrected; a project home for `tool:rule` findings

> **Superseded by [ADR-017](017-knowledge-layer.md)**, which restates this decision together with
> the rest of the knowledge layer. Nothing here was reversed — kept on record for the
> reasoning that produced it. Read ADR-017 for what currently holds.

Date: 2026-08-10. Amends the evidence and the hand-seeded corpus in ADR-004, and the
key/scope binding, promotion bar, and key notation in ADR-007. The decision ADR-004
made — two scopes, retrieved by different triggers — stands unchanged.

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

**3. `scope` and key shape become independent fields.** ADR-007 welded them — "`key`'s
meaning depends on `scope` — a path prefix for `project`, a `tool:rule` pair for
`shared`" — which point 2 breaks. An entry therefore carries an explicit `key_type`:

```yaml
scope: project | shared # which projects load it
key_type: path | tool-rule # what retrieves it
key: <path prefix, or engine:rule-id per point 4>
```

`key_type` decides the retrieval trigger, exactly as ADR-004's table already split it: a
`path` key fires when the agent touches matching files, a `tool-rule` key fires when a
gate reports that rule. Three of the four combinations are meaningful; **`scope: shared`
with `key_type: path` is invalid** and rejected on write, for the reason ADR-004 gives in
its own context — "paths mean nothing across repositories."

Not inferred from the key's text. `security/detect-object-injection` contains a slash and
is a rule, not a path; any sniffing heuristic gets that case wrong, and it is the case
this ADR exists to handle.

**4. Canonical key notation: `engine:rule-id`, where `rule-id` is spelled the way the
engine reports it.** ADR-013 makes key equality the counting primitive for the thesis test
("count recurrences per `key`"), so one finding must have exactly one spelling.
`docs/vision.md`'s table and ADR-007's example currently disagree with each other and with
this — `security/detect-object-injection`, `eslint-plugin-security:detect-object-injection`,
and bare `avoid-v-html` are three notations for two rules and one ambiguity.

- **Engine, not platform.** All seven measured commits arrived through Codacy, but the
  same ESLint rule fires from a local run too. The engine is the stable identity; the
  platform that happened to report it is not part of the key.
- **Engine, not plugin.** An ESLint rule id already carries its plugin, so ADR-007's
  `eslint-plugin-security:detect-object-injection` says it twice. Superseded by
  `eslint:security/detect-object-injection`.
- **Bare rule names are not keys.** `avoid-v-html` without an engine can collide across
  engines; a Semgrep rule takes its fully-qualified id.

The two seeded keys, in canonical form: `eslint:xss/no-mixed-html` and
`eslint:security/detect-object-injection`.

**5. The promotion bar is ADR-004's — a second _project_, not a second occurrence.**
ADR-007 restates the bar as "only after a second confirmed occurrence" while presenting it
as ADR-001/004 "unchanged". It is not the same rule, and the corrected data falls in the
gap: `detect-object-injection` has three occurrences in one repository, so ADR-007's
wording promotes it and ADR-004's does not. ADR-004 wins — it owns the split, ADR-007 was
restating it, and ADR-004's reason is the operative one: "the shared base is the one
loaded for every task on every project — the exact place where noise is most expensive."
Three hits in one codebase can just as easily mean that codebase indexes objects a lot.

**6. The hand-seeded MVP corpus is one shared entry, not one class covering seven
commits.** ADR-004 states the seed "already exists" as that one class. Corrected, and
applying the bar fixed in point 5: `eslint:xss/no-mixed-html` is the only key confirmed in
a second project, so it is the whole shared seed. `eslint:security/detect-object-injection`
seeds project scope for the second codebase. The other four keys seed nothing — a
singleton is not knowledge yet.

**7. The addressable ceiling is 4 corrections in 70 PRs (5.7%), and 1 of the 4 needs
shared scope.** Knowledge can only help from a key's second occurrence onward: two for
each recurring key. `../vision.md`'s 8.6% counts PRs _touched by_ a recurring key, not
turns a knowledge layer could have saved — the thesis test must not be read against the
larger number.

## Consequences

The shared scope is the more expensive half of ADR-004 — versioned in this repository,
promoted by PR, visible to other projects only after a release — and it is now carried by
a single data point. That is a live risk, not a settled question, and it is why the
revisit trigger below is sharper than ADR-004's.

Points 2–4 give ADR-013's dedup a project-scoped `tool:rule` key to count recurrences
against before anything reaches ADR-015's shared write path, and they change ADR-007's
frontmatter. No write path changes: ADR-010's orchestrator still formats the entry,
ADR-015 still keeps it away from the shared directory.

**`docs/vision.md` is updated with this ADR**, not left to drift. Its MVP scope guard
says an entry "is either project-scoped by path or shared across projects by finding
class, the two retrieved with different keys" — point 2 makes the first half false and
point 3 makes the second half imprecise (the trigger differs, the key shape need not).
That paragraph is what `CLAUDE.md` sends every session to read before building anything,
so it is the one place this correction cannot be allowed to lag.

ADR-007 is not edited. It stands as written and dated; points 3–5 supersede its
key/scope binding, its worked example's scope, and its restatement of the promotion bar.

## Reversibility

Two-way door, and cheaper than ADR-004's version: collapsing shared into project scope now
means moving one seeded entry, since point 2 gives project scope the key shape to hold it.

## Revisit trigger

No second cross-project recurrence by the time a second project has run thirty tasks. One
observation would then have been a coincidence, and the split should collapse to project
scope while it still costs one entry to undo.
