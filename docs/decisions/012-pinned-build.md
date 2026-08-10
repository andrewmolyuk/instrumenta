# 012 — Pinned build: Docker image tagged per merge, compose pins the tag

Date: 2026-08-10. Makes ADR-001's self-hosting rule concrete: "always run a pinned
installed build, never the working tree it is currently editing."

## Context

ADR-001 accepted a real risk — a bug in the orchestrator could damage the tool that would
fix the bug — and mitigated it with a rule, not a mechanism. Nothing since has said what
"pinned installed build" actually is. The system runs locally under docker-compose
(ADR-005, ADR-008), so the mechanism has to fit that shape.

## Decision

**Every merge to `main` builds and tags a Docker image with the merge commit's SHA.**
CI already runs the full gate list on every push to `main` (`.github/workflows/ci.yml`,
ADR-002); a green run there is the same bar the repository already trusts for merging, so
it's the same bar for producing a new pinned build — no separate promotion step, no
second set of checks. `docker-compose.yml` references that explicit tag, never `:latest`
or a bind-mount of the working tree. Moving to a new build means editing the tag in
compose and restarting — a deliberate, reviewable, one-line change, not something that
happens underneath a running task.

**Why not a manual semver release:** it adds a step — the maintainer deciding when to
promote — for a check CI already performs on every merge. ADR-002 already treats a green
`main` as mergeable and deployable in spirit ("merge once the gates are green, nothing
waits on a reviewer"); requiring a second, separate release ritual to reach the same bar
duplicates it rather than protecting anything the gates don't already catch.

**What this does not solve:** a merge that passes gates but is wrong in a way gates can't
catch (the exact risk ADR-001 accepted). The mitigation is the explicit tag in
compose — a bad build only replaces a running instance when someone changes the pinned
tag and restarts, never automatically.

## Reversibility

Two-way door. Switching to manual promotion later is a change to the tagging step in CI,
not to how compose consumes the tag.

## Revisit trigger

A merge to `main` ships a build that breaks self-hosted Instrumenta before anyone notices
the tag change — evidence that gate-green isn't a strong enough bar for this specific
risk, and manual promotion has earned its extra step.
