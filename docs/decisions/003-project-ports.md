# 003 — Three ports, one implementation each

Date: 2026-08-10. Before the first line of orchestrator code.

## Context

MVP targets one repository — this one. But a second project would not reuse any of the
three things this one happens to use: it would have a different **task source**, its docs
and prior decisions would live somewhere else, and its finished work would land somewhere
else. If `gh` is called from wherever it is convenient, all three assumptions get welded
into the orchestrator and the second project becomes a rewrite.

The opposite mistake is just as real: building a plugin system with adapter registries and
config-driven loading, for projects that do not exist, is an abstraction over a single
use. ADR-001 already rejected that shape of speculation for the knowledge graph.

## Decision

Name three ports as interfaces. Ship exactly **one implementation of each**, and no
mechanism for selecting between implementations.

| Port             | MVP implementation                              | What varies per project                       |
| ---------------- | ----------------------------------------------- | --------------------------------------------- |
| Task source      | GitHub Issues via `gh`                          | issue tracker, query, what counts as ready    |
| Knowledge source | decision and knowledge files in the target repo | location and format of written memory         |
| Work sink        | GitHub PR via `gh`                              | PR vs MR vs patch, and the branch conventions |

The orchestrator depends on the interfaces only. No `gh` call sits outside the two
adapters that own it.

**Not built:** an adapter registry, a plugin loader, per-adapter configuration schemas, or
a second implementation of anything. The interface is the whole cost being paid now; a
second implementation is written when a second project exists, and its first job is to
prove the interface was drawn in the right place.

**Project identity.** The orchestrator needs to know which project a task belongs to
before any of this can be per-project. A project record lives in the event store — the
component already in MVP scope — rather than in a config file, so the Cockpit can
enumerate projects without cloning anything.

## Reversibility

Two-way door, and the direction that matters is cheap: three interfaces with one
implementation each can be deleted back into direct calls far more easily than direct
calls can be lifted into interfaces.

## Revisit trigger

The second project. At that point the interfaces get their real test, and any of them
drawn in the wrong place will show it immediately — that is the moment to reshape them,
not now on a guess.
