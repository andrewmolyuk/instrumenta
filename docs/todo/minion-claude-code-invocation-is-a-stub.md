---
type: todo
status: open
date: 2026-08-13
source: session 8c4a9ce1-2399-44fc-a492-a9515b69f9c8
---

# Minion's task-implementation step is still a stub

`minion/implement-task.mts` is a best-effort placeholder — it invokes an injectable
command (defaults to the real `claude` binary on PATH, swapped out in tests) but does
not yet drive Claude Code with real task content end-to-end. Everything downstream
(verify-gate detection, git commit/push, Bitbucket PR creation, notes) is implemented
and was verified against a real Docker build and a real Bitbucket auth round-trip; only
the actual "read the Jira ticket, make the code change" step is unfinished.

Known consequence of the stub: on a target repo whose `verify` script passes but where
the stub makes no real file changes, Minion fails at `git commit` ("nothing to commit")
and exits without a structured result, which Foreman correctly (if bluntly) classifies
as `crashed`. This is expected given the stub, not a bug in the crash-classification
path itself — but it means no real dispatch will succeed until this is wired up.
