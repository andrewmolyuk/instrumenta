---
type: bug
status: open
date: 2026-08-23
source: session 18fd2ae7-43f9-4f49-bc94-4a50eb11250c
---

# Minion resumes a declined branch's commits instead of starting fresh

`cloneAndBranch` reuses an existing remote branch whenever there is no *open* PR on it,
which now also covers the DECLINED case (see ADR-016, which made declined PRs no longer
retire a ticket). A ticket redispatched after a human declines its PR therefore resumes
from the exact commits that were just rejected, rather than branching fresh from base —
and may report `no_change` (terminal per ADR-014), effectively burning the retry without
producing new work. Branching fresh from base instead would collide non-fast-forward
against the existing remote branch, which the current reuse behavior exists to avoid, so
this needs a real fix (e.g. deleting/resetting the remote branch before a re-run) rather
than a one-line change. ADR-016 names this as the next thing to fix if re-runs after a
decline are observed going nowhere.
