# 007 — Knowledge entry format: flat Markdown, two directories

> **Superseded by [ADR-017](017-knowledge-layer.md)**, which restates this decision together with
> the rest of the knowledge layer. Nothing here was reversed — kept on record for the
> reasoning that produced it. Read ADR-017 for what currently holds.

Date: 2026-08-10. Makes ADR-001 and ADR-004 concrete: what a knowledge entry is,
literally, and where it lives.

## Context

ADR-001 fixed the fields an entry carries (commit, path scope, optional `supersedes`).
ADR-004 fixed the two scopes and their keys (project by path, shared by finding class)
and said shared knowledge is "versioned data in this repository, released with the
build." Neither picked a file format or a directory. ADR-005 gives the event store a
home (SQLite) for state and attribution, but a knowledge entry is meant to be read by a
maintainer in review and cross-linked like an ADR (ADR-001's no-graph decision: "flat,
cross-linked Markdown ... works") — so it is a file, not a database row. SQLite logs that
an entry was created and which commit produced it; the entry's content lives in the file.

## Decision

**Format:** one Markdown file per entry, frontmatter plus body — same shape as the ADRs
in this directory.

```yaml
---
id: 2026-08-10-object-injection-registry-lookup
scope: project | shared
key: apps/orchestrator/src/registry/ # scope: project → path prefix
# key: eslint-plugin-security:detect-object-injection # scope: shared → tool:rule
commit: <sha that produced this entry>
date: 2026-08-10
supersedes: <id> # optional
summary: one line, shown in retrieval logs without opening the file
---
Body: the finding or rule, in prose. What happened, why it's a false positive or a real
rule, and what to do differently next time.
```

`key`'s meaning depends on `scope` — a path prefix for `project`, a `tool:rule` pair for
`shared` — matching the two retrieval keys ADR-004 already defined.

**Directories:**

- **Project-scoped** — `docs/knowledge/` in the target repository. For MVP that
  repository is Instrumenta itself (ADR-001), so this directory lives here too, parallel
  to `docs/decisions/`. On a second project (ADR-003's revisit trigger), the knowledge
  port implementation reads this same relative path inside whichever repo it's pointed
  at.
- **Shared** — `packages/knowledge-shared/entries/`, a real workspace package (ADR-002's
  `packages/*` convention), not `docs/`. This is deliberate: shared entries are runtime
  data the orchestrator loads to act on gate failures, not documentation about
  Instrumenta — "released with the build" (ADR-004) means it ships as part of a package,
  versioned and installed the same way the rest of the code is.

**What's not a new decision:** promotion rules (a project entry becomes shared only after
a second confirmed occurrence), retrieval triggers (path touch vs gate firing), and the
"never written by the Coding agent about its own work" rule all come from ADR-001/004
unchanged. This ADR only fixes the file shape and the two paths.

## Reversibility

Two-way door. Frontmatter fields can gain optional keys without breaking existing
entries; moving `packages/knowledge-shared/` is a directory rename, not a data migration,
since nothing but the retrieval code depends on the path.

## Revisit trigger

The second project (same trigger as ADR-003): confirms whether `docs/knowledge/` as a
fixed relative path inside the target repo is the right assumption, or whether it needs
to be configurable per project.
