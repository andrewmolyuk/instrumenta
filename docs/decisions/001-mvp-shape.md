# 001 — MVP shape: knowledge-first, self-hosted, SDK-wrapped, no graph

Four decisions taken on 2026-08-09, each only meaningful given the others. Recorded as
one file for that reason.

---

## Decision: accumulated knowledge is the thesis the MVP must test

Date: 2026-08-09

**Context:** The first framing deferred the knowledge layer past MVP. But an orchestrator
running gated agents behind a dashboard is already covered by Devin, OpenHands, Cursor
background agents, and Claude Code's own subagents and hooks. The differentiator is
knowledge that compounds across tasks. An MVP that defers its own thesis tests nothing.

**Options considered:**

- **A** — Knowledge is the thesis; a thin knowledge layer ships in MVP.
- **B** — Deterministic gates are the thesis; knowledge comes later.
- **C** — Both, gates first, knowledge after 10–20 real tasks.

**Choice: A.** Gates are table stakes — necessary, not distinguishing. The claim worth
testing is that recorded knowledge changes later outcomes, and it cannot be tested
without the layer present.

**Scope guard.** "Thin" is load-bearing: entries are written only from confirmed review
findings and failed gates, each scoped to a path and carrying the commit that produced
it, never written by the Coding agent about its own work. A knowledge base that grows on
every task becomes noise within weeks — the same failure mode as a bloated CLAUDE.md.

**Known risk — knowledge rot.** Stale knowledge inverts the thesis: the agent applies a
rule the code has moved past and quality degrades over time. This is observed, not
theoretical; an existing repository of mine carries an explicit CLAUDE.md warning that
docs written before 2026-07-18 still claim deploys are manual. Every entry therefore
needs provenance and a path to invalidation.

**Known risk — retrieval, not storage.** Writing knowledge is the easy half. Selecting
five entries out of five hundred for a given task is the hard half, and injecting all of
them recreates the context-bloat problem. Hence path/module scoping over embedding
search, so selection stays close to deterministic.

**Reversibility:** two-way door.

**Revisit trigger:** 20 completed tasks with no measurable drop in recurring review
findings — the thesis is then wrong or the retrieval design is.

---

## Decision: Instrumenta's first target repository is Instrumenta itself

Date: 2026-08-09

**Context:** The knowledge thesis needs a codebase with history to accumulate against.
An existing repository of mine already has ADRs, a knowledge directory, working gates,
CI, and a live task flow — a pre-loaded corpus. Instrumenta's own repository has none of that.

**Options considered:** an existing repository with history · Instrumenta itself.

**Choice: Instrumenta itself**, for dogfooding from day one.

**Accepted risk — cold start.** An empty repository has nothing to accumulate, so the
thesis cannot demonstrate itself for the first stretch of tasks. This was raised and
accepted deliberately. Partial mitigation: cross-repo process conventions (branch rules,
conventional commits, English-only docs, lint/format choices) transfer immediately even
though code-level knowledge does not.

**Consequent risk — self-modification.** No other option had this: a bug in the
orchestrator damages the tool that would fix the bug. Mitigation is a hard rule —
Instrumenta always runs from a pinned installed build, never from the working tree it is
currently editing.

**Reversibility:** two-way door — pointing it at another repository is configuration.

**Revisit trigger:** if after 20 tasks the knowledge layer is still empty enough that the
north-star metric can't be read, switch to an existing repository with history.

---

## Decision: wrap the Claude Agent SDK rather than write agents

Date: 2026-08-09

**Context:** Coding agent, Review agent, orchestrator, policy engine, Cockpit, and
issue-tracker integration is six or seven subsystems for a single maintainer. Most of
the agent runtime is commodity.

**Options considered:** write the agents · wrap the Claude Agent SDK · defer the choice.

**Choice: wrap the SDK.** Own the orchestrator, the knowledge layer, and the Cockpit —
the parts that are actually differentiated. This removes roughly half the work, and the
half that is indistinguishable from what already exists.

**Consequence:** the policy engine leaves MVP scope. With risk tiers deferred, a policy
engine has no decision to make — a fixed list of gates that must all pass covers every
case. It returns when a real task appears whose correct gate set differs.

**Reversibility:** two-way door on the agents, though prompt-level control is
constrained by whatever the SDK exposes.

**Revisit trigger:** the first requirement the SDK cannot express — at that point compare
forking against writing a runtime.

---

## Decision: no knowledge graph — dropped from the roadmap, not deferred

Date: 2026-08-09

**Context:** "Knowledge graph" was sitting in the deferred list. Pulled apart, the term
covers three unrelated things, and none of them justifies a graph:

1. **Code structure** — imports, calls, ownership, git co-change. Genuinely useful, but
   it is derived from the code on demand and is therefore always current. Extracting and
   storing it creates a second copy that starts rotting the day it is written.
2. **Relations between knowledge entries** — "this decision supersedes that one."
   An existing repository already has exactly this case — one ADR superseding another on
   a billing decision. One edge type is a field, not a graph.
3. **A semantic graph of entities extracted by an LLM** — the most expensive, the most
   hallucination-prone, and with no evidence of value anywhere in the existing manual
   practice.

**The decisive argument:** a graph does not address the problem that is actually hard.
The hard problem is retrieval — selecting five entries out of five hundred. A graph
replaces that question with "which five, and how deep do I walk," where depth 1 is a flat
list and depth 3 is everything, which is the context-bloat failure again.

**Empirically:** the manual version of all of this already runs across two existing
repositories as flat, cross-linked Markdown — ADRs, `docs/knowledge/`, skills. It works.
Nobody built a graph and nobody needed one.

**Options considered:** keep it deferred · drop it entirely · build a minimal edge model
now.

**Choice: drop it entirely.** A deferred item is a phantom requirement — it quietly bends
decisions taken today ("the store should be graph-ready"). Its useful part survives as an
optional `supersedes` pointer on a knowledge entry.

**Reversibility:** two-way door — edges can be added over a flat store later.

**Revisit trigger:** path-scoped retrieval missing repeatedly on **non-local** relations,
where the connection is real but crosses directories with no import edge between them —
e.g. a change to the auth cookie affecting the public API-key path. A few recurrences of
that class and edges have earned their place.
